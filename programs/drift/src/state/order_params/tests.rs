mod get_auction_duration {
    use crate::state::order_params::get_auction_duration;
    use crate::{ContractTier, PRICE_PRECISION_U64};

    #[test]
    fn test() {
        let price_diff = 0;
        let price = 100 * PRICE_PRECISION_U64;
        let contract_tier = ContractTier::C;

        let duration = get_auction_duration(price_diff, price, contract_tier).unwrap();
        assert_eq!(duration, 10);

        let price_diff = PRICE_PRECISION_U64 / 10;
        let price = 100 * PRICE_PRECISION_U64;

        let duration = get_auction_duration(price_diff, price, contract_tier).unwrap();
        assert_eq!(duration, 10);

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
    use crate::state::perp_market::{ContractTier, PerpMarket, AMM};
    use crate::state::user::OrderType;
    use crate::{
        OrderParams, PositionDirection, AMM_RESERVE_PRECISION, BID_ASK_SPREAD_PRECISION,
        PEG_PRECISION, PRICE_PRECISION_I64, PRICE_PRECISION_U64,
    };

    #[test]
    fn test_limit() {
        let oracle_price = 100 * PRICE_PRECISION_I64;
        let mut amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            short_spread: (BID_ASK_SPREAD_PRECISION / 100) as u32,
            long_spread: (BID_ASK_SPREAD_PRECISION / 100) as u32,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            ..AMM::default()
        };
        amm.last_bid_price_twap = (oracle_price * 99 / 100) as u64;
        amm.last_mark_price_twap_5min = oracle_price as u64;
        amm.last_ask_price_twap = (oracle_price * 101 / 100) as u64;
        amm.historical_oracle_data.last_oracle_price_twap = oracle_price as i64;
        amm.historical_oracle_data.last_oracle_price_twap_5min = oracle_price as i64;

        amm.historical_oracle_data.last_oracle_price = oracle_price;
        let perp_market = PerpMarket {
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
            .update_perp_auction_params(&perp_market, oracle_price)
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
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_eq!(order_params_before, order_params_after);

        let order_params_before = OrderParams {
            order_type: OrderType::Limit,
            auction_duration: None,
            post_only: PostOnlyParam::None,
            immediate_or_cancel: true,
            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_eq!(order_params_before, order_params_after);

        let order_params_before = OrderParams {
            order_type: OrderType::Limit,
            auction_duration: None,
            post_only: PostOnlyParam::None,
            immediate_or_cancel: false,
            oracle_price_offset: Some(0),
            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_eq!(order_params_before, order_params_after);

        let order_params_before = OrderParams {
            order_type: OrderType::Limit,
            auction_duration: None,
            post_only: PostOnlyParam::None,
            immediate_or_cancel: false,
            oracle_price_offset: None,
            price: 0,
            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_eq!(order_params_before, order_params_after);

        let order_params_before = OrderParams {
            order_type: OrderType::Limit,
            auction_duration: None,
            post_only: PostOnlyParam::None,
            immediate_or_cancel: false,
            oracle_price_offset: None,
            price: 100 * PRICE_PRECISION_U64,
            direction: PositionDirection::Long,
            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_eq!(order_params_before, order_params_after);

        let order_params_before = OrderParams {
            order_type: OrderType::Limit,
            auction_duration: None,
            post_only: PostOnlyParam::None,
            immediate_or_cancel: false,
            oracle_price_offset: None,
            price: 102 * PRICE_PRECISION_U64,
            direction: PositionDirection::Long,
            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(order_params_after.auction_duration, Some(175));
        assert_eq!(
            order_params_after.auction_start_price,
            Some(100 * PRICE_PRECISION_I64 - 901000)
        );
        assert_eq!(
            order_params_after.auction_end_price,
            Some(102 * PRICE_PRECISION_I64)
        );

        let order_params_before = OrderParams {
            order_type: OrderType::Limit,
            auction_duration: None,
            post_only: PostOnlyParam::None,
            immediate_or_cancel: false,
            oracle_price_offset: None,
            price: 100 * PRICE_PRECISION_U64,
            direction: PositionDirection::Short,
            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_eq!(order_params_before, order_params_after);

        let order_params_before = OrderParams {
            order_type: OrderType::Limit,
            auction_duration: None,
            post_only: PostOnlyParam::None,
            immediate_or_cancel: false,
            oracle_price_offset: None,
            price: 98 * PRICE_PRECISION_U64,
            direction: PositionDirection::Short,
            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(order_params_after.auction_duration, Some(174));
        assert_eq!(
            order_params_after.auction_start_price,
            Some(100 * PRICE_PRECISION_I64 + 899000) // %1 / 10 = 10 bps aggression
        );
        assert_eq!(
            order_params_after.auction_end_price,
            Some(98 * PRICE_PRECISION_I64)
        );
    }

    #[test]
    fn test_market_sanitize() {
        let oracle_price = 99 * PRICE_PRECISION_I64;
        let mut amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            short_spread: (BID_ASK_SPREAD_PRECISION / 100) as u32,
            long_spread: (BID_ASK_SPREAD_PRECISION / 100) as u32,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 99 * PEG_PRECISION,
            ..AMM::default()
        };
        amm.historical_oracle_data.last_oracle_price = oracle_price;
        amm.historical_oracle_data.last_oracle_price_twap = oracle_price - 97238;
        amm.last_ask_price_twap =
            (amm.historical_oracle_data.last_oracle_price_twap as u64) + 217999;
        amm.last_bid_price_twap =
            (amm.historical_oracle_data.last_oracle_price_twap as u64) + 17238;

        let perp_market = PerpMarket {
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
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(order_params_after.auction_start_price.unwrap(), 98901080);
        let amm_bid_price = amm.bid_price(amm.reserve_price().unwrap()).unwrap();
        assert_eq!(amm_bid_price, 98010000);
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
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(order_params_after.auction_start_price.unwrap(), 99118879);

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
            .update_perp_auction_params(&perp_market, oracle_price)
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
            short_spread: (BID_ASK_SPREAD_PRECISION / 100) as u32,
            long_spread: (BID_ASK_SPREAD_PRECISION / 100) as u32,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            ..AMM::default()
        };
        amm.historical_oracle_data.last_oracle_price = oracle_price;
        amm.historical_oracle_data.last_oracle_price_twap = oracle_price - 97238;
        amm.last_ask_price_twap =
            (amm.historical_oracle_data.last_oracle_price_twap as u64) + 217999;
        amm.last_bid_price_twap =
            (amm.historical_oracle_data.last_oracle_price_twap as u64) + 17238;

        let perp_market = PerpMarket {
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
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(order_params_after.auction_start_price.unwrap(), -98920);

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
            .update_perp_auction_params(&perp_market, oracle_price)
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
    }

    #[test]
    fn test_market_sanatize_no_auction_params() {
        let oracle_price = 99 * PRICE_PRECISION_I64;
        let mut amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            short_spread: (BID_ASK_SPREAD_PRECISION / 100) as u32,
            long_spread: (BID_ASK_SPREAD_PRECISION / 100) as u32,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            ..AMM::default()
        };
        amm.historical_oracle_data.last_oracle_price = oracle_price;
        amm.historical_oracle_data.last_oracle_price_twap = oracle_price - 97238;
        amm.last_ask_price_twap =
            (amm.historical_oracle_data.last_oracle_price_twap as u64) + 217999;
        amm.last_bid_price_twap =
            (amm.historical_oracle_data.last_oracle_price_twap as u64) + 17238;

        let perp_market = PerpMarket {
            amm,
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
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(order_params_after.auction_start_price.unwrap(), 98901080);

        let order_params_before = OrderParams {
            order_type: OrderType::Market,
            direction: PositionDirection::Long,
            auction_start_price: None,
            auction_end_price: None,
            price: 95 * PRICE_PRECISION_U64,
            auction_duration: None,

            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(
            order_params_after.auction_start_price.unwrap(),
            95 * PRICE_PRECISION_I64
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
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(order_params_after.auction_start_price.unwrap(), 99118879);

        let order_params_before = OrderParams {
            order_type: OrderType::Market,
            direction: PositionDirection::Short,
            auction_start_price: None,
            auction_end_price: None,
            price: 100 * PRICE_PRECISION_U64,
            auction_duration: None,

            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(
            order_params_after.auction_start_price.unwrap(),
            100 * PRICE_PRECISION_I64
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
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_eq!(order_params_after.auction_start_price.unwrap(), 99118879);
        assert_eq!(order_params_after.auction_end_price.unwrap(), 98028211);

        assert_eq!(order_params_after.auction_duration, Some(67));

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
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_eq!(order_params_after.auction_start_price.unwrap(), 98901080);
        assert_eq!(order_params_after.auction_end_price.unwrap(), 100207026);

        assert_eq!(order_params_after.auction_duration, Some(80));
    }

    #[test]
    fn test_oracle_market_sanitize_no_auction_params() {
        let oracle_price = 99 * PRICE_PRECISION_I64;
        let mut amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            short_spread: (BID_ASK_SPREAD_PRECISION / 100) as u32,
            long_spread: (BID_ASK_SPREAD_PRECISION / 100) as u32,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            ..AMM::default()
        };
        amm.historical_oracle_data.last_oracle_price = oracle_price;
        amm.historical_oracle_data.last_oracle_price_twap = oracle_price - 97238;
        amm.historical_oracle_data.last_oracle_price_twap_5min =
            amm.historical_oracle_data.last_oracle_price_twap;

        let ask_twap_offset = 217999;
        amm.last_ask_price_twap =
            (amm.historical_oracle_data.last_oracle_price_twap as u64) + ask_twap_offset;

        let bid_twap_offset = 17238;
        amm.last_bid_price_twap =
            (amm.historical_oracle_data.last_oracle_price_twap as u64) + bid_twap_offset;

        amm.last_mark_price_twap_5min =
            (amm.historical_oracle_data.last_oracle_price_twap as u64) + (17238 + 217999) / 2;

        let perp_market = PerpMarket {
            amm,
            ..PerpMarket::default()
        };

        let order_params_before = OrderParams {
            order_type: OrderType::Oracle,
            direction: PositionDirection::Long,
            auction_start_price: None,
            auction_end_price: None,
            oracle_price_offset: Some(5 * PRICE_PRECISION_U64 as i32),
            auction_duration: None,

            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(order_params_after.auction_start_price.unwrap(), 18698);
        assert!(order_params_after.auction_start_price.unwrap() > bid_twap_offset as i64);
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
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_ne!(order_params_before, order_params_after);
        assert_eq!(order_params_after.auction_start_price.unwrap(), 18698);
        assert_eq!(order_params_after.auction_end_price.unwrap(), 1207026);
        assert_eq!(order_params_after.oracle_price_offset, None);

        // test sanitize laxing on stale/mismatched mark/oracle twap timestamps

        // not too late, should be the same
        amm.historical_oracle_data.last_oracle_price_twap_ts = 17000000;
        amm.last_mark_price_twap_ts = 17000000 - 55;
        let mut order_params_after_2 = order_params_before;
        order_params_after_2
            .update_perp_auction_params(&perp_market, oracle_price)
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
        amm.historical_oracle_data.last_oracle_price_twap_ts = 17000000;
        amm.last_mark_price_twap_ts = 17000000 - 65;
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_eq!(order_params_after.auction_start_price.unwrap(), 18698);
        assert_eq!(order_params_after.auction_end_price.unwrap(), 1207026);

        // test empty
        let order_params_before = OrderParams {
            order_type: OrderType::Oracle,
            direction: PositionDirection::Short,
            auction_start_price: None,
            auction_end_price: None,
            oracle_price_offset: Some(-5 * PRICE_PRECISION_I64 as i32),
            auction_duration: None,

            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_eq!(order_params_after.auction_start_price.unwrap(), 216738);
        assert!(order_params_after.auction_start_price.unwrap() < (ask_twap_offset as i64));
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
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_eq!(order_params_after.auction_start_price.unwrap(), 216738);
        assert_eq!(order_params_after.auction_end_price.unwrap(), -971789);
        assert_eq!(order_params_after.auction_duration.unwrap(), 73);
    }
}

mod get_close_perp_params {
    use crate::state::oracle::HistoricalOracleData;
    use crate::state::order_params::PostOnlyParam;
    use crate::state::perp_market::{PerpMarket, AMM};
    use crate::state::user::{Order, OrderStatus};
    use crate::test_utils::create_account_info;
    use crate::validation::order::validate_order;
    use crate::{
        OrderParams, PositionDirection, BASE_PRECISION_U64, PRICE_PRECISION_I64,
        PRICE_PRECISION_U64,
    };
    use anchor_lang::prelude::AccountLoader;
    use solana_program::pubkey::Pubkey;
    use std::str::FromStr;

    #[test]
    fn bid() {
        let oracle_price = 100 * PRICE_PRECISION_I64;
        let slot = 1;
        let amm = AMM {
            last_ask_price_twap: 101 * PRICE_PRECISION_U64,
            last_bid_price_twap: 99 * PRICE_PRECISION_U64,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: 100 * PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            mark_std: PRICE_PRECISION_U64,
            oracle_std: PRICE_PRECISION_U64,
            ..AMM::default_test()
        };
        let perp_market = PerpMarket {
            amm,
            ..PerpMarket::default()
        };

        let direction_to_close = PositionDirection::Long;
        let base_asset_amount = BASE_PRECISION_U64;

        let params =
            OrderParams::get_close_perp_params(&perp_market, direction_to_close, base_asset_amount)
                .unwrap();

        let auction_start_price = params.auction_start_price.unwrap();
        let auction_end_price = params.auction_end_price.unwrap();
        let oracle_price_offset = params.oracle_price_offset.unwrap();
        assert_eq!(auction_start_price, -1000000);
        assert_eq!(auction_end_price, 2 * PRICE_PRECISION_I64);
        assert_eq!(oracle_price_offset, 2 * PRICE_PRECISION_I64 as i32);

        let order = get_order(&params, slot);

        validate_order(&order, &perp_market, Some(oracle_price), slot).unwrap();

        let amm = AMM {
            last_ask_price_twap: 103 * PRICE_PRECISION_U64,
            last_bid_price_twap: 101 * PRICE_PRECISION_U64,
            last_mark_price_twap_5min: 102 * PRICE_PRECISION_U64,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: 100 * PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: 100 * PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            mark_std: PRICE_PRECISION_U64,
            oracle_std: PRICE_PRECISION_U64,
            ..AMM::default_test()
        };
        let perp_market = PerpMarket {
            amm,
            ..PerpMarket::default()
        };

        let params =
            OrderParams::get_close_perp_params(&perp_market, direction_to_close, base_asset_amount)
                .unwrap();

        let auction_start_price = params.auction_start_price.unwrap();
        let auction_end_price = params.auction_end_price.unwrap();
        let oracle_price_offset = params.oracle_price_offset.unwrap();
        assert_eq!(auction_start_price, PRICE_PRECISION_I64);
        assert_eq!(auction_end_price, 4 * PRICE_PRECISION_I64);
        assert_eq!(oracle_price_offset, 4 * PRICE_PRECISION_I64 as i32);

        let order = get_order(&params, slot);

        validate_order(&order, &perp_market, Some(oracle_price), slot).unwrap();

        let amm = AMM {
            last_ask_price_twap: 99 * PRICE_PRECISION_U64,
            last_bid_price_twap: 97 * PRICE_PRECISION_U64,
            last_mark_price_twap_5min: 98 * PRICE_PRECISION_U64,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: 100 * PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: 100 * PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            mark_std: PRICE_PRECISION_U64,
            oracle_std: PRICE_PRECISION_U64,
            ..AMM::default_test()
        };
        let perp_market = PerpMarket {
            amm,
            ..PerpMarket::default()
        };

        let params =
            OrderParams::get_close_perp_params(&perp_market, direction_to_close, base_asset_amount)
                .unwrap();

        let auction_start_price = params.auction_start_price.unwrap();
        let auction_end_price = params.auction_end_price.unwrap();
        let oracle_price_offset = params.oracle_price_offset.unwrap();
        assert_eq!(auction_start_price, -3 * PRICE_PRECISION_I64);
        assert_eq!(auction_end_price, 0);
        assert_eq!(oracle_price_offset, 0);

        let order = get_order(&params, slot);

        validate_order(&order, &perp_market, Some(oracle_price), slot).unwrap();
    }

    #[test]
    fn ask() {
        let oracle_price = 100 * PRICE_PRECISION_I64;
        let slot = 1;
        let amm = AMM {
            last_ask_price_twap: 101 * PRICE_PRECISION_U64,
            last_bid_price_twap: 99 * PRICE_PRECISION_U64,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: 100 * PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            mark_std: PRICE_PRECISION_U64,
            oracle_std: PRICE_PRECISION_U64,
            ..AMM::default_test()
        };
        let perp_market = PerpMarket {
            amm,
            ..PerpMarket::default()
        };

        let direction_to_close = PositionDirection::Short;
        let base_asset_amount = BASE_PRECISION_U64;

        let params =
            OrderParams::get_close_perp_params(&perp_market, direction_to_close, base_asset_amount)
                .unwrap();

        let auction_start_price = params.auction_start_price.unwrap();
        let auction_end_price = params.auction_end_price.unwrap();
        let oracle_price_offset = params.oracle_price_offset.unwrap();
        assert_eq!(auction_start_price, 1000000);
        assert_eq!(auction_end_price, -2 * PRICE_PRECISION_I64);
        assert_eq!(oracle_price_offset, -2 * PRICE_PRECISION_I64 as i32);

        let order = get_order(&params, slot);

        validate_order(&order, &perp_market, Some(oracle_price), slot).unwrap();

        let amm = AMM {
            last_ask_price_twap: 103 * PRICE_PRECISION_U64,
            last_bid_price_twap: 101 * PRICE_PRECISION_U64,
            last_mark_price_twap_5min: 102 * PRICE_PRECISION_U64,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: 100 * PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: 100 * PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            mark_std: PRICE_PRECISION_U64,
            oracle_std: PRICE_PRECISION_U64,
            ..AMM::default_test()
        };
        let perp_market = PerpMarket {
            amm,
            ..PerpMarket::default()
        };

        let params =
            OrderParams::get_close_perp_params(&perp_market, direction_to_close, base_asset_amount)
                .unwrap();

        let auction_start_price = params.auction_start_price.unwrap();
        let auction_end_price = params.auction_end_price.unwrap();
        let oracle_price_offset = params.oracle_price_offset.unwrap();
        assert_eq!(auction_start_price, 3 * PRICE_PRECISION_I64);
        assert_eq!(auction_end_price, 0);
        assert_eq!(oracle_price_offset, 0);

        let order = get_order(&params, slot);

        validate_order(&order, &perp_market, Some(oracle_price), slot).unwrap();

        let amm = AMM {
            last_ask_price_twap: 99 * PRICE_PRECISION_U64,
            last_mark_price_twap_5min: 98 * PRICE_PRECISION_U64,
            last_bid_price_twap: 97 * PRICE_PRECISION_U64,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: 100 * PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: 100 * PRICE_PRECISION_I64,

                ..HistoricalOracleData::default()
            },
            mark_std: PRICE_PRECISION_U64,
            oracle_std: PRICE_PRECISION_U64,
            ..AMM::default_test()
        };
        let perp_market = PerpMarket {
            amm,
            ..PerpMarket::default()
        };

        let params =
            OrderParams::get_close_perp_params(&perp_market, direction_to_close, base_asset_amount)
                .unwrap();

        let auction_start_price = params.auction_start_price.unwrap();
        let auction_end_price = params.auction_end_price.unwrap();
        let oracle_price_offset = params.oracle_price_offset.unwrap();
        assert_eq!(auction_start_price, -PRICE_PRECISION_I64);
        assert_eq!(auction_end_price, -4 * PRICE_PRECISION_I64);
        assert_eq!(oracle_price_offset, -4 * PRICE_PRECISION_I64 as i32);

        let order = get_order(&params, slot);

        validate_order(&order, &perp_market, Some(oracle_price), slot).unwrap();
    }

    #[test]
    fn btc() {
        let perp_market_str = String::from("Ct8MLGv1N/cV6vWLwJY+18dY2GsrmrNldgnISB7pmbcf7cn9S4FZ4OYt9si0qF/hpn20TcEt5dszD3rGa3LcZYr+3w9KQVtDd3+9kQoAAAAAAAAAAAAAAAEAAAAAAAAA2VkiggoAAAC/dZSICgAAACeqnmUAAAAAeCbW5P///////////////8J7Hv4BAAAAAAAAAAAAAAB7+rQtykoAAAAAAAAAAAAAAAAAAAAAAABlO/erzgEAAAAAAAAAAAAAVnP4srYEAAAAAAAAAAAAAJxiDwAAAAAAAAAAAAAAAAAy7nN6ywEAAAAAAAAAAAAA5ihcH9MBAAAAAAAAAAAAAK7izzLrAgAAAAAAAAAAAADs3G4NBAAAAAAAAAAAAAAAYIhJGrUEAAAAAAAAAAAAAKA0JMEnAAAAAAAAAAAAAADg/mJJ2f//////////////aJbnnAAAAAAAAAAAAAAAABidn20AAAAAAAAAAAAAAAAARCk1OgAAAAAAAAAAAAAA/U3ihP3//////////////0p/wecT+f////////////8elGWXkwYAAAAAAAAAAAAAbccyGPz4/////////////+ZmycPDBgAAAAAAAAAAAAAASI58awAAAAAAAAAAAAAArC2A7gAAAACsLYDuAAAAAKwtgO4AAAAApwxIKwEAAABrEoqhLAAAAAAAAAAAAAAAf+nRyBMAAAAAAAAAAAAAAIagdCkZAAAAAAAAAAAAAADQH9cHJgAAAAAAAAAAAAAAc132XBgAAAAAAAAAAAAAAATX1A4SAAAAAAAAAAAAAADSZHePVgcAAAAAAAAAAAAA99MFdFYHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACE4MmozQEAAAAAAAAAAAAAHWZqWLkEAAAAAAAAAAAAACdJh8HOAQAAAAAAAAAAAADzKL56tgQAAAAAAAAAAAAAd3+9kQoAAAAAAAAAAAAAALJBWoMKAAAAJf9eiwoAAABroFyHCgAAAIv2go0KAAAAPT5dDgAAAAAEAgAAAAAAAAFRgdb/////MqOeZQAAAAAQDgAAAAAAAKCGAQAAAAAAoIYBAAAAAAAgoQcAAAAAAAAAAAAAAAAAscrx5+8FAACIP1dQJgAAAEGRyqEnAAAAJ6qeZQAAAABr7TAQAAAAAJ4lmw8AAAAAJ6qeZQAAAAAUAAAALEwAACARAABsAQAAKhoAAAAAAADcBTIAZMgAAYCLLeUAAAAAKHVdAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFiluuwDJwEAAAAAAAAAAAAAAAAAAAAAAEJUQy1QRVJQICAgICAgICAgICAgICAgICAgICAgICAgWXIm/v////8AwusLAAAAAAB0O6QLAAAAvz8ZJAAAAACLqJ5lAAAAAADKmjsAAAAAAAAAAAAAAAAAAAAAAAAAAKcPDQAAAAAA8SQAAAAAAAC9AwAAAAAAAEAfAAAAAAAATB0AANQwAAD0AQAALAEAAAAAAAAQJwAApwUAABEJAAABAAEAAAAAALX/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
        let mut decoded_bytes = base64::decode(perp_market_str).unwrap();
        let perp_market_bytes = decoded_bytes.as_mut_slice();

        let key = Pubkey::default();
        let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
        let mut lamports = 0;
        let perp_market_account_info =
            create_account_info(&key, true, &mut lamports, perp_market_bytes, &owner);

        let perp_market_loader: AccountLoader<PerpMarket> =
            AccountLoader::try_from(&perp_market_account_info).unwrap();
        let perp_market = perp_market_loader.load_mut().unwrap();

        let oracle_price = perp_market.amm.historical_oracle_data.last_oracle_price;
        let slot = 240991856_u64;

        let direction_to_close = PositionDirection::Short;
        let base_asset_amount = BASE_PRECISION_U64;

        let params =
            OrderParams::get_close_perp_params(&perp_market, direction_to_close, base_asset_amount)
                .unwrap();

        let auction_start_price = params.auction_start_price.unwrap();
        let auction_end_price = params.auction_end_price.unwrap();
        let oracle_price_offset = params.oracle_price_offset.unwrap();
        assert_eq!(auction_start_price, 153320940);
        assert_eq!(auction_end_price, -251200914);
        assert_eq!(oracle_price_offset, -251200914);
        assert_eq!(params.auction_duration.unwrap_or(0), 80);

        let order = get_order(&params, slot);

        validate_order(&order, &perp_market, Some(oracle_price), slot).unwrap();
    }

    #[test]
    fn doge() {
        let perp_market_str = String::from("Ct8MLGv1N/cueW7q94VBpwLPordbGCeLrp/R8owsajNEG7L2nvhZ8NzvUN0KTNLcwX5F3xZ23LM2oRphxp33oCmbAVDGctJc8y4BAAAAAAAAAAAAAAAAAAEAAAAAAAAAiC8BAAAAAABMLwEAAAAAACmrnmUAAAAAmSxi7CT8/////////////zgrThgAAAAAAAAAAAAAAADdzXKMUwsAAAAAAAAAAAAAAAAAAAAAAADP1HhexhXAAgAAAAAAAAAAdDGk8Gq1xwIAAAAAAAAAAAzkDwAAAAAAAAAAAAAAAAAply2wnkelAgAAAAAAAAAA4qQewS2M3gIAAAAAAAAAAInzGxP44sMCAAAAAAAAAAC0KwEAAAAAAAAAAAAAAAAABtbOzyJzxgIAAAAAAAAAAACcfFCu/wYAAAAAAAAAAAAAnFHtB0b6////////////9GoMAGU/AQAAAAAAAAAAAAzNwT1RBgAAAAAAAAAAAAAAAMFv8oYjAAAAAAAAAAAABhCDPfz//////////////6bEBnzX//////////////95+qpnJAAAAAAAAAAAAAAAwQyrjdX//////////////33ohvUnAAAAAAAAAAAAAAAA/As7QZ0VAAAAAAAAAAAA8iQAAAAAAADyJAAAAAAAAPIkAAAAAAAA1wYAAAAAAABg33mwCgAAAAAAAAAAAAAABY12UwkAAAAAAAAAAAAAALwqCWEBAAAAAAAAAAAAAACQMZk6EwAAAAAAAAAAAAAAnzjKCwEAAAAAAAAAAAAAAApzcx8BAAAAAAAAAAAAAADLvbQBAAAAAAAAAAAAAAAAy720AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACHhwa6WVC6AgAAAAAAAAAASl7rdy6XzQIAAAAAAAAAAPsDHiPPL8MCAAAAAAAAAACXfZpmTpbEAgAAAAAAAAAA8y4BAAAAAAD0/////////zIuAQAAAAAATTIBAAAAAAA/MAEAAAAAAGgwAQAAAAAAgEBdDgAAAAA3AgAAAAAAAGCTe/7/////66KeZQAAAAAQDgAAAAAAAACUNXcAAAAACgAAAAAAAAAAdDukCwAAAAAAAAAAAAAAc3fY9xsAAAD1rzWPAAAAABtgqEAAAAAAdKqeZQAAAAAlAAAAAAAAAJUAAAAAAAAAKaueZQAAAAAcJQAAgDgBAF1AAAAuIgAA1QEAAAAAAAD0ATIAZGQAAQAAAAAFAAAANbUVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADzUZfxOTwAAAAAAAAAAAAAAAAAAAAAAAERPR0UtUEVSUCAgICAgICAgICAgICAgICAgICAgICAg5Nyg//////+AlpgAAAAAAAAvaFkAAAAAMZviAQAAAABXpJ5lAAAAABAnAAAAAAAAAAAAAAAAAAAAAAAAAAAAABuUAAAAAAAAFRoAAAAAAAC+CgAAAAAAAMgAAADIAAAAECcAAKhhAADoAwAA9AEAAAAAAAAQJwAA2AAAAEkBAAAHAAEAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
        let mut decoded_bytes = base64::decode(perp_market_str).unwrap();
        let perp_market_bytes = decoded_bytes.as_mut_slice();

        let key = Pubkey::default();
        let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
        let mut lamports = 0;
        let perp_market_account_info =
            create_account_info(&key, true, &mut lamports, perp_market_bytes, &owner);

        let perp_market_loader: AccountLoader<PerpMarket> =
            AccountLoader::try_from(&perp_market_account_info).unwrap();
        let perp_market = perp_market_loader.load_mut().unwrap();

        let oracle_price = perp_market.amm.historical_oracle_data.last_oracle_price;
        let slot = 240991856_u64;

        let direction_to_close = PositionDirection::Short;
        let base_asset_amount = 100 * BASE_PRECISION_U64;

        let params =
            OrderParams::get_close_perp_params(&perp_market, direction_to_close, base_asset_amount)
                .unwrap();

        let auction_start_price = params.auction_start_price.unwrap();
        let auction_end_price = params.auction_end_price.unwrap();
        let oracle_price_offset = params.oracle_price_offset.unwrap();
        assert_eq!(auction_start_price, 641);
        assert_eq!(auction_end_price, -1021);
        assert_eq!(oracle_price_offset, -1021);

        let order = get_order(&params, slot);

        validate_order(&order, &perp_market, Some(oracle_price), slot).unwrap();
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
            immediate_or_cancel: params.immediate_or_cancel,
            auction_start_price: params.auction_start_price.unwrap_or(0),
            auction_end_price: params.auction_end_price.unwrap_or(0),
            auction_duration: params.auction_duration.unwrap_or(0),
            max_ts: 100,
            padding: [0; 3],
        }
    }

    #[test]
    fn test_default_starts_on_perp_markets() {
        // BTC style market
        // ideally 60 above oracle is fill
        let perp_market_str = String::from("Ct8MLGv1N/cV6vWLwJY+18dY2GsrmrNldgnISB7pmbcf7cn9S4FZ4OYt9si0qF/hpn20TcEt5dszD3rGa3LcZYr+3w9KQVtDQEK8LQwAAAAAAAAAAAAAAAIAAAAAAAAATR7OKQwAAACsuhItDAAAABqp1GUAAAAA/fzP2P///////////////99h9GQEAAAAAAAAAAAAAADXOjdJzWQAAAAAAAAAAAAAAAAAAAAAAAAuI6el0QEAAAAAAAAAAAAA9u9IVNEGAAAAAAAAAAAAAJxiDwAAAAAAAAAAAAAAAABVU808zgEAAAAAAAAAAAAACeF17dUBAAAAAAAAAAAAAM6XvYCFAwAAAAAAAAAAAACWxcs/AwAAAAAAAAAAAAAAN2QGws8GAAAAAAAAAAAAAMCk9S8+AAAAAAAAAAAAAADABV1mwv//////////////5QhrawAAAAAAAAAAAAAAAJuh5yoAAAAAAAAAAAAAAAAAoNshXQAAAAAAAAAAAAAAgruloUEAAAAAAAAAAAAAAIjHhpPh8//////////////C9GHQvgsAAAAAAAAAAAAApZ+7JMPz/////////////+Wma/v1CwAAAAAAAAAAAAAAMVw41QAAAAAAAAAAAAAAcUNyaAAAAABxQ3JoAAAAAHFDcmgAAAAArY7UlAAAAACt+g88fgAAAAAAAAAAAAAAznvNmTMAAAAAAAAAAAAAAPG3DURMAAAAAAAAAAAAAACBrvFTdAAAAAAAAAAAAAAA8tmZKi8AAAAAAAAAAAAAAHvRRkAjAAAAAAAAAAAAAADNFAJImwgAAAAAAAAAAAAA8oOQLJsIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2eHJY0QEAAAAAAAAAAAAA+XzaddIGAAAAAAAAAAAAAOf5IqvRAQAAAAAAAAAAAACqVrs/0QYAAAAAAAAAAAAAQEK8LQwAAAAAAAAAAAAAAPDx7SoMAAAAnb+iLAwAAADGWMgrDAAAAIYLIy8MAAAA+dLcDgAAAABaAgAAAAAAALM+D/7/////VaLUZQAAAAAQDgAAAAAAAKCGAQAAAAAAoIYBAAAAAAAgoQcAAAAAAAAAAAAAAAAABeZ6i7gsAAAysGg95QAAAO7ctlC7AAAAGqnUZQAAAACpe6oBAAAAAPMj7gMAAAAAGqnUZQAAAAAyAAAAHCUAABAFAABcAAAAAAAAAK0DAADcBTIAZMgAAYCLLeUAAAAAvUntAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFaHyO66xAIAAAAAAAAAAAAAAAAAAAAAAEJUQy1QRVJQICAgICAgICAgICAgICAgICAgICAgICAggA8F/f////+A8PoCAAAAAABcsuwiAAAAXd8ZJAAAAAAMo9RlAAAAAADh9QUAAAAAAAAAAAAAAAAAAAAAAAAAALgnGAAAAAAAwygAAAAAAAD5AwAAAAAAAEAfAAAAAAAATB0AANQwAAD0AQAALAEAAAAAAAAQJwAArwwAAOgWAAABAAEAAAAAALX/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
        let mut decoded_bytes = base64::decode(perp_market_str).unwrap();
        let perp_market_bytes = decoded_bytes.as_mut_slice();

        let key = Pubkey::default();
        let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
        let mut lamports = 0;
        let perp_market_account_info =
            create_account_info(&key, true, &mut lamports, perp_market_bytes, &owner);

        let perp_market_loader: AccountLoader<PerpMarket> =
            AccountLoader::try_from(&perp_market_account_info).unwrap();
        let perp_market = perp_market_loader.load_mut().unwrap();

        let oracle_price = perp_market.amm.historical_oracle_data.last_oracle_price;
        let slot = 249352956_u64;
        let base_asset_amount = 100 * BASE_PRECISION_U64;

        let (long_start, long_end) = OrderParams::get_perp_baseline_start_end_price_offset(
            &perp_market,
            PositionDirection::Long,
        )
        .unwrap();
        assert_eq!(long_start, 25635886); // $25 above
        assert_eq!(long_end, 115193672); //115

        let (short_start, short_end) = OrderParams::get_perp_baseline_start_end_price_offset(
            &perp_market,
            PositionDirection::Short,
        )
        .unwrap();
        assert_eq!(short_start, 47008307);
        assert_eq!(short_end, -47075408);

        let params = OrderParams::get_close_perp_params(
            &perp_market,
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
        assert_eq!(oracle_price_offset, long_end as i32);
        assert_eq!(auction_duration, 80);

        let order = get_order(&params, slot);

        validate_order(&order, &perp_market, Some(oracle_price), slot).unwrap();
    }
}
