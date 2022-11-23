#[cfg(test)]
mod test {
    use crate::math::amm_spread::*;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BASE_PRECISION_I128, BID_ASK_SPREAD_PRECISION,
        BID_ASK_SPREAD_PRECISION_I64, QUOTE_PRECISION, QUOTE_PRECISION_I128,
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
        assert_eq!(l, 63);
        assert_eq!(s, 1000 - 63);

        let (l, s) = cap_to_max_spread(2500 - 10, 11, 2500).unwrap();
        assert_eq!(l, 2490);
        assert_eq!(s, 10);

        let (l, s) = cap_to_max_spread(2510, 110, 2500).unwrap();
        assert_eq!(l, 2396);
        assert_eq!(s, 104);
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
        let net_revenue_since_last_funding = 0;

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
            net_revenue_since_last_funding,
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
            net_revenue_since_last_funding,
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
            net_revenue_since_last_funding,
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
            net_revenue_since_last_funding,
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
            net_revenue_since_last_funding,
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
            net_revenue_since_last_funding,
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
            net_revenue_since_last_funding,
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

        assert_eq!(long_spread_btc1, 211);
        assert_eq!(short_spread_btc1, 200000 - 211); // max spread
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
        let net_revenue_since_last_funding = 0;

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
            net_revenue_since_last_funding,
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
            net_revenue_since_last_funding,
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
        assert_eq!(short_spread1, 5000 + 2166);

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
            net_revenue_since_last_funding,
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
        assert_eq!(short_spread1, 10787 + 4674);

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
            net_revenue_since_last_funding,
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
        assert_eq!(short_spread1, 48641); // 1214 * 40.06

        // flip sign
        let (d1, _) = calculate_long_short_vol_spread(
            last_oracle_conf_pct, // 0
            reserve_price,
            mark_std,               // 0
            oracle_std,             // 0
            long_intensity_volume,  // 0
            short_intensity_volume, // 0
            volume_24h,             // 0
        )
        .unwrap();
        assert_eq!(d1, 0); // no volatility measured at all from input data -_-

        let iscale = calculate_spread_inventory_scale(
            -base_asset_amount_with_amm,
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
            d1,
            max_spread as u64,
        )
        .unwrap();
        assert_eq!(iscale, 14333333); //14.3x

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
            net_revenue_since_last_funding,
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
        assert_eq!(long_spread1, 71660);
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
            net_revenue_since_last_funding,
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
        assert_eq!(long_spread1, 199901);
        assert_eq!(short_spread1, 99); // max on long

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
            net_revenue_since_last_funding,
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
        assert_eq!(long_spread1, 31660);
        assert_eq!(short_spread1, 500);
    }

    #[test]
    fn calculate_spread_inventory_scale_tests() {
        // from mainnet 2022/11/22

        let d1 = 250;
        let max_spread = 300000;
        let iscale = calculate_spread_inventory_scale(
            941291801615,
            443370320987941,
            435296619793629,
            453513306290427,
            d1,
            max_spread,
        )
        .unwrap();
        assert_eq!(iscale / BID_ASK_SPREAD_PRECISION, 600);
        assert_eq!(250 * iscale / BID_ASK_SPREAD_PRECISION, 300000 / 2);
    }

    #[test]
    fn calculate_spread_scales_tests() {
        let lscale = calculate_spread_leverage_scale(
            AMM_RESERVE_PRECISION,
            AMM_RESERVE_PRECISION,
            12 * PEG_PRECISION,
            BASE_PRECISION_I128,
            (12.5 * PRICE_PRECISION as f64) as u64,
            QUOTE_PRECISION_I128,
        )
        .unwrap();
        assert_eq!(lscale, 10000000); // 10x (max)

        // more total fee minus dist => lower leverage
        let lscale = calculate_spread_leverage_scale(
            AMM_RESERVE_PRECISION,
            AMM_RESERVE_PRECISION,
            12 * PEG_PRECISION,
            BASE_PRECISION_I128,
            (12.5 * PRICE_PRECISION as f64) as u64,
            QUOTE_PRECISION_I128 * 100,
        )
        .unwrap();
        assert_eq!(lscale, 1125000); // 1.125x

        // less base => lower leverage
        let lscale = calculate_spread_leverage_scale(
            AMM_RESERVE_PRECISION,
            AMM_RESERVE_PRECISION,
            12 * PEG_PRECISION,
            BASE_PRECISION_I128 / 100,
            (12.5 * PRICE_PRECISION as f64) as u64,
            QUOTE_PRECISION_I128,
        )
        .unwrap();
        assert_eq!(lscale, 1125000); // 1.125x (inc)

        // user long => bar < sqrt_k < qar => tqar < qar => peg < reserve_price
        let lscale = calculate_spread_leverage_scale(
            AMM_RESERVE_PRECISION * 1000,
            (AMM_RESERVE_PRECISION * 9999 / 10000) as u128,
            12 * PEG_PRECISION,
            BASE_PRECISION_I128,
            (12.1 * PRICE_PRECISION as f64) as u64,
            QUOTE_PRECISION_I128,
        )
        .unwrap();
        assert_eq!(lscale, 1000001); // 1.000001x (min)

        // from mainnet 2022/11/22
        let lscale = calculate_spread_leverage_scale(
            455362349720024,
            454386986330347,
            11760127,
            968409950546,
            11869992,
            7978239165,
        )
        .unwrap();
        assert_eq!(lscale, 1003087); // 1.003087x
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
        let net_revenue_since_last_funding = 0;

        let base_asset_reserve = AMM_RESERVE_PRECISION * 10;
        let min_base_asset_reserve = 0_u128;
        let max_base_asset_reserve = AMM_RESERVE_PRECISION * 100000;

        let margin_ratio_initial = 2000; // 5x max leverage
        let max_spread = margin_ratio_initial * 100; //20%

        let mark_std = 34000000 / 50; // 2% of price
        let oracle_std = 34000000 / 150; // .66% of price
        let long_intensity_volume = (QUOTE_PRECISION * 10000) as u64; //10k
        let short_intensity_volume = (QUOTE_PRECISION * 30000) as u64; //30k
        let volume_24h = (QUOTE_PRECISION * 40000) as u64; // 40k

        let (long_vspread, short_vspread) = calculate_long_short_vol_spread(
            last_oracle_conf_pct,
            reserve_price,
            mark_std,
            oracle_std,
            long_intensity_volume,
            short_intensity_volume,
            volume_24h,
        )
        .unwrap();
        assert_eq!(long_vspread, 1639);
        assert_eq!(short_vspread, 4918);

        // since short volume ~= 3 * long volume intensity, expect short spread to be larger by this factor
        assert_eq!(short_vspread >= long_vspread * 3, true);

        // inventory scale
        let (max_bids, max_asks) = _calculate_market_open_bids_asks(
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
        )
        .unwrap();
        assert_eq!(max_bids, 10000000000);
        assert_eq!(max_asks, -99990000000000);

        let min_side_liquidity = max_bids.min(max_asks.abs());
        assert_eq!(min_side_liquidity, 10000000000);

        // inventory scale
        let inventory_scale = base_asset_amount_with_amm
            .safe_mul(DEFAULT_LARGE_BID_ASK_FACTOR.cast::<i128>().unwrap())
            .unwrap()
            .safe_div(min_side_liquidity.max(1))
            .unwrap()
            .unsigned_abs();

        assert_eq!(inventory_scale, 0);

        let inventory_scale_capped = min(
            MAX_BID_ASK_INVENTORY_SKEW_FACTOR,
            BID_ASK_SPREAD_PRECISION
                .safe_add(inventory_scale.cast().unwrap())
                .unwrap(),
        );
        assert_eq!(inventory_scale_capped, BID_ASK_SPREAD_PRECISION);

        let (long_spread, short_spread) = calculate_spread(
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
            net_revenue_since_last_funding,
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

        // since total_fee_minus_distributions <=0, 10 * vol spread
        assert_eq!(long_spread, 16390); // vs 2500
        assert_eq!(
            long_spread
                > (base_spread
                    * ((DEFAULT_LARGE_BID_ASK_FACTOR / BID_ASK_SPREAD_PRECISION) as u32)),
            true
        );

        assert_eq!(short_spread, 49180);
        assert_eq!(
            short_spread
                > (base_spread
                    * ((DEFAULT_LARGE_BID_ASK_FACTOR / BID_ASK_SPREAD_PRECISION) as u32)),
            true
        );

        let (long_spread, short_spread) = calculate_spread(
            base_spread,
            last_oracle_reserve_price_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            base_asset_amount_with_amm,
            reserve_price,
            total_fee_minus_distributions + 1000,
            net_revenue_since_last_funding,
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

        assert_eq!(long_spread, 1639);
        assert_eq!(short_spread, 4918);

        let (long_spread, short_spread) = calculate_spread(
            base_spread,
            last_oracle_reserve_price_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            base_asset_amount_with_amm + BASE_PRECISION_I128,
            reserve_price,
            total_fee_minus_distributions + 1000,
            net_revenue_since_last_funding,
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
        assert_eq!(long_spread, 1639 * 20); // inventory scale = 1e6 (=>2x), effective_leverage = 10 (10x, max) when terminal=quote reserves and amm long
        assert_eq!(short_spread, 4918);

        let (long_spread, short_spread) = calculate_spread(
            base_spread,
            last_oracle_reserve_price_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            base_asset_amount_with_amm - BASE_PRECISION_I128,
            reserve_price,
            total_fee_minus_distributions + 1000,
            net_revenue_since_last_funding,
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
        assert_eq!(long_spread, 1639);
        assert_eq!(short_spread, 4918 * 2); // inventory scale = 1e6, effective_leverage = 0 when terminal=quote reserves and amm short
    }

    #[test]
    fn calculate_vol_oracle_reserve_price_spread_pct_tests() {
        let base_spread = 250; // .025%
        let last_oracle_reserve_price_spread_pct = 5000; //.5%
        let last_oracle_conf_pct = 250; // .025%
        let quote_asset_reserve = AMM_RESERVE_PRECISION * 10;
        let terminal_quote_asset_reserve = AMM_RESERVE_PRECISION * 9;
        let peg_multiplier = 34000000;
        let base_asset_amount_with_amm = 0;
        let reserve_price = 34562304;
        let total_fee_minus_distributions = 0;
        let net_revenue_since_last_funding = 0;

        let base_asset_reserve = AMM_RESERVE_PRECISION * 10;
        let min_base_asset_reserve = AMM_RESERVE_PRECISION * 7;
        let max_base_asset_reserve = AMM_RESERVE_PRECISION * 13;

        let margin_ratio_initial = 2000; // 5x max leverage
        let max_spread = margin_ratio_initial * 100; //20%

        let mark_std = 34000000 / 50; // 2% of price
        let oracle_std = 34000000 / 150; // .66% of price
        let long_intensity_volume = (QUOTE_PRECISION * 10000) as u64; //10k
        let short_intensity_volume = (QUOTE_PRECISION * 30000) as u64; //30k
        let volume_24h = (QUOTE_PRECISION * 40000) as u64; // 40k

        let (long_vspread, short_vspread) = calculate_long_short_vol_spread(
            last_oracle_conf_pct,
            reserve_price,
            mark_std,
            oracle_std,
            long_intensity_volume,
            short_intensity_volume,
            volume_24h,
        )
        .unwrap();
        assert_eq!(long_vspread, 1639);
        assert_eq!(short_vspread, 4918);

        // since short volume ~= 3 * long volume intensity, expect short spread to be larger by this factor
        assert_eq!(short_vspread >= long_vspread * 3, true);

        // inventory scale
        let (max_bids, max_asks) = _calculate_market_open_bids_asks(
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
        )
        .unwrap();
        assert_eq!(max_bids, 3000000000);
        assert_eq!(max_asks, -3000000000);

        let min_side_liquidity = max_bids.min(max_asks.abs());
        assert_eq!(min_side_liquidity, 3000000000);

        // inventory scale
        let inventory_scale = base_asset_amount_with_amm
            .safe_mul(DEFAULT_LARGE_BID_ASK_FACTOR.cast::<i128>().unwrap())
            .unwrap()
            .safe_div(min_side_liquidity.max(1))
            .unwrap()
            .unsigned_abs();

        assert_eq!(inventory_scale, 0);

        let inventory_scale_capped = min(
            MAX_BID_ASK_INVENTORY_SKEW_FACTOR,
            BID_ASK_SPREAD_PRECISION
                .safe_add(inventory_scale.cast().unwrap())
                .unwrap(),
        );
        assert_eq!(inventory_scale_capped, BID_ASK_SPREAD_PRECISION);

        let (long_spread, short_spread) = calculate_spread(
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
            net_revenue_since_last_funding,
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

        // since total_fee_minus_distributions <=0, 10 * vol spread
        assert_eq!(long_spread, 16390); // vs 2500
        assert_eq!(
            long_spread
                > (base_spread
                    * ((DEFAULT_LARGE_BID_ASK_FACTOR / BID_ASK_SPREAD_PRECISION) as u32)),
            true
        );

        assert_eq!(short_spread, 99180);
        assert_eq!(
            short_spread
                > (base_spread
                    * ((DEFAULT_LARGE_BID_ASK_FACTOR / BID_ASK_SPREAD_PRECISION) as u32)),
            true
        );

        let (long_spread, short_spread) = calculate_spread(
            base_spread,
            last_oracle_reserve_price_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            base_asset_amount_with_amm,
            reserve_price,
            total_fee_minus_distributions + 1000,
            net_revenue_since_last_funding,
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

        assert_eq!(long_spread, 1639);
        assert_eq!(short_spread, 9918);

        let (long_spread, short_spread) = calculate_spread(
            base_spread,
            last_oracle_reserve_price_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            base_asset_amount_with_amm + BASE_PRECISION_I128,
            reserve_price,
            total_fee_minus_distributions + 1000,
            net_revenue_since_last_funding,
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
        assert_eq!(long_spread, 71020); // big cause of oracel pct
        assert_eq!(short_spread, 9918);

        let (long_spread, short_spread) = calculate_spread(
            base_spread,
            last_oracle_reserve_price_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            base_asset_amount_with_amm - BASE_PRECISION_I128,
            reserve_price,
            total_fee_minus_distributions + 1000,
            net_revenue_since_last_funding,
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
        assert_eq!(long_spread, 1639);
        assert_eq!(short_spread, 42977); // big
    }
}
