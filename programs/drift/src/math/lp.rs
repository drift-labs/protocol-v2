use crate::error::{DriftResult, ErrorCode};
use crate::validate;
use solana_program::msg;

use crate::math::amm::calculate_market_open_bids_asks;
use crate::math::casting::Cast;
use crate::math::constants::AMM_RESERVE_PRECISION_I128;
use crate::math::helpers;
use crate::math::orders::standardize_base_asset_amount_with_remainder_i128;
use crate::math::safe_math::SafeMath;

use crate::state::perp_market::PerpMarket;
use crate::state::perp_market::AMM;
use crate::state::user::PerpPosition;

#[cfg(test)]
mod tests;

#[derive(Debug)]
pub struct LPMetrics {
    pub base_asset_amount: i128,
    pub quote_asset_amount: i128,
    pub remainder_base_asset_amount: i128,
}

pub fn calculate_settle_lp_metrics(amm: &AMM, position: &PerpPosition) -> DriftResult<LPMetrics> {
    let (base_asset_amount, quote_asset_amount) = calculate_settled_lp_base_quote(amm, position)?;

    // stepsize it
    let (standardized_base_asset_amount, remainder_base_asset_amount) =
        standardize_base_asset_amount_with_remainder_i128(
            base_asset_amount,
            amm.order_step_size.cast()?,
        )?;

    let lp_metrics = LPMetrics {
        base_asset_amount: standardized_base_asset_amount,
        quote_asset_amount,
        remainder_base_asset_amount: remainder_base_asset_amount.cast()?,
    };

    Ok(lp_metrics)
}

pub fn calculate_settled_lp_base_quote(
    amm: &AMM,
    position: &PerpPosition,
) -> DriftResult<(i128, i128)> {
    let mut n_shares = position.lp_shares;
    let mut base_unit = AMM_RESERVE_PRECISION_I128;

    validate!(
        amm.per_lp_base == position.per_lp_base,
        ErrorCode::InvalidPerpPositionDetected,
        "calculate_settled_lp_base_quote :: position/market per_lp_base unequal {} != {}",
        position.per_lp_base,
        amm.per_lp_base
    )?;

    if position.per_lp_base != 0 {
        if position.per_lp_base > 0 {
            let rebase_divisor = 10_u64.pow(position.per_lp_base.cast()?);
            base_unit = base_unit.safe_mul(rebase_divisor.cast()?)?;
            msg!("base_unit inc");
        } else {
            let rebase_divisor = 10_u64.pow(position.per_lp_base.abs().cast()?);
            n_shares = n_shares.safe_mul(rebase_divisor)?;
            msg!("n_shares inc");
        }
    }

    let n_shares_i128 = n_shares.cast::<i128>()?;

    // give them slice of the damm market position
    let amm_net_base_asset_amount_per_lp = amm
        .base_asset_amount_per_lp
        .safe_sub(position.last_base_asset_amount_per_lp.cast()?)?;

    let base_asset_amount = amm_net_base_asset_amount_per_lp
        .cast::<i128>()?
        .safe_mul(n_shares_i128)?
        .safe_div(base_unit)?;

    crate::dlog!(
        position.per_lp_base,
        base_asset_amount,
        amm_net_base_asset_amount_per_lp,
        n_shares_i128,
        base_unit
    );

    let amm_net_quote_asset_amount_per_lp = amm
        .quote_asset_amount_per_lp
        .safe_sub(position.last_quote_asset_amount_per_lp.cast()?)?;

    let quote_asset_amount = amm_net_quote_asset_amount_per_lp
        .cast::<i128>()?
        .safe_mul(n_shares_i128)?
        .safe_div(base_unit)?;

    Ok((base_asset_amount, quote_asset_amount))
}

pub fn calculate_lp_open_bids_asks(
    market_position: &PerpPosition,
    market: &PerpMarket,
) -> DriftResult<(i64, i64)> {
    let total_lp_shares = market.amm.sqrt_k;
    let lp_shares = market_position.lp_shares;

    let (max_bids, max_asks) = calculate_market_open_bids_asks(&market.amm)?;
    let open_asks = helpers::get_proportion_i128(max_asks, lp_shares.cast()?, total_lp_shares)?;
    let open_bids = helpers::get_proportion_i128(max_bids, lp_shares.cast()?, total_lp_shares)?;

    Ok((open_bids.cast()?, open_asks.cast()?))
}
