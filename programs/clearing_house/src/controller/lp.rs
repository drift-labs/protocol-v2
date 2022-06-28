use crate::error::ClearingHouseResult;
use crate::math::lp::get_lp_market_position;
use crate::state::market::AMM;
use crate::MarketPosition;

pub fn settle_lp_position(
    lp_position: &mut MarketPosition,
    lp_tokens_to_settle: u128,
    amm: &AMM,
) -> ClearingHouseResult<()> {
    if lp_position.lp_tokens != lp_tokens_to_settle {
        panic!("not implemented yet...");
    }

    if lp_tokens_to_settle == 0 {
        return Ok(());
    }

    let lp_market_position = get_lp_market_position(lp_position, lp_tokens_to_settle, amm)?;

    // update market position args
    lp_position.base_asset_amount = lp_market_position.base_asset_amount;
    lp_position.quote_asset_amount = lp_market_position.quote_asset_amount;
    lp_position.unsettled_pnl = lp_market_position.unsettled_pnl;

    // update the lp position
    lp_position.last_net_base_asset_amount = amm.net_base_asset_amount;
    lp_position.last_total_fee_minus_distributions = amm.total_fee_minus_distributions;
    lp_position.last_cumulative_funding_rate = amm.cumulative_funding_rate_lp;

    Ok(())
}
