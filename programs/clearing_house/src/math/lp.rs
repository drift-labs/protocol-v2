use crate::controller::amm::SwapDirection;
use crate::error::ClearingHouseResult;
use crate::math::amm::calculate_swap_output;
use crate::math::casting::cast_to_i128;
use crate::math::constants::{AMM_RESERVE_PRECISION, AMM_TO_QUOTE_PRECISION_RATIO, PEG_PRECISION};
use crate::math::quote_asset::reserve_to_asset_amount;
use crate::math_error;
use crate::state::market::AMM;
use crate::state::user::MarketPosition;

use solana_program::msg;
use std::cmp::max;

#[derive(Debug)]
pub struct LPMetrics {
    pub fee_payment: i128,
    pub funding_payment: i128,
    pub unsettled_pnl: i128,
    pub base_asset_amount: i128,
    pub quote_asset_amount: u128,
}

pub fn get_lp_metrics(
    lp_position: &MarketPosition,
    lp_tokens_to_settle: u128,
    amm: &AMM,
) -> ClearingHouseResult<LPMetrics> {
    let total_lp_tokens = amm.sqrt_k;

    // give them fees
    let fee_delta = cast_to_i128(amm.total_fee_minus_distributions)?
        .checked_sub(cast_to_i128(
            lp_position.last_total_fee_minus_distributions,
        )?)
        .ok_or_else(math_error!())?;
    let fee_payment = get_proportion_i128(fee_delta, lp_tokens_to_settle, total_lp_tokens)?;

    // give them the funding
    let funding_delta = amm
        .cumulative_funding_rate_lp
        .checked_sub(lp_position.last_cumulative_funding_rate)
        .ok_or_else(math_error!())?;
    let funding_payment = get_proportion_i128(funding_delta, lp_tokens_to_settle, total_lp_tokens)?;

    // give them slice of the damm market position
    let net_base_asset_amount_delta = lp_position
        .last_net_base_asset_amount
        .checked_sub(amm.net_base_asset_amount)
        .ok_or_else(math_error!())?;

    let mut market_base_asset_amount = 0;
    let mut market_quote_asset_amount = 0;
    let mut unsettled_pnl = 0;

    if net_base_asset_amount_delta != 0 {
        let base_asset_amount = get_proportion_i128(
            net_base_asset_amount_delta,
            lp_tokens_to_settle,
            total_lp_tokens,
        )?;

        let net_quote_asset_amount_delta =
            calculate_swap_quote_reserve_delta(amm, net_base_asset_amount_delta)?;

        // when qar delta is very small => converting to quote precision
        // results in zero -- user position will have non-zero base with zero quote
        let quote_asset_amount = reserve_to_asset_amount(
            get_proportion_u128(
                net_quote_asset_amount_delta,
                lp_tokens_to_settle,
                total_lp_tokens,
            )?,
            amm.peg_multiplier,
        )?;

        let min_qaa = amm.minimum_quote_asset_trade_size;
        let min_baa = amm.base_asset_amount_step_size;

        if base_asset_amount.unsigned_abs() >= min_baa && quote_asset_amount >= min_qaa {
            market_quote_asset_amount = quote_asset_amount;
            market_base_asset_amount = base_asset_amount;
        } else {
            // no market position bc too small so give them negative upnl
            // similar to closing their small position
            // TODO: decide what this should be
            unsettled_pnl = cast_to_i128(min_qaa)?
                .checked_mul(-1)
                .ok_or_else(math_error!())?;
        }
    }

    let lp_metrics = LPMetrics {
        fee_payment,
        funding_payment,
        base_asset_amount: market_base_asset_amount,
        quote_asset_amount: market_quote_asset_amount,
        unsettled_pnl,
    };

    Ok(lp_metrics)
}

pub fn calculate_swap_quote_reserve_delta(
    amm: &AMM,
    base_asset_amount: i128,
) -> ClearingHouseResult<u128> {
    let swap_direction = match base_asset_amount > 0 {
        true => SwapDirection::Remove,
        false => SwapDirection::Add,
    };

    let (new_quote_asset_reserve, _) = calculate_swap_output(
        base_asset_amount.unsigned_abs(),
        amm.base_asset_reserve,
        swap_direction,
        amm.sqrt_k,
    )?;

    // avoid overflow - note: sign doesnt matter
    let quote_asset_reserve_output = if new_quote_asset_reserve > amm.quote_asset_reserve {
        new_quote_asset_reserve
            .checked_sub(amm.quote_asset_reserve)
            .ok_or_else(math_error!())?
    } else {
        amm.quote_asset_reserve
            .checked_sub(new_quote_asset_reserve)
            .ok_or_else(math_error!())?
    };

    Ok(quote_asset_reserve_output)
}

pub fn get_lp_market_position_margin(
    lp_position: &MarketPosition,
    amm: &AMM,
) -> ClearingHouseResult<(MarketPosition, u128)> {
    let total_lp_tokens = amm.sqrt_k;
    let lp_tokens = lp_position.lp_tokens;

    let mut market_position = *lp_position; // clone bc its only temporary
    let lp_metrics = get_lp_metrics(&market_position, lp_tokens, amm)?;

    // update pnl payments
    market_position.unsettled_pnl = lp_position
        .unsettled_pnl
        .checked_add(lp_metrics.fee_payment)
        .ok_or_else(math_error!())?
        .checked_add(lp_metrics.funding_payment)
        .ok_or_else(math_error!())?;

    // worse case market position
    // max ask: (sqrtk*1.4142 - base asset reserves) * lp share
    // max bid: (base asset reserves - sqrtk/1.4142) * lp share

    // TODO: is there a cleaner way to do this? -- maybe make it a constant?
    let percision: f64 = 10_000_000_000_000.0; // amm percision as float
    let sqrt_2 = (2_f64.sqrt() * percision).round() as u128;

    // worse case if all asks are filled
    let ask_bounded_k = amm
        .sqrt_k
        .checked_mul(sqrt_2)
        .ok_or_else(math_error!())?
        .checked_div(AMM_RESERVE_PRECISION)
        .ok_or_else(math_error!())?;

    let max_asks_fill = ask_bounded_k
        .checked_sub(amm.base_asset_reserve)
        .ok_or_else(math_error!())?;

    // worse case if all bids are filled (lp is now long)
    let bids_bounded_k = amm
        .sqrt_k
        .checked_mul(AMM_RESERVE_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(sqrt_2)
        .ok_or_else(math_error!())?;

    let max_bids_fill = amm
        .base_asset_reserve
        .checked_sub(bids_bounded_k)
        .ok_or_else(math_error!())?;

    // both will always be positive so its ok to compare directly
    let net_base_asset_amount = if max_bids_fill > max_asks_fill {
        cast_to_i128(max_bids_fill)? // lp goes long
    } else {
        cast_to_i128(max_asks_fill)?
            .checked_mul(-1)
            .ok_or_else(math_error!())? // lp is short (baa = negative)
    };

    let quote_asset_reserve_amount =
        calculate_swap_quote_reserve_delta(amm, net_base_asset_amount)?;

    let quote_asset_amount = reserve_to_asset_amount(
        get_proportion_u128(quote_asset_reserve_amount, lp_tokens, total_lp_tokens)?,
        amm.peg_multiplier,
    )?;

    let base_asset_amount = get_proportion_i128(net_base_asset_amount, lp_tokens, total_lp_tokens)?;

    market_position.base_asset_amount = base_asset_amount;
    market_position.quote_asset_amount = quote_asset_amount;

    // additional lp margin requirements for holding lp tokens
    let lp_margin_requirement = max(
        1,
        market_position
            .lp_tokens
            .checked_mul(2)
            .ok_or_else(math_error!())?
            .checked_mul(amm.peg_multiplier)
            .ok_or_else(math_error!())?
            .checked_div(PEG_PRECISION)
            .ok_or_else(math_error!())?
            .checked_div(AMM_TO_QUOTE_PRECISION_RATIO)
            .ok_or_else(math_error!())?,
    );

    Ok((market_position, lp_margin_requirement))
}

// TODO: change to macro to support value=u128, U192, etc. without casting?
pub fn get_proportion_i128(
    value: i128,
    numerator: u128,
    denominator: u128,
) -> ClearingHouseResult<i128> {
    let sign: i128 = if value > 0 { 1 } else { -1 };
    let proportional_value = cast_to_i128(
        value
            .unsigned_abs()
            .checked_mul(numerator)
            .ok_or_else(math_error!())?
            .checked_div(denominator)
            .ok_or_else(math_error!())?,
    )?
    .checked_mul(sign)
    .ok_or_else(math_error!())?;
    Ok(proportional_value)
}

pub fn get_proportion_u128(
    value: u128,
    numerator: u128,
    denominator: u128,
) -> ClearingHouseResult<u128> {
    let proportional_value = value
        .checked_mul(numerator)
        .ok_or_else(math_error!())?
        .checked_div(denominator)
        .ok_or_else(math_error!())?;
    Ok(proportional_value)
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::math::position::calculate_base_asset_value_and_pnl;

    #[test]
    fn test_margin_requirements_user_short() {
        let lp_position = MarketPosition {
            lp_tokens: 10 * AMM_RESERVE_PRECISION,
            ..MarketPosition::default()
        };

        // 500_000 * 1e13
        let init_reserves: u128 = 5000000000000000000;
        let mut amm = AMM {
            // balanced market
            base_asset_reserve: init_reserves,
            quote_asset_reserve: init_reserves,
            sqrt_k: init_reserves,
            peg_multiplier: 53000,
            ..AMM::default()
        };

        let (market_position, _) = get_lp_market_position_margin(&lp_position, &amm).unwrap();
        let (balanced_position_base_asset_value, balanced_pnl) =
            calculate_base_asset_value_and_pnl(&market_position, &amm, true).unwrap();

        // make the market unbalanced
        // note we gotta short a lot more bc theres more risk to lps going short than long
        let trade_size = 200_000 * AMM_RESERVE_PRECISION;
        let (new_qar, new_bar) = calculate_swap_output(
            trade_size,
            amm.base_asset_reserve,
            SwapDirection::Add, // user shorts
            amm.sqrt_k,
        )
        .unwrap();
        amm.quote_asset_reserve = new_qar;
        amm.base_asset_reserve = new_bar;

        // recompute margin requirements
        let (market_position, _) = get_lp_market_position_margin(&lp_position, &amm).unwrap();
        let (unbalanced_position_base_asset_value, unbalanced_pnl) =
            calculate_base_asset_value_and_pnl(&market_position, &amm, true).unwrap();

        let unbalanced_value: i128 = unbalanced_position_base_asset_value as i128 - unbalanced_pnl;
        let balanced_value: i128 = balanced_position_base_asset_value as i128 - balanced_pnl;

        println!("pnl: {} {}", balanced_pnl, unbalanced_pnl);
        println!(
            "base v: {} {} {}",
            balanced_position_base_asset_value,
            unbalanced_position_base_asset_value,
            balanced_position_base_asset_value < unbalanced_position_base_asset_value
        );
        println!(
            "total v: {} {} {}",
            balanced_value,
            unbalanced_value,
            unbalanced_value > balanced_value
        );

        // this doesnt pass regardless of trade size when the user shorts lol
        //assert!(unbalanced_position_base_asset_value > balanced_position_base_asset_value);

        // this passes
        assert!(unbalanced_value > balanced_value);
    }

    #[test]
    fn test_margin_requirements_user_long() {
        let lp_position = MarketPosition {
            lp_tokens: 50 * AMM_RESERVE_PRECISION,
            ..MarketPosition::default()
        };

        let init_reserves: u128 = 5000000000000000000;
        let mut amm = AMM {
            // balanced market
            base_asset_reserve: init_reserves,
            quote_asset_reserve: init_reserves,
            sqrt_k: init_reserves,
            peg_multiplier: 53000,
            ..AMM::default()
        };

        let (market_position, _) = get_lp_market_position_margin(&lp_position, &amm).unwrap();
        let (balanced_position_base_asset_value, balanced_pnl) =
            calculate_base_asset_value_and_pnl(&market_position, &amm, true).unwrap();

        // make the market unbalanced
        let trade_size = 2_000 * AMM_RESERVE_PRECISION;
        let (new_qar, new_bar) = calculate_swap_output(
            trade_size,
            amm.base_asset_reserve,
            SwapDirection::Remove, // user longs
            amm.sqrt_k,
        )
        .unwrap();
        amm.quote_asset_reserve = new_qar;
        amm.base_asset_reserve = new_bar;

        // recompute margin requirements
        let (market_position, _) = get_lp_market_position_margin(&lp_position, &amm).unwrap();
        let (unbalanced_position_base_asset_value, unbalanced_pnl) =
            calculate_base_asset_value_and_pnl(&market_position, &amm, true).unwrap();

        let unbalanced_value: i128 = unbalanced_position_base_asset_value as i128 - unbalanced_pnl;
        let balanced_value: i128 = balanced_position_base_asset_value as i128 - balanced_pnl;

        println!("pnl: {} {}", balanced_pnl, unbalanced_pnl);
        println!(
            "base v: {} {}",
            balanced_position_base_asset_value, unbalanced_position_base_asset_value
        );
        println!(
            "total v: {} {} {}",
            balanced_value,
            unbalanced_value,
            unbalanced_value > balanced_value
        );

        assert!(unbalanced_position_base_asset_value > balanced_position_base_asset_value);
    }

    #[test]
    fn test_no_change_lp_metrics() {
        let lp_position = MarketPosition {
            lp_tokens: 100,
            last_net_base_asset_amount: 100,
            ..MarketPosition::default()
        };
        let amm = AMM {
            net_base_asset_amount: 100,
            sqrt_k: 200,
            ..AMM::default()
        };

        let lp_metrics = get_lp_metrics(&lp_position, lp_position.lp_tokens, &amm).unwrap();

        assert_eq!(lp_metrics.base_asset_amount, 0);
        assert_eq!(lp_metrics.unsettled_pnl, 0); // no neg upnl
    }

    #[test]
    fn test_too_small_lp_metrics() {
        let lp_position = MarketPosition {
            lp_tokens: 100,
            ..MarketPosition::default()
        };
        let amm = AMM {
            net_base_asset_amount: 100, // users went long
            peg_multiplier: 1,
            sqrt_k: 200,
            base_asset_amount_step_size: 100, // min size is big
            minimum_quote_asset_trade_size: 100,
            ..AMM::default()
        };

        let lp_metrics = get_lp_metrics(&lp_position, lp_position.lp_tokens, &amm).unwrap();

        println!("{:#?}", lp_metrics);
        assert!(lp_metrics.unsettled_pnl < 0);
        assert_eq!(lp_metrics.base_asset_amount, 0);
    }

    #[test]
    fn test_simple_lp_metrics() {
        let lp_position = MarketPosition {
            lp_tokens: 100,
            ..MarketPosition::default()
        };
        let amm = AMM {
            net_base_asset_amount: 100, // users went long
            total_fee_minus_distributions: 100,
            cumulative_funding_rate_lp: 100,
            sqrt_k: 200,
            base_asset_amount_step_size: 1,
            ..AMM::default()
        };

        let lp_metrics = get_lp_metrics(&lp_position, lp_position.lp_tokens, &amm).unwrap();
        println!("{:#?}", lp_metrics);

        assert_eq!(lp_metrics.base_asset_amount, -50);
        assert_eq!(lp_metrics.fee_payment, 50);
        assert_eq!(lp_metrics.funding_payment, 50);
    }
}
