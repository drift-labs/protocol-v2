use crate::controller::position::PositionDirection;
use crate::math::constants::{PRICE_PRECISION, PRICE_PRECISION_I128};
use crate::math::matching::*;

#[test]
fn filler_multiplier_maker_long() {
    let direction = PositionDirection::Long;
    let oracle_price = 34 * PRICE_PRECISION_I128;

    let mult = calculate_filler_multiplier_for_matched_orders(
        oracle_price as u128,
        direction,
        oracle_price,
    )
    .unwrap();
    assert_eq!(mult, 2000); // 2x

    let mult = calculate_filler_multiplier_for_matched_orders(
        (oracle_price - oracle_price / 10000) as u128, // barely bad 1 bp
        direction,
        oracle_price,
    )
    .unwrap();

    assert_eq!(mult, 1900); // 1.9x

    let maker_price_bad = 30 * PRICE_PRECISION;
    let maker_price_good = 40 * PRICE_PRECISION;

    let mult =
        calculate_filler_multiplier_for_matched_orders(maker_price_good, direction, oracle_price)
            .unwrap();

    assert_eq!(mult, 100000); // 100x

    let mult =
        calculate_filler_multiplier_for_matched_orders(maker_price_bad, direction, oracle_price)
            .unwrap();

    assert_eq!(mult, 1000); // 1x
}

#[test]
fn filler_multiplier_maker_short() {
    let direction = PositionDirection::Short;
    let oracle_price = 34 * PRICE_PRECISION_I128;

    let maker_price_good = 30 * PRICE_PRECISION;
    let maker_price_bad = 40 * PRICE_PRECISION;

    let mult =
        calculate_filler_multiplier_for_matched_orders(maker_price_good, direction, oracle_price)
            .unwrap();

    assert_eq!(mult, 100000);

    let mult =
        calculate_filler_multiplier_for_matched_orders(maker_price_bad, direction, oracle_price)
            .unwrap();

    assert_eq!(mult, 1000);

    let mult = calculate_filler_multiplier_for_matched_orders(
        (oracle_price + oracle_price / 10000) as u128, // barely bad 1 bp
        direction,
        oracle_price,
    )
    .unwrap();

    assert_eq!(mult, 1900); // 1.9x

    let mult = calculate_filler_multiplier_for_matched_orders(
        (oracle_price - oracle_price / 10000) as u128, // barely good 1 bp
        direction,
        oracle_price,
    )
    .unwrap();

    assert_eq!(mult, 2100); // 2.1x
}
