use crate::math::constants::AMM_RESERVE_PRECISION;
use crate::math::lp::*;
use crate::state::user::PerpPosition;

mod calculate_get_proportion_u128 {
    use crate::math::helpers::get_proportion_u128;

    use super::*;

    pub fn get_proportion_u128_safe(
        value: u128,
        numerator: u128,
        denominator: u128,
    ) -> DriftResult<u128> {
        if numerator == 0 {
            return Ok(0);
        }

        let proportional_value = if numerator <= denominator {
            let ratio = denominator.safe_mul(10000)?.safe_div(numerator)?;
            value.safe_mul(10000)?.safe_div(ratio)?
        } else {
            value.safe_mul(numerator)?.safe_div(denominator)?
        };

        Ok(proportional_value)
    }

    #[test]
    fn test_safe() {
        let sqrt_k = AMM_RESERVE_PRECISION * 10_123;
        let max_reserve = sqrt_k * 14121 / 10000;
        let max_asks = max_reserve - sqrt_k;

        // let ans1 = get_proportion_u128_safe(max_asks, sqrt_k - sqrt_k / 100, sqrt_k).unwrap();
        // let ans2 = get_proportion_u128(max_asks, sqrt_k - sqrt_k / 100, sqrt_k).unwrap();
        // assert_eq!(ans1, ans2); //fails

        let ans1 = get_proportion_u128_safe(max_asks, sqrt_k / 2, sqrt_k).unwrap();
        let ans2 = get_proportion_u128(max_asks, sqrt_k / 2, sqrt_k).unwrap();
        assert_eq!(ans1, ans2);

        let ans1 = get_proportion_u128_safe(max_asks, AMM_RESERVE_PRECISION, sqrt_k).unwrap();
        let ans2 = get_proportion_u128(max_asks, AMM_RESERVE_PRECISION, sqrt_k).unwrap();
        assert_eq!(ans1, ans2);

        let ans1 = get_proportion_u128_safe(max_asks, 0, sqrt_k).unwrap();
        let ans2 = get_proportion_u128(max_asks, 0, sqrt_k).unwrap();
        assert_eq!(ans1, ans2);

        let ans1 = get_proportion_u128_safe(max_asks, 1325324, sqrt_k).unwrap();
        let ans2 = get_proportion_u128(max_asks, 1325324, sqrt_k).unwrap();
        assert_eq!(ans1, ans2);

        // let ans1 = get_proportion_u128(max_asks, sqrt_k, sqrt_k).unwrap();
        // assert_eq!(ans1, max_asks);
    }
}

mod calculate_lp_open_bids_asks {
    use super::*;

    #[test]
    fn test_simple_lp_bid_ask() {
        let position = PerpPosition {
            lp_shares: 100,
            ..PerpPosition::default()
        };

        let amm = AMM {
            base_asset_reserve: 10,
            max_base_asset_reserve: 100,
            min_base_asset_reserve: 0,
            sqrt_k: 200,
            ..AMM::default_test()
        };
        let market = PerpMarket {
            amm,
            ..PerpMarket::default_test()
        };

        let (open_bids, open_asks) = calculate_lp_open_bids_asks(&position, &market).unwrap();

        assert_eq!(open_bids, 10 * 100 / 200);
        assert_eq!(open_asks, -90 * 100 / 200);
    }

    #[test]
    fn test_max_ask() {
        let position = PerpPosition {
            lp_shares: 100,
            ..PerpPosition::default()
        };

        let amm = AMM {
            base_asset_reserve: 0,
            max_base_asset_reserve: 100,
            min_base_asset_reserve: 0,
            sqrt_k: 200,
            ..AMM::default_test()
        };
        let market = PerpMarket {
            amm,
            ..PerpMarket::default_test()
        };

        let (open_bids, open_asks) = calculate_lp_open_bids_asks(&position, &market).unwrap();

        assert_eq!(open_bids, 0); // wont go anymore short
        assert_eq!(open_asks, -100 * 100 / 200);
    }

    #[test]
    fn test_max_bid() {
        let position = PerpPosition {
            lp_shares: 100,
            ..PerpPosition::default()
        };

        let amm = AMM {
            base_asset_reserve: 10,
            max_base_asset_reserve: 10,
            min_base_asset_reserve: 0,
            sqrt_k: 200,
            ..AMM::default_test()
        };
        let market = PerpMarket {
            amm,
            ..PerpMarket::default_test()
        };

        let (open_bids, open_asks) = calculate_lp_open_bids_asks(&position, &market).unwrap();

        assert_eq!(open_bids, 10 * 100 / 200);
        assert_eq!(open_asks, 0); // no more long
    }
}

mod calculate_settled_lp_base_quote {
    use crate::math::constants::BASE_PRECISION_U64;

    use super::*;

    #[test]
    fn test_long_settle() {
        let position = PerpPosition {
            lp_shares: 100 * BASE_PRECISION_U64,
            ..PerpPosition::default()
        };

        let amm = AMM {
            base_asset_amount_per_lp: 10,
            quote_asset_amount_per_lp: -10,
            ..AMM::default_test()
        };

        let (baa, qaa) = calculate_settled_lp_base_quote(&amm, &position).unwrap();

        assert_eq!(baa, 10 * 100);
        assert_eq!(qaa, -10 * 100);
    }

    #[test]
    fn test_short_settle() {
        let position = PerpPosition {
            lp_shares: 100 * BASE_PRECISION_U64,
            ..PerpPosition::default()
        };

        let amm = AMM {
            base_asset_amount_per_lp: -10,
            quote_asset_amount_per_lp: 10,
            ..AMM::default_test()
        };

        let (baa, qaa) = calculate_settled_lp_base_quote(&amm, &position).unwrap();

        assert_eq!(baa, -10 * 100);
        assert_eq!(qaa, 10 * 100);
    }
}

mod calculate_settle_lp_metrics {
    use crate::math::constants::BASE_PRECISION_U64;

    use super::*;

    #[test]
    fn test_long_settle() {
        let position = PerpPosition {
            lp_shares: 100 * BASE_PRECISION_U64,
            ..PerpPosition::default()
        };

        let amm = AMM {
            base_asset_amount_per_lp: 10,
            quote_asset_amount_per_lp: -10,
            order_step_size: 1,
            ..AMM::default_test()
        };

        let lp_metrics = calculate_settle_lp_metrics(&amm, &position).unwrap();

        assert_eq!(lp_metrics.base_asset_amount, 10 * 100);
        assert_eq!(lp_metrics.quote_asset_amount, -10 * 100);
        assert_eq!(lp_metrics.remainder_base_asset_amount, 0);
    }

    #[test]
    fn test_all_remainder() {
        let position = PerpPosition {
            lp_shares: 100 * BASE_PRECISION_U64,
            ..PerpPosition::default()
        };

        let amm = AMM {
            base_asset_amount_per_lp: 10,
            quote_asset_amount_per_lp: -10,
            order_step_size: 50 * 100,
            ..AMM::default_test()
        };

        let lp_metrics = calculate_settle_lp_metrics(&amm, &position).unwrap();

        assert_eq!(lp_metrics.base_asset_amount, 0);
        assert_eq!(lp_metrics.quote_asset_amount, -10 * 100);
        assert_eq!(lp_metrics.remainder_base_asset_amount, 10 * 100);
    }

    #[test]
    fn test_portion_remainder() {
        let position = PerpPosition {
            lp_shares: BASE_PRECISION_U64,
            ..PerpPosition::default()
        };

        let amm = AMM {
            base_asset_amount_per_lp: 10,
            quote_asset_amount_per_lp: -10,
            order_step_size: 3,
            ..AMM::default_test()
        };

        let lp_metrics = calculate_settle_lp_metrics(&amm, &position).unwrap();

        assert_eq!(lp_metrics.base_asset_amount, 9);
        assert_eq!(lp_metrics.quote_asset_amount, -10);
        assert_eq!(lp_metrics.remainder_base_asset_amount, 1);
    }
}
