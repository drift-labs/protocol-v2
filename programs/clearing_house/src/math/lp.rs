use crate::error::ClearingHouseResult;
use crate::math::casting::{cast_to_i128, cast_to_u128};
use crate::math_error;
use crate::state::market::{self, AMM};
use crate::state::user::MarketPosition;
use solana_program::msg;

use crate::controller::amm::SwapDirection;
use crate::math::amm::calculate_swap_output;
use crate::math::constants::{AMM_TO_QUOTE_PRECISION_RATIO, PEG_PRECISION};
use crate::math::quote_asset::reserve_to_asset_amount;
use std::cmp::max;

#[derive(PartialEq, Eq)]
pub enum SettleResult {
    RecievedMarketPosition,
    DidNotRecieveMarketPosition,
}

pub struct LPMetrics {
    pub fee_payment: i128,
    pub funding_payment: i128,
    pub base_asset_amount: i128,
    pub quote_asset_amount: u128,
    pub settle_result: SettleResult,
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
    let fee_payment = get_proportion(fee_delta, lp_tokens_to_settle, total_lp_tokens)?;

    // give them the funding
    let funding_delta = amm
        .cumulative_funding_rate_lp
        .checked_sub(lp_position.last_cumulative_funding_rate)
        .ok_or_else(math_error!())?;
    let funding_payment = get_proportion(funding_delta, lp_tokens_to_settle, total_lp_tokens)?;

    // give them slice of the damm market position
    let net_base_asset_amount_delta = lp_position
        .last_net_base_asset_amount
        .checked_sub(amm.net_base_asset_amount)
        .ok_or_else(math_error!())?;

    let mut market_base_asset_amount = 0;
    let mut market_quote_asset_amount = 0;
    let mut settle_result = SettleResult::RecievedMarketPosition;

    if net_base_asset_amount_delta != 0 {
        let base_asset_amount = get_proportion(
            net_base_asset_amount_delta,
            lp_tokens_to_settle,
            total_lp_tokens,
        )?;

        let swap_direction = match net_base_asset_amount_delta > 0 {
            true => SwapDirection::Remove,
            false => SwapDirection::Add,
        };

        let (new_quote_asset_reserve, _) = calculate_swap_output(
            net_base_asset_amount_delta.unsigned_abs(),
            amm.base_asset_reserve,
            swap_direction,
            amm.sqrt_k,
        )?;

        // avoid overflow - note: sign doesnt matter
        let net_quote_asset_amount_delta = if new_quote_asset_reserve > amm.quote_asset_reserve {
            new_quote_asset_reserve
                .checked_sub(amm.quote_asset_reserve)
                .ok_or_else(math_error!())?
        } else {
            amm.quote_asset_reserve
                .checked_sub(new_quote_asset_reserve)
                .ok_or_else(math_error!())?
        };

        // when qar delta is very small => converting to quote precision
        // results in zero -- user position will have non-zero base with zero quote
        let quote_asset_amount = reserve_to_asset_amount(
            cast_to_u128(get_proportion(
                cast_to_i128(net_quote_asset_amount_delta)?,
                lp_tokens_to_settle,
                total_lp_tokens,
            )?)?,
            amm.peg_multiplier,
        )?;

        let min_qaa = amm.minimum_quote_asset_trade_size;
        let min_baa = amm.minimum_base_asset_trade_size;

        if base_asset_amount.unsigned_abs() >= min_baa && quote_asset_amount >= min_qaa {
            market_quote_asset_amount = quote_asset_amount;
            market_base_asset_amount = base_asset_amount;
        } else {
            // dont let them burn tokens
            settle_result = SettleResult::DidNotRecieveMarketPosition;
        }
    }

    let lp_metrics = LPMetrics {
        fee_payment,
        funding_payment,
        base_asset_amount: market_base_asset_amount,
        quote_asset_amount: market_quote_asset_amount,
        settle_result,
    };

    Ok(lp_metrics)
}

pub fn get_lp_market_position_margin(
    lp_position: &MarketPosition,
    lp_tokens_to_settle: u128,
    amm: &AMM,
) -> ClearingHouseResult<MarketPosition> {
    if lp_position.lp_tokens != lp_tokens_to_settle {
        panic!("not implemented yet...");
    }

    // clone bc its only temporary
    let mut market_position = *lp_position;

    if lp_tokens_to_settle == 0 {
        return Ok(market_position);
    }

    let lp_metrics = get_lp_metrics(&market_position, lp_tokens_to_settle, amm)?;

    // update pnl payments
    market_position.unsettled_pnl = lp_position
        .unsettled_pnl
        .checked_add(lp_metrics.fee_payment)
        .ok_or_else(math_error!())?
        .checked_add(lp_metrics.funding_payment)
        .ok_or_else(math_error!())?;

    // give market position if size is large enough
    // otherwise reduce upnl by 1 to account for small position loss
    if lp_metrics.settle_result == SettleResult::RecievedMarketPosition {
        market_position.base_asset_amount = market_position
            .base_asset_amount
            .checked_add(lp_metrics.base_asset_amount)
            .ok_or_else(math_error!())?;
        market_position.quote_asset_amount = market_position
            .quote_asset_amount
            .checked_add(lp_metrics.quote_asset_amount)
            .ok_or_else(math_error!())?;
    } else {
        market_position.unsettled_pnl = market_position
            .unsettled_pnl
            .checked_sub(1)
            .ok_or_else(math_error!())?;
    }

    // add additional lp margin requirements
    let lp_margin_req = max(
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
    market_position.unsettled_pnl = market_position
        .unsettled_pnl
        .checked_sub(cast_to_i128(lp_margin_req)?)
        .ok_or_else(math_error!())?;

    Ok(market_position)
}

pub fn get_proportion(
    value: i128,
    numerator: u128,
    denominator: u128,
) -> ClearingHouseResult<i128> {
    let _sign: i128 = if value > 0 { 1 } else { -1 };
    let proportional_value = cast_to_i128(
        value
            .unsigned_abs()
            .checked_mul(numerator)
            .ok_or_else(math_error!())?
            .checked_div(denominator)
            .ok_or_else(math_error!())?,
    )?
    .checked_mul(_sign)
    .ok_or_else(math_error!())?;
    Ok(proportional_value)
}
