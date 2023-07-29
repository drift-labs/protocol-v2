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
    use crate::math::orders::order_breaches_oracle_price_bands;
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
        let result = order_breaches_oracle_price_bands(
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
        let result = order_breaches_oracle_price_bands(
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
        let result = order_breaches_oracle_price_bands(
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
        let result = order_breaches_oracle_price_bands(
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
        let result = order_breaches_oracle_price_bands(
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
        let result = order_breaches_oracle_price_bands(
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
    use crate::LAMPORTS_PER_SOL_U64;
    use anchor_spl::token::spl_token::solana_program::native_token::LAMPORTS_PER_SOL;

    #[test]
    fn fully_collateralized_selling_base() {
        let base_market = SpotMarket {
            deposit_balance: 4 * 100 * SPOT_BALANCE_PRECISION,
            deposit_token_twap: 4 * 100 * LAMPORTS_PER_SOL_U64,
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
            deposit_token_twap: 100 * SPOT_BALANCE_PRECISION as u64,
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
        let quote_market = SpotMarket {
            deposit_balance: 4 * 100 * SPOT_BALANCE_PRECISION,
            deposit_token_twap: 4 * 100 * QUOTE_PRECISION_U64,
            ..SpotMarket::default_quote_market()
        };

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
            deposit_token_twap: 100 * QUOTE_PRECISION_U64,

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

mod find_maker_orders {
    use crate::controller::position::PositionDirection;
    use crate::math::constants::{PRICE_PRECISION_I64, PRICE_PRECISION_U64};
    use crate::math::orders::find_maker_orders;
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

        let orders = find_maker_orders(
            &user,
            &direction,
            &market_type,
            market_index,
            Some(oracle_price),
            slot,
            tick_size,
        )
        .unwrap();

        assert_eq!(orders, vec![]);
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

        let orders = find_maker_orders(
            &user,
            &direction,
            &market_type,
            market_index,
            Some(oracle_price),
            slot,
            tick_size,
        )
        .unwrap();

        assert_eq!(orders, vec![]);
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

        let orders = find_maker_orders(
            &user,
            &direction,
            &market_type,
            market_index,
            Some(oracle_price),
            slot,
            tick_size,
        )
        .unwrap();

        assert_eq!(orders, vec![]);
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

        let orders = find_maker_orders(
            &user,
            &direction,
            &market_type,
            market_index,
            Some(oracle_price),
            slot,
            tick_size,
        )
        .unwrap();

        assert_eq!(orders, vec![]);
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

        let orders = find_maker_orders(
            &user,
            &direction,
            &market_type,
            market_index,
            Some(oracle_price),
            slot,
            tick_size,
        )
        .unwrap();

        assert_eq!(orders, vec![]);
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

        let orders = find_maker_orders(
            &user,
            &direction,
            &market_type,
            market_index,
            Some(oracle_price),
            slot,
            tick_size,
        )
        .unwrap();

        assert_eq!(orders, vec![]);
    }

    #[test]
    fn only_one_maker_bid() {
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

        let orders = find_maker_orders(
            &user,
            &direction,
            &market_type,
            market_index,
            Some(oracle_price),
            slot,
            tick_size,
        )
        .unwrap();

        assert_eq!(orders, vec![(0, PRICE_PRECISION_U64)]);
    }

    #[test]
    fn multiple_maker_bids() {
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

        let orders = find_maker_orders(
            &user,
            &direction,
            &market_type,
            market_index,
            Some(oracle_price),
            slot,
            tick_size,
        )
        .unwrap();

        let mut expected_orders = vec![];
        for i in 0..32 {
            expected_orders.push((i, (i as u64 + 1) * PRICE_PRECISION_U64));
        }

        assert_eq!(orders, expected_orders);
    }

    #[test]
    fn multiple_asks() {
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

        let orders = find_maker_orders(
            &user,
            &direction,
            &market_type,
            market_index,
            Some(oracle_price),
            slot,
            tick_size,
        )
        .unwrap();

        let mut expected_orders = vec![];
        for i in 0..32 {
            expected_orders.push((i, (i as u64 + 1) * PRICE_PRECISION_U64));
        }

        assert_eq!(orders, expected_orders);
    }
}

mod calculate_max_spot_order_size {
    use std::str::FromStr;

    use anchor_lang::Owner;
    use solana_program::pubkey::Pubkey;

    use crate::math::constants::{
        LIQUIDATION_FEE_PRECISION, PRICE_PRECISION_I64, SPOT_BALANCE_PRECISION,
        SPOT_BALANCE_PRECISION_U64, SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_WEIGHT_PRECISION,
    };
    use crate::math::margin::{
        calculate_margin_requirement_and_total_collateral_and_liability_info, MarginRequirementType,
    };
    use crate::math::orders::calculate_max_spot_order_size;
    use crate::state::oracle::{HistoricalOracleData, OracleSource};
    use crate::state::oracle_map::OracleMap;

    use crate::create_anchor_account_info;
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::user::{Order, PerpPosition, SpotPosition, User};
    use crate::test_utils::get_pyth_price;
    use crate::test_utils::*;
    use crate::{create_account_info, PositionDirection};

    #[test]
    pub fn usdc_deposit_and_5x_sol_bid() {
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let _market_map = PerpMarketMap::empty();

        let mut usdc_spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 10000 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData::default_quote_oracle(),
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_spot_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_spot_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap_5min: 110 * PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_spot_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 10000 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: [PerpPosition::default(); 8],
            spot_positions,
            ..User::default()
        };

        let max_order_size = calculate_max_spot_order_size(
            &user,
            1,
            PositionDirection::Long,
            &PerpMarketMap::empty(),
            &spot_market_map,
            &mut oracle_map,
        )
        .unwrap();

        assert_eq!(max_order_size, 454545000000);

        user.spot_positions[1].open_orders = 1;
        user.spot_positions[1].open_bids = max_order_size as i64;

        let (margin_requirement, total_collateral, _, _, _, _) =
            calculate_margin_requirement_and_total_collateral_and_liability_info(
                &user,
                &PerpMarketMap::empty(),
                MarginRequirementType::Initial,
                &spot_market_map,
                &mut oracle_map,
                None,
                true,
            )
            .unwrap();

        assert_eq!(total_collateral.unsigned_abs(), margin_requirement);
    }

    #[test]
    pub fn usdc_deposit_and_5x_sol_bid_already_short() {
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let _market_map = PerpMarketMap::empty();

        let mut usdc_spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 10000 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData::default_quote_oracle(),
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_spot_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_spot_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap_5min: 110 * PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_spot_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 10000 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: 500 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let user = User {
            orders: [Order::default(); 32],
            perp_positions: [PerpPosition::default(); 8],
            spot_positions,
            ..User::default()
        };

        let max_order_size = calculate_max_spot_order_size(
            &user,
            1,
            PositionDirection::Long,
            &PerpMarketMap::empty(),
            &spot_market_map,
            &mut oracle_map,
        )
        .unwrap();

        assert_eq!(max_order_size, 999999999999);
    }

    #[test]
    pub fn usdc_deposit_and_5x_sol_sell() {
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let _market_map = PerpMarketMap::empty();

        let mut usdc_spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 10000 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData::default_quote_oracle(),
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_spot_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_spot_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap_5min: 110 * PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_spot_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 10000 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: [PerpPosition::default(); 8],
            spot_positions,
            ..User::default()
        };

        let max_order_size = calculate_max_spot_order_size(
            &user,
            1,
            PositionDirection::Short,
            &PerpMarketMap::empty(),
            &spot_market_map,
            &mut oracle_map,
        )
        .unwrap();

        assert_eq!(max_order_size, 454545000000);

        user.spot_positions[1].open_orders = 1;
        user.spot_positions[1].open_asks = -(max_order_size as i64);

        let (margin_requirement, total_collateral, _, _, _, _) =
            calculate_margin_requirement_and_total_collateral_and_liability_info(
                &user,
                &PerpMarketMap::empty(),
                MarginRequirementType::Initial,
                &spot_market_map,
                &mut oracle_map,
                None,
                true,
            )
            .unwrap();

        assert_eq!(total_collateral.unsigned_abs(), margin_requirement);
    }

    #[test]
    pub fn usdc_deposit_and_5x_sol_sell_already_long() {
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let _market_map = PerpMarketMap::empty();

        let mut usdc_spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 10000 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData::default_quote_oracle(),
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_spot_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_spot_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap_5min: 110 * PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_spot_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 10000 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 500 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let user = User {
            orders: [Order::default(); 32],
            perp_positions: [PerpPosition::default(); 8],
            spot_positions,
            ..User::default()
        };

        let max_order_size = calculate_max_spot_order_size(
            &user,
            1,
            PositionDirection::Short,
            &PerpMarketMap::empty(),
            &spot_market_map,
            &mut oracle_map,
        )
        .unwrap();

        assert_eq!(max_order_size, 3181817727272);
    }
}

mod calculate_max_perp_order_size {
    use std::str::FromStr;

    use anchor_lang::Owner;
    use solana_program::pubkey::Pubkey;

    use crate::math::constants::{
        SPOT_BALANCE_PRECISION, SPOT_BALANCE_PRECISION_U64, SPOT_CUMULATIVE_INTEREST_PRECISION,
        SPOT_WEIGHT_PRECISION,
    };
    use crate::math::margin::{
        calculate_margin_requirement_and_total_collateral_and_liability_info, MarginRequirementType,
    };
    use crate::math::orders::calculate_max_perp_order_size;
    use crate::state::oracle::{HistoricalOracleData, OracleSource};
    use crate::state::oracle_map::OracleMap;

    use crate::state::perp_market::{PerpMarket, AMM};
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::user::{Order, PerpPosition, SpotPosition, User};
    use crate::test_utils::get_pyth_price;
    use crate::test_utils::*;
    use crate::{create_account_info, PositionDirection, PRICE_PRECISION_I64};
    use crate::{
        create_anchor_account_info, MarketStatus, AMM_RESERVE_PRECISION, PEG_PRECISION,
        PRICE_PRECISION,
    };

    #[test]
    pub fn sol_perp_5x_bid() {
        let slot = 0_u64;

        let mut oracle_price = get_pyth_price(100, 6);
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            oracle_price,
            &oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                base_spread: 0, // 1 basis point
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 2000,
            margin_ratio_maintenance: 1000,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;

        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 10000 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_spot_market, SpotMarket, usdc_spot_market_account_info);
        let spot_market_account_infos = Vec::from([&usdc_spot_market_account_info]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 10000 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                ..PerpPosition::default()
            }),
            spot_positions,
            ..User::default()
        };

        let max_order_size = calculate_max_perp_order_size(
            &user,
            0,
            0,
            PositionDirection::Long,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
        )
        .unwrap();

        assert_eq!(max_order_size, 499999500000);

        user.perp_positions[0].open_orders = 1;
        user.perp_positions[0].open_bids = max_order_size as i64;

        let (margin_requirement, total_collateral, _, _, _, _) =
            calculate_margin_requirement_and_total_collateral_and_liability_info(
                &user,
                &market_map,
                MarginRequirementType::Initial,
                &spot_market_map,
                &mut oracle_map,
                None,
                true,
            )
            .unwrap();

        assert_eq!(total_collateral.unsigned_abs(), margin_requirement);
    }

    #[test]
    pub fn sol_perp_5x_bid_when_short_5x() {
        let slot = 0_u64;

        let mut oracle_price = get_pyth_price(100, 6);
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            oracle_price,
            &oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                base_spread: 0, // 1 basis point
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 2000,
            margin_ratio_maintenance: 1000,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;

        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 10000 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_spot_market, SpotMarket, usdc_spot_market_account_info);
        let spot_market_account_infos = Vec::from([&usdc_spot_market_account_info]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 10000 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: -500000000000,
                ..PerpPosition::default()
            }),
            spot_positions,
            ..User::default()
        };

        let max_order_size = calculate_max_perp_order_size(
            &user,
            0,
            0,
            PositionDirection::Long,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
        )
        .unwrap();

        assert_eq!(max_order_size, 999999999000);
    }

    #[test]
    pub fn sol_perp_5x_ask() {
        let slot = 0_u64;

        let mut oracle_price = get_pyth_price(100, 6);
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            oracle_price,
            &oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                base_spread: 0, // 1 basis point
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 2000,
            margin_ratio_maintenance: 1000,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;

        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 10000 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_spot_market, SpotMarket, usdc_spot_market_account_info);
        let spot_market_account_infos = Vec::from([&usdc_spot_market_account_info]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 10000 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                ..PerpPosition::default()
            }),
            spot_positions,
            ..User::default()
        };

        let max_order_size = calculate_max_perp_order_size(
            &user,
            0,
            0,
            PositionDirection::Short,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
        )
        .unwrap();

        assert_eq!(max_order_size, 499999500000);

        user.perp_positions[0].open_orders = 1;
        user.perp_positions[0].open_asks = -(max_order_size as i64);

        let (margin_requirement, total_collateral, _, _, _, _) =
            calculate_margin_requirement_and_total_collateral_and_liability_info(
                &user,
                &market_map,
                MarginRequirementType::Initial,
                &spot_market_map,
                &mut oracle_map,
                None,
                true,
            )
            .unwrap();

        assert_eq!(total_collateral.unsigned_abs(), margin_requirement);
    }

    #[test]
    pub fn sol_perp_5x_ask_when_long_5x() {
        let slot = 0_u64;

        let mut oracle_price = get_pyth_price(100, 6);
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            oracle_price,
            &oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                base_spread: 0, // 1 basis point
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 2000,
            margin_ratio_maintenance: 1000,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;

        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 10000 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_spot_market, SpotMarket, usdc_spot_market_account_info);
        let spot_market_account_infos = Vec::from([&usdc_spot_market_account_info]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 10000 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: 500000000000,
                ..PerpPosition::default()
            }),
            spot_positions,
            ..User::default()
        };

        let max_order_size = calculate_max_perp_order_size(
            &user,
            0,
            0,
            PositionDirection::Short,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
        )
        .unwrap();

        assert_eq!(max_order_size, 999999999000);
    }
}

pub mod validate_fill_price_within_price_bands {
    use crate::math::orders::validate_fill_price_within_price_bands;
    use crate::{
        PositionDirection, MARGIN_PRECISION, PERCENTAGE_PRECISION, PRICE_PRECISION_I64,
        PRICE_PRECISION_U64,
    };

    #[test]
    fn valid_long() {
        let oracle_price = 100 * PRICE_PRECISION_I64;
        let twap = oracle_price;
        let fill_price = 105 * PRICE_PRECISION_U64;
        let direction = PositionDirection::Long;
        let margin_ratio_initial = MARGIN_PRECISION / 10;

        assert!(validate_fill_price_within_price_bands(
            fill_price,
            direction,
            oracle_price,
            twap,
            margin_ratio_initial,
            (PERCENTAGE_PRECISION / 2) as u64,
        )
        .is_ok())
    }

    #[test]
    fn valid_short() {
        let oracle_price = 100 * PRICE_PRECISION_I64;
        let twap = oracle_price;
        let fill_price = 95 * PRICE_PRECISION_U64;
        let direction = PositionDirection::Short;
        let margin_ratio_initial = MARGIN_PRECISION / 10;

        assert!(validate_fill_price_within_price_bands(
            fill_price,
            direction,
            oracle_price,
            twap,
            margin_ratio_initial,
            (PERCENTAGE_PRECISION / 2) as u64,
        )
        .is_ok())
    }

    #[test]
    fn invalid_long_breaches_oracle() {
        let oracle_price = 100 * PRICE_PRECISION_I64;
        let twap = oracle_price;
        // 11% greater than oracle price
        let fill_price = 111 * PRICE_PRECISION_U64;
        let direction = PositionDirection::Long;
        let margin_ratio_initial = MARGIN_PRECISION / 10; // 10x

        assert!(validate_fill_price_within_price_bands(
            fill_price,
            direction,
            oracle_price,
            twap,
            margin_ratio_initial,
            (PERCENTAGE_PRECISION / 2) as u64,
        )
        .is_err())
    }

    #[test]
    fn invalid_short_breaches_oracle() {
        let oracle_price = 100 * PRICE_PRECISION_I64;
        let twap = oracle_price;
        // 11% less than oracle price
        let fill_price = 89 * PRICE_PRECISION_U64;
        let direction = PositionDirection::Short;
        let margin_ratio_initial = MARGIN_PRECISION / 10; // 10x

        assert!(validate_fill_price_within_price_bands(
            fill_price,
            direction,
            oracle_price,
            twap,
            margin_ratio_initial,
            (PERCENTAGE_PRECISION / 2) as u64,
        )
        .is_err())
    }

    #[test]
    fn invalid_long_breaches_oracle_twap() {
        let oracle_price = 150 * PRICE_PRECISION_I64;
        let twap = 100 * PRICE_PRECISION_I64;
        // 50% greater than twap
        let fill_price = 150 * PRICE_PRECISION_U64;
        let direction = PositionDirection::Long;
        let margin_ratio_initial = MARGIN_PRECISION / 10; // 10x

        assert!(validate_fill_price_within_price_bands(
            fill_price,
            direction,
            oracle_price,
            twap,
            margin_ratio_initial,
            (PERCENTAGE_PRECISION / 2) as u64,
        )
        .is_err())
    }

    #[test]
    fn invalid_short_breaches_oracle_twap() {
        let oracle_price = 50 * PRICE_PRECISION_I64;
        let twap = 100 * PRICE_PRECISION_I64;
        // 50% less than twap
        let fill_price = 50 * PRICE_PRECISION_U64;
        let direction = PositionDirection::Short;
        let margin_ratio_initial = MARGIN_PRECISION / 10; // 10x

        assert!(validate_fill_price_within_price_bands(
            fill_price,
            direction,
            oracle_price,
            twap,
            margin_ratio_initial,
            (PERCENTAGE_PRECISION / 2) as u64,
        )
        .is_err())
    }
}

pub mod is_oracle_too_divergent_with_twap_5min {
    use crate::math::orders::is_oracle_too_divergent_with_twap_5min;
    use crate::{PERCENTAGE_PRECISION_U64, PRICE_PRECISION_I64};

    #[test]
    pub fn valid_above() {
        let oracle_price = 149 * PRICE_PRECISION_I64;
        let twap = 100 * PRICE_PRECISION_I64;
        let max_divergence = PERCENTAGE_PRECISION_U64 as i64 / 2;

        assert!(
            !is_oracle_too_divergent_with_twap_5min(oracle_price, twap, max_divergence).unwrap()
        )
    }

    #[test]
    pub fn invalid_above() {
        let oracle_price = 151 * PRICE_PRECISION_I64;
        let twap = 100 * PRICE_PRECISION_I64;
        let max_divergence = PERCENTAGE_PRECISION_U64 as i64 / 2;

        assert!(is_oracle_too_divergent_with_twap_5min(oracle_price, twap, max_divergence).unwrap())
    }

    #[test]
    pub fn valid_below() {
        let oracle_price = 51 * PRICE_PRECISION_I64;
        let twap = 100 * PRICE_PRECISION_I64;
        let max_divergence = PERCENTAGE_PRECISION_U64 as i64 / 2;

        assert!(
            !is_oracle_too_divergent_with_twap_5min(oracle_price, twap, max_divergence).unwrap()
        )
    }

    #[test]
    pub fn invalid_below() {
        let oracle_price = 49 * PRICE_PRECISION_I64;
        let twap = 100 * PRICE_PRECISION_I64;
        let max_divergence = PERCENTAGE_PRECISION_U64 as i64 / 2;

        assert!(is_oracle_too_divergent_with_twap_5min(oracle_price, twap, max_divergence).unwrap())
    }
}

pub mod get_price_for_perp_order {
    use crate::math::orders::get_price_for_perp_order;

    use crate::state::perp_market::AMM;
    use crate::{PositionDirection, PostOnlyParam, BID_ASK_SPREAD_PRECISION_U128};
    use crate::{AMM_RESERVE_PRECISION, PEG_PRECISION};

    #[test]
    fn bid_crosses_vamm_ask() {
        let amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            order_tick_size: 100000,
            short_spread: BID_ASK_SPREAD_PRECISION_U128 as u32 / 100,
            ..AMM::default()
        };

        let amm_reserve_price = amm.reserve_price().unwrap();
        let amm_bid_price = amm.bid_price(amm_reserve_price).unwrap();

        assert_eq!(amm_bid_price, 99000000); // $99

        let ask = 98900000; // $98.9
        let direction = PositionDirection::Short;

        let limit_price =
            get_price_for_perp_order(ask, direction, PostOnlyParam::Slide, &amm).unwrap();

        assert_eq!(limit_price, 99100000); // $99.1

        let ask = amm_bid_price;
        let limit_price =
            get_price_for_perp_order(ask, direction, PostOnlyParam::Slide, &amm).unwrap();

        assert_eq!(limit_price, 99100000); // $99.1
    }

    #[test]
    fn bid_doesnt_cross_vamm_ask() {
        let amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            order_tick_size: 100000,
            short_spread: BID_ASK_SPREAD_PRECISION_U128 as u32 / 100,
            ..AMM::default()
        };

        let amm_reserve_price = amm.reserve_price().unwrap();
        let amm_bid_price = amm.bid_price(amm_reserve_price).unwrap();

        assert_eq!(amm_bid_price, 99000000); // $99

        let ask = 99900000; // $99.9
        let direction = PositionDirection::Short;

        let limit_price =
            get_price_for_perp_order(ask, direction, PostOnlyParam::Slide, &amm).unwrap();

        assert_eq!(limit_price, ask); // $99.1
    }

    #[test]
    fn ask_crosses_vamm_ask() {
        let amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            order_tick_size: 100000,
            long_spread: BID_ASK_SPREAD_PRECISION_U128 as u32 / 100,
            ..AMM::default()
        };

        let amm_reserve_price = amm.reserve_price().unwrap();
        let amm_ask_price = amm.ask_price(amm_reserve_price).unwrap();

        assert_eq!(amm_ask_price, 101000000); // $101

        let bid = 101100000; // $101.1
        let direction = PositionDirection::Long;

        let limit_price =
            get_price_for_perp_order(bid, direction, PostOnlyParam::Slide, &amm).unwrap();

        assert_eq!(limit_price, 100900000); // $100.9

        let bid = amm_ask_price;
        let limit_price =
            get_price_for_perp_order(bid, direction, PostOnlyParam::Slide, &amm).unwrap();

        assert_eq!(limit_price, 100900000); // $100.9
    }

    #[test]
    fn ask_doesnt_cross_vamm_ask() {
        let amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            order_tick_size: 100000,
            long_spread: BID_ASK_SPREAD_PRECISION_U128 as u32 / 100,
            ..AMM::default()
        };

        let amm_reserve_price = amm.reserve_price().unwrap();
        let amm_ask_price = amm.ask_price(amm_reserve_price).unwrap();

        assert_eq!(amm_ask_price, 101000000); // $101

        let bid = 100100000; // $100.1
        let direction = PositionDirection::Long;

        let limit_price =
            get_price_for_perp_order(bid, direction, PostOnlyParam::Slide, &amm).unwrap();

        assert_eq!(limit_price, bid); // $100.1
    }
}

pub mod estimate_price_from_side {
    use crate::math::orders::{estimate_price_from_side, Level, Side};
    use crate::{BASE_PRECISION_U64, PRICE_PRECISION_U64};

    #[test]
    fn ask() {
        let mut asks: Side = vec![];
        for i in 0..11 {
            asks.push(Level {
                price: (100 - i) * PRICE_PRECISION_U64,
                base_asset_amount: 100 * BASE_PRECISION_U64,
            })
        }

        let depth = 1100 * BASE_PRECISION_U64;
        let price = estimate_price_from_side(&asks, depth).unwrap();

        assert_eq!(price, Some(95000000));

        let depth = 1101 * BASE_PRECISION_U64;
        let price = estimate_price_from_side(&asks, depth).unwrap();

        assert_eq!(price, None);
    }

    #[test]
    fn bids() {
        let mut bids: Side = vec![];
        for i in 0..11 {
            bids.push(Level {
                price: (90 + i) * PRICE_PRECISION_U64,
                base_asset_amount: 100 * BASE_PRECISION_U64,
            })
        }

        let depth = 1100 * BASE_PRECISION_U64;
        let price = estimate_price_from_side(&bids, depth).unwrap();

        assert_eq!(price, Some(95000000));

        let depth = 1101 * BASE_PRECISION_U64;
        let price = estimate_price_from_side(&bids, depth).unwrap();

        assert_eq!(price, None);
    }
}

pub mod find_bids_and_asks_from_users {
    use solana_program::pubkey::Pubkey;

    use crate::controller::position::PositionDirection;
    use crate::create_anchor_account_info;
    use crate::math::constants::{BASE_PRECISION_U64, PRICE_PRECISION_I64, PRICE_PRECISION_U64};
    use crate::math::orders::{find_bids_and_asks_from_users, Level};
    use crate::state::oracle::OraclePriceData;
    use crate::state::perp_market::PerpMarket;
    use crate::state::user::{Order, OrderStatus, OrderType, PerpPosition, User};
    use crate::state::user_map::UserMap;
    use crate::test_utils::*;
    use crate::test_utils::{create_account_info, get_positions};
    use crate::MarketType;
    use anchor_lang::Owner;

    #[test]
    fn test() {
        let market = PerpMarket::default_test();

        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            ..OraclePriceData::default()
        };

        let mut maker_orders = [Order::default(); 32];
        for (i, order) in maker_orders.iter_mut().enumerate().take(16) {
            *order = Order {
                status: OrderStatus::Open,
                market_index: 0,
                market_type: MarketType::Perp,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                price: (80 + i) as u64 * PRICE_PRECISION_U64,
                post_only: true,
                ..Order::default()
            };
        }

        for (i, order) in maker_orders.iter_mut().enumerate().skip(16) {
            *order = Order {
                status: OrderStatus::Open,
                market_index: 0,
                market_type: MarketType::Perp,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                price: (120 - i) as u64 * PRICE_PRECISION_U64,
                post_only: true,
                ..Order::default()
            };
        }

        let mut maker = User {
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 32,
                ..PerpPosition::default()
            }),
            orders: maker_orders,
            ..User::default()
        };
        let maker_key = Pubkey::default();
        create_anchor_account_info!(maker, &maker_key, User, maker_account_info);

        let makers_and_referrers = UserMap::load_one(&maker_account_info).unwrap();

        let (bids, asks) =
            find_bids_and_asks_from_users(&market, &oracle_price_data, &makers_and_referrers, 0, 0)
                .unwrap();

        let mut expected_bids = vec![];
        for i in 0..16 {
            expected_bids.push(Level {
                price: (95 - i) as u64 * PRICE_PRECISION_U64,
                base_asset_amount: BASE_PRECISION_U64,
            })
        }
        assert_eq!(bids, expected_bids);

        let mut expected_asks = vec![];
        for i in 0..16 {
            expected_asks.push(Level {
                price: (89 + i) as u64 * PRICE_PRECISION_U64,
                base_asset_amount: BASE_PRECISION_U64,
            })
        }
        assert_eq!(asks, expected_asks);
    }
}
