use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::margin::MarginRequirementType;
use crate::math::safe_math::SafeMath;
use crate::{validate, MarketType, MARGIN_PRECISION_U128};
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
    pub with_isolated_liability: bool,
    pub total_spot_asset_value: i128,
    pub total_spot_liability_value: u128,
    pub total_perp_liability_value: u128,
    pub open_orders_margin_requirement: u128,
    tracked_market_margin_requirement: u128,
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
            with_isolated_liability: false,
            total_spot_asset_value: 0,
            total_spot_liability_value: 0,
            total_perp_liability_value: 0,
            open_orders_margin_requirement: 0,
            tracked_market_margin_requirement: 0,
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

    pub fn update_all_oracles_valid(&mut self, valid: bool) {
        self.all_oracles_valid &= valid;
    }

    pub fn update_with_isolated_liability(&mut self, isolated: bool) {
        self.with_isolated_liability &= isolated;
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
}
