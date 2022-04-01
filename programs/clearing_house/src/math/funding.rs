use crate::error::*;
use crate::math::bn;
use crate::math::casting::cast_to_i128;
use crate::math::constants::{
    AMM_TO_QUOTE_PRECISION_RATIO, FUNDING_PAYMENT_PRECISION, MARK_PRICE_PRECISION,
    QUOTE_TO_BASE_AMT_FUNDING_PRECISION,
};
use crate::math::repeg::total_fee_lower_bound;
use crate::math_error;
use crate::state::market::Market;
use crate::state::user::MarketPosition;
use solana_program::msg;
use std::cmp::max;

/// With a virtual AMM, there can be an imbalance between longs and shorts and thus funding can be asymmetric.
/// To account for this, amm keeps track of the cumulative funding rate for both longs and shorts.
/// When there is a period with asymmetric funding, the clearing house will pay/receive funding from/to it's collected fees.
pub fn calculate_funding_rate_long_short(
    market: &mut Market,
    funding_rate: i128,
) -> ClearingHouseResult<(i128, i128)> {
    // Calculate the funding payment owed by the net_market_position if funding is not capped
    // If the net market position owes funding payment, the clearing house receives payment
    let net_market_position = market.base_asset_amount;
    let net_market_position_funding_payment =
        calculate_funding_payment_in_quote_precision(funding_rate, net_market_position)?;
    let uncapped_funding_pnl = -net_market_position_funding_payment;

    // If the uncapped_funding_pnl is positive, the clearing house receives money.
    if uncapped_funding_pnl >= 0 {
        market.amm.total_fee_minus_distributions = market
            .amm
            .total_fee_minus_distributions
            .checked_add(uncapped_funding_pnl.unsigned_abs())
            .ok_or_else(math_error!())?;
        market.amm.net_revenue_since_last_funding = market
            .amm
            .net_revenue_since_last_funding
            .checked_add(uncapped_funding_pnl as i64)
            .ok_or_else(math_error!())?;
        return Ok((funding_rate, funding_rate));
    }

    let (capped_funding_rate, capped_funding_pnl) =
        calculate_capped_funding_rate(market, uncapped_funding_pnl, funding_rate)?;

    let new_total_fee_minus_distributions = market
        .amm
        .total_fee_minus_distributions
        .checked_sub(capped_funding_pnl.unsigned_abs())
        .ok_or_else(math_error!())?;

    // clearing house is paying part of funding imbalance
    if capped_funding_pnl != 0 {
        let total_fee_minus_distributions_lower_bound = total_fee_lower_bound(market)?;

        // makes sure the clearing house doesn't pay more than the share of fees allocated to `distributions`
        if new_total_fee_minus_distributions < total_fee_minus_distributions_lower_bound {
            return Err(ErrorCode::InvalidFundingProfitability);
        }
    }

    market.amm.total_fee_minus_distributions = new_total_fee_minus_distributions;
    market.amm.net_revenue_since_last_funding = market
        .amm
        .net_revenue_since_last_funding
        .checked_add(uncapped_funding_pnl as i64)
        .ok_or_else(math_error!())?;

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

    Ok((funding_rate_long, funding_rate_short))
}

fn calculate_capped_funding_rate(
    market: &Market,
    uncapped_funding_pnl: i128, // if negative, users would net recieve from clearinghouse
    funding_rate: i128,
) -> ClearingHouseResult<(i128, i128)> {
    // The funding_rate_pnl_limit is the amount of fees the clearing house can use before it hits it's lower bound
    let total_fee_minus_distributions_lower_bound = total_fee_lower_bound(market)?;
    let funding_rate_pnl_limit =
        if market.amm.total_fee_minus_distributions > total_fee_minus_distributions_lower_bound {
            -cast_to_i128(
                (market
                    .amm
                    .total_fee_minus_distributions
                    .checked_sub(total_fee_minus_distributions_lower_bound)
                    .ok_or_else(math_error!())?)
                .checked_mul(2)
                .ok_or_else(math_error!())?
                .checked_div(3)
                .ok_or_else(math_error!())?,
            )?
        } else {
            0
        };

    // if theres enough in fees, give user's uncapped funding
    // if theres a little/nothing in fees, give the user's capped outflow funding
    let capped_funding_pnl = max(uncapped_funding_pnl, funding_rate_pnl_limit);
    let capped_funding_rate = if uncapped_funding_pnl < funding_rate_pnl_limit {
        // Calculate how much funding payment is already available from users
        let funding_payment_from_users = if funding_rate > 0 {
            calculate_funding_payment_in_quote_precision(
                funding_rate,
                market.base_asset_amount_long,
            )
        } else {
            calculate_funding_payment_in_quote_precision(
                funding_rate,
                market.base_asset_amount_short,
            )
        }?;

        // increase the funding_rate_pnl_limit by accounting for the funding payment already being made by users
        // this makes it so that the capped rate includes funding payments from users and clearing house collected fees
        let funding_rate_pnl_limit = funding_rate_pnl_limit
            .checked_sub(funding_payment_from_users.abs())
            .ok_or_else(math_error!())?;

        if funding_rate < 0 {
            // longs receive
            calculate_funding_rate_from_pnl_limit(
                funding_rate_pnl_limit,
                market.base_asset_amount_long,
            )?
        } else {
            // shorts receive
            calculate_funding_rate_from_pnl_limit(
                funding_rate_pnl_limit,
                market.base_asset_amount_short,
            )?
        }
    } else {
        funding_rate
    };

    Ok((capped_funding_rate, capped_funding_pnl))
}

pub fn calculate_funding_payment(
    amm_cumulative_funding_rate: i128,
    market_position: &MarketPosition,
) -> ClearingHouseResult<i128> {
    let funding_rate_delta = amm_cumulative_funding_rate
        .checked_sub(market_position.last_cumulative_funding_rate)
        .ok_or_else(math_error!())?;

    let funding_rate_payment =
        _calculate_funding_payment(funding_rate_delta, market_position.base_asset_amount)?;

    Ok(funding_rate_payment)
}

fn _calculate_funding_payment(
    funding_rate_delta: i128,
    base_asset_amount: i128,
) -> ClearingHouseResult<i128> {
    let funding_rate_delta_sign: i128 = if funding_rate_delta > 0 { 1 } else { -1 };

    let funding_rate_payment_magnitude = cast_to_i128(
        bn::U192::from(funding_rate_delta.unsigned_abs())
            .checked_mul(bn::U192::from(base_asset_amount.unsigned_abs()))
            .ok_or_else(math_error!())?
            .checked_div(bn::U192::from(MARK_PRICE_PRECISION))
            .ok_or_else(math_error!())?
            .checked_div(bn::U192::from(FUNDING_PAYMENT_PRECISION))
            .ok_or_else(math_error!())?
            .try_to_u128()?,
    )?;

    // funding_rate: longs pay shorts
    let funding_rate_payment_sign: i128 = if base_asset_amount > 0 { -1 } else { 1 };

    let funding_rate_payment = (funding_rate_payment_magnitude)
        .checked_mul(funding_rate_payment_sign)
        .ok_or_else(math_error!())?
        .checked_mul(funding_rate_delta_sign)
        .ok_or_else(math_error!())?;

    Ok(funding_rate_payment)
}

fn calculate_funding_rate_from_pnl_limit(
    pnl_limit: i128,
    base_asset_amount: i128,
) -> ClearingHouseResult<i128> {
    if base_asset_amount == 0 {
        return Ok(0);
    }

    let pnl_limit_biased = if pnl_limit < 0 {
        pnl_limit.checked_add(1).ok_or_else(math_error!())?
    } else {
        pnl_limit
    };

    pnl_limit_biased
        .checked_mul(QUOTE_TO_BASE_AMT_FUNDING_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(base_asset_amount)
        .ok_or_else(math_error!())
}

fn calculate_funding_payment_in_quote_precision(
    funding_rate_delta: i128,
    base_asset_amount: i128,
) -> ClearingHouseResult<i128> {
    let funding_payment = _calculate_funding_payment(funding_rate_delta, base_asset_amount)?;
    let funding_payment_collateral = funding_payment
        .checked_div(cast_to_i128(AMM_TO_QUOTE_PRECISION_RATIO)?)
        .ok_or_else(math_error!())?;

    Ok(funding_payment_collateral)
}
