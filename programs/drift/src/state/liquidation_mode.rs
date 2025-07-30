use solana_program::msg;

use crate::{controller::{spot_balance::update_spot_balances, spot_position::update_spot_balances_and_cumulative_deposits}, error::{DriftResult, ErrorCode}, math::{bankruptcy::{is_user_bankrupt, is_user_isolated_position_bankrupt}, liquidation::calculate_max_pct_to_liquidate, margin::calculate_user_safest_position_tiers}, state::margin_calculation::{MarginContext, MarketIdentifier}, validate, LIQUIDATION_PCT_PRECISION, QUOTE_SPOT_MARKET_INDEX};

use super::{perp_market::ContractTier, perp_market_map::PerpMarketMap, spot_market::{AssetTier, SpotBalanceType, SpotMarket}, spot_market_map::SpotMarketMap, user::{MarketType, User}};

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

    fn should_user_enter_bankruptcy(&self, user: &User) -> DriftResult<bool>;

    fn enter_bankruptcy(&self, user: &mut User) -> DriftResult<()>;

    fn exit_bankruptcy(&self, user: &mut User) -> DriftResult<()>;

    fn validate_spot_position(&self, user: &User, asset_market_index: u16) -> DriftResult<()>;

    fn get_spot_token_amount(&self, user: &User, spot_market: &SpotMarket) -> DriftResult<u128>;

    fn calculate_user_safest_position_tiers(&self, user: &User, perp_market_map: &PerpMarketMap, spot_market_map: &SpotMarketMap) -> DriftResult<(AssetTier, ContractTier)>;

    fn decrease_spot_token_amount(
        &self,
        user: &mut User,
        token_amount: u128,
        spot_market: &mut SpotMarket,
        cumulative_deposit_delta: Option<u128>,
    ) -> DriftResult<()>;
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
        Ok(MarginContext::liquidation(liquidation_margin_buffer_ratio))
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

    fn should_user_enter_bankruptcy(&self, user: &User) -> DriftResult<bool> {
        Ok(is_user_bankrupt(user))
    }

    fn enter_bankruptcy(&self, user: &mut User) -> DriftResult<()> {
        Ok(user.enter_bankruptcy())
    }

    fn exit_bankruptcy(&self, user: &mut User) -> DriftResult<()> {
        Ok(user.exit_bankruptcy())
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

    fn calculate_user_safest_position_tiers(&self, user: &User, perp_market_map: &PerpMarketMap, spot_market_map: &SpotMarketMap) -> DriftResult<(AssetTier, ContractTier)> {
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
        Ok(MarginContext::liquidation(liquidation_margin_buffer_ratio).isolated_position_market_index(self.market_index))
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
        user.is_isolated_position_bankrupt(self.market_index)
    }

    fn should_user_enter_bankruptcy(&self, user: &User) -> DriftResult<bool> {
        is_user_isolated_position_bankrupt(user, self.market_index)
    }

    fn enter_bankruptcy(&self, user: &mut User) -> DriftResult<()> {
        user.enter_isolated_position_bankruptcy(self.market_index)
    }

    fn exit_bankruptcy(&self, user: &mut User) -> DriftResult<()> {
        user.exit_isolated_position_bankruptcy(self.market_index)
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
        
        let token_amount = isolated_perp_position.get_isolated_position_token_amount(spot_market)?;

        validate!(
            token_amount != 0,
            ErrorCode::InvalidSpotPosition,
            "asset token amount zero for market index = {}",
            spot_market.market_index
        )?;

        Ok(token_amount)
    }

    fn calculate_user_safest_position_tiers(&self, user: &User, perp_market_map: &PerpMarketMap, spot_market_map: &SpotMarketMap) -> DriftResult<(AssetTier, ContractTier)> {
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
        let perp_position = user.get_isolated_perp_position_mut(&self.market_index)?;

        update_spot_balances(
            token_amount,
            &SpotBalanceType::Borrow,
            spot_market,
            perp_position,
            false,
        )?;

        Ok(())
    }
}