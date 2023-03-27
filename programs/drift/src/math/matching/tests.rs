use crate::controller::position::PositionDirection;
use crate::math::constants::{PRICE_PRECISION_I64, PRICE_PRECISION_U64};
use crate::math::matching::*;

mod is_maker_for_taker {
    use crate::math::matching::is_maker_for_taker;
    use crate::state::user::{Order, OrderType};

    #[test]
    fn taker_is_post_only() {
        let taker = Order {
            post_only: true,
            ..Default::default()
        };
        let maker = Order {
            post_only: false,
            ..Default::default()
        };
        assert_eq!(is_maker_for_taker(&maker, &taker, 0).unwrap(), false);
    }

    #[test]
    fn maker_is_market_order() {
        let taker = Order {
            post_only: false,
            order_type: OrderType::Market,
            ..Default::default()
        };
        let maker = Order {
            post_only: false,
            order_type: OrderType::Market,
            ..Default::default()
        };
        assert_eq!(is_maker_for_taker(&maker, &taker, 0).unwrap(), false);
    }

    #[test]
    fn maker_is_limit_order_in_auction() {
        // market order
        let taker = Order {
            post_only: false,
            order_type: OrderType::Market,
            ..Default::default()
        };
        let maker = Order {
            post_only: false,
            order_type: OrderType::Limit,
            auction_duration: 10,
            slot: 0,
            ..Default::default()
        };
        assert_eq!(is_maker_for_taker(&maker, &taker, 0).unwrap(), false);

        // limit order in auction
        let taker = Order {
            post_only: false,
            order_type: OrderType::Limit,
            auction_duration: 10,
            ..Default::default()
        };
        assert_eq!(is_maker_for_taker(&maker, &taker, 0).unwrap(), false);
    }

    #[test]
    fn maker_is_post_only() {
        let slot = 1;
        // market order
        let taker = Order {
            post_only: false,
            order_type: OrderType::Market,
            slot: slot - 1,
            ..Default::default()
        };
        let maker = Order {
            post_only: true,
            order_type: OrderType::Limit,
            slot: slot - 1,
            ..Default::default()
        };
        assert_eq!(is_maker_for_taker(&maker, &taker, slot).unwrap(), true);

        // limit order in auction
        let taker = Order {
            post_only: false,
            order_type: OrderType::Limit,
            auction_duration: 10,
            slot: slot - 1,
            ..Default::default()
        };
        assert_eq!(is_maker_for_taker(&maker, &taker, slot).unwrap(), true);
    }

    #[test]
    fn maker_is_resting_limit_order_after_auction() {
        // market order
        let taker = Order {
            post_only: false,
            order_type: OrderType::Market,
            ..Default::default()
        };
        let maker = Order {
            post_only: false,
            order_type: OrderType::Limit,
            auction_duration: 10,
            ..Default::default()
        };
        let slot = 11;
        assert_eq!(maker.is_resting_limit_order(slot).unwrap(), true);
        assert_eq!(is_maker_for_taker(&maker, &taker, slot).unwrap(), true);

        // limit order in auction
        let taker = Order {
            post_only: false,
            order_type: OrderType::Limit,
            slot,
            auction_duration: 10,
            ..Default::default()
        };
        assert_eq!(taker.is_resting_limit_order(slot).unwrap(), false);
        assert_eq!(is_maker_for_taker(&maker, &taker, slot).unwrap(), true);
    }

    #[test]
    fn maker_is_post_only_for_resting_taker_limit() {
        let slot = 11;

        let taker = Order {
            post_only: false,
            order_type: OrderType::Limit,
            slot: 0,
            auction_duration: 10,
            ..Default::default()
        };
        assert_eq!(taker.is_resting_limit_order(slot).unwrap(), true);

        let maker = Order {
            slot: 1,
            post_only: true,
            order_type: OrderType::Limit,
            ..Default::default()
        };
        assert_eq!(is_maker_for_taker(&maker, &taker, slot).unwrap(), true);
    }

    #[test]
    fn maker_and_taker_resting_limit_orders() {
        let slot = 15;

        let taker = Order {
            post_only: false,
            order_type: OrderType::Limit,
            slot: 0,
            auction_duration: 10,
            ..Default::default()
        };
        assert_eq!(taker.is_resting_limit_order(slot).unwrap(), true);

        let maker = Order {
            post_only: false,
            order_type: OrderType::Limit,
            slot: 1,
            auction_duration: 10,
            ..Default::default()
        };
        assert_eq!(taker.is_resting_limit_order(slot).unwrap(), true);

        assert_eq!(is_maker_for_taker(&maker, &taker, slot).unwrap(), false);

        let taker = Order {
            post_only: false,
            order_type: OrderType::Limit,
            slot: 2,
            auction_duration: 10,
            ..Default::default()
        };
        assert_eq!(taker.is_resting_limit_order(slot).unwrap(), true);

        assert_eq!(is_maker_for_taker(&maker, &taker, slot).unwrap(), true);
    }
}

#[test]
fn filler_multiplier_maker_long() {
    let direction = PositionDirection::Long;
    let oracle_price = 34 * PRICE_PRECISION_I64;

    let mult = calculate_filler_multiplier_for_matched_orders(
        oracle_price as u64,
        direction,
        oracle_price,
    )
    .unwrap();
    assert_eq!(mult, 2000); // 2x

    let mult = calculate_filler_multiplier_for_matched_orders(
        (oracle_price - oracle_price / 10000) as u64, // barely bad 1 bp
        direction,
        oracle_price,
    )
    .unwrap();

    assert_eq!(mult, 1900); // 1.9x

    let maker_price_bad = 30 * PRICE_PRECISION_U64;
    let maker_price_good = 40 * PRICE_PRECISION_U64;

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
    let oracle_price = 34 * PRICE_PRECISION_I64;

    let maker_price_good = 30 * PRICE_PRECISION_U64;
    let maker_price_bad = 40 * PRICE_PRECISION_U64;

    let mult =
        calculate_filler_multiplier_for_matched_orders(maker_price_good, direction, oracle_price)
            .unwrap();

    assert_eq!(mult, 100000);

    let mult =
        calculate_filler_multiplier_for_matched_orders(maker_price_bad, direction, oracle_price)
            .unwrap();

    assert_eq!(mult, 1000);

    let mult = calculate_filler_multiplier_for_matched_orders(
        (oracle_price + oracle_price / 10000) as u64, // barely bad 1 bp
        direction,
        oracle_price,
    )
    .unwrap();

    assert_eq!(mult, 1900); // 1.9x

    let mult = calculate_filler_multiplier_for_matched_orders(
        (oracle_price - oracle_price / 10000) as u64, // barely good 1 bp
        direction,
        oracle_price,
    )
    .unwrap();

    assert_eq!(mult, 2100); // 2.1x
}
