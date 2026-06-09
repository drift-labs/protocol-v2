use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::safe_math::SafeMath;

use crate::msg;
use crate::state::perp_market::PerpMarket;
use crate::validate;

pub fn validate_perp_market(market: &PerpMarket) -> DriftResult {
    // PerpMarket-level invariants: the position counters must standardize
    // cleanly against the configured tick size, and the rolling insurance
    // claim must stay within its per-period cap.
    let (_, remainder_base_asset_amount_long) =
        crate::math::orders::standardize_base_asset_amount_with_remainder_i128(
            market.base_asset_amount_long,
            market.order_step_size.cast()?,
        )?;
    let (_, remainder_base_asset_amount_short) =
        crate::math::orders::standardize_base_asset_amount_with_remainder_i128(
            market.base_asset_amount_short,
            market.order_step_size.cast()?,
        )?;
    validate!(
        remainder_base_asset_amount_long == 0 && remainder_base_asset_amount_short == 0,
        ErrorCode::InvalidPositionDelta,
        "market {} invalid base_asset_amount_long/short vs order_step_size, remainder={}/{}",
        market.market_index,
        remainder_base_asset_amount_short,
        market.order_step_size
    )?;

    validate!(
        market.insurance_claim.max_revenue_withdraw_per_period
            >= market
                .insurance_claim
                .revenue_withdraw_since_last_settle
                .unsigned_abs(),
        ErrorCode::InvalidAmmDetected,
        "{} market.insurance_claim.max_revenue_withdraw_per_period={} < |revenue_withdraw_since_last_settle|={}",
        market.market_index,
        market.insurance_claim.max_revenue_withdraw_per_period,
        market
            .insurance_claim
            .revenue_withdraw_since_last_settle
            .unsigned_abs()
    )?;

    // AMM-internal invariants: delegate to the AMM. Cross-checks that need
    // PerpMarket-side inputs (the long+short position sum) are threaded in
    // as parameters; the AMM is otherwise the source of truth on its own
    // integrity.
    let net_user_position = market
        .base_asset_amount_long
        .safe_add(market.base_asset_amount_short)?;
    market.amm.validate(
        market.status,
        market.margin_ratio_initial,
        net_user_position,
        market.market_index,
    )?;

    Ok(())
}
