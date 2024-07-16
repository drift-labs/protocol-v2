use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::fuel::{calculate_perp_fuel_bonus, calculate_spot_fuel_bonus};
use crate::math::margin::MarginRequirementType;
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_strict_token_value;
use crate::state::oracle::StrictOraclePrice;
use crate::state::perp_market::PerpMarket;
use crate::state::spot_market::SpotMarket;
use crate::state::user::{PerpPosition, User};
use crate::{validate, MarketType, AMM_RESERVE_PRECISION_I128, MARGIN_PRECISION_U128};
use anchor_lang::{prelude::*, solana_program::msg};

#[derive(Clone, Copy, Debug)]
pub enum MarginCalculationMode {
    Standard {
        track_open_orders_fraction: bool,
    },
    Liquidation {
        market_to_track_margin_requirement: Option<MarketIdentifier>,
    },
}

#[derive(Clone, Copy, Debug)]
pub struct MarginContext {
    pub margin_type: MarginRequirementType,
    pub mode: MarginCalculationMode,
    pub strict: bool,
    pub margin_buffer: u128,
    pub fuel_bonus_numerator: i64,
    pub fuel_bonus: u64,
    pub fuel_perp_delta: Option<(u16, i64)>,
    pub fuel_spot_deltas: [(u16, i128); 2],
}

#[derive(PartialEq, Eq, Copy, Clone, Debug, AnchorSerialize, AnchorDeserialize)]
pub struct MarketIdentifier {
    pub market_type: MarketType,
    pub market_index: u16,
}

impl MarketIdentifier {
    pub fn spot(market_index: u16) -> Self {
        Self {
            market_type: MarketType::Spot,
            market_index,
        }
    }

    pub fn perp(market_index: u16) -> Self {
        Self {
            market_type: MarketType::Perp,
            market_index,
        }
    }
}

impl MarginContext {
    pub fn standard(margin_type: MarginRequirementType) -> Self {
        Self {
            margin_type,
            mode: MarginCalculationMode::Standard {
                track_open_orders_fraction: false,
            },
            strict: false,
            margin_buffer: 0,
            fuel_bonus_numerator: 0,
            fuel_bonus: 0,
            fuel_perp_delta: None,
            fuel_spot_deltas: [(0, 0); 2],
        }
    }

    pub fn strict(mut self, strict: bool) -> Self {
        self.strict = strict;
        self
    }

    pub fn margin_buffer(mut self, margin_buffer: u32) -> Self {
        self.margin_buffer = margin_buffer as u128;
        self
    }

    // how to change the user's spot position to match how it was prior to instruction change
    // i.e. diffs are ADDED to perp
    pub fn fuel_perp_delta(mut self, market_index: u16, delta: i64) -> Self {
        self.fuel_perp_delta = Some((market_index, delta));
        self
    }

    pub fn fuel_spot_delta(mut self, market_index: u16, delta: i128) -> Self {
        self.fuel_spot_deltas[0] = (market_index, delta);
        self
    }

    pub fn fuel_spot_deltas(mut self, deltas: [(u16, i128); 2]) -> Self {
        self.fuel_spot_deltas = deltas;
        self
    }

    pub fn fuel_numerator(mut self, user: &User, now: i64) -> Self {
        self.fuel_bonus_numerator = user.get_fuel_bonus_numerator(now).unwrap();
        self
    }

    pub fn track_open_orders_fraction(mut self) -> DriftResult<Self> {
        match self.mode {
            MarginCalculationMode::Standard {
                track_open_orders_fraction: ref mut track,
            } => {
                *track = true;
            }
            _ => {
                msg!("Cant track open orders fraction outside of standard mode");
                return Err(ErrorCode::InvalidMarginCalculation);
            }
        }
        Ok(self)
    }

    pub fn liquidation(margin_buffer: u32) -> Self {
        Self {
            margin_type: MarginRequirementType::Maintenance,
            mode: MarginCalculationMode::Liquidation {
                market_to_track_margin_requirement: None,
            },
            margin_buffer: margin_buffer as u128,
            strict: false,
            fuel_bonus_numerator: 0,
            fuel_bonus: 0,
            fuel_perp_delta: None,
            fuel_spot_deltas: [(0, 0); 2],
        }
    }

    pub fn track_market_margin_requirement(
        mut self,
        market_identifier: MarketIdentifier,
    ) -> DriftResult<Self> {
        match self.mode {
            MarginCalculationMode::Liquidation {
                market_to_track_margin_requirement: ref mut market_to_track,
                ..
            } => {
                *market_to_track = Some(market_identifier);
            }
            _ => {
                msg!("Cant track market outside of liquidation mode");
                return Err(ErrorCode::InvalidMarginCalculation);
            }
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct MarginCalculation {
    pub context: MarginContext,
    pub total_collateral: i128,
    pub margin_requirement: u128,
    #[cfg(not(test))]
    margin_requirement_plus_buffer: u128,
    #[cfg(test)]
    pub margin_requirement_plus_buffer: u128,
    pub num_spot_liabilities: u8,
    pub num_perp_liabilities: u8,
    pub all_oracles_valid: bool,
    pub with_perp_isolated_liability: bool,
    pub with_spot_isolated_liability: bool,
    pub total_spot_asset_value: i128,
    pub total_spot_liability_value: u128,
    pub total_perp_liability_value: u128,
    pub total_perp_pnl: i128,
    pub open_orders_margin_requirement: u128,
    tracked_market_margin_requirement: u128,
    pub fuel_deposits: u32,
    pub fuel_borrows: u32,
    pub fuel_positions: u32,
}

impl MarginCalculation {
    pub fn new(context: MarginContext) -> Self {
        Self {
            context,
            total_collateral: 0,
            margin_requirement: 0,
            margin_requirement_plus_buffer: 0,
            num_spot_liabilities: 0,
            num_perp_liabilities: 0,
            all_oracles_valid: true,
            with_perp_isolated_liability: false,
            with_spot_isolated_liability: false,
            total_spot_asset_value: 0,
            total_spot_liability_value: 0,
            total_perp_liability_value: 0,
            total_perp_pnl: 0,
            open_orders_margin_requirement: 0,
            tracked_market_margin_requirement: 0,
            fuel_deposits: 0,
            fuel_borrows: 0,
            fuel_positions: 0,
        }
    }

    pub fn add_total_collateral(&mut self, total_collateral: i128) -> DriftResult {
        self.total_collateral = self.total_collateral.safe_add(total_collateral)?;
        Ok(())
    }

    pub fn add_margin_requirement(
        &mut self,
        margin_requirement: u128,
        liability_value: u128,
        market_identifier: MarketIdentifier,
    ) -> DriftResult {
        self.margin_requirement = self.margin_requirement.safe_add(margin_requirement)?;

        if self.context.margin_buffer > 0 {
            self.margin_requirement_plus_buffer =
                self.margin_requirement_plus_buffer
                    .safe_add(margin_requirement.safe_add(
                        liability_value.safe_mul(self.context.margin_buffer)?
                            / MARGIN_PRECISION_U128,
                    )?)?;
        }

        if let Some(market_to_track) = self.market_to_track_margin_requirement() {
            if market_to_track == market_identifier {
                self.tracked_market_margin_requirement = self
                    .tracked_market_margin_requirement
                    .safe_add(margin_requirement)?;
            }
        }

        Ok(())
    }

    pub fn add_open_orders_margin_requirement(&mut self, margin_requirement: u128) -> DriftResult {
        self.open_orders_margin_requirement = self
            .open_orders_margin_requirement
            .safe_add(margin_requirement)?;
        Ok(())
    }

    pub fn add_spot_liability(&mut self) -> DriftResult {
        self.num_spot_liabilities = self.num_spot_liabilities.safe_add(1)?;
        Ok(())
    }

    pub fn add_perp_liability(&mut self) -> DriftResult {
        self.num_perp_liabilities = self.num_perp_liabilities.safe_add(1)?;
        Ok(())
    }

    #[cfg(feature = "drift-rs")]
    pub fn add_spot_asset_value(&mut self, spot_asset_value: i128) -> DriftResult {
        self.total_spot_asset_value = self.total_spot_asset_value.safe_add(spot_asset_value)?;
        Ok(())
    }

    #[cfg(feature = "drift-rs")]
    pub fn add_spot_liability_value(&mut self, spot_liability_value: u128) -> DriftResult {
        self.total_spot_liability_value = self
            .total_spot_liability_value
            .safe_add(spot_liability_value)?;
        Ok(())
    }

    #[cfg(feature = "drift-rs")]
    pub fn add_perp_liability_value(&mut self, perp_liability_value: u128) -> DriftResult {
        self.total_perp_liability_value = self
            .total_perp_liability_value
            .safe_add(perp_liability_value)?;
        Ok(())
    }

    #[cfg(feature = "drift-rs")]
    pub fn add_perp_pnl(&mut self, perp_pnl: i128) -> DriftResult {
        self.total_perp_pnl = self.total_perp_pnl.safe_add(perp_pnl)?;
        Ok(())
    }

    pub fn update_all_oracles_valid(&mut self, valid: bool) {
        self.all_oracles_valid &= valid;
    }

    pub fn update_with_spot_isolated_liability(&mut self, isolated: bool) {
        self.with_spot_isolated_liability |= isolated;
    }

    pub fn update_with_perp_isolated_liability(&mut self, isolated: bool) {
        self.with_perp_isolated_liability |= isolated;
    }

    pub fn validate_num_spot_liabilities(&self) -> DriftResult {
        if self.num_spot_liabilities > 0 {
            validate!(
                self.margin_requirement > 0,
                ErrorCode::InvalidMarginRatio,
                "num_spot_liabilities={} but margin_requirement=0",
                self.num_spot_liabilities
            )?;
        }
        Ok(())
    }

    pub fn get_num_of_liabilities(&self) -> DriftResult<u8> {
        self.num_spot_liabilities
            .safe_add(self.num_perp_liabilities)
    }

    pub fn meets_margin_requirement(&self) -> bool {
        self.total_collateral >= self.margin_requirement as i128
    }

    pub fn positions_meets_margin_requirement(&self) -> DriftResult<bool> {
        Ok(self.total_collateral
            >= self
                .margin_requirement
                .safe_sub(self.open_orders_margin_requirement)?
                .cast::<i128>()?)
    }

    pub fn can_exit_liquidation(&self) -> DriftResult<bool> {
        if !self.is_liquidation_mode() {
            msg!("liquidation mode not enabled");
            return Err(ErrorCode::InvalidMarginCalculation);
        }

        Ok(self.total_collateral >= self.margin_requirement_plus_buffer as i128)
    }

    pub fn margin_shortage(&self) -> DriftResult<u128> {
        if self.context.margin_buffer == 0 {
            msg!("margin buffer mode not enabled");
            return Err(ErrorCode::InvalidMarginCalculation);
        }

        Ok(self
            .margin_requirement_plus_buffer
            .cast::<i128>()?
            .safe_sub(self.total_collateral)?
            .unsigned_abs())
    }

    pub fn tracked_market_margin_shortage(&self, margin_shortage: u128) -> DriftResult<u128> {
        if self.market_to_track_margin_requirement().is_none() {
            msg!("cant call tracked_market_margin_shortage");
            return Err(ErrorCode::InvalidMarginCalculation);
        }

        if self.margin_requirement == 0 {
            return Ok(0);
        }

        margin_shortage
            .safe_mul(self.tracked_market_margin_requirement)?
            .safe_div(self.margin_requirement)
    }

    pub fn get_free_collateral(&self) -> DriftResult<u128> {
        self.total_collateral
            .safe_sub(self.margin_requirement.cast::<i128>()?)?
            .max(0)
            .cast()
    }

    fn market_to_track_margin_requirement(&self) -> Option<MarketIdentifier> {
        if let MarginCalculationMode::Liquidation {
            market_to_track_margin_requirement: track_margin_requirement,
            ..
        } = self.context.mode
        {
            track_margin_requirement
        } else {
            None
        }
    }

    fn is_liquidation_mode(&self) -> bool {
        matches!(self.context.mode, MarginCalculationMode::Liquidation { .. })
    }

    pub fn track_open_orders_fraction(&self) -> bool {
        matches!(
            self.context.mode,
            MarginCalculationMode::Standard {
                track_open_orders_fraction: true
            }
        )
    }

    pub fn update_fuel_perp_bonus(
        &mut self,
        perp_market: &PerpMarket,
        perp_position: &PerpPosition,
        base_asset_value: u128,
        oracle_price: i64,
    ) -> DriftResult {
        if perp_market.fuel_boost_position == 0 {
            return Ok(());
        }

        let fuel_base_asset_value =
            if let Some((market_index, perp_delta)) = self.context.fuel_perp_delta {
                if market_index == perp_market.market_index {
                    perp_position
                        .base_asset_amount
                        .safe_add(perp_delta)?
                        .cast::<i128>()?
                        .safe_mul(oracle_price.cast()?)?
                        .safe_div(AMM_RESERVE_PRECISION_I128)?
                        .unsigned_abs()
                } else {
                    base_asset_value
                }
            } else {
                base_asset_value
            };

        let perp_fuel_oi_bonus = calculate_perp_fuel_bonus(
            perp_market,
            fuel_base_asset_value as i128,
            self.context.fuel_bonus_numerator,
        )?;

        self.fuel_positions = self
            .fuel_positions
            .saturating_add(perp_fuel_oi_bonus.cast().unwrap_or(u32::MAX));

        Ok(())
    }

    pub fn update_fuel_spot_bonus(
        &mut self,
        spot_market: &SpotMarket,
        mut signed_token_amount: i128,
        strict_price: &StrictOraclePrice,
    ) -> DriftResult {
        if spot_market.fuel_boost_deposits == 0 && spot_market.fuel_boost_borrows == 0 {
            return Ok(());
        }

        for &(market_index, delta) in &self.context.fuel_spot_deltas {
            if spot_market.market_index == market_index && delta != 0 {
                signed_token_amount = signed_token_amount.safe_add(delta)?;
            }
        }

        if spot_market.fuel_boost_deposits > 0 && signed_token_amount > 0 {
            let signed_token_value =
                get_strict_token_value(signed_token_amount, spot_market.decimals, strict_price)?;

            let fuel_bonus = calculate_spot_fuel_bonus(
                spot_market,
                signed_token_value,
                self.context.fuel_bonus_numerator,
            )?;
            self.fuel_deposits = self
                .fuel_deposits
                .saturating_add(fuel_bonus.cast().unwrap_or(u32::MAX));
        } else if spot_market.fuel_boost_borrows > 0 && signed_token_amount < 0 {
            let signed_token_value =
                get_strict_token_value(signed_token_amount, spot_market.decimals, strict_price)?;

            let fuel_bonus = calculate_spot_fuel_bonus(
                spot_market,
                signed_token_value,
                self.context.fuel_bonus_numerator,
            )?;

            self.fuel_borrows = self
                .fuel_borrows
                .saturating_add(fuel_bonus.cast().unwrap_or(u32::MAX));
        }

        Ok(())
    }
}
