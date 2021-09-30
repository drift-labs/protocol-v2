use crate::state::market::{SwapDirection, AMM};
use crate::state::user::MarketPosition;

pub fn calculate_base_asset_value_and_pnl(
    market_position: &MarketPosition,
    amm: &AMM,
) -> (u128, i128) {
    let swap_direction = if market_position.base_asset_amount > 0 {
        SwapDirection::Add
    } else {
        SwapDirection::Remove
    };
    let (quote_asset_acquired, pnl) = amm.find_swap_output_and_pnl(
        market_position.base_asset_amount.unsigned_abs(),
        market_position.quote_asset_amount,
        swap_direction,
    );
    return (quote_asset_acquired, pnl);
}
