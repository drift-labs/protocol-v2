mod prediction_markets {
    use crate::error::ErrorCode;
    use crate::state::perp_market::{ContractType, PerpMarket};
    use crate::state::user::{Order, OrderType};
    use crate::validation::order::validate_order;
    use crate::{
        MarketType, PositionDirection, BASE_PRECISION_U64, MAX_PREDICTION_MARKET_PRICE,
        MAX_PREDICTION_MARKET_PRICE_I64,
    };

    #[test]
    fn fixed_auction() {
        let perp_market = PerpMarket {
            contract_type: ContractType::Prediction,
            ..PerpMarket::default_test()
        };

        let mut order = Order {
            market_type: MarketType::Perp,
            order_type: OrderType::Market,
            base_asset_amount: BASE_PRECISION_U64,
            direction: PositionDirection::Long,
            auction_start_price: MAX_PREDICTION_MARKET_PRICE_I64 - 1,
            auction_end_price: MAX_PREDICTION_MARKET_PRICE_I64 - 1,
            price: MAX_PREDICTION_MARKET_PRICE + 1,
            auction_duration: 10,
            ..Order::default()
        };

        let oracle_price = Some(MAX_PREDICTION_MARKET_PRICE_I64 / 2);

        let slot = 0;

        let res = validate_order(&order, &perp_market, oracle_price, slot);

        assert_eq!(res, Err(ErrorCode::InvalidPredictionMarketOrder));

        order.auction_end_price = MAX_PREDICTION_MARKET_PRICE_I64 + 1;

        let res = validate_order(&order, &perp_market, oracle_price, slot);

        assert_eq!(res, Err(ErrorCode::InvalidPredictionMarketOrder));

        order.auction_start_price = MAX_PREDICTION_MARKET_PRICE_I64 + 1;

        let res = validate_order(&order, &perp_market, oracle_price, slot);

        assert_eq!(res, Err(ErrorCode::InvalidPredictionMarketOrder));
    }

    #[test]
    fn oracle_auction() {
        let perp_market = PerpMarket {
            contract_type: ContractType::Prediction,
            ..PerpMarket::default_test()
        };

        let mut order = Order {
            market_type: MarketType::Perp,
            order_type: OrderType::Oracle,
            base_asset_amount: BASE_PRECISION_U64,
            direction: PositionDirection::Long,
            auction_start_price: 1,
            auction_end_price: 1,
            oracle_price_offset: (MAX_PREDICTION_MARKET_PRICE + 1) as i32,
            auction_duration: 10,
            ..Order::default()
        };

        let oracle_price = Some(MAX_PREDICTION_MARKET_PRICE_I64 / 2);

        let slot = 0;

        let res = validate_order(&order, &perp_market, oracle_price, slot);

        assert_eq!(res, Err(ErrorCode::InvalidPredictionMarketOrder));

        order.auction_end_price = MAX_PREDICTION_MARKET_PRICE_I64 + 1;

        let res = validate_order(&order, &perp_market, oracle_price, slot);

        assert_eq!(res, Err(ErrorCode::InvalidPredictionMarketOrder));

        order.auction_start_price = MAX_PREDICTION_MARKET_PRICE_I64 + 1;

        let res = validate_order(&order, &perp_market, oracle_price, slot);

        assert_eq!(res, Err(ErrorCode::InvalidPredictionMarketOrder));

        order.auction_start_price = 1;
        order.auction_end_price = 1;
        order.oracle_price_offset = -(MAX_PREDICTION_MARKET_PRICE as i32) - 1;
        order.direction = PositionDirection::Short;

        let res = validate_order(&order, &perp_market, oracle_price, slot);

        assert_eq!(res, Err(ErrorCode::InvalidPredictionMarketOrder));

        order.auction_end_price = -MAX_PREDICTION_MARKET_PRICE_I64 - 1;

        let res = validate_order(&order, &perp_market, oracle_price, slot);

        assert_eq!(res, Err(ErrorCode::InvalidPredictionMarketOrder));

        order.auction_start_price = -MAX_PREDICTION_MARKET_PRICE_I64 - 1;

        let res = validate_order(&order, &perp_market, oracle_price, slot);

        assert_eq!(res, Err(ErrorCode::InvalidPredictionMarketOrder));
    }
}
