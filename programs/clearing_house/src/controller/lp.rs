use crate::controller::position::update_unsettled_pnl;
use crate::error::ClearingHouseResult;
use crate::math::casting::cast_to_i128;
use crate::math::lp::get_lp_metrics;
use crate::math_error;
use crate::state::market::Market;
use crate::MarketPosition;
use solana_program::msg;

pub fn settle_lp_position(
    position: &mut MarketPosition,
    market: &mut Market,
) -> ClearingHouseResult<()> {
    let amm = &mut market.amm;
    let metrics = get_lp_metrics(position, amm)?;

    // update lp market position
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
        let quote_asset_amount = if metrics.quote_asset_amount > position.lp_quote_asset_amount {
            metrics
                .quote_asset_amount
                .checked_sub(position.lp_quote_asset_amount)
                .ok_or_else(math_error!())?
        } else {
            position
                .lp_quote_asset_amount
                .checked_sub(metrics.quote_asset_amount)
                .ok_or_else(math_error!())?
        };
        let base_asset_amount = position
            .lp_base_asset_amount
            .checked_add(metrics.base_asset_amount)
            .ok_or_else(math_error!())?;
        position.lp_base_asset_amount = base_asset_amount;
        position.lp_quote_asset_amount = quote_asset_amount;
    }

    // pay them upnl
    let upnl = cast_to_i128(metrics.fee_payment)?
        .checked_add(metrics.funding_payment)
        .ok_or_else(math_error!())?
        .checked_add(metrics.unsettled_pnl)
        .ok_or_else(math_error!())?;

    update_unsettled_pnl(position, market, upnl)?;

    // update last_ metrics
    position.last_cumulative_fee_per_lp = market.amm.cumulative_fee_per_lp;
    position.last_cumulative_funding_rate_lp = market.amm.cumulative_funding_payment_per_lp;
    position.last_cumulative_net_base_asset_amount_per_lp =
        market.amm.cumulative_net_base_asset_amount_per_lp;

    Ok(())
}
