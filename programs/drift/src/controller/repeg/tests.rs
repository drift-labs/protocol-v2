use crate::controller::repeg::*;
use crate::math::constants::{
    AMM_RESERVE_PRECISION, PEG_PRECISION, PRICE_PRECISION, PRICE_PRECISION_I64,
    PRICE_PRECISION_U64, QUOTE_PRECISION,
};
use crate::math::oracle::OracleValidity;
use crate::math::repeg::{
    calculate_fee_pool, calculate_peg_from_target_price, calculate_repeg_cost,
};
use crate::state::oracle::HistoricalOracleData;
use crate::state::perp_market::{ContractTier, AMM};
use crate::state::state::{PriceDivergenceGuardRails, ValidityGuardRails};

#[test]
pub fn update_amm_test() {
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 65 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 63015384615,
            terminal_quote_asset_reserve: 64 * AMM_RESERVE_PRECISION,
            sqrt_k: 64 * AMM_RESERVE_PRECISION,
            peg_multiplier: 19_400 * PEG_PRECISION,
            base_asset_amount_with_amm: -(AMM_RESERVE_PRECISION as i128),
            mark_std: PRICE_PRECISION as u64,
            last_mark_price_twap_ts: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: 19_400 * PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            base_spread: 250,
            curve_update_intensity: 100,
            max_spread: 55500,
            ..AMM::default()
        },
        status: MarketStatus::Initialized,
        contract_tier: ContractTier::B,
        margin_ratio_initial: 555, // max 1/.0555 = 18.018018018x leverage
        ..PerpMarket::default()
    };

    let state = State {
        oracle_guard_rails: OracleGuardRails {
            price_divergence: PriceDivergenceGuardRails {
                mark_oracle_divergence_numerator: 1,
                mark_oracle_divergence_denominator: 10,
            },
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            use_for_liquidations: true,
            padding: [0; 7],
        },
        ..State::default()
    };

    let now = 10000;
    let slot = 81680085;
    let oracle_price_data = OraclePriceData {
        price: (12_400 * PRICE_PRECISION) as i64,
        confidence: 0,
        delay: 2,
        has_sufficient_number_of_data_points: true,
    };

    let reserve_price_before = market.amm.reserve_price().unwrap();
    assert_eq!(reserve_price_before, 18807668638);

    market
        .amm
        .historical_oracle_data
        .last_oracle_price_twap_5min = 18907668639;
    market.amm.historical_oracle_data.last_oracle_price_twap_ts = now - (167 + 6);
    let oracle_reserve_price_spread_pct_before =
        amm::calculate_oracle_twap_5min_mark_spread_pct(&market.amm, Some(reserve_price_before))
            .unwrap();
    assert_eq!(oracle_reserve_price_spread_pct_before, -5316);
    let too_diverge = amm::is_oracle_mark_too_divergent(
        oracle_reserve_price_spread_pct_before,
        &state.oracle_guard_rails.price_divergence,
    )
    .unwrap();
    assert!(!too_diverge);

    let cost_of_update = _update_amm(&mut market, &oracle_price_data, &state, now, slot).unwrap();

    let is_oracle_valid = oracle::oracle_validity(
        market.amm.historical_oracle_data.last_oracle_price_twap,
        &oracle_price_data,
        &state.oracle_guard_rails.validity,
    )
    .unwrap()
        == OracleValidity::Valid;

    let reserve_price_after_prepeg = market.amm.reserve_price().unwrap();
    assert_eq!(reserve_price_after_prepeg, 13088199999);
    assert_eq!(
        market.amm.historical_oracle_data.last_oracle_price,
        12400000000
    );
    assert_eq!(market.amm.last_oracle_normalised_price, 15520000000);
    assert_eq!(
        market.amm.historical_oracle_data.last_oracle_price_twap,
        15520000000
    );
    assert_eq!(
        market
            .amm
            .historical_oracle_data
            .last_oracle_price_twap_5min,
        16954113056
    ); // since manually set higher above

    let oracle_reserve_price_spread_pct_before = amm::calculate_oracle_twap_5min_mark_spread_pct(
        &market.amm,
        Some(reserve_price_after_prepeg),
    )
    .unwrap();
    assert_eq!(oracle_reserve_price_spread_pct_before, -295373);
    let too_diverge = amm::is_oracle_mark_too_divergent(
        oracle_reserve_price_spread_pct_before,
        &state.oracle_guard_rails.price_divergence,
    )
    .unwrap();
    assert!(too_diverge);

    let profit = market.amm.total_fee_minus_distributions;
    let peg = market.amm.peg_multiplier;
    assert_eq!(-cost_of_update, profit);
    assert!(is_oracle_valid);
    assert!(profit < 0);
    assert_eq!(profit, -5808835339);
    assert_eq!(peg, 13500401611);

    let reserve_price = market.amm.reserve_price().unwrap();
    let (bid, ask) = market.amm.bid_ask_price(reserve_price).unwrap();
    assert!(bid < reserve_price);
    assert!(bid < ask);
    assert!(reserve_price <= ask);
    assert_eq!(
        market.amm.long_spread + market.amm.short_spread,
        (market.margin_ratio_initial * 100) as u32
    );

    assert_eq!(bid, 12361804899);
    assert!(bid < (oracle_price_data.price as u64));

    assert_eq!(ask, 13088199999);
    assert_eq!(reserve_price, 13088199999);
    //(133487208381380-120146825282679)/133403830987014 == .1 (max spread)
    // 127060953641838
}

#[test]
pub fn update_amm_test_bad_oracle() {
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 65 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 630153846154000,
            terminal_quote_asset_reserve: 64 * AMM_RESERVE_PRECISION,
            sqrt_k: 64 * AMM_RESERVE_PRECISION,
            peg_multiplier: 19_400_000,
            base_asset_amount_with_amm: -(AMM_RESERVE_PRECISION as i128),
            mark_std: PRICE_PRECISION as u64,
            last_mark_price_twap_ts: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: 19_400 * PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            base_spread: 250,
            curve_update_intensity: 100,
            max_spread: 55500,
            ..AMM::default()
        },
        margin_ratio_initial: 555, // max 1/.0555 = 18.018018018x leverage
        ..PerpMarket::default()
    };

    let state = State {
        oracle_guard_rails: OracleGuardRails {
            price_divergence: PriceDivergenceGuardRails {
                mark_oracle_divergence_numerator: 1,
                mark_oracle_divergence_denominator: 10,
            },
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,      // 5s
                slots_before_stale_for_margin: 120,  // 60s
                confidence_interval_max_size: 20000, //2%
                too_volatile_ratio: 5,
            },
            use_for_liquidations: true,
            padding: [0; 7],
        },
        ..State::default()
    };

    let now = 10000;
    let slot = 81680085;
    let oracle_price_data = OraclePriceData {
        price: (12_400 * PRICE_PRECISION) as i64,
        confidence: 0,
        delay: 12,
        has_sufficient_number_of_data_points: true,
    };

    let _cost_of_update = _update_amm(&mut market, &oracle_price_data, &state, now, slot).unwrap();
    assert!(market.amm.last_update_slot == 0);

    let is_oracle_valid = oracle::oracle_validity(
        market.amm.historical_oracle_data.last_oracle_price_twap,
        &oracle_price_data,
        &state.oracle_guard_rails.validity,
    )
    .unwrap()
        == OracleValidity::Valid;
    assert!(!is_oracle_valid);
}

#[test]
pub fn update_amm_larg_conf_test() {
    let now = 1662800000 + 60;
    let slot = 81680085;

    let mut market = PerpMarket::default_btc_test();
    assert_eq!(market.amm.base_asset_amount_with_amm, -1000000000);

    let state = State {
        oracle_guard_rails: OracleGuardRails {
            price_divergence: PriceDivergenceGuardRails {
                mark_oracle_divergence_numerator: 1,
                mark_oracle_divergence_denominator: 10,
            },
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,      // 5s
                slots_before_stale_for_margin: 120,  // 60s
                confidence_interval_max_size: 20000, //2%
                too_volatile_ratio: 5,
            },
            use_for_liquidations: true,
            padding: [0; 7],
        },
        ..State::default()
    };

    let reserve_price_before = market.amm.reserve_price().unwrap();
    assert_eq!(reserve_price_before, 18807668638);

    let oracle_price_data = OraclePriceData {
        price: (18_850 * PRICE_PRECISION) as i64,
        confidence: 0,
        delay: 9,
        has_sufficient_number_of_data_points: true,
    };
    assert_eq!(market.amm.long_spread, 0);
    assert_eq!(market.amm.short_spread, 0);

    let cost_of_update = _update_amm(&mut market, &oracle_price_data, &state, now, slot).unwrap();
    assert_eq!(cost_of_update, -42992787); // amm wins when price increases

    assert_eq!(market.amm.long_spread, 0);
    assert_eq!(market.amm.short_spread, 975);

    let reserve_price_after = market.amm.reserve_price().unwrap();
    assert_eq!(reserve_price_after, 18849999999);
    assert_eq!(reserve_price_before < reserve_price_after, true);

    // add large confidence
    let oracle_price_data = OraclePriceData {
        price: (18_850 * PRICE_PRECISION) as i64,
        confidence: 100 * PRICE_PRECISION_U64,
        delay: 1,
        has_sufficient_number_of_data_points: true,
    };

    let cost_of_update = _update_amm(&mut market, &oracle_price_data, &state, now, slot).unwrap();
    assert_eq!(cost_of_update, 0);

    let mrk = market.amm.reserve_price().unwrap();
    let (bid, ask) = market.amm.bid_ask_price(mrk).unwrap();

    assert_eq!(bid, 18831621249);
    assert_eq!(mrk, 18849999999);
    assert_eq!(ask, 18849999999);

    assert_eq!(market.amm.long_spread, 0);
    assert_eq!(market.amm.short_spread, 975);

    // add move lower
    let oracle_price_data = OraclePriceData {
        price: (18_820 * PRICE_PRECISION) as i64,
        confidence: 100 * PRICE_PRECISION_U64,
        delay: 1,
        has_sufficient_number_of_data_points: true,
    };

    let fee_budget = calculate_fee_pool(&market).unwrap();
    assert_eq!(market.amm.total_fee_minus_distributions, 42992787);
    assert_eq!(fee_budget, 42992787);

    let optimal_peg = calculate_peg_from_target_price(
        market.amm.quote_asset_reserve,
        market.amm.base_asset_reserve,
        oracle_price_data.price as u64,
    )
    .unwrap();
    assert_eq!(market.amm.peg_multiplier, 19443664550);
    assert_eq!(optimal_peg, 19412719726);

    let optimal_peg_cost = calculate_repeg_cost(&market.amm, optimal_peg).unwrap();
    assert_eq!(optimal_peg_cost, 30468749);

    let cost_of_update = _update_amm(&mut market, &oracle_price_data, &state, now, slot).unwrap();
    assert_eq!(cost_of_update, 30468749);
    assert_eq!(market.amm.long_spread, 0);
    assert_eq!(market.amm.short_spread, 975);

    let mrk = market.amm.reserve_price().unwrap();
    let (bid, ask) = market.amm.bid_ask_price(mrk).unwrap();

    assert_eq!(bid, 18801650499);
    assert_eq!(mrk, 18819999999);
    assert_eq!(ask, 18819999999);

    // add move lower
    let oracle_price_data = OraclePriceData {
        price: (18_823 * PRICE_PRECISION) as i64,
        confidence: 121 * PRICE_PRECISION_U64,
        delay: 1,
        has_sufficient_number_of_data_points: true,
    };

    let cost_of_update = _update_amm(&mut market, &oracle_price_data, &state, now, slot).unwrap();
    assert_eq!(cost_of_update, -3046875);
    assert_eq!(market.amm.long_spread, 0);
    assert_eq!(market.amm.short_spread, 975);

    let mrk = market.amm.reserve_price().unwrap();
    let (bid, ask) = market.amm.bid_ask_price(mrk).unwrap();

    assert_eq!(bid, 18804647574);
    assert_eq!(mrk, 18822999999);
    assert_eq!(ask, 18822999999);
}

#[test]
pub fn update_amm_larg_conf_w_neg_tfmd_test() {
    let now = 1662800000 + 60;
    let slot = 81680085;

    let mut market = PerpMarket::default_btc_test();
    market.amm.total_fee_minus_distributions = -(10000 * QUOTE_PRECISION as i128);
    assert_eq!(market.amm.base_asset_amount_with_amm, -1000000000);

    let state = State {
        oracle_guard_rails: OracleGuardRails {
            price_divergence: PriceDivergenceGuardRails {
                mark_oracle_divergence_numerator: 1,
                mark_oracle_divergence_denominator: 10,
            },
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,      // 5s
                slots_before_stale_for_margin: 120,  // 60s
                confidence_interval_max_size: 20000, //2%
                too_volatile_ratio: 5,
            },
            use_for_liquidations: true,
            padding: [0; 7],
        },
        ..State::default()
    };

    let reserve_price_before = market.amm.reserve_price().unwrap();
    assert_eq!(reserve_price_before, 18807668638);

    let oracle_price_data = OraclePriceData {
        price: (18_850 * PRICE_PRECISION) as i64,
        confidence: 0,
        delay: 9,
        has_sufficient_number_of_data_points: true,
    };
    assert_eq!(market.amm.long_spread, 0);
    assert_eq!(market.amm.short_spread, 0);

    let cost_of_update = _update_amm(&mut market, &oracle_price_data, &state, now, slot).unwrap();
    assert_eq!(cost_of_update, -42992787); // amm wins when price increases
    assert_eq!(market.amm.long_spread, 0);
    assert_eq!(market.amm.short_spread, 975);

    let reserve_price_after = market.amm.reserve_price().unwrap();
    assert_eq!(reserve_price_after, 18849999999);
    assert_eq!(reserve_price_before < reserve_price_after, true);

    // add large confidence
    let oracle_price_data = OraclePriceData {
        price: (18_850 * PRICE_PRECISION) as i64,
        confidence: 100 * PRICE_PRECISION_U64,
        delay: 1,
        has_sufficient_number_of_data_points: true,
    };

    let cost_of_update = _update_amm(&mut market, &oracle_price_data, &state, now, slot).unwrap();
    assert_eq!(cost_of_update, 0);

    let mrk = market.amm.reserve_price().unwrap();
    let (bid, ask) = market.amm.bid_ask_price(mrk).unwrap();

    assert_eq!(bid, 18831621249);
    assert_eq!(mrk, 18849999999);
    assert_eq!(ask, 18849999999);

    assert_eq!(market.amm.long_spread, 0);
    assert_eq!(market.amm.short_spread, 975);

    // add move lower
    let oracle_price_data = OraclePriceData {
        price: (18_820 * PRICE_PRECISION) as i64,
        confidence: 100 * PRICE_PRECISION_U64,
        delay: 1,
        has_sufficient_number_of_data_points: true,
    };

    let fee_budget = calculate_fee_pool(&market).unwrap();
    assert_eq!(market.amm.total_fee_minus_distributions, -9957007213);
    assert_eq!(fee_budget, 0);

    let optimal_peg = calculate_peg_from_target_price(
        market.amm.quote_asset_reserve,
        market.amm.base_asset_reserve,
        oracle_price_data.price as u64,
    )
    .unwrap();
    assert_eq!(market.amm.peg_multiplier, 19443664550);
    assert_eq!(optimal_peg, 19412719726);

    let optimal_peg_cost = calculate_repeg_cost(&market.amm, optimal_peg).unwrap();
    assert_eq!(optimal_peg_cost, 30468749);

    let cost_of_update = _update_amm(&mut market, &oracle_price_data, &state, now, slot).unwrap();
    assert_eq!(cost_of_update, 11832538);
    assert_eq!(market.amm.long_spread, 0);
    assert_eq!(market.amm.short_spread, 975);

    let mrk = market.amm.reserve_price().unwrap();
    let (bid, ask) = market.amm.bid_ask_price(mrk).unwrap();

    assert_eq!(bid, 18819982108);
    assert_eq!(mrk, 18838349499);
    assert_eq!(ask, 18838349499);

    // add move lower
    let oracle_price_data = OraclePriceData {
        price: (18_823 * PRICE_PRECISION) as i64,
        confidence: 121 * PRICE_PRECISION_U64,
        delay: 1,
        has_sufficient_number_of_data_points: true,
    };

    let cost_of_update = _update_amm(&mut market, &oracle_price_data, &state, now, slot).unwrap();
    assert_eq!(cost_of_update, 0);
    assert_eq!(market.amm.long_spread, 0);
    assert_eq!(market.amm.short_spread, 975);

    let mrk = market.amm.reserve_price().unwrap();
    let (bid, ask) = market.amm.bid_ask_price(mrk).unwrap();

    assert_eq!(bid, 18819982108);
    assert_eq!(mrk, 18838349499);
    assert_eq!(ask, 18838349499);
}
