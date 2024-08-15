use crate::state::fill_mode::FillMode;
use crate::state::user::{Order, OrderType};
use crate::{PositionDirection, PRICE_PRECISION_I64, PRICE_PRECISION_U64};

#[test]
fn test() {
    let market_order = Order {
        order_type: OrderType::Market,
        direction: PositionDirection::Long,
        auction_start_price: 100 * PRICE_PRECISION_I64,
        auction_end_price: 110 * PRICE_PRECISION_I64,
        price: 120 * PRICE_PRECISION_U64,
        slot: 0,
        auction_duration: 10,
        ..Order::default()
    };

    let fill_mode = FillMode::Fill;

    let slot = 0;
    let oracle_price = Some(100 * PRICE_PRECISION_I64);
    let tick_size = 1;

    let limit_price = fill_mode
        .get_limit_price(&market_order, oracle_price, slot, tick_size, false)
        .unwrap();

    assert_eq!(limit_price, Some(100 * PRICE_PRECISION_U64));

    let place_and_take_mode = FillMode::PlaceAndTake;

    let limit_price = place_and_take_mode
        .get_limit_price(&market_order, oracle_price, slot, tick_size, false)
        .unwrap();

    assert_eq!(limit_price, Some(110 * PRICE_PRECISION_U64));

    let limit_order = Order {
        order_type: OrderType::Limit,
        direction: PositionDirection::Long,
        price: 120 * PRICE_PRECISION_U64,
        slot: 0,
        ..Order::default()
    };

    let limit_price = place_and_take_mode
        .get_limit_price(&limit_order, oracle_price, slot, tick_size, false)
        .unwrap();

    assert_eq!(limit_price, Some(120 * PRICE_PRECISION_U64));
}
