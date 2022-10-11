pub mod standardize_base_asset_amount_with_remainder_i128 {
    use crate::math::orders::standardize_base_asset_amount_with_remainder_i128;

    #[test]
    fn negative_remainder_greater_than_step() {
        let baa = -90;
        let step_size = 50;

        let (s_baa, rem) =
            standardize_base_asset_amount_with_remainder_i128(baa, step_size).unwrap();

        assert_eq!(s_baa, -50); // reduced to 50 short position
        assert_eq!(rem, -40); // 40 short left over
    }

    #[test]
    fn negative_remainder_smaller_than_step() {
        let baa = -20;
        let step_size = 50;

        let (s_baa, rem) =
            standardize_base_asset_amount_with_remainder_i128(baa, step_size).unwrap();

        assert_eq!(s_baa, 0);
        assert_eq!(rem, -20);
    }

    #[test]
    fn positive_remainder_greater_than_step() {
        let baa = 90;
        let step_size = 50;

        let (s_baa, rem) =
            standardize_base_asset_amount_with_remainder_i128(baa, step_size).unwrap();

        assert_eq!(s_baa, 50); // reduced to 50 long position
        assert_eq!(rem, 40); // 40 long left over
    }

    #[test]
    fn positive_remainder_smaller_than_step() {
        let baa = 20;
        let step_size = 50;

        let (s_baa, rem) =
            standardize_base_asset_amount_with_remainder_i128(baa, step_size).unwrap();

        assert_eq!(s_baa, 0);
        assert_eq!(rem, 20);
    }

    #[test]
    fn no_remainder() {
        let baa = 100;
        let step_size = 50;

        let (s_baa, rem) =
            standardize_base_asset_amount_with_remainder_i128(baa, step_size).unwrap();

        assert_eq!(s_baa, 100);
        assert_eq!(rem, 0);
    }
}
// baa = -90
// remainder = -40
// baa -= remainder (baa = -50)

// trades +100
// stepsize of 50
// amm = 10 lp = 90
// net_baa = 10
// market_baa = -10
// lp burns => metrics_baa: -90
// standardize => baa = -50 (round down (+40))
// amm_net_baa = 10 + (-40)
// amm_baa = 10 + 40 = 50

pub mod standardize_base_asset_amount {
    use crate::math::orders::standardize_base_asset_amount;

    #[test]
    fn remainder_less_than_half_minimum_size() {
        let base_asset_amount: u64 = 200001;
        let minimum_size: u64 = 100000;

        let result = standardize_base_asset_amount(base_asset_amount, minimum_size).unwrap();

        assert_eq!(result, 200000);
    }

    #[test]
    fn remainder_more_than_half_minimum_size() {
        let base_asset_amount: u64 = 250001;
        let minimum_size: u64 = 100000;

        let result = standardize_base_asset_amount(base_asset_amount, minimum_size).unwrap();

        assert_eq!(result, 200000);
    }

    #[test]
    fn zero() {
        let base_asset_amount: u64 = 0;
        let minimum_size: u64 = 100000;

        let result = standardize_base_asset_amount(base_asset_amount, minimum_size).unwrap();

        assert_eq!(result, 0);
    }
}

mod is_order_risk_increase {
    use crate::controller::position::PositionDirection;
    use crate::math::constants::{BASE_PRECISION_I64, BASE_PRECISION_U64};
    use crate::math::orders::is_order_risk_decreasing;

    #[test]
    fn no_position() {
        let order_direction = PositionDirection::Long;
        let order_base_asset_amount = BASE_PRECISION_U64;
        let existing_position = 0;

        let risk_decreasing =
            is_order_risk_decreasing(&order_direction, order_base_asset_amount, existing_position)
                .unwrap();

        assert!(!risk_decreasing);

        let order_direction = PositionDirection::Short;
        let risk_decreasing =
            is_order_risk_decreasing(&order_direction, order_base_asset_amount, existing_position)
                .unwrap();

        assert!(!risk_decreasing);
    }

    #[test]
    fn bid() {
        // user long and bid
        let order_direction = PositionDirection::Long;
        let order_base_asset_amount = BASE_PRECISION_U64;
        let existing_position = BASE_PRECISION_I64;
        let risk_decreasing =
            is_order_risk_decreasing(&order_direction, order_base_asset_amount, existing_position)
                .unwrap();

        assert!(!risk_decreasing);

        // user short and bid < 2 * position
        let existing_position = -BASE_PRECISION_I64;
        let risk_decreasing =
            is_order_risk_decreasing(&order_direction, order_base_asset_amount, existing_position)
                .unwrap();

        assert!(risk_decreasing);

        // user short and bid = 2 * position
        let existing_position = -BASE_PRECISION_I64 / 2;
        let risk_decreasing =
            is_order_risk_decreasing(&order_direction, order_base_asset_amount, existing_position)
                .unwrap();

        assert!(!risk_decreasing);
    }

    #[test]
    fn ask() {
        // user short and ask
        let order_direction = PositionDirection::Short;
        let order_base_asset_amount = BASE_PRECISION_U64;
        let existing_position = -BASE_PRECISION_I64;

        let risk_decreasing =
            is_order_risk_decreasing(&order_direction, order_base_asset_amount, existing_position)
                .unwrap();

        assert!(!risk_decreasing);

        // user long and ask < 2 * position
        let existing_position = BASE_PRECISION_I64;
        let risk_decreasing =
            is_order_risk_decreasing(&order_direction, order_base_asset_amount, existing_position)
                .unwrap();

        assert!(risk_decreasing);

        // user long and ask = 2 * position
        let existing_position = BASE_PRECISION_I64 / 2;
        let risk_decreasing =
            is_order_risk_decreasing(&order_direction, order_base_asset_amount, existing_position)
                .unwrap();

        assert!(!risk_decreasing);
    }
}

mod order_breaches_oracle_price_limits {
    use crate::controller::position::PositionDirection;
    use crate::math::constants::{MARGIN_PRECISION, PRICE_PRECISION_I128, PRICE_PRECISION_U64};
    use crate::math::orders::order_breaches_oracle_price_limits;
    use crate::state::perp_market::PerpMarket;
    use crate::state::user::Order;

    #[test]
    fn bid_does_not_breach() {
        let _market = PerpMarket {
            margin_ratio_initial: (MARGIN_PRECISION / 10) as u32, // 10x
            ..PerpMarket::default()
        };

        let order = Order {
            price: 101 * PRICE_PRECISION_U64,
            ..Order::default()
        };

        let oracle_price = 100 * PRICE_PRECISION_I128;

        let slot = 0;
        let tick_size = 1;

        let margin_ratio_initial = MARGIN_PRECISION / 10;
        let margin_ratio_maintenance = MARGIN_PRECISION / 20;
        let result = order_breaches_oracle_price_limits(
            &order,
            oracle_price,
            slot,
            tick_size,
            margin_ratio_initial,
            margin_ratio_maintenance,
            None,
        )
        .unwrap();

        assert!(!result)
    }

    #[test]
    fn bid_does_not_breach_4_99_percent_move() {
        let _market = PerpMarket {
            margin_ratio_initial: (MARGIN_PRECISION / 10) as u32, // 10x
            ..PerpMarket::default()
        };

        let order = Order {
            price: 105 * PRICE_PRECISION_U64 - 1,
            ..Order::default()
        };

        let oracle_price = 100 * PRICE_PRECISION_I128;

        let slot = 0;
        let tick_size = 1;

        let margin_ratio_initial = MARGIN_PRECISION / 10;
        let margin_ratio_maintenance = MARGIN_PRECISION / 20;
        let result = order_breaches_oracle_price_limits(
            &order,
            oracle_price,
            slot,
            tick_size,
            margin_ratio_initial,
            margin_ratio_maintenance,
            None,
        )
        .unwrap();

        assert!(!result)
    }

    #[test]
    fn bid_breaches() {
        let _market = PerpMarket {
            margin_ratio_initial: (MARGIN_PRECISION / 10) as u32, // 10x
            margin_ratio_maintenance: (MARGIN_PRECISION / 20) as u32, // 20x
            ..PerpMarket::default()
        };

        let order = Order {
            direction: PositionDirection::Long,
            price: 105 * PRICE_PRECISION_U64,
            ..Order::default()
        };

        let oracle_price = 100 * PRICE_PRECISION_I128;

        let slot = 0;
        let tick_size = 1;

        let margin_ratio_initial = MARGIN_PRECISION / 10;
        let margin_ratio_maintenance = MARGIN_PRECISION / 20;
        let result = order_breaches_oracle_price_limits(
            &order,
            oracle_price,
            slot,
            tick_size,
            margin_ratio_initial,
            margin_ratio_maintenance,
            None,
        )
        .unwrap();

        assert!(result)
    }

    #[test]
    fn ask_does_not_breach() {
        let _market = PerpMarket {
            margin_ratio_initial: (MARGIN_PRECISION / 10) as u32, // 10x
            margin_ratio_maintenance: (MARGIN_PRECISION / 20) as u32, // 20x
            ..PerpMarket::default()
        };

        let order = Order {
            direction: PositionDirection::Short,
            price: 99 * PRICE_PRECISION_U64,
            ..Order::default()
        };

        let oracle_price = 100 * PRICE_PRECISION_I128;

        let slot = 0;
        let tick_size = 1;

        let margin_ratio_initial = MARGIN_PRECISION / 10;
        let margin_ratio_maintenance = MARGIN_PRECISION / 20;
        let result = order_breaches_oracle_price_limits(
            &order,
            oracle_price,
            slot,
            tick_size,
            margin_ratio_initial,
            margin_ratio_maintenance,
            None,
        )
        .unwrap();

        assert!(!result)
    }

    #[test]
    fn ask_does_not_breach_4_99_percent_move() {
        let _market = PerpMarket {
            margin_ratio_initial: (MARGIN_PRECISION / 10) as u32, // 10x
            margin_ratio_maintenance: (MARGIN_PRECISION / 20) as u32, // 20x
            ..PerpMarket::default()
        };

        let order = Order {
            direction: PositionDirection::Short,
            price: 95 * PRICE_PRECISION_U64 + 1,
            ..Order::default()
        };

        let oracle_price = 100 * PRICE_PRECISION_I128;

        let slot = 0;
        let tick_size = 1;

        let margin_ratio_initial = MARGIN_PRECISION / 10;
        let margin_ratio_maintenance = MARGIN_PRECISION / 20;
        let result = order_breaches_oracle_price_limits(
            &order,
            oracle_price,
            slot,
            tick_size,
            margin_ratio_initial,
            margin_ratio_maintenance,
            None,
        )
        .unwrap();

        assert!(!result)
    }

    #[test]
    fn ask_breaches() {
        let _market = PerpMarket {
            margin_ratio_initial: (MARGIN_PRECISION / 10) as u32, // 10x
            margin_ratio_maintenance: (MARGIN_PRECISION / 20) as u32, // 20x
            ..PerpMarket::default()
        };

        let order = Order {
            direction: PositionDirection::Short,
            price: 95 * PRICE_PRECISION_U64,
            ..Order::default()
        };

        let oracle_price = 100 * PRICE_PRECISION_I128;

        let slot = 0;
        let tick_size = 1;

        let margin_ratio_initial = MARGIN_PRECISION / 10;
        let margin_ratio_maintenance = MARGIN_PRECISION / 20;
        let result = order_breaches_oracle_price_limits(
            &order,
            oracle_price,
            slot,
            tick_size,
            margin_ratio_initial,
            margin_ratio_maintenance,
            None,
        )
        .unwrap();

        assert!(result)
    }
}
