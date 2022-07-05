use crate::controller::position::update_unsettled_pnl;
use crate::error::ClearingHouseResult;
use crate::math::casting::cast_to_u128;
use crate::math::lp::get_lp_metrics;
use crate::math::lp::SettleResult;
use crate::math_error;
use crate::state::market::Market;
use crate::MarketPosition;
use solana_program::msg;

pub fn settle_lp_position(
    lp_position: &mut MarketPosition,
    lp_tokens_to_settle: u128,
    market: &mut Market,
) -> ClearingHouseResult<SettleResult> {
    let amm = &mut market.amm;
    let lp_metrics = get_lp_metrics(lp_position, lp_tokens_to_settle, amm)?;

    // update amm metrics
    amm.total_fee_minus_distributions = amm
        .total_fee_minus_distributions
        .checked_sub(cast_to_u128(lp_metrics.fee_payment)?)
        .ok_or_else(math_error!())?;

    // give market position if size is large enough
    // otherwise reduce upnl by 1 to account for small position loss
    if lp_metrics.settle_result == SettleResult::RecievedMarketPosition {
        lp_position.base_asset_amount = lp_position
            .base_asset_amount
            .checked_add(lp_metrics.base_asset_amount)
            .ok_or_else(math_error!())?;
        lp_position.quote_asset_amount = lp_position
            .quote_asset_amount
            .checked_add(lp_metrics.quote_asset_amount)
            .ok_or_else(math_error!())?;
        lp_position.quote_entry_amount = lp_position
            .quote_entry_amount
            .checked_add(lp_metrics.quote_asset_amount)
            .ok_or_else(math_error!())?;
        lp_position.last_net_base_asset_amount = amm.net_base_asset_amount;
    }
    lp_position.last_total_fee_minus_distributions = amm.total_fee_minus_distributions;
    lp_position.last_cumulative_funding_rate = amm.cumulative_funding_rate_lp;

    // update the lp position
    let lp_pnl = lp_metrics
        .fee_payment
        .checked_add(lp_metrics.funding_payment)
        .ok_or_else(math_error!())?;

    update_unsettled_pnl(lp_position, market, lp_pnl)?;

    Ok(lp_metrics.settle_result)
}
