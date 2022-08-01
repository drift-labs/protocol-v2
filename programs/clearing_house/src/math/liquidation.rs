use crate::error::ClearingHouseResult;
use crate::math::constants::{
    BANK_WEIGHT_PRECISION, LIQUIDATION_FEE_PRECISION, LIQUIDATION_FEE_TO_MARGIN_PRECISION_RATIO,
    MARK_PRICE_PRECISION, MARK_PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO,
};
use crate::math_error;
use solana_program::msg;

#[cfg(test)]
mod tests;

pub fn calculate_base_asset_amount_to_cover_margin_shortage(
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
                        .ok_or_else(math_error!())?,
                )
                .ok_or_else(math_error!())?
                .checked_div(LIQUIDATION_FEE_PRECISION)
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())
}

pub fn calculate_liability_transfer_to_cover_margin_shortage(
    margin_shortage: u128,
    asset_weight: u128,
    asset_liquidation_multiplier: u128,
    liability_weight: u128,
    liability_liquidation_multiplier: u128,
    liability_decimals: u8,
    liability_price: i128,
) -> ClearingHouseResult<u128> {
    let (numerator_scale, denominator_scale) = if liability_decimals > 6 {
        (10_u128.pow((liability_decimals - 6) as u32), 1)
    } else {
        (1, 10_u128.pow((6 - liability_decimals) as u32))
    };

    margin_shortage
        .checked_mul(numerator_scale)
        .ok_or_else(math_error!())?
        .checked_mul(MARK_PRICE_PRECISION * BANK_WEIGHT_PRECISION * 1000)
        .ok_or_else(math_error!())?
        .checked_div(
            liability_price
                .unsigned_abs()
                .checked_mul(
                    liability_weight
                        .checked_mul(1000) // multiply bank weights by extra 1000 to increase precision
                        .ok_or_else(math_error!())?
                        .checked_sub(
                            asset_weight
                                .checked_mul(1000)
                                .ok_or_else(math_error!())?
                                .checked_mul(asset_liquidation_multiplier)
                                .ok_or_else(math_error!())?
                                .checked_div(liability_liquidation_multiplier)
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

pub fn calculate_liability_transfer_implied_by_asset_amount(
    asset_amount: u128,
    asset_liquidation_multiplier: u128,
    asset_decimals: u8,
    asset_price: i128,
    liability_liquidation_multiplier: u128,
    liability_decimals: u8,
    liability_price: i128,
) -> ClearingHouseResult<u128> {
    let (numerator_scale, denominator_scale) = if liability_decimals > asset_decimals {
        (10_u128.pow((liability_decimals - asset_decimals) as u32), 1)
    } else {
        (1, 10_u128.pow((asset_decimals - liability_decimals) as u32))
    };

    asset_amount
        .checked_mul(numerator_scale)
        .ok_or_else(math_error!())?
        .checked_mul(asset_price.unsigned_abs())
        .ok_or_else(math_error!())?
        .checked_mul(liability_liquidation_multiplier)
        .ok_or_else(math_error!())?
        .checked_div(
            liability_price
                .unsigned_abs()
                .checked_mul(asset_liquidation_multiplier)
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?
        .checked_div(denominator_scale)
        .ok_or_else(math_error!())
}

pub fn calculate_asset_transfer_for_liability_transfer(
    asset_liquidation_multiplier: u128,
    asset_decimals: u8,
    asset_price: i128,
    liability_amount: u128,
    liability_liquidation_multiplier: u128,
    liability_decimals: u8,
    liability_price: i128,
) -> ClearingHouseResult<u128> {
    let (numerator_scale, denominator_scale) = if asset_decimals > liability_decimals {
        (10_u128.pow((asset_decimals - liability_decimals) as u32), 1)
    } else {
        (1, 10_u128.pow((liability_decimals - asset_decimals) as u32))
    };

    liability_amount
        .checked_mul(numerator_scale)
        .ok_or_else(math_error!())?
        .checked_mul(liability_price.unsigned_abs())
        .ok_or_else(math_error!())?
        .checked_mul(asset_liquidation_multiplier)
        .ok_or_else(math_error!())?
        .checked_div(
            asset_price
                .unsigned_abs()
                .checked_mul(liability_liquidation_multiplier)
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?
        .checked_div(denominator_scale)
        .ok_or_else(math_error!())
}
