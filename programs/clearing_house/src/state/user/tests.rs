mod get_unsettled_pnl {
    use crate::math::constants::{
        BASE_PRECISION_I128, MARK_PRICE_PRECISION_I128, QUOTE_PRECISION_I128,
    };
    use crate::state::user::{MarketPosition, User};
    use crate::tests::utils::get_positions;

    #[test]
    fn long_negative_unrealized_pnl() {
        let user = User {
            positions: get_positions(MarketPosition {
                base_asset_amount: BASE_PRECISION_I128,
                quote_asset_amount: -100 * QUOTE_PRECISION_I128,
                quote_entry_amount: -100 * QUOTE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 50 * MARK_PRICE_PRECISION_I128;
        let unsettled_pnl = user.positions[0].get_unsettled_pnl(oracle_price).unwrap();
        assert_eq!(unsettled_pnl, -50 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn long_positive_unrealized_pnl_more_than_max_pnl_to_settle() {
        let user = User {
            positions: get_positions(MarketPosition {
                base_asset_amount: BASE_PRECISION_I128,
                quote_asset_amount: -50 * QUOTE_PRECISION_I128,
                quote_entry_amount: -100 * QUOTE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 150 * MARK_PRICE_PRECISION_I128;
        let unsettled_pnl = user.positions[0].get_unsettled_pnl(oracle_price).unwrap();
        assert_eq!(unsettled_pnl, 50 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn long_positive_unrealized_pnl_less_than_max_pnl_to_settle() {
        let user = User {
            positions: get_positions(MarketPosition {
                base_asset_amount: BASE_PRECISION_I128,
                quote_asset_amount: -50 * QUOTE_PRECISION_I128,
                quote_entry_amount: -100 * QUOTE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 75 * MARK_PRICE_PRECISION_I128;
        let unsettled_pnl = user.positions[0].get_unsettled_pnl(oracle_price).unwrap();
        assert_eq!(unsettled_pnl, 25 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn long_no_negative_pnl_if_already_settled_to_oracle() {
        let user = User {
            positions: get_positions(MarketPosition {
                base_asset_amount: BASE_PRECISION_I128,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                quote_entry_amount: -100 * QUOTE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 150 * MARK_PRICE_PRECISION_I128;
        let unsettled_pnl = user.positions[0].get_unsettled_pnl(oracle_price).unwrap();
        assert_eq!(unsettled_pnl, 0);
    }

    #[test]
    fn short_negative_unrealized_pnl() {
        let user = User {
            positions: get_positions(MarketPosition {
                base_asset_amount: -BASE_PRECISION_I128,
                quote_asset_amount: 100 * QUOTE_PRECISION_I128,
                quote_entry_amount: 100 * QUOTE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 150 * MARK_PRICE_PRECISION_I128;
        let unsettled_pnl = user.positions[0].get_unsettled_pnl(oracle_price).unwrap();
        assert_eq!(unsettled_pnl, -50 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn short_positive_unrealized_pnl_more_than_max_pnl_to_settle() {
        let user = User {
            positions: get_positions(MarketPosition {
                base_asset_amount: -BASE_PRECISION_I128,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                quote_entry_amount: 100 * QUOTE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 50 * MARK_PRICE_PRECISION_I128;
        let unsettled_pnl = user.positions[0].get_unsettled_pnl(oracle_price).unwrap();
        assert_eq!(unsettled_pnl, 50 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn short_positive_unrealized_pnl_less_than_max_pnl_to_settle() {
        let user = User {
            positions: get_positions(MarketPosition {
                base_asset_amount: -BASE_PRECISION_I128,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                quote_entry_amount: 100 * QUOTE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 125 * MARK_PRICE_PRECISION_I128;
        let unsettled_pnl = user.positions[0].get_unsettled_pnl(oracle_price).unwrap();
        assert_eq!(unsettled_pnl, 25 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn short_no_negative_pnl_if_already_settled_to_oracle() {
        let user = User {
            positions: get_positions(MarketPosition {
                base_asset_amount: -BASE_PRECISION_I128,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                quote_entry_amount: 100 * QUOTE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 150 * MARK_PRICE_PRECISION_I128;
        let unsettled_pnl = user.positions[0].get_unsettled_pnl(oracle_price).unwrap();
        assert_eq!(unsettled_pnl, 0);
    }
}
