use crate::error::ClearingHouseResult;
use crate::math::position::_calculate_base_asset_value_and_pnl;
use crate::state::market::Market;

pub fn adjust_peg_cost(market: &mut Market, new_peg: u128) -> ClearingHouseResult<i128> {
    // Find the net market value before adjusting peg
    let (current_net_market_value, _) =
        _calculate_base_asset_value_and_pnl(market.base_asset_amount, 0, &market.amm)?;

    market.amm.peg_multiplier = new_peg;

    let (_new_net_market_value, cost) = _calculate_base_asset_value_and_pnl(
        market.base_asset_amount,
        current_net_market_value,
        &market.amm,
    )?;

    Ok(cost)
}
