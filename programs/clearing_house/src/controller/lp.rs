use crate::controller::position::update_unsettled_pnl;
use crate::error::ClearingHouseResult;
use crate::math::lp::get_lp_metrics;
use crate::math::lp::update_lp_position;
use crate::state::market::Market;
use crate::MarketPosition;

pub fn settle_lp_position(
    position: &mut MarketPosition,
    market: &mut Market,
) -> ClearingHouseResult<()> {
    let amm = &mut market.amm;
    let metrics = get_lp_metrics(position, amm)?;

    // update lp market position
    let upnl = update_lp_position(position, &metrics)?;
    update_unsettled_pnl(position, market, upnl)?;

    // update last_ metrics
    position.last_cumulative_fee_per_lp = market.amm.cumulative_fee_per_lp;
    position.last_cumulative_funding_payment_per_lp = market.amm.cumulative_funding_payment_per_lp;
    position.last_cumulative_net_base_asset_amount_per_lp =
        market.amm.cumulative_net_base_asset_amount_per_lp;

    Ok(())
}
