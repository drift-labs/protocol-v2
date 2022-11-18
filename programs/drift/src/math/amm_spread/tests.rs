#[cfg(test)]
mod test {
    use crate::math::amm_spread::*;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BID_ASK_SPREAD_PRECISION, BID_ASK_SPREAD_PRECISION_I64,
        QUOTE_PRECISION, QUOTE_PRECISION_I128,
    };

    #[test]
    fn max_spread_tests() {
        let (l, s) = cap_to_max_spread(3905832905, 3582930, 1000).unwrap();
        assert_eq!(l, 1000);
        assert_eq!(s, 0);

        let (l, s) = cap_to_max_spread(9999, 1, 1000).unwrap();
        assert_eq!(l, 1000);
        assert_eq!(s, 0);

        let (l, s) = cap_to_max_spread(999, 1, 1000).unwrap();
        assert_eq!(l, 999);
        assert_eq!(s, 1);

        let (l, s) = cap_to_max_spread(444, 222, 1000).unwrap();
        assert_eq!(l, 444);
        assert_eq!(s, 222);

        let (l, s) = cap_to_max_spread(150, 2221, 1000).unwrap();
        assert_eq!(l, 0);
        assert_eq!(s, 1000);

        let (l, s) = cap_to_max_spread(2500 - 10, 11, 2500).unwrap();
        assert_eq!(l, 2490);
        assert_eq!(s, 10);

        let (l, s) = cap_to_max_spread(2510, 110, 2500).unwrap();
        assert_eq!(l, 2500);
        assert_eq!(s, 0);
    }

    #[test]
    fn calculate_spread_tests() {
        let base_spread = 1000; // .1%
        let mut last_oracle_reserve_price_spread_pct = 0;
        let mut last_oracle_conf_pct = 0;
        let quote_asset_reserve = AMM_RESERVE_PRECISION * 10;
        let mut terminal_quote_asset_reserve = AMM_RESERVE_PRECISION * 10;
        let peg_multiplier = 34000000;
        let mut base_asset_amount_with_amm = 0;
        let reserve_price = 34562304;
        let mut total_fee_minus_distributions = 0;

        let base_asset_reserve = AMM_RESERVE_PRECISION * 10;
        let min_base_asset_reserve = 0_u128;
        let max_base_asset_reserve = AMM_RESERVE_PRECISION * 100000;

        let margin_ratio_initial = 2000; // 5x max leverage
        let max_spread = margin_ratio_initial * 100;

        let mark_std = 0;
        let oracle_std = 0;
        let long_intensity_volume = 0;
        let short_intensity_volume = 0;
        let volume_24h = 0;

        // at 0 fee be max spread
        let (long_spread1, short_spread1) = calculate_spread(
            base_spread,
            last_oracle_reserve_price_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            base_asset_amount_with_amm,
            reserve_price,
            total_fee_minus_distributions,
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
            mark_std,
            oracle_std,
            long_intensity_volume,
            short_intensity_volume,
            volume_24h,
        )
        .unwrap();
        assert_eq!(long_spread1, (base_spread * 10 / 2));
        assert_eq!(short_spread1, (base_spread * 10 / 2));

        // even at imbalance with 0 fee, be max spread
        terminal_quote_asset_reserve -= AMM_RESERVE_PRECISION;
        base_asset_amount_with_amm += AMM_RESERVE_PRECISION as i128;

        let (long_spread2, short_spread2) = calculate_spread(
            base_spread,
            last_oracle_reserve_price_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            base_asset_amount_with_amm,
            reserve_price,
            total_fee_minus_distributions,
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
            mark_std,
            oracle_std,
            long_intensity_volume,
            short_intensity_volume,
            volume_24h,
        )
        .unwrap();
        assert_eq!(long_spread2, (base_spread * 10));
        assert_eq!(short_spread2, (base_spread * 10 / 2));

        // oracle retreat * skew that increases long spread
        last_oracle_reserve_price_spread_pct = BID_ASK_SPREAD_PRECISION_I64 / 20; //5%
        last_oracle_conf_pct = (BID_ASK_SPREAD_PRECISION / 100) as u64; //1%
        total_fee_minus_distributions = QUOTE_PRECISION as i128;
        let (long_spread3, short_spread3) = calculate_spread(
            base_spread,
            last_oracle_reserve_price_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            base_asset_amount_with_amm,
            reserve_price,
            total_fee_minus_distributions,
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
            mark_std,
            oracle_std,
            long_intensity_volume,
            short_intensity_volume,
            volume_24h,
        )
        .unwrap();
        assert!(short_spread3 > long_spread3);

        // 1000/2 * (1+(34562000-34000000)/QUOTE_PRECISION) -> 781
        assert_eq!(long_spread3, 31246);

        // last_oracle_reserve_price_spread_pct + conf retreat
        // assert_eq!(short_spread3, 1010000);
        assert_eq!(short_spread3, 60000); // hitting max spread

        last_oracle_reserve_price_spread_pct = -BID_ASK_SPREAD_PRECISION_I64 / 777;
        last_oracle_conf_pct = 1;
        let (long_spread4, short_spread4) = calculate_spread(
            base_spread,
            last_oracle_reserve_price_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            base_asset_amount_with_amm,
            reserve_price,
            total_fee_minus_distributions,
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
            mark_std,
            oracle_std,
            long_intensity_volume,
            short_intensity_volume,
            volume_24h,
        )
        .unwrap();
        assert!(short_spread4 < long_spread4);
        // (1000000/777 + 1 )* 1.562 * 2 -> 2012 * 2
        assert_eq!(long_spread4, 2012 * 2);
        // base_spread
        assert_eq!(short_spread4, 500);

        // increases to fee pool will decrease long spread (all else equal)
        let (long_spread5, short_spread5) = calculate_spread(
            base_spread,
            last_oracle_reserve_price_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            base_asset_amount_with_amm,
            reserve_price,
            total_fee_minus_distributions * 2,
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
            mark_std,
            oracle_std,
            long_intensity_volume,
            short_intensity_volume,
            volume_24h,
        )
        .unwrap();

        assert!(long_spread5 < long_spread4);
        assert_eq!(short_spread5, short_spread4);

        let amm = AMM {
            base_asset_reserve: 2 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 2 * AMM_RESERVE_PRECISION,
            sqrt_k: 2 * AMM_RESERVE_PRECISION,
            peg_multiplier: PEG_PRECISION,
            long_spread: long_spread5,
            short_spread: short_spread5,
            ..AMM::default()
        };

        let (bar_l, qar_l) = calculate_spread_reserves(&amm, PositionDirection::Long).unwrap();
        let (bar_s, qar_s) = calculate_spread_reserves(&amm, PositionDirection::Short).unwrap();

        assert!(qar_l > amm.quote_asset_reserve);
        assert!(bar_l < amm.base_asset_reserve);
        assert!(qar_s < amm.quote_asset_reserve);
        assert!(bar_s > amm.base_asset_reserve);
        assert_eq!(bar_s, 2000500125);
        assert_eq!(bar_l, 1996705107);
        assert_eq!(qar_l, 2003300330);
        assert_eq!(qar_s, 1999500000);

        let (long_spread_btc, short_spread_btc) = calculate_spread(
            500,
            62099,
            411,
            margin_ratio_initial * 100,
            94280030695,
            94472846843,
            21966868000,
            -193160000,
            21927763871,
            50457675,
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
            mark_std,
            oracle_std,
            long_intensity_volume,
            short_intensity_volume,
            volume_24h,
        )
        .unwrap();

        assert_eq!(long_spread_btc, 411);
        assert_eq!(short_spread_btc, 74584);

        let (long_spread_btc1, short_spread_btc1) = calculate_spread(
            500,
            70719,
            0,
            margin_ratio_initial * 100,
            92113762421,
            92306488219,
            21754071000,
            -193060000,
            21671071573,
            4876326,
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
            mark_std,
            oracle_std,
            long_intensity_volume,
            short_intensity_volume,
            volume_24h,
        )
        .unwrap();

        assert_eq!(long_spread_btc1, 0);
        assert_eq!(short_spread_btc1, 200000); // max spread
    }

    #[test]
    fn calculate_spread_inventory_tests() {
        let base_spread = 1000; // .1%
        let last_oracle_reserve_price_spread_pct = 0;
        let last_oracle_conf_pct = 0;
        let quote_asset_reserve = AMM_RESERVE_PRECISION * 9;
        let mut terminal_quote_asset_reserve = AMM_RESERVE_PRECISION * 10;
        let peg_multiplier = 34000000;
        let mut base_asset_amount_with_amm = -(AMM_RESERVE_PRECISION as i128);
        let reserve_price = 34562304;
        let mut total_fee_minus_distributions = 10000 * QUOTE_PRECISION_I128;

        let base_asset_reserve = AMM_RESERVE_PRECISION * 11;
        let min_base_asset_reserve = AMM_RESERVE_PRECISION * 7;
        let max_base_asset_reserve = AMM_RESERVE_PRECISION * 14;

        let margin_ratio_initial = 2000; // 5x max leverage
        let max_spread = margin_ratio_initial * 100;

        let mark_std = 0;
        let oracle_std = 0;
        let long_intensity_volume = 0;
        let short_intensity_volume = 0;
        let volume_24h = 0;

        let (long_spread1, short_spread1) = calculate_spread(
            base_spread,
            last_oracle_reserve_price_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            base_asset_amount_with_amm,
            reserve_price,
            total_fee_minus_distributions,
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
            mark_std,
            oracle_std,
            long_intensity_volume,
            short_intensity_volume,
            volume_24h,
        )
        .unwrap();

        // inventory scale
        let (max_bids, max_asks) = _calculate_market_open_bids_asks(
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
        )
        .unwrap();
        assert_eq!(max_bids, 4000000000);
        assert_eq!(max_asks, -3000000000);

        let total_liquidity = max_bids.safe_add(max_asks.abs()).unwrap();
        assert_eq!(total_liquidity, 7000000000);
        // inventory scale
        let inventory_scale = base_asset_amount_with_amm
            .safe_mul(BID_ASK_SPREAD_PRECISION_I128 * 5)
            .unwrap()
            .safe_div(total_liquidity)
            .unwrap()
            .unsigned_abs();
        assert_eq!(inventory_scale, 714285);

        assert_eq!(long_spread1, 500);
        assert_eq!(short_spread1, 2166);

        base_asset_amount_with_amm *= 2;
        let (long_spread1, short_spread1) = calculate_spread(
            base_spread,
            last_oracle_reserve_price_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            base_asset_amount_with_amm,
            reserve_price,
            total_fee_minus_distributions,
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
            mark_std,
            oracle_std,
            long_intensity_volume,
            short_intensity_volume,
            volume_24h,
        )
        .unwrap();
        assert_eq!(long_spread1, 500);
        assert_eq!(short_spread1, 3833);

        terminal_quote_asset_reserve = AMM_RESERVE_PRECISION * 11;
        total_fee_minus_distributions = QUOTE_PRECISION_I128 * 5;
        let (long_spread1, short_spread1) = calculate_spread(
            base_spread,
            last_oracle_reserve_price_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            base_asset_amount_with_amm,
            reserve_price * 9 / 10,
            total_fee_minus_distributions,
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
            mark_std,
            oracle_std,
            long_intensity_volume,
            short_intensity_volume,
            volume_24h,
        )
        .unwrap();
        assert_eq!(long_spread1, 500);
        assert_eq!(short_spread1, 8269);

        total_fee_minus_distributions = QUOTE_PRECISION_I128;
        let (long_spread1, short_spread1) = calculate_spread(
            base_spread,
            last_oracle_reserve_price_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            base_asset_amount_with_amm,
            reserve_price * 9 / 10,
            total_fee_minus_distributions,
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
            mark_std,
            oracle_std,
            long_intensity_volume,
            short_intensity_volume,
            volume_24h,
        )
        .unwrap();
        assert_eq!(long_spread1, 500);
        assert_eq!(short_spread1, 26017); // 1214 * 5

        // flip sign
        let (long_spread1, short_spread1) = calculate_spread(
            base_spread,
            last_oracle_reserve_price_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            -base_asset_amount_with_amm,
            reserve_price * 9 / 10,
            total_fee_minus_distributions,
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
            mark_std,
            oracle_std,
            long_intensity_volume,
            short_intensity_volume,
            volume_24h,
        )
        .unwrap();
        assert_eq!(long_spread1, 38330);
        assert_eq!(short_spread1, 500);

        let (long_spread1, short_spread1) = calculate_spread(
            base_spread,
            last_oracle_reserve_price_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            -base_asset_amount_with_amm * 5,
            reserve_price * 9 / 10,
            total_fee_minus_distributions,
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
            mark_std,
            oracle_std,
            long_intensity_volume,
            short_intensity_volume,
            volume_24h,
        )
        .unwrap();
        assert_eq!(long_spread1, 50000);
        assert_eq!(short_spread1, 500);

        let (long_spread1, short_spread1) = calculate_spread(
            base_spread,
            last_oracle_reserve_price_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            -base_asset_amount_with_amm,
            reserve_price * 9 / 10,
            total_fee_minus_distributions,
            base_asset_reserve,
            min_base_asset_reserve / 2,
            max_base_asset_reserve * 2,
            mark_std,
            oracle_std,
            long_intensity_volume,
            short_intensity_volume,
            volume_24h,
        )
        .unwrap();
        assert_eq!(long_spread1, 18330);
        assert_eq!(short_spread1, 500);
    }

    #[test]
    fn calculate_vol_spread_tests() {
        let base_spread = 250; // .025%
        let last_oracle_reserve_price_spread_pct = 0;
        let last_oracle_conf_pct = 0;
        let quote_asset_reserve = AMM_RESERVE_PRECISION * 10;
        let terminal_quote_asset_reserve = AMM_RESERVE_PRECISION * 10;
        let peg_multiplier = 34000000;
        let base_asset_amount_with_amm = 0;
        let reserve_price = 34562304;
        let total_fee_minus_distributions = 0;

        let base_asset_reserve = AMM_RESERVE_PRECISION * 10;
        let min_base_asset_reserve = 0_u128;
        let max_base_asset_reserve = AMM_RESERVE_PRECISION * 100000;

        let margin_ratio_initial = 2000; // 5x max leverage
        let max_spread = margin_ratio_initial * 100;

        let mark_std = 34000000 / 50;
        let oracle_std = 34000000 / 150;
        let long_intensity_volume = (QUOTE_PRECISION * 10000) as u64;
        let short_intensity_volume = (QUOTE_PRECISION * 30000) as u64;
        let volume_24h = (QUOTE_PRECISION * 40000) as u64;

        // at 0 fee be max spread
        let (long_spread1, short_spread) = calculate_spread(
            base_spread,
            last_oracle_reserve_price_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            base_asset_amount_with_amm,
            reserve_price,
            total_fee_minus_distributions,
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
            mark_std,
            oracle_std,
            long_intensity_volume,
            short_intensity_volume,
            volume_24h,
        )
        .unwrap();
        assert_eq!(long_spread1, 16390);
        assert_eq!(short_spread, 49180);
    }
}
