use crate::controller::position::{add_new_position, get_position_index, PositionDirection};
use crate::error::{ErrorCode, VelocityResult};
use crate::math::auction::{calculate_auction_price, is_auction_complete};
use crate::math::casting::Cast;
use crate::math::constants::{
    OPEN_ORDER_MARGIN_REQUIREMENT, QUOTE_SPOT_MARKET_INDEX, SPOT_WEIGHT_PRECISION,
    SPOT_WEIGHT_PRECISION_I128, THIRTY_DAY,
};
use crate::math::margin::MarginRequirementType;
use crate::math::orders::{standardize_base_asset_amount, standardize_price};
use crate::math::position::{
    calculate_base_asset_value_and_pnl_with_oracle_price, calculate_perp_liability_value,
};
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::{
    get_signed_token_amount, get_strict_token_value, get_token_amount, get_token_value,
};
use crate::math::stats::calculate_rolling_sum;
use crate::math_error;
use crate::msg;
use crate::safe_increment;
use crate::state::oracle::StrictOraclePrice;
use crate::state::spot_market::{SpotBalance, SpotBalanceType, SpotMarket};
use crate::state::traits::Size;
use crate::validate;
use crate::{get_then_update_id, ID};
use anchor_lang::prelude::borsh::{BorshDeserialize, BorshSerialize};
use anchor_lang::prelude::*;
use bytemuck::{Pod, Zeroable};
use std::cmp::max;
use std::fmt;
use std::ops::Neg;
use std::panic::Location;

use crate::math::margin::{
    calculate_margin_requirement_and_total_collateral_and_liability_info,
    validate_any_isolated_tier_requirements,
};
use crate::state::margin_calculation::{MarginContext, MarginTypeConfig};
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_market_map::SpotMarketMap;

#[cfg(test)]
mod isolated_transfer_tests;
#[cfg(test)]
mod tests;

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
#[borsh(use_discriminant = true)]
pub enum UserStatus {
    // Active = 0
    BeingLiquidated = 0b00000001,
    Bankrupt = 0b00000010,
    ReduceOnly = 0b00000100,
    AdvancedLp = 0b00001000,
    // 0b00010000 reserved (was ProtectedMakerOrders)
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
#[borsh(use_discriminant = true)]
pub enum SpecialUserStatus {
    // None = 0
    VammHedger = 0b00000001,
}

// implement SIZE const for User
impl Size for User {
    const SIZE: usize = 4496;
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
    pub pool_id: u8,
    /// Whether the user is a special user (vamm hedger, etc)
    pub special_user_status: u8,
    pub padding: [u8; 14],
}

impl User {
    pub fn is_being_liquidated(&self) -> bool {
        self.is_cross_margin_being_liquidated() || self.has_isolated_margin_being_liquidated()
    }

    pub fn is_cross_margin_being_liquidated(&self) -> bool {
        self.status & (UserStatus::BeingLiquidated as u8 | UserStatus::Bankrupt as u8) > 0
    }

    pub fn is_bankrupt(&self) -> bool {
        self.is_cross_margin_bankrupt() || self.has_isolated_margin_bankrupt()
    }

    pub fn is_cross_margin_bankrupt(&self) -> bool {
        self.status & (UserStatus::Bankrupt as u8) > 0
    }

    pub fn is_reduce_only(&self) -> bool {
        self.status & (UserStatus::ReduceOnly as u8) > 0
    }

    pub fn is_advanced_lp(&self) -> bool {
        self.status & (UserStatus::AdvancedLp as u8) > 0
    }

    pub fn add_user_status(&mut self, status: UserStatus) {
        self.status |= status as u8;
    }

    pub fn remove_user_status(&mut self, status: UserStatus) {
        self.status &= !(status as u8);
    }

    pub fn get_spot_position_index(&self, market_index: u16) -> VelocityResult<usize> {
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

    pub fn get_spot_position(&self, market_index: u16) -> VelocityResult<&SpotPosition> {
        self.get_spot_position_index(market_index)
            .map(|market_index| &self.spot_positions[market_index])
    }

    pub fn get_spot_position_mut(
        &mut self,
        market_index: u16,
    ) -> VelocityResult<&mut SpotPosition> {
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
    ) -> VelocityResult<usize> {
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
    ) -> VelocityResult<&mut SpotPosition> {
        self.get_spot_position_index(market_index)
            .or_else(|_| self.add_spot_position(market_index, SpotBalanceType::Deposit))
            .map(move |market_index| &mut self.spot_positions[market_index])
    }

    pub fn force_get_spot_position_index(&mut self, market_index: u16) -> VelocityResult<usize> {
        self.get_spot_position_index(market_index)
            .or_else(|_| self.add_spot_position(market_index, SpotBalanceType::Deposit))
    }

    pub fn get_perp_position(&self, market_index: u16) -> VelocityResult<&PerpPosition> {
        Ok(&self.perp_positions[get_position_index(&self.perp_positions, market_index)?])
    }

    pub fn get_perp_position_mut(
        &mut self,
        market_index: u16,
    ) -> VelocityResult<&mut PerpPosition> {
        Ok(&mut self.perp_positions[get_position_index(&self.perp_positions, market_index)?])
    }

    pub fn force_get_perp_position_mut(
        &mut self,
        market_index: u16,
    ) -> VelocityResult<&mut PerpPosition> {
        let position_index = get_position_index(&self.perp_positions, market_index)
            .or_else(|_| add_new_position(&mut self.perp_positions, market_index))?;
        Ok(&mut self.perp_positions[position_index])
    }

    pub fn force_get_isolated_perp_position_mut(
        &mut self,
        perp_market_index: u16,
    ) -> VelocityResult<&mut PerpPosition> {
        if let Ok(position_index) = get_position_index(&self.perp_positions, perp_market_index) {
            let perp_position = &mut self.perp_positions[position_index];
            validate!(
                perp_position.is_isolated(),
                ErrorCode::InvalidPerpPosition,
                "perp position is not isolated"
            )?;

            Ok(&mut self.perp_positions[position_index])
        } else {
            let position_index = add_new_position(&mut self.perp_positions, perp_market_index)?;

            let perp_position = &mut self.perp_positions[position_index];
            perp_position.position_flag = PositionFlag::IsolatedPosition as u8;

            Ok(&mut self.perp_positions[position_index])
        }
    }

    pub fn get_isolated_perp_position(
        &self,
        perp_market_index: u16,
    ) -> VelocityResult<&PerpPosition> {
        let position_index = get_position_index(&self.perp_positions, perp_market_index)?;
        validate!(
            self.perp_positions[position_index].is_isolated(),
            ErrorCode::InvalidPerpPosition,
            "perp position is not isolated"
        )?;

        Ok(&self.perp_positions[position_index])
    }

    pub fn get_order_index(&self, order_id: u32) -> VelocityResult<usize> {
        self.orders
            .iter()
            .position(|order| order.order_id == order_id && order.status == OrderStatus::Open)
            .ok_or(ErrorCode::OrderDoesNotExist)
    }

    pub fn get_order_index_by_user_order_id(&self, user_order_id: u8) -> VelocityResult<usize> {
        self.orders
            .iter()
            .position(|order| {
                order.user_order_id == user_order_id && order.status == OrderStatus::Open
            })
            .ok_or(ErrorCode::OrderDoesNotExist)
    }

    pub fn get_order(&self, order_id: u32) -> Option<&Order> {
        self.orders
            .iter()
            .find(|order| order.order_id == order_id && order.status == OrderStatus::Open)
    }

    pub fn get_last_order_id(&self) -> u32 {
        if self.next_order_id == 1 {
            u32::MAX
        } else {
            self.next_order_id - 1
        }
    }

    pub fn get_total_token_amount(&self, spot_market: &SpotMarket) -> VelocityResult<i128> {
        let spot_token_amount = {
            if let Ok(spot_position) = self.get_spot_position(spot_market.market_index) {
                spot_position.get_signed_token_amount(spot_market)?
            } else {
                0_i128
            }
        };

        if spot_market.market_index != QUOTE_SPOT_MARKET_INDEX {
            return Ok(spot_token_amount);
        }

        let mut perp_token_amount = 0;
        for perp_position in self.perp_positions.iter() {
            if perp_position.is_isolated() {
                perp_token_amount = perp_token_amount
                    .safe_add(perp_position.get_isolated_token_amount(spot_market)?)?;
            }
        }

        spot_token_amount.safe_add(perp_token_amount.cast::<i128>()?)
    }

    pub fn increment_total_deposits(
        &mut self,
        amount: u64,
        price: i64,
        precision: u128,
    ) -> VelocityResult {
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
    ) -> VelocityResult {
        let value = amount
            .cast::<u128>()?
            .safe_mul(price.cast()?)?
            .safe_div(precision)?
            .cast::<u64>()?;
        self.total_withdraws = self.total_withdraws.saturating_add(value);

        Ok(())
    }

    pub fn increment_total_socialized_loss(&mut self, value: u64) -> VelocityResult {
        self.total_social_loss = self.total_social_loss.saturating_add(value);

        Ok(())
    }

    pub fn update_cumulative_spot_fees(&mut self, amount: i64) -> VelocityResult {
        safe_increment!(self.cumulative_spot_fees, amount);
        Ok(())
    }

    pub fn update_cumulative_perp_funding(&mut self, amount: i64) -> VelocityResult {
        safe_increment!(self.cumulative_perp_funding, amount);
        Ok(())
    }

    pub fn enter_cross_margin_liquidation(&mut self, slot: u64) -> VelocityResult<u16> {
        if self.is_cross_margin_being_liquidated() {
            return self.next_liquidation_id.safe_sub(1);
        }

        self.add_user_status(UserStatus::BeingLiquidated);
        self.liquidation_margin_freed = 0;

        let liquidation_id = if self.has_isolated_margin_being_liquidated() {
            self.next_liquidation_id.safe_sub(1)?
        } else {
            self.last_active_slot = slot;
            get_then_update_id!(self, next_liquidation_id)
        };

        Ok(liquidation_id)
    }

    pub fn exit_cross_margin_liquidation(&mut self) {
        self.remove_user_status(UserStatus::BeingLiquidated);
        self.remove_user_status(UserStatus::Bankrupt);
        self.liquidation_margin_freed = 0;
    }

    pub fn enter_cross_margin_bankruptcy(&mut self) {
        // Economic bankruptcy can be entered directly, without a prior
        // liquidation episode. Allocate a liquidation id in that case so the
        // resolver's `next_liquidation_id - 1` references this event instead of
        // underflowing (fresh user) or reusing a stale id. When an episode is
        // already active, `enter_*_liquidation` allocated the id; reuse it.
        if !self.is_being_liquidated() {
            get_then_update_id!(self, next_liquidation_id);
        }
        self.remove_user_status(UserStatus::BeingLiquidated);
        self.add_user_status(UserStatus::Bankrupt);
    }

    pub fn exit_cross_margin_bankruptcy(&mut self) {
        self.remove_user_status(UserStatus::BeingLiquidated);
        self.remove_user_status(UserStatus::Bankrupt);
        self.liquidation_margin_freed = 0;
    }

    pub fn has_isolated_margin_being_liquidated(&self) -> bool {
        self.perp_positions
            .iter()
            .any(|position| position.is_isolated() && position.is_being_liquidated())
    }

    pub fn enter_isolated_margin_liquidation(
        &mut self,
        perp_market_index: u16,
        slot: u64,
    ) -> VelocityResult<u16> {
        if self.is_isolated_margin_being_liquidated(perp_market_index)? {
            return self.next_liquidation_id.safe_sub(1);
        }

        let liquidation_id = if self.is_cross_margin_being_liquidated()
            || self.has_isolated_margin_being_liquidated()
        {
            self.next_liquidation_id.safe_sub(1)?
        } else {
            self.last_active_slot = slot;
            get_then_update_id!(self, next_liquidation_id)
        };

        let perp_position = self.force_get_isolated_perp_position_mut(perp_market_index)?;

        perp_position.position_flag |= PositionFlag::BeingLiquidated as u8;

        Ok(liquidation_id)
    }

    pub fn exit_isolated_margin_liquidation(&mut self, perp_market_index: u16) -> VelocityResult {
        let perp_position = self.force_get_isolated_perp_position_mut(perp_market_index)?;
        perp_position.position_flag &= !(PositionFlag::BeingLiquidated as u8);
        perp_position.position_flag &= !(PositionFlag::Bankrupt as u8);
        Ok(())
    }

    pub fn is_isolated_margin_being_liquidated(
        &self,
        perp_market_index: u16,
    ) -> VelocityResult<bool> {
        if let Ok(perp_position) = self.get_isolated_perp_position(perp_market_index) {
            Ok(perp_position.is_being_liquidated())
        } else {
            Ok(false)
        }
    }

    pub fn has_isolated_margin_bankrupt(&self) -> bool {
        self.perp_positions
            .iter()
            .any(|position| position.is_isolated() && position.is_bankrupt())
    }

    pub fn enter_isolated_margin_bankruptcy(&mut self, perp_market_index: u16) -> VelocityResult {
        // Allocate a liquidation id when no episode is active (direct economic
        // bankruptcy) so the resolver's `next_liquidation_id - 1` is valid;
        // otherwise reuse the active episode's id. Mirrors
        // `enter_isolated_margin_liquidation`.
        if !self.is_being_liquidated() {
            get_then_update_id!(self, next_liquidation_id);
        }
        let perp_position = self.force_get_isolated_perp_position_mut(perp_market_index)?;
        perp_position.position_flag &= !(PositionFlag::BeingLiquidated as u8);
        perp_position.position_flag |= PositionFlag::Bankrupt as u8;
        Ok(())
    }

    pub fn exit_isolated_margin_bankruptcy(&mut self, perp_market_index: u16) -> VelocityResult {
        let perp_position = self.force_get_isolated_perp_position_mut(perp_market_index)?;
        perp_position.position_flag &= !(PositionFlag::BeingLiquidated as u8);
        perp_position.position_flag &= !(PositionFlag::Bankrupt as u8);
        Ok(())
    }

    pub fn is_isolated_margin_bankrupt(&self, perp_market_index: u16) -> VelocityResult<bool> {
        let perp_position = self.get_isolated_perp_position(perp_market_index)?;
        Ok(perp_position.position_flag & (PositionFlag::Bankrupt as u8) != 0)
    }

    pub fn increment_margin_freed(&mut self, margin_free: u64) -> VelocityResult {
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
            self.increment_open_auctions();
        }
    }

    pub fn increment_open_auctions(&mut self) {
        self.open_auctions = self.open_auctions.saturating_add(1);
        self.has_open_auction = self.open_auctions > 0;
    }

    pub fn decrement_open_orders(&mut self, is_auction: bool) {
        self.open_orders = self.open_orders.saturating_sub(1);
        self.has_open_order = self.open_orders > 0;
        if is_auction {
            self.open_auctions = self.open_auctions.saturating_sub(1);
            self.has_open_auction = self.open_auctions > 0;
        }
    }

    pub fn update_reduce_only_status(&mut self, reduce_only: bool) -> VelocityResult {
        if reduce_only {
            self.add_user_status(UserStatus::ReduceOnly);
        } else {
            self.remove_user_status(UserStatus::ReduceOnly);
        }

        Ok(())
    }

    pub fn update_advanced_lp_status(&mut self, advanced_lp: bool) -> VelocityResult {
        if advanced_lp {
            self.add_user_status(UserStatus::AdvancedLp);
        } else {
            self.remove_user_status(UserStatus::AdvancedLp);
        }

        Ok(())
    }

    pub fn has_room_for_new_order(&self) -> bool {
        for order in self.orders.iter() {
            if order.is_available() {
                return true;
            }
        }

        false
    }

    pub fn meets_withdraw_margin_requirement_swap(
        &mut self,
        perp_market_map: &PerpMarketMap,
        spot_market_map: &SpotMarketMap,
        oracle_map: &mut OracleMap,
        margin_requirement_type: MarginRequirementType,
    ) -> VelocityResult<bool> {
        let strict = margin_requirement_type == MarginRequirementType::Initial;
        let context = MarginContext::standard(margin_requirement_type)
            .strict(strict)
            .ignore_invalid_deposit_oracles(true);

        let calculation = calculate_margin_requirement_and_total_collateral_and_liability_info(
            self,
            perp_market_map,
            spot_market_map,
            oracle_map,
            context,
        )?;

        if calculation.margin_requirement > 0 || calculation.get_num_of_liabilities()? > 0 {
            validate!(
                calculation.all_liability_oracles_valid,
                ErrorCode::InvalidOracle,
                "User attempting to withdraw with outstanding liabilities when an oracle is invalid"
            )?;
        }

        validate_any_isolated_tier_requirements(self, &calculation)?;

        validate!(
            calculation.meets_margin_requirement(),
            ErrorCode::InsufficientCollateral,
            "margin calculation: {:?}",
            calculation
        )?;

        Ok(true)
    }

    pub fn meets_withdraw_margin_requirement(
        &mut self,
        perp_market_map: &PerpMarketMap,
        spot_market_map: &SpotMarketMap,
        oracle_map: &mut OracleMap,
        margin_requirement_type: MarginRequirementType,
    ) -> VelocityResult<bool> {
        let strict = margin_requirement_type == MarginRequirementType::Initial;
        let context = MarginContext::standard(margin_requirement_type)
            .strict(strict)
            .ignore_invalid_deposit_oracles(true);

        let calculation = calculate_margin_requirement_and_total_collateral_and_liability_info(
            self,
            perp_market_map,
            spot_market_map,
            oracle_map,
            context,
        )?;

        if calculation.margin_requirement > 0 || calculation.get_num_of_liabilities()? > 0 {
            validate!(
                calculation.all_liability_oracles_valid,
                ErrorCode::InvalidOracle,
                "User attempting to withdraw with outstanding liabilities when an oracle is invalid"
            )?;
        }

        validate_any_isolated_tier_requirements(self, &calculation)?;

        validate!(
            calculation.meets_margin_requirement(),
            ErrorCode::InsufficientCollateral,
            "margin calculation: {:?}",
            calculation
        )?;

        Ok(true)
    }

    pub fn meets_transfer_isolated_position_deposit_margin_requirement(
        &mut self,
        perp_market_map: &PerpMarketMap,
        spot_market_map: &SpotMarketMap,
        oracle_map: &mut OracleMap,
        margin_type_config: MarginTypeConfig,
        to_isolated_position: bool,
        isolated_market_index: u16,
    ) -> VelocityResult<bool> {
        let strict = if !to_isolated_position {
            margin_type_config.get_isolated_margin_requirement_type(isolated_market_index)
                == MarginRequirementType::Initial
        } else {
            margin_type_config.get_cross_margin_requirement_type() == MarginRequirementType::Initial
        };
        let context = MarginContext::standard_with_config(margin_type_config)
            .strict(strict)
            .ignore_invalid_deposit_oracles(true);

        let calculation = calculate_margin_requirement_and_total_collateral_and_liability_info(
            self,
            perp_market_map,
            spot_market_map,
            oracle_map,
            context,
        )?;

        if calculation.margin_requirement > 0 || calculation.get_num_of_liabilities()? > 0 {
            validate!(
                calculation.all_liability_oracles_valid,
                ErrorCode::InvalidOracle,
                "User attempting to withdraw with outstanding liabilities when an oracle is invalid"
            )?;
        }

        validate_any_isolated_tier_requirements(self, &calculation)?;

        validate!(
            calculation.meets_margin_requirement(),
            ErrorCode::InsufficientCollateral,
            "margin calculation: {:?}",
            calculation
        )?;

        Ok(true)
    }

    pub fn can_skip_auction_duration(
        &self,
        user_stats: &UserStats,
        reduce_only_order: bool,
    ) -> VelocityResult<bool> {
        let atomic_fill_paused = UserStatsPausedOperations::is_operation_paused(
            user_stats.paused_operations,
            UserStatsPausedOperations::AmmAtomicFill,
        );
        let atomic_risk_increasing_fill_paused = UserStatsPausedOperations::is_operation_paused(
            user_stats.paused_operations,
            UserStatsPausedOperations::AmmAtomicRiskIncreasingFill,
        );

        if atomic_fill_paused || (atomic_risk_increasing_fill_paused && !reduce_only_order) {
            return Ok(false);
        }

        Ok(true)
    }

    pub fn update_perp_position_max_margin_ratio(
        &mut self,
        market_index: u16,
        margin_ratio: u16,
    ) -> VelocityResult<()> {
        let perp_position = self.force_get_perp_position_mut(market_index)?;
        msg!(
            "perp_position.max_margin_ratio ({}) -> {}",
            perp_position.max_margin_ratio,
            margin_ratio
        );
        perp_position.max_margin_ratio = margin_ratio;

        Ok(())
    }
}

pub fn derive_user_account(authority: &Pubkey, sub_account_id: u16) -> Pubkey {
    let (account_velocity_pda, _seed) = Pubkey::find_program_address(
        &[
            &b"user"[..],
            authority.as_ref(),
            &sub_account_id.to_le_bytes(),
        ],
        &ID,
    );
    account_velocity_pda
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
}

#[zero_copy(unsafe)]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct SpotPosition {
    /// The scaled balance of the position. To get the token amount, multiply by the cumulative deposit/borrow
    /// interest of corresponding market.
    /// precision: SPOT_BALANCE_PRECISION
    pub scaled_balance: u64,
    /// How many spot non reduce only trigger orders the user has open
    /// precision: token mint precision
    pub open_bids: i64,
    /// How many spot non reduce only trigger orders the user has open
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

    fn increase_balance(&mut self, delta: u128) -> VelocityResult {
        self.scaled_balance = self.scaled_balance.safe_add(delta.cast()?)?;
        Ok(())
    }

    fn decrease_balance(&mut self, delta: u128) -> VelocityResult {
        self.scaled_balance = self.scaled_balance.safe_sub(delta.cast()?)?;
        Ok(())
    }

    fn update_balance_type(&mut self, balance_type: SpotBalanceType) -> VelocityResult {
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
    ) -> VelocityResult<Self> {
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

    pub fn margin_requirement_for_open_orders(&self) -> VelocityResult<u128> {
        self.open_orders
            .cast::<u128>()?
            .safe_mul(OPEN_ORDER_MARGIN_REQUIREMENT)
    }

    pub fn get_token_amount(&self, spot_market: &SpotMarket) -> VelocityResult<u128> {
        get_token_amount(self.scaled_balance.cast()?, spot_market, &self.balance_type)
    }

    pub fn get_signed_token_amount(&self, spot_market: &SpotMarket) -> VelocityResult<i128> {
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
    ) -> VelocityResult<OrderFillSimulation> {
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
    ) -> VelocityResult<[OrderFillSimulation; 2]> {
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
                -open_orders,
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

    pub fn is_borrow(&self) -> bool {
        self.scaled_balance > 0 && self.balance_type == SpotBalanceType::Borrow
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
    /// The amount of non reduce only trigger orders the user has open
    /// precision: BASE_PRECISION
    pub open_bids: i64,
    /// The amount of non reduce only trigger orders the user has open
    /// precision: BASE_PRECISION
    pub open_asks: i64,
    /// The amount of pnl settled in this market since opening the position
    /// precision: QUOTE_PRECISION
    pub settled_pnl: i64,
    /// The scaled balance of the isolated position
    /// precision: SPOT_BALANCE_PRECISION
    pub isolated_position_scaled_balance: u64,
    pub padding: [u8; 2],
    // custom max margin ratio for perp market
    pub max_margin_ratio: u16,
    /// The market index for the perp market
    pub market_index: u16,
    /// The number of open orders
    pub open_orders: u8,
    pub position_flag: u8,
}

impl PerpPosition {
    pub fn is_for(&self, market_index: u16) -> bool {
        self.market_index == market_index && !self.is_available()
    }

    pub fn is_available(&self) -> bool {
        !self.is_open_position()
            && !self.has_open_order()
            && !self.has_unsettled_pnl()
            && self.isolated_position_scaled_balance == 0
            && !self.is_being_liquidated()
    }

    pub fn is_open_position(&self) -> bool {
        self.base_asset_amount != 0
    }

    pub fn has_open_order(&self) -> bool {
        self.open_orders != 0 || self.open_bids != 0 || self.open_asks != 0
    }

    pub fn margin_requirement_for_open_orders(&self) -> VelocityResult<u128> {
        self.open_orders
            .cast::<u128>()?
            .safe_mul(OPEN_ORDER_MARGIN_REQUIREMENT)
    }

    pub fn has_unsettled_pnl(&self) -> bool {
        self.base_asset_amount == 0 && self.quote_asset_amount != 0
    }

    pub fn worst_case_base_asset_amount(&self, oracle_price: i64) -> VelocityResult<i128> {
        self.worst_case_liability_value(oracle_price).map(|v| v.0)
    }

    pub fn worst_case_liability_value(&self, oracle_price: i64) -> VelocityResult<(i128, u128)> {
        let base_asset_amount_all_bids_fill = self
            .base_asset_amount
            .safe_add(self.open_bids)?
            .cast::<i128>()?;
        let base_asset_amount_all_asks_fill = self
            .base_asset_amount
            .safe_add(self.open_asks)?
            .cast::<i128>()?;

        let liability_value_all_bids_fill =
            calculate_perp_liability_value(base_asset_amount_all_bids_fill, oracle_price)?;

        let liability_value_all_asks_fill =
            calculate_perp_liability_value(base_asset_amount_all_asks_fill, oracle_price)?;

        if liability_value_all_asks_fill >= liability_value_all_bids_fill {
            Ok((
                base_asset_amount_all_asks_fill,
                liability_value_all_asks_fill,
            ))
        } else {
            Ok((
                base_asset_amount_all_bids_fill,
                liability_value_all_bids_fill,
            ))
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

    pub fn get_unrealized_pnl(&self, oracle_price: i64) -> VelocityResult<i128> {
        let (_, unrealized_pnl) =
            calculate_base_asset_value_and_pnl_with_oracle_price(self, oracle_price)?;

        Ok(unrealized_pnl)
    }

    pub fn get_base_asset_amount(&self) -> VelocityResult<i128> {
        self.base_asset_amount.cast::<i128>()
    }

    pub fn get_base_asset_amount_abs(&self) -> VelocityResult<i128> {
        Ok(self.get_base_asset_amount()?.abs())
    }

    pub fn get_claimable_pnl(
        &self,
        oracle_price: i64,
        pnl_pool_excess: i128,
    ) -> VelocityResult<i128> {
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

            if max_positive_pnl < unrealized_pnl {
                msg!(
                    "Claimable pnl below position upnl: {} < {}",
                    max_positive_pnl,
                    unrealized_pnl
                );
            }

            Ok(unrealized_pnl.min(max_positive_pnl))
        } else {
            Ok(unrealized_pnl)
        }
    }

    pub fn get_existing_position_params_for_order_action(
        &self,
        fill_direction: PositionDirection,
    ) -> Option<(u64, u64)> {
        if self.base_asset_amount == 0 {
            return None;
        }

        if self.get_direction_to_close() == fill_direction {
            Some((
                self.quote_entry_amount.unsigned_abs(),
                self.base_asset_amount.unsigned_abs(),
            ))
        } else {
            None
        }
    }

    pub fn is_isolated(&self) -> bool {
        self.position_flag & PositionFlag::IsolatedPosition as u8 > 0
    }

    pub fn get_isolated_token_amount(&self, spot_market: &SpotMarket) -> VelocityResult<u128> {
        get_token_amount(
            self.isolated_position_scaled_balance as u128,
            spot_market,
            &SpotBalanceType::Deposit,
        )
    }

    pub fn is_being_liquidated(&self) -> bool {
        self.position_flag & (PositionFlag::BeingLiquidated as u8 | PositionFlag::Bankrupt as u8)
            > 0
    }

    pub fn is_bankrupt(&self) -> bool {
        self.position_flag & PositionFlag::Bankrupt as u8 > 0
    }

    pub fn can_transfer_isolated_position_deposit(&self) -> bool {
        self.is_isolated()
            && self.isolated_position_scaled_balance > 0
            && !self.is_open_position()
            && !self.has_open_order()
            && !self.has_unsettled_pnl()
    }
}

impl SpotBalance for PerpPosition {
    fn market_index(&self) -> u16 {
        QUOTE_SPOT_MARKET_INDEX
    }

    fn balance_type(&self) -> &SpotBalanceType {
        &SpotBalanceType::Deposit
    }

    fn balance(&self) -> u128 {
        self.isolated_position_scaled_balance as u128
    }

    fn increase_balance(&mut self, delta: u128) -> VelocityResult {
        self.isolated_position_scaled_balance = self
            .isolated_position_scaled_balance
            .safe_add(delta.cast::<u64>()?)?;
        Ok(())
    }

    fn decrease_balance(&mut self, delta: u128) -> VelocityResult {
        self.isolated_position_scaled_balance = self
            .isolated_position_scaled_balance
            .safe_sub(delta.cast::<u64>()?)?;
        Ok(())
    }

    fn update_balance_type(&mut self, _balance_type: SpotBalanceType) -> VelocityResult {
        Err(ErrorCode::CantUpdateSpotBalanceType)
    }
}

pub(crate) type PerpPositions = [PerpPosition; 8];

#[cfg(test)]
use crate::math::constants::{AMM_TO_QUOTE_PRECISION_RATIO_I128, PRICE_PRECISION_I128};

#[cfg(test)]
impl PerpPosition {
    pub fn get_breakeven_price(&self) -> VelocityResult<i128> {
        let base_with_remainder = self.get_base_asset_amount()?;
        if base_with_remainder == 0 {
            return Ok(0);
        }

        (-self.quote_break_even_amount.cast::<i128>()?)
            .safe_mul(PRICE_PRECISION_I128)?
            .safe_mul(AMM_TO_QUOTE_PRECISION_RATIO_I128)?
            .safe_div(base_with_remainder)
    }

    pub fn get_entry_price(&self) -> VelocityResult<i128> {
        let base_with_remainder = self.get_base_asset_amount()?;
        if base_with_remainder == 0 {
            return Ok(0);
        }

        (-self.quote_entry_amount.cast::<i128>()?)
            .safe_mul(PRICE_PRECISION_I128)?
            .safe_mul(AMM_TO_QUOTE_PRECISION_RATIO_I128)?
            .safe_div(base_with_remainder)
    }

    pub fn get_cost_basis(&self) -> VelocityResult<i128> {
        if self.base_asset_amount == 0 {
            return Ok(0);
        }

        (-self.quote_asset_amount.cast::<i128>()?)
            .safe_mul(PRICE_PRECISION_I128)?
            .safe_mul(AMM_TO_QUOTE_PRECISION_RATIO_I128)?
            .safe_div(self.base_asset_amount.cast()?)
    }
}

#[zero_copy(unsafe)]
#[derive(BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
#[repr(C)]
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
    pub oracle_price_offset: i64,
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
    /// Last 8 bits of the slot the order was posted on-chain (not order slot for signed msg orders)
    pub posted_slot_tail: u8,
    /// Bitflags for further classification
    /// 0: is_signed_message
    pub bit_flags: u8,
    pub padding: [u8; 5],
}

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Eq, Debug)]
pub enum AssetType {
    Base,
    Quote,
}

impl Order {
    pub fn seconds_til_expiry(self, now: i64) -> i64 {
        (self.max_ts - now).max(0)
    }

    pub fn has_oracle_price_offset(self) -> bool {
        self.oracle_price_offset != 0
    }

    pub fn get_limit_price(
        &self,
        valid_oracle_price: Option<i64>,
        fallback_price: Option<u64>,
        slot: u64,
        tick_size: u64,
    ) -> VelocityResult<Option<u64>> {
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

            let limit_price = oracle_price
                .safe_add(self.oracle_price_offset.cast()?)?
                .max(tick_size.cast()?)
                .cast::<u64>()?;

            Some(standardize_price(limit_price, tick_size, self.direction)?)
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
    ) -> VelocityResult<u64> {
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

    pub fn has_limit_price(self, slot: u64) -> VelocityResult<bool> {
        Ok(self.price > 0
            || self.has_oracle_price_offset()
            || !is_auction_complete(self.slot, self.auction_duration, slot)?)
    }

    pub fn is_auction_complete(self, slot: u64) -> VelocityResult<bool> {
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
    ) -> VelocityResult<bool> {
        let auction_complete = is_auction_complete(order_slot, auction_duration, slot)?;
        let has_auction_prices = self.auction_start_price != 0 || self.auction_end_price != 0;
        Ok(!auction_complete && has_auction_prices)
    }

    /// Passing in an existing_position forces the function to consider the order's reduce only status
    pub fn get_base_asset_amount_unfilled(
        &self,
        existing_position: Option<i64>,
    ) -> VelocityResult<u64> {
        let base_asset_amount_unfilled = self
            .base_asset_amount
            .safe_sub(self.base_asset_amount_filled)?;

        let existing_position = match existing_position {
            Some(existing_position) => existing_position,
            None => {
                return Ok(base_asset_amount_unfilled);
            }
        };

        if !self.reduce_only {
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
    ) -> VelocityResult<u64> {
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

    pub fn is_resting_limit_order(&self, slot: u64) -> VelocityResult<bool> {
        if !self.is_limit_order() {
            return Ok(false);
        }

        Ok(self.post_only || self.is_auction_complete(slot)?)
    }

    pub fn is_signed_msg(&self) -> bool {
        self.is_bit_flag_set(OrderBitFlag::SignedMessage)
    }

    pub fn is_has_builder(&self) -> bool {
        self.is_bit_flag_set(OrderBitFlag::HasBuilder)
    }

    pub fn add_bit_flag(&mut self, flag: OrderBitFlag) {
        self.bit_flags |= flag as u8;
    }

    pub fn is_bit_flag_set(&self, flag: OrderBitFlag) -> bool {
        (self.bit_flags & flag as u8) != 0
    }

    pub fn is_available(&self) -> bool {
        self.status != OrderStatus::Open
    }

    pub fn update_open_bids_and_asks(&self) -> bool {
        !self.must_be_triggered()
            || (self.triggered()
                && !(self.reduce_only && self.is_bit_flag_set(OrderBitFlag::NewTriggerReduceOnly)))
    }

    pub fn is_low_risk_for_amm(
        &self,
        mm_oracle_delay: i64,
        clock_slot: u64,
        is_liquidation: bool,
        user_can_skip_auction_duration: bool,
    ) -> VelocityResult<bool> {
        if self.market_type == MarketType::Spot {
            return Ok(false);
        }

        let order_older_than_oracle_delay = {
            let clock_minus_delay = clock_slot.cast::<i64>()?.safe_sub(mm_oracle_delay)?;
            if user_can_skip_auction_duration {
                clock_minus_delay >= self.slot.cast::<i64>()?
            } else {
                clock_minus_delay > self.slot.cast::<i64>()?
            }
        };

        Ok(order_older_than_oracle_delay
            || is_liquidation
            || self.is_bit_flag_set(OrderBitFlag::SafeTriggerOrder))
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
            posted_slot_tail: 0,
            bit_flags: 0,
            padding: [0; 5],
        }
    }
}

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Eq, Debug)]
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

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Debug, Eq, Default)]
pub enum OrderType {
    Market,
    #[default]
    Limit,
    TriggerMarket,
    TriggerLimit,
    /// Market order where the auction prices are oracle offsets
    Oracle,
}

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Debug, Eq, Default)]
pub enum OrderTriggerCondition {
    #[default]
    Above,
    Below,
    TriggeredAbove, // above condition has been triggered
    TriggeredBelow, // below condition has been triggered
}

#[derive(Default, Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Debug, Eq)]
pub enum MarketType {
    #[default]
    Spot,
    Perp,
}

impl fmt::Display for MarketType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MarketType::Spot => write!(f, "Spot"),
            MarketType::Perp => write!(f, "Perp"),
        }
    }
}

unsafe impl Zeroable for MarketType {}
unsafe impl Pod for MarketType {}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
#[borsh(use_discriminant = true)]
pub enum OrderBitFlag {
    SignedMessage = 0b00000001,
    OracleTriggerMarket = 0b00000010,
    SafeTriggerOrder = 0b00000100,
    NewTriggerReduceOnly = 0b00001000,
    HasBuilder = 0b00010000,
    IsIsolatedPosition = 0b00100000,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
#[borsh(use_discriminant = true)]
pub enum PositionFlag {
    IsolatedPosition = 0b00000001,
    BeingLiquidated = 0b00000010,
    Bankrupt = 0b00000100,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
#[borsh(use_discriminant = true)]
pub enum UserDelegatePermission {
    AllowDelegateTransfer = 0b00000001,
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
    /// Flags for referrer status:
    /// First bit (LSB): 1 if user is a referrer, 0 otherwise
    /// Second bit: 1 if user was referred, 0 otherwise
    pub referrer_status: u8,
    pub disable_update_perp_bid_ask_twap: u8,
    pub paused_operations: u8,

    /// 9 bytes: 1 byte of former repr(C) alignment padding + the removed
    /// 8-byte `if_staked_gov_token_amount` field (gov-token stake fee discount)
    pub padding1: [u8; 9],

    /// Delegate permissions across all sub accounts
    pub delegate_permissions: u8,
    pub padding: [u8; 63],
}

impl Default for UserStats {
    fn default() -> Self {
        Self {
            authority: Pubkey::default(),
            referrer: Pubkey::default(),
            fees: UserFees::default(),
            maker_volume_30d: 0,
            taker_volume_30d: 0,
            filler_volume_30d: 0,
            last_maker_volume_30d_ts: 0,
            last_taker_volume_30d_ts: 0,
            last_filler_volume_30d_ts: 0,
            if_staked_quote_asset_amount: 0,
            number_of_sub_accounts: 0,
            number_of_sub_accounts_created: 0,
            referrer_status: 0,
            disable_update_perp_bid_ask_twap: 0,
            paused_operations: 0,
            padding1: [0; 9],
            delegate_permissions: 0,
            padding: [0; 63],
        }
    }
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum ReferrerStatus {
    IsReferrer = 0b00000001,
    IsReferred = 0b00000010,
    BuilderReferral = 0b00000100,
}

impl ReferrerStatus {
    pub fn is_referrer(status: u8) -> bool {
        status & ReferrerStatus::IsReferrer as u8 != 0
    }

    pub fn is_referred(status: u8) -> bool {
        status & ReferrerStatus::IsReferred as u8 != 0
    }

    pub fn has_builder_referral(status: u8) -> bool {
        status & ReferrerStatus::BuilderReferral as u8 != 0
    }
}

impl Size for UserStats {
    const SIZE: usize = 240;
}

impl UserStats {
    pub fn update_allow_delegate_transfer(
        &mut self,
        allow_delegate_transfer: bool,
    ) -> VelocityResult {
        if allow_delegate_transfer {
            self.delegate_permissions |= UserDelegatePermission::AllowDelegateTransfer as u8;
        } else {
            self.delegate_permissions &= !(UserDelegatePermission::AllowDelegateTransfer as u8);
        }

        self.validate_delegate_permissions()
    }

    pub fn is_delegate_transfer_allowed(&self) -> bool {
        self.delegate_permissions & UserDelegatePermission::AllowDelegateTransfer as u8 != 0
    }

    pub fn validate_delegate_permissions(&self) -> VelocityResult {
        let allowed_bits = UserDelegatePermission::AllowDelegateTransfer as u8;

        validate!(
            self.delegate_permissions & !allowed_bits == 0,
            ErrorCode::DefaultError,
            "unknown bits set in delegate_permissions: {:?}",
            self.delegate_permissions
        )?;

        Ok(())
    }

    pub fn update_maker_volume_30d(&mut self, quote_asset_amount: u64, now: i64) -> VelocityResult {
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

    pub fn update_taker_volume_30d(&mut self, quote_asset_amount: u64, now: i64) -> VelocityResult {
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

    pub fn update_filler_volume(&mut self, quote_asset_amount: u64, now: i64) -> VelocityResult {
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

    pub fn increment_total_fees(&mut self, fee: u64) -> VelocityResult {
        self.fees.total_fee_paid = self.fees.total_fee_paid.safe_add(fee)?;

        Ok(())
    }

    pub fn increment_total_rebate(&mut self, fee: u64) -> VelocityResult {
        self.fees.total_fee_rebate = self.fees.total_fee_rebate.safe_add(fee)?;

        Ok(())
    }

    pub fn increment_total_referee_discount(&mut self, discount: u64) -> VelocityResult {
        self.fees.total_referee_discount = self.fees.total_referee_discount.safe_add(discount)?;

        Ok(())
    }

    pub fn has_referrer(&self) -> bool {
        !self.referrer.eq(&Pubkey::default())
    }

    pub fn get_total_30d_volume(&self) -> VelocityResult<u64> {
        self.taker_volume_30d.safe_add(self.maker_volume_30d)
    }

    pub fn get_age_ts(&self, now: i64) -> i64 {
        // upper bound of age of the user stats account
        let min_action_ts: i64 = self
            .last_filler_volume_30d_ts
            .min(self.last_maker_volume_30d_ts)
            .min(self.last_taker_volume_30d_ts);
        now.saturating_sub(min_action_ts).max(0)
    }

    pub fn is_referrer(&self) -> bool {
        ReferrerStatus::is_referrer(self.referrer_status)
    }

    pub fn update_referrer_status(&mut self) {
        if !self.referrer.eq(&Pubkey::default()) {
            self.referrer_status |= ReferrerStatus::IsReferred as u8;
        } else {
            self.referrer_status &= !(ReferrerStatus::IsReferred as u8);
        }
    }

    pub fn update_builder_referral_status(&mut self) {
        if !self.referrer.eq(&Pubkey::default()) {
            self.referrer_status |= ReferrerStatus::BuilderReferral as u8;
        } else {
            self.referrer_status &= !(ReferrerStatus::BuilderReferral as u8);
        }
    }

    pub fn can_update_bid_ask_twap(&self) -> bool {
        let update_mark_twap_paused = UserStatsPausedOperations::is_operation_paused(
            self.paused_operations,
            UserStatsPausedOperations::UpdateBidAskTwap,
        );
        !update_mark_twap_paused
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

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum UserStatsPausedOperations {
    UpdateBidAskTwap = 0b00000001,
    AmmAtomicFill = 0b00000010,
    AmmAtomicRiskIncreasingFill = 0b00000100,
}

impl UserStatsPausedOperations {
    pub fn is_operation_paused(current: u8, operation: UserStatsPausedOperations) -> bool {
        current & operation as u8 != 0
    }
}
