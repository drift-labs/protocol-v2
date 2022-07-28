use crate::error::ClearingHouseResult;
use crate::math::constants::{
    LIQUIDATION_FEE_PRECISION, LIQUIDATION_FEE_TO_MARGIN_PRECISION_RATIO, MARK_PRICE_PRECISION,
    MARK_PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO,
};
use crate::math_error;
use solana_program::msg;

pub fn calculate_base_asset_amount_to_remove_margin_shortage(
    margin_shortage: u128,
    margin_ratio: u32,
    liquidation_fee: u128,
    oracle_price: i128,
) -> ClearingHouseResult<u128> {
    margin_shortage
        .checked_mul(MARK_PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO)
        .ok_or_else(math_error!())?
        .checked_div(
            oracle_price
                .unsigned_abs()
                .checked_mul(
                    (margin_ratio as u128)
                        .checked_mul(LIQUIDATION_FEE_TO_MARGIN_PRECISION_RATIO)
                        .ok_or_else(math_error!())?
                        .checked_sub(liquidation_fee)
                        .unwrap_or(1),
                )
                .ok_or_else(math_error!())?
                .checked_div(LIQUIDATION_FEE_PRECISION)
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())
}

pub fn calculate_borrow_amount_to_remove_margin_shortage(
    margin_shortage: u128,
    deposit_asset_weight: u128,
    deposit_liquidation_multiplier: u128,
    borrow_liability_weight: u128,
    borrow_liquidation_multiplier: u128,
    borrow_decimals: u32,
    borrow_price: i128,
) -> ClearingHouseResult<u128> {
    let (numerator_scale, denominator_scale) = if borrow_decimals > 6 {
        (10_u128.pow((borrow_decimals - 6) as u32), 1)
    } else {
        (1, 10_u128.pow((6 - borrow_decimals) as u32))
    };

    margin_shortage
        .checked_mul(numerator_scale)
        .ok_or_else(math_error!())?
        .checked_mul(MARK_PRICE_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(
            borrow_price
                .unsigned_abs()
                .checked_mul(
                    borrow_liability_weight
                        .checked_sub(
                            deposit_asset_weight
                                .checked_mul(deposit_liquidation_multiplier)
                                .ok_or_else(math_error!())?
                                .checked_mul(borrow_liquidation_multiplier)
                                .ok_or_else(math_error!())?,
                        )
                        .ok_or_else(math_error!())?,
                )
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?
        .checked_div(denominator_scale)
        .ok_or_else(math_error!())
}

pub fn calculate_borrow_amount_for_deposit_amount(
    deposit_amount: u128,
    deposit_liquidation_multiplier: u128,
    deposit_decimals: u32,
    deposit_price: i128,
    borrow_liquidation_multiplier: u128,
    borrow_decimals: u32,
    borrow_price: i128,
) -> ClearingHouseResult<u128> {
    let (numerator_scale, denominator_scale) = if borrow_decimals > deposit_decimals {
        (10_u128.pow((borrow_decimals - deposit_decimals) as u32), 1)
    } else {
        (1, 10_u128.pow((deposit_decimals - borrow_decimals) as u32))
    };

    deposit_amount
        .checked_mul(numerator_scale)
        .ok_or_else(math_error!())?
        .checked_mul(deposit_price.unsigned_abs())
        .ok_or_else(math_error!())?
        .checked_mul(borrow_liquidation_multiplier)
        .ok_or_else(math_error!())?
        .checked_div(
            borrow_price
                .unsigned_abs()
                .checked_mul(deposit_liquidation_multiplier)
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?
        .checked_div(denominator_scale)
        .ok_or_else(math_error!())
}

pub fn calculate_deposit_amount_to_transfer(
    deposit_liquidation_multiplier: u128,
    deposit_decimals: u32,
    deposit_price: i128,
    borrow_amount: u128,
    borrow_liquidation_multiplier: u128,
    borrow_decimals: u32,
    borrow_price: i128,
) -> ClearingHouseResult<u128> {
    let (numerator_scale, denominator_scale) = if deposit_decimals > borrow_decimals {
        (10_u128.pow((deposit_decimals - borrow_decimals) as u32), 1)
    } else {
        (1, 10_u128.pow((borrow_decimals - deposit_decimals) as u32))
    };

    borrow_amount
        .checked_mul(numerator_scale)
        .ok_or_else(math_error!())?
        .checked_mul(borrow_price.unsigned_abs())
        .ok_or_else(math_error!())?
        .checked_mul(deposit_liquidation_multiplier)
        .ok_or_else(math_error!())?
        .checked_div(
            deposit_price
                .unsigned_abs()
                .checked_mul(borrow_liquidation_multiplier)
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?
        .checked_div(denominator_scale)
        .ok_or_else(math_error!())
}
