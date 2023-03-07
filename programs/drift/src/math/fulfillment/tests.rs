mod determine_perp_fulfillment_methods {
    use crate::controller::position::PositionDirection;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, PEG_PRECISION, PRICE_PRECISION, PRICE_PRECISION_I64,
        PRICE_PRECISION_U64,
    };
    use crate::math::fulfillment::determine_perp_fulfillment_methods;
    use crate::state::fulfillment::PerpFulfillmentMethod;
    use crate::state::oracle::HistoricalOracleData;
    use crate::state::perp_market::{MarketStatus, PerpMarket, AMM};
    use crate::state::user::Order;
    use solana_program::pubkey::Pubkey;

    #[test]
    fn amm_available_and_taker_doesnt_cross_maker() {
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
                order_step_size: 10000000,
                order_tick_size: 1,
                base_spread: 100,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;

        let taker_order = Order {
            direction: PositionDirection::Long,
            price: 102 * PRICE_PRECISION_U64,
            ..Order::default()
        };

        let oracle_price = 100 * PRICE_PRECISION_I64;

        let fulfillment_methods = determine_perp_fulfillment_methods(
            &taker_order,
            &[(Pubkey::default(), 0, 103 * PRICE_PRECISION_U64)],
            &market.amm,
            market.amm.reserve_price().unwrap(),
            Some(oracle_price),
            true,
            0,
            0,
        )
        .unwrap();

        assert_eq!(fulfillment_methods, [PerpFulfillmentMethod::AMM(None)]);
    }

    #[test]
    fn amm_available_and_maker_better_than_amm() {
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
                order_step_size: 10000000,
                order_tick_size: 1,
                base_spread: 100,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;

        let taker_order = Order {
            direction: PositionDirection::Long,
            price: 102 * PRICE_PRECISION_U64,
            ..Order::default()
        };

        let oracle_price = 100 * PRICE_PRECISION_I64;

        let fulfillment_methods = determine_perp_fulfillment_methods(
            &taker_order,
            &[(Pubkey::default(), 0, 99 * PRICE_PRECISION_U64)],
            &market.amm,
            market.amm.reserve_price().unwrap(),
            Some(oracle_price),
            true,
            0,
            0,
        )
        .unwrap();

        assert_eq!(
            fulfillment_methods,
            [
                PerpFulfillmentMethod::Match(Pubkey::default(), 0),
                PerpFulfillmentMethod::AMM(None)
            ]
        );
    }

    #[test]
    fn amm_available_and_amm_better_than_maker() {
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
                order_step_size: 10000000,
                order_tick_size: 1,
                base_spread: 100,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;

        let taker_order = Order {
            direction: PositionDirection::Long,
            price: 102 * PRICE_PRECISION_U64,
            ..Order::default()
        };

        let maker_order = Order {
            direction: PositionDirection::Short,
            price: 101 * PRICE_PRECISION_U64,
            ..Order::default()
        };

        let oracle_price = 100 * PRICE_PRECISION_I64;

        let fulfillment_methods = determine_perp_fulfillment_methods(
            &taker_order,
            &[(Pubkey::default(), 0, 101 * PRICE_PRECISION_U64)],
            &market.amm,
            market.amm.reserve_price().unwrap(),
            Some(oracle_price),
            true,
            0,
            0,
        )
        .unwrap();

        assert_eq!(
            fulfillment_methods,
            [
                PerpFulfillmentMethod::AMM(Some(maker_order.price)),
                PerpFulfillmentMethod::Match(Pubkey::default(), 0),
                PerpFulfillmentMethod::AMM(None)
            ]
        );
    }

    #[test]
    fn maker_amm_maker_amm_maker_ask() {
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
                order_step_size: 10000000,
                order_tick_size: 1,
                base_spread: 100,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;

        let taker_order = Order {
            direction: PositionDirection::Long,
            price: 102 * PRICE_PRECISION_U64,
            ..Order::default()
        };

        let oracle_price = 100 * PRICE_PRECISION_I64;

        let fulfillment_methods = determine_perp_fulfillment_methods(
            &taker_order,
            &[
                (Pubkey::default(), 0, 99 * PRICE_PRECISION_U64),
                (Pubkey::default(), 1, 101 * PRICE_PRECISION_U64),
            ],
            &market.amm,
            market.amm.reserve_price().unwrap(),
            Some(oracle_price),
            true,
            0,
            0,
        )
        .unwrap();

        assert_eq!(
            fulfillment_methods,
            [
                PerpFulfillmentMethod::Match(Pubkey::default(), 0),
                PerpFulfillmentMethod::AMM(Some(101 * PRICE_PRECISION_U64)),
                PerpFulfillmentMethod::Match(Pubkey::default(), 1),
                PerpFulfillmentMethod::AMM(None),
            ]
        );
    }

    #[test]
    fn maker_maker_amm_ask() {
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
                order_step_size: 10000000,
                order_tick_size: 1,
                base_spread: 100,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;

        let taker_order = Order {
            direction: PositionDirection::Long,
            price: 102 * PRICE_PRECISION_U64,
            ..Order::default()
        };

        let oracle_price = 100 * PRICE_PRECISION_I64;

        let fulfillment_methods = determine_perp_fulfillment_methods(
            &taker_order,
            &[
                (Pubkey::default(), 0, 99 * PRICE_PRECISION_U64),
                (
                    Pubkey::default(),
                    1,
                    99 * PRICE_PRECISION_U64 + PRICE_PRECISION_U64 / 2,
                ),
            ],
            &market.amm,
            market.amm.reserve_price().unwrap(),
            Some(oracle_price),
            true,
            0,
            0,
        )
        .unwrap();

        assert_eq!(
            fulfillment_methods,
            [
                PerpFulfillmentMethod::Match(Pubkey::default(), 0),
                PerpFulfillmentMethod::Match(Pubkey::default(), 1),
                PerpFulfillmentMethod::AMM(None),
            ]
        );
    }

    #[test]
    fn amm_maker_amm_maker_amm_ask() {
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
                order_step_size: 10000000,
                order_tick_size: 1,
                base_spread: 100,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;

        let taker_order = Order {
            direction: PositionDirection::Long,
            price: 105 * PRICE_PRECISION_U64,
            ..Order::default()
        };

        let oracle_price = 100 * PRICE_PRECISION_I64;

        let fulfillment_methods = determine_perp_fulfillment_methods(
            &taker_order,
            &[
                (Pubkey::default(), 0, 102 * PRICE_PRECISION_U64),
                (Pubkey::default(), 1, 103 * PRICE_PRECISION_U64),
            ],
            &market.amm,
            market.amm.reserve_price().unwrap(),
            Some(oracle_price),
            true,
            0,
            0,
        )
        .unwrap();

        assert_eq!(
            fulfillment_methods,
            [
                PerpFulfillmentMethod::AMM(Some(102 * PRICE_PRECISION_U64)),
                PerpFulfillmentMethod::Match(Pubkey::default(), 0),
                PerpFulfillmentMethod::AMM(Some(103 * PRICE_PRECISION_U64)),
                PerpFulfillmentMethod::Match(Pubkey::default(), 1),
                PerpFulfillmentMethod::AMM(None),
            ]
        );
    }

    #[test]
    fn maker_amm_maker_amm_maker_bid() {
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
                order_step_size: 10000000,
                order_tick_size: 1,
                base_spread: 100,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;

        let taker_order = Order {
            direction: PositionDirection::Short,
            price: 95 * PRICE_PRECISION_U64,
            ..Order::default()
        };

        let oracle_price = 100 * PRICE_PRECISION_I64;

        let fulfillment_methods = determine_perp_fulfillment_methods(
            &taker_order,
            &[
                (Pubkey::default(), 0, 101 * PRICE_PRECISION_U64),
                (Pubkey::default(), 1, 99 * PRICE_PRECISION_U64),
            ],
            &market.amm,
            market.amm.reserve_price().unwrap(),
            Some(oracle_price),
            true,
            0,
            0,
        )
        .unwrap();

        assert_eq!(
            fulfillment_methods,
            [
                PerpFulfillmentMethod::Match(Pubkey::default(), 0),
                PerpFulfillmentMethod::AMM(Some(99 * PRICE_PRECISION_U64)),
                PerpFulfillmentMethod::Match(Pubkey::default(), 1),
                PerpFulfillmentMethod::AMM(None),
            ]
        );
    }

    #[test]
    fn maker_maker_amm_bid() {
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
                order_step_size: 10000000,
                order_tick_size: 1,
                base_spread: 100,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;

        let taker_order = Order {
            direction: PositionDirection::Short,
            price: 95 * PRICE_PRECISION_U64,
            ..Order::default()
        };

        let oracle_price = 100 * PRICE_PRECISION_I64;

        let fulfillment_methods = determine_perp_fulfillment_methods(
            &taker_order,
            &[
                (Pubkey::default(), 0, 102 * PRICE_PRECISION_U64),
                (Pubkey::default(), 1, 101 * PRICE_PRECISION_U64),
            ],
            &market.amm,
            market.amm.reserve_price().unwrap(),
            Some(oracle_price),
            true,
            0,
            0,
        )
        .unwrap();

        assert_eq!(
            fulfillment_methods,
            [
                PerpFulfillmentMethod::Match(Pubkey::default(), 0),
                PerpFulfillmentMethod::Match(Pubkey::default(), 1),
                PerpFulfillmentMethod::AMM(None),
            ]
        );
    }

    #[test]
    fn amm_maker_amm_maker_amm_bid() {
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
                order_step_size: 10000000,
                order_tick_size: 1,
                base_spread: 100,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;

        let taker_order = Order {
            direction: PositionDirection::Short,
            price: 95 * PRICE_PRECISION_U64,
            ..Order::default()
        };

        let oracle_price = 100 * PRICE_PRECISION_I64;

        let fulfillment_methods = determine_perp_fulfillment_methods(
            &taker_order,
            &[
                (Pubkey::default(), 0, 99 * PRICE_PRECISION_U64),
                (Pubkey::default(), 1, 98 * PRICE_PRECISION_U64),
            ],
            &market.amm,
            market.amm.reserve_price().unwrap(),
            Some(oracle_price),
            true,
            0,
            0,
        )
        .unwrap();

        assert_eq!(
            fulfillment_methods,
            [
                PerpFulfillmentMethod::AMM(Some(99 * PRICE_PRECISION_U64)),
                PerpFulfillmentMethod::Match(Pubkey::default(), 0),
                PerpFulfillmentMethod::AMM(Some(98 * PRICE_PRECISION_U64)),
                PerpFulfillmentMethod::Match(Pubkey::default(), 1),
                PerpFulfillmentMethod::AMM(None),
            ]
        );
    }

    #[test]
    fn no_asks() {
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
                order_step_size: 10000000,
                order_tick_size: 1,
                base_spread: 100,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;

        let taker_order = Order {
            direction: PositionDirection::Long,
            price: 99 * PRICE_PRECISION_U64,
            ..Order::default()
        };

        let oracle_price = 100 * PRICE_PRECISION_I64;

        let fulfillment_methods = determine_perp_fulfillment_methods(
            &taker_order,
            &[
                (Pubkey::default(), 0, 101 * PRICE_PRECISION_U64),
                (Pubkey::default(), 1, 102 * PRICE_PRECISION_U64),
            ],
            &market.amm,
            market.amm.reserve_price().unwrap(),
            Some(oracle_price),
            true,
            0,
            0,
        )
        .unwrap();

        assert_eq!(fulfillment_methods, []);
    }

    #[test]
    fn no_bids() {
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
                order_step_size: 10000000,
                order_tick_size: 1,
                base_spread: 100,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;

        let taker_order = Order {
            direction: PositionDirection::Short,
            price: 105 * PRICE_PRECISION_U64,
            ..Order::default()
        };

        let oracle_price = 100 * PRICE_PRECISION_I64;

        let fulfillment_methods = determine_perp_fulfillment_methods(
            &taker_order,
            &[
                (Pubkey::default(), 0, 99 * PRICE_PRECISION_U64),
                (Pubkey::default(), 1, 98 * PRICE_PRECISION_U64),
            ],
            &market.amm,
            market.amm.reserve_price().unwrap(),
            Some(oracle_price),
            true,
            0,
            0,
        )
        .unwrap();

        assert_eq!(fulfillment_methods, []);
    }
}
