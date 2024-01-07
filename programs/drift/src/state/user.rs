use crate::controller::lp::apply_lp_rebase_to_perp_position;
use crate::controller::position::{add_new_position, get_position_index, PositionDirection};
use crate::error::{DriftResult, ErrorCode};
use crate::math::auction::{calculate_auction_price, is_auction_complete};
use crate::math::casting::Cast;
use crate::math::constants::{
    AMM_TO_QUOTE_PRECISION_RATIO_I128, EPOCH_DURATION, OPEN_ORDER_MARGIN_REQUIREMENT,
    PRICE_PRECISION_I128, PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO, QUOTE_PRECISION,
    QUOTE_SPOT_MARKET_INDEX, THIRTY_DAY,
};
use crate::math::lp::{calculate_lp_open_bids_asks, calculate_settle_lp_metrics};
use crate::math::margin::MarginRequirementType;
use crate::math::orders::{standardize_base_asset_amount, standardize_price};
use crate::math::position::{
    calculate_base_asset_value_and_pnl_with_oracle_price,
    calculate_base_asset_value_with_oracle_price,
};
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::{
    get_signed_token_amount, get_strict_token_value, get_token_amount, get_token_value,
};
use crate::math::stats::calculate_rolling_sum;
use crate::state::oracle::StrictOraclePrice;
use crate::state::perp_market::PerpMarket;
use crate::state::spot_market::{SpotBalance, SpotBalanceType, SpotMarket};
use crate::state::traits::Size;
use crate::validate;
use crate::{get_then_update_id, QUOTE_PRECISION_U64};
use crate::{math_error, SPOT_WEIGHT_PRECISION_I128};
use crate::{safe_increment, SPOT_WEIGHT_PRECISION};
use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::msg;
use std::cmp::max;
use std::ops::Neg;
use std::panic::Location;

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum UserStatus {
    // Active = 0
    BeingLiquidated = 0b00000001,
    Bankrupt = 0b00000010,
    ReduceOnly = 0b00000100,
}

// implement SIZE const for User
impl Size for User {
    const SIZE: usize = 4376;
}

#[account(zero_copy(unsafe))]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct User {
    /// The owner/authority of the account
    pub authority: Pubkey,
    /// An addresses that can control the account on the authority's behalf. Has limited power, cant withdraw
    pub delegate: Pubkey,
    /// Encoded display name e.g. "toly"
    pub name: [u8; 32],
    /// The user's spot positions
    pub spot_positions: [SpotPosition; 8],
    /// The user's perp positions
    pub perp_positions: [PerpPosition; 8],
    /// The user's orders
    pub orders: [Order; 32],
    /// The last time the user added perp lp positions
    pub last_add_perp_lp_shares_ts: i64,
    /// The total values of deposits the user has made
    /// precision: QUOTE_PRECISION
    pub total_deposits: u64,
    /// The total values of withdrawals the user has made
    /// precision: QUOTE_PRECISION
    pub total_withdraws: u64,
    /// The total socialized loss the users has incurred upon the protocol
    /// precision: QUOTE_PRECISION
    pub total_social_loss: u64,
    /// Fees (taker fees, maker rebate, referrer reward, filler reward) and pnl for perps
    /// precision: QUOTE_PRECISION
    pub settled_perp_pnl: i64,
    /// Fees (taker fees, maker rebate, filler reward) for spot
    /// precision: QUOTE_PRECISION
    pub cumulative_spot_fees: i64,
    /// Cumulative funding paid/received for perps
    /// precision: QUOTE_PRECISION
    pub cumulative_perp_funding: i64,
    /// The amount of margin freed during liquidation. Used to force the liquidation to occur over a period of time
    /// Defaults to zero when not being liquidated
    /// precision: QUOTE_PRECISION
    pub liquidation_margin_freed: u64,
    /// The last slot a user was active. Used to determine if a user is idle
    pub last_active_slot: u64,
    /// Every user order has an order id. This is the next order id to be used
    pub next_order_id: u32,
    /// Custom max initial margin ratio for the user
    pub max_margin_ratio: u32,
    /// The next liquidation id to be used for user
    pub next_liquidation_id: u16,
    /// The sub account id for this user
    pub sub_account_id: u16,
    /// Whether the user is active, being liquidated or bankrupt
    pub status: u8,
    /// Whether the user has enabled margin trading
    pub is_margin_trading_enabled: bool,
    /// User is idle if they haven't interacted with the protocol in 1 week and they have no orders, perp positions or borrows
    /// Off-chain keeper bots can ignore users that are idle
    pub idle: bool,
    /// number of open orders
    pub open_orders: u8,
    /// Whether or not user has open order
    pub has_open_order: bool,
    /// number of open orders with auction
    pub open_auctions: u8,
    /// Whether or not user has open order with auction
    pub has_open_auction: bool,
    pub padding: [u8; 21],
}

impl User {
    pub fn is_being_liquidated(&self) -> bool {
        self.status & (UserStatus::BeingLiquidated as u8 | UserStatus::Bankrupt as u8) > 0
    }

    pub fn is_bankrupt(&self) -> bool {
        self.status & (UserStatus::Bankrupt as u8) > 0
    }

    pub fn is_reduce_only(&self) -> bool {
        self.status & (UserStatus::ReduceOnly as u8) > 0
    }

    pub fn add_user_status(&mut self, status: UserStatus) {
        self.status |= status as u8;
    }

    pub fn remove_user_status(&mut self, status: UserStatus) {
        self.status &= !(status as u8);
    }

    pub fn get_spot_position_index(&self, market_index: u16) -> DriftResult<usize> {
        // first spot position is always quote asset
        if market_index == 0 {
            validate!(
                self.spot_positions[0].market_index == 0,
                ErrorCode::DefaultError,
                "User position 0 not market_index=0"
            )?;
            return Ok(0);
        }

        self.spot_positions
            .iter()
            .position(|spot_position| spot_position.market_index == market_index)
            .ok_or(ErrorCode::CouldNotFindSpotPosition)
    }

    pub fn get_spot_position(&self, market_index: u16) -> DriftResult<&SpotPosition> {
        self.get_spot_position_index(market_index)
            .map(|market_index| &self.spot_positions[market_index])
    }

    pub fn get_spot_position_mut(&mut self, market_index: u16) -> DriftResult<&mut SpotPosition> {
        self.get_spot_position_index(market_index)
            .map(move |market_index| &mut self.spot_positions[market_index])
    }

    pub fn get_quote_spot_position(&self) -> &SpotPosition {
        match self.get_spot_position(QUOTE_SPOT_MARKET_INDEX) {
            Ok(position) => position,
            Err(_) => unreachable!(),
        }
    }

    pub fn get_quote_spot_position_mut(&mut self) -> &mut SpotPosition {
        match self.get_spot_position_mut(QUOTE_SPOT_MARKET_INDEX) {
            Ok(position) => position,
            Err(_) => unreachable!(),
        }
    }

    pub fn add_spot_position(
        &mut self,
        market_index: u16,
        balance_type: SpotBalanceType,
    ) -> DriftResult<usize> {
        let new_spot_position_index = self
            .spot_positions
            .iter()
            .enumerate()
            .position(|(index, spot_position)| index != 0 && spot_position.is_available())
            .ok_or(ErrorCode::NoSpotPositionAvailable)?;

        let new_spot_position = SpotPosition {
            market_index,
            balance_type,
            ..SpotPosition::default()
        };

        self.spot_positions[new_spot_position_index] = new_spot_position;

        Ok(new_spot_position_index)
    }

    pub fn force_get_spot_position_mut(
        &mut self,
        market_index: u16,
    ) -> DriftResult<&mut SpotPosition> {
        self.get_spot_position_index(market_index)
            .or_else(|_| self.add_spot_position(market_index, SpotBalanceType::Deposit))
            .map(move |market_index| &mut self.spot_positions[market_index])
    }

    pub fn force_get_spot_position_index(&mut self, market_index: u16) -> DriftResult<usize> {
        self.get_spot_position_index(market_index)
            .or_else(|_| self.add_spot_position(market_index, SpotBalanceType::Deposit))
    }

    pub fn get_perp_position(&self, market_index: u16) -> DriftResult<&PerpPosition> {
        Ok(&self.perp_positions[get_position_index(&self.perp_positions, market_index)?])
    }

    pub fn get_perp_position_mut(&mut self, market_index: u16) -> DriftResult<&mut PerpPosition> {
        Ok(&mut self.perp_positions[get_position_index(&self.perp_positions, market_index)?])
    }

    pub fn force_get_perp_position_mut(
        &mut self,
        market_index: u16,
    ) -> DriftResult<&mut PerpPosition> {
        let position_index = get_position_index(&self.perp_positions, market_index)
            .or_else(|_| add_new_position(&mut self.perp_positions, market_index))?;
        Ok(&mut self.perp_positions[position_index])
    }

    pub fn get_order_index(&self, order_id: u32) -> DriftResult<usize> {
        self.orders
            .iter()
            .position(|order| order.order_id == order_id && order.status == OrderStatus::Open)
            .ok_or(ErrorCode::OrderDoesNotExist)
    }

    pub fn get_order_index_by_user_order_id(&self, user_order_id: u8) -> DriftResult<usize> {
        self.orders
            .iter()
            .position(|order| {
                order.user_order_id == user_order_id && order.status == OrderStatus::Open
            })
            .ok_or(ErrorCode::OrderDoesNotExist)
    }

    pub fn get_order(&self, order_id: u32) -> Option<&Order> {
        self.orders.iter().find(|order| order.order_id == order_id)
    }

    pub fn get_last_order_id(&self) -> u32 {
        if self.next_order_id == 1 {
            u32::MAX
        } else {
            self.next_order_id - 1
        }
    }

    pub fn increment_total_deposits(
        &mut self,
        amount: u64,
        price: i64,
        precision: u128,
    ) -> DriftResult {
        let value = amount
            .cast::<u128>()?
            .safe_mul(price.cast::<u128>()?)?
            .safe_div(precision)?
            .cast::<u64>()?;
        self.total_deposits = self.total_deposits.saturating_add(value);

        Ok(())
    }

    pub fn increment_total_withdraws(
        &mut self,
        amount: u64,
        price: i64,
        precision: u128,
    ) -> DriftResult {
        let value = amount
            .cast::<u128>()?
            .safe_mul(price.cast()?)?
            .safe_div(precision)?
            .cast::<u64>()?;
        self.total_withdraws = self.total_withdraws.saturating_add(value);

        Ok(())
    }

    pub fn increment_total_socialized_loss(&mut self, value: u64) -> DriftResult {
        self.total_social_loss = self.total_social_loss.saturating_add(value);

        Ok(())
    }

    pub fn update_cumulative_spot_fees(&mut self, amount: i64) -> DriftResult {
        safe_increment!(self.cumulative_spot_fees, amount);
        Ok(())
    }

    pub fn update_cumulative_perp_funding(&mut self, amount: i64) -> DriftResult {
        safe_increment!(self.cumulative_perp_funding, amount);
        Ok(())
    }

    pub fn enter_liquidation(&mut self, slot: u64) -> DriftResult<u16> {
        if self.is_being_liquidated() {
            return self.next_liquidation_id.safe_sub(1);
        }

        self.add_user_status(UserStatus::BeingLiquidated);
        self.liquidation_margin_freed = 0;
        self.last_active_slot = slot;
        Ok(get_then_update_id!(self, next_liquidation_id))
    }

    pub fn exit_liquidation(&mut self) {
        self.remove_user_status(UserStatus::BeingLiquidated);
        self.remove_user_status(UserStatus::Bankrupt);
        self.liquidation_margin_freed = 0;
    }

    pub fn enter_bankruptcy(&mut self) {
        self.remove_user_status(UserStatus::BeingLiquidated);
        self.add_user_status(UserStatus::Bankrupt);
    }

    pub fn exit_bankruptcy(&mut self) {
        self.remove_user_status(UserStatus::BeingLiquidated);
        self.remove_user_status(UserStatus::Bankrupt);
        self.liquidation_margin_freed = 0;
    }

    pub fn increment_margin_freed(&mut self, margin_free: u64) -> DriftResult {
        self.liquidation_margin_freed = self.liquidation_margin_freed.safe_add(margin_free)?;
        Ok(())
    }

    pub fn update_last_active_slot(&mut self, slot: u64) {
        if !self.is_being_liquidated() {
            self.last_active_slot = slot;
        }
        self.idle = false;
    }

    pub fn increment_open_orders(&mut self, is_auction: bool) {
        self.open_orders = self.open_orders.saturating_add(1);
        self.has_open_order = self.open_orders > 0;
        if is_auction {
            self.open_auctions = self.open_auctions.saturating_add(1);
            self.has_open_auction = self.open_auctions > 0;
        }
    }

    pub fn decrement_open_orders(&mut self, is_auction: bool) {
        self.open_orders = self.open_orders.saturating_sub(1);
        self.has_open_order = self.open_orders > 0;
        if is_auction {
            self.open_auctions = self.open_auctions.saturating_sub(1);
            self.has_open_auction = self.open_auctions > 0;
        }
    }

    pub fn qualifies_for_withdraw_fee(&self, user_stats: &UserStats) -> bool {
        let min_total_withdraws = 10_000_000 * QUOTE_PRECISION_U64; // $10M

        // if total withdraws are greater than $10M and user has paid more than %.01 of it in fees
        self.total_withdraws >= min_total_withdraws
            && self.total_withdraws / user_stats.fees.total_fee_paid.max(1) > 10_000
    }

    pub fn update_reduce_only_status(&mut self, reduce_only: bool) -> DriftResult {
        if reduce_only {
            self.add_user_status(UserStatus::ReduceOnly);
        } else {
            self.remove_user_status(UserStatus::ReduceOnly);
        }

        Ok(())
    }
}

#[zero_copy(unsafe)]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct UserFees {
    /// Total taker fee paid
    /// precision: QUOTE_PRECISION
    pub total_fee_paid: u64,
    /// Total maker fee rebate
    /// precision: QUOTE_PRECISION
    pub total_fee_rebate: u64,
    /// Total discount from holding token
    /// precision: QUOTE_PRECISION
    pub total_token_discount: u64,
    /// Total discount from being referred
    /// precision: QUOTE_PRECISION
    pub total_referee_discount: u64,
    /// Total reward to referrer
    /// precision: QUOTE_PRECISION
    pub total_referrer_reward: u64,
    /// Total reward to referrer this epoch
    /// precision: QUOTE_PRECISION
    pub current_epoch_referrer_reward: u64,
}

#[zero_copy(unsafe)]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct SpotPosition {
    /// The scaled balance of the position. To get the token amount, multiply by the cumulative deposit/borrow
    /// interest of corresponding market.
    /// precision: SPOT_BALANCE_PRECISION
    pub scaled_balance: u64,
    /// How many spot bids the user has open
    /// precision: token mint precision
    pub open_bids: i64,
    /// How many spot asks the user has open
    /// precision: token mint precision
    pub open_asks: i64,
    /// The cumulative deposits/borrows a user has made into a market
    /// precision: token mint precision
    pub cumulative_deposits: i64,
    /// The market index of the corresponding spot market
    pub market_index: u16,
    /// Whether the position is deposit or borrow
    pub balance_type: SpotBalanceType,
    /// Number of open orders
    pub open_orders: u8,
    pub padding: [u8; 4],
}

impl SpotBalance for SpotPosition {
    fn market_index(&self) -> u16 {
        self.market_index
    }

    fn balance_type(&self) -> &SpotBalanceType {
        &self.balance_type
    }

    fn balance(&self) -> u128 {
        self.scaled_balance as u128
    }

    fn increase_balance(&mut self, delta: u128) -> DriftResult {
        self.scaled_balance = self.scaled_balance.safe_add(delta.cast()?)?;
        Ok(())
    }

    fn decrease_balance(&mut self, delta: u128) -> DriftResult {
        self.scaled_balance = self.scaled_balance.safe_sub(delta.cast()?)?;
        Ok(())
    }

    fn update_balance_type(&mut self, balance_type: SpotBalanceType) -> DriftResult {
        self.balance_type = balance_type;
        Ok(())
    }
}

#[derive(Clone, Copy, Default, Eq, PartialEq, Debug)]
pub struct OrderFillSimulation {
    pub token_amount: i128,
    pub orders_value: i128,
    pub token_value: i128,
    pub weighted_token_value: i128,
    pub free_collateral_contribution: i128,
}

impl OrderFillSimulation {
    pub fn riskier_side(ask: Self, bid: Self) -> Self {
        if ask.free_collateral_contribution <= bid.free_collateral_contribution {
            ask
        } else {
            bid
        }
    }

    pub fn risk_increasing(&self, after: Self) -> bool {
        after.free_collateral_contribution < self.free_collateral_contribution
    }

    pub fn apply_user_custom_margin_ratio(
        mut self,
        spot_market: &SpotMarket,
        oracle_price: i64,
        user_custom_margin_ratio: u32,
    ) -> DriftResult<Self> {
        if user_custom_margin_ratio == 0 {
            return Ok(self);
        }

        if self.weighted_token_value < 0 {
            let max_liability_weight = spot_market
                .get_liability_weight(
                    self.token_amount.unsigned_abs(),
                    &MarginRequirementType::Initial,
                )?
                .max(user_custom_margin_ratio.safe_add(SPOT_WEIGHT_PRECISION)?);

            self.weighted_token_value = self
                .token_value
                .safe_mul(max_liability_weight.cast()?)?
                .safe_div(SPOT_WEIGHT_PRECISION_I128)?;
        } else if self.weighted_token_value > 0 {
            let min_asset_weight = spot_market
                .get_asset_weight(
                    self.token_amount.unsigned_abs(),
                    oracle_price,
                    &MarginRequirementType::Initial,
                )?
                .min(SPOT_WEIGHT_PRECISION.saturating_sub(user_custom_margin_ratio));

            self.weighted_token_value = self
                .token_value
                .safe_mul(min_asset_weight.cast()?)?
                .safe_div(SPOT_WEIGHT_PRECISION_I128)?;
        }

        self.free_collateral_contribution =
            self.weighted_token_value.safe_add(self.orders_value)?;

        Ok(self)
    }
}

impl SpotPosition {
    pub fn is_available(&self) -> bool {
        self.scaled_balance == 0 && self.open_orders == 0
    }

    pub fn has_open_order(&self) -> bool {
        self.open_orders != 0 || self.open_bids != 0 || self.open_asks != 0
    }

    pub fn margin_requirement_for_open_orders(&self) -> DriftResult<u128> {
        self.open_orders
            .cast::<u128>()?
            .safe_mul(OPEN_ORDER_MARGIN_REQUIREMENT)
    }

    pub fn get_token_amount(&self, spot_market: &SpotMarket) -> DriftResult<u128> {
        get_token_amount(self.scaled_balance.cast()?, spot_market, &self.balance_type)
    }

    pub fn get_signed_token_amount(&self, spot_market: &SpotMarket) -> DriftResult<i128> {
        get_signed_token_amount(
            get_token_amount(self.scaled_balance.cast()?, spot_market, &self.balance_type)?,
            &self.balance_type,
        )
    }

    pub fn get_worst_case_fill_simulation(
        &self,
        spot_market: &SpotMarket,
        strict_oracle_price: &StrictOraclePrice,
        token_amount: Option<i128>,
        margin_type: MarginRequirementType,
    ) -> DriftResult<OrderFillSimulation> {
        let [bid_simulation, ask_simulation] = self.simulate_fills_both_sides(
            spot_market,
            strict_oracle_price,
            token_amount,
            margin_type,
        )?;

        Ok(OrderFillSimulation::riskier_side(
            ask_simulation,
            bid_simulation,
        ))
    }

    pub fn simulate_fills_both_sides(
        &self,
        spot_market: &SpotMarket,
        strict_oracle_price: &StrictOraclePrice,
        token_amount: Option<i128>,
        margin_type: MarginRequirementType,
    ) -> DriftResult<[OrderFillSimulation; 2]> {
        let token_amount = match token_amount {
            Some(token_amount) => token_amount,
            None => self.get_signed_token_amount(spot_market)?,
        };

        let token_value =
            get_strict_token_value(token_amount, spot_market.decimals, strict_oracle_price)?;

        let calculate_weighted_token_value = |token_amount: i128, token_value: i128| {
            if token_value > 0 {
                let asset_weight = spot_market.get_asset_weight(
                    token_amount.unsigned_abs(),
                    strict_oracle_price.current,
                    &margin_type,
                )?;

                token_value
                    .safe_mul(asset_weight.cast()?)?
                    .safe_div(SPOT_WEIGHT_PRECISION_I128)
            } else if token_value < 0 {
                let liability_weight =
                    spot_market.get_liability_weight(token_amount.unsigned_abs(), &margin_type)?;

                token_value
                    .safe_mul(liability_weight.cast()?)?
                    .safe_div(SPOT_WEIGHT_PRECISION_I128)
            } else {
                Ok(0)
            }
        };

        if self.open_bids == 0 && self.open_asks == 0 {
            let weighted_token_value = calculate_weighted_token_value(token_amount, token_value)?;

            let calculation = OrderFillSimulation {
                token_amount,
                orders_value: 0,
                token_value,
                weighted_token_value,
                free_collateral_contribution: weighted_token_value,
            };

            return Ok([calculation, calculation]);
        }

        let simulate_side = |strict_oracle_price: &StrictOraclePrice,
                             token_amount: i128,
                             open_orders: i128| {
            let order_value = get_token_value(
                -open_orders as i128,
                spot_market.decimals,
                strict_oracle_price.max(),
            )?;
            let token_amount_after_fill = token_amount.safe_add(open_orders)?;
            let token_value_after_fill = token_value.safe_add(order_value.neg())?;

            let weighted_token_value_after_fill =
                calculate_weighted_token_value(token_amount_after_fill, token_value_after_fill)?;

            let free_collateral_contribution =
                weighted_token_value_after_fill.safe_add(order_value)?;

            Ok(OrderFillSimulation {
                token_amount: token_amount_after_fill,
                orders_value: order_value,
                token_value: token_value_after_fill,
                weighted_token_value: weighted_token_value_after_fill,
                free_collateral_contribution,
            })
        };

        let bid_simulation =
            simulate_side(strict_oracle_price, token_amount, self.open_bids.cast()?)?;

        let ask_simulation =
            simulate_side(strict_oracle_price, token_amount, self.open_asks.cast()?)?;

        Ok([bid_simulation, ask_simulation])
    }
}

#[zero_copy(unsafe)]
#[derive(Default, Debug, Eq, PartialEq)]
#[repr(C)]
pub struct PerpPosition {
    /// The perp market's last cumulative funding rate. Used to calculate the funding payment owed to user
    /// precision: FUNDING_RATE_PRECISION
    pub last_cumulative_funding_rate: i64,
    /// the size of the users perp position
    /// precision: BASE_PRECISION
    pub base_asset_amount: i64,
    /// Used to calculate the users pnl. Upon entry, is equal to base_asset_amount * avg entry price - fees
    /// Updated when the user open/closes position or settles pnl. Includes fees/funding
    /// precision: QUOTE_PRECISION
    pub quote_asset_amount: i64,
    /// The amount of quote the user would need to exit their position at to break even
    /// Updated when the user open/closes position or settles pnl. Includes fees/funding
    /// precision: QUOTE_PRECISION
    pub quote_break_even_amount: i64,
    /// The amount quote the user entered the position with. Equal to base asset amount * avg entry price
    /// Updated when the user open/closes position. Excludes fees/funding
    /// precision: QUOTE_PRECISION
    pub quote_entry_amount: i64,
    /// The amount of open bids the user has in this perp market
    /// precision: BASE_PRECISION
    pub open_bids: i64,
    /// The amount of open asks the user has in this perp market
    /// precision: BASE_PRECISION
    pub open_asks: i64,
    /// The amount of pnl settled in this market since opening the position
    /// precision: QUOTE_PRECISION
    pub settled_pnl: i64,
    /// The number of lp (liquidity provider) shares the user has in this perp market
    /// LP shares allow users to provide liquidity via the AMM
    /// precision: BASE_PRECISION
    pub lp_shares: u64,
    /// The last base asset amount per lp the amm had
    /// Used to settle the users lp position
    /// precision: BASE_PRECISION
    pub last_base_asset_amount_per_lp: i64,
    /// The last quote asset amount per lp the amm had
    /// Used to settle the users lp position
    /// precision: QUOTE_PRECISION
    pub last_quote_asset_amount_per_lp: i64,
    /// Settling LP position can lead to a small amount of base asset being left over smaller than step size
    /// This records that remainder so it can be settled later on
    /// precision: BASE_PRECISION
    pub remainder_base_asset_amount: i32,
    /// The market index for the perp market
    pub market_index: u16,
    /// The number of open orders
    pub open_orders: u8,
    pub per_lp_base: i8,
}

impl PerpPosition {
    pub fn is_for(&self, market_index: u16) -> bool {
        self.market_index == market_index && !self.is_available()
    }

    pub fn is_available(&self) -> bool {
        !self.is_open_position()
            && !self.has_open_order()
            && !self.has_unsettled_pnl()
            && !self.is_lp()
    }

    pub fn is_open_position(&self) -> bool {
        self.base_asset_amount != 0
    }

    pub fn has_open_order(&self) -> bool {
        self.open_orders != 0 || self.open_bids != 0 || self.open_asks != 0
    }

    pub fn margin_requirement_for_lp_shares(
        &self,
        order_step_size: u64,
        valuation_price: i64,
    ) -> DriftResult<u128> {
        if !self.is_lp() {
            return Ok(0);
        }
        Ok(QUOTE_PRECISION.max(
            order_step_size
                .cast::<u128>()?
                .safe_mul(valuation_price.cast()?)?
                .safe_div(PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO)?,
        ))
    }

    pub fn margin_requirement_for_open_orders(&self) -> DriftResult<u128> {
        self.open_orders
            .cast::<u128>()?
            .safe_mul(OPEN_ORDER_MARGIN_REQUIREMENT)
    }

    pub fn is_lp(&self) -> bool {
        self.lp_shares > 0
    }

    pub fn simulate_settled_lp_position(
        &self,
        market: &PerpMarket,
        valuation_price: i64,
    ) -> DriftResult<PerpPosition> {
        let mut settled_position = *self;

        if !settled_position.is_lp() {
            return Ok(settled_position);
        }

        apply_lp_rebase_to_perp_position(market, &mut settled_position)?;

        // compute lp metrics
        let mut lp_metrics = calculate_settle_lp_metrics(&market.amm, &settled_position)?;

        // compute settled position
        let base_asset_amount = settled_position
            .base_asset_amount
            .safe_add(lp_metrics.base_asset_amount.cast()?)?;

        let mut quote_asset_amount = settled_position
            .quote_asset_amount
            .safe_add(lp_metrics.quote_asset_amount.cast()?)?;

        let mut new_remainder_base_asset_amount = settled_position
            .remainder_base_asset_amount
            .cast::<i64>()?
            .safe_add(lp_metrics.remainder_base_asset_amount.cast()?)?;

        if new_remainder_base_asset_amount.unsigned_abs() >= market.amm.order_step_size {
            let (standardized_remainder_base_asset_amount, remainder_base_asset_amount) =
                crate::math::orders::standardize_base_asset_amount_with_remainder_i128(
                    new_remainder_base_asset_amount.cast()?,
                    market.amm.order_step_size.cast()?,
                )?;

            lp_metrics.base_asset_amount = lp_metrics
                .base_asset_amount
                .safe_add(standardized_remainder_base_asset_amount)?;

            new_remainder_base_asset_amount = remainder_base_asset_amount.cast()?;
        } else {
            new_remainder_base_asset_amount = new_remainder_base_asset_amount.cast()?;
        }

        // dust position in baa/qaa
        if new_remainder_base_asset_amount != 0 {
            let dust_base_asset_value = calculate_base_asset_value_with_oracle_price(
                new_remainder_base_asset_amount.cast()?,
                valuation_price,
            )?
            .safe_add(1)?;

            quote_asset_amount = quote_asset_amount.safe_sub(dust_base_asset_value.cast()?)?;
        }

        let (lp_bids, lp_asks) = calculate_lp_open_bids_asks(&settled_position, market)?;

        let open_bids = settled_position.open_bids.safe_add(lp_bids)?;

        let open_asks = settled_position.open_asks.safe_add(lp_asks)?;

        settled_position.base_asset_amount = base_asset_amount;
        settled_position.quote_asset_amount = quote_asset_amount;
        settled_position.open_bids = open_bids;
        settled_position.open_asks = open_asks;

        Ok(settled_position)
    }

    pub fn has_unsettled_pnl(&self) -> bool {
        self.base_asset_amount == 0 && self.quote_asset_amount != 0
    }

    pub fn worst_case_base_asset_amount(&self) -> DriftResult<i128> {
        let base_asset_amount_all_bids_fill = self.base_asset_amount.safe_add(self.open_bids)?;
        let base_asset_amount_all_asks_fill = self.base_asset_amount.safe_add(self.open_asks)?;

        if base_asset_amount_all_bids_fill
            .checked_abs()
            .ok_or_else(math_error!())?
            > base_asset_amount_all_asks_fill
                .checked_abs()
                .ok_or_else(math_error!())?
        {
            base_asset_amount_all_bids_fill.cast()
        } else {
            base_asset_amount_all_asks_fill.cast()
        }
    }

    pub fn get_direction(&self) -> PositionDirection {
        if self.base_asset_amount >= 0 {
            PositionDirection::Long
        } else {
            PositionDirection::Short
        }
    }

    pub fn get_direction_to_close(&self) -> PositionDirection {
        if self.base_asset_amount >= 0 {
            PositionDirection::Short
        } else {
            PositionDirection::Long
        }
    }

    pub fn get_cost_basis(&self) -> DriftResult<i128> {
        if self.base_asset_amount == 0 {
            return Ok(0);
        }

        (-self.quote_asset_amount.cast::<i128>()?)
            .safe_mul(PRICE_PRECISION_I128)?
            .safe_mul(AMM_TO_QUOTE_PRECISION_RATIO_I128)?
            .safe_div(self.base_asset_amount.cast()?)
    }

    pub fn get_unrealized_pnl(&self, oracle_price: i64) -> DriftResult<i128> {
        let (_, unrealized_pnl) =
            calculate_base_asset_value_and_pnl_with_oracle_price(self, oracle_price)?;

        Ok(unrealized_pnl)
    }

    pub fn get_claimable_pnl(&self, oracle_price: i64, pnl_pool_excess: i128) -> DriftResult<i128> {
        let (_, unrealized_pnl) =
            calculate_base_asset_value_and_pnl_with_oracle_price(self, oracle_price)?;
        if unrealized_pnl > 0 {
            // this limits the amount of positive pnl that can be settled to be the amount of positive pnl
            // realized by reducing/closing position
            let max_positive_pnl = self
                .quote_asset_amount
                .cast::<i128>()?
                .safe_sub(self.quote_entry_amount.cast()?)
                .map(|delta| delta.max(0))?
                .safe_add(pnl_pool_excess.max(0))?;

            Ok(unrealized_pnl.min(max_positive_pnl))
        } else {
            Ok(unrealized_pnl)
        }
    }
}

pub type PerpPositions = [PerpPosition; 8];

#[cfg_attr(feature = "sdk", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "sdk", serde(rename_all = "camelCase"))]
#[zero_copy(unsafe)]
#[repr(C)]
#[derive(AnchorSerialize, AnchorDeserialize, PartialEq, Debug, Eq)]
pub struct Order {
    /// The slot the order was placed
    pub slot: u64,
    /// The limit price for the order (can be 0 for market orders)
    /// For orders with an auction, this price isn't used until the auction is complete
    /// precision: PRICE_PRECISION
    pub price: u64,
    /// The size of the order
    /// precision for perps: BASE_PRECISION
    /// precision for spot: token mint precision
    pub base_asset_amount: u64,
    /// The amount of the order filled
    /// precision for perps: BASE_PRECISION
    /// precision for spot: token mint precision
    pub base_asset_amount_filled: u64,
    /// The amount of quote filled for the order
    /// precision: QUOTE_PRECISION
    pub quote_asset_amount_filled: u64,
    /// At what price the order will be triggered. Only relevant for trigger orders
    /// precision: PRICE_PRECISION
    pub trigger_price: u64,
    /// The start price for the auction. Only relevant for market/oracle orders
    /// precision: PRICE_PRECISION
    pub auction_start_price: i64,
    /// The end price for the auction. Only relevant for market/oracle orders
    /// precision: PRICE_PRECISION
    pub auction_end_price: i64,
    /// The time when the order will expire
    pub max_ts: i64,
    /// If set, the order limit price is the oracle price + this offset
    /// precision: PRICE_PRECISION
    pub oracle_price_offset: i32,
    /// The id for the order. Each users has their own order id space
    pub order_id: u32,
    /// The perp/spot market index
    pub market_index: u16,
    /// Whether the order is open or unused
    pub status: OrderStatus,
    /// The type of order
    pub order_type: OrderType,
    /// Whether market is spot or perp
    pub market_type: MarketType,
    /// User generated order id. Can make it easier to place/cancel orders
    pub user_order_id: u8,
    /// What the users position was when the order was placed
    pub existing_position_direction: PositionDirection,
    /// Whether the user is going long or short. LONG = bid, SHORT = ask
    pub direction: PositionDirection,
    /// Whether the order is allowed to only reduce position size
    pub reduce_only: bool,
    /// Whether the order must be a maker
    pub post_only: bool,
    /// Whether the order must be canceled the same slot it is placed
    pub immediate_or_cancel: bool,
    /// Whether the order is triggered above or below the trigger price. Only relevant for trigger orders
    pub trigger_condition: OrderTriggerCondition,
    /// How many slots the auction lasts
    pub auction_duration: u8,
    #[cfg_attr(feature = "sdk", serde(skip))]
    pub padding: [u8; 3],
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Eq, Debug)]
pub enum AssetType {
    Base,
    Quote,
}

impl Order {
    pub fn has_oracle_price_offset(self) -> bool {
        self.oracle_price_offset != 0
    }

    pub fn get_limit_price(
        &self,
        valid_oracle_price: Option<i64>,
        fallback_price: Option<u64>,
        slot: u64,
        tick_size: u64,
    ) -> DriftResult<Option<u64>> {
        let price = if self.has_auction_price(self.slot, self.auction_duration, slot)? {
            Some(calculate_auction_price(
                self,
                slot,
                tick_size,
                valid_oracle_price,
            )?)
        } else if self.has_oracle_price_offset() {
            let oracle_price = valid_oracle_price.ok_or_else(|| {
                msg!("Could not find oracle too calculate oracle offset limit price");
                ErrorCode::OracleNotFound
            })?;

            let limit_price = oracle_price.safe_add(self.oracle_price_offset.cast()?)?;

            if limit_price <= 0 {
                msg!("Oracle offset limit price below zero: {}", limit_price);
                return Err(crate::error::ErrorCode::InvalidOracleOffset);
            }

            Some(standardize_price(
                limit_price.cast::<u64>()?,
                tick_size,
                self.direction,
            )?)
        } else if self.price == 0 {
            match fallback_price {
                Some(price) => Some(standardize_price(price, tick_size, self.direction)?),
                None => None,
            }
        } else {
            Some(self.price)
        };

        Ok(price)
    }

    #[track_caller]
    #[inline(always)]
    pub fn force_get_limit_price(
        &self,
        valid_oracle_price: Option<i64>,
        fallback_price: Option<u64>,
        slot: u64,
        tick_size: u64,
    ) -> DriftResult<u64> {
        match self.get_limit_price(valid_oracle_price, fallback_price, slot, tick_size)? {
            Some(price) => Ok(price),
            None => {
                let caller = Location::caller();
                msg!(
                    "Could not get limit price at {}:{}",
                    caller.file(),
                    caller.line()
                );
                Err(ErrorCode::UnableToGetLimitPrice)
            }
        }
    }

    pub fn has_limit_price(self, slot: u64) -> DriftResult<bool> {
        Ok(self.price > 0
            || self.has_oracle_price_offset()
            || !is_auction_complete(self.slot, self.auction_duration, slot)?)
    }

    pub fn is_auction_complete(self, slot: u64) -> DriftResult<bool> {
        is_auction_complete(self.slot, self.auction_duration, slot)
    }

    pub fn has_auction(&self) -> bool {
        self.auction_duration != 0
    }

    pub fn has_auction_price(
        &self,
        order_slot: u64,
        auction_duration: u8,
        slot: u64,
    ) -> DriftResult<bool> {
        let auction_complete = is_auction_complete(order_slot, auction_duration, slot)?;
        let has_auction_prices = self.auction_start_price != 0 || self.auction_end_price != 0;
        Ok(!auction_complete && has_auction_prices)
    }

    /// Passing in an existing_position forces the function to consider the order's reduce only status
    pub fn get_base_asset_amount_unfilled(
        &self,
        existing_position: Option<i64>,
    ) -> DriftResult<u64> {
        let base_asset_amount_unfilled = self
            .base_asset_amount
            .safe_sub(self.base_asset_amount_filled)?;

        let existing_position = match existing_position {
            Some(existing_position) => existing_position,
            None => {
                return Ok(base_asset_amount_unfilled);
            }
        };

        // if order is post only, can disregard reduce only
        if !self.reduce_only || self.post_only {
            return Ok(base_asset_amount_unfilled);
        }

        if existing_position == 0 {
            return Ok(0);
        }

        match self.direction {
            PositionDirection::Long => {
                if existing_position > 0 {
                    Ok(0)
                } else {
                    Ok(base_asset_amount_unfilled.min(existing_position.unsigned_abs()))
                }
            }
            PositionDirection::Short => {
                if existing_position < 0 {
                    Ok(0)
                } else {
                    Ok(base_asset_amount_unfilled.min(existing_position.unsigned_abs()))
                }
            }
        }
    }

    /// Stardardizes the base asset amount unfilled to the nearest step size
    /// Particularly important for spot positions where existing position can be dust
    pub fn get_standardized_base_asset_amount_unfilled(
        &self,
        existing_position: Option<i64>,
        step_size: u64,
    ) -> DriftResult<u64> {
        standardize_base_asset_amount(
            self.get_base_asset_amount_unfilled(existing_position)?,
            step_size,
        )
    }

    pub fn must_be_triggered(&self) -> bool {
        matches!(
            self.order_type,
            OrderType::TriggerMarket | OrderType::TriggerLimit
        )
    }

    pub fn triggered(&self) -> bool {
        matches!(
            self.trigger_condition,
            OrderTriggerCondition::TriggeredAbove | OrderTriggerCondition::TriggeredBelow
        )
    }

    pub fn is_jit_maker(&self) -> bool {
        self.post_only && self.immediate_or_cancel
    }

    pub fn is_open_order_for_market(&self, market_index: u16, market_type: &MarketType) -> bool {
        self.market_index == market_index
            && self.status == OrderStatus::Open
            && &self.market_type == market_type
    }

    pub fn get_spot_position_update_direction(&self, asset_type: AssetType) -> SpotBalanceType {
        match (self.direction, asset_type) {
            (PositionDirection::Long, AssetType::Base) => SpotBalanceType::Deposit,
            (PositionDirection::Long, AssetType::Quote) => SpotBalanceType::Borrow,
            (PositionDirection::Short, AssetType::Base) => SpotBalanceType::Borrow,
            (PositionDirection::Short, AssetType::Quote) => SpotBalanceType::Deposit,
        }
    }

    pub fn is_market_order(&self) -> bool {
        matches!(
            self.order_type,
            OrderType::Market | OrderType::TriggerMarket | OrderType::Oracle
        )
    }

    pub fn is_limit_order(&self) -> bool {
        matches!(self.order_type, OrderType::Limit | OrderType::TriggerLimit)
    }

    pub fn is_resting_limit_order(&self, slot: u64) -> DriftResult<bool> {
        if !self.is_limit_order() {
            return Ok(false);
        }

        if self.order_type == OrderType::TriggerLimit {
            return match self.direction {
                PositionDirection::Long if self.trigger_price < self.price => {
                    return Ok(false);
                }
                PositionDirection::Short if self.trigger_price > self.price => {
                    return Ok(false);
                }
                _ => self.is_auction_complete(slot),
            };
        }

        Ok(self.post_only || self.is_auction_complete(slot)?)
    }
}

impl Default for Order {
    fn default() -> Self {
        Self {
            status: OrderStatus::Init,
            order_type: OrderType::Limit,
            market_type: MarketType::Perp,
            slot: 0,
            order_id: 0,
            user_order_id: 0,
            market_index: 0,
            price: 0,
            existing_position_direction: PositionDirection::Long,
            base_asset_amount: 0,
            base_asset_amount_filled: 0,
            quote_asset_amount_filled: 0,
            direction: PositionDirection::Long,
            reduce_only: false,
            post_only: false,
            immediate_or_cancel: false,
            trigger_price: 0,
            trigger_condition: OrderTriggerCondition::Above,
            oracle_price_offset: 0,
            auction_start_price: 0,
            auction_end_price: 0,
            auction_duration: 0,
            max_ts: 0,
            padding: [0; 3],
        }
    }
}

#[cfg_attr(feature = "sdk", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "sdk", serde(rename_all = "camelCase"))]
#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Eq, Debug)]
pub enum OrderStatus {
    /// The order is not in use
    Init,
    /// Order is open
    Open,
    /// Order has been filled
    Filled,
    /// Order has been canceled
    Canceled,
}

#[cfg_attr(feature = "sdk", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "sdk", serde(rename_all = "camelCase"))]
#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum OrderType {
    Market,
    Limit,
    TriggerMarket,
    TriggerLimit,
    /// Market order where the auction prices are oracle offsets
    Oracle,
}

impl Default for OrderType {
    fn default() -> Self {
        OrderType::Limit
    }
}

#[cfg_attr(feature = "sdk", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "sdk", serde(rename_all = "camelCase"))]
#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum OrderTriggerCondition {
    Above,
    Below,
    TriggeredAbove, // above condition has been triggered
    TriggeredBelow, // below condition has been triggered
}

impl Default for OrderTriggerCondition {
    fn default() -> Self {
        OrderTriggerCondition::Above
    }
}

#[cfg_attr(feature = "sdk", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "sdk", serde(rename_all = "camelCase"))]
#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum MarketType {
    Spot,
    Perp,
}

impl Default for MarketType {
    fn default() -> Self {
        MarketType::Spot
    }
}

#[account(zero_copy(unsafe))]
#[derive(Eq, PartialEq, Debug)]
#[repr(C)]
pub struct UserStats {
    /// The authority for all of a users sub accounts
    pub authority: Pubkey,
    /// The address that referred this user
    pub referrer: Pubkey,
    /// Stats on the fees paid by the user
    pub fees: UserFees,

    /// The timestamp of the next epoch
    /// Epoch is used to limit referrer rewards earned in single epoch
    pub next_epoch_ts: i64,

    /// Rolling 30day maker volume for user
    /// precision: QUOTE_PRECISION
    pub maker_volume_30d: u64,
    /// Rolling 30day taker volume for user
    /// precision: QUOTE_PRECISION
    pub taker_volume_30d: u64,
    /// Rolling 30day filler volume for user
    /// precision: QUOTE_PRECISION
    pub filler_volume_30d: u64,
    /// last time the maker volume was updated
    pub last_maker_volume_30d_ts: i64,
    /// last time the taker volume was updated
    pub last_taker_volume_30d_ts: i64,
    /// last time the filler volume was updated
    pub last_filler_volume_30d_ts: i64,

    /// The amount of tokens staked in the quote spot markets if
    pub if_staked_quote_asset_amount: u64,
    /// The current number of sub accounts
    pub number_of_sub_accounts: u16,
    /// The number of sub accounts created. Can be greater than the number of sub accounts if user
    /// has deleted sub accounts
    pub number_of_sub_accounts_created: u16,
    /// Whether the user is a referrer. Sub account 0 can not be deleted if user is a referrer
    pub is_referrer: bool,
    pub disable_update_perp_bid_ask_twap: bool,
    pub padding: [u8; 50],
}

impl Default for UserStats {
    fn default() -> Self {
        UserStats {
            authority: Pubkey::default(),
            referrer: Pubkey::default(),
            fees: UserFees::default(),
            next_epoch_ts: 0,
            maker_volume_30d: 0,
            taker_volume_30d: 0,
            filler_volume_30d: 0,
            last_maker_volume_30d_ts: 0,
            last_taker_volume_30d_ts: 0,
            last_filler_volume_30d_ts: 0,
            if_staked_quote_asset_amount: 0,
            number_of_sub_accounts: 0,
            number_of_sub_accounts_created: 0,
            is_referrer: false,
            disable_update_perp_bid_ask_twap: false,
            padding: [0; 50],
        }
    }
}

impl Size for UserStats {
    const SIZE: usize = 240;
}

impl UserStats {
    pub fn update_maker_volume_30d(&mut self, quote_asset_amount: u64, now: i64) -> DriftResult {
        let since_last = max(1_i64, now.safe_sub(self.last_maker_volume_30d_ts)?);

        self.maker_volume_30d = calculate_rolling_sum(
            self.maker_volume_30d,
            quote_asset_amount,
            since_last,
            THIRTY_DAY,
        )?;
        self.last_maker_volume_30d_ts = now;

        Ok(())
    }

    pub fn update_taker_volume_30d(&mut self, quote_asset_amount: u64, now: i64) -> DriftResult {
        let since_last = max(1_i64, now.safe_sub(self.last_taker_volume_30d_ts)?);

        self.taker_volume_30d = calculate_rolling_sum(
            self.taker_volume_30d,
            quote_asset_amount,
            since_last,
            THIRTY_DAY,
        )?;
        self.last_taker_volume_30d_ts = now;

        Ok(())
    }

    pub fn update_filler_volume(&mut self, quote_asset_amount: u64, now: i64) -> DriftResult {
        let since_last = max(1_i64, now.safe_sub(self.last_filler_volume_30d_ts)?);

        self.filler_volume_30d = calculate_rolling_sum(
            self.filler_volume_30d,
            quote_asset_amount,
            since_last,
            THIRTY_DAY,
        )?;

        self.last_filler_volume_30d_ts = now;

        Ok(())
    }

    pub fn increment_total_fees(&mut self, fee: u64) -> DriftResult {
        self.fees.total_fee_paid = self.fees.total_fee_paid.safe_add(fee)?;

        Ok(())
    }

    pub fn increment_total_rebate(&mut self, fee: u64) -> DriftResult {
        self.fees.total_fee_rebate = self.fees.total_fee_rebate.safe_add(fee)?;

        Ok(())
    }

    pub fn increment_total_referrer_reward(&mut self, reward: u64, now: i64) -> DriftResult {
        self.fees.total_referrer_reward = self.fees.total_referrer_reward.safe_add(reward)?;

        self.fees.current_epoch_referrer_reward =
            self.fees.current_epoch_referrer_reward.safe_add(reward)?;

        if now > self.next_epoch_ts {
            let n_epoch_durations = now
                .safe_sub(self.next_epoch_ts)?
                .safe_div(EPOCH_DURATION)?
                .safe_add(1)?;

            self.next_epoch_ts = self
                .next_epoch_ts
                .safe_add(EPOCH_DURATION.safe_mul(n_epoch_durations)?)?;

            self.fees.current_epoch_referrer_reward = 0;
        }

        Ok(())
    }

    pub fn increment_total_referee_discount(&mut self, discount: u64) -> DriftResult {
        self.fees.total_referee_discount = self.fees.total_referee_discount.safe_add(discount)?;

        Ok(())
    }

    pub fn has_referrer(&self) -> bool {
        !self.referrer.eq(&Pubkey::default())
    }

    pub fn get_total_30d_volume(&self) -> DriftResult<u64> {
        self.taker_volume_30d.safe_add(self.maker_volume_30d)
    }
}

#[account(zero_copy(unsafe))]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct ReferrerName {
    pub authority: Pubkey,
    pub user: Pubkey,
    pub user_stats: Pubkey,
    pub name: [u8; 32],
}

impl Size for ReferrerName {
    const SIZE: usize = 136;
}
