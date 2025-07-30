use crate::{error::DriftResult, math::{bankruptcy::{is_user_bankrupt, is_user_isolated_position_bankrupt}, liquidation::calculate_max_pct_to_liquidate}, state::margin_calculation::{MarginContext, MarketIdentifier}, LIQUIDATION_PCT_PRECISION};

use super::user::{MarketType, User};

pub trait LiquidatePerpMode {
    fn get_margin_context(&self, liquidation_margin_buffer_ratio: u32) -> DriftResult<MarginContext>;

    fn user_is_being_liquidated(&self, user: &User) -> DriftResult<bool>;

    fn exit_liquidation(&self, user: &mut User) -> DriftResult<()>;

    fn get_cancel_orders_params(&self) -> (Option<MarketType>, Option<u16>, bool);

    fn calculate_max_pct_to_liquidate(
        &self,
        user: &User,
        margin_shortage: u128,
        slot: u64,
        initial_pct_to_liquidate: u128,
        liquidation_duration: u128,
    ) -> DriftResult<u128>;

    fn increment_free_margin(&self, user: &mut User, amount: u64);

    fn is_user_bankrupt(&self, user: &User) -> DriftResult<bool>;

    fn enter_bankruptcy(&self, user: &mut User) -> DriftResult<()>;

    fn exit_bankruptcy(&self, user: &mut User) -> DriftResult<()>;
}

pub fn get_perp_liquidation_mode(user: &User, market_index: u16) -> Box<dyn LiquidatePerpMode> {
    Box::new(CrossMarginLiquidatePerpMode::new(market_index))
}

pub struct CrossMarginLiquidatePerpMode {
    pub market_index: u16,
}

impl CrossMarginLiquidatePerpMode {
    pub fn new(market_index: u16) -> Self {
        Self { market_index }
    }
}

impl LiquidatePerpMode for CrossMarginLiquidatePerpMode {
    fn get_margin_context(&self, liquidation_margin_buffer_ratio: u32) -> DriftResult<MarginContext> {
        MarginContext::liquidation(liquidation_margin_buffer_ratio)
            .track_market_margin_requirement(MarketIdentifier::perp(self.market_index))
    }

    fn user_is_being_liquidated(&self, user: &User) -> DriftResult<bool> {
        Ok(user.is_being_liquidated())
    }

    fn exit_liquidation(&self, user: &mut User) -> DriftResult<()> {
        Ok(user.exit_liquidation())
    }

    fn get_cancel_orders_params(&self) -> (Option<MarketType>, Option<u16>, bool) {
        (None, None, true)
    }

    fn calculate_max_pct_to_liquidate(
        &self,
        user: &User,
        margin_shortage: u128,
        slot: u64,
        initial_pct_to_liquidate: u128,
        liquidation_duration: u128,
    ) -> DriftResult<u128> {
        calculate_max_pct_to_liquidate(
            user,
            margin_shortage,
            slot,
            initial_pct_to_liquidate,
            liquidation_duration,
        )
    }

    fn increment_free_margin(&self, user: &mut User, amount: u64) {
        user.increment_margin_freed(amount);
    }

    fn is_user_bankrupt(&self, user: &User) -> DriftResult<bool> {
        Ok(is_user_bankrupt(user))
    }

    fn enter_bankruptcy(&self, user: &mut User) -> DriftResult<()> {
        Ok(user.enter_bankruptcy())
    }

    fn exit_bankruptcy(&self, user: &mut User) -> DriftResult<()> {
        Ok(user.exit_bankruptcy())
    }
}

pub struct IsolatedLiquidatePerpMode {
    pub market_index: u16,
}

impl IsolatedLiquidatePerpMode {
    pub fn new(market_index: u16) -> Self {
        Self { market_index }
    }
}

impl LiquidatePerpMode for IsolatedLiquidatePerpMode {
    fn get_margin_context(&self, liquidation_margin_buffer_ratio: u32) -> DriftResult<MarginContext> {
        MarginContext::liquidation(liquidation_margin_buffer_ratio)
            .isolated_position_market_index(self.market_index)
            .track_market_margin_requirement(MarketIdentifier::perp(self.market_index))
    }

    fn user_is_being_liquidated(&self, user: &User) -> DriftResult<bool> {
        user.is_isolated_position_being_liquidated(self.market_index)
    }

    fn exit_liquidation(&self, user: &mut User) -> DriftResult<()> {
        user.exit_isolated_position_liquidation(self.market_index)
    }

    fn get_cancel_orders_params(&self) -> (Option<MarketType>, Option<u16>, bool) {
        (Some(MarketType::Perp), Some(self.market_index), true)
    }

    fn calculate_max_pct_to_liquidate(
        &self,
        user: &User,
        margin_shortage: u128,
        slot: u64,
        initial_pct_to_liquidate: u128,
        liquidation_duration: u128,
    ) -> DriftResult<u128> {
        Ok(LIQUIDATION_PCT_PRECISION)
    }

    fn increment_free_margin(&self, user: &mut User, amount: u64) {
        return;
    }

    fn is_user_bankrupt(&self, user: &User) -> DriftResult<bool> {
        is_user_isolated_position_bankrupt(user, self.market_index)
    }

    fn enter_bankruptcy(&self, user: &mut User) -> DriftResult<()> {
        user.enter_isolated_position_bankruptcy(self.market_index)
    }

    fn exit_bankruptcy(&self, user: &mut User) -> DriftResult<()> {
        user.exit_isolated_position_bankruptcy(self.market_index)
    }
}