use crate::controller::lp::burn_lp_shares;
use crate::error::ClearingHouseResult;
use crate::math::amm::calculate_swap_output;
use crate::math::casting::cast_to_i128;
use crate::math::constants::{AMM_RESERVE_PRECISION, AMM_RESERVE_PRECISION_I128};
use crate::math::position::swap_direction_to_close_position;
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

        let total_net_base_asset_amount = amm_net_base_asset_amount_per_lp
            .checked_mul(total_lp_shares_i128)
            .ok_or_else(math_error!())?
            .checked_div(AMM_RESERVE_PRECISION_I128)
            .ok_or_else(math_error!())?;

        // close out the user positions
        let net_quote_reserves = calculate_swap_quote_reserve_delta(
            amm,
            total_net_base_asset_amount
                .checked_mul(-1)
                .ok_or_else(math_error!())?,
        )?;

        let quote_asset_reserve_amount = net_quote_reserves
            .checked_mul(n_shares)
            .ok_or_else(math_error!())?
            .checked_div(total_lp_shares)
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

    let metrics = LPMetrics {
        fee_payment,
        funding_payment,
        base_asset_amount: market_base_asset_amount,
        quote_asset_amount: market_quote_asset_amount,
        unsettled_pnl,
    };
    msg!("lp metrics: {:#?}", metrics);

    Ok(metrics)
}

pub fn calculate_swap_quote_reserve_delta(
    amm: &AMM,
    base_asset_amount: i128,
) -> ClearingHouseResult<u128> {
    let swap_direction = swap_direction_to_close_position(base_asset_amount);

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

// settle and make tradeable
pub fn get_lp_market_position_margin(
    position: &MarketPosition,
    market: &Market,
) -> ClearingHouseResult<MarketPosition> {
    // clone bc its only temporary
    let mut position_clone = *position;
    let mut market_clone = *market;

    let total_lp_shares = market.amm.sqrt_k;
    let lp_shares = position.lp_shares;

    burn_lp_shares(&mut position_clone, &mut market_clone, lp_shares)?;

    // worse case market position
    // max ask: (sqrtk*1.4142 - base asset reserves) * lp share
    // max bid: (base asset reserves - sqrtk/1.4142) * lp share

    // TODO: make this a constant?
    let sqrt_2_percision = 10_000_u128;
    let sqrt_2 = 14142;

    // worse case if all asks are filled
    let ask_bounded_k = market
        .amm
        .sqrt_k
        .checked_mul(sqrt_2)
        .ok_or_else(math_error!())?
        .checked_div(sqrt_2_percision)
        .ok_or_else(math_error!())?;

    let max_asks = ask_bounded_k
        .checked_sub(market.amm.base_asset_reserve)
        .ok_or_else(math_error!())?;

    let open_asks = cast_to_i128(get_proportion_u128(max_asks, lp_shares, total_lp_shares)?)?;

    // worst case if all bids are filled (lp is now long)
    let bids_bounded_k = market
        .amm
        .sqrt_k
        .checked_mul(sqrt_2_percision)
        .ok_or_else(math_error!())?
        .checked_div(sqrt_2)
        .ok_or_else(math_error!())?;

    let max_bids = market
        .amm
        .base_asset_reserve
        .checked_sub(bids_bounded_k)
        .ok_or_else(math_error!())?;

    let open_bids = cast_to_i128(get_proportion_u128(max_bids, lp_shares, total_lp_shares)?)?;

    position_clone.open_bids = position_clone
        .open_bids
        .checked_add(open_bids)
        .ok_or_else(math_error!())?;

    position_clone.open_asks = position_clone
        .open_asks
        .checked_add(open_asks)
        .ok_or_else(math_error!())?;

    Ok(position_clone)
}

pub fn abs_difference(a: u128, b: u128) -> ClearingHouseResult<u128> {
    if a > b {
        a.checked_sub(b).ok_or_else(math_error!())
    } else {
        b.checked_sub(a).ok_or_else(math_error!())
    }
}

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

pub fn update_lp_position(
    position: &mut MarketPosition,
    metrics: &LPMetrics,
) -> ClearingHouseResult<i128> {
    let is_new_position = position.lp_base_asset_amount == 0;
    let is_increase = (position.lp_base_asset_amount > 0 && metrics.base_asset_amount > 0)
        || (position.lp_base_asset_amount < 0 && metrics.base_asset_amount < 0);

    if is_new_position || is_increase {
        position.lp_base_asset_amount = position
            .lp_base_asset_amount
            .checked_add(metrics.base_asset_amount)
            .ok_or_else(math_error!())?;

        position.lp_quote_asset_amount = position
            .lp_quote_asset_amount
            .checked_add(metrics.quote_asset_amount)
            .ok_or_else(math_error!())?;
    } else {
        let quote_asset_amount =
            abs_difference(metrics.quote_asset_amount, position.lp_quote_asset_amount)?;

        let base_asset_amount = position
            .lp_base_asset_amount
            .checked_add(metrics.base_asset_amount)
            .ok_or_else(math_error!())?;

        position.lp_base_asset_amount = base_asset_amount;
        position.lp_quote_asset_amount = quote_asset_amount;
    }

    let upnl = cast_to_i128(metrics.fee_payment)?
        .checked_add(metrics.funding_payment)
        .ok_or_else(math_error!())?
        .checked_add(metrics.unsettled_pnl)
        .ok_or_else(math_error!())?;

    Ok(upnl)
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::controller::amm::SwapDirection;
    use crate::math::{constants::PEG_PRECISION, position::calculate_base_asset_value};

    #[test]
    fn test_margin_requirements_user_long() {
        let position = MarketPosition {
            lp_shares: 300_000 * AMM_RESERVE_PRECISION,
            ..MarketPosition::default()
        };

        // 500_000 * 1e13
        let init_reserves: u128 = 5000000000000000000;
        let amm = AMM {
            // balanced market
            base_asset_reserve: init_reserves,
            quote_asset_reserve: init_reserves,
            sqrt_k: init_reserves,
            user_lp_shares: position.lp_shares,
            peg_multiplier: 53000,
            ..AMM::default()
        };
        let mut market = Market {
            amm,
            ..Market::default()
        };

        let market_position = get_lp_market_position_margin(&position, &market).unwrap();
        let worst_case_base_asset_amount = market_position.worst_case_base_asset_amount().unwrap();
        let balanced_position_base_asset_value =
            calculate_base_asset_value(worst_case_base_asset_amount, &market.amm, false).unwrap();

        // make the market unbalanced
        let trade_size = 2_000 * AMM_RESERVE_PRECISION;
        let (new_qar, new_bar) = calculate_swap_output(
            trade_size,
            amm.base_asset_reserve,
            SwapDirection::Remove, // user longs
            amm.sqrt_k,
        )
        .unwrap();
        market.amm.quote_asset_reserve = new_qar;
        market.amm.base_asset_reserve = new_bar;
        market.amm.user_lp_shares = position.lp_shares;

        // recompute margin requirements
        let market_position = get_lp_market_position_margin(&position, &market).unwrap();
        let worst_case_base_asset_amount = market_position.worst_case_base_asset_amount().unwrap();
        let unbalanced_position_base_asset_value =
            calculate_base_asset_value(worst_case_base_asset_amount, &market.amm, false).unwrap();

        println!(
            "base v: {} {}",
            balanced_position_base_asset_value, unbalanced_position_base_asset_value,
        );

        assert!(unbalanced_position_base_asset_value > balanced_position_base_asset_value);
    }

    // unsure how to write this - the margin risk of the shorts are always larger than the
    // amount of longs even if longs >> shorts
    // #[test]
    // fn test_margin_requirements_user_short() {
    //     let position = MarketPosition {
    //         lp_shares: 300_000 * AMM_RESERVE_PRECISION,
    //         ..MarketPosition::default()
    //     };

    //     // 500_000 * 1e13
    //     let init_reserves: u128 = 5000000000000000000;
    //     let amm = AMM {
    //         // balanced market
    //         base_asset_reserve: init_reserves,
    //         quote_asset_reserve: init_reserves,
    //         sqrt_k: init_reserves,
    //         peg_multiplier: 53000,
    //         ..AMM::default()
    //     };
    //     let mut market = Market {
    //         amm,
    //         ..Market::default()
    //     };

    //     let market_position= get_lp_market_position_margin(&position, &market).unwrap();
    //     let worst_case_base_asset_amount = market_position.worst_case_base_asset_amount().unwrap();
    //     let balanced_position_base_asset_value =
    //         calculate_base_asset_value(worst_case_base_asset_amount, &market.amm, false).unwrap();

    //     // make the market unbalanced
    //     // note we gotta short a lot more bc theres more risk to lps going short than long
    //     let trade_size = 200_000 * AMM_RESERVE_PRECISION;
    //     let (new_qar, new_bar) = calculate_swap_output(
    //         trade_size,
    //         amm.base_asset_reserve,
    //         SwapDirection::Add, // user shorts
    //         amm.sqrt_k,
    //     )
    //     .unwrap();
    //     market.amm.quote_asset_reserve = new_qar;
    //     market.amm.base_asset_reserve = new_bar;

    //     // recompute margin requirements
    //     let market_position= get_lp_market_position_margin(&position, &market).unwrap();
    //     let worst_case_base_asset_amount = market_position.worst_case_base_asset_amount().unwrap();
    //     let unbalanced_position_base_asset_value =
    //         calculate_base_asset_value(worst_case_base_asset_amount, &market.amm, false).unwrap();

    //     println!(
    //         "base v: {} {}",
    //         balanced_position_base_asset_value,
    //         unbalanced_position_base_asset_value,
    //     );
    //     assert!(unbalanced_position_base_asset_value > balanced_position_base_asset_value);
    // }

    #[test]
    fn test_no_change_metrics() {
        let position = MarketPosition {
            lp_shares: 100,
            last_cumulative_net_base_asset_amount_per_lp: 100,
            ..MarketPosition::default()
        };
        let amm = AMM {
            cumulative_net_base_asset_amount_per_lp: 100,
            sqrt_k: 200,
            ..AMM::default()
        };

        let metrics = get_lp_metrics(&position, &amm).unwrap();

        assert_eq!(metrics.base_asset_amount, 0);
        assert_eq!(metrics.unsettled_pnl, 0); // no neg upnl
    }

    #[test]
    fn test_too_small_metrics() {
        let position = MarketPosition {
            lp_shares: 100 * AMM_RESERVE_PRECISION,
            last_cumulative_net_base_asset_amount_per_lp: 70 * AMM_RESERVE_PRECISION_I128,
            ..MarketPosition::default()
        };

        let amm = AMM {
            cumulative_net_base_asset_amount_per_lp: 100 * AMM_RESERVE_PRECISION_I128,
            net_base_asset_amount: 100 * AMM_RESERVE_PRECISION_I128, // users went long
            peg_multiplier: 1,
            sqrt_k: 900 * AMM_RESERVE_PRECISION,
            base_asset_amount_step_size: 100 * AMM_RESERVE_PRECISION, // min size is big
            minimum_quote_asset_trade_size: 100 * AMM_RESERVE_PRECISION,
            ..AMM::default()
        };

        let metrics = get_lp_metrics(&position, &amm).unwrap();

        println!("{:#?}", metrics);
        assert!(metrics.unsettled_pnl < 0);
        assert_eq!(metrics.base_asset_amount, 0);
    }

    #[test]
    fn test_simple_metrics() {
        let position = MarketPosition {
            lp_shares: 1000 * AMM_RESERVE_PRECISION,
            ..MarketPosition::default()
        };
        let init_reserves = 2000 * AMM_RESERVE_PRECISION;
        let amm = AMM {
            cumulative_net_base_asset_amount_per_lp: 100 * AMM_RESERVE_PRECISION_I128,
            cumulative_fee_per_lp: 100,
            cumulative_funding_payment_per_lp: 100,

            sqrt_k: init_reserves,
            base_asset_reserve: init_reserves,
            quote_asset_reserve: init_reserves,
            peg_multiplier: PEG_PRECISION,
            base_asset_amount_step_size: 1,
            minimum_quote_asset_trade_size: 1,
            ..AMM::default()
        };

        let metrics = get_lp_metrics(&position, &amm).unwrap();
        println!("{:#?}", metrics);

        let shares_ = position.lp_shares as i128 / AMM_RESERVE_PRECISION_I128;
        assert_eq!(
            metrics.base_asset_amount,
            -100_i128 * position.lp_shares as i128
        );
        assert_eq!(
            metrics.fee_payment,
            amm.cumulative_fee_per_lp * shares_ as u128
        );
        assert_eq!(
            metrics.funding_payment,
            amm.cumulative_funding_payment_per_lp * shares_
        );
    }
}
