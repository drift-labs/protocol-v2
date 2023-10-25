use std::cmp::max;

use solana_program::msg;

use crate::error::{DriftResult, ErrorCode};
use crate::math::bn;
use crate::math::casting::Cast;
use crate::math::constants::{
    AMM_TO_QUOTE_PRECISION_RATIO, AMM_TO_QUOTE_PRECISION_RATIO_I128, FUNDING_RATE_BUFFER,
    PRICE_PRECISION, QUOTE_TO_BASE_AMT_FUNDING_PRECISION,
};
use crate::math::repeg::{calculate_fee_pool, get_total_fee_lower_bound};
use crate::math::safe_math::SafeMath;

use crate::state::perp_market::PerpMarket;
use crate::state::user::PerpPosition;

#[cfg(test)]
mod tests;

/// With a virtual AMM, there can be an imbalance between longs and shorts and thus funding can be asymmetric.
/// To account for this, amm keeps track of the cumulative funding rate for both longs and shorts.
/// When there is a period with asymmetric funding, the protocol will pay/receive funding from/to it's collected fees.
pub fn calculate_funding_rate_long_short(
    market: &mut PerpMarket,
    funding_rate: i128,
) -> DriftResult<(i128, i128, i128)> {
    // Calculate the funding payment owed by the net_market_position if funding is not capped
    // If the net market position owes funding payment, the protocol receives payment
    let settled_net_market_position = market
        .amm
        .base_asset_amount_with_amm
        .safe_add(market.amm.base_asset_amount_with_unsettled_lp)?;

    let net_market_position_funding_payment =
        calculate_funding_payment_in_quote_precision(funding_rate, settled_net_market_position)?;
    let uncapped_funding_pnl = -net_market_position_funding_payment;

    // If the uncapped_funding_pnl is positive, the protocol receives money.
    if uncapped_funding_pnl >= 0 {
        market.amm.total_fee_minus_distributions = market
            .amm
            .total_fee_minus_distributions
            .safe_add(uncapped_funding_pnl)?;

        market.amm.net_revenue_since_last_funding = market
            .amm
            .net_revenue_since_last_funding
            .safe_add(uncapped_funding_pnl as i64)?;

        return Ok((funding_rate, funding_rate, uncapped_funding_pnl));
    }

    let (capped_funding_rate, capped_funding_pnl) =
        calculate_capped_funding_rate(market, uncapped_funding_pnl, funding_rate)?;

    let new_total_fee_minus_distributions = market
        .amm
        .total_fee_minus_distributions
        .safe_add(capped_funding_pnl)?;

    // protocol is paying part of funding imbalance
    if capped_funding_pnl != 0 {
        let total_fee_minus_distributions_lower_bound =
            get_total_fee_lower_bound(market)?.cast::<i128>()?;

        // makes sure the protocol doesn't pay more than the share of fees allocated to `distributions`
        if new_total_fee_minus_distributions < total_fee_minus_distributions_lower_bound {
            msg!("new_total_fee_minus_distributions={} < total_fee_minus_distributions_lower_bound={}", new_total_fee_minus_distributions, total_fee_minus_distributions_lower_bound);
            return Err(ErrorCode::InvalidFundingProfitability);
        }
    }
    market.amm.total_fee_minus_distributions = new_total_fee_minus_distributions;
    market.amm.net_revenue_since_last_funding = market
        .amm
        .net_revenue_since_last_funding
        .safe_sub(capped_funding_pnl.unsigned_abs() as i64)?;

    let funding_rate_long = if funding_rate < 0 {
        capped_funding_rate
    } else {
        funding_rate
    };

    let funding_rate_short = if funding_rate > 0 {
        capped_funding_rate
    } else {
        funding_rate
    };

    Ok((funding_rate_long, funding_rate_short, uncapped_funding_pnl))
}

fn calculate_capped_funding_rate(
    market: &PerpMarket,
    uncapped_funding_pnl: i128, // if negative, users would net receive from protocol
    funding_rate: i128,
) -> DriftResult<(i128, i128)> {
    // The funding_rate_pnl_limit is the amount of fees the protocol can use before it hits it's lower bound
    let fee_pool = calculate_fee_pool(market)?;

    // limit to 1/3 of current fee pool per funding period
    let funding_rate_pnl_limit = -fee_pool.cast::<i128>()?.safe_div(3)?;

    // if theres enough in fees, give user's uncapped funding
    // if theres a little/nothing in fees, give the user's capped outflow funding
    let capped_funding_pnl = max(uncapped_funding_pnl, funding_rate_pnl_limit);
    let capped_funding_rate = if uncapped_funding_pnl < funding_rate_pnl_limit {
        // Calculate how much funding payment is already available from users
        let funding_payment_from_users = calculate_funding_payment_in_quote_precision(
            funding_rate,
            if funding_rate > 0 {
                market.amm.base_asset_amount_long
            } else {
                market.amm.base_asset_amount_short
            },
        )?;

        // increase the funding_rate_pnl_limit by accounting for the funding payment already being made by users
        // this makes it so that the capped rate includes funding payments from users and protocol collected fees
        let funding_rate_pnl_limit =
            funding_rate_pnl_limit.safe_sub(funding_payment_from_users.abs())?;

        if funding_rate < 0 {
            // longs receive
            calculate_funding_rate_from_pnl_limit(
                funding_rate_pnl_limit,
                market.amm.base_asset_amount_long,
            )?
        } else {
            // shorts receive
            calculate_funding_rate_from_pnl_limit(
                funding_rate_pnl_limit,
                market.amm.base_asset_amount_short,
            )?
        }
    } else {
        funding_rate
    };

    Ok((capped_funding_rate, capped_funding_pnl))
}

pub fn calculate_funding_payment(
    amm_cumulative_funding_rate: i128,
    market_position: &PerpPosition,
) -> DriftResult<i64> {
    let funding_rate_delta = amm_cumulative_funding_rate
        .safe_sub(market_position.last_cumulative_funding_rate.cast()?)?;

    if funding_rate_delta == 0 {
        return Ok(0);
    }

    _calculate_funding_payment(
        funding_rate_delta,
        market_position.base_asset_amount.cast()?,
    )?
    .safe_div(AMM_TO_QUOTE_PRECISION_RATIO_I128)?
    .cast()
}

fn _calculate_funding_payment(
    funding_rate_delta: i128,
    base_asset_amount: i128,
) -> DriftResult<i128> {
    let funding_rate_delta_sign: i128 = if funding_rate_delta > 0 { 1 } else { -1 };

    let funding_rate_payment_magnitude = bn::U192::from(funding_rate_delta.unsigned_abs())
        .safe_mul(bn::U192::from(base_asset_amount.unsigned_abs()))?
        .safe_div(bn::U192::from(PRICE_PRECISION))?
        .safe_div(bn::U192::from(FUNDING_RATE_BUFFER))?
        .try_to_u128()?
        .cast::<i128>()?;

    // funding_rate: longs pay shorts
    let funding_rate_payment_sign: i128 = if base_asset_amount > 0 { -1 } else { 1 };

    let funding_rate_payment = (funding_rate_payment_magnitude)
        .safe_mul(funding_rate_payment_sign)?
        .safe_mul(funding_rate_delta_sign)?;

    Ok(funding_rate_payment)
}

fn calculate_funding_rate_from_pnl_limit(
    pnl_limit: i128,
    base_asset_amount: i128,
) -> DriftResult<i128> {
    if base_asset_amount == 0 {
        return Ok(0);
    }

    let pnl_limit_biased = if pnl_limit < 0 {
        pnl_limit.safe_add(1)?
    } else {
        pnl_limit
    };

    pnl_limit_biased
        .safe_mul(QUOTE_TO_BASE_AMT_FUNDING_PRECISION)?
        .safe_div(base_asset_amount)
}

pub fn calculate_funding_payment_in_quote_precision(
    funding_rate_delta: i128,
    base_asset_amount: i128,
) -> DriftResult<i128> {
    let funding_payment = _calculate_funding_payment(funding_rate_delta, base_asset_amount)?;
    let funding_payment_collateral =
        funding_payment.safe_div(AMM_TO_QUOTE_PRECISION_RATIO.cast::<i128>()?)?;

    Ok(funding_payment_collateral)
}
