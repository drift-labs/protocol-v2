use solana_program::msg;

use crate::{
    controller::{
        spot_balance::update_spot_balances,
        spot_position::update_spot_balances_and_cumulative_deposits,
    },
    error::{DriftResult, ErrorCode},
    math::{
        bankruptcy::{is_cross_margin_bankrupt, is_isolated_margin_bankrupt},
        liquidation::calculate_max_pct_to_liquidate,
        margin::calculate_user_safest_position_tiers,
        safe_unwrap::SafeUnwrap,
    },
    state::margin_calculation::{MarginCalculation, MarginContext, MarketIdentifier},
    validate, LIQUIDATION_PCT_PRECISION, QUOTE_SPOT_MARKET_INDEX,
};

use super::{
    events::LiquidationBitFlag,
    perp_market::ContractTier,
    perp_market_map::PerpMarketMap,
    spot_market::{AssetTier, SpotBalanceType, SpotMarket},
    spot_market_map::SpotMarketMap,
    user::{MarketType, User},
};

pub trait LiquidatePerpMode {
    fn user_is_being_liquidated(&self, user: &User) -> DriftResult<bool>;

    fn meets_margin_requirements(
        &self,
        margin_calculation: &MarginCalculation,
    ) -> DriftResult<bool>;

    fn enter_liquidation(&self, user: &mut User, slot: u64) -> DriftResult<u16>;

    fn can_exit_liquidation(&self, margin_calculation: &MarginCalculation) -> DriftResult<bool>;

    fn exit_liquidation(&self, user: &mut User) -> DriftResult<()>;

    fn get_cancel_orders_params(&self) -> (Option<MarketType>, Option<u16>);

    fn calculate_max_pct_to_liquidate(
        &self,
        user: &User,
        margin_shortage: u128,
        slot: u64,
        initial_pct_to_liquidate: u128,
        liquidation_duration: u128,
    ) -> DriftResult<u128>;

    fn increment_free_margin(&self, user: &mut User, amount: u64) -> DriftResult<()>;

    fn is_user_bankrupt(&self, user: &User) -> DriftResult<bool>;

    fn should_user_enter_bankruptcy(&self, user: &User) -> DriftResult<bool>;

    fn enter_bankruptcy(&self, user: &mut User) -> DriftResult<()>;

    fn exit_bankruptcy(&self, user: &mut User) -> DriftResult<()>;

    fn get_event_fields(
        &self,
        margin_calculation: &MarginCalculation,
    ) -> DriftResult<(u128, i128, u8)>;

    fn validate_spot_position(&self, user: &User, asset_market_index: u16) -> DriftResult<()>;

    fn get_spot_token_amount(&self, user: &User, spot_market: &SpotMarket) -> DriftResult<u128>;

    fn calculate_user_safest_position_tiers(
        &self,
        user: &User,
        perp_market_map: &PerpMarketMap,
        spot_market_map: &SpotMarketMap,
    ) -> DriftResult<(AssetTier, ContractTier)>;

    fn decrease_spot_token_amount(
        &self,
        user: &mut User,
        token_amount: u128,
        spot_market: &mut SpotMarket,
        cumulative_deposit_delta: Option<u128>,
    ) -> DriftResult<()>;

    fn margin_shortage(&self, margin_calculation: &MarginCalculation) -> DriftResult<u128>;
}

pub fn get_perp_liquidation_mode(
    user: &User,
    market_index: u16,
) -> DriftResult<Box<dyn LiquidatePerpMode>> {
    let perp_position = user.get_perp_position(market_index)?;
    let mode: Box<dyn LiquidatePerpMode> = if perp_position.is_isolated() {
        Box::new(IsolatedMarginLiquidatePerpMode::new(market_index))
    } else {
        Box::new(CrossMarginLiquidatePerpMode::new(market_index))
    };

    Ok(mode)
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
    fn user_is_being_liquidated(&self, user: &User) -> DriftResult<bool> {
        Ok(user.is_cross_margin_being_liquidated())
    }

    fn meets_margin_requirements(
        &self,
        margin_calculation: &MarginCalculation,
    ) -> DriftResult<bool> {
        Ok(margin_calculation.meets_cross_margin_requirement())
    }

    fn enter_liquidation(&self, user: &mut User, slot: u64) -> DriftResult<u16> {
        user.enter_cross_margin_liquidation(slot)
    }

    fn can_exit_liquidation(&self, margin_calculation: &MarginCalculation) -> DriftResult<bool> {
        Ok(margin_calculation.can_exit_cross_margin_liquidation()?)
    }

    fn exit_liquidation(&self, user: &mut User) -> DriftResult<()> {
        Ok(user.exit_cross_margin_liquidation())
    }

    fn get_cancel_orders_params(&self) -> (Option<MarketType>, Option<u16>) {
        (None, None)
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

    fn increment_free_margin(&self, user: &mut User, amount: u64) -> DriftResult<()> {
        user.increment_margin_freed(amount)
    }

    fn is_user_bankrupt(&self, user: &User) -> DriftResult<bool> {
        Ok(user.is_cross_margin_bankrupt())
    }

    fn should_user_enter_bankruptcy(&self, user: &User) -> DriftResult<bool> {
        Ok(is_cross_margin_bankrupt(user))
    }

    fn enter_bankruptcy(&self, user: &mut User) -> DriftResult<()> {
        Ok(user.enter_cross_margin_bankruptcy())
    }

    fn exit_bankruptcy(&self, user: &mut User) -> DriftResult<()> {
        Ok(user.exit_cross_margin_bankruptcy())
    }

    fn get_event_fields(
        &self,
        margin_calculation: &MarginCalculation,
    ) -> DriftResult<(u128, i128, u8)> {
        Ok((
            margin_calculation.margin_requirement,
            margin_calculation.total_collateral,
            0,
        ))
    }

    fn validate_spot_position(&self, user: &User, asset_market_index: u16) -> DriftResult<()> {
        if user.get_spot_position(asset_market_index).is_err() {
            msg!(
                "User does not have a spot balance for asset market {}",
                asset_market_index
            );

            return Err(ErrorCode::CouldNotFindSpotPosition);
        }

        Ok(())
    }

    fn get_spot_token_amount(&self, user: &User, spot_market: &SpotMarket) -> DriftResult<u128> {
        let spot_position = user.get_spot_position(spot_market.market_index)?;

        validate!(
            spot_position.balance_type == SpotBalanceType::Deposit,
            ErrorCode::WrongSpotBalanceType,
            "User did not have a deposit for the asset market"
        )?;

        let token_amount = spot_position.get_token_amount(&spot_market)?;

        validate!(
            token_amount != 0,
            ErrorCode::InvalidSpotPosition,
            "asset token amount zero for market index = {}",
            spot_market.market_index
        )?;

        Ok(token_amount)
    }

    fn calculate_user_safest_position_tiers(
        &self,
        user: &User,
        perp_market_map: &PerpMarketMap,
        spot_market_map: &SpotMarketMap,
    ) -> DriftResult<(AssetTier, ContractTier)> {
        calculate_user_safest_position_tiers(user, perp_market_map, spot_market_map)
    }

    fn decrease_spot_token_amount(
        &self,
        user: &mut User,
        token_amount: u128,
        spot_market: &mut SpotMarket,
        cumulative_deposit_delta: Option<u128>,
    ) -> DriftResult<()> {
        let spot_position = user.get_spot_position_mut(spot_market.market_index)?;

        update_spot_balances_and_cumulative_deposits(
            token_amount,
            &SpotBalanceType::Borrow,
            spot_market,
            spot_position,
            false,
            cumulative_deposit_delta,
        )?;

        Ok(())
    }

    fn margin_shortage(&self, margin_calculation: &MarginCalculation) -> DriftResult<u128> {
        margin_calculation.cross_margin_margin_shortage()
    }
}

pub struct IsolatedMarginLiquidatePerpMode {
    pub market_index: u16,
}

impl IsolatedMarginLiquidatePerpMode {
    pub fn new(market_index: u16) -> Self {
        Self { market_index }
    }
}

impl LiquidatePerpMode for IsolatedMarginLiquidatePerpMode {
    fn user_is_being_liquidated(&self, user: &User) -> DriftResult<bool> {
        user.is_isolated_margin_being_liquidated(self.market_index)
    }

    fn meets_margin_requirements(
        &self,
        margin_calculation: &MarginCalculation,
    ) -> DriftResult<bool> {
        margin_calculation.meets_isolated_margin_requirement(self.market_index)
    }

    fn can_exit_liquidation(&self, margin_calculation: &MarginCalculation) -> DriftResult<bool> {
        margin_calculation.can_exit_isolated_margin_liquidation(self.market_index)
    }

    fn enter_liquidation(&self, user: &mut User, slot: u64) -> DriftResult<u16> {
        user.enter_isolated_margin_liquidation(self.market_index, slot)
    }

    fn exit_liquidation(&self, user: &mut User) -> DriftResult<()> {
        user.exit_isolated_margin_liquidation(self.market_index)
    }

    fn get_cancel_orders_params(&self) -> (Option<MarketType>, Option<u16>) {
        (Some(MarketType::Perp), Some(self.market_index))
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

    fn increment_free_margin(&self, user: &mut User, amount: u64) -> DriftResult<()> {
        Ok(())
    }

    fn is_user_bankrupt(&self, user: &User) -> DriftResult<bool> {
        user.is_isolated_margin_bankrupt(self.market_index)
    }

    fn should_user_enter_bankruptcy(&self, user: &User) -> DriftResult<bool> {
        is_isolated_margin_bankrupt(user, self.market_index)
    }

    fn enter_bankruptcy(&self, user: &mut User) -> DriftResult<()> {
        user.enter_isolated_margin_bankruptcy(self.market_index)
    }

    fn exit_bankruptcy(&self, user: &mut User) -> DriftResult<()> {
        user.exit_isolated_margin_bankruptcy(self.market_index)
    }

    fn get_event_fields(
        &self,
        margin_calculation: &MarginCalculation,
    ) -> DriftResult<(u128, i128, u8)> {
        let isolated_margin_calculation = margin_calculation
            .isolated_margin_calculations
            .get(&self.market_index)
            .safe_unwrap()?;
        Ok((
            isolated_margin_calculation.margin_requirement,
            isolated_margin_calculation.total_collateral,
            LiquidationBitFlag::IsolatedPosition as u8,
        ))
    }

    fn validate_spot_position(&self, user: &User, asset_market_index: u16) -> DriftResult<()> {
        validate!(
            asset_market_index == QUOTE_SPOT_MARKET_INDEX,
            ErrorCode::CouldNotFindSpotPosition,
            "asset market index must be quote asset market index for isolated liquidation mode"
        )
    }

    fn get_spot_token_amount(&self, user: &User, spot_market: &SpotMarket) -> DriftResult<u128> {
        let isolated_perp_position = user.get_isolated_perp_position(self.market_index)?;

        let token_amount =
            isolated_perp_position.get_isolated_token_amount(spot_market)?;

        validate!(
            token_amount != 0,
            ErrorCode::InvalidSpotPosition,
            "asset token amount zero for market index = {}",
            spot_market.market_index
        )?;

        Ok(token_amount)
    }

    fn calculate_user_safest_position_tiers(
        &self,
        user: &User,
        perp_market_map: &PerpMarketMap,
        spot_market_map: &SpotMarketMap,
    ) -> DriftResult<(AssetTier, ContractTier)> {
        let contract_tier = perp_market_map.get_ref(&self.market_index)?.contract_tier;

        Ok((AssetTier::default(), contract_tier))
    }

    fn decrease_spot_token_amount(
        &self,
        user: &mut User,
        token_amount: u128,
        spot_market: &mut SpotMarket,
        cumulative_deposit_delta: Option<u128>,
    ) -> DriftResult<()> {
        let perp_position = user.force_get_isolated_perp_position_mut(self.market_index)?;

        update_spot_balances(
            token_amount,
            &SpotBalanceType::Borrow,
            spot_market,
            perp_position,
            false,
        )?;

        Ok(())
    }

    fn margin_shortage(&self, margin_calculation: &MarginCalculation) -> DriftResult<u128> {
        margin_calculation.isolated_margin_shortage(self.market_index)
    }
}
