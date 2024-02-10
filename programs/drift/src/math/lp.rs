use crate::error::{DriftResult, ErrorCode};
use crate::{
    validate, MARGIN_PRECISION_U128, PRICE_PRECISION, PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO,
};
use solana_program::msg;
use std::u64;

use crate::math::amm::calculate_market_open_bids_asks;
use crate::math::casting::Cast;
use crate::math::helpers;
use crate::math::margin::MarginRequirementType;
use crate::math::orders::{
    standardize_base_asset_amount, standardize_base_asset_amount_ceil,
    standardize_base_asset_amount_with_remainder_i128,
};
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
    let n_shares = position.lp_shares;
    let base_unit: i128 = amm.get_per_lp_base_unit()?;

    validate!(
        amm.per_lp_base == position.per_lp_base,
        ErrorCode::InvalidPerpPositionDetected,
        "calculate_settled_lp_base_quote :: position/market per_lp_base unequal {} != {}",
        position.per_lp_base,
        amm.per_lp_base
    )?;

    let n_shares_i128 = n_shares.cast::<i128>()?;

    // give them slice of the damm market position
    let amm_net_base_asset_amount_per_lp = amm
        .base_asset_amount_per_lp
        .safe_sub(position.last_base_asset_amount_per_lp.cast()?)?;

    let base_asset_amount = amm_net_base_asset_amount_per_lp
        .cast::<i128>()?
        .safe_mul(n_shares_i128)?
        .safe_div(base_unit)?;

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

pub fn calculate_lp_shares_to_burn_for_risk_reduction(
    perp_position: &PerpPosition,
    market: &PerpMarket,
    oracle_price: i64,
    quote_oracle_price: i64,
    margin_shortage: u128,
    user_custom_margin_ratio: u32,
) -> DriftResult<(u64, u64)> {
    let settled_lp_position = perp_position.simulate_settled_lp_position(market, oracle_price)?;

    let worse_case_base_asset_amount = settled_lp_position.worst_case_base_asset_amount()?;

    let open_orders_from_lp_shares = if worse_case_base_asset_amount >= 0 {
        worse_case_base_asset_amount.safe_sub(
            settled_lp_position
                .base_asset_amount
                .safe_add(perp_position.open_bids)?
                .cast()?,
        )?
    } else {
        worse_case_base_asset_amount.safe_sub(
            settled_lp_position
                .base_asset_amount
                .safe_add(perp_position.open_asks)?
                .cast()?,
        )?
    };

    let margin_ratio = market
        .get_margin_ratio(
            worse_case_base_asset_amount.unsigned_abs(),
            MarginRequirementType::Initial,
        )?
        .max(user_custom_margin_ratio);

    let base_asset_amount_to_cover = margin_shortage
        .safe_mul(PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO)?
        .safe_div(
            oracle_price
                .cast::<u128>()?
                .safe_mul(quote_oracle_price.cast()?)?
                .safe_div(PRICE_PRECISION)?
                .safe_mul(margin_ratio.cast()?)?
                .safe_div(MARGIN_PRECISION_U128)?,
        )?
        .cast::<u64>()?;

    let current_base_asset_amount = settled_lp_position.base_asset_amount.unsigned_abs();

    // if closing position is enough to cover margin shortage, then only a small % of lp shares need to be burned
    if base_asset_amount_to_cover < current_base_asset_amount {
        let base_asset_amount_to_close = standardize_base_asset_amount_ceil(
            base_asset_amount_to_cover,
            market.amm.order_step_size,
        )?
        .min(current_base_asset_amount);
        let lp_shares_to_burn = standardize_base_asset_amount(
            settled_lp_position.lp_shares / 10,
            market.amm.order_step_size,
        )?
        .max(market.amm.order_step_size);
        return Ok((lp_shares_to_burn, base_asset_amount_to_close));
    }

    let base_asset_amount_to_cover =
        base_asset_amount_to_cover.safe_sub(current_base_asset_amount)?;

    let percent_to_burn = base_asset_amount_to_cover
        .cast::<u128>()?
        .safe_mul(100)?
        .safe_div_ceil(open_orders_from_lp_shares.unsigned_abs())?;

    let lp_shares_to_burn = settled_lp_position
        .lp_shares
        .cast::<u128>()?
        .safe_mul(percent_to_burn.cast()?)?
        .safe_div_ceil(100)?
        .cast::<u64>()?;

    let standardized_lp_shares_to_burn =
        standardize_base_asset_amount_ceil(lp_shares_to_burn, market.amm.order_step_size)?
            .clamp(market.amm.order_step_size, settled_lp_position.lp_shares);

    Ok((standardized_lp_shares_to_burn, current_base_asset_amount))
}
