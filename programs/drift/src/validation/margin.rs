use crate::error::{DriftResult, ErrorCode};
use crate::math::constants::{
    LIQUIDATION_FEE_TO_MARGIN_PRECISION_RATIO, MAX_MARGIN_RATIO, MIN_MARGIN_RATIO,
    SPOT_IMF_PRECISION, SPOT_WEIGHT_PRECISION,
};
use crate::validate;
use solana_program::msg;

pub fn validate_margin(
    margin_ratio_initial: u32,
    margin_ratio_maintenance: u32,
    liquidation_fee: u32,
    max_spread: u32,
) -> DriftResult {
    if !(MIN_MARGIN_RATIO..=MAX_MARGIN_RATIO).contains(&margin_ratio_initial) {
        return Err(ErrorCode::InvalidMarginRatio);
    }

    if margin_ratio_initial <= margin_ratio_maintenance {
        return Err(ErrorCode::InvalidMarginRatio);
    }

    if !(MIN_MARGIN_RATIO..=MAX_MARGIN_RATIO).contains(&margin_ratio_maintenance) {
        return Err(ErrorCode::InvalidMarginRatio);
    }

    validate!(
        margin_ratio_maintenance * LIQUIDATION_FEE_TO_MARGIN_PRECISION_RATIO > liquidation_fee,
        ErrorCode::InvalidMarginRatio,
        "margin_ratio_maintenance must be greater than liquidation fee"
    )?;

    validate!(
        margin_ratio_initial * 100 > max_spread,
        ErrorCode::InvalidMarginRatio,
        "margin_ratio_initial must be greater than max_spread (or must lower max_spread first)"
    )?;

    Ok(())
}

pub fn validate_margin_weights(
    spot_market_index: u16,
    initial_asset_weight: u32,
    maintenance_asset_weight: u32,
    initial_liability_weight: u32,
    maintenance_liability_weight: u32,
    imf_factor: u32,
) -> DriftResult {
    if spot_market_index == 0 {
        validate!(
            initial_asset_weight == SPOT_WEIGHT_PRECISION,
            ErrorCode::InvalidSpotMarketInitialization,
            "For quote asset spot market, initial asset weight must be {}",
            SPOT_WEIGHT_PRECISION
        )?;

        validate!(
            maintenance_asset_weight == SPOT_WEIGHT_PRECISION,
            ErrorCode::InvalidSpotMarketInitialization,
            "For quote asset spot market, maintenance asset weight must be {}",
            SPOT_WEIGHT_PRECISION
        )?;

        validate!(
            initial_liability_weight == SPOT_WEIGHT_PRECISION,
            ErrorCode::InvalidSpotMarketInitialization,
            "For quote asset spot market, initial liability weight must be {}",
            SPOT_WEIGHT_PRECISION
        )?;

        validate!(
            maintenance_liability_weight == SPOT_WEIGHT_PRECISION,
            ErrorCode::InvalidSpotMarketInitialization,
            "For quote asset spot market, maintenance liability weight must be {}",
            SPOT_WEIGHT_PRECISION
        )?;
    } else {
        validate!(
            initial_asset_weight < SPOT_WEIGHT_PRECISION,
            ErrorCode::InvalidSpotMarketInitialization,
            "Initial asset weight must be less than {}",
            SPOT_WEIGHT_PRECISION
        )?;

        validate!(
            initial_asset_weight <= maintenance_asset_weight
                && maintenance_asset_weight > 0
                && maintenance_asset_weight < SPOT_WEIGHT_PRECISION,
            ErrorCode::InvalidSpotMarketInitialization,
            "Maintenance asset weight must be between 0 {}",
            SPOT_WEIGHT_PRECISION
        )?;

        validate!(
            initial_liability_weight > SPOT_WEIGHT_PRECISION,
            ErrorCode::InvalidSpotMarketInitialization,
            "Initial liability weight must be greater than {}",
            SPOT_WEIGHT_PRECISION
        )?;

        validate!(
            initial_liability_weight >= maintenance_liability_weight
                && maintenance_liability_weight > SPOT_WEIGHT_PRECISION,
            ErrorCode::InvalidSpotMarketInitialization,
            "Maintenance liability weight must be greater than {}",
            SPOT_WEIGHT_PRECISION
        )?;
    }

    validate!(
        imf_factor < SPOT_IMF_PRECISION,
        ErrorCode::InvalidSpotMarketInitialization,
        "imf_factor={} must be less than SPOT_IMF_PRECISION={}",
        imf_factor,
        SPOT_IMF_PRECISION,
    )?;

    Ok(())
}
