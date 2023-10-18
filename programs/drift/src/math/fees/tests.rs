mod calculate_fee_for_taker_and_maker {
    use crate::math::constants::QUOTE_PRECISION_U64;
    use crate::math::fees::{calculate_fee_for_fulfillment_with_match, FillFees};
    use crate::state::state::FeeStructure;
    use crate::state::user::{MarketType, UserStats};

    #[test]
    fn no_filler() {
        let quote_asset_amount = 100 * QUOTE_PRECISION_U64;
        let taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let FillFees {
            user_fee: taker_fee,
            maker_rebate,
            fee_to_market,
            filler_reward,
            referee_discount,
            referrer_reward,
            ..
        } = calculate_fee_for_fulfillment_with_match(
            &taker_stats,
            &Some(&mut maker_stats),
            quote_asset_amount,
            &FeeStructure::test_default(),
            0,
            0,
            0,
            false,
            &None,
            &MarketType::Perp,
            0,
        )
        .unwrap();

        assert_eq!(taker_fee, 100000);
        assert_eq!(maker_rebate, 60000);
        assert_eq!(fee_to_market, 40000);
        assert_eq!(filler_reward, 0);
        assert_eq!(referrer_reward, 0);
        assert_eq!(referee_discount, 0);
    }

    #[test]
    fn filler_size_reward() {
        let quote_asset_amount = 100 * QUOTE_PRECISION_U64;

        let taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let mut fee_structure = FeeStructure::test_default();
        fee_structure
            .filler_reward_structure
            .time_based_reward_lower_bound = 10000000000000000; // big number

        let FillFees {
            user_fee: taker_fee,
            maker_rebate,
            fee_to_market,
            filler_reward,
            referee_discount,
            referrer_reward,
            ..
        } = calculate_fee_for_fulfillment_with_match(
            &taker_stats,
            &Some(&mut maker_stats),
            quote_asset_amount,
            &fee_structure,
            0,
            0,
            1,
            false,
            &None,
            &MarketType::Perp,
            0,
        )
        .unwrap();

        assert_eq!(taker_fee, 100000);
        assert_eq!(maker_rebate, 60000);
        assert_eq!(fee_to_market, 30000);
        assert_eq!(filler_reward, 10000);
        assert_eq!(referrer_reward, 0);
        assert_eq!(referee_discount, 0);
    }

    #[test]
    fn time_reward_no_time_passed() {
        let quote_asset_amount = 100 * QUOTE_PRECISION_U64;

        let taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let mut fee_structure = FeeStructure::test_default();
        fee_structure.filler_reward_structure.reward_numerator = 1; // will make size reward the whole fee
        fee_structure.filler_reward_structure.reward_denominator = 1;

        let FillFees {
            user_fee: taker_fee,
            maker_rebate,
            fee_to_market,
            filler_reward,
            referee_discount,
            referrer_reward,
            ..
        } = calculate_fee_for_fulfillment_with_match(
            &taker_stats,
            &Some(&mut maker_stats),
            quote_asset_amount,
            &fee_structure,
            0,
            0,
            1,
            false,
            &None,
            &MarketType::Perp,
            0,
        )
        .unwrap();

        assert_eq!(taker_fee, 100000);
        assert_eq!(maker_rebate, 60000);
        assert_eq!(fee_to_market, 30000);
        assert_eq!(filler_reward, 10000);
        assert_eq!(referrer_reward, 0);
        assert_eq!(referee_discount, 0);
    }

    #[test]
    fn time_reward_time_passed() {
        let quote_asset_amount = 100 * QUOTE_PRECISION_U64;

        let taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let mut fee_structure = FeeStructure::test_default();
        fee_structure.filler_reward_structure.reward_numerator = 1; // will make size reward the whole fee
        fee_structure.filler_reward_structure.reward_denominator = 1;

        let FillFees {
            user_fee: taker_fee,
            maker_rebate,
            fee_to_market,
            filler_reward,
            referee_discount,
            referrer_reward,
            ..
        } = calculate_fee_for_fulfillment_with_match(
            &taker_stats,
            &Some(&mut maker_stats),
            quote_asset_amount,
            &fee_structure,
            0,
            60,
            1,
            false,
            &None,
            &MarketType::Perp,
            0,
        )
        .unwrap();

        assert_eq!(taker_fee, 100000);
        assert_eq!(maker_rebate, 60000);
        assert_eq!(fee_to_market, 12200);
        assert_eq!(filler_reward, 27800);
        assert_eq!(referrer_reward, 0);
        assert_eq!(referee_discount, 0);
    }

    #[test]
    fn referrer() {
        let quote_asset_amount = 100 * QUOTE_PRECISION_U64;

        let taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let fee_structure = FeeStructure::test_default();

        let FillFees {
            user_fee: taker_fee,
            maker_rebate,
            fee_to_market,
            filler_reward,
            referee_discount,
            referrer_reward,
            ..
        } = calculate_fee_for_fulfillment_with_match(
            &taker_stats,
            &Some(&mut maker_stats),
            quote_asset_amount,
            &fee_structure,
            0,
            0,
            0,
            true,
            &None,
            &MarketType::Perp,
            0,
        )
        .unwrap();

        assert_eq!(taker_fee, 90000);
        assert_eq!(maker_rebate, 60000);
        assert_eq!(fee_to_market, 20000);
        assert_eq!(filler_reward, 0);
        assert_eq!(referrer_reward, 10000);
        assert_eq!(referee_discount, 10000);
    }

    #[test]
    fn fee_adjustment() {
        let quote_asset_amount = 100 * QUOTE_PRECISION_U64;
        let taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let FillFees {
            user_fee: taker_fee,
            maker_rebate,
            fee_to_market,
            filler_reward,
            referee_discount,
            referrer_reward,
            ..
        } = calculate_fee_for_fulfillment_with_match(
            &taker_stats,
            &Some(&mut maker_stats),
            quote_asset_amount,
            &FeeStructure::test_default(),
            0,
            0,
            0,
            false,
            &None,
            &MarketType::Perp,
            -50,
        )
        .unwrap();

        assert_eq!(taker_fee, 50000);
        assert_eq!(maker_rebate, 30000);
        assert_eq!(fee_to_market, 20000);
        assert_eq!(filler_reward, 0);
        assert_eq!(referrer_reward, 0);
        assert_eq!(referee_discount, 0);

        let FillFees {
            user_fee: taker_fee,
            maker_rebate,
            fee_to_market,
            filler_reward,
            referee_discount,
            referrer_reward,
            ..
        } = calculate_fee_for_fulfillment_with_match(
            &taker_stats,
            &Some(&mut maker_stats),
            quote_asset_amount,
            &FeeStructure::test_default(),
            0,
            0,
            0,
            false,
            &None,
            &MarketType::Perp,
            50,
        )
        .unwrap();

        assert_eq!(taker_fee, 150000);
        assert_eq!(maker_rebate, 90000);
        assert_eq!(fee_to_market, 60000);
        assert_eq!(filler_reward, 0);
        assert_eq!(referrer_reward, 0);
        assert_eq!(referee_discount, 0);

        // reward referrer
        let FillFees {
            user_fee: taker_fee,
            maker_rebate,
            fee_to_market,
            filler_reward,
            referee_discount,
            referrer_reward,
            ..
        } = calculate_fee_for_fulfillment_with_match(
            &taker_stats,
            &Some(&mut maker_stats),
            quote_asset_amount,
            &FeeStructure::test_default(),
            0,
            0,
            0,
            true,
            &None,
            &MarketType::Perp,
            -50,
        )
        .unwrap();

        assert_eq!(taker_fee, 45000);
        assert_eq!(maker_rebate, 30000);
        assert_eq!(fee_to_market, 10000);
        assert_eq!(filler_reward, 0);
        assert_eq!(referrer_reward, 5000);
        assert_eq!(referee_discount, 5000);

        // reward referrer + filler
        let FillFees {
            user_fee: taker_fee,
            maker_rebate,
            fee_to_market,
            filler_reward,
            referee_discount,
            referrer_reward,
            ..
        } = calculate_fee_for_fulfillment_with_match(
            &taker_stats,
            &Some(&mut maker_stats),
            quote_asset_amount,
            &FeeStructure::test_default(),
            0,
            0,
            1,
            true,
            &None,
            &MarketType::Perp,
            -50,
        )
        .unwrap();

        assert_eq!(taker_fee, 45000);
        assert_eq!(maker_rebate, 30000);
        assert_eq!(fee_to_market, 5500);
        assert_eq!(filler_reward, 4500);
        assert_eq!(referrer_reward, 5000);
        assert_eq!(referee_discount, 5000);
    }
}

mod calculate_fee_for_order_fulfill_against_amm {
    use crate::math::constants::QUOTE_PRECISION_U64;
    use crate::math::fees::{calculate_fee_for_fulfillment_with_amm, FillFees};
    use crate::state::state::FeeStructure;
    use crate::state::user::UserStats;

    #[test]
    fn referrer() {
        let quote_asset_amount = 100 * QUOTE_PRECISION_U64;

        let taker_stats = UserStats::default();
        let fee_structure = FeeStructure::test_default();

        let FillFees {
            user_fee,
            fee_to_market,
            filler_reward,
            referee_discount,
            referrer_reward,
            ..
        } = calculate_fee_for_fulfillment_with_amm(
            &taker_stats,
            quote_asset_amount,
            &fee_structure,
            0,
            60,
            false,
            true,
            &None,
            0,
            false,
            0,
        )
        .unwrap();

        assert_eq!(user_fee, 90000);
        assert_eq!(fee_to_market, 80000);
        assert_eq!(filler_reward, 0);
        assert_eq!(referrer_reward, 10000);
        assert_eq!(referee_discount, 10000);
    }

    #[test]
    fn fee_adjustment() {
        let quote_asset_amount = 100 * QUOTE_PRECISION_U64;

        let taker_stats = UserStats::default();
        let fee_structure = FeeStructure::test_default();

        let FillFees {
            user_fee,
            fee_to_market,
            filler_reward,
            referee_discount,
            referrer_reward,
            ..
        } = calculate_fee_for_fulfillment_with_amm(
            &taker_stats,
            quote_asset_amount,
            &fee_structure,
            0,
            60,
            false,
            false,
            &None,
            0,
            false,
            -50,
        )
        .unwrap();

        assert_eq!(user_fee, 50000);
        assert_eq!(fee_to_market, 50000);
        assert_eq!(filler_reward, 0);
        assert_eq!(referrer_reward, 0);
        assert_eq!(referee_discount, 0);

        let FillFees {
            user_fee,
            fee_to_market,
            filler_reward,
            referee_discount,
            referrer_reward,
            ..
        } = calculate_fee_for_fulfillment_with_amm(
            &taker_stats,
            quote_asset_amount,
            &fee_structure,
            0,
            60,
            false,
            false,
            &None,
            0,
            false,
            50,
        )
        .unwrap();

        assert_eq!(user_fee, 150000);
        assert_eq!(fee_to_market, 150000);
        assert_eq!(filler_reward, 0);
        assert_eq!(referrer_reward, 0);
        assert_eq!(referee_discount, 0);

        // reward referrer
        let FillFees {
            user_fee,
            fee_to_market,
            filler_reward,
            referee_discount,
            referrer_reward,
            ..
        } = calculate_fee_for_fulfillment_with_amm(
            &taker_stats,
            quote_asset_amount,
            &fee_structure,
            0,
            60,
            false,
            true,
            &None,
            0,
            false,
            -50,
        )
        .unwrap();

        assert_eq!(user_fee, 45000);
        assert_eq!(fee_to_market, 40000);
        assert_eq!(filler_reward, 0);
        assert_eq!(referrer_reward, 5000);
        assert_eq!(referee_discount, 5000);

        // reward referrer + filler
        let FillFees {
            user_fee,
            fee_to_market,
            filler_reward,
            referee_discount,
            referrer_reward,
            ..
        } = calculate_fee_for_fulfillment_with_amm(
            &taker_stats,
            quote_asset_amount,
            &fee_structure,
            0,
            60,
            true,
            true,
            &None,
            0,
            false,
            -50,
        )
        .unwrap();

        assert_eq!(user_fee, 45000);
        assert_eq!(fee_to_market, 35500);
        assert_eq!(filler_reward, 4500);
        assert_eq!(referrer_reward, 5000);
        assert_eq!(referee_discount, 5000);
    }
}

mod calculate_fee_for_fulfillment_with_serum {
    use crate::math::constants::QUOTE_PRECISION_U64;
    use crate::math::fees::{calculate_fee_for_fulfillment_with_external_market, ExternalFillFees};
    use crate::state::state::FeeStructure;
    use crate::state::user::UserStats;

    #[test]
    fn no_filler() {
        let quote_asset_amount = 100 * QUOTE_PRECISION_U64;

        let serum_fee = 32000_u64; // 3.2 bps

        let serum_referrer_rebate = 8000_u64; // .8 bps

        let fee_pool_token_amount = 0_u64;

        let taker_stats = UserStats::default();
        let fee_structure = FeeStructure::test_default();

        let ExternalFillFees {
            user_fee,
            fee_to_market,
            fee_pool_delta,
            filler_reward,
        } = calculate_fee_for_fulfillment_with_external_market(
            &taker_stats,
            quote_asset_amount,
            &fee_structure,
            0,
            0,
            false,
            serum_fee,
            serum_referrer_rebate,
            fee_pool_token_amount,
            0,
        )
        .unwrap();

        assert_eq!(user_fee, 100000);
        assert_eq!(fee_to_market, 68000);
        assert_eq!(fee_pool_delta, 60000);
        assert_eq!(filler_reward, 0);
    }

    #[test]
    fn filler_reward_from_excess_user_fee() {
        let quote_asset_amount = 100 * QUOTE_PRECISION_U64;

        let serum_fee = 32000_u64; // 3.2 bps

        let serum_referrer_rebate = 8000_u64; // .8 bps

        let fee_pool_token_amount = 0_u64;

        let taker_stats = UserStats::default();
        let fee_structure = FeeStructure::test_default();

        let ExternalFillFees {
            user_fee,
            fee_to_market,
            fee_pool_delta,
            filler_reward,
        } = calculate_fee_for_fulfillment_with_external_market(
            &taker_stats,
            quote_asset_amount,
            &fee_structure,
            0,
            0,
            true,
            serum_fee,
            serum_referrer_rebate,
            fee_pool_token_amount,
            0,
        )
        .unwrap();

        assert_eq!(user_fee, 100000);
        assert_eq!(fee_to_market, 58000);
        assert_eq!(fee_pool_delta, 50000);
        assert_eq!(filler_reward, 10000);
    }

    #[test]
    fn filler_reward_from_fee_pool() {
        let quote_asset_amount = 100 * QUOTE_PRECISION_U64;

        let serum_fee = 32000_u64; // 3.2 bps

        let serum_referrer_rebate = 8000_u64; // .8 bps

        let fee_pool_token_amount = 10000_u64;

        let user_stats = UserStats::default();
        let mut fee_structure = FeeStructure::test_default();
        fee_structure.fee_tiers[0].fee_numerator = 4;

        let ExternalFillFees {
            user_fee,
            fee_to_market,
            fee_pool_delta,
            filler_reward,
        } = calculate_fee_for_fulfillment_with_external_market(
            &user_stats,
            quote_asset_amount,
            &fee_structure,
            0,
            0,
            true,
            serum_fee,
            serum_referrer_rebate,
            fee_pool_token_amount,
            0,
        )
        .unwrap();

        assert_eq!(user_fee, 40000);
        assert_eq!(fee_to_market, 0);
        assert_eq!(fee_pool_delta, -8000);
        assert_eq!(filler_reward, 8000);
    }

    #[test]
    fn filler_reward_from_smaller_fee_pool() {
        let quote_asset_amount = 100 * QUOTE_PRECISION_U64;

        let serum_fee = 32000_u64; // 3.2 bps

        let serum_referrer_rebate = 8000_u64; // .8 bps

        let fee_pool_token_amount = 2000_u64;

        let user_stats = UserStats::default();
        let mut fee_structure = FeeStructure::test_default();
        fee_structure.fee_tiers[0].fee_numerator = 4;

        let ExternalFillFees {
            user_fee,
            fee_to_market,
            fee_pool_delta,
            filler_reward,
        } = calculate_fee_for_fulfillment_with_external_market(
            &user_stats,
            quote_asset_amount,
            &fee_structure,
            0,
            0,
            true,
            serum_fee,
            serum_referrer_rebate,
            fee_pool_token_amount,
            0,
        )
        .unwrap();

        assert_eq!(user_fee, 40000);
        assert_eq!(fee_to_market, 6000);
        assert_eq!(fee_pool_delta, -2000);
        assert_eq!(filler_reward, 2000);
    }
}
