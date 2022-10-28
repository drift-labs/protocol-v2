mod calculate_auction_prices {
    use crate::controller::position::PositionDirection;
    use crate::math::auction::calculate_auction_prices;
    use crate::math::constants::PRICE_PRECISION_I64;
    use crate::state::oracle::OraclePriceData;

    #[test]
    fn no_limit_price_long() {
        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            ..OraclePriceData::default()
        };
        let position_direction = PositionDirection::Long;
        let limit_price = 0;

        let (auction_start_price, auction_end_price) =
            calculate_auction_prices(&oracle_price_data, position_direction, limit_price).unwrap();

        assert_eq!(auction_start_price, 100000000);
        assert_eq!(auction_end_price, 100500000);
    }

    #[test]
    fn no_limit_price_short() {
        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            ..OraclePriceData::default()
        };
        let position_direction = PositionDirection::Short;
        let limit_price = 0;

        let (auction_start_price, auction_end_price) =
            calculate_auction_prices(&oracle_price_data, position_direction, limit_price).unwrap();

        assert_eq!(auction_start_price, 100000000);
        assert_eq!(auction_end_price, 99500000);
    }

    #[test]
    fn limit_price_much_better_than_oracle_long() {
        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            ..OraclePriceData::default()
        };
        let position_direction = PositionDirection::Long;
        let limit_price = 90000000;

        let (auction_start_price, auction_end_price) =
            calculate_auction_prices(&oracle_price_data, position_direction, limit_price).unwrap();

        assert_eq!(auction_start_price, 89550000);
        assert_eq!(auction_end_price, 90000000);
    }

    #[test]
    fn limit_price_slightly_better_than_oracle_long() {
        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            ..OraclePriceData::default()
        };
        let position_direction = PositionDirection::Long;
        let limit_price = 99999999;

        let (auction_start_price, auction_end_price) =
            calculate_auction_prices(&oracle_price_data, position_direction, limit_price).unwrap();

        assert_eq!(auction_start_price, 99500000);
        assert_eq!(auction_end_price, 99999999);
    }

    #[test]
    fn limit_price_much_worse_than_oracle_long() {
        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            ..OraclePriceData::default()
        };
        let position_direction = PositionDirection::Long;
        let limit_price = 110000000;

        let (auction_start_price, auction_end_price) =
            calculate_auction_prices(&oracle_price_data, position_direction, limit_price).unwrap();

        assert_eq!(auction_start_price, 100000000);
        assert_eq!(auction_end_price, 100500000);
    }

    #[test]
    fn limit_price_slightly_worse_than_oracle_long() {
        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            ..OraclePriceData::default()
        };
        let position_direction = PositionDirection::Long;
        let limit_price = 100400000;

        let (auction_start_price, auction_end_price) =
            calculate_auction_prices(&oracle_price_data, position_direction, limit_price).unwrap();

        assert_eq!(auction_start_price, 100000000);
        assert_eq!(auction_end_price, 100400000);
    }

    #[test]
    fn limit_price_much_better_than_oracle_short() {
        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            ..OraclePriceData::default()
        };
        let position_direction = PositionDirection::Short;
        let limit_price = 110000000;

        let (auction_start_price, auction_end_price) =
            calculate_auction_prices(&oracle_price_data, position_direction, limit_price).unwrap();

        assert_eq!(auction_start_price, 110550000);
        assert_eq!(auction_end_price, 110000000);
    }

    #[test]
    fn limit_price_slightly_better_than_oracle_short() {
        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            ..OraclePriceData::default()
        };
        let position_direction = PositionDirection::Short;
        let limit_price = 100000001;

        let (auction_start_price, auction_end_price) =
            calculate_auction_prices(&oracle_price_data, position_direction, limit_price).unwrap();

        assert_eq!(auction_start_price, 100500001);
        assert_eq!(auction_end_price, 100000001);
    }

    #[test]
    fn limit_price_much_worse_than_oracle_short() {
        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            ..OraclePriceData::default()
        };
        let position_direction = PositionDirection::Short;
        let limit_price = 90000000;

        let (auction_start_price, auction_end_price) =
            calculate_auction_prices(&oracle_price_data, position_direction, limit_price).unwrap();

        assert_eq!(auction_start_price, 100000000);
        assert_eq!(auction_end_price, 99500000);
    }

    #[test]
    fn limit_price_slightly_worse_than_oracle_short() {
        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            ..OraclePriceData::default()
        };
        let position_direction = PositionDirection::Short;
        let limit_price = 99999999;

        let (auction_start_price, auction_end_price) =
            calculate_auction_prices(&oracle_price_data, position_direction, limit_price).unwrap();

        assert_eq!(auction_start_price, 100000000);
        assert_eq!(auction_end_price, 99999999);
    }
}
