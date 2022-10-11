use solana_program::msg;

use crate::error::ClearingHouseResult;
use crate::math::amm::calculate_market_open_bids_asks;
use crate::math::casting::{cast, cast_to_i128, Cast};
use crate::math::constants::AMM_RESERVE_PRECISION_I128;
use crate::math::helpers;
use crate::math::orders::standardize_base_asset_amount_with_remainder_i128;
use crate::math_error;
use crate::state::perp_market::PerpMarket;
use crate::state::perp_market::AMM;
use crate::state::user::PerpPosition;

#[derive(Debug)]
pub struct LPMetrics {
    pub base_asset_amount: i128,
    pub quote_asset_amount: i128,
    pub remainder_base_asset_amount: i32,
}

pub fn calculate_settle_lp_metrics(
    amm: &AMM,
    position: &PerpPosition,
) -> ClearingHouseResult<LPMetrics> {
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
) -> ClearingHouseResult<(i128, i128)> {
    let n_shares = position.lp_shares;
    let n_shares_i128 = cast_to_i128(n_shares)?;

    // give them slice of the damm market position
    let amm_net_base_asset_amount_per_lp = amm
        .market_position_per_lp
        .base_asset_amount
        .checked_sub(position.last_net_base_asset_amount_per_lp.cast()?)
        .ok_or_else(math_error!())?;

    let base_asset_amount = amm_net_base_asset_amount_per_lp
        .cast::<i128>()?
        .checked_mul(n_shares_i128)
        .ok_or_else(math_error!())?
        .checked_div(AMM_RESERVE_PRECISION_I128)
        .ok_or_else(math_error!())?;

    let amm_net_quote_asset_amount_per_lp = amm
        .market_position_per_lp
        .quote_asset_amount
        .checked_sub(position.last_net_quote_asset_amount_per_lp.cast()?)
        .ok_or_else(math_error!())?;

    let quote_asset_amount = amm_net_quote_asset_amount_per_lp
        .cast::<i128>()?
        .checked_mul(n_shares_i128)
        .ok_or_else(math_error!())?
        .checked_div(AMM_RESERVE_PRECISION_I128)
        .ok_or_else(math_error!())?;

    Ok((base_asset_amount, quote_asset_amount))
}

pub fn calculate_lp_open_bids_asks(
    market_position: &PerpPosition,
    market: &PerpMarket,
) -> ClearingHouseResult<(i64, i64)> {
    let total_lp_shares = market.amm.sqrt_k;
    let lp_shares = market_position.lp_shares;

    let (max_bids, max_asks) = calculate_market_open_bids_asks(&market.amm)?;
    let open_asks = helpers::get_proportion_i128(max_asks, lp_shares.cast()?, total_lp_shares)?;
    let open_bids = helpers::get_proportion_i128(max_bids, lp_shares.cast()?, total_lp_shares)?;

    Ok((cast(open_bids)?, cast(open_asks)?))
}
