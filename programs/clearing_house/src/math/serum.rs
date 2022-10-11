use solana_program::msg;

use crate::error::ClearingHouseResult;
use crate::math::casting::{cast, cast_to_u128};
use crate::math::constants::PRICE_TO_QUOTE_PRECISION_RATIO;
use crate::math_error;

// Max amount of base to put deposit into serum
pub fn calculate_serum_max_coin_qty(
    base_asset_amount: u64,
    coin_lot_size: u64,
) -> ClearingHouseResult<u64> {
    base_asset_amount
        .checked_div(coin_lot_size)
        .ok_or_else(math_error!())
}

// calculate limit price in serum lot sizes
pub fn calculate_serum_limit_price(
    limit_price: u128,
    pc_lot_size: u64,
    coin_decimals: u32,
    coin_lot_size: u64,
) -> ClearingHouseResult<u64> {
    let coin_precision = 10_u128.pow(coin_decimals);

    limit_price
        .checked_div(PRICE_TO_QUOTE_PRECISION_RATIO)
        .ok_or_else(math_error!())?
        .checked_mul(cast(coin_lot_size)?)
        .ok_or_else(math_error!())?
        .checked_div(
            cast_to_u128(pc_lot_size)?
                .checked_mul(coin_precision)
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())
        .map(|limit_price| limit_price as u64)
}

// Max amount of quote to put deposit into serum
pub fn calculate_serum_max_native_pc_quantity(
    serum_limit_price: u64,
    serum_coin_qty: u64,
    pc_lot_size: u64,
) -> ClearingHouseResult<u64> {
    pc_lot_size
        .checked_add(pc_lot_size / 2500) // max 4bps
        .ok_or_else(math_error!())?
        .checked_mul(serum_limit_price)
        .ok_or_else(math_error!())?
        .checked_mul(serum_coin_qty)
        .ok_or_else(math_error!())?
        .checked_mul(10004)
        .ok_or_else(math_error!())?
        .checked_div(10000)
        .ok_or_else(math_error!())
}

pub fn calculate_price_from_serum_limit_price(
    limit_price: u64,
    pc_lot_size: u64,
    coin_decimals: u32,
    coin_lot_size: u64,
) -> ClearingHouseResult<u128> {
    let coin_precision = 10_u128.pow(coin_decimals);

    cast_to_u128(limit_price)?
        .checked_mul(
            cast_to_u128(pc_lot_size)?
                .checked_mul(coin_precision)
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?
        .checked_mul(PRICE_TO_QUOTE_PRECISION_RATIO)
        .ok_or_else(math_error!())?
        .checked_div(cast(coin_lot_size)?)
        .ok_or_else(math_error!())
}
