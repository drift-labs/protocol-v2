mod get_post_only_boundary {
    use crate::state::perp_market::{PerpMarket, AMM};
    use crate::validation::order::get_post_only_boundary;
    use crate::{
        PositionDirection, AMM_RESERVE_PRECISION, BID_ASK_SPREAD_PRECISION, PEG_PRECISION,
        PRICE_PRECISION_U64,
    };

    #[test]
    pub fn test() {
        let market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                long_spread: BID_ASK_SPREAD_PRECISION as u32 / 50,
                short_spread: BID_ASK_SPREAD_PRECISION as u32 / 50,
                ..AMM::default()
            },
            ..PerpMarket::default_test()
        };

        let bid_boundary =
            get_post_only_boundary(&market.amm, PositionDirection::Long, false).unwrap();

        assert_eq!(bid_boundary, 102 * PRICE_PRECISION_U64 as u64);

        let ask_boundary =
            get_post_only_boundary(&market.amm, PositionDirection::Short, false).unwrap();

        assert_eq!(ask_boundary, 98 * PRICE_PRECISION_U64 as u64);

        let bid_boundary_jit_maker =
            get_post_only_boundary(&market.amm, PositionDirection::Long, true).unwrap();

        assert_eq!(bid_boundary_jit_maker, 103 * PRICE_PRECISION_U64 as u64);

        let ask_boundary_jit_maker =
            get_post_only_boundary(&market.amm, PositionDirection::Short, true).unwrap();

        assert_eq!(ask_boundary_jit_maker, 97 * PRICE_PRECISION_U64 as u64);
    }
}
