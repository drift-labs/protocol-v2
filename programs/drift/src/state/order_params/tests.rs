mod get_auction_duration {
    use crate::state::order_params::get_auction_duration;
    use crate::PRICE_PRECISION_U64;

    #[test]
    fn test() {
        let price_diff = 0;
        let price = 100 * PRICE_PRECISION_U64;

        let duration = get_auction_duration(price_diff, price).unwrap();
        assert_eq!(duration, 10);

        let price_diff = PRICE_PRECISION_U64 / 10;
        let price = 100 * PRICE_PRECISION_U64;

        let duration = get_auction_duration(price_diff, price).unwrap();
        assert_eq!(duration, 10);

        let price_diff = PRICE_PRECISION_U64 / 2;
        let price = 100 * PRICE_PRECISION_U64;

        let duration = get_auction_duration(price_diff, price).unwrap();
        assert_eq!(duration, 30);

        let price_diff = PRICE_PRECISION_U64;
        let price = 100 * PRICE_PRECISION_U64;

        let duration = get_auction_duration(price_diff, price).unwrap();
        assert_eq!(duration, 60);

        let price_diff = 2 * PRICE_PRECISION_U64;
        let price = 100 * PRICE_PRECISION_U64;

        let duration = get_auction_duration(price_diff, price).unwrap();
        assert_eq!(duration, 60);
    }
}

mod update_perp_auction_params {
    use crate::state::order_params::PostOnlyParam;
    use crate::state::perp_market::{PerpMarket, AMM};
    use crate::state::user::OrderType;
    use crate::{
        OrderParams, PositionDirection, AMM_RESERVE_PRECISION, BID_ASK_SPREAD_PRECISION,
        PEG_PRECISION, PRICE_PRECISION_I64, PRICE_PRECISION_U64,
    };

    #[test]
    fn test() {
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
        amm.historical_oracle_data.last_oracle_price = oracle_price;
        let perp_market = PerpMarket {
            amm,
            ..PerpMarket::default()
        };

        let order_params_before = OrderParams {
            order_type: OrderType::Market,
            ..OrderParams::default()
        };
        let mut order_params_after = order_params_before;
        order_params_after
            .update_perp_auction_params(&perp_market, oracle_price)
            .unwrap();
        assert_eq!(order_params_before, order_params_after);

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
        assert_eq!(order_params_after.auction_duration, Some(60));
        assert_eq!(
            order_params_after.auction_start_price,
            Some(101 * PRICE_PRECISION_I64)
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
        assert_eq!(order_params_after.auction_duration, Some(60));
        assert_eq!(
            order_params_after.auction_start_price,
            Some(99 * PRICE_PRECISION_I64)
        );
        assert_eq!(
            order_params_after.auction_end_price,
            Some(98 * PRICE_PRECISION_I64)
        );
    }
}
