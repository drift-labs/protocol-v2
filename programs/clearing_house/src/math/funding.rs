use crate::error::*;
use crate::math::bn;
use crate::math::constants::{
    AMM_TO_USDC_PRECISION_RATIO, FUNDING_PAYMENT_MANTISSA, MARK_PRICE_MANTISSA,
    SHARE_OF_FEES_ALLOCATED_TO_MARKET_DENOMINATOR, SHARE_OF_FEES_ALLOCATED_TO_MARKET_NUMERATOR,
    USDC_TO_BASE_AMT_FUNDING_PRECISION,
};
use crate::math_error;
use crate::state::market::Market;
use crate::state::user::MarketPosition;
use solana_program::msg;

pub fn calculate_funding_rate_long_short(
    market: &mut Market,
    funding_rate: i128,
) -> ClearingHouseResult<(i128, i128)> {
    let symmetric_funding_pnl =
        -(calculate_funding_payment_in_quote_precision(funding_rate, market.base_asset_amount)?);
    if symmetric_funding_pnl >= 0 {
        market.amm.cumulative_fee = market
            .amm
            .cumulative_fee
            .checked_add(symmetric_funding_pnl.unsigned_abs())
            .ok_or_else(math_error!())?;
        return Ok((funding_rate, funding_rate));
    }

    let (capped_funding_rate, capped_symmetric_funding_pnl) =
        calculate_capped_funding_rate(&market, symmetric_funding_pnl, funding_rate)?;

    market.amm.cumulative_fee = market
        .amm
        .cumulative_fee
        .checked_sub(capped_symmetric_funding_pnl.unsigned_abs())
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

    return Ok((funding_rate_long, funding_rate_short));
}

fn calculate_capped_funding_rate(
    market: &Market,
    symmetric_funding_pnl: i128,
    funding_rate: i128,
) -> ClearingHouseResult<(i128, i128)> {
    let cumulative_fee_lower_bound = market
        .amm
        .total_fee
        .checked_mul(SHARE_OF_FEES_ALLOCATED_TO_MARKET_NUMERATOR)
        .ok_or_else(math_error!())?
        .checked_div(SHARE_OF_FEES_ALLOCATED_TO_MARKET_DENOMINATOR)
        .ok_or_else(math_error!())?;

    let this_funding_rate_inflow = -(if funding_rate > 0 {
        calculate_funding_payment_in_quote_precision(funding_rate, market.base_asset_amount_long)
    } else {
        calculate_funding_payment_in_quote_precision(funding_rate, market.base_asset_amount_short)
    }?);

    let cumulative_fee_available = market
        .amm
        .cumulative_fee
        .checked_add(this_funding_rate_inflow.unsigned_abs())
        .ok_or_else(math_error!())?;

    let funding_rate_pnl_limit = if cumulative_fee_available > cumulative_fee_lower_bound {
        -(cumulative_fee_available
            .checked_sub(cumulative_fee_lower_bound)
            .ok_or_else(math_error!())? as i128)
    } else {
        0
    };

    // if theres enough in fees, give user's symmetric at a loss funding
    // if theres a little in fees, give the user's assymetric capped outflow funding
    // if theres nothing in fees/inflows, give user's no outflow funding
    let capped_symmetric_funding_pnl = if symmetric_funding_pnl > funding_rate_pnl_limit {
        symmetric_funding_pnl
            .checked_add(this_funding_rate_inflow.abs())
            .ok_or_else(math_error!())
    } else {
        funding_rate_pnl_limit
            .checked_add(this_funding_rate_inflow.abs())
            .ok_or_else(math_error!())
    }?;

    let this_funding_rate_outflow = if symmetric_funding_pnl < funding_rate_pnl_limit {
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

    return Ok((this_funding_rate_outflow, capped_symmetric_funding_pnl));
}

pub fn calculate_funding_payment(
    amm_cumulative_funding_rate_dir: i128,
    market_position: &MarketPosition,
) -> ClearingHouseResult<i128> {
    let funding_rate_delta = amm_cumulative_funding_rate_dir
        .checked_sub(market_position.last_cumulative_funding_rate)
        .ok_or_else(math_error!())?;

    let funding_rate_payment =
        _calculate_funding_payment(funding_rate_delta, market_position.base_asset_amount)?;

    return Ok(funding_rate_payment);
}

fn _calculate_funding_payment(
    funding_rate_delta: i128,
    base_asset_amount: i128,
) -> ClearingHouseResult<i128> {
    let funding_rate_delta_sign: i128 = if funding_rate_delta > 0 { 1 } else { -1 } as i128;

    let funding_rate_payment_mag = bn::U192::from(funding_rate_delta.unsigned_abs())
        .checked_mul(bn::U192::from(base_asset_amount.unsigned_abs()))
        .ok_or_else(math_error!())?
        .checked_div(bn::U192::from(MARK_PRICE_MANTISSA))
        .ok_or_else(math_error!())?
        .checked_div(bn::U192::from(FUNDING_PAYMENT_MANTISSA))
        .ok_or_else(math_error!())?
        .try_to_u128()? as i128;

    // funding_rate: longs pay shorts
    let funding_rate_payment_sign: i128 = if base_asset_amount > 0 { -1 } else { 1 } as i128;

    let funding_rate_payment = (funding_rate_payment_mag)
        .checked_mul(funding_rate_payment_sign)
        .ok_or_else(math_error!())?
        .checked_mul(funding_rate_delta_sign)
        .ok_or_else(math_error!())?;

    return Ok(funding_rate_payment);
}

fn calculate_funding_rate_from_pnl_limit(
    pnl_limit: i128,
    base_asset_amount_dir: i128,
) -> ClearingHouseResult<i128> {
    if base_asset_amount_dir == 0 {
        return Ok(0);
    }

    let funding_rate = pnl_limit
        .checked_add(1)
        .ok_or_else(math_error!())?
        .checked_mul(USDC_TO_BASE_AMT_FUNDING_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(base_asset_amount_dir)
        .ok_or_else(math_error!());

    return funding_rate;
}

fn calculate_funding_payment_in_quote_precision(
    funding_rate_delta: i128,
    base_asset_amount: i128,
) -> ClearingHouseResult<i128> {
    let funding_payment = _calculate_funding_payment(funding_rate_delta, base_asset_amount)?;
    let funding_payment_collateral = funding_payment
        .checked_div(AMM_TO_USDC_PRECISION_RATIO as i128)
        .ok_or_else(math_error!())?;

    return Ok(funding_payment_collateral);
}
