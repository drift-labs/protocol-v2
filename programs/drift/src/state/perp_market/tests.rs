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

mod get_margin_ratio {
    use crate::math::margin::MarginRequirementType;
    use crate::state::perp_market::PerpMarket;
    use crate::{BASE_PRECISION, MARGIN_PRECISION};

    #[test]
    fn test() {
        let perp_market = PerpMarket {
            margin_ratio_initial: MARGIN_PRECISION / 10,
            margin_ratio_maintenance: MARGIN_PRECISION / 20,
            ..PerpMarket::default()
        };

        let margin_ratio_initial = perp_market
            .get_margin_ratio(BASE_PRECISION, MarginRequirementType::Initial, false)
            .unwrap();

        let margin_ratio_maintenance = perp_market
            .get_margin_ratio(BASE_PRECISION, MarginRequirementType::Maintenance, false)
            .unwrap();

        let margin_ratio_fill = perp_market
            .get_margin_ratio(BASE_PRECISION, MarginRequirementType::Fill, false)
            .unwrap();

        assert_eq!(margin_ratio_initial, MARGIN_PRECISION / 10);
        assert_eq!(
            margin_ratio_fill,
            (MARGIN_PRECISION / 10 + MARGIN_PRECISION / 20) / 2
        );
        assert_eq!(margin_ratio_maintenance, MARGIN_PRECISION / 20);

        let perp_market = PerpMarket {
            margin_ratio_initial: MARGIN_PRECISION / 10,
            margin_ratio_maintenance: MARGIN_PRECISION / 20,
            high_leverage_margin_ratio_initial: MARGIN_PRECISION as u16 / 50,
            high_leverage_margin_ratio_maintenance: MARGIN_PRECISION as u16 / 100,
            ..PerpMarket::default()
        };

        let margin_ratio_initial = perp_market
            .get_margin_ratio(BASE_PRECISION, MarginRequirementType::Initial, true)
            .unwrap();

        let margin_ratio_maintenance = perp_market
            .get_margin_ratio(BASE_PRECISION, MarginRequirementType::Maintenance, true)
            .unwrap();

        let margin_ratio_fill = perp_market
            .get_margin_ratio(BASE_PRECISION, MarginRequirementType::Fill, true)
            .unwrap();

        assert_eq!(margin_ratio_initial, MARGIN_PRECISION / 50);
        assert_eq!(
            margin_ratio_fill,
            (MARGIN_PRECISION / 50 + MARGIN_PRECISION / 100) / 2
        );
        assert_eq!(margin_ratio_maintenance, MARGIN_PRECISION / 100);
    }
}

mod get_min_perp_auction_duration {
    use crate::state::perp_market::{PerpMarket, AMM};
    use crate::State;

    #[test]
    fn test_get_speed_bump() {
        let perp_market = PerpMarket {
            amm: AMM {
                taker_speed_bump_override: 0,
                ..AMM::default()
            },
            ..PerpMarket::default()
        };

        let state = State {
            min_perp_auction_duration: 10,
            ..State::default()
        };

        // no override uses state value
        assert_eq!(
            perp_market.get_min_perp_auction_duration(state.min_perp_auction_duration),
            10
        );

        let perp_market = PerpMarket {
            amm: AMM {
                taker_speed_bump_override: -1,
                ..AMM::default()
            },
            ..PerpMarket::default()
        };

        // -1 override disables speed bump
        assert_eq!(
            perp_market.get_min_perp_auction_duration(state.min_perp_auction_duration),
            0
        );

        let perp_market = PerpMarket {
            amm: AMM {
                taker_speed_bump_override: 20,
                ..AMM::default()
            },
            ..PerpMarket::default()
        };

        // positive override uses override value
        assert_eq!(
            perp_market.get_min_perp_auction_duration(state.min_perp_auction_duration),
            20
        );
    }
}
