use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::msg;

use crate::controller::position::{add_new_position, get_position_index, PositionDirection};
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::amm::calculate_rolling_sum;
use crate::math::auction::{calculate_auction_price, is_auction_complete};
use crate::math::casting::{cast_to_i128, Cast};
use crate::math::constants::{
    AMM_TO_QUOTE_PRECISION_RATIO_I128, EPOCH_DURATION, PRICE_PRECISION_I128,
    QUOTE_SPOT_MARKET_INDEX, THIRTY_DAY_I128,
};
use crate::math::position::calculate_base_asset_value_and_pnl_with_oracle_price;
use crate::math::spot_balance::{get_signed_token_amount, get_token_amount, get_token_value};
use crate::math_error;
use crate::state::market::AMM;
use crate::state::oracle::OraclePriceData;
use crate::state::spot_market::{SpotBalance, SpotBalanceType, SpotMarket};
use std::cmp::max;

#[cfg(test)]
mod tests;

#[account(zero_copy)]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(packed)]
pub struct User {
    pub authority: Pubkey,
    pub delegate: Pubkey,
    pub user_id: u8,
    pub name: [u8; 32],
    pub spot_positions: [SpotPosition; 8],
    pub next_order_id: u32,
    pub perp_positions: [PerpPosition; 8],
    pub orders: [Order; 32],
    pub next_liquidation_id: u16,
    pub being_liquidated: bool,
    pub bankrupt: bool,
    pub custom_margin_ratio: u32,
    pub last_lp_add_time: i64,
}

impl User {
    pub fn get_spot_position_index(&self, market_index: u16) -> ClearingHouseResult<usize> {
        // first spot position is always quote asset
        if market_index == 0 {
            return Ok(0);
        }

        self.spot_positions
            .iter()
            .position(|spot_position| spot_position.market_index == market_index)
            .ok_or(ErrorCode::CouldNotFindSpotPosition)
    }

    pub fn get_spot_position(&self, market_index: u16) -> Option<&SpotPosition> {
        self.get_spot_position_index(market_index)
            .ok()
            .map(|market_index| &self.spot_positions[market_index])
    }

    pub fn get_spot_position_mut(&mut self, market_index: u16) -> Option<&mut SpotPosition> {
        self.get_spot_position_index(market_index)
            .ok()
            .map(move |market_index| &mut self.spot_positions[market_index])
    }

    pub fn get_quote_spot_position_mut(&mut self) -> &mut SpotPosition {
        self.get_spot_position_mut(QUOTE_SPOT_MARKET_INDEX).unwrap()
    }

    pub fn add_spot_position(
        &mut self,
        market_index: u16,
        balance_type: SpotBalanceType,
    ) -> ClearingHouseResult<usize> {
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
    ) -> ClearingHouseResult<&mut SpotPosition> {
        self.get_spot_position_index(market_index)
            .or_else(|_| self.add_spot_position(market_index, SpotBalanceType::Deposit))
            .map(move |market_index| &mut self.spot_positions[market_index])
    }

    pub fn get_perp_position(&self, market_index: u16) -> ClearingHouseResult<&PerpPosition> {
        Ok(&self.perp_positions[get_position_index(&self.perp_positions, market_index)?])
    }

    pub fn get_perp_position_mut(
        &mut self,
        market_index: u16,
    ) -> ClearingHouseResult<&mut PerpPosition> {
        Ok(&mut self.perp_positions[get_position_index(&self.perp_positions, market_index)?])
    }

    pub fn force_get_perp_position_mut(
        &mut self,
        market_index: u16,
    ) -> ClearingHouseResult<&mut PerpPosition> {
        let position_index = get_position_index(&self.perp_positions, market_index)
            .or_else(|_| add_new_position(&mut self.perp_positions, market_index))?;
        Ok(&mut self.perp_positions[position_index])
    }

    pub fn get_order_index(&self, order_id: u32) -> ClearingHouseResult<usize> {
        self.orders
            .iter()
            .position(|order| order.order_id == order_id)
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
}

#[zero_copy]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(packed)]
pub struct UserFees {
    pub total_fee_paid: u64,
    pub total_lp_fees: u64,
    pub total_fee_rebate: u64,
    pub total_token_discount: u64,
    pub total_referee_discount: u64,
}

#[zero_copy]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(packed)]
pub struct SpotPosition {
    pub market_index: u16,
    pub balance_type: SpotBalanceType,
    pub balance: u64,
    pub open_orders: u8,
    pub open_bids: i64,
    pub open_asks: i64,
    pub cumulative_deposits: i64,
}

impl SpotBalance for SpotPosition {
    fn market_index(&self) -> u16 {
        self.market_index
    }

    fn balance_type(&self) -> &SpotBalanceType {
        &self.balance_type
    }

    fn balance(&self) -> u128 {
        self.balance as u128
    }

    fn increase_balance(&mut self, delta: u128) -> ClearingHouseResult {
        self.balance = self
            .balance
            .checked_add(delta.cast()?)
            .ok_or_else(math_error!())?;
        Ok(())
    }

    fn decrease_balance(&mut self, delta: u128) -> ClearingHouseResult {
        self.balance = self
            .balance
            .checked_sub(delta.cast()?)
            .ok_or_else(math_error!())?;
        Ok(())
    }

    fn update_balance_type(&mut self, balance_type: SpotBalanceType) -> ClearingHouseResult {
        self.balance_type = balance_type;
        Ok(())
    }
}

impl SpotPosition {
    pub fn is_available(&self) -> bool {
        self.balance == 0 && self.open_orders == 0
    }

    pub fn get_token_amount(&self, spot_market: &SpotMarket) -> ClearingHouseResult<u128> {
        get_token_amount(self.balance.cast()?, spot_market, &self.balance_type)
    }

    pub fn get_signed_token_amount(&self, spot_market: &SpotMarket) -> ClearingHouseResult<i128> {
        get_signed_token_amount(
            get_token_amount(self.balance.cast()?, spot_market, &self.balance_type)?,
            &self.balance_type,
        )
    }

    pub fn get_worst_case_token_amounts(
        &self,
        spot_market: &SpotMarket,
        oracle_price_data: &OraclePriceData,
        token_amount: Option<i128>,
    ) -> ClearingHouseResult<(i128, i128)> {
        let token_amount = match token_amount {
            Some(token_amount) => token_amount,
            None => self.get_signed_token_amount(spot_market)?,
        };

        let token_amount_all_bids_fill = token_amount
            .checked_add(self.open_bids as i128)
            .ok_or_else(math_error!())?;

        let token_amount_all_asks_fill = token_amount
            .checked_add(self.open_asks as i128)
            .ok_or_else(math_error!())?;

        if token_amount_all_bids_fill.abs() > token_amount_all_asks_fill.abs() {
            let worst_case_quote_token_amount = get_token_value(
                -self.open_bids as i128,
                spot_market.decimals,
                oracle_price_data,
            )?;
            Ok((token_amount_all_bids_fill, worst_case_quote_token_amount))
        } else {
            let worst_case_quote_token_amount = get_token_value(
                -self.open_asks as i128,
                spot_market.decimals,
                oracle_price_data,
            )?;
            Ok((token_amount_all_asks_fill, worst_case_quote_token_amount))
        }
    }
}

#[zero_copy]
#[derive(Default, Debug, Eq, PartialEq)]
#[repr(packed)]
pub struct PerpPosition {
    pub market_index: u16,
    pub base_asset_amount: i64,
    pub quote_asset_amount: i64,
    pub quote_entry_amount: i64,
    pub last_cumulative_funding_rate: i128,
    pub open_orders: u8,
    pub open_bids: i64,
    pub open_asks: i64,
    pub settled_pnl: i64,

    // lp stuff
    pub lp_shares: u64,
    pub remainder_base_asset_amount: i32,
    pub last_net_base_asset_amount_per_lp: i64,
    pub last_net_quote_asset_amount_per_lp: i64,
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

    pub fn is_lp(&self) -> bool {
        self.lp_shares > 0
    }

    pub fn has_unsettled_pnl(&self) -> bool {
        self.base_asset_amount == 0 && self.quote_asset_amount != 0
    }

    pub fn worst_case_base_asset_amount(&self) -> ClearingHouseResult<i128> {
        let base_asset_amount_all_bids_fill = self
            .base_asset_amount
            .checked_add(self.open_bids)
            .ok_or_else(math_error!())?;
        let base_asset_amount_all_asks_fill = self
            .base_asset_amount
            .checked_add(self.open_asks)
            .ok_or_else(math_error!())?;

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

    pub fn get_entry_price(&self) -> ClearingHouseResult<i128> {
        if self.base_asset_amount == 0 {
            return Ok(0);
        }

        (-self.quote_entry_amount.cast::<i128>()?)
            .checked_mul(PRICE_PRECISION_I128)
            .ok_or_else(math_error!())?
            .checked_mul(AMM_TO_QUOTE_PRECISION_RATIO_I128)
            .ok_or_else(math_error!())?
            .checked_div(self.base_asset_amount.cast()?)
            .ok_or_else(math_error!())
    }

    pub fn get_cost_basis(&self) -> ClearingHouseResult<i128> {
        if self.base_asset_amount == 0 {
            return Ok(0);
        }

        (-self.quote_asset_amount.cast::<i128>()?)
            .checked_mul(PRICE_PRECISION_I128)
            .ok_or_else(math_error!())?
            .checked_mul(AMM_TO_QUOTE_PRECISION_RATIO_I128)
            .ok_or_else(math_error!())?
            .checked_div(self.base_asset_amount.cast()?)
            .ok_or_else(math_error!())
    }

    pub fn get_unrealized_pnl(&self, oracle_price: i128) -> ClearingHouseResult<i128> {
        let (_, unrealized_pnl) =
            calculate_base_asset_value_and_pnl_with_oracle_price(self, oracle_price)?;

        Ok(unrealized_pnl)
    }

    pub fn get_claimable_pnl(
        &self,
        oracle_price: i128,
        pnl_pool_excess: i128,
    ) -> ClearingHouseResult<i128> {
        let (_, unrealized_pnl) =
            calculate_base_asset_value_and_pnl_with_oracle_price(self, oracle_price)?;

        if unrealized_pnl > 0 {
            // this limits the amount of positive pnl that can be settled to be the amount of positive pnl
            // realized by reducing/closing position
            let max_positive_pnl = self
                .quote_asset_amount
                .cast::<i128>()?
                .checked_sub(self.quote_entry_amount.cast()?)
                .map(|delta| delta.max(0))
                .ok_or_else(math_error!())?
                .checked_add(pnl_pool_excess.max(0))
                .ok_or_else(math_error!())?;

            Ok(unrealized_pnl.min(max_positive_pnl))
        } else {
            Ok(unrealized_pnl)
        }
    }
}

pub type PerpPositions = [PerpPosition; 8];

#[zero_copy]
#[repr(packed)]
#[derive(AnchorSerialize, AnchorDeserialize, PartialEq, Debug, Eq)]
pub struct Order {
    pub status: OrderStatus,
    pub order_type: OrderType,
    pub market_type: MarketType,
    pub ts: i64,
    pub slot: u64,
    pub order_id: u32,
    pub user_order_id: u8,
    pub market_index: u16,
    pub price: u64,
    pub existing_position_direction: PositionDirection,
    pub base_asset_amount: u64,
    pub base_asset_amount_filled: u64,
    pub quote_asset_amount_filled: u64,
    pub fee: i64,
    pub direction: PositionDirection,
    pub reduce_only: bool,
    pub post_only: bool,
    pub immediate_or_cancel: bool,
    pub trigger_price: u64,
    pub trigger_condition: OrderTriggerCondition,
    pub triggered: bool,
    pub oracle_price_offset: i64,
    pub auction_start_price: u64,
    pub auction_end_price: u64,
    pub auction_duration: u8,
    pub time_in_force: u8,
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
        valid_oracle_price: Option<i128>,
        slot: u64,
        amm: Option<&AMM>,
    ) -> ClearingHouseResult<u128> {
        // the limit price can be hardcoded on order or derived from oracle_price + oracle_price_offset
        let price = if self.has_oracle_price_offset() {
            if let Some(oracle_price) = valid_oracle_price {
                let limit_price = oracle_price
                    .checked_add(self.oracle_price_offset as i128)
                    .ok_or_else(math_error!())?;

                if limit_price <= 0 {
                    msg!("Oracle offset limit price below zero: {}", limit_price);
                    return Err(crate::error::ErrorCode::InvalidOracleOffset);
                }

                limit_price.unsigned_abs()
            } else {
                msg!("Could not find oracle too calculate oracle offset limit price");
                return Err(crate::error::ErrorCode::OracleNotFound);
            }
        } else if matches!(
            self.order_type,
            OrderType::Market | OrderType::TriggerMarket
        ) {
            if !is_auction_complete(self.slot, self.auction_duration, slot)? {
                calculate_auction_price(self, slot)? as u128
            } else if self.price != 0 {
                self.price as u128
            } else {
                match amm {
                    Some(amm) => match self.direction {
                        PositionDirection::Long => {
                            let ask_price = amm.ask_price(amm.reserve_price()?)?;
                            let delta = ask_price
                                .checked_div(amm.max_slippage_ratio as u128)
                                .ok_or_else(math_error!())?;
                            ask_price.checked_add(delta).ok_or_else(math_error!())?
                        }
                        PositionDirection::Short => {
                            let bid_price = amm.bid_price(amm.reserve_price()?)?;
                            let delta = bid_price
                                .checked_div(amm.max_slippage_ratio as u128)
                                .ok_or_else(math_error!())?;
                            bid_price.checked_sub(delta).ok_or_else(math_error!())?
                        }
                    },
                    None => {
                        let oracle_price = valid_oracle_price
                            .ok_or_else(|| {
                                msg!("No oracle found to generate dynamic limit price");
                                ErrorCode::OracleNotFound
                            })?
                            .unsigned_abs();

                        let oracle_price_1pct = oracle_price / 100;

                        match self.direction {
                            PositionDirection::Long => oracle_price
                                .checked_add(oracle_price_1pct)
                                .ok_or_else(math_error!())?,
                            PositionDirection::Short => oracle_price
                                .checked_sub(oracle_price_1pct)
                                .ok_or_else(math_error!())?,
                        }
                    }
                }
            }
        } else {
            self.price as u128
        };

        Ok(price)
    }

    pub fn get_base_asset_amount_unfilled(&self) -> ClearingHouseResult<u64> {
        self.base_asset_amount
            .checked_sub(self.base_asset_amount_filled)
            .ok_or_else(math_error!())
    }

    pub fn must_be_triggered(&self) -> bool {
        matches!(
            self.order_type,
            OrderType::TriggerMarket | OrderType::TriggerLimit
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
}

impl Default for Order {
    fn default() -> Self {
        Self {
            status: OrderStatus::Init,
            order_type: OrderType::Limit,
            market_type: MarketType::Perp,
            ts: 0,
            slot: 0,
            order_id: 0,
            user_order_id: 0,
            market_index: 0,
            price: 0,
            existing_position_direction: PositionDirection::Long,
            base_asset_amount: 0,
            base_asset_amount_filled: 0,
            quote_asset_amount_filled: 0,
            fee: 0,
            direction: PositionDirection::Long,
            reduce_only: false,
            post_only: false,
            immediate_or_cancel: false,
            trigger_price: 0,
            trigger_condition: OrderTriggerCondition::Above,
            triggered: false,
            oracle_price_offset: 0,
            auction_start_price: 0,
            auction_end_price: 0,
            auction_duration: 0,
            time_in_force: 0,
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
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum OrderTriggerCondition {
    Above,
    Below,
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
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(packed)]
pub struct UserStats {
    pub authority: Pubkey,
    pub number_of_users: u8,

    pub is_referrer: bool,
    pub referrer: Pubkey,
    pub total_referrer_reward: u64,
    pub current_epoch_referrer_reward: u64,
    pub next_epoch_ts: i64,

    pub fees: UserFees,

    // volume track
    pub maker_volume_30d: u64,
    pub taker_volume_30d: u64,
    pub filler_volume_30d: u64,
    pub last_maker_volume_30d_ts: i64,
    pub last_taker_volume_30d_ts: i64,
    pub last_filler_volume_30d_ts: i64,

    pub staked_quote_asset_amount: u64,
}

impl UserStats {
    pub fn update_maker_volume_30d(
        &mut self,
        quote_asset_amount: u64,
        now: i64,
    ) -> ClearingHouseResult {
        let since_last = cast_to_i128(max(
            1,
            now.checked_sub(self.last_maker_volume_30d_ts)
                .ok_or_else(math_error!())?,
        ))?;

        self.maker_volume_30d = calculate_rolling_sum(
            self.maker_volume_30d,
            quote_asset_amount,
            since_last,
            THIRTY_DAY_I128,
        )?;
        self.last_maker_volume_30d_ts = now;

        Ok(())
    }

    pub fn update_taker_volume_30d(
        &mut self,
        quote_asset_amount: u64,
        now: i64,
    ) -> ClearingHouseResult {
        let since_last = cast_to_i128(max(
            1,
            now.checked_sub(self.last_taker_volume_30d_ts)
                .ok_or_else(math_error!())?,
        ))?;

        self.taker_volume_30d = calculate_rolling_sum(
            self.taker_volume_30d,
            quote_asset_amount,
            since_last,
            THIRTY_DAY_I128,
        )?;
        self.last_taker_volume_30d_ts = now;

        Ok(())
    }

    pub fn update_filler_volume(
        &mut self,
        quote_asset_amount: u64,
        now: i64,
    ) -> ClearingHouseResult {
        let since_last = cast_to_i128(max(
            1,
            now.checked_sub(self.last_filler_volume_30d_ts)
                .ok_or_else(math_error!())?,
        ))?;

        self.filler_volume_30d = calculate_rolling_sum(
            self.filler_volume_30d,
            quote_asset_amount,
            since_last,
            THIRTY_DAY_I128,
        )?;

        self.last_filler_volume_30d_ts = now;

        Ok(())
    }

    pub fn increment_total_fees(&mut self, fee: u64) -> ClearingHouseResult {
        self.fees.total_fee_paid = self
            .fees
            .total_fee_paid
            .checked_add(fee)
            .ok_or_else(math_error!())?;

        Ok(())
    }

    pub fn increment_total_rebate(&mut self, fee: u64) -> ClearingHouseResult {
        self.fees.total_fee_rebate = self
            .fees
            .total_fee_rebate
            .checked_add(fee)
            .ok_or_else(math_error!())?;

        Ok(())
    }

    pub fn increment_total_referrer_reward(
        &mut self,
        reward: u64,
        now: i64,
    ) -> ClearingHouseResult {
        self.total_referrer_reward = self
            .total_referrer_reward
            .checked_add(reward)
            .ok_or_else(math_error!())?;

        self.current_epoch_referrer_reward = self
            .current_epoch_referrer_reward
            .checked_add(reward)
            .ok_or_else(math_error!())?;

        if now > self.next_epoch_ts {
            let n_epoch_durations = now
                .checked_sub(self.next_epoch_ts)
                .ok_or_else(math_error!())?
                .checked_div(EPOCH_DURATION)
                .ok_or_else(math_error!())?
                .checked_add(1)
                .ok_or_else(math_error!())?;

            self.next_epoch_ts = self
                .next_epoch_ts
                .checked_add(
                    EPOCH_DURATION
                        .checked_mul(n_epoch_durations)
                        .ok_or_else(math_error!())?,
                )
                .ok_or_else(math_error!())?;

            self.current_epoch_referrer_reward = 0;
        }

        Ok(())
    }

    pub fn increment_total_referee_discount(&mut self, discount: u64) -> ClearingHouseResult {
        self.fees.total_referee_discount = self
            .fees
            .total_referee_discount
            .checked_add(discount)
            .ok_or_else(math_error!())?;

        Ok(())
    }

    pub fn has_referrer(&self) -> bool {
        !self.referrer.eq(&Pubkey::default())
    }

    pub fn get_total_30d_volume(&self) -> ClearingHouseResult<u64> {
        self.taker_volume_30d
            .checked_add(self.maker_volume_30d)
            .ok_or_else(math_error!())
    }
}

#[cfg(test)]
mod test {
    use crate::state::user::{Order, PerpPosition, SpotPosition, User};

    #[test]
    fn test() {
        let user_size = std::mem::size_of::<User>();
        println!("user_size {}", user_size);

        let perp_position_size = std::mem::size_of::<PerpPosition>();
        println!("perp_position_size {}", perp_position_size);

        let spot_position_size = std::mem::size_of::<SpotPosition>();
        println!("spot_position_size {}", spot_position_size);

        let order_size = std::mem::size_of::<Order>();
        println!("order_size {}", order_size);
    }
}
