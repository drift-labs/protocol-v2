use crate::controller::amm::SwapDirection;
use crate::controller::position::PositionDirection;
use crate::error::*;
use crate::math::{amm, quote_asset::*};
use crate::math_error;
use crate::state::market::AMM;
use crate::state::user::MarketPosition;
use solana_program::msg;

pub fn calculate_base_asset_value_and_pnl(
    market_position: &MarketPosition,
    amm: &AMM,
) -> ClearingHouseResult<(u128, i128)> {
    let swap_direction = if market_position.base_asset_amount > 0 {
        SwapDirection::Add
    } else {
        SwapDirection::Remove
    };

    let (new_quote_asset_reserve, _new_base_asset_reserve) = amm::calculate_swap_output(
        market_position.base_asset_amount.unsigned_abs(),
        amm.base_asset_reserve,
        swap_direction,
        amm.sqrt_k,
    )?;

    let scaled_unpegged_quote_asset_amount_acquired = match swap_direction {
        SwapDirection::Add => amm
            .quote_asset_reserve
            .checked_sub(new_quote_asset_reserve)
            .ok_or_else(math_error!())?,

        SwapDirection::Remove => new_quote_asset_reserve
            .checked_sub(amm.quote_asset_reserve)
            .ok_or_else(math_error!())?,
    };

    let scaled_pegged_quote_asset_amount_acquired =
        scale_from_amm_precision(scaled_unpegged_quote_asset_amount_acquired)?;
    let pegged_quote_asset_amount_acquired = peg_quote_asset_amount(
        scaled_pegged_quote_asset_amount_acquired,
        amm.peg_multiplier,
    )?;

    let pnl: i128 = match swap_direction {
        SwapDirection::Add => (pegged_quote_asset_amount_acquired as i128)
            .checked_sub(market_position.quote_asset_amount as i128)
            .ok_or_else(math_error!())?,

        SwapDirection::Remove => (market_position.quote_asset_amount as i128)
            .checked_sub(pegged_quote_asset_amount_acquired as i128)
            .ok_or_else(math_error!())?,
    };

    return Ok((pegged_quote_asset_amount_acquired, pnl));
}

pub fn direction_to_close_position(base_asset_amount: i128) -> PositionDirection {
    if base_asset_amount > 0 {
        PositionDirection::Short
    } else {
        PositionDirection::Long
    }
}
