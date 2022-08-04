use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::constants::{
    LIQUIDATION_FEE_TO_MARGIN_PRECISION_RATIO, MAXIMUM_MARGIN_RATIO, MINIMUM_MARGIN_RATIO,
};
use crate::validate;
use solana_program::msg;

pub fn validate_margin(
    margin_ratio_initial: u32,
    margin_ratio_maintenance: u32,
    liquidation_fee: u128,
) -> ClearingHouseResult {
    if !(MINIMUM_MARGIN_RATIO..=MAXIMUM_MARGIN_RATIO).contains(&margin_ratio_initial) {
        return Err(ErrorCode::InvalidMarginRatio);
    }

    if margin_ratio_initial < margin_ratio_maintenance {
        return Err(ErrorCode::InvalidMarginRatio);
    }

    if !(MINIMUM_MARGIN_RATIO..=MAXIMUM_MARGIN_RATIO).contains(&margin_ratio_maintenance) {
        return Err(ErrorCode::InvalidMarginRatio);
    }

    validate!(
        (margin_ratio_maintenance as u128) * LIQUIDATION_FEE_TO_MARGIN_PRECISION_RATIO
            > liquidation_fee,
        ErrorCode::InvalidMarginRatio,
        "margin_ratio_maintenance must be greater than liquidation fee"
    )?;

    Ok(())
}
