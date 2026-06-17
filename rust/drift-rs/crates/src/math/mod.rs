use drift::error::ErrorCode;

use crate::{
    math::constants::{
        BASE_PRECISION, LIQUIDATION_FEE_ADJUST_GRACE_PERIOD_SLOTS,
        LIQUIDATION_FEE_INCREASE_PER_SLOT, LIQUIDATION_FEE_PRECISION_U128,
        LIQUIDATION_FEE_TO_MARGIN_PRECISION_RATIO, PRICE_PRECISION,
        PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO,
    },
    types::{
        MarginCalculationMode, MarginRequirementType, MarketIdentifier, OracleSource,
        PositionDirection, SdkError, SdkResult,
    },
};

pub mod account_list_builder;
pub mod auction;
pub mod constants;
pub mod leverage;
pub mod liquidation;
pub mod order;
pub mod tiers;

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

impl MarginContext {
    pub fn standard(margin_type: MarginRequirementType) -> Self {
        Self {
            margin_type,
            mode: MarginCalculationMode::Standard,
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
    ) -> Result<Self, ErrorCode> {
        match self.mode {
            MarginCalculationMode::Liquidation {
                market_to_track_margin_requirement: ref mut market_to_track,
                ..
            } => {
                *market_to_track = Some(market_identifier);
            }
            _ => {
                return Err(ErrorCode::InvalidMarginCalculation);
            }
        }
        Ok(self)
    }
}

/// Returns (numerator, denominator) pair to normalize prices from 2 different oracle source
fn get_oracle_normalization_factor(a: OracleSource, b: OracleSource) -> (u64, u64) {
    match (a, b) {
        // 1M scaling relationships
        (OracleSource::PythLazer, OracleSource::PythLazer1M)
        | (OracleSource::PythPull, OracleSource::Pyth1MPull) => (1_000_000, 1),
        (OracleSource::PythLazer1M, OracleSource::PythLazer)
        | (OracleSource::Pyth1MPull, OracleSource::PythPull) => (1, 1_000_000),
        // 1K scaling relationships
        (OracleSource::PythLazer, OracleSource::PythLazer1K)
        | (OracleSource::PythPull, OracleSource::Pyth1KPull) => (1_000, 1),
        (OracleSource::PythLazer1K, OracleSource::PythLazer)
        | (OracleSource::Pyth1KPull, OracleSource::PythPull) => (1, 1_000),
        _ => (1, 1),
    }
}

/// ## panics if `tick_size` is 0
#[inline]
pub fn standardize_price(price: u64, tick_size: u64, direction: PositionDirection) -> u64 {
    if price == 0 {
        return 0;
    }

    let remainder = price.rem_euclid(tick_size);

    if remainder == 0 {
        return price;
    }

    match direction {
        PositionDirection::Long => price - remainder,
        PositionDirection::Short => (price + tick_size) - remainder,
    }
}

/// ## panics if `tick_size` is 0
#[inline]
pub fn standardize_price_i64(price: i64, tick_size: u64, direction: PositionDirection) -> i64 {
    if price == 0 {
        return 0;
    }

    let remainder = price.rem_euclid(tick_size as i64);

    if remainder == 0 {
        return price;
    }

    match direction {
        PositionDirection::Long => price - remainder,
        PositionDirection::Short => (price + tick_size as i64) - remainder,
    }
}

/// ## panics if `step_size` is 0
#[inline]
pub fn standardize_base_asset_amount(base_asset_amount: u64, step_size: u64) -> u64 {
    let remainder = base_asset_amount.rem_euclid(step_size);
    base_asset_amount - remainder
}

/// ## panics if `step_size` is 0
#[inline]
pub fn standardize_base_asset_amount_ceil(base_asset_amount: u64, step_size: u64) -> u64 {
    let next_tick = (step_size.abs_diff(base_asset_amount % step_size)) % step_size;
    base_asset_amount + next_tick
}

pub fn get_liquidation_fee(
    base_liquidation_fee: u32,
    max_liquidation_fee: u32,
    last_active_user_slot: u64,
    current_slot: u64,
) -> SdkResult<u32> {
    if current_slot < last_active_user_slot {
        return Err(SdkError::MathError("slot < user.last_active_slot"));
    }
    let slots_elapsed = current_slot - last_active_user_slot;

    if slots_elapsed < LIQUIDATION_FEE_ADJUST_GRACE_PERIOD_SLOTS {
        return Ok(base_liquidation_fee);
    }

    let liquidation_fee = base_liquidation_fee
        .saturating_add((slots_elapsed * LIQUIDATION_FEE_INCREASE_PER_SLOT as u64) as u32);

    Ok(liquidation_fee.min(max_liquidation_fee))
}

pub fn calculate_base_asset_amount_to_cover_margin_shortage(
    margin_shortage: u128,
    margin_ratio: u32,
    liquidation_fee: u32,
    if_liquidation_fee: u32,
    oracle_price: i64,
    quote_oracle_price: i64,
) -> SdkResult<u64> {
    let margin_ratio = margin_ratio * LIQUIDATION_FEE_TO_MARGIN_PRECISION_RATIO;

    if oracle_price == 0 || margin_ratio <= liquidation_fee {
        return Ok(u64::MAX);
    }

    let adjusted_margin = (margin_ratio - liquidation_fee) as u128;

    let oracle_product = oracle_price as i128 * quote_oracle_price as i128;
    let price_term = (oracle_product * adjusted_margin as i128)
        / (PRICE_PRECISION as i128 * LIQUIDATION_FEE_PRECISION_U128 as i128);

    let fee_term =
        oracle_price as i128 * if_liquidation_fee as i128 / LIQUIDATION_FEE_PRECISION_U128 as i128;

    let divisor = price_term - fee_term;

    if divisor <= 0 {
        return Ok(u64::MAX);
    }

    let result =
        margin_shortage.saturating_mul(PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO) / divisor as u128;

    Ok(result as u64) // truncate at u64 max
}

pub fn calculate_perp_if_fee(
    margin_shortage: u128,
    user_base_asset_amount: u64,
    margin_ratio: u32,
    liquidator_fee: u32,
    oracle_price: i64,
    quote_oracle_price: i64,
    max_if_liquidation_fee: u32,
) -> u32 {
    if oracle_price == 0
        || quote_oracle_price == 0
        || user_base_asset_amount == 0
        || margin_ratio <= liquidator_fee
    {
        return 0;
    }

    let margin_ratio = margin_ratio * LIQUIDATION_FEE_TO_MARGIN_PRECISION_RATIO;
    let price = (oracle_price as u128 * quote_oracle_price as u128) / PRICE_PRECISION;

    // implied_if_fee = (margin_shortage / (user_base_asset_amount * price)) * scaling
    let fee_component = ((margin_shortage * BASE_PRECISION * PRICE_PRECISION)
        / ((user_base_asset_amount as u128) * price)) as u32; // cap at u32::MAX

    // implied_if_fee = (margin_ratio - liquidator_fee - fee_component) * 95%
    let implied_if_fee = margin_ratio
        .saturating_sub(liquidator_fee)
        .saturating_sub(fee_component)
        .saturating_mul(19)
        / 20;

    implied_if_fee.min(max_if_liquidation_fee)
}
