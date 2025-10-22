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

mod amm_can_fill_order_tests {
    use crate::controller::position::PositionDirection;
    use crate::math::oracle::OracleValidity;
    use crate::state::fill_mode::FillMode;
    use crate::state::oracle::{MMOraclePriceData, OraclePriceData};
    use crate::state::paused_operations::PerpOperation;
    use crate::state::perp_market::{PerpMarket, AMM};
    use crate::state::state::{State, ValidityGuardRails};
    use crate::state::user::{Order, OrderStatus};
    use crate::PRICE_PRECISION_I64;

    fn base_state() -> State {
        State {
            min_perp_auction_duration: 10,
            ..State::default()
        }
    }

    fn base_market() -> PerpMarket {
        PerpMarket {
            amm: AMM {
                mm_oracle_price: PRICE_PRECISION_I64,
                mm_oracle_slot: 0,
                order_step_size: 1,
                amm_jit_intensity: 100,
                ..AMM::default()
            },
            ..PerpMarket::default()
        }
    }

    fn base_order() -> Order {
        Order {
            status: OrderStatus::Open,
            slot: 0,
            base_asset_amount: 1,
            direction: PositionDirection::Long,
            ..Order::default()
        }
    }

    fn mm_oracle_ok_and_as_recent() -> (MMOraclePriceData, ValidityGuardRails) {
        let exchange = OraclePriceData {
            price: PRICE_PRECISION_I64,
            confidence: 1,
            delay: 5,
            has_sufficient_number_of_data_points: true,
            sequence_id: Some(100),
        };
        let mm =
            MMOraclePriceData::new(PRICE_PRECISION_I64, 5, 100, OracleValidity::Valid, exchange)
                .unwrap();
        (mm, ValidityGuardRails::default())
    }

    #[test]
    fn paused_operation_returns_false() {
        let mut market = base_market();
        // Pause AMM fill
        market.paused_operations = PerpOperation::AmmFill as u8;
        let order = base_order();
        let state = base_state();
        let (mm, guard) = mm_oracle_ok_and_as_recent();

        let can = market
            .amm_can_fill_order(
                &order,
                10,
                FillMode::Fill,
                &state,
                OracleValidity::Valid,
                true,
                &mm,
            )
            .unwrap();
        assert!(!can);
    }

    #[test]
    fn mm_oracle_too_volatile_blocks() {
        let market = base_market();
        let order = base_order();
        let state = base_state();

        // Create MM oracle data with >1% diff vs exchange to force fallback and block
        let exchange = OraclePriceData {
            price: PRICE_PRECISION_I64, // 1.0
            confidence: 1,
            delay: 1,
            has_sufficient_number_of_data_points: true,
            sequence_id: Some(100),
        };
        // 3% higher than exchange
        let mm = MMOraclePriceData::new(
            PRICE_PRECISION_I64 + (PRICE_PRECISION_I64 / 33),
            1,
            99,
            OracleValidity::Valid,
            exchange,
        )
        .unwrap();

        let can = market
            .amm_can_fill_order(
                &order,
                10,
                FillMode::Fill,
                &state,
                OracleValidity::Valid,
                true,
                &mm,
            )
            .unwrap();
        assert!(!can);
    }

    #[test]
    fn low_risk_path_succeeds_when_auction_elapsed() {
        let market = base_market();
        let mut order = base_order();
        order.slot = 0;

        let state = base_state();
        let (mm, _) = mm_oracle_ok_and_as_recent();

        // clock_slot sufficiently beyond min_auction_duration
        let can = market
            .amm_can_fill_order(
                &order,
                15,
                FillMode::Fill,
                &state,
                OracleValidity::Valid,
                true,
                &mm,
            )
            .unwrap();
        assert!(can);
    }

    #[test]
    fn low_risk_path_succeeds_when_auction_elapsed_with_stale_for_immediate() {
        let market = base_market();
        let mut order = base_order();
        order.slot = 0; // order placed at slot 0

        let state = base_state();
        let (mm, _) = mm_oracle_ok_and_as_recent();

        // clock_slot sufficiently beyond min_auction_duration
        let can = market
            .amm_can_fill_order(
                &order,
                15,
                FillMode::Fill,
                &state,
                OracleValidity::StaleForAMM {
                    immediate: true,
                    low_risk: false,
                },
                true,
                &mm,
            )
            .unwrap();
        assert!(can);
    }

    #[test]
    fn high_risk_immediate_requires_user_and_market_skip() {
        let mut market = base_market();
        let mut order = base_order();
        order.slot = 20;
        market.amm.amm_jit_intensity = 100;

        let state = base_state();
        let (mm, _) = mm_oracle_ok_and_as_recent();

        // cnat fill if user cant skip auction duration
        let can1 = market
            .amm_can_fill_order(
                &order,
                21,
                FillMode::Fill,
                &state,
                OracleValidity::Valid,
                false,
                &mm,
            )
            .unwrap();
        assert!(!can1);

        // valid oracle for immediate and user can skip, market can skip due to low inventory => can fill
        market.amm.base_asset_amount_with_amm = -2; // taker long improves balance
        market.amm.order_step_size = 1;
        market.amm.base_asset_reserve = 1_000_000;
        market.amm.quote_asset_reserve = 1_000_000;
        market.amm.sqrt_k = 1_000_000;
        market.amm.max_base_asset_reserve = 2_000_000;
        market.amm.min_base_asset_reserve = 0;

        let can2 = market
            .amm_can_fill_order(
                &order,
                21,
                FillMode::Fill,
                &state,
                OracleValidity::Valid,
                true,
                &mm,
            )
            .unwrap();
        assert!(can2);
    }

    #[test]
    fn invalid_safe_oracle_validity_blocks_low_risk() {
        let market = base_market();
        let order = base_order();
        let state = base_state();
        let (mm, _) = mm_oracle_ok_and_as_recent();

        // Order is old but invalid oracle validity
        let can = market
            .amm_can_fill_order(
                &order,
                20,
                FillMode::Fill,
                &state,
                OracleValidity::StaleForAMM {
                    immediate: true,
                    low_risk: true,
                },
                true,
                &mm,
            )
            .unwrap();
        assert!(!can);
    }
}
