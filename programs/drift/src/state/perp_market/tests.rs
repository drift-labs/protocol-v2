mod amm {
    use crate::state::perp_market::AMM;
    use crate::{
        AMM_RESERVE_PRECISION, BID_ASK_SPREAD_PRECISION, PEG_PRECISION, PRICE_PRECISION_I64,
    };

    #[test]
    fn last_ask_premium() {
        let mut amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            short_spread: (BID_ASK_SPREAD_PRECISION / 10) as u32,
            long_spread: (BID_ASK_SPREAD_PRECISION / 10) as u32,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            ..AMM::default()
        };
        amm.historical_oracle_data.last_oracle_price = 100 * PRICE_PRECISION_I64;

        let premium = amm.last_ask_premium().unwrap();

        assert_eq!(premium, 10000000); // $1
    }

    #[test]
    fn last_bid_discount() {
        let mut amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            short_spread: (BID_ASK_SPREAD_PRECISION / 10) as u32,
            long_spread: (BID_ASK_SPREAD_PRECISION / 10) as u32,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            ..AMM::default()
        };
        amm.historical_oracle_data.last_oracle_price = 100 * PRICE_PRECISION_I64;

        let discount = amm.last_bid_discount().unwrap();

        assert_eq!(discount, 10000000); // $1
    }
}
