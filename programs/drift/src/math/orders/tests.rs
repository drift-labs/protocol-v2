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
    use crate::math::constants::{MARGIN_PRECISION, PRICE_PRECISION_I64, PRICE_PRECISION_U64};
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

        let oracle_price = 100 * PRICE_PRECISION_I64;

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

        let oracle_price = 100 * PRICE_PRECISION_I64;

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

        let oracle_price = 100 * PRICE_PRECISION_I64;

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

        let oracle_price = 100 * PRICE_PRECISION_I64;

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

        let oracle_price = 100 * PRICE_PRECISION_I64;

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

        let oracle_price = 100 * PRICE_PRECISION_I64;

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
        )
        .unwrap();

        assert!(result)
    }
}

mod should_expire_order {
    use crate::math::orders::should_expire_order;
    use crate::state::user::{Order, OrderStatus, OrderType, User};
    use crate::test_utils::get_orders;

    #[test]
    fn max_ts_is_zero() {
        let user = User {
            orders: get_orders(Order {
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                max_ts: 0,
                ..Order::default()
            }),
            ..User::default()
        };

        let now = 100;

        let is_expired = should_expire_order(&user, 0, now).unwrap();

        assert!(!is_expired);
    }

    #[test]
    fn max_ts_is_greater_than_now() {
        let user = User {
            orders: get_orders(Order {
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                max_ts: 101,
                ..Order::default()
            }),
            ..User::default()
        };

        let now = 100;

        let is_expired = should_expire_order(&user, 0, now).unwrap();

        assert!(!is_expired);
    }

    #[test]
    fn max_ts_is_less_than_now() {
        let user = User {
            orders: get_orders(Order {
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                max_ts: 99,
                ..Order::default()
            }),
            ..User::default()
        };

        let now = 100;

        let is_expired = should_expire_order(&user, 0, now).unwrap();

        assert!(is_expired);
    }

    #[test]
    fn order_is_not_open() {
        let user = User {
            orders: get_orders(Order {
                status: OrderStatus::Init,
                order_type: OrderType::Limit,
                max_ts: 99,
                ..Order::default()
            }),
            ..User::default()
        };

        let now = 100;

        let is_expired = should_expire_order(&user, 0, now).unwrap();

        assert!(!is_expired);
    }

    #[test]
    fn order_is_trigger_market_order() {
        let user = User {
            orders: get_orders(Order {
                status: OrderStatus::Open,
                order_type: OrderType::TriggerMarket,
                max_ts: 99,
                ..Order::default()
            }),
            ..User::default()
        };

        let now = 100;

        let is_expired = should_expire_order(&user, 0, now).unwrap();

        assert!(!is_expired);
    }

    #[test]
    fn order_is_trigger_limit_order() {
        let user = User {
            orders: get_orders(Order {
                status: OrderStatus::Open,
                order_type: OrderType::TriggerLimit,
                max_ts: 99,
                ..Order::default()
            }),
            ..User::default()
        };

        let now = 100;

        let is_expired = should_expire_order(&user, 0, now).unwrap();

        assert!(!is_expired);
    }
}

mod get_max_fill_amounts {
    use crate::controller::position::PositionDirection;
    use crate::math::constants::{
        LAMPORTS_PER_SOL_I64, QUOTE_PRECISION_U64, SPOT_BALANCE_PRECISION,
        SPOT_BALANCE_PRECISION_U64,
    };
    use crate::math::orders::get_max_fill_amounts;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::user::{Order, SpotPosition, User};
    use crate::test_utils::get_orders;
    use anchor_spl::token::spl_token::solana_program::native_token::LAMPORTS_PER_SOL;

    #[test]
    fn fully_collateralized_selling_base() {
        let base_market = SpotMarket::default_base_market();
        let quote_market = SpotMarket::default_quote_market();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            open_asks: -100 * LAMPORTS_PER_SOL_I64,
            open_orders: 1,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };

        let user = User {
            spot_positions,
            orders: get_orders(Order {
                direction: PositionDirection::Short,
                base_asset_amount: 100 * LAMPORTS_PER_SOL,
                ..Order::default()
            }),
            ..User::default()
        };

        let (max_base, max_quote) =
            get_max_fill_amounts(&user, 0, &base_market, &quote_market).unwrap();

        assert_eq!(max_base, Some(100 * LAMPORTS_PER_SOL));
        assert_eq!(max_quote, None);
    }

    #[test]
    fn selling_base_with_borrow_and_no_borrow_liquidity() {
        let base_market = SpotMarket::default_base_market();
        let quote_market = SpotMarket::default_quote_market();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            open_asks: -100 * LAMPORTS_PER_SOL_I64,
            open_orders: 1,
            balance_type: SpotBalanceType::Borrow,
            ..SpotPosition::default()
        };

        let user = User {
            spot_positions,
            orders: get_orders(Order {
                direction: PositionDirection::Short,
                base_asset_amount: 100 * LAMPORTS_PER_SOL,
                ..Order::default()
            }),
            ..User::default()
        };

        let (max_base, max_quote) =
            get_max_fill_amounts(&user, 0, &base_market, &quote_market).unwrap();

        assert_eq!(max_base, Some(0));
        assert_eq!(max_quote, None);
    }

    #[test]
    fn selling_base_with_borrow_liquidity_greater_than_order() {
        let base_market = SpotMarket {
            deposit_balance: 100 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_base_market()
        };
        let quote_market = SpotMarket::default_quote_market();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            scaled_balance: 0,
            open_asks: -100 * LAMPORTS_PER_SOL_I64,
            open_orders: 1,
            ..SpotPosition::default()
        };

        let user = User {
            spot_positions,
            orders: get_orders(Order {
                direction: PositionDirection::Short,
                base_asset_amount: 100 * LAMPORTS_PER_SOL,
                ..Order::default()
            }),
            ..User::default()
        };

        let (max_base, max_quote) =
            get_max_fill_amounts(&user, 0, &base_market, &quote_market).unwrap();

        assert_eq!(max_base, Some(16666666666));
        assert_eq!(max_quote, None);
    }

    #[test]
    fn fully_collateralized_selling_quote() {
        let base_market = SpotMarket::default_base_market();
        let quote_market = SpotMarket::default_quote_market();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            open_bids: 100 * LAMPORTS_PER_SOL_I64,
            open_orders: 1,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };

        let user = User {
            spot_positions,
            orders: get_orders(Order {
                direction: PositionDirection::Long,
                base_asset_amount: 100 * LAMPORTS_PER_SOL,
                ..Order::default()
            }),
            ..User::default()
        };

        let (max_base, max_quote) =
            get_max_fill_amounts(&user, 0, &base_market, &quote_market).unwrap();

        assert_eq!(max_base, None);
        assert_eq!(max_quote, Some(100 * QUOTE_PRECISION_U64));
    }

    #[test]
    fn selling_quote_with_borrow_and_no_borrow_liquidity() {
        let base_market = SpotMarket::default_base_market();
        let quote_market = SpotMarket::default_quote_market();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Borrow,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            open_bids: 100 * LAMPORTS_PER_SOL_I64,
            open_orders: 1,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };

        let user = User {
            spot_positions,
            orders: get_orders(Order {
                direction: PositionDirection::Long,
                base_asset_amount: 100 * LAMPORTS_PER_SOL,
                ..Order::default()
            }),
            ..User::default()
        };

        let (max_base, max_quote) =
            get_max_fill_amounts(&user, 0, &base_market, &quote_market).unwrap();

        assert_eq!(max_base, None);
        assert_eq!(max_quote, Some(0));
    }

    #[test]
    fn selling_quote_with_borrow_liquidity_greater_than_order() {
        let base_market = SpotMarket::default_base_market();
        let quote_market = SpotMarket {
            deposit_balance: 100 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_quote_market()
        };

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Borrow,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            scaled_balance: 0,
            open_bids: 100 * LAMPORTS_PER_SOL_I64,
            open_orders: 1,
            ..SpotPosition::default()
        };

        let user = User {
            spot_positions,
            orders: get_orders(Order {
                direction: PositionDirection::Long,
                base_asset_amount: 100 * LAMPORTS_PER_SOL,
                ..Order::default()
            }),
            ..User::default()
        };

        let (max_base, max_quote) =
            get_max_fill_amounts(&user, 0, &base_market, &quote_market).unwrap();

        assert_eq!(max_base, None);
        assert_eq!(max_quote, Some(16666666));
    }
}

mod find_fallback_maker_order {
    use crate::controller::position::PositionDirection;
    use crate::math::constants::{PRICE_PRECISION_I64, PRICE_PRECISION_U64};
    use crate::math::orders::find_fallback_maker_order;
    use crate::state::user::{
        MarketType, Order, OrderStatus, OrderTriggerCondition, OrderType, User,
    };

    #[test]
    fn no_open_orders() {
        let user = User::default();
        let direction = PositionDirection::Long;
        let market_type = MarketType::Perp;
        let market_index = 0;
        let oracle_price = PRICE_PRECISION_I64;
        let slot = 0;
        let tick_size = 1;

        let order_index = find_fallback_maker_order(
            &user,
            &direction,
            &market_type,
            market_index,
            Some(oracle_price),
            slot,
            tick_size,
        )
        .unwrap();

        assert_eq!(order_index, None);
    }

    #[test]
    fn no_limit_orders() {
        let user = User {
            orders: [Order {
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                market_index: 0,
                market_type: MarketType::Perp,
                direction: PositionDirection::Long,
                ..Order::default()
            }; 32],
            ..User::default()
        };
        let direction = PositionDirection::Long;
        let market_type = MarketType::Perp;
        let market_index = 0;
        let oracle_price = PRICE_PRECISION_I64;
        let slot = 0;
        let tick_size = 1;

        let order_index = find_fallback_maker_order(
            &user,
            &direction,
            &market_type,
            market_index,
            Some(oracle_price),
            slot,
            tick_size,
        )
        .unwrap();

        assert_eq!(order_index, None);
    }

    #[test]
    fn no_triggered_trigger_limit_orders() {
        let user = User {
            orders: [Order {
                status: OrderStatus::Open,
                order_type: OrderType::TriggerLimit,
                trigger_condition: OrderTriggerCondition::Above,
                market_index: 0,
                market_type: MarketType::Perp,
                direction: PositionDirection::Long,
                ..Order::default()
            }; 32],
            ..User::default()
        };
        let direction = PositionDirection::Long;
        let market_type = MarketType::Perp;
        let market_index = 0;
        let oracle_price = PRICE_PRECISION_I64;
        let slot = 0;
        let tick_size = 1;

        let order_index = find_fallback_maker_order(
            &user,
            &direction,
            &market_type,
            market_index,
            Some(oracle_price),
            slot,
            tick_size,
        )
        .unwrap();

        assert_eq!(order_index, None);
    }

    #[test]
    fn wrong_direction() {
        let user = User {
            orders: [Order {
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                market_index: 0,
                market_type: MarketType::Perp,
                direction: PositionDirection::Short,
                price: PRICE_PRECISION_U64,
                ..Order::default()
            }; 32],
            ..User::default()
        };
        let direction = PositionDirection::Long;
        let market_type = MarketType::Perp;
        let market_index = 0;
        let oracle_price = PRICE_PRECISION_I64;
        let slot = 0;
        let tick_size = 1;

        let order_index = find_fallback_maker_order(
            &user,
            &direction,
            &market_type,
            market_index,
            Some(oracle_price),
            slot,
            tick_size,
        )
        .unwrap();

        assert_eq!(order_index, None);
    }

    #[test]
    fn wrong_market_index() {
        let user = User {
            orders: [Order {
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                market_index: 1,
                market_type: MarketType::Perp,
                direction: PositionDirection::Long,
                price: PRICE_PRECISION_U64,
                ..Order::default()
            }; 32],
            ..User::default()
        };
        let direction = PositionDirection::Long;
        let market_type = MarketType::Perp;
        let market_index = 0;
        let oracle_price = PRICE_PRECISION_I64;
        let slot = 0;
        let tick_size = 1;

        let order_index = find_fallback_maker_order(
            &user,
            &direction,
            &market_type,
            market_index,
            Some(oracle_price),
            slot,
            tick_size,
        )
        .unwrap();

        assert_eq!(order_index, None);
    }

    #[test]
    fn wrong_market_type() {
        let user = User {
            orders: [Order {
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                market_index: 0,
                market_type: MarketType::Spot,
                direction: PositionDirection::Long,
                price: PRICE_PRECISION_U64,
                ..Order::default()
            }; 32],
            ..User::default()
        };
        let direction = PositionDirection::Long;
        let market_type = MarketType::Perp;
        let market_index = 0;
        let oracle_price = PRICE_PRECISION_I64;
        let slot = 0;
        let tick_size = 1;

        let order_index = find_fallback_maker_order(
            &user,
            &direction,
            &market_type,
            market_index,
            Some(oracle_price),
            slot,
            tick_size,
        )
        .unwrap();

        assert_eq!(order_index, None);
    }

    #[test]
    fn only_one_fallback_bid() {
        let mut orders = [Order::default(); 32];
        orders[0] = Order {
            status: OrderStatus::Open,
            order_type: OrderType::Limit,
            market_index: 0,
            market_type: MarketType::Perp,
            direction: PositionDirection::Long,
            price: PRICE_PRECISION_U64,
            ..Order::default()
        };

        let user = User {
            orders,
            ..User::default()
        };
        let direction = PositionDirection::Long;
        let market_type = MarketType::Perp;
        let market_index = 0;
        let oracle_price = PRICE_PRECISION_I64;
        let slot = 0;
        let tick_size = 1;

        let order_index = find_fallback_maker_order(
            &user,
            &direction,
            &market_type,
            market_index,
            Some(oracle_price),
            slot,
            tick_size,
        )
        .unwrap();

        assert_eq!(order_index, Some(0));
    }

    #[test]
    fn find_best_bid() {
        let mut orders = [Order::default(); 32];
        for (i, order) in orders.iter_mut().enumerate() {
            *order = Order {
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                market_index: 0,
                market_type: MarketType::Perp,
                direction: PositionDirection::Long,
                price: (i as u64 + 1) * PRICE_PRECISION_U64,
                ..Order::default()
            }
        }

        let user = User {
            orders,
            ..User::default()
        };
        let direction = PositionDirection::Long;
        let market_type = MarketType::Perp;
        let market_index = 0;
        let oracle_price = PRICE_PRECISION_I64;
        let slot = 0;
        let tick_size = 1;

        let order_index = find_fallback_maker_order(
            &user,
            &direction,
            &market_type,
            market_index,
            Some(oracle_price),
            slot,
            tick_size,
        )
        .unwrap();

        assert_eq!(order_index, Some(31));
    }

    #[test]
    fn find_best_ask() {
        let mut orders = [Order::default(); 32];
        for (i, order) in orders.iter_mut().enumerate() {
            *order = Order {
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                market_index: 0,
                market_type: MarketType::Perp,
                direction: PositionDirection::Short,
                price: (i as u64 + 1) * PRICE_PRECISION_U64,
                ..Order::default()
            }
        }

        let user = User {
            orders,
            ..User::default()
        };
        let direction = PositionDirection::Short;
        let market_type = MarketType::Perp;
        let market_index = 0;
        let oracle_price = PRICE_PRECISION_I64;
        let slot = 0;
        let tick_size = 1;

        let order_index = find_fallback_maker_order(
            &user,
            &direction,
            &market_type,
            market_index,
            Some(oracle_price),
            slot,
            tick_size,
        )
        .unwrap();

        assert_eq!(order_index, Some(0));
    }
}
