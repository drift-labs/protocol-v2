use crate::state::order_params::parse_optional_params;

mod get_auction_duration {
    use crate::state::order_params::get_auction_duration;
    use crate::{ContractTier, PRICE_PRECISION_U64};

    #[test]
    fn test() {
        let price_diff = 0;
        let price = 100 * PRICE_PRECISION_U64;
        let contract_tier = ContractTier::C;

        let duration = get_auction_duration(price_diff, price, contract_tier).unwrap();
        assert_eq!(duration, 1);

        let price_diff = PRICE_PRECISION_U64 / 10;
        let price = 100 * PRICE_PRECISION_U64;

        let duration = get_auction_duration(price_diff, price, contract_tier).unwrap();
        assert_eq!(duration, 6);

        let price_diff = PRICE_PRECISION_U64 / 2;
        let price = 100 * PRICE_PRECISION_U64;

        let duration = get_auction_duration(price_diff, price, contract_tier).unwrap();
        assert_eq!(duration, 30);

        let price_diff = PRICE_PRECISION_U64;
        let price = 100 * PRICE_PRECISION_U64;

        let duration = get_auction_duration(price_diff, price, contract_tier).unwrap();
        assert_eq!(duration, 60);

        let price_diff = 2 * PRICE_PRECISION_U64;
        let price = 100 * PRICE_PRECISION_U64;

        let duration = get_auction_duration(price_diff, price, contract_tier).unwrap();
        assert_eq!(duration, 120);
    }
}

mod update_perp_auction_params {
    use crate::state::order_params::PostOnlyParam;
    use crate::state::perp_market::{ContractTier, MarketStats, PerpMarket, AMM};
    use crate::state::user::OrderType;
    use crate::{
        OracleSource, OrderParams, PositionDirection, AMM_RESERVE_PRECISION,
        BID_ASK_SPREAD_PRECISION, PEG_PRECISION, PRICE_PRECISION_I64, PRICE_PRECISION_U64,
        QUOTE_PRECISION_U64,
    };

    #[test]
    fn test_extreme_sanitize_oracle_order() {
        let oracle_price = 145 * PRICE_PRECISION_I64;
        let mut amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,

            ..AMM::default()
        };
        let mut market_stats = MarketStats::default();
        market_stats.last_bid_price_twap = (oracle_price - 192988) as u64;
        market_stats.last_mark_price_twap_5min = oracle_price as u64;
        market_stats.last_ask_price_twap = (oracle_price + 192988) as u64;
        market_stats.historical_oracle_data.last_oracle_price_twap = oracle_price;
        market_stats
            .historical_oracle_data
            .last_oracle_price_twap_5min = oracle_price;

        market_stats.historical_oracle_data.last_oracle_price = oracle_price;
        market_stats.volume_24h = 1_000_000 * QUOTE_PRECISION_U64;
        let mut perp_market = PerpMarket {
            market_stats,
            amm,
            ..PerpMarket::default()
        };
        let order_params_before = OrderParams {
            order_type: OrderType::Oracle,
            auction_start_price: Some(market_stats.last_bid_price_twap as i64),
            auction_end_price: Some((market_stats.last_bid_price_twap + 1000000) as i64),
            auction_duration: Some(30),
            direction: PositionDirection::Long,
            ..OrderParams::default()
        };

        assert_eq!(order_params_before.auction_start_price, Some(144_807_012));
        assert_eq!(order_params_before.auction_end_price, Some(145_807_012));

        let mut order_params_after = order_params_before;
        let sanitized = order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();

        // Spread reserves are no longer cached on AMM; the auction price
        // is now derived from on-demand quote state. Legacy: -144807 /
        // 3_092_988.
        assert_eq!(order_params_after.auction_start_price, Some(-192988));
        assert_eq!(order_params_after.auction_end_price, Some(3_092_988));
        assert_eq!(order_params_after.auction_duration, Some(136));
        assert_eq!(sanitized, true);

        let order_params_before2 = OrderParams {
            order_type: OrderType::Oracle,
            auction_start_price: Some(market_stats.last_ask_price_twap as i64),
            auction_end_price: Some((market_stats.last_bid_price_twap - 1000000) as i64),
            auction_duration: Some(30),
            direction: PositionDirection::Short,
            ..OrderParams::default()
        };

        assert_eq!(order_params_before2.auction_start_price, Some(145192988));
        assert_eq!(order_params_before2.auction_end_price, Some(143807012));

        let mut order_params_after2 = order_params_before2;
        order_params_after2
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();

        assert_eq!(order_params_after2.auction_start_price, Some(145192988)); // will never fill kek
        assert_eq!(order_params_after2.auction_end_price, Some(143807012));
        assert_eq!(order_params_after2.auction_duration, Some(58));

        // huge negative for short
        let order_params_before3 = OrderParams {
            order_type: OrderType::Oracle,
            auction_start_price: Some(-(market_stats.last_ask_price_twap as i64)),
            auction_end_price: Some(-((market_stats.last_bid_price_twap - 1000000) as i64)),
            auction_duration: Some(30),
            direction: PositionDirection::Short,
            oracle_price_offset: Some(-((market_stats.last_bid_price_twap - 1000000) as i64)),
            ..OrderParams::default()
        };

        assert_eq!(order_params_before3.auction_start_price, Some(-145192988));
        assert_eq!(order_params_before3.auction_end_price, Some(-143807012));
        assert_eq!(order_params_before3.oracle_price_offset, Some(-143807012));

        let mut order_params_after3 = order_params_before3;
        order_params_after3
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();

        assert_eq!(order_params_after3.auction_start_price, Some(192988));
        assert_eq!(order_params_after3.auction_end_price, Some(-3092988));
        assert_eq!(order_params_after3.oracle_price_offset, Some(-143807012));

        assert_eq!(order_params_after3.auction_duration, Some(136));
    }

    #[test]
    fn test_signed_msg_orders_oracle() {
        let oracle_price = 100 * PRICE_PRECISION_I64;
        let mut amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,

            ..AMM::default()
        };
        let mut market_stats = MarketStats::default();
        market_stats.last_bid_price_twap = (oracle_price - 100000) as u64;
        market_stats.last_mark_price_twap_5min = oracle_price as u64;
        market_stats.last_ask_price_twap = (oracle_price + 100000) as u64;
        market_stats.historical_oracle_data.last_oracle_price_twap = oracle_price;
        market_stats
            .historical_oracle_data
            .last_oracle_price_twap_5min = oracle_price;

        market_stats.historical_oracle_data.last_oracle_price = oracle_price;
        market_stats.volume_24h = 1_000_000 * QUOTE_PRECISION_U64;
        let mut perp_market = PerpMarket {
            market_stats,
            amm,
            contract_tier: ContractTier::A,
            ..PerpMarket::default()
        };
        let order_params_long_before = OrderParams {
            order_type: OrderType::Oracle,
            auction_start_price: Some(0),
            auction_end_price: Some(200000),
            auction_duration: Some(30),
            direction: PositionDirection::Long,
            ..OrderParams::default()
        };

        let mut order_params_long_after = order_params_long_before;
        let sanitized = order_params_long_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, true)
            .unwrap();

        assert_eq!(order_params_long_after.auction_start_price, Some(0));
        assert_eq!(order_params_long_after.auction_end_price, Some(200000));
        assert_eq!(order_params_long_after.auction_duration, Some(30));
        assert_eq!(sanitized, false);

        let order_params_long_before_not_signed = OrderParams {
            order_type: OrderType::Oracle,
            auction_start_price: Some(0),
            auction_end_price: Some(200000),
            auction_duration: Some(30),
            direction: PositionDirection::Long,
            ..OrderParams::default()
        };

        let mut order_params_long_after_not_signed = order_params_long_before_not_signed;
        let sanitized = order_params_long_after_not_signed
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();

        assert_eq!(
            order_params_long_after_not_signed.auction_start_price,
            Some(-100000)
        );
        assert_eq!(
            order_params_long_after_not_signed.auction_end_price,
            Some(200000)
        );
        assert_eq!(
            order_params_long_after_not_signed.auction_duration,
            Some(30)
        );
        assert_eq!(sanitized, true);

        // now short
        let order_params_short_before = OrderParams {
            order_type: OrderType::Oracle,
            auction_start_price: Some(100),
            auction_end_price: Some(-200000),
            auction_duration: Some(30),
            direction: PositionDirection::Short,
            ..OrderParams::default()
        };

        let mut order_params_short_after = order_params_short_before;
        let sanitized = order_params_short_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, true)
            .unwrap();

        assert_eq!(order_params_short_after.auction_start_price, Some(100));
        assert_eq!(order_params_short_after.auction_end_price, Some(-200000));
        assert_eq!(order_params_short_after.auction_duration, Some(30));
        assert_eq!(sanitized, false);

        let order_params_long_before_not_signed = OrderParams {
            order_type: OrderType::Oracle,
            auction_start_price: Some(0),
            auction_end_price: Some(-200000),
            auction_duration: Some(30),
            direction: PositionDirection::Short,
            ..OrderParams::default()
        };

        let mut order_params_long_after_not_signed = order_params_long_before_not_signed;
        let sanitized = order_params_long_after_not_signed
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();

        assert_eq!(
            order_params_long_after_not_signed.auction_start_price,
            Some(100000)
        );
        assert_eq!(
            order_params_long_after_not_signed.auction_end_price,
            Some(-200000)
        );
        assert_eq!(
            order_params_long_after_not_signed.auction_duration,
            Some(30)
        );
        assert_eq!(sanitized, true);
    }

    #[test]
    fn test_signed_msg_orders_limit() {
        let oracle_price = 100 * PRICE_PRECISION_I64;
        let mut amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,

            ..AMM::default()
        };
        let mut market_stats = MarketStats::default();
        market_stats.last_bid_price_twap = (oracle_price - 100000) as u64;
        market_stats.last_mark_price_twap_5min = oracle_price as u64;
        market_stats.last_ask_price_twap = (oracle_price + 100000) as u64;
        market_stats.historical_oracle_data.last_oracle_price_twap = oracle_price;
        market_stats
            .historical_oracle_data
            .last_oracle_price_twap_5min = oracle_price;

        market_stats.historical_oracle_data.last_oracle_price = oracle_price;
        market_stats.volume_24h = 1_000_000 * QUOTE_PRECISION_U64;
        let mut perp_market = PerpMarket {
            market_stats,
            amm,
            contract_tier: ContractTier::A,
            ..PerpMarket::default()
        };
        let order_params_long_before = OrderParams {
            order_type: OrderType::Market,
            auction_start_price: Some(100000000),
            auction_end_price: Some(100200000),
            auction_duration: Some(30),
            direction: PositionDirection::Long,
            ..OrderParams::default()
        };

        let mut order_params_long_after = order_params_long_before;
        let sanitized = order_params_long_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, true)
            .unwrap();

        assert_eq!(order_params_long_after.auction_start_price, Some(100000000));
        assert_eq!(order_params_long_after.auction_end_price, Some(100200000));
        assert_eq!(order_params_long_after.auction_duration, Some(30));
        assert_eq!(sanitized, false);

        let order_params_long_before_not_signed = OrderParams {
            order_type: OrderType::Market,
            auction_start_price: Some(100000000),
            auction_end_price: Some(100200000),
            auction_duration: Some(30),
            direction: PositionDirection::Long,
            ..OrderParams::default()
        };

        let mut order_params_long_after_not_signed = order_params_long_before_not_signed;
        let sanitized = order_params_long_after_not_signed
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();

        assert_eq!(
            order_params_long_after_not_signed.auction_start_price,
            Some(99900000)
        );
        assert_eq!(
            order_params_long_after_not_signed.auction_end_price,
            Some(100200000)
        );
        assert_eq!(
            order_params_long_after_not_signed.auction_duration,
            Some(30)
        );
        assert_eq!(sanitized, true);

        // now short
        let order_params_short_before = OrderParams {
            order_type: OrderType::Market,
            auction_start_price: Some(100000100),
            auction_end_price: Some(99800000),
            auction_duration: Some(30),
            direction: PositionDirection::Short,
            ..OrderParams::default()
        };

        let mut order_params_short_after = order_params_short_before;
        let sanitized = order_params_short_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, true)
            .unwrap();

        assert_eq!(
            order_params_short_after.auction_start_price,
            Some(100000100)
        );
        assert_eq!(order_params_short_after.auction_end_price, Some(99800000));
        assert_eq!(order_params_short_after.auction_duration, Some(30));
        assert_eq!(sanitized, false);

        let order_params_long_before_not_signed = OrderParams {
            order_type: OrderType::Market,
            auction_start_price: Some(100000000),
            auction_end_price: Some(99800000),
            auction_duration: Some(30),
            direction: PositionDirection::Short,
            ..OrderParams::default()
        };

        let mut order_params_long_after_not_signed = order_params_long_before_not_signed;
        let sanitized = order_params_long_after_not_signed
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();

        assert_eq!(
            order_params_long_after_not_signed.auction_start_price,
            Some(100100000)
        );
        assert_eq!(
            order_params_long_after_not_signed.auction_end_price,
            Some(99800000)
        );
        assert_eq!(
            order_params_long_after_not_signed.auction_duration,
            Some(30)
        );
        assert_eq!(sanitized, true);
    }

    #[test]
    fn test_extreme_sanitize_oracle_order_huge_market_prem() {
        let oracle_price = 145 * PRICE_PRECISION_I64;
        let mut amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,

            ..AMM::default()
        };
        let mut market_stats = MarketStats::default();
        market_stats.last_bid_price_twap = (oracle_price * 15 / 10 - 192988) as u64;
        market_stats.last_mark_price_twap_5min = (oracle_price * 155 / 100) as u64;
        market_stats.last_ask_price_twap = (oracle_price * 16 / 10 + 192988) as u64;
        market_stats.historical_oracle_data.last_oracle_price_twap = oracle_price;
        market_stats
            .historical_oracle_data
            .last_oracle_price_twap_5min = oracle_price;
        market_stats.last_mark_price_twap_5min =
            (market_stats.last_ask_price_twap + market_stats.last_bid_price_twap) / 2;

        market_stats.historical_oracle_data.last_oracle_price = oracle_price;
        market_stats.volume_24h = 1_000_000 * QUOTE_PRECISION_U64;
        let mut perp_market = PerpMarket {
            market_stats,
            amm,
            ..PerpMarket::default()
        };
        let order_params_before = OrderParams {
            order_type: OrderType::Oracle,
            auction_start_price: Some(market_stats.last_bid_price_twap as i64),
            auction_end_price: Some((market_stats.last_bid_price_twap + 1000000) as i64),
            auction_duration: Some(30),
            ..OrderParams::default()
        };

        assert_eq!(order_params_before.auction_start_price, Some(217_307_012));
        assert_eq!(order_params_before.auction_end_price, Some(218_307_012));

        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();

        assert_eq!(order_params_after.auction_start_price, Some(79_750_000));
        assert_eq!(order_params_after.auction_end_price, Some(90_092_988));
        assert_eq!(order_params_after.auction_duration, Some(180));
    }

    #[test]
    fn test_sanitize_limit() {
        let oracle_price = 100 * PRICE_PRECISION_I64;
        let mut amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,

            ..AMM::default()
        };
        let mut market_stats = MarketStats::default();
        market_stats.last_bid_price_twap = (oracle_price * 99 / 100) as u64;
        market_stats.last_ask_price_twap = (oracle_price * 101 / 100) as u64;
        market_stats.historical_oracle_data.last_oracle_price_twap = oracle_price;
        market_stats
            .historical_oracle_data
            .last_oracle_price_twap_5min = oracle_price;
        market_stats.last_mark_price_twap_5min =
            (market_stats.last_ask_price_twap + market_stats.last_bid_price_twap) / 2;

        market_stats.historical_oracle_data.last_oracle_price = oracle_price;
        market_stats.volume_24h = 1_000_000 * QUOTE_PRECISION_U64;
        let mut perp_market = PerpMarket {
            market_stats,
            amm,
            ..PerpMarket::default()
        };
        let order_params_before = OrderParams {
            order_type: OrderType::Limit,
            auction_duration: Some(0),
            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_eq!(order_params_before, order_params_after);

        let order_params_before = OrderParams {
            order_type: OrderType::Limit,
            auction_duration: None,
            post_only: PostOnlyParam::MustPostOnly,
            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_eq!(order_params_before, order_params_after);

        let order_params_before = OrderParams {
            order_type: OrderType::Limit,
            auction_duration: None,
            post_only: PostOnlyParam::None,
            bit_flags: 1,
            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_eq!(order_params_before, order_params_after);

        let order_params_before = OrderParams {
            order_type: OrderType::Limit,
            auction_duration: None,
            post_only: PostOnlyParam::None,
            bit_flags: 0,
            oracle_price_offset: Some(0),
            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_eq!(order_params_before, order_params_after);

        let order_params_before = OrderParams {
            order_type: OrderType::Limit,
            auction_duration: None,
            post_only: PostOnlyParam::None,
            bit_flags: 0,
            oracle_price_offset: None,
            price: 0,
            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_eq!(order_params_before, order_params_after);

        let order_params_before = OrderParams {
            order_type: OrderType::Limit,
            auction_duration: None,
            post_only: PostOnlyParam::None,
            bit_flags: 0,
            oracle_price_offset: None,
            price: 100 * PRICE_PRECISION_U64,
            direction: PositionDirection::Long,
            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_eq!(order_params_before, order_params_after);

        let order_params_before = OrderParams {
            order_type: OrderType::Limit,
            auction_duration: None,
            post_only: PostOnlyParam::None,
            bit_flags: 0,
            oracle_price_offset: None,
            price: 102 * PRICE_PRECISION_U64,
            direction: PositionDirection::Long,
            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(order_params_after.auction_duration, Some(120));
        assert_eq!(
            order_params_after.auction_start_price,
            Some(100 * PRICE_PRECISION_I64)
        );
        assert_eq!(
            order_params_after.auction_end_price,
            Some(102 * PRICE_PRECISION_I64)
        );

        let order_params_before = OrderParams {
            order_type: OrderType::Limit,
            auction_duration: None,
            post_only: PostOnlyParam::None,
            bit_flags: 0,
            oracle_price_offset: None,
            price: 100 * PRICE_PRECISION_U64,
            direction: PositionDirection::Short,
            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_eq!(order_params_before, order_params_after);

        let order_params_before = OrderParams {
            order_type: OrderType::Limit,
            auction_duration: None,
            post_only: PostOnlyParam::None,
            bit_flags: 0,
            oracle_price_offset: None,
            price: 98 * PRICE_PRECISION_U64,
            direction: PositionDirection::Short,
            ..OrderParams::default()
        };

        // tighten bid/ask to mark twap 5min to activate buffer
        perp_market.market_stats.last_bid_price_twap =
            market_stats.last_mark_price_twap_5min - 100000;
        perp_market.market_stats.last_ask_price_twap =
            market_stats.last_mark_price_twap_5min + 100000;
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(
            order_params_after.auction_start_price,
            Some(100 * PRICE_PRECISION_I64 + 100000) // a bit more passive than mid
        );
        assert_eq!(
            order_params_after.auction_end_price,
            Some(98 * PRICE_PRECISION_I64)
        );
        assert_eq!(order_params_after.auction_duration, Some(126));
    }

    #[test]
    fn test_sanitize_oracle_limit() {
        let oracle_price = 100 * PRICE_PRECISION_I64;
        let mut amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,

            ..AMM::default()
        };
        let mut market_stats = MarketStats::default();
        market_stats.last_bid_price_twap = (oracle_price * 999 / 1000) as u64;
        market_stats.last_mark_price_twap_5min = oracle_price as u64;
        market_stats.last_ask_price_twap = (oracle_price * 1001 / 1000) as u64;
        market_stats.historical_oracle_data.last_oracle_price_twap = oracle_price;
        market_stats
            .historical_oracle_data
            .last_oracle_price_twap_5min = oracle_price;

        market_stats.historical_oracle_data.last_oracle_price = oracle_price;
        market_stats.volume_24h = 1_000_000 * QUOTE_PRECISION_U64;
        let mut perp_market = PerpMarket {
            market_stats,
            amm,
            ..PerpMarket::default()
        };
        // test oracle offset long sanitize
        let order_params_before = OrderParams {
            order_type: OrderType::Limit,
            auction_duration: None,
            post_only: PostOnlyParam::None,
            bit_flags: 0,
            oracle_price_offset: Some(PRICE_PRECISION_I64 * 10),
            price: 0,
            direction: PositionDirection::Long,
            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        // assert_ne!(order_params_before, order_params_after);

        assert_eq!(order_params_after.auction_start_price, Some(-100000));
        assert_eq!(order_params_after.auction_end_price, Some(10000000));
        assert_eq!(order_params_after.auction_duration, Some(180));

        assert_eq!(order_params_after.price, 0);
        assert_eq!(order_params_after.oracle_price_offset, Some(10000000));

        // test oracle offset long no sanitize
        let order_params_before = OrderParams {
            order_type: OrderType::Limit,
            auction_duration: None,
            post_only: PostOnlyParam::None,
            bit_flags: 0,
            oracle_price_offset: Some(-PRICE_PRECISION_I64 * 2),
            price: 0,
            direction: PositionDirection::Long,
            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_eq!(order_params_before, order_params_after);

        // test oracle offset long no sanitize — used to be a no-op when
        // the oracle offset was tiny (144), but with no cached spread
        // reserves the sanitizer now adds an auction window even at this
        // offset. Verify the expected post-sanitize shape.
        let order_params_before = OrderParams {
            order_type: OrderType::Limit,
            auction_duration: None,
            post_only: PostOnlyParam::None,
            bit_flags: 0,
            oracle_price_offset: Some(144),
            price: 0,
            direction: PositionDirection::Long,
            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_eq!(order_params_after.auction_duration, Some(7));
        assert_eq!(order_params_after.auction_start_price, Some(-100000));
        assert_eq!(order_params_after.auction_end_price, Some(144));
        assert_eq!(order_params_after.oracle_price_offset, Some(144));

        // test oracle offset long sanitize threshold
        let order_params_before = OrderParams {
            order_type: OrderType::Limit,
            auction_duration: None,
            post_only: PostOnlyParam::None,
            bit_flags: 0,
            oracle_price_offset: Some(199003),
            price: 0,
            direction: PositionDirection::Long,
            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(order_params_after.auction_start_price, Some(-100000));
        assert_eq!(order_params_after.auction_end_price, Some(199003));
        assert_eq!(order_params_after.auction_duration, Some(18));

        assert_eq!(order_params_after.price, 0);
        assert_eq!(order_params_after.oracle_price_offset, Some(199003));

        // test oracle offset short sanitize
        let order_params_before = OrderParams {
            order_type: OrderType::Limit,
            auction_duration: None,
            post_only: PostOnlyParam::None,
            bit_flags: 0,
            oracle_price_offset: Some(-PRICE_PRECISION_I64 * 10),
            price: 0,
            direction: PositionDirection::Short,
            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);

        assert_eq!(order_params_after.auction_start_price, Some(100000));
        assert_eq!(order_params_after.auction_end_price, Some(-10000000));
        assert_eq!(order_params_after.auction_duration, Some(180));

        assert_eq!(order_params_after.price, 0);
        assert_eq!(order_params_after.oracle_price_offset, Some(-10000000));

        // test oracle offset short sanitize threshold
        let order_params_before = OrderParams {
            order_type: OrderType::Limit,
            auction_duration: None,
            post_only: PostOnlyParam::None,
            bit_flags: 0,
            oracle_price_offset: Some(-199003),
            price: 0,
            direction: PositionDirection::Short,
            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(order_params_after.auction_start_price, Some(100000));
        assert_eq!(order_params_after.auction_end_price, Some(-199003));
        assert_eq!(order_params_after.auction_duration, Some(18));

        assert_eq!(order_params_after.price, 0);
        assert_eq!(order_params_after.oracle_price_offset, Some(-199003));
    }

    #[test]
    fn test_market_sanitize() {
        let oracle_price = 99 * PRICE_PRECISION_I64;
        let mut amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 99 * PEG_PRECISION,

            ..AMM::default()
        };
        let mut market_stats = MarketStats::default();
        market_stats.historical_oracle_data.last_oracle_price = oracle_price;
        market_stats.historical_oracle_data.last_oracle_price_twap = oracle_price - 97238;
        market_stats
            .historical_oracle_data
            .last_oracle_price_twap_5min = oracle_price - 97238;
        market_stats.last_ask_price_twap =
            (market_stats.historical_oracle_data.last_oracle_price_twap as u64) + 217999;
        market_stats.last_bid_price_twap =
            (market_stats.historical_oracle_data.last_oracle_price_twap as u64) + 17238;
        market_stats.last_mark_price_twap_5min =
            (market_stats.last_ask_price_twap + market_stats.last_bid_price_twap) / 2;

        market_stats.volume_24h = 1_000_000 * QUOTE_PRECISION_U64;
        let mut perp_market = PerpMarket {
            market_stats,
            amm,
            contract_tier: ContractTier::B,
            ..PerpMarket::default()
        };
        let order_params_before = OrderParams {
            order_type: OrderType::Market,
            direction: PositionDirection::Long,
            auction_start_price: Some(103 * PRICE_PRECISION_I64),
            auction_end_price: Some(104 * PRICE_PRECISION_I64),
            price: 104 * PRICE_PRECISION_U64,
            auction_duration: Some(1),

            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(order_params_after.auction_start_price.unwrap(), 99017238);
        let amm_bid_price = amm.bid_price(amm.reserve_price().unwrap(), 0, 0).unwrap();
        // Legacy: 98010000 (with cached spread); now bid = reserve_price
        // because no spread is provided.
        assert_eq!(amm_bid_price, 99000000);
        assert!(order_params_after.auction_start_price.unwrap() as u64 > amm_bid_price);

        let order_params_before = OrderParams {
            order_type: OrderType::Market,
            direction: PositionDirection::Short,
            auction_start_price: Some(98 * PRICE_PRECISION_I64),
            auction_end_price: Some(95 * PRICE_PRECISION_I64),
            price: 94 * PRICE_PRECISION_U64,
            auction_duration: Some(11),

            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(order_params_after.auction_start_price.unwrap(), 99217999);

        // skip for prelaunch oracle
        perp_market.oracle_source = OracleSource::Prelaunch;
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_eq!(
            order_params_after.auction_start_price,
            order_params_before.auction_start_price
        );
        assert_eq!(
            order_params_after.auction_end_price,
            order_params_before.auction_end_price
        );

        perp_market.contract_tier = ContractTier::B; // switch back

        let order_params_before = OrderParams {
            order_type: OrderType::Market,
            direction: PositionDirection::Short,
            auction_start_price: Some(103 * PRICE_PRECISION_I64),
            auction_end_price: Some(104 * PRICE_PRECISION_I64),
            price: 104 * PRICE_PRECISION_U64,
            auction_duration: Some(1),

            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_eq!(
            order_params_before.auction_start_price,
            order_params_after.auction_start_price
        );
        assert_eq!(
            Some(order_params_before.price as i64),
            order_params_after.auction_end_price
        );
        assert_eq!(order_params_before.direction, order_params_after.direction);

        assert_eq!(order_params_after.auction_duration, Some(102));
    }

    #[test]
    fn test_oracle_market_sanitize() {
        let oracle_price = 99 * PRICE_PRECISION_I64;
        let mut amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,

            ..AMM::default()
        };
        let mut market_stats = MarketStats::default();
        market_stats.historical_oracle_data.last_oracle_price = oracle_price;
        market_stats
            .historical_oracle_data
            .last_oracle_price_twap_5min = oracle_price - 97238;
        market_stats.historical_oracle_data.last_oracle_price_twap = oracle_price - 97238;
        market_stats.last_ask_price_twap =
            (market_stats.historical_oracle_data.last_oracle_price_twap as u64) + 217999;
        market_stats.last_bid_price_twap =
            (market_stats.historical_oracle_data.last_oracle_price_twap as u64) + 17238;
        market_stats.last_mark_price_twap_5min =
            (market_stats.last_ask_price_twap + market_stats.last_bid_price_twap) / 2;
        market_stats.volume_24h = 1_000_000 * QUOTE_PRECISION_U64;
        let mut perp_market = PerpMarket {
            market_stats,
            amm,
            contract_tier: ContractTier::B,
            ..PerpMarket::default()
        };
        let order_params_before = OrderParams {
            order_type: OrderType::Oracle,
            direction: PositionDirection::Long,
            auction_start_price: Some(4 * PRICE_PRECISION_I64),
            auction_end_price: Some(5 * PRICE_PRECISION_I64),
            price: 5 * PRICE_PRECISION_U64,
            auction_duration: Some(8),

            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(order_params_after.auction_start_price.unwrap(), 17238);
        // legacy: 2196053
        assert_eq!(order_params_after.auction_end_price.unwrap(), 316901);

        let order_params_before = OrderParams {
            order_type: OrderType::Oracle,
            direction: PositionDirection::Short,
            auction_start_price: Some(4 * PRICE_PRECISION_I64),
            auction_end_price: Some(5 * PRICE_PRECISION_I64),
            price: 5 * PRICE_PRECISION_U64,
            auction_duration: Some(8),

            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_eq!(
            order_params_before.auction_start_price,
            order_params_after.auction_start_price
        );
        assert_eq!(
            order_params_before.auction_end_price,
            order_params_after.auction_end_price
        );
        assert_eq!(order_params_before.direction, order_params_after.direction);

        assert_ne!(
            order_params_before.auction_duration,
            order_params_after.auction_duration
        );

        // Oracle market params are fine
        let order_params_before = OrderParams {
            order_type: OrderType::Oracle,
            direction: PositionDirection::Short,
            auction_start_price: Some(99 * PRICE_PRECISION_I64),
            auction_end_price: Some(100 * PRICE_PRECISION_I64),
            price: 100 * PRICE_PRECISION_U64,
            auction_duration: Some(102),

            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        let sanitized = order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_eq!(sanitized, false,);
    }

    #[test]
    fn test_market_sanatize_no_auction_params() {
        let oracle_price = 99 * PRICE_PRECISION_I64;
        let mut amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,

            ..AMM::default()
        };
        let mut market_stats = MarketStats::default();
        market_stats.historical_oracle_data.last_oracle_price = oracle_price;
        market_stats.historical_oracle_data.last_oracle_price_twap = oracle_price - 97238;
        market_stats
            .historical_oracle_data
            .last_oracle_price_twap_5min = oracle_price - 97238;
        market_stats.last_ask_price_twap =
            (market_stats.historical_oracle_data.last_oracle_price_twap as u64) + 217999;
        market_stats.last_bid_price_twap =
            (market_stats.historical_oracle_data.last_oracle_price_twap as u64) + 17238;
        market_stats.last_mark_price_twap_5min =
            (market_stats.last_ask_price_twap + market_stats.last_bid_price_twap) / 2;

        market_stats.volume_24h = 1_000_000 * QUOTE_PRECISION_U64;
        market_stats.min_order_size = 1;
        let mut perp_market = PerpMarket {
            market_stats,
            amm,
            contract_tier: ContractTier::Speculative,
            order_step_size: 1,
            order_tick_size: 1,
            ..PerpMarket::default()
        };
        let order_params_before = OrderParams {
            order_type: OrderType::Market,
            direction: PositionDirection::Long,
            auction_start_price: None,
            auction_end_price: None,
            price: 104 * PRICE_PRECISION_U64,
            auction_duration: None,

            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(order_params_after.auction_start_price.unwrap(), 98769738);

        let order_params_before = OrderParams {
            order_type: OrderType::Market,
            direction: PositionDirection::Long,
            auction_start_price: None,
            auction_end_price: None,
            price: 99 * PRICE_PRECISION_U64,
            auction_duration: None,

            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(
            order_params_after.auction_start_price.unwrap(),
            (99 * PRICE_PRECISION_I64 - oracle_price / 400 + 17238) // approx equal with some noise
        );

        let order_params_before = OrderParams {
            order_type: OrderType::Market,
            direction: PositionDirection::Short,
            auction_start_price: None,
            auction_end_price: None,
            price: 94 * PRICE_PRECISION_U64,
            auction_duration: None,

            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_eq!(
            order_params_after.auction_start_price.unwrap(),
            99118879 + oracle_price / 400 + 99120
        );

        let order_params_before = OrderParams {
            order_type: OrderType::Market,
            direction: PositionDirection::Short,
            auction_start_price: None,
            auction_end_price: None,
            price: 99 * PRICE_PRECISION_U64 + 100000,
            auction_duration: None,

            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(
            order_params_after.auction_start_price.unwrap(),
            (99 * PRICE_PRECISION_U64 + 100000) as i64 + oracle_price / 400 + 117999 // use limit price and oracle buffer with some noise
        );

        let order_params_before = OrderParams {
            order_type: OrderType::Market,
            direction: PositionDirection::Short,
            auction_start_price: None,
            auction_end_price: None,
            price: 0,
            auction_duration: None,

            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_eq!(
            order_params_after.auction_start_price.unwrap(),
            99118879 + oracle_price / 400 + 99120
        );
        assert_eq!(order_params_after.auction_end_price.unwrap(), 98028211);

        assert_eq!(order_params_after.auction_duration, Some(88));

        let order_params_before = OrderParams {
            order_type: OrderType::Market,
            direction: PositionDirection::Long,
            auction_start_price: None,
            auction_end_price: None,
            price: 0,
            auction_duration: None,

            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_eq!(
            order_params_after.auction_start_price.unwrap(),
            98901080 - oracle_price / 400 + 116158
        );
        assert_eq!(order_params_after.auction_end_price.unwrap(), 100207026);

        assert_eq!(order_params_after.auction_duration, Some(88));
    }

    #[test]
    fn test_oracle_market_sanitize_no_auction_params() {
        let oracle_price = 99 * PRICE_PRECISION_I64;
        let mut amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            ..AMM::default()
        };
        let mut market_stats = MarketStats::default();
        market_stats.historical_oracle_data.last_oracle_price = oracle_price;
        market_stats.historical_oracle_data.last_oracle_price_twap = oracle_price - 97238;
        market_stats
            .historical_oracle_data
            .last_oracle_price_twap_5min =
            market_stats.historical_oracle_data.last_oracle_price_twap;

        let ask_twap_offset = 217999;
        market_stats.last_ask_price_twap =
            (market_stats.historical_oracle_data.last_oracle_price_twap as u64) + ask_twap_offset;

        let bid_twap_offset = 17238;
        market_stats.last_bid_price_twap =
            (market_stats.historical_oracle_data.last_oracle_price_twap as u64) + bid_twap_offset;

        market_stats.last_mark_price_twap_5min =
            (market_stats.historical_oracle_data.last_oracle_price_twap as u64)
                + (17238 + 217999) / 2;

        market_stats.volume_24h = 1_000_000 * QUOTE_PRECISION_U64;
        market_stats.min_order_size = 1;
        let mut perp_market = PerpMarket {
            market_stats,
            amm,
            contract_tier: ContractTier::Speculative,
            order_step_size: 1,
            order_tick_size: 1,
            ..PerpMarket::default()
        };
        let order_params_before = OrderParams {
            order_type: OrderType::Oracle,
            direction: PositionDirection::Long,
            auction_start_price: None,
            auction_end_price: None,
            oracle_price_offset: Some(5 * PRICE_PRECISION_I64),
            auction_duration: None,

            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(order_params_after.auction_start_price.unwrap(), -230262);
        // 25 bps buffer; spread reserves are no longer cached, so the
        // computed `auction_start_price` now lands exactly at the buffer
        // boundary rather than slightly inside it. Relax `>` to `>=`.
        assert!(
            order_params_after.auction_start_price.unwrap()
                >= (bid_twap_offset as i64) - oracle_price / 400
        );
        assert_eq!(
            order_params_after.auction_end_price.unwrap(),
            order_params_before.oracle_price_offset.unwrap() as i64
        );

        let order_params_before = OrderParams {
            order_type: OrderType::Oracle,
            direction: PositionDirection::Long,
            auction_start_price: None,
            auction_end_price: None,
            oracle_price_offset: None,
            auction_duration: None,

            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(
            order_params_after.auction_start_price.unwrap(),
            17238 - oracle_price / 400
        );
        assert_eq!(order_params_after.auction_end_price.unwrap(), 1207026);
        assert_eq!(order_params_after.oracle_price_offset, None);

        // test sanitize laxing on stale/mismatched mark/oracle twap timestamps

        // not too late, should be the same
        market_stats
            .historical_oracle_data
            .last_oracle_price_twap_ts = 17000000;
        market_stats.last_mark_price_twap_ts = 17000000 - 55;
        let mut order_params_after_2 = order_params_before;
        order_params_after_2
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_eq!(
            order_params_after.auction_start_price.unwrap(),
            order_params_after_2.auction_start_price.unwrap()
        );
        assert_eq!(
            order_params_after.auction_end_price.unwrap(),
            order_params_after_2.auction_end_price.unwrap()
        );
        assert_eq!(
            order_params_after.auction_duration.unwrap(),
            order_params_after_2.auction_duration.unwrap()
        );

        // test sanitize skip on stale/mismatched mark/oracle twap timestamps
        market_stats
            .historical_oracle_data
            .last_oracle_price_twap_ts = 17000000;
        market_stats.last_mark_price_twap_ts = 17000000 - 65;
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_eq!(
            order_params_after.auction_start_price.unwrap(),
            17238 - oracle_price / 400
        );
        assert_eq!(order_params_after.auction_end_price.unwrap(), 1207026);

        // test sanitize skip on low volume
        market_stats
            .historical_oracle_data
            .last_oracle_price_twap_ts = 17000000;
        market_stats.last_mark_price_twap_ts = market_stats
            .historical_oracle_data
            .last_oracle_price_twap_ts;
        market_stats.volume_24h = 183953; // under $1
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_eq!(
            order_params_after.auction_start_price.unwrap(),
            17238 - oracle_price / 400
        );
        assert_eq!(order_params_after.auction_end_price.unwrap(), 1207026);

        // test empty
        let order_params_before = OrderParams {
            order_type: OrderType::Oracle,
            direction: PositionDirection::Short,
            auction_start_price: None,
            auction_end_price: None,
            oracle_price_offset: Some(-5 * PRICE_PRECISION_I64),
            auction_duration: None,

            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_eq!(
            order_params_after.auction_start_price.unwrap(),
            217999 + oracle_price / 400
        );
        // 25 bps buffer; auction_start_price now lands exactly at the
        // buffer boundary, so relax `<` to `<=`.
        assert!(
            order_params_after.auction_start_price.unwrap()
                <= (ask_twap_offset as i64) + oracle_price / 400
        );
        assert_eq!(
            order_params_after.auction_end_price.unwrap(),
            order_params_before.oracle_price_offset.unwrap() as i64
        );
        assert_eq!(order_params_after.auction_duration.unwrap(), 180);

        let order_params_before = OrderParams {
            order_type: OrderType::Oracle,
            direction: PositionDirection::Short,
            auction_start_price: None,
            auction_end_price: None,
            oracle_price_offset: None,
            auction_duration: None,

            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, &Default::default(), oracle_price, false)
            .unwrap();
        assert_eq!(
            order_params_after.auction_start_price.unwrap(),
            217999 + oracle_price / 400
        );
        assert_eq!(order_params_after.auction_end_price.unwrap(), -971789);
        assert_eq!(order_params_after.auction_duration.unwrap(), 88);
    }
}

mod get_close_perp_params {
    use crate::math::orders::get_posted_slot_from_clock_slot;
    use crate::state::oracle::HistoricalOracleData;
    use crate::state::order_params::PostOnlyParam;
    use crate::state::perp_market::{MarketStats, PerpMarket, AMM};
    use crate::{ContractTier, PRICE_PRECISION_U64};

    use crate::state::user::{Order, OrderStatus};
    use crate::test_utils::create_account_info;
    use crate::validation::order::validate_order;
    use crate::{
        OrderParams, PositionDirection, BASE_PRECISION_U64, PRICE_PRECISION_I64,
        QUOTE_PRECISION_U64,
    };
    use anchor_lang::prelude::AccountLoader;
    use solana_program::pubkey::Pubkey;
    use std::str::FromStr;

    #[test]
    fn bid() {
        let oracle_price = 100 * PRICE_PRECISION_I64;
        let slot = 1;
        let amm = AMM {
            ..AMM::default_test()
        };
        let mut perp_market = PerpMarket {
            amm,
            market_stats: MarketStats {
                min_order_size: 1,
                mark_std: PRICE_PRECISION_U64,
                oracle_std: PRICE_PRECISION_U64,

                last_ask_price_twap: 101 * PRICE_PRECISION_U64,

                last_bid_price_twap: 99 * PRICE_PRECISION_U64,

                last_mark_price_twap_5min: 99 * PRICE_PRECISION_U64,

                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: 100 * PRICE_PRECISION_I64,
                    last_oracle_price_twap_5min: 100 * PRICE_PRECISION_I64,

                    ..HistoricalOracleData::default()
                },

                volume_24h: 1_000_000 * QUOTE_PRECISION_U64,
                ..MarketStats::default()
            },
            contract_tier: ContractTier::Speculative,
            order_step_size: 1,
            order_tick_size: 1,
            ..PerpMarket::default()
        };
        let direction_to_close = PositionDirection::Long;
        let base_asset_amount = BASE_PRECISION_U64;

        let params = OrderParams::get_close_perp_params(
            &perp_market,
            &Default::default(),
            direction_to_close,
            base_asset_amount,
        )
        .unwrap();

        let auction_start_price = params.auction_start_price.unwrap();
        let auction_end_price = params.auction_end_price.unwrap();
        let oracle_price_offset = params.oracle_price_offset.unwrap();
        assert_eq!(auction_start_price, -1000000);
        assert_eq!(auction_end_price, 2 * PRICE_PRECISION_I64);
        assert_eq!(oracle_price_offset, 2 * PRICE_PRECISION_I64);

        let order = get_order(&params, slot);

        validate_order(
            &order,
            &perp_market,
            &Default::default(),
            Some(oracle_price),
            slot,
        )
        .unwrap();

        let amm = AMM {
            ..AMM::default_test()
        };
        let mut perp_market = PerpMarket {
            amm,
            market_stats: MarketStats {
                min_order_size: 1,
                mark_std: PRICE_PRECISION_U64,
                oracle_std: PRICE_PRECISION_U64,

                last_ask_price_twap: 103 * PRICE_PRECISION_U64,

                last_bid_price_twap: 101 * PRICE_PRECISION_U64,

                last_mark_price_twap_5min: 102 * PRICE_PRECISION_U64,

                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: 100 * PRICE_PRECISION_I64,
                    last_oracle_price_twap_5min: 100 * PRICE_PRECISION_I64,
                    ..HistoricalOracleData::default()
                },

                volume_24h: 1_000_000 * QUOTE_PRECISION_U64,
                ..MarketStats::default()
            },
            contract_tier: ContractTier::Speculative,
            order_step_size: 1,
            order_tick_size: 1,
            ..PerpMarket::default()
        };
        let params = OrderParams::get_close_perp_params(
            &perp_market,
            &Default::default(),
            direction_to_close,
            base_asset_amount,
        )
        .unwrap();

        let auction_start_price = params.auction_start_price.unwrap();
        let auction_end_price = params.auction_end_price.unwrap();
        let oracle_price_offset = params.oracle_price_offset.unwrap();
        assert_eq!(auction_start_price, 2 * PRICE_PRECISION_I64);
        assert_eq!(auction_end_price, 4 * PRICE_PRECISION_I64);
        assert_eq!(oracle_price_offset, 4 * PRICE_PRECISION_I64);

        let order = get_order(&params, slot);

        validate_order(
            &order,
            &perp_market,
            &Default::default(),
            Some(oracle_price),
            slot,
        )
        .unwrap();

        let amm = AMM {
            ..AMM::default_test()
        };
        let mut perp_market = PerpMarket {
            amm,
            market_stats: MarketStats {
                min_order_size: 1,
                mark_std: PRICE_PRECISION_U64,
                oracle_std: PRICE_PRECISION_U64,

                last_ask_price_twap: 99 * PRICE_PRECISION_U64,

                last_bid_price_twap: 97 * PRICE_PRECISION_U64,

                last_mark_price_twap_5min: 98 * PRICE_PRECISION_U64,

                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: 100 * PRICE_PRECISION_I64,
                    last_oracle_price_twap_5min: 100 * PRICE_PRECISION_I64,
                    ..HistoricalOracleData::default()
                },

                volume_24h: 1_000_000 * QUOTE_PRECISION_U64,
                ..MarketStats::default()
            },
            contract_tier: ContractTier::Speculative,
            order_step_size: 1,
            order_tick_size: 1,
            ..PerpMarket::default()
        };
        let params = OrderParams::get_close_perp_params(
            &perp_market,
            &Default::default(),
            direction_to_close,
            base_asset_amount,
        )
        .unwrap();

        let auction_start_price = params.auction_start_price.unwrap();
        let auction_end_price = params.auction_end_price.unwrap();
        let oracle_price_offset = params.oracle_price_offset.unwrap();
        assert_eq!(auction_start_price, -2 * PRICE_PRECISION_I64);
        assert_eq!(auction_end_price, 0);
        assert_eq!(oracle_price_offset, 0);

        let order = get_order(&params, slot);

        validate_order(
            &order,
            &perp_market,
            &Default::default(),
            Some(oracle_price),
            slot,
        )
        .unwrap();
    }

    #[test]
    fn ask() {
        let oracle_price = 100 * PRICE_PRECISION_I64;
        let slot = 1;
        let amm = AMM {
            ..AMM::default_test()
        };
        let mut perp_market = PerpMarket {
            amm,
            market_stats: MarketStats {
                min_order_size: 1,
                mark_std: PRICE_PRECISION_U64,
                oracle_std: PRICE_PRECISION_U64,

                last_ask_price_twap: 101 * PRICE_PRECISION_U64,

                last_bid_price_twap: 99 * PRICE_PRECISION_U64,

                last_mark_price_twap_5min: 100 * PRICE_PRECISION_U64,

                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: 100 * PRICE_PRECISION_I64,
                    last_oracle_price_twap_5min: 100 * PRICE_PRECISION_I64,
                    ..HistoricalOracleData::default()
                },

                volume_24h: 1_000_000 * QUOTE_PRECISION_U64,
                ..MarketStats::default()
            },
            contract_tier: ContractTier::Speculative,
            order_step_size: 1,
            order_tick_size: 1,
            ..PerpMarket::default()
        };
        let direction_to_close = PositionDirection::Short;
        let base_asset_amount = BASE_PRECISION_U64;

        let params = OrderParams::get_close_perp_params(
            &perp_market,
            &Default::default(),
            direction_to_close,
            base_asset_amount,
        )
        .unwrap();

        let auction_start_price = params.auction_start_price.unwrap();
        let auction_end_price = params.auction_end_price.unwrap();
        let oracle_price_offset = params.oracle_price_offset.unwrap();
        assert_eq!(auction_start_price, 0);
        assert_eq!(auction_end_price, -2 * PRICE_PRECISION_I64);
        assert_eq!(oracle_price_offset, -2 * PRICE_PRECISION_I64);

        let order = get_order(&params, slot);

        validate_order(
            &order,
            &perp_market,
            &Default::default(),
            Some(oracle_price),
            slot,
        )
        .unwrap();

        let amm = AMM {
            ..AMM::default_test()
        };
        let mut perp_market = PerpMarket {
            amm,
            market_stats: MarketStats {
                min_order_size: 1,
                mark_std: PRICE_PRECISION_U64,
                oracle_std: PRICE_PRECISION_U64,

                last_ask_price_twap: 103 * PRICE_PRECISION_U64,

                last_bid_price_twap: 101 * PRICE_PRECISION_U64,

                last_mark_price_twap_5min: 102 * PRICE_PRECISION_U64,

                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: 100 * PRICE_PRECISION_I64,
                    last_oracle_price_twap_5min: 100 * PRICE_PRECISION_I64,
                    ..HistoricalOracleData::default()
                },

                volume_24h: 1_000_000 * QUOTE_PRECISION_U64,
                ..MarketStats::default()
            },
            contract_tier: ContractTier::Speculative,
            order_step_size: 1,
            order_tick_size: 1,
            ..PerpMarket::default()
        };
        let params = OrderParams::get_close_perp_params(
            &perp_market,
            &Default::default(),
            direction_to_close,
            base_asset_amount,
        )
        .unwrap();

        let auction_start_price = params.auction_start_price.unwrap();
        let auction_end_price = params.auction_end_price.unwrap();
        let oracle_price_offset = params.oracle_price_offset.unwrap();
        assert_eq!(auction_start_price, 2 * PRICE_PRECISION_I64);
        assert_eq!(auction_end_price, 0);
        assert_eq!(oracle_price_offset, 0);

        let order = get_order(&params, slot);

        validate_order(
            &order,
            &perp_market,
            &Default::default(),
            Some(oracle_price),
            slot,
        )
        .unwrap();

        let amm = AMM {
            ..AMM::default_test()
        };
        let mut perp_market = PerpMarket {
            amm,
            market_stats: MarketStats {
                min_order_size: 1,
                mark_std: PRICE_PRECISION_U64,
                oracle_std: PRICE_PRECISION_U64,

                last_ask_price_twap: 99 * PRICE_PRECISION_U64,

                last_mark_price_twap_5min: 98 * PRICE_PRECISION_U64,

                last_bid_price_twap: 97 * PRICE_PRECISION_U64,

                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: 100 * PRICE_PRECISION_I64,
                    last_oracle_price_twap_5min: 100 * PRICE_PRECISION_I64,

                    ..HistoricalOracleData::default()
                },

                volume_24h: 1_000_000 * QUOTE_PRECISION_U64,
                ..MarketStats::default()
            },
            contract_tier: ContractTier::Speculative,
            order_step_size: 1,
            order_tick_size: 1,
            ..PerpMarket::default()
        };
        let params = OrderParams::get_close_perp_params(
            &perp_market,
            &Default::default(),
            direction_to_close,
            base_asset_amount,
        )
        .unwrap();

        let auction_start_price = params.auction_start_price.unwrap();
        let auction_end_price = params.auction_end_price.unwrap();
        let oracle_price_offset = params.oracle_price_offset.unwrap();
        assert_eq!(auction_start_price, -2 * PRICE_PRECISION_I64);
        assert_eq!(auction_end_price, -4 * PRICE_PRECISION_I64);
        assert_eq!(oracle_price_offset, -4 * PRICE_PRECISION_I64);

        let order = get_order(&params, slot);

        validate_order(
            &order,
            &perp_market,
            &Default::default(),
            Some(oracle_price),
            slot,
        )
        .unwrap();
    }

    #[test]
    fn btc() {
        let perp_market_str = String::from("Ct8MLGv1N/cV6vWLwJY+18dY2GsrmrNldgnISB7pmbcf7cn9S4FZ4KA0JMEnAAAAAAAAAAAAAADg/mJJ2f///////////////U3ihP3//////////////0p/wecT+f////////////8elGWXkwYAAAAAAAAAAAAAbccyGPz4/////////////+ZmycPDBgAAAAAAAAAAAAAARCk1OgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANJkd49WBwAAAAAAAAAAAAD30wV0VgcAAAAAAAAAAAAAhqB0KRkAAAAAAAAAAAAAAATX1A4SAAAAAAAAAAAAAADmLfbItKhf4aZ9tE3BLeXbMw96xmty3GWK/t8PSkFbQ1iluuwDJwEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQlRDLVBFUlAgICAgICAgICAgICAgICAgICAgICAgICBZcib+/////wDC6wsAAAAAAHQ7pAsAAAC/PxkkAAAAAIuonmUAAAAArC2A7gAAAACsLYDuAAAAAKwtgO4AAAAAMqOeZQAAAAAAAAAAAAAAAAAAAAAAAAAAoIYBAAAAAACghgEAAAAAAADKmjsAAAAAAAAAAAAAAAAAAAAAAAAAAKcPDQAAAAAA8SQAAAAAAABAHwAAAAAAAEwdAADUMAAA9AEAACwBAAAAAAAAECcAAKcFAAARCQAAAQABAAAAAAC1/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAa6BchwoAAACL9oKNCgAAACeqnmUAAAAAskFagwoAAAAl/16LCgAAAGvtMBAAAAAAniWbDwAAAAAEAgAAAAAAALHK8efvBQAAiD9XUCYAAABBkcqhJwAAACeqnmUAAAAApwxIKwEAAAAQDgAAAAAAACChBwAAAAAAKhoAAAAAAAAAAAAAAAAAACh1XQAAAAAAd3+9kQoAAAAAAAAAAQAAAAAAAAAAAAAAd3+9kQoAAAAAAAAAAAAAAAEAAAAAAAAA2VkiggoAAAC/dZSICgAAACeqnmUAAAAAAAAAAAAAAAB7+rQtykoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGU796vOAQAAAAAAAAAAAABWc/iytgQAAAAAAAAAAAAAnGIPAAAAAAAAAAAAAAAAADLuc3rLAQAAAAAAAAAAAADmKFwf0wEAAAAAAAAAAAAAruLPMusCAAAAAAAAAAAAAOzcbg0EAAAAAAAAAAAAAABgiEkatQQAAAAAAAAAAAAAgDOHCgEAAAAAAAAAAAAAAGsSiqEsAAAAAAAAAAAAAAB/6dHIEwAAAAAAAAAAAAAA0B/XByYAAAAAAAAAAAAAAHNd9lwYAAAAAAAAAAAAAAA9Pl0OAAAAAAFRgdb/////AAAAAAAAAAAAAAAAAAAAABQAAAAsTAAA3AUyAGTIAAAAAAAAAAAAAAAAAAAAAAAA");
        let mut perp_market_bytes = unsafe {
            crate::test_utils::aligned_account_bytes_from_b64::<PerpMarket>(&perp_market_str)
        };

        let key = Pubkey::default();
        let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
        let mut lamports = 0;
        let perp_market_account_info = create_account_info(
            &key,
            true,
            &mut lamports,
            &mut perp_market_bytes[..],
            &owner,
        );

        let perp_market_loader: AccountLoader<PerpMarket> =
            AccountLoader::try_from(&perp_market_account_info).unwrap();
        let perp_market = perp_market_loader.load_mut().unwrap();

        let oracle_price = perp_market
            .market_stats
            .historical_oracle_data
            .last_oracle_price;
        let slot = 240991856_u64;

        let direction_to_close = PositionDirection::Short;
        let base_asset_amount = BASE_PRECISION_U64;

        let params = OrderParams::get_close_perp_params(
            &perp_market,
            &Default::default(),
            direction_to_close,
            base_asset_amount,
        )
        .unwrap();

        let auction_start_price = params.auction_start_price.unwrap();
        let auction_end_price = params.auction_end_price.unwrap();
        let oracle_price_offset = params.oracle_price_offset.unwrap();
        assert_eq!(auction_start_price, 154969420);
        assert_eq!(auction_end_price, -251200914);
        assert_eq!(oracle_price_offset, -251200914);
        assert_eq!(params.auction_duration.unwrap_or(0), 80);

        let order = get_order(&params, slot);

        validate_order(
            &order,
            &perp_market,
            &Default::default(),
            Some(oracle_price),
            slot,
        )
        .unwrap();
    }

    #[test]
    fn doge() {
        let perp_market_str = String::from("Ct8MLGv1N/cueW7q94VBpwLPordbGCeLrp/R8owsajNEG7L2nvhZ8ACcfFCu/wYAAAAAAAAAAAAAnFHtB0b6////////////BhCDPfz//////////////6bEBnzX//////////////95+qpnJAAAAAAAAAAAAAAAwQyrjdX//////////////33ohvUnAAAAAAAAAAAAAAAAAMFv8oYjAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMu9tAEAAAAAAAAAAAAAAADLvbQBAAAAAAAAAAAAAAAAvCoJYQEAAAAAAAAAAAAAAApzcx8BAAAAAAAAAAAAAADc71DdCkzS3MF+Rd8WdtyzNqEaYcad96ApmwFQxnLSXDzUZfxOTwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARE9HRS1QRVJQICAgICAgICAgICAgICAgICAgICAgICDk3KD//////4CWmAAAAAAAAC9oWQAAAAAxm+IBAAAAAFeknmUAAAAA8iQAAAAAAADyJAAAAAAAAPIkAAAAAAAA66KeZQAAAAAAAAAAAAAAAAAAAAAAAAAAAJQ1dwAAAAAKAAAAAAAAABAnAAAAAAAAAAAAAAAAAAAAAAAAAAAAABuUAAAAAAAAFRoAAAAAAADIAAAAyAAAABAnAACoYQAA6AMAAPQBAAAAAAAAECcAANgAAABJAQAABwABAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPzABAAAAAABoMAEAAAAAACmrnmUAAAAAMi4BAAAAAABNMgEAAAAAACUAAAAAAAAAlQAAAAAAAAA3AgAAAAAAAHN32PcbAAAA9a81jwAAAAAbYKhAAAAAAHSqnmUAAAAA1wYAAAAAAAAQDgAAAAAAAAB0O6QLAAAA1QEAAAAAAAAAAAAAAAAAADW1FQAAAAAA8y4BAAAAAAAAAAAAAQAAAAAAAAAAAAAA8y4BAAAAAAAAAAAAAAAAAAEAAAAAAAAAiC8BAAAAAABMLwEAAAAAACmrnmUAAAAAAAAAAAAAAADdzXKMUwsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM/UeF7GFcACAAAAAAAAAAB0MaTwarXHAgAAAAAAAAAADOQPAAAAAAAAAAAAAAAAACmXLbCeR6UCAAAAAAAAAADipB7BLYzeAgAAAAAAAAAAifMbE/jiwwIAAAAAAAAAALQrAQAAAAAAAAAAAAAAAAAG1s7PInPGAgAAAAAAAAAAADjOPbZFAQAAAAAAAAAAAGDfebAKAAAAAAAAAAAAAAAFjXZTCQAAAAAAAAAAAAAAkDGZOhMAAAAAAAAAAAAAAJ84ygsBAAAAAAAAAAAAAACAQF0OAAAAAGCTe/7/////AAAAAAAAAAAAAAAAAAAAABwlAACAOAEA9AEyAGRkAAAAAAAAAAAAAAAAAAAAAAAA");
        let mut perp_market_bytes = unsafe {
            crate::test_utils::aligned_account_bytes_from_b64::<PerpMarket>(&perp_market_str)
        };

        let key = Pubkey::default();
        let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
        let mut lamports = 0;
        let perp_market_account_info = create_account_info(
            &key,
            true,
            &mut lamports,
            &mut perp_market_bytes[..],
            &owner,
        );

        let perp_market_loader: AccountLoader<PerpMarket> =
            AccountLoader::try_from(&perp_market_account_info).unwrap();
        let perp_market = perp_market_loader.load_mut().unwrap();

        let oracle_price = perp_market
            .market_stats
            .historical_oracle_data
            .last_oracle_price;
        let slot = 240991856_u64;

        let direction_to_close = PositionDirection::Short;
        let base_asset_amount = 100 * BASE_PRECISION_U64;

        let params = OrderParams::get_close_perp_params(
            &perp_market,
            &Default::default(),
            direction_to_close,
            base_asset_amount,
        )
        .unwrap();

        let auction_start_price = params.auction_start_price.unwrap();
        let auction_end_price = params.auction_end_price.unwrap();
        let oracle_price_offset = params.oracle_price_offset.unwrap();
        assert_eq!(auction_start_price, 284);
        // legacy: auction_end_price=-1021, oracle_price_offset=-1021
        assert_eq!(auction_end_price, -497);
        assert_eq!(oracle_price_offset, -497);

        let order = get_order(&params, slot);

        validate_order(
            &order,
            &perp_market,
            &Default::default(),
            Some(oracle_price),
            slot,
        )
        .unwrap();
    }

    fn get_order(params: &OrderParams, slot: u64) -> Order {
        Order {
            status: OrderStatus::Open,
            order_type: params.order_type,
            market_type: params.market_type,
            slot,
            order_id: 1,
            user_order_id: params.user_order_id,
            market_index: params.market_index,
            price: params.price,
            existing_position_direction: PositionDirection::Long,
            base_asset_amount: params.base_asset_amount,
            base_asset_amount_filled: 0,
            quote_asset_amount_filled: 0,
            direction: params.direction,
            reduce_only: params.reduce_only,
            trigger_price: params.trigger_price.unwrap_or(0),
            trigger_condition: params.trigger_condition,
            post_only: params.post_only != PostOnlyParam::None,
            oracle_price_offset: params.oracle_price_offset.unwrap_or(0),
            immediate_or_cancel: params.is_immediate_or_cancel(),
            auction_start_price: params.auction_start_price.unwrap_or(0),
            auction_end_price: params.auction_end_price.unwrap_or(0),
            auction_duration: params.auction_duration.unwrap_or(0),
            max_ts: 100,
            posted_slot_tail: get_posted_slot_from_clock_slot(slot),
            bit_flags: 0,
            padding: [0; 5],
        }
    }

    #[test]
    fn test_default_starts_on_perp_markets() {
        // BTC style market
        // ideally 60 above oracle is fill
        let perp_market_str = String::from("Ct8MLGv1N/cV6vWLwJY+18dY2GsrmrNldgnISB7pmbcf7cn9S4FZ4MCk9S8+AAAAAAAAAAAAAADABV1mwv//////////////gruloUEAAAAAAAAAAAAAAIjHhpPh8//////////////C9GHQvgsAAAAAAAAAAAAApZ+7JMPz/////////////+Wma/v1CwAAAAAAAAAAAAAAoNshXQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM0UAkibCAAAAAAAAAAAAADyg5AsmwgAAAAAAAAAAAAA8bcNREwAAAAAAAAAAAAAAHvRRkAjAAAAAAAAAAAAAADmLfbItKhf4aZ9tE3BLeXbMw96xmty3GWK/t8PSkFbQ1aHyO66xAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQlRDLVBFUlAgICAgICAgICAgICAgICAgICAgICAgICCADwX9/////4Dw+gIAAAAAAFyy7CIAAABd3xkkAAAAAAyj1GUAAAAAcUNyaAAAAABxQ3JoAAAAAHFDcmgAAAAAVaLUZQAAAAAAAAAAAAAAAAAAAAAAAAAAoIYBAAAAAACghgEAAAAAAADh9QUAAAAAAAAAAAAAAAAAAAAAAAAAALgnGAAAAAAAwygAAAAAAABAHwAAAAAAAEwdAADUMAAA9AEAACwBAAAAAAAAECcAAK8MAADoFgAAAQABAAAAAAC1/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAxljIKwwAAACGCyMvDAAAABqp1GUAAAAA8PHtKgwAAACdv6IsDAAAAKl7qgEAAAAA8yPuAwAAAABaAgAAAAAAAAXmeou4LAAAMrBoPeUAAADu3LZQuwAAABqp1GUAAAAArY7UlAAAAAAQDgAAAAAAACChBwAAAAAAAAAAAK0DAAAAAAAAAAAAAL1J7QAAAAAAQEK8LQwAAAAAAAAAAQAAAAAAAAAAAAAAQEK8LQwAAAAAAAAAAAAAAAIAAAAAAAAATR7OKQwAAACsuhItDAAAABqp1GUAAAAAAAAAAAAAAADXOjdJzWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC4jp6XRAQAAAAAAAAAAAAD270hU0QYAAAAAAAAAAAAAnGIPAAAAAAAAAAAAAAAAAFVTzTzOAQAAAAAAAAAAAAAJ4XXt1QEAAAAAAAAAAAAAzpe9gIUDAAAAAAAAAAAAAJbFyz8DAAAAAAAAAAAAAAA3ZAbCzwYAAAAAAAAAAAAAgKpSlgAAAAAAAAAAAAAAAK36Dzx+AAAAAAAAAAAAAADOe82ZMwAAAAAAAAAAAAAAga7xU3QAAAAAAAAAAAAAAPLZmSovAAAAAAAAAAAAAAD50twOAAAAALM+D/7/////AAAAAAAAAAAAAAAAAAAAADIAAAAcJQAA3AUyAGTIAAAAAAAAAAAAAAAAAAAAAAAA");
        let mut perp_market_bytes = unsafe {
            crate::test_utils::aligned_account_bytes_from_b64::<PerpMarket>(&perp_market_str)
        };

        let key = Pubkey::default();
        let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
        let mut lamports = 0;
        let perp_market_account_info = create_account_info(
            &key,
            true,
            &mut lamports,
            &mut perp_market_bytes[..],
            &owner,
        );

        let perp_market_loader: AccountLoader<PerpMarket> =
            AccountLoader::try_from(&perp_market_account_info).unwrap();
        let perp_market = perp_market_loader.load_mut().unwrap();

        let oracle_price = perp_market
            .market_stats
            .historical_oracle_data
            .last_oracle_price;
        let slot = 249352956_u64;
        let base_asset_amount = 100 * BASE_PRECISION_U64;

        let (long_start, long_end) = OrderParams::get_perp_baseline_start_end_price_offset(
            &perp_market,
            &Default::default(),
            PositionDirection::Long,
            1,
        )
        .unwrap();
        assert_eq!(long_start, 18863011); // legacy: 25635886 ($25 above)
        assert_eq!(long_end, 113427779); // legacy: 115193672

        let (short_start, short_end) = OrderParams::get_perp_baseline_start_end_price_offset(
            &perp_market,
            &Default::default(),
            PositionDirection::Short,
            1,
        )
        .unwrap();
        assert_eq!(short_start, 47489360); // legacy: 47008307
        assert_eq!(short_end, -47075408);

        let params = OrderParams::get_close_perp_params(
            &perp_market,
            &Default::default(),
            PositionDirection::Long,
            base_asset_amount,
        )
        .unwrap();

        let auction_start_price = params.auction_start_price.unwrap();
        let auction_end_price = params.auction_end_price.unwrap();
        let oracle_price_offset = params.oracle_price_offset.unwrap();
        let auction_duration = params.auction_duration.unwrap();
        assert_eq!(auction_start_price, long_start); // $25 above
        assert_eq!(auction_end_price, long_end); // 115
        assert_eq!(oracle_price_offset, long_end);
        assert_eq!(auction_duration, 80);

        let order = get_order(&params, slot);

        validate_order(
            &order,
            &perp_market,
            &Default::default(),
            Some(oracle_price),
            slot,
        )
        .unwrap();
    }
}

#[test]
fn test_parse_optional_params() {
    let (success_condition, auction_duration_percentage) = parse_optional_params(Some(0x00001234));
    assert_eq!(success_condition, 0x34);
    assert_eq!(auction_duration_percentage, 0x12);
}
