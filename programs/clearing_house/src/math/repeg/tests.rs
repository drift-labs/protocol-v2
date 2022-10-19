use crate::controller::amm::SwapDirection;
use crate::math::constants::{
    AMM_RESERVE_PRECISION, MAX_CONCENTRATION_COEFFICIENT, PRICE_PRECISION, QUOTE_PRECISION,
};
use crate::math::repeg::*;

#[test]
fn calc_peg_tests() {
    let qar = AMM_RESERVE_PRECISION;
    let bar = AMM_RESERVE_PRECISION;
    let px = 19401125456; // 19401.125

    let mut new_peg = calculate_peg_from_target_price(qar, bar, px).unwrap();
    assert_eq!(new_peg, 19401125456);
    new_peg = calculate_peg_from_target_price(qar - 10000, bar + 10000, px).unwrap();
    assert_eq!(new_peg, 19401513482);
    new_peg = calculate_peg_from_target_price(qar + 10000, bar - 10000, px).unwrap();
    assert_eq!(new_peg, 19400737437);
    new_peg = calculate_peg_from_target_price(qar / 2, bar * 2, px).unwrap();
    assert_eq!(new_peg, 77604501824);

    let px2 = PRICE_PRECISION + (PRICE_PRECISION / 10000) * 5;
    new_peg = calculate_peg_from_target_price(qar, bar, px2).unwrap();
    assert_eq!(new_peg, 1000500);
    new_peg = calculate_peg_from_target_price(qar, bar, px2 - 1).unwrap();
    assert_eq!(new_peg, 1000499);
}

#[test]
fn calculate_optimal_peg_and_budget_test() {
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 65 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 63015384615,
            terminal_quote_asset_reserve: 64 * AMM_RESERVE_PRECISION,
            sqrt_k: 64 * AMM_RESERVE_PRECISION,
            peg_multiplier: 19_400_000_000,
            base_asset_amount_with_amm: -(AMM_RESERVE_PRECISION as i128),
            mark_std: PRICE_PRECISION as u64,
            last_mark_price_twap_ts: 0,
            base_spread: 250,
            curve_update_intensity: 100,
            max_spread: 500 * 100,
            total_exchange_fee: QUOTE_PRECISION,
            total_fee_minus_distributions: (40 * QUOTE_PRECISION) as i128,
            ..AMM::default()
        },
        margin_ratio_initial: 500,

        ..PerpMarket::default()
    };

    let reserve_price = market.amm.reserve_price().unwrap();
    assert_eq!(reserve_price, 18807668638); //$ 18,807.6686390578

    // positive target_price_gap exceeding max_spread
    let oracle_price_data = OraclePriceData {
        price: (12_400 * PRICE_PRECISION) as i128,
        confidence: 0,
        delay: 2,
        has_sufficient_number_of_data_points: true,
    };

    let (optimal_peg, budget, check_lb) =
        calculate_optimal_peg_and_budget(&market, &oracle_price_data).unwrap();

    assert_eq!(optimal_peg, 13430053711);
    assert_eq!(budget, 5878100963);
    assert!(!check_lb);

    // positive target_price_gap within max_spread
    let oracle_price_data = OraclePriceData {
        price: (18_901 * PRICE_PRECISION) as i128,
        confidence: 167,
        delay: 21,
        has_sufficient_number_of_data_points: true,
    };
    let (optimal_peg, budget, check_lb) =
        calculate_optimal_peg_and_budget(&market, &oracle_price_data).unwrap();

    assert_eq!(optimal_peg, 19496270752);
    assert_eq!(budget, 39500000);
    assert!(check_lb);

    // positive target_price_gap 2 within max_spread?
    let oracle_price_data = OraclePriceData {
        price: (18_601 * PRICE_PRECISION) as i128,
        confidence: 167,
        delay: 21,
        has_sufficient_number_of_data_points: true,
    };
    let (optimal_peg, budget, check_lb) =
        calculate_optimal_peg_and_budget(&market, &oracle_price_data).unwrap();

    assert_eq!(optimal_peg, 19186822509);
    assert_eq!(budget, 39500000);
    assert!(check_lb);

    // negative target_price_gap within max_spread
    let oracle_price_data = OraclePriceData {
        price: (20_400 * PRICE_PRECISION) as i128,
        confidence: 1234567,
        delay: 21,
        has_sufficient_number_of_data_points: true,
    };
    let (optimal_peg, budget, check_lb) =
        calculate_optimal_peg_and_budget(&market, &oracle_price_data).unwrap();

    assert_eq!(optimal_peg, 21042480468);
    assert_eq!(budget, 39500000);
    assert!(check_lb);

    // negative target_price_gap exceeding max_spread (in favor of vAMM)
    let oracle_price_data = OraclePriceData {
        price: (42_400 * PRICE_PRECISION) as i128,
        confidence: 0,
        delay: 2,
        has_sufficient_number_of_data_points: true,
    };
    let (optimal_peg, budget, check_lb) =
        calculate_optimal_peg_and_budget(&market, &oracle_price_data).unwrap();

    assert_eq!(optimal_peg, 43735351562);
    assert_eq!(budget, 39500000);
    assert!(check_lb);

    market.amm.base_asset_amount_with_amm = AMM_RESERVE_PRECISION as i128;

    let swap_direction = if market.amm.base_asset_amount_with_amm > 0 {
        SwapDirection::Add
    } else {
        SwapDirection::Remove
    };
    let (new_terminal_quote_reserve, _new_terminal_base_reserve) = amm::calculate_swap_output(
        market.amm.base_asset_amount_with_amm.unsigned_abs(),
        market.amm.base_asset_reserve,
        swap_direction,
        market.amm.sqrt_k,
    )
    .unwrap();

    market.amm.terminal_quote_asset_reserve = new_terminal_quote_reserve;

    // negative target_price_gap exceeding max_spread (not in favor of vAMM)
    let oracle_price_data = OraclePriceData {
        price: (42_400 * PRICE_PRECISION) as i128,
        confidence: 0,
        delay: 2,
        has_sufficient_number_of_data_points: true,
    };
    let (optimal_peg, budget, check_lb) =
        calculate_optimal_peg_and_budget(&market, &oracle_price_data).unwrap();

    assert_eq!(optimal_peg, 41548583984);
    assert_eq!(budget, 21146993011); // $21146.993022
    assert!(!check_lb);
}

#[test]
fn calc_adjust_amm_tests_repeg_in_favour() {
    // btc-esque market
    let market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 65 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 63015384615,
            terminal_quote_asset_reserve: 64 * AMM_RESERVE_PRECISION,
            sqrt_k: 64 * AMM_RESERVE_PRECISION,
            peg_multiplier: 19_400_000_000,
            base_asset_amount_with_amm: AMM_RESERVE_PRECISION as i128,
            mark_std: PRICE_PRECISION as u64,
            last_mark_price_twap_ts: 0,
            curve_update_intensity: 100,
            ..AMM::default()
        },
        ..PerpMarket::default()
    };

    let prev_price = market.amm.reserve_price().unwrap();

    let px = 20_401_125_456;
    let optimal_peg = calculate_peg_from_target_price(
        market.amm.quote_asset_reserve,
        market.amm.base_asset_reserve,
        px,
    )
    .unwrap();
    assert!(optimal_peg > market.amm.peg_multiplier);

    let (repegged_market, _amm_update_cost) = adjust_amm(&market, optimal_peg, 0, true).unwrap();
    assert_eq!(_amm_update_cost, -1618354580);
    assert_eq!(repegged_market.amm.peg_multiplier, optimal_peg);

    let post_price = repegged_market.amm.reserve_price().unwrap();
    assert_eq!(post_price - prev_price, 1593456817); // todo: (15934564582252/1e4 - 1615699103 is the slippage cost?)
}

#[test]
fn calc_adjust_amm_tests_sufficent_fee_for_repeg() {
    // btc-esque market
    let market = PerpMarket {
        amm: AMM {
            order_step_size: 1000,
            base_asset_reserve: 60437939720095,
            quote_asset_reserve: 60440212459368,
            terminal_quote_asset_reserve: 60439072663003,
            sqrt_k: 60439076079049,
            peg_multiplier: 34353000,
            base_asset_amount_with_amm: AMM_RESERVE_PRECISION as i128,
            last_mark_price_twap: 34128370,
            last_mark_price_twap_ts: 165705,
            curve_update_intensity: 100,
            base_spread: 1000,
            total_fee_minus_distributions: 304289,
            total_fee: 607476,
            total_exchange_fee: 0, // new fee pool lowerbound
            funding_period: 3600,
            concentration_coef: MAX_CONCENTRATION_COEFFICIENT,

            ..AMM::default()
        },
        next_curve_record_id: 1,
        next_fill_record_id: 4,
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,

        ..PerpMarket::default()
    };

    let px = 35768 * PRICE_PRECISION / 1000;
    let optimal_peg = calculate_peg_from_target_price(
        market.amm.quote_asset_reserve,
        market.amm.base_asset_reserve,
        px,
    )
    .unwrap();
    assert!(optimal_peg > market.amm.peg_multiplier);
    let fee_budget = calculate_fee_pool(&market).unwrap();
    assert!(fee_budget > 0);
    let (repegged_market, _amm_update_cost) =
        adjust_amm(&market, optimal_peg, fee_budget, true).unwrap();

    // insufficient fee to repeg
    let new_peg = repegged_market.amm.peg_multiplier;
    let old_peg = market.amm.peg_multiplier;
    assert!(new_peg > old_peg);
    assert_eq!(new_peg, 34657283);
    assert_eq!(_amm_update_cost, 304289);
}
