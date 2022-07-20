use crate::controller::amm::SwapDirection;
use crate::controller::position::update_position_and_market;
use crate::controller::position::PositionDelta;
use crate::error::ClearingHouseResult;
use crate::math::amm::calculate_swap_output;
use crate::math::casting::cast_to_i128;
use crate::math::constants::{AMM_RESERVE_PRECISION, AMM_RESERVE_PRECISION_I128};
use crate::math::quote_asset::reserve_to_asset_amount;
use crate::math_error;
use crate::state::market::Market;
use crate::state::market::AMM;
use crate::state::user::MarketPosition;

use solana_program::msg;

#[derive(Debug)]
pub struct LPMetrics {
    pub fee_payment: u128,
    pub funding_payment: i128,
    pub unsettled_pnl: i128,
    pub base_asset_amount: i128,
    pub quote_asset_amount: u128,
}

pub fn get_lp_metrics(position: &MarketPosition, amm: &AMM) -> ClearingHouseResult<LPMetrics> {
    let total_lp_shares = amm.sqrt_k;
    let n_shares = position.lp_shares;
    let n_shares_i128 = cast_to_i128(n_shares)?;
    let total_lp_shares_i128 = cast_to_i128(total_lp_shares)?;

    // give them fees
    assert!(amm.cumulative_fee_per_lp >= position.last_cumulative_fee_per_lp);
    let fee_payment = amm
        .cumulative_fee_per_lp
        .checked_sub(position.last_cumulative_fee_per_lp)
        .ok_or_else(math_error!())?
        .checked_mul(n_shares)
        .ok_or_else(math_error!())?
        .checked_div(AMM_RESERVE_PRECISION)
        .ok_or_else(math_error!())?;

    // give them the funding
    let funding_payment = amm
        .cumulative_funding_payment_per_lp
        .checked_sub(position.last_cumulative_funding_payment_per_lp)
        .ok_or_else(math_error!())?
        .checked_mul(n_shares_i128)
        .ok_or_else(math_error!())?
        .checked_div(AMM_RESERVE_PRECISION_I128)
        .ok_or_else(math_error!())?;

    // give them slice of the damm market position
    let amm_net_base_asset_amount_per_lp = position
        .last_cumulative_net_base_asset_amount_per_lp
        .checked_sub(amm.cumulative_net_base_asset_amount_per_lp)
        .ok_or_else(math_error!())?;

    let mut market_base_asset_amount = 0;
    let mut market_quote_asset_amount = 0;
    let mut unsettled_pnl = 0;

    if amm_net_base_asset_amount_per_lp != 0 {
        let base_asset_amount = amm_net_base_asset_amount_per_lp
            .checked_mul(n_shares_i128)
            .ok_or_else(math_error!())?
            .checked_div(AMM_RESERVE_PRECISION_I128)
            .ok_or_else(math_error!())?;

        let total_net_base_asset_amount_lp = amm_net_base_asset_amount_per_lp
            .checked_mul(total_lp_shares_i128)
            .ok_or_else(math_error!())?
            .checked_div(AMM_RESERVE_PRECISION_I128)
            .ok_or_else(math_error!())?;

        let net_quote_reserves_lp =
            calculate_swap_quote_reserve_delta(amm, total_net_base_asset_amount_lp)?;

        let quote_asset_reserve_amount = net_quote_reserves_lp
            .checked_mul(AMM_RESERVE_PRECISION)
            .ok_or_else(math_error!())?
            .checked_div(total_lp_shares)
            .ok_or_else(math_error!())?
            .checked_mul(n_shares)
            .ok_or_else(math_error!())?
            .checked_div(AMM_RESERVE_PRECISION)
            .ok_or_else(math_error!())?;

        let quote_asset_amount =
            reserve_to_asset_amount(quote_asset_reserve_amount, amm.peg_multiplier)?;

        let min_qaa = amm.minimum_quote_asset_trade_size;
        let min_baa = amm.base_asset_amount_step_size;

        if base_asset_amount.unsigned_abs() >= min_baa && quote_asset_amount >= min_qaa {
            market_quote_asset_amount = quote_asset_amount;
            market_base_asset_amount = base_asset_amount;
        } else {
            msg!(
                "Warning: lp market position too small: {} {} :: {} {}",
                base_asset_amount,
                min_baa,
                quote_asset_amount,
                min_qaa
            );

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
    msg!("lp metrics: {:#?}", lp_metrics);

    Ok(lp_metrics)
}

pub fn abs_difference(a: u128, b: u128) -> ClearingHouseResult<u128> {
    if a > b {
        a.checked_sub(b).ok_or_else(math_error!())
    } else {
        b.checked_sub(a).ok_or_else(math_error!())
    }
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

    let quote_asset_reserve_output =
        abs_difference(new_quote_asset_reserve, amm.quote_asset_reserve)?;

    Ok(quote_asset_reserve_output)
}

pub fn get_lp_market_position_margin(
    position: &MarketPosition,
    market: &Market,
) -> ClearingHouseResult<MarketPosition> {
    let amm = &market.amm;

    // clone bc its only temporary
    let mut market_position = *position;

    let lp_metrics = get_lp_metrics(&market_position, amm)?;

    let total_lp_shares = amm.sqrt_k;
    let lp_shares = position.lp_shares;

    // update pnl payments
    market_position.unsettled_pnl = position
        .unsettled_pnl
        .checked_add(cast_to_i128(lp_metrics.fee_payment)?)
        .ok_or_else(math_error!())?
        .checked_add(lp_metrics.funding_payment)
        .ok_or_else(math_error!())?;

    // update the virtual position from the settle
    // TODO: probably want to refactor so we dont have to clone the market

    let mut market_clone = *market;
    if lp_metrics.base_asset_amount != 0 {
        let position_delta = PositionDelta {
            base_asset_amount: lp_metrics.base_asset_amount,
            quote_asset_amount: lp_metrics.quote_asset_amount,
        };
        let pnl = update_position_and_market(
            &mut market_position,
            &mut market_clone,
            &position_delta,
            true,
        )?;
        market_position.unsettled_pnl = market_position
            .unsettled_pnl
            .checked_add(pnl)
            .ok_or_else(math_error!())?;
    }

    // worse case market position
    // max ask: (sqrtk*1.4142 - base asset reserves) * lp share
    // max bid: (base asset reserves - sqrtk/1.4142) * lp share

    // TODO: is there a cleaner way to do this? -- maybe make it a constant?
    // TODO: 14142 with percision of 10_000
    let percision: f64 = 10_000_000_000_000.0; // amm percision as float
    let sqrt_2 = (2_f64.sqrt() * percision).round() as u128;

    // worse case if all asks are filled
    let ask_bounded_k = amm
        .sqrt_k
        .checked_mul(sqrt_2)
        .ok_or_else(math_error!())?
        .checked_div(AMM_RESERVE_PRECISION)
        .ok_or_else(math_error!())?;

    let max_asks = ask_bounded_k
        .checked_sub(amm.base_asset_reserve)
        .ok_or_else(math_error!())?;

    let open_asks = cast_to_i128(get_proportion_u128(max_asks, lp_shares, total_lp_shares)?)?;

    // worse case if all bids are filled (lp is now long)
    let bids_bounded_k = amm
        .sqrt_k
        .checked_mul(AMM_RESERVE_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(sqrt_2)
        .ok_or_else(math_error!())?;

    let max_bids = amm
        .base_asset_reserve
        .checked_sub(bids_bounded_k)
        .ok_or_else(math_error!())?;

    let open_bids = cast_to_i128(get_proportion_u128(max_bids, lp_shares, total_lp_shares)?)?;

    market_position.open_bids = market_position
        .open_bids
        .checked_add(open_bids)
        .ok_or_else(math_error!())?;
    market_position.open_asks = market_position
        .open_asks
        .checked_add(open_asks)
        .ok_or_else(math_error!())?;

    Ok(market_position)
}

// TODO: change to macro to support value=u128, U192, etc. without casting?
pub fn get_proportion_i128(
    value: i128,
    numerator: u128,
    denominator: u128,
) -> ClearingHouseResult<i128> {
    let proportional_value = cast_to_i128(
        value
            .unsigned_abs()
            .checked_mul(numerator)
            .ok_or_else(math_error!())?
            .checked_div(denominator)
            .ok_or_else(math_error!())?,
    )?
    .checked_mul(value.signum())
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

// #[cfg(test)]
// mod test {
//     use super::*;
//     use crate::math::position::calculate_base_asset_value_and_pnl;
//
//     #[test]
//     fn test_margin_requirements_user_short() {
//         let position = MarketPosition {
//             lp_shares: 10 * AMM_RESERVE_PRECISION,
//             ..MarketPosition::default()
//         };
//
//         // 500_000 * 1e13
//         let init_reserves: u128 = 5000000000000000000;
//         let mut amm = AMM {
//             // balanced market
//             base_asset_reserve: init_reserves,
//             quote_asset_reserve: init_reserves,
//             sqrt_k: init_reserves,
//             peg_multiplier: 53000,
//             ..AMM::default()
//         };
//
//         let (market_position, _) = get_lp_market_position_margin(&position, &amm).unwrap();
//         let (balanced_position_base_asset_value, balanced_pnl) =
//             calculate_base_asset_value_and_pnl(&market_position, &amm, true).unwrap();
//
//         // make the market unbalanced
//         // note we gotta short a lot more bc theres more risk to lps going short than long
//         let trade_size = 200_000 * AMM_RESERVE_PRECISION;
//         let (new_qar, new_bar) = calculate_swap_output(
//             trade_size,
//             amm.base_asset_reserve,
//             SwapDirection::Add, // user shorts
//             amm.sqrt_k,
//         )
//         .unwrap();
//         amm.quote_asset_reserve = new_qar;
//         amm.base_asset_reserve = new_bar;
//
//         // recompute margin requirements
//         let (market_position, _) = get_lp_market_position_margin(&position, &amm).unwrap();
//         let (unbalanced_position_base_asset_value, unbalanced_pnl) =
//             calculate_base_asset_value_and_pnl(&market_position, &amm, true).unwrap();
//
//         let unbalanced_value: i128 = unbalanced_position_base_asset_value as i128 - unbalanced_pnl;
//         let balanced_value: i128 = balanced_position_base_asset_value as i128 - balanced_pnl;
//
//         println!("pnl: {} {}", balanced_pnl, unbalanced_pnl);
//         println!(
//             "base v: {} {} {}",
//             balanced_position_base_asset_value,
//             unbalanced_position_base_asset_value,
//             balanced_position_base_asset_value < unbalanced_position_base_asset_value
//         );
//         println!(
//             "total v: {} {} {}",
//             balanced_value,
//             unbalanced_value,
//             unbalanced_value > balanced_value
//         );
//
//         // this doesnt pass regardless of trade size when the user shorts lol
//         //assert!(unbalanced_position_base_asset_value > balanced_position_base_asset_value);
//
//         // this passes
//         assert!(unbalanced_value > balanced_value);
//     }
//
//     #[test]
//     fn test_margin_requirements_user_long() {
//         let position = MarketPosition {
//             lp_shares: 50 * AMM_RESERVE_PRECISION,
//             ..MarketPosition::default()
//         };
//
//         let init_reserves: u128 = 5000000000000000000;
//         let mut amm = AMM {
//             // balanced market
//             base_asset_reserve: init_reserves,
//             quote_asset_reserve: init_reserves,
//             sqrt_k: init_reserves,
//             peg_multiplier: 53000,
//             ..AMM::default()
//         };
//
//         let (market_position, _) = get_lp_market_position_margin(&position, &amm).unwrap();
//         let (balanced_position_base_asset_value, balanced_pnl) =
//             calculate_base_asset_value_and_pnl(&market_position, &amm, true).unwrap();
//
//         // make the market unbalanced
//         let trade_size = 2_000 * AMM_RESERVE_PRECISION;
//         let (new_qar, new_bar) = calculate_swap_output(
//             trade_size,
//             amm.base_asset_reserve,
//             SwapDirection::Remove, // user longs
//             amm.sqrt_k,
//         )
//         .unwrap();
//         amm.quote_asset_reserve = new_qar;
//         amm.base_asset_reserve = new_bar;
//
//         // recompute margin requirements
//         let (market_position, _) = get_lp_market_position_margin(&position, &amm).unwrap();
//         let (unbalanced_position_base_asset_value, unbalanced_pnl) =
//             calculate_base_asset_value_and_pnl(&market_position, &amm, true).unwrap();
//
//         let unbalanced_value: i128 = unbalanced_position_base_asset_value as i128 - unbalanced_pnl;
//         let balanced_value: i128 = balanced_position_base_asset_value as i128 - balanced_pnl;
//
//         println!("pnl: {} {}", balanced_pnl, unbalanced_pnl);
//         println!(
//             "base v: {} {}",
//             balanced_position_base_asset_value, unbalanced_position_base_asset_value
//         );
//         println!(
//             "total v: {} {} {}",
//             balanced_value,
//             unbalanced_value,
//             unbalanced_value > balanced_value
//         );
//
//         assert!(unbalanced_position_base_asset_value > balanced_position_base_asset_value);
//     }
//
//     #[test]
//     fn test_no_change_lp_metrics() {
//         let position = MarketPosition {
//             lp_shares: 100,
//             last_net_base_asset_amount: 100,
//             ..MarketPosition::default()
//         };
//         let amm = AMM {
//             net_base_asset_amount: 100,
//             sqrt_k: 200,
//             ..AMM::default()
//         };
//
//         let lp_metrics = get_lp_metrics(&position, position.lp_shares, &amm).unwrap();
//
//         assert_eq!(lp_metrics.base_asset_amount, 0);
//         assert_eq!(lp_metrics.unsettled_pnl, 0); // no neg upnl
//     }
//
//     #[test]
//     fn test_too_small_lp_metrics() {
//         let position = MarketPosition {
//             lp_shares: 100,
//             ..MarketPosition::default()
//         };
//         let amm = AMM {
//             net_base_asset_amount: 100, // users went long
//             peg_multiplier: 1,
//             sqrt_k: 200,
//             base_asset_amount_step_size: 100, // min size is big
//             minimum_quote_asset_trade_size: 100,
//             ..AMM::default()
//         };
//
//         let lp_metrics = get_lp_metrics(&position, position.lp_shares, &amm).unwrap();
//
//         println!("{:#?}", lp_metrics);
//         assert!(lp_metrics.unsettled_pnl < 0);
//         assert_eq!(lp_metrics.base_asset_amount, 0);
//     }
//
//     #[test]
//     fn test_simple_lp_metrics() {
//         let position = MarketPosition {
//             lp_shares: 100,
//             ..MarketPosition::default()
//         };
//         let amm = AMM {
//             net_base_asset_amount: 100, // users went long
//             total_fee_minus_distributions: 100,
//             cumulative_funding_rate_lp: 100,
//             sqrt_k: 200,
//             base_asset_amount_step_size: 1,
//             ..AMM::default()
//         };
//
//         let lp_metrics = get_lp_metrics(&position, position.lp_shares, &amm).unwrap();
//         println!("{:#?}", lp_metrics);
//
//         assert_eq!(lp_metrics.base_asset_amount, -50);
//         assert_eq!(lp_metrics.fee_payment, 50);
//         assert_eq!(lp_metrics.funding_payment, 50);
//     }
// }
