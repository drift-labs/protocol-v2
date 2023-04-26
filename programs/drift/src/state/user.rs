use crate::controller::position::{add_new_position, get_position_index, PositionDirection};
use crate::error::{DriftResult, ErrorCode};
use crate::get_then_update_id;
use crate::math::auction::{calculate_auction_price, is_auction_complete};
use crate::math::casting::Cast;
use crate::math::constants::{
    AMM_TO_QUOTE_PRECISION_RATIO_I128, EPOCH_DURATION, OPEN_ORDER_MARGIN_REQUIREMENT,
    PRICE_PRECISION_I128, QUOTE_SPOT_MARKET_INDEX, THIRTY_DAY,
};
use crate::math::orders::{standardize_base_asset_amount, standardize_price};
use crate::math::position::calculate_base_asset_value_and_pnl_with_oracle_price;
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::{get_signed_token_amount, get_token_amount, get_token_value};
use crate::math::stats::calculate_rolling_sum;
use crate::math_error;
use crate::safe_increment;
use crate::state::oracle::OraclePriceData;
use crate::state::spot_market::{SpotBalance, SpotBalanceType, SpotMarket};
use crate::state::traits::Size;
use crate::validate;
use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::msg;
use std::cmp::max;
use std::panic::Location;

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum UserStatus {
    Active,
    BeingLiquidated,
    Bankrupt,
}

impl Default for UserStatus {
    fn default() -> Self {
        UserStatus::Active
    }
}

// implement SIZE const for User
impl Size for User {
    const SIZE: usize = 4376;
}

#[account(zero_copy)]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct User {
    pub authority: Pubkey,
    pub delegate: Pubkey,
    pub name: [u8; 32],
    pub spot_positions: [SpotPosition; 8],
    pub perp_positions: [PerpPosition; 8],
    pub orders: [Order; 32],
    pub last_add_perp_lp_shares_ts: i64,
    pub total_deposits: u64,
    pub total_withdraws: u64,
    pub total_social_loss: u64,
    // Fees (taker fees, maker rebate, referrer reward, filler reward) and pnl for perps
    pub settled_perp_pnl: i64,
    // Fees (taker fees, maker rebate, filler reward) for spot
    pub cumulative_spot_fees: i64,
    pub cumulative_perp_funding: i64,
    pub liquidation_margin_freed: u64,
    pub last_active_slot: u64,
    pub next_order_id: u32,
    pub max_margin_ratio: u32,
    pub next_liquidation_id: u16,
    pub sub_account_id: u16,
    pub status: UserStatus,
    pub is_margin_trading_enabled: bool,
    pub idle: bool,
    pub padding: [u8; 25],
}

impl User {
    pub fn is_being_liquidated(&self) -> bool {
        matches!(
            self.status,
            UserStatus::BeingLiquidated | UserStatus::Bankrupt
        )
    }

    pub fn is_bankrupt(&self) -> bool {
        self.status == UserStatus::Bankrupt
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

        self.status = UserStatus::BeingLiquidated;
        self.liquidation_margin_freed = 0;
        self.last_active_slot = slot;
        Ok(get_then_update_id!(self, next_liquidation_id))
    }

    pub fn exit_liquidation(&mut self) {
        self.status = UserStatus::Active;
        self.liquidation_margin_freed = 0;
    }

    pub fn enter_bankruptcy(&mut self) {
        self.status = UserStatus::Bankrupt;
    }

    pub fn exit_bankruptcy(&mut self) {
        self.status = UserStatus::Active;
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
}

#[zero_copy]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct UserFees {
    pub total_fee_paid: u64,
    pub total_fee_rebate: u64,
    pub total_token_discount: u64,
    pub total_referee_discount: u64,
    pub total_referrer_reward: u64,
    pub current_epoch_referrer_reward: u64,
}

#[zero_copy]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct SpotPosition {
    pub scaled_balance: u64,
    pub open_bids: i64,
    pub open_asks: i64,
    pub cumulative_deposits: i64,
    pub market_index: u16,
    pub balance_type: SpotBalanceType,
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

    pub fn get_worst_case_token_amount(
        &self,
        spot_market: &SpotMarket,
        oracle_price_data: &OraclePriceData,
        twap_5min: Option<i64>,
        token_amount: Option<i128>,
    ) -> DriftResult<(i128, i128)> {
        let token_amount = match token_amount {
            Some(token_amount) => token_amount,
            None => self.get_signed_token_amount(spot_market)?,
        };

        let token_amount_all_bids_fill = token_amount.safe_add(self.open_bids as i128)?;

        let token_amount_all_asks_fill = token_amount.safe_add(self.open_asks as i128)?;

        let oracle_price = match twap_5min {
            Some(twap_5min) => twap_5min.max(oracle_price_data.price),
            None => oracle_price_data.price,
        };

        if token_amount_all_bids_fill.abs() > token_amount_all_asks_fill.abs() {
            let worst_case_orders_value =
                get_token_value(-self.open_bids as i128, spot_market.decimals, oracle_price)?;
            Ok((token_amount_all_bids_fill, worst_case_orders_value))
        } else {
            let worst_case_orders_value =
                get_token_value(-self.open_asks as i128, spot_market.decimals, oracle_price)?;
            Ok((token_amount_all_asks_fill, worst_case_orders_value))
        }
    }
}

#[zero_copy]
#[derive(Default, Debug, Eq, PartialEq)]
#[repr(C)]
pub struct PerpPosition {
    pub last_cumulative_funding_rate: i64,
    pub base_asset_amount: i64,
    pub quote_asset_amount: i64,
    pub quote_break_even_amount: i64,
    pub quote_entry_amount: i64,
    pub open_bids: i64,
    pub open_asks: i64,
    pub settled_pnl: i64,
    pub lp_shares: u64,
    pub last_base_asset_amount_per_lp: i64,
    pub last_quote_asset_amount_per_lp: i64,
    pub remainder_base_asset_amount: i32,
    pub market_index: u16,
    pub open_orders: u8,
    pub padding: [u8; 1],
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

    pub fn margin_requirement_for_open_orders(&self) -> DriftResult<u128> {
        self.open_orders
            .cast::<u128>()?
            .safe_mul(OPEN_ORDER_MARGIN_REQUIREMENT)
    }

    pub fn is_lp(&self) -> bool {
        self.lp_shares > 0
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

#[zero_copy]
#[repr(C)]
#[derive(AnchorSerialize, AnchorDeserialize, PartialEq, Debug, Eq)]
pub struct Order {
    pub slot: u64,
    pub price: u64,
    pub base_asset_amount: u64,
    pub base_asset_amount_filled: u64,
    pub quote_asset_amount_filled: u64,
    pub trigger_price: u64,
    pub auction_start_price: i64,
    pub auction_end_price: i64,
    pub max_ts: i64,
    pub oracle_price_offset: i32,
    pub order_id: u32,
    pub market_index: u16,
    pub status: OrderStatus,
    pub order_type: OrderType,
    pub market_type: MarketType,
    pub user_order_id: u8,
    pub existing_position_direction: PositionDirection,
    pub direction: PositionDirection,
    pub reduce_only: bool,
    pub post_only: bool,
    pub immediate_or_cancel: bool,
    pub trigger_condition: OrderTriggerCondition,
    pub auction_duration: u8,
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
        Ok(self.is_limit_order() && (self.post_only || self.is_auction_complete(slot)?))
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

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Eq, Debug)]
pub enum OrderStatus {
    Init,
    Open,
    Filled,
    Canceled,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum OrderType {
    Market,
    Limit,
    TriggerMarket,
    TriggerLimit,
    Oracle,
}

impl Default for OrderType {
    fn default() -> Self {
        OrderType::Limit
    }
}

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

#[account(zero_copy)]
#[derive(Eq, PartialEq, Debug)]
#[repr(C)]
pub struct UserStats {
    pub authority: Pubkey,
    pub referrer: Pubkey,
    pub fees: UserFees,

    pub next_epoch_ts: i64,

    // volume track
    pub maker_volume_30d: u64,
    pub taker_volume_30d: u64,
    pub filler_volume_30d: u64,
    pub last_maker_volume_30d_ts: i64,
    pub last_taker_volume_30d_ts: i64,
    pub last_filler_volume_30d_ts: i64,

    pub if_staked_quote_asset_amount: u64,
    pub number_of_sub_accounts: u16,
    pub number_of_sub_accounts_created: u16,
    pub is_referrer: bool,
    pub padding: [u8; 51],
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
            padding: [0; 51],
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

#[account(zero_copy)]
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
