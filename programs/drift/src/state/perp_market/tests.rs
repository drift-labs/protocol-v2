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
        assert_eq!(margin_ratio_initial, MARGIN_PRECISION / 50);

        let margin_ratio_maintenance = perp_market
            .get_margin_ratio(BASE_PRECISION, MarginRequirementType::Maintenance, true)
            .unwrap();

        assert_eq!(margin_ratio_maintenance, MARGIN_PRECISION / 100);

        let margin_ratio_fill = perp_market
            .get_margin_ratio(BASE_PRECISION, MarginRequirementType::Fill, true)
            .unwrap();

        assert_eq!(
            margin_ratio_fill,
            (MARGIN_PRECISION / 50 + MARGIN_PRECISION / 100) / 2
        );
    }

    #[test]
    fn new_hlm_imf_size_loop() {
        let perp_market = PerpMarket {
            margin_ratio_initial: MARGIN_PRECISION / 20,
            margin_ratio_maintenance: MARGIN_PRECISION / 33,
            high_leverage_margin_ratio_initial: (MARGIN_PRECISION / 100) as u16,
            high_leverage_margin_ratio_maintenance: (MARGIN_PRECISION / 151) as u16,
            imf_factor: 50,
            ..PerpMarket::default()
        };

        let mut cnt = 0;

        for i in 1..1_000 {
            let hlm_margin_ratio_initial = perp_market
                .get_margin_ratio(
                    BASE_PRECISION * i * 1000,
                    MarginRequirementType::Initial,
                    true,
                )
                .unwrap();

            let margin_ratio_initial = perp_market
                .get_margin_ratio(
                    BASE_PRECISION * i * 1000,
                    MarginRequirementType::Initial,
                    false,
                )
                .unwrap();

            if margin_ratio_initial != perp_market.margin_ratio_initial {
                // crate::msg!("{}", BASE_PRECISION * i);
                assert_eq!(hlm_margin_ratio_initial, margin_ratio_initial);
                cnt += 1;
            }
        }

        assert_eq!(cnt, 959_196 / 1_000);
    }

    #[test]
    fn new_hlm_imf_size() {
        let perp_market = PerpMarket {
            margin_ratio_initial: MARGIN_PRECISION / 10,
            margin_ratio_maintenance: MARGIN_PRECISION / 20,
            high_leverage_margin_ratio_initial: (MARGIN_PRECISION / 100) as u16,
            high_leverage_margin_ratio_maintenance: (MARGIN_PRECISION / 200) as u16,
            imf_factor: 50,
            ..PerpMarket::default()
        };

        let normal_margin_ratio_initial = perp_market
            .get_margin_ratio(
                BASE_PRECISION * 1000000,
                MarginRequirementType::Initial,
                false,
            )
            .unwrap();

        assert_eq!(normal_margin_ratio_initial, 1300);

        let hlm_margin_ratio_initial = perp_market
            .get_margin_ratio(BASE_PRECISION / 10, MarginRequirementType::Initial, true)
            .unwrap();

        assert_eq!(
            hlm_margin_ratio_initial,
            perp_market.high_leverage_margin_ratio_initial as u32
        );

        let hlm_margin_ratio_initial = perp_market
            .get_margin_ratio(BASE_PRECISION, MarginRequirementType::Initial, true)
            .unwrap();

        assert_eq!(
            hlm_margin_ratio_initial,
            perp_market.high_leverage_margin_ratio_initial as u32
        );

        let hlm_margin_ratio_initial = perp_market
            .get_margin_ratio(BASE_PRECISION * 10, MarginRequirementType::Initial, true)
            .unwrap();

        assert_eq!(
            hlm_margin_ratio_initial,
            104 // slightly under 100x at 10 base
        );

        let hlm_margin_ratio_initial_sized = perp_market
            .get_margin_ratio(BASE_PRECISION * 3000, MarginRequirementType::Initial, true)
            .unwrap();
        assert_eq!(hlm_margin_ratio_initial_sized, 221);
        assert!(
            hlm_margin_ratio_initial_sized > perp_market.high_leverage_margin_ratio_initial as u32
        );

        let hlm_margin_ratio_maint = perp_market
            .get_margin_ratio(
                BASE_PRECISION * 3000,
                MarginRequirementType::Maintenance,
                true,
            )
            .unwrap();
        assert_eq!(hlm_margin_ratio_maint, 67); // hardly changed

        let hlm_margin_ratio_maint = perp_market
            .get_margin_ratio(
                BASE_PRECISION * 300000,
                MarginRequirementType::Maintenance,
                true,
            )
            .unwrap();
        assert_eq!(hlm_margin_ratio_maint, 313); // changed more at large size
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

mod get_trigger_price {
    use crate::state::perp_market::HistoricalOracleData;
    use crate::state::perp_market::{PerpMarket, AMM};

    #[test]
    fn test_get_last_funding_basis() {
        let oracle_price = 109144736794;
        let last_funding_rate_ts = 1752080410;
        let now = last_funding_rate_ts + 0;
        let perp_market = PerpMarket {
            amm: AMM {
                last_funding_rate: 1410520875,
                last_funding_rate_ts: 1752080410,
                last_mark_price_twap: 109146153042,
                last_funding_oracle_twap: 109198342833,
                funding_period: 3600,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap_5min: 109143803911,
                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            ..PerpMarket::default()
        };

        let last_funding_basis = perp_market
            .get_last_funding_basis(oracle_price, now)
            .unwrap();

        assert_eq!(last_funding_basis, 12006794); // $12 basis

        let now = last_funding_rate_ts + 1800;
        let last_funding_basis = perp_market
            .get_last_funding_basis(oracle_price, now)
            .unwrap();

        assert_eq!(last_funding_basis, 6003397); // $6 basis

        let now = last_funding_rate_ts + 3600;
        let last_funding_basis = perp_market
            .get_last_funding_basis(oracle_price, now)
            .unwrap();

        assert_eq!(last_funding_basis, 0);

        let now = last_funding_rate_ts + 5400;
        let last_funding_basis = perp_market
            .get_last_funding_basis(oracle_price, now)
            .unwrap();

        assert_eq!(last_funding_basis, 0);
    }

    #[test]
    fn test_get_trigger_price() {
        let oracle_price = 109144736794;
        let now = 1752082210;
        let perp_market = PerpMarket {
            amm: AMM {
                last_funding_rate: 1410520875,
                last_funding_rate_ts: 1752080410,
                last_mark_price_twap: 109146153042,
                last_funding_oracle_twap: 109198342833,
                funding_period: 3600,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap_5min: 109143803911,
                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            ..PerpMarket::default()
        };

        let trigger_price = perp_market
            .get_trigger_price(oracle_price, now, true)
            .unwrap();

        assert_eq!(trigger_price, 109144736794);
    }

    #[test]
    fn test_clamp_trigger_price() {
        use crate::state::perp_market::{ContractTier, PerpMarket};

        // Test Contract Tier A (20 BPS = 500 divisor)
        let perp_market_a = PerpMarket {
            contract_tier: ContractTier::A,
            ..PerpMarket::default()
        };

        let oracle_price = 100_000_000_000; // $100,000
        let max_bps_diff = 500; // 20 BPS
        let max_oracle_diff = oracle_price / max_bps_diff; // 200,000,000

        // Test median price below lower bound
        let median_price_below = oracle_price - max_oracle_diff - 1_000_000;
        let clamped_price = perp_market_a
            .clamp_trigger_price(oracle_price, median_price_below)
            .unwrap();
        assert_eq!(clamped_price, oracle_price - max_oracle_diff);

        // Test median price above upper bound
        let median_price_above = oracle_price + max_oracle_diff + 1_000_000;
        let clamped_price = perp_market_a
            .clamp_trigger_price(oracle_price, median_price_above)
            .unwrap();
        assert_eq!(clamped_price, oracle_price + max_oracle_diff);

        // Test median price within bounds (should not be clamped)
        let median_price_within = oracle_price + max_oracle_diff / 2;
        let clamped_price = perp_market_a
            .clamp_trigger_price(oracle_price, median_price_within)
            .unwrap();
        assert_eq!(clamped_price, median_price_within);

        // Test median price at exact bounds
        let median_price_at_lower = oracle_price - max_oracle_diff;
        let clamped_price = perp_market_a
            .clamp_trigger_price(oracle_price, median_price_at_lower)
            .unwrap();
        assert_eq!(clamped_price, median_price_at_lower);

        let median_price_at_upper = oracle_price + max_oracle_diff;
        let clamped_price = perp_market_a
            .clamp_trigger_price(oracle_price, median_price_at_upper)
            .unwrap();
        assert_eq!(clamped_price, median_price_at_upper);

        // Test Contract Tier C (100 BPS = 100 divisor)
        let perp_market_c = PerpMarket {
            contract_tier: ContractTier::C,
            ..PerpMarket::default()
        };

        let max_bps_diff_c = 100; // 100 BPS
        let max_oracle_diff_c = oracle_price / max_bps_diff_c; // 1,000,000,000

        // Test median price below lower bound for Tier C
        let median_price_below_c = oracle_price - max_oracle_diff_c - 1_000_000;
        let clamped_price = perp_market_c
            .clamp_trigger_price(oracle_price, median_price_below_c)
            .unwrap();
        assert_eq!(clamped_price, oracle_price - max_oracle_diff_c);

        // Test median price above upper bound for Tier C
        let median_price_above_c = oracle_price + max_oracle_diff_c + 1_000_000;
        let clamped_price = perp_market_c
            .clamp_trigger_price(oracle_price, median_price_above_c)
            .unwrap();
        assert_eq!(clamped_price, oracle_price + max_oracle_diff_c);

        // Test median price within bounds for Tier C
        let median_price_within_c = oracle_price + max_oracle_diff_c / 2;
        let clamped_price = perp_market_c
            .clamp_trigger_price(oracle_price, median_price_within_c)
            .unwrap();
        assert_eq!(clamped_price, median_price_within_c);

        // Test edge cases with very small oracle price
        let small_oracle_price = 1_000_000; // $1
        let max_oracle_diff_small = small_oracle_price / max_bps_diff; // 2,000

        let median_price_small = small_oracle_price - max_oracle_diff_small - 100;
        let clamped_price = perp_market_a
            .clamp_trigger_price(small_oracle_price, median_price_small)
            .unwrap();
        assert_eq!(clamped_price, small_oracle_price - max_oracle_diff_small);

        // Test edge cases with very large oracle price
        let large_oracle_price = 1_000_000_000_000_000; // $1M
        let max_oracle_diff_large = large_oracle_price / max_bps_diff; // 2,000,000,000,000

        let median_price_large = large_oracle_price + max_oracle_diff_large + 1_000_000_000;
        let clamped_price = perp_market_a
            .clamp_trigger_price(large_oracle_price, median_price_large)
            .unwrap();
        assert_eq!(clamped_price, large_oracle_price + max_oracle_diff_large);
    }
}
