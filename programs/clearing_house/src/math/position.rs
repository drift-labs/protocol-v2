use crate::controller::amm::SwapDirection;
use crate::math::{amm, constants::MARK_PRICE_MANTISSA};
use crate::state::market::AMM;
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

    let (new_quote_asset_amount, _new_base_asset_amount) = amm::calculate_swap_output(
        market_position.base_asset_amount.unsigned_abs(),
        amm.base_asset_reserve,
        swap_direction,
        amm.sqrt_k,
    )
    .unwrap();

    let mut quote_asset_acquired = match swap_direction {
        SwapDirection::Add => amm
            .quote_asset_reserve
            .checked_sub(new_quote_asset_amount)
            .unwrap(),

        SwapDirection::Remove => new_quote_asset_amount
            .checked_sub(amm.quote_asset_reserve)
            .unwrap(),
    };

    quote_asset_acquired = quote_asset_acquired
        .checked_mul(amm.peg_multiplier)
        .unwrap()
        .checked_div(MARK_PRICE_MANTISSA)
        .unwrap();

    let pnl: i128 = match swap_direction {
        SwapDirection::Add => (quote_asset_acquired as i128)
            .checked_sub(market_position.quote_asset_amount as i128)
            .unwrap(),

        SwapDirection::Remove => (market_position.quote_asset_amount as i128)
            .checked_sub(quote_asset_acquired as i128)
            .unwrap(),
    };

    return (quote_asset_acquired, pnl);
}
