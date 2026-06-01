use crate::amm::math::amm;
use crate::amm::math::cp_curve::*;
use crate::amm::AMM;
use crate::controller::position::PositionDirection;
use crate::math::constants::{
    AMM_RESERVE_PRECISION, MAX_CONCENTRATION_COEFFICIENT, MAX_K_BPS_INCREASE, PRICE_PRECISION,
    QUOTE_PRECISION_I64,
};
use crate::state::perp_market::PerpMarket;

#[test]
fn k_update_results_bound_flag() {
    let init_reserves = 100 * AMM_RESERVE_PRECISION;
    let amm = AMM {
        sqrt_k: init_reserves,
        base_asset_reserve: init_reserves,
        quote_asset_reserve: init_reserves,
        ..AMM::default()
    };
    let market = PerpMarket {
        amm,
        ..PerpMarket::default()
    };

    let new_sqrt_k = U192::from(AMM_RESERVE_PRECISION);
    let is_error = get_update_k_result(&market.amm, market.status, new_sqrt_k, true).is_err();
    assert!(is_error);

    let is_ok = get_update_k_result(&market.amm, market.status, new_sqrt_k, false).is_ok();
    assert!(is_ok)
}

#[test]
fn calculate_k_tests_with_spread() {
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            concentration_coef: MAX_CONCENTRATION_COEFFICIENT,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000000,
            base_asset_amount_with_amm: -12295081967,
            ..AMM::default()
        },
        ..PerpMarket::default()
    };
    market.amm.max_base_asset_reserve = u128::MAX;
    market.amm.min_base_asset_reserve = 0;
    market.amm.base_spread = 10;

    // Spread reserves are no longer cached on `AMM` — compute them via the
    // pure `compute_spread_reserves_for_direction` helper with explicit
    // spread / reference-price-offset inputs (mirrors what
    // `compute_amm_quote_state` does in production).
    let half_base_spread = market.amm.base_spread / 2;
    let (new_ask_base_asset_reserve, new_ask_quote_asset_reserve) =
        crate::amm::math::spread::compute_spread_reserves_for_direction(
            &market.amm,
            half_base_spread,
            0,
            PositionDirection::Long,
        )
        .unwrap();
    let (new_bid_base_asset_reserve, new_bid_quote_asset_reserve) =
        crate::amm::math::spread::compute_spread_reserves_for_direction(
            &market.amm,
            half_base_spread,
            0,
            PositionDirection::Short,
        )
        .unwrap();

    validate!(
        new_bid_base_asset_reserve >= market.amm.base_asset_reserve
            && new_bid_quote_asset_reserve <= market.amm.quote_asset_reserve,
        ErrorCode::InvalidAmmDetected,
        "market index {} amm bid reserves invalid: {} -> {}, quote: {} -> {}",
        market.market_index,
        new_bid_base_asset_reserve,
        market.amm.base_asset_reserve,
        new_bid_quote_asset_reserve,
        market.amm.quote_asset_reserve
    )
    .unwrap();

    validate!(
        new_ask_base_asset_reserve <= market.amm.base_asset_reserve
            && new_ask_quote_asset_reserve >= market.amm.quote_asset_reserve,
        ErrorCode::InvalidAmmDetected,
        "market index {} amm ask reserves invalid: {} -> {}, quote: {} -> {}",
        market.market_index,
        new_ask_base_asset_reserve,
        market.amm.base_asset_reserve,
        new_ask_quote_asset_reserve,
        market.amm.quote_asset_reserve
    )
    .unwrap();

    // increase k by .25%
    let update_k_result = get_update_k_result(
        &market.amm,
        market.status,
        bn::U192::from(501 * AMM_RESERVE_PRECISION),
        true,
    )
    .unwrap();
    market.amm.apply_k_update(&update_k_result).unwrap();

    // Re-derive spread reserves against the updated AMM and re-validate.
    let (new_ask_base_asset_reserve, new_ask_quote_asset_reserve) =
        crate::amm::math::spread::compute_spread_reserves_for_direction(
            &market.amm,
            half_base_spread,
            0,
            PositionDirection::Long,
        )
        .unwrap();
    let (new_bid_base_asset_reserve, new_bid_quote_asset_reserve) =
        crate::amm::math::spread::compute_spread_reserves_for_direction(
            &market.amm,
            half_base_spread,
            0,
            PositionDirection::Short,
        )
        .unwrap();

    validate!(
        new_bid_base_asset_reserve >= market.amm.base_asset_reserve
            && new_bid_quote_asset_reserve <= market.amm.quote_asset_reserve,
        ErrorCode::InvalidAmmDetected,
        "bid reserves out of wack: {} -> {}, quote: {} -> {}",
        new_bid_base_asset_reserve,
        market.amm.base_asset_reserve,
        new_bid_quote_asset_reserve,
        market.amm.quote_asset_reserve
    )
    .unwrap();

    validate!(
        new_ask_base_asset_reserve <= market.amm.base_asset_reserve
            && new_ask_quote_asset_reserve >= market.amm.quote_asset_reserve,
        ErrorCode::InvalidAmmDetected,
        "ask reserves out of wack: {} -> {}, quote: {} -> {}",
        new_ask_base_asset_reserve,
        market.amm.base_asset_reserve,
        new_ask_quote_asset_reserve,
        market.amm.quote_asset_reserve
    )
    .unwrap();
}

#[test]
fn calculate_k_with_rounding() {
    let base_asset_reserve: u128 = 9942017440883516352;
    let quote_asset_reserve: u128 = 10058320717561858267;
    let budget: i128 = 32195176;
    let peg_multiplier: u128 = 1103;
    let base_asset_amount_with_amm: i128 = 57982559000000000;
    let k_pct_upper_bound = 100000000;
    let k_pct_lower_bound = 1000000;

    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve,
            quote_asset_reserve,
            concentration_coef: MAX_CONCENTRATION_COEFFICIENT,
            sqrt_k: 10000000000000000000,
            peg_multiplier,
            base_asset_amount_with_amm,
            ..AMM::default()
        },
        ..PerpMarket::default()
    };

    let (numerator, denominator) = _calculate_budgeted_k_scale(
        base_asset_reserve,
        quote_asset_reserve,
        budget,
        peg_multiplier,
        base_asset_amount_with_amm,
        k_pct_upper_bound,
        k_pct_lower_bound,
    )
    .unwrap();
    assert_eq!(numerator, 1094419);
    assert_eq!(denominator, 1000000);

    assert_eq!(100000000 * numerator / denominator, 109441900);

    let k_scale_numerator: u128 = 373175;
    let k_scale_denominator: u128 = 340980;

    let new_sqrt_k = bn::U192::from(market.amm.sqrt_k)
        .safe_mul(bn::U192::from(k_scale_numerator))
        .unwrap()
        .safe_div(bn::U192::from(k_scale_denominator))
        .unwrap();

    let update_k_result =
        get_update_k_result(&market.amm, market.status, new_sqrt_k, true).unwrap();

    let adjustment_cost = adjust_k_cost(&market.amm, &update_k_result).unwrap();
    assert!(adjustment_cost <= budget);
    assert_eq!(adjustment_cost, 32195097);
}

#[test]
fn calculate_k_tests() {
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            concentration_coef: MAX_CONCENTRATION_COEFFICIENT,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000000,
            base_asset_amount_with_amm: -12295081967,
            ..AMM::default()
        },
        ..PerpMarket::default()
    };
    // increase k by .25%
    let update_k_up = get_update_k_result(
        &market.amm,
        market.status,
        bn::U192::from(501 * AMM_RESERVE_PRECISION),
        true,
    )
    .unwrap();
    let (t_price, t_qar, t_bar) = amm::calculate_terminal_price_and_reserves(&market.amm).unwrap();

    // new terminal reserves are balanced, terminal price = peg)
    assert_eq!(t_qar, 500 * AMM_RESERVE_PRECISION);
    assert_eq!(t_bar, 500 * AMM_RESERVE_PRECISION);
    assert_eq!(t_price as u128, market.amm.peg_multiplier);

    assert_eq!(update_k_up.sqrt_k, 501 * AMM_RESERVE_PRECISION);
    assert_eq!(update_k_up.base_asset_reserve, 513319672130);
    assert_eq!(update_k_up.quote_asset_reserve, 488976000001);

    // cost to increase k is always positive when imbalanced
    let cost = market.amm.adjust_k_cost_and_update(&update_k_up).unwrap();
    assert_eq!(market.amm.terminal_quote_asset_reserve, 500975411043);
    assert!(cost > 0);
    assert_eq!(cost, 29448);

    let (t_price2, t_qar2, t_bar2) =
        amm::calculate_terminal_price_and_reserves(&market.amm).unwrap();
    // since users are net short, new terminal price lower after increasing k
    assert!(t_price2 < t_price);
    // new terminal reserves are unbalanced with quote below base (lower terminal price)
    assert_eq!(t_bar2, 501024590163);
    assert_eq!(t_qar2, 500975411043);

    let curve_update_intensity = 100;
    let k_pct_upper_bound =
        K_BPS_UPDATE_SCALE + (MAX_K_BPS_INCREASE) * curve_update_intensity / 100;
    let k_pct_lower_bound =
        K_BPS_UPDATE_SCALE - (MAX_K_BPS_DECREASE) * curve_update_intensity / 100;

    // with positive budget, how much can k be increased?
    let (numer1, denom1) = _calculate_budgeted_k_scale(
        AMM_RESERVE_PRECISION * 55414,
        AMM_RESERVE_PRECISION * 55530,
        (QUOTE_PRECISION / 500) as i128, // positive budget
        36365000,
        (AMM_RESERVE_PRECISION * 66) as i128,
        k_pct_upper_bound,
        k_pct_lower_bound,
    )
    .unwrap();

    assert!(numer1 > denom1);
    assert_eq!(numer1, 1000700);
    assert_eq!(denom1, 1000000);

    let mut pct_change_in_k = (numer1 * 10000) / denom1;
    assert_eq!(pct_change_in_k, 10007); // k was increased .07%

    // with negative budget, how much should k be lowered?
    let (numer1, denom1) = _calculate_budgeted_k_scale(
        AMM_RESERVE_PRECISION * 55414,
        AMM_RESERVE_PRECISION * 55530,
        -((QUOTE_PRECISION / 50) as i128),
        36365000,
        (AMM_RESERVE_PRECISION * 66) as i128,
        k_pct_upper_bound,
        k_pct_lower_bound,
    )
    .unwrap();
    assert!(numer1 < denom1);
    pct_change_in_k = (numer1 * 1000000) / denom1;
    assert_eq!(pct_change_in_k, 993050); // k was decreased 0.695%

    // show non-linearity with budget
    let (numer1, denom1) = _calculate_budgeted_k_scale(
        AMM_RESERVE_PRECISION * 55414,
        AMM_RESERVE_PRECISION * 55530,
        -((QUOTE_PRECISION / 25) as i128),
        36365000,
        (AMM_RESERVE_PRECISION * 66) as i128,
        k_pct_upper_bound,
        k_pct_lower_bound,
    )
    .unwrap();
    assert!(numer1 < denom1);
    pct_change_in_k = (numer1 * 1000000) / denom1;
    assert_eq!(pct_change_in_k, 986196); // k was decreased 1.3804%

    // todo:
    let (numer1, denom1) = _calculate_budgeted_k_scale(
        500000000049750000004950,
        499999999950250000000000,
        114638,
        40000000,
        49750000004950,
        k_pct_upper_bound,
        k_pct_lower_bound,
    )
    .unwrap();

    assert!(numer1 > denom1);
    assert_eq!(numer1, 1001000);
    assert_eq!(denom1, 1000000);

    // todo:
    let (numer1, denom1) = _calculate_budgeted_k_scale(
        500000000049750000004950,
        499999999950250000000000,
        -114638,
        40000000,
        49750000004950,
        k_pct_upper_bound,
        k_pct_lower_bound,
    )
    .unwrap();

    assert!(numer1 < denom1);
    assert_eq!(numer1, 978000); // 2.2% decrease
    assert_eq!(denom1, 1000000);
}

#[test]
fn calculate_k_tests_wrapper_fcn() {
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: AMM_RESERVE_PRECISION * 55414,
            quote_asset_reserve: AMM_RESERVE_PRECISION * 55530,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 36365000,
            base_asset_amount_with_amm: (AMM_RESERVE_PRECISION * 66) as i128,
            ..AMM::default()
        },
        ..PerpMarket::default()
    };

    let (numer1, denom1) = calculate_budgeted_k_scale(
        &market.amm,
        (QUOTE_PRECISION / 500) as i128, // positive budget
        1100000,
        1000000 - 22000,
    )
    .unwrap();

    assert_eq!(numer1, 1000700);
    assert_eq!(denom1, 1000000);
    assert!(numer1 > denom1);

    let pct_change_in_k = (numer1 * 10000) / denom1;
    assert_eq!(pct_change_in_k, 10007); // k was increased .07%
}

// `amm_spread_adj_logic` was removed: it drove the deleted `update_spreads`
// mutator and asserted on cached spread fields that no longer exist on
// AMM. The underlying spread-adjustment math is covered by tests against
// `compute_amm_quote_state` in `math/amm_spread/tests.rs`.
