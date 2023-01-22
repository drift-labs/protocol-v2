use crate::controller::position::PositionDirection;
use crate::math::constants::{LAMPORTS_PER_SOL_U64, PRICE_PRECISION_U64};
use crate::math::serum::{
    calculate_price_from_serum_limit_price, calculate_serum_limit_price,
    calculate_serum_max_coin_qty, calculate_serum_max_native_pc_quantity,
};

#[test]
fn test_calculate_serum_max_coin_qty() {
    let base_asset_amount = LAMPORTS_PER_SOL_U64;
    let coin_lot_size = 100000000;
    let max_coin_qty = calculate_serum_max_coin_qty(base_asset_amount, coin_lot_size).unwrap();
    assert_eq!(max_coin_qty, 10)
}

#[test]
fn test_calculate_serum_limit_price_bid() {
    let limit_price = 21359900;
    let pc_lot_size = 1_u64;
    let coin_lot_size = 1000000;
    let coin_decimals = 9;

    let direction = PositionDirection::Long;
    let serum_limit_price = calculate_serum_limit_price(
        limit_price,
        pc_lot_size,
        coin_decimals,
        coin_lot_size,
        direction,
    )
    .unwrap();

    assert_eq!(serum_limit_price, 21359);
}

#[test]
fn test_calculate_serum_limit_price_ask() {
    let limit_price = 21359900;
    let pc_lot_size = 1_u64;
    let coin_lot_size = 1000000;
    let coin_decimals = 9;

    let direction = PositionDirection::Short;
    let serum_limit_price = calculate_serum_limit_price(
        limit_price,
        pc_lot_size,
        coin_decimals,
        coin_lot_size,
        direction,
    )
    .unwrap();

    assert_eq!(serum_limit_price, 21360);
}

#[test]
fn test_calculate_serum_max_native_pc_quantity() {
    let serum_limit_price = 100000_u64;
    let serum_coin_qty = 10;
    let pc_lot_size = 100_u64;

    let max_native_pc_quantity =
        calculate_serum_max_native_pc_quantity(serum_limit_price, serum_coin_qty, pc_lot_size)
            .unwrap();

    assert_eq!(max_native_pc_quantity, 100040000); // $100.04
}

#[test]
fn test_calculate_price_from_serum_limit_price() {
    let serum_limit_price = 100000_u64;
    let pc_lot_size = 100_u64;
    let coin_lot_size = 100000000;
    let coin_decimals = 9;

    let price = calculate_price_from_serum_limit_price(
        serum_limit_price,
        pc_lot_size,
        coin_decimals,
        coin_lot_size,
    )
    .unwrap();

    assert_eq!(price, 100 * PRICE_PRECISION_U64);
}
