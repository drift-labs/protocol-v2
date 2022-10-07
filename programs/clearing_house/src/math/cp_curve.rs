use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::amm;
use crate::math::bn;
use crate::math::bn::U192;
use crate::math::casting::{cast_to_i128, cast_to_u128};
use crate::math::constants::{
    AMM_RESERVE_PRECISION, AMM_TO_QUOTE_PRECISION_RATIO_I128, K_BPS_UPDATE_SCALE,
    MAX_K_BPS_DECREASE, PEG_PRECISION, PERCENTAGE_PRECISION_I128, QUOTE_PRECISION,
};
use crate::math::position::{_calculate_base_asset_value_and_pnl, calculate_base_asset_value};
use crate::math_error;
use crate::state::market::PerpMarket;
use crate::validate;
use solana_program::msg;

pub fn calculate_budgeted_k_scale(
    market: &mut PerpMarket,
    budget: i128,
    increase_max: i128,
) -> ClearingHouseResult<(u128, u128)> {
    let curve_update_intensity = market.amm.curve_update_intensity as i128;
    let k_pct_upper_bound = increase_max;

    validate!(
        increase_max >= K_BPS_UPDATE_SCALE,
        ErrorCode::DefaultError,
        "invalid increase_max={} < {}",
        increase_max,
        K_BPS_UPDATE_SCALE
    )?;

    let k_pct_lower_bound =
        K_BPS_UPDATE_SCALE - (MAX_K_BPS_DECREASE) * curve_update_intensity / 100;

    let (numerator, denominator) = _calculate_budgeted_k_scale(
        market.amm.base_asset_reserve,
        market.amm.quote_asset_reserve,
        budget,
        market.amm.peg_multiplier,
        market.amm.net_base_asset_amount,
        k_pct_upper_bound,
        k_pct_lower_bound,
    )?;

    Ok((numerator, denominator))
}

pub fn _calculate_budgeted_k_scale(
    x: u128,
    y: u128,
    budget: i128,
    q: u128,
    d: i128,
    k_pct_upper_bound: i128,
    k_pct_lower_bound: i128,
) -> ClearingHouseResult<(u128, u128)> {
    // let curve_update_intensity = curve_update_intensity as i128;
    let c = -budget;
    let q = cast_to_i128(q)?;

    let c_sign: i128 = if c > 0 { 1 } else { -1 };
    let d_sign: i128 = if d > 0 { 1 } else { -1 };

    let rounding_bias: i128 = c_sign.checked_mul(d_sign).ok_or_else(math_error!())?;

    let x_d = cast_to_i128(x)?.checked_add(d).ok_or_else(math_error!())?;

    let amm_reserve_precision_u192 = U192::from(AMM_RESERVE_PRECISION);
    let x_times_x_d_u192 = U192::from(x)
        .checked_mul(U192::from(x_d))
        .ok_or_else(math_error!())?
        .checked_div(amm_reserve_precision_u192)
        .ok_or_else(math_error!())?;

    let quote_precision_u192 = U192::from(QUOTE_PRECISION);
    let x_times_x_d_c = x_times_x_d_u192
        .checked_mul(U192::from(c.unsigned_abs()))
        .ok_or_else(math_error!())?
        .checked_div(quote_precision_u192)
        .ok_or_else(math_error!())?
        .try_to_u128()?;

    let c_times_x_d_d = U192::from(c.unsigned_abs())
        .checked_mul(U192::from(x_d.unsigned_abs()))
        .ok_or_else(math_error!())?
        .checked_div(quote_precision_u192)
        .ok_or_else(math_error!())?
        .checked_mul(U192::from(d.unsigned_abs()))
        .ok_or_else(math_error!())?
        .checked_div(amm_reserve_precision_u192)
        .ok_or_else(math_error!())?
        .try_to_u128()?;

    let pegged_quote_times_dd = cast_to_i128(
        U192::from(y)
            .checked_mul(U192::from(d.unsigned_abs()))
            .ok_or_else(math_error!())?
            .checked_div(amm_reserve_precision_u192)
            .ok_or_else(math_error!())?
            .checked_mul(U192::from(d.unsigned_abs()))
            .ok_or_else(math_error!())?
            .checked_div(amm_reserve_precision_u192)
            .ok_or_else(math_error!())?
            .checked_mul(U192::from(q))
            .ok_or_else(math_error!())?
            .checked_div(U192::from(PEG_PRECISION))
            .ok_or_else(math_error!())?
            .try_to_u128()?,
    )?;

    let numer1 = pegged_quote_times_dd;

    let numer2 = cast_to_i128(c_times_x_d_d)?
        .checked_mul(rounding_bias)
        .ok_or_else(math_error!())?;

    let denom1 = cast_to_i128(x_times_x_d_c)?
        .checked_mul(c_sign)
        .ok_or_else(math_error!())?;

    let denom2 = pegged_quote_times_dd;

    // protocol is spending to increase k
    if c_sign < 0 {
        // thus denom1 is negative and solution is unstable
        if x_times_x_d_c > pegged_quote_times_dd.unsigned_abs() {
            msg!("cost exceeds possible amount to spend");
            msg!("k * {:?}/{:?}", k_pct_upper_bound, K_BPS_UPDATE_SCALE);
            return Ok((
                cast_to_u128(k_pct_upper_bound)?,
                cast_to_u128(K_BPS_UPDATE_SCALE)?,
            ));
        }
    }

    let mut numerator = (numer1.checked_sub(numer2).ok_or_else(math_error!())?)
        .checked_div(AMM_TO_QUOTE_PRECISION_RATIO_I128)
        .ok_or_else(math_error!())?;
    let mut denominator = denom1
        .checked_add(denom2)
        .ok_or_else(math_error!())?
        .checked_div(AMM_TO_QUOTE_PRECISION_RATIO_I128)
        .ok_or_else(math_error!())?;

    if numerator < 0 && denominator < 0 {
        numerator = numerator.abs();
        denominator = denominator.abs();
    }
    assert!((numerator > 0 && denominator > 0));

    let (numerator, denominator) = if numerator > denominator {
        let current_pct_change = numerator
            .checked_mul(PERCENTAGE_PRECISION_I128)
            .ok_or_else(math_error!())?
            .checked_div(denominator)
            .ok_or_else(math_error!())?;

        let maximum_pct_change = k_pct_upper_bound
            .checked_mul(PERCENTAGE_PRECISION_I128)
            .ok_or_else(math_error!())?
            .checked_div(K_BPS_UPDATE_SCALE)
            .ok_or_else(math_error!())?;

        if current_pct_change > maximum_pct_change {
            (k_pct_upper_bound, K_BPS_UPDATE_SCALE)
        } else {
            (current_pct_change, K_BPS_UPDATE_SCALE)
        }
    } else {
        let current_pct_change = numerator
            .checked_mul(PERCENTAGE_PRECISION_I128)
            .ok_or_else(math_error!())?
            .checked_div(denominator)
            .ok_or_else(math_error!())?;

        let maximum_pct_change = k_pct_lower_bound
            .checked_mul(PERCENTAGE_PRECISION_I128)
            .ok_or_else(math_error!())?
            .checked_div(K_BPS_UPDATE_SCALE)
            .ok_or_else(math_error!())?;

        if current_pct_change < maximum_pct_change {
            (k_pct_lower_bound, K_BPS_UPDATE_SCALE)
        } else {
            (current_pct_change, K_BPS_UPDATE_SCALE)
        }
    };

    Ok((cast_to_u128(numerator)?, cast_to_u128(denominator)?))
}

/// To find the cost of adjusting k, compare the the net market value before and after adjusting k
/// Increasing k costs the protocol money because it reduces slippage and improves the exit price for net market position
/// Decreasing k costs the protocol money because it increases slippage and hurts the exit price for net market position
pub fn adjust_k_cost(
    market: &mut PerpMarket,
    update_k_result: &UpdateKResult,
) -> ClearingHouseResult<i128> {
    let mut market_clone = *market;

    // Find the net market value before adjusting k
    let (current_net_market_value, _) = _calculate_base_asset_value_and_pnl(
        market_clone.amm.net_base_asset_amount,
        0,
        &market_clone.amm,
        false,
    )?;

    update_k(&mut market_clone, update_k_result)?;

    let (_new_net_market_value, cost) = _calculate_base_asset_value_and_pnl(
        market_clone.amm.net_base_asset_amount,
        current_net_market_value,
        &market_clone.amm,
        false,
    )?;

    Ok(cost)
}

/// To find the cost of adjusting k, compare the the net market value before and after adjusting k
/// Increasing k costs the protocol money because it reduces slippage and improves the exit price for net market position
/// Decreasing k costs the protocol money because it increases slippage and hurts the exit price for net market position
pub fn adjust_k_cost_and_update(
    market: &mut PerpMarket,
    update_k_result: &UpdateKResult,
) -> ClearingHouseResult<i128> {
    // Find the net market value before adjusting k
    let current_net_market_value =
        calculate_base_asset_value(market.amm.net_base_asset_amount, &market.amm, false)?;

    update_k(market, update_k_result)?;

    let (_new_net_market_value, cost) = _calculate_base_asset_value_and_pnl(
        market.amm.net_base_asset_amount,
        current_net_market_value,
        &market.amm,
        false,
    )?;

    Ok(cost)
}

pub struct UpdateKResult {
    pub sqrt_k: u128,
    pub base_asset_reserve: u128,
    pub quote_asset_reserve: u128,
}

pub fn get_update_k_result(
    market: &PerpMarket,
    new_sqrt_k: bn::U192,
    bound_update: bool,
) -> ClearingHouseResult<UpdateKResult> {
    let sqrt_k_ratio_precision = bn::U192::from(AMM_RESERVE_PRECISION);

    let old_sqrt_k = bn::U192::from(market.amm.sqrt_k);
    let mut sqrt_k_ratio = new_sqrt_k
        .checked_mul(sqrt_k_ratio_precision)
        .ok_or_else(math_error!())?
        .checked_div(old_sqrt_k)
        .ok_or_else(math_error!())?;

    // if decreasing k, max decrease ratio for single transaction is 2.5%
    if bound_update && sqrt_k_ratio < U192::from(975_000_000_u128) {
        return Err(ErrorCode::InvalidUpdateK);
    }

    if sqrt_k_ratio < sqrt_k_ratio_precision {
        sqrt_k_ratio = sqrt_k_ratio + 1;
    }

    let sqrt_k = new_sqrt_k.try_to_u128().unwrap();

    if bound_update
        && new_sqrt_k < old_sqrt_k
        && market.amm.net_base_asset_amount.unsigned_abs()
            > sqrt_k.checked_div(3).ok_or_else(math_error!())?
    {
        // todo, check less lp_tokens as well
        msg!("new_sqrt_k too small relative to market imbalance");
        return Err(ErrorCode::InvalidUpdateK);
    }

    if market.amm.net_base_asset_amount.unsigned_abs() > sqrt_k {
        msg!("new_sqrt_k too small relative to market imbalance");
        return Err(ErrorCode::InvalidUpdateK);
    }

    let base_asset_reserve = bn::U192::from(market.amm.base_asset_reserve)
        .checked_mul(sqrt_k_ratio)
        .ok_or_else(math_error!())?
        .checked_div(sqrt_k_ratio_precision)
        .ok_or_else(math_error!())?
        .try_to_u128()?;

    let invariant_sqrt_u192 = U192::from(sqrt_k);
    let invariant = invariant_sqrt_u192
        .checked_mul(invariant_sqrt_u192)
        .ok_or_else(math_error!())?;

    let quote_asset_reserve = invariant
        .checked_div(U192::from(base_asset_reserve))
        .ok_or_else(math_error!())?
        .try_to_u128()?;

    Ok(UpdateKResult {
        sqrt_k,
        base_asset_reserve,
        quote_asset_reserve,
    })
}

pub fn update_k(market: &mut PerpMarket, update_k_result: &UpdateKResult) -> ClearingHouseResult {
    market.amm.base_asset_reserve = update_k_result.base_asset_reserve;
    market.amm.quote_asset_reserve = update_k_result.quote_asset_reserve;
    market.amm.sqrt_k = update_k_result.sqrt_k;

    let (new_terminal_quote_reserve, new_terminal_base_reserve) =
        amm::calculate_terminal_reserves(&market.amm)?;
    market.amm.terminal_quote_asset_reserve = new_terminal_quote_reserve;

    let (min_base_asset_reserve, max_base_asset_reserve) =
        amm::calculate_bid_ask_bounds(market.amm.concentration_coef, new_terminal_base_reserve)?;
    market.amm.min_base_asset_reserve = min_base_asset_reserve;
    market.amm.max_base_asset_reserve = max_base_asset_reserve;

    let reserve_price_after = market.amm.reserve_price()?;
    crate::controller::amm::update_spreads(&mut market.amm, reserve_price_after)?;

    Ok(())
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::controller::amm::update_spreads;
    use crate::controller::lp::burn_lp_shares;
    use crate::controller::lp::mint_lp_shares;
    use crate::controller::lp::settle_lp_position;
    use crate::controller::position::PositionDirection;
    use crate::math::constants::{
        BASE_PRECISION_U64, MAX_CONCENTRATION_COEFFICIENT, MAX_K_BPS_INCREASE, QUOTE_PRECISION_I64,
    };
    use crate::state::market::AMM;
    use crate::state::user::PerpPosition;

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
        let is_error = get_update_k_result(&market, new_sqrt_k, true).is_err();
        assert!(is_error);

        let is_ok = get_update_k_result(&market, new_sqrt_k, false).is_ok();
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
                net_base_asset_amount: -12295081967,
                ..AMM::default()
            },
            ..PerpMarket::default()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;
        market.amm.base_spread = 10;
        market.amm.long_spread = 5;
        market.amm.short_spread = 5;

        let (new_ask_base_asset_reserve, new_ask_quote_asset_reserve) =
            crate::math::amm_spread::calculate_spread_reserves(
                &market.amm,
                PositionDirection::Long,
            )
            .unwrap();
        let (new_bid_base_asset_reserve, new_bid_quote_asset_reserve) =
            crate::math::amm_spread::calculate_spread_reserves(
                &market.amm,
                PositionDirection::Short,
            )
            .unwrap();

        market.amm.ask_base_asset_reserve = new_ask_base_asset_reserve;
        market.amm.bid_base_asset_reserve = new_bid_base_asset_reserve;
        market.amm.ask_quote_asset_reserve = new_ask_quote_asset_reserve;
        market.amm.bid_quote_asset_reserve = new_bid_quote_asset_reserve;

        validate!(
            market.amm.bid_base_asset_reserve >= market.amm.base_asset_reserve
                && market.amm.bid_quote_asset_reserve <= market.amm.quote_asset_reserve,
            ErrorCode::DefaultError,
            "bid reserves out of wack: {} -> {}, quote: {} -> {}",
            market.amm.bid_base_asset_reserve,
            market.amm.base_asset_reserve,
            market.amm.bid_quote_asset_reserve,
            market.amm.quote_asset_reserve
        )
        .unwrap();

        // increase k by .25%
        let update_k_result =
            get_update_k_result(&market, bn::U192::from(501 * AMM_RESERVE_PRECISION), true)
                .unwrap();
        update_k(&mut market, &update_k_result).unwrap();

        validate!(
            market.amm.bid_base_asset_reserve >= market.amm.base_asset_reserve
                && market.amm.bid_quote_asset_reserve <= market.amm.quote_asset_reserve,
            ErrorCode::DefaultError,
            "bid reserves out of wack: {} -> {}, quote: {} -> {}",
            market.amm.bid_base_asset_reserve,
            market.amm.base_asset_reserve,
            market.amm.bid_quote_asset_reserve,
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
        let net_base_asset_amount: i128 = 57982559000000000;
        let k_pct_upper_bound = 100000000;
        let k_pct_lower_bound = 1000000;

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve,
                quote_asset_reserve,
                concentration_coef: MAX_CONCENTRATION_COEFFICIENT,
                sqrt_k: 10000000000000000000,
                peg_multiplier,
                net_base_asset_amount,
                ..AMM::default()
            },
            ..PerpMarket::default()
        };

        let (numerator, denominator) = _calculate_budgeted_k_scale(
            base_asset_reserve,
            quote_asset_reserve,
            budget,
            peg_multiplier,
            net_base_asset_amount,
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
            .checked_mul(bn::U192::from(k_scale_numerator))
            .ok_or_else(math_error!())
            .unwrap()
            .checked_div(bn::U192::from(k_scale_denominator))
            .ok_or_else(math_error!())
            .unwrap();

        let update_k_result = get_update_k_result(&market, new_sqrt_k, true).unwrap();

        let adjustment_cost = adjust_k_cost(&mut market, &update_k_result).unwrap();
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
                net_base_asset_amount: -12295081967,
                ..AMM::default()
            },
            ..PerpMarket::default()
        };
        // increase k by .25%
        let update_k_up =
            get_update_k_result(&market, bn::U192::from(501 * AMM_RESERVE_PRECISION), true)
                .unwrap();
        let (t_price, t_qar, t_bar) =
            amm::calculate_terminal_price_and_reserves(&market.amm).unwrap();

        // new terminal reserves are balanced, terminal price = peg)
        assert_eq!(t_qar, 500 * AMM_RESERVE_PRECISION);
        assert_eq!(t_bar, 500 * AMM_RESERVE_PRECISION);
        assert_eq!(t_price, market.amm.peg_multiplier);

        assert_eq!(update_k_up.sqrt_k, 501 * AMM_RESERVE_PRECISION);
        assert_eq!(update_k_up.base_asset_reserve, 513319672130);
        assert_eq!(update_k_up.quote_asset_reserve, 488976000001);

        // cost to increase k is always positive when imbalanced
        let cost = adjust_k_cost_and_update(&mut market, &update_k_up).unwrap();
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
                net_base_asset_amount: (AMM_RESERVE_PRECISION * 66) as i128,
                ..AMM::default()
            },
            ..PerpMarket::default()
        };

        let (numer1, denom1) = calculate_budgeted_k_scale(
            &mut market,
            (QUOTE_PRECISION / 500) as i128, // positive budget
            1100000,
        )
        .unwrap();

        assert_eq!(numer1, 1000700);
        assert_eq!(denom1, 1000000);
        assert!(numer1 > denom1);

        let pct_change_in_k = (numer1 * 10000) / denom1;
        assert_eq!(pct_change_in_k, 10007); // k was increased .07%
    }

    #[test]
    fn calculate_k_with_lps_tests() {
        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                terminal_quote_asset_reserve: 999900009999000 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 50_000_000_000,
                net_base_asset_amount: (AMM_RESERVE_PRECISION / 10) as i128,
                order_step_size: 3,
                max_spread: 1000,
                ..AMM::default_test()
            },
            margin_ratio_initial: 1000,
            base_asset_amount_long: (AMM_RESERVE_PRECISION / 10) as i128,
            ..PerpMarket::default()
        };
        // let (t_price, _t_qar, _t_bar) = calculate_terminal_price_and_reserves(&market.amm).unwrap();
        // market.amm.terminal_quote_asset_reserve = _t_qar;

        let mut position = PerpPosition {
            ..PerpPosition::default()
        };

        mint_lp_shares(&mut position, &mut market, BASE_PRECISION_U64).unwrap();

        market.amm.market_position_per_lp = PerpPosition {
            base_asset_amount: 1,
            quote_asset_amount: -QUOTE_PRECISION_I64,
            ..PerpPosition::default()
        };

        let reserve_price = market.amm.reserve_price().unwrap();
        update_spreads(&mut market.amm, reserve_price).unwrap();

        settle_lp_position(&mut position, &mut market).unwrap();

        assert_eq!(position.base_asset_amount, 0);
        assert_eq!(position.quote_asset_amount, -QUOTE_PRECISION_I64);
        assert_eq!(position.last_net_base_asset_amount_per_lp, 1);
        assert_eq!(
            position.last_net_quote_asset_amount_per_lp,
            -QUOTE_PRECISION_I64
        );

        // increase k by 1%
        let update_k_up =
            get_update_k_result(&market, bn::U192::from(102 * AMM_RESERVE_PRECISION), false)
                .unwrap();
        let (t_price, _t_qar, _t_bar) =
            amm::calculate_terminal_price_and_reserves(&market.amm).unwrap();

        // new terminal reserves are balanced, terminal price = peg)
        // assert_eq!(t_qar, 999900009999000);
        // assert_eq!(t_bar, 1000100000000000);
        assert_eq!(t_price, 49901136949); //
                                          // assert_eq!(update_k_up.sqrt_k, 101 * AMM_RESERVE_PRECISION);

        let cost = adjust_k_cost(&mut market, &update_k_up).unwrap();
        assert_eq!(
            market.amm.net_base_asset_amount,
            (AMM_RESERVE_PRECISION / 10) as i128
        );
        assert_eq!(cost, 49400); //0.05

        // lp whale adds
        let lp_whale_amount = 1000 * BASE_PRECISION_U64;
        mint_lp_shares(&mut position, &mut market, lp_whale_amount).unwrap();

        // ensure same cost
        let update_k_up =
            get_update_k_result(&market, bn::U192::from(1102 * AMM_RESERVE_PRECISION), false)
                .unwrap();
        let cost = adjust_k_cost(&mut market, &update_k_up).unwrap();
        assert_eq!(
            market.amm.net_base_asset_amount,
            (AMM_RESERVE_PRECISION / 10) as i128
        );
        assert_eq!(cost, 49450); //0.05

        let update_k_down =
            get_update_k_result(&market, bn::U192::from(1001 * AMM_RESERVE_PRECISION), false)
                .unwrap();
        let cost = adjust_k_cost(&mut market, &update_k_down).unwrap();
        assert_eq!(cost, -4995004950); //amm rug

        // lp whale removes
        burn_lp_shares(&mut position, &mut market, lp_whale_amount, 0).unwrap();

        // ensure same cost
        let update_k_up =
            get_update_k_result(&market, bn::U192::from(102 * AMM_RESERVE_PRECISION), false)
                .unwrap();
        let cost = adjust_k_cost(&mut market, &update_k_up).unwrap();
        assert_eq!(
            market.amm.net_base_asset_amount,
            (AMM_RESERVE_PRECISION / 10) as i128 - 1
        );
        assert_eq!(cost, 49450); //0.05

        let update_k_down =
            get_update_k_result(&market, bn::U192::from(79 * AMM_RESERVE_PRECISION), false)
                .unwrap();
        let cost = adjust_k_cost(&mut market, &update_k_down).unwrap();
        assert_eq!(cost, -1407000); //0.05

        // lp owns 50% of vAMM, same k
        position.lp_shares = 50 * BASE_PRECISION_U64;
        market.amm.user_lp_shares = 50 * AMM_RESERVE_PRECISION;
        // cost to increase k is always positive when imbalanced
        let cost = adjust_k_cost(&mut market, &update_k_up).unwrap();
        assert_eq!(
            market.amm.net_base_asset_amount,
            (AMM_RESERVE_PRECISION / 10) as i128 - 1
        );
        assert_eq!(cost, 187800); //0.19

        // lp owns 99% of vAMM, same k
        position.lp_shares = 99 * BASE_PRECISION_U64;
        market.amm.user_lp_shares = 99 * AMM_RESERVE_PRECISION;
        let cost2 = adjust_k_cost(&mut market, &update_k_up).unwrap();
        assert!(cost2 > cost);
        assert_eq!(cost2, 76804900); //216.45

        // lp owns 100% of vAMM, same k
        position.lp_shares = 100 * BASE_PRECISION_U64;
        market.amm.user_lp_shares = 100 * AMM_RESERVE_PRECISION;
        let cost3 = adjust_k_cost(&mut market, &update_k_up).unwrap();
        assert!(cost3 > cost);
        assert!(cost3 > cost2);
        assert_eq!(cost3, 216450200);

        // //  todo: support this
        // market.amm.net_base_asset_amount = -(AMM_RESERVE_PRECISION as i128);
        // let cost2 = adjust_k_cost(&mut market, &update_k_up).unwrap();
        // assert!(cost2 > cost);
        // assert_eq!(cost2, 249999999999850000000001);
    }
}
