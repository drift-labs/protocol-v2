use solana_program::msg;

use crate::controller::amm::SwapDirection;
use crate::controller::position::PositionDirection;
use crate::error::ClearingHouseResult;
use crate::math::amm;
use crate::math::amm::calculate_quote_asset_amount_swapped;
use crate::math::collateral::calculate_updated_collateral;
use crate::math::constants::{AMM_RESERVE_PRECISION, PRICE_TO_QUOTE_PRECISION_RATIO};
use crate::math::pnl::calculate_pnl;
use crate::math_error;
use crate::settlement_ratios::{SETTLEMENT_RATIOS, SETTLEMENT_RATIO_PRECISION};
use crate::state::market::{Markets, AMM};
use crate::state::user::{MarketPosition, User, UserPositions};

pub fn calculate_base_asset_value_and_pnl(
    market_position: &MarketPosition,
    amm: &AMM,
) -> ClearingHouseResult<(u128, i128)> {
    _calculate_base_asset_value_and_pnl(
        market_position.base_asset_amount,
        market_position.quote_asset_amount,
        amm,
    )
}

pub fn _calculate_base_asset_value_and_pnl(
    base_asset_amount: i128,
    quote_asset_amount: u128,
    amm: &AMM,
) -> ClearingHouseResult<(u128, i128)> {
    if base_asset_amount == 0 {
        return Ok((0, 0));
    }

    let swap_direction = swap_direction_to_close_position(base_asset_amount);

    let (new_quote_asset_reserve, _new_base_asset_reserve) = amm::calculate_swap_output(
        base_asset_amount.unsigned_abs(),
        amm.base_asset_reserve,
        swap_direction,
        amm.sqrt_k,
    )?;

    let base_asset_value = calculate_quote_asset_amount_swapped(
        amm.quote_asset_reserve,
        new_quote_asset_reserve,
        swap_direction,
        amm.peg_multiplier,
    )?;

    let pnl = calculate_pnl(base_asset_value, quote_asset_amount, swap_direction)?;

    Ok((base_asset_value, pnl))
}

pub fn calculate_base_asset_value_and_pnl_with_oracle_price(
    market_position: &MarketPosition,
    oracle_price: i128,
) -> ClearingHouseResult<(u128, i128)> {
    if market_position.base_asset_amount == 0 {
        return Ok((0, 0));
    }

    let swap_direction = swap_direction_to_close_position(market_position.base_asset_amount);

    let oracle_price = if oracle_price > 0 {
        oracle_price.unsigned_abs()
    } else {
        0
    };

    let base_asset_value = market_position
        .base_asset_amount
        .unsigned_abs()
        .checked_mul(oracle_price)
        .ok_or_else(math_error!())?
        .checked_div(AMM_RESERVE_PRECISION * PRICE_TO_QUOTE_PRECISION_RATIO)
        .ok_or_else(math_error!())?;

    let pnl = calculate_pnl(
        base_asset_value,
        market_position.quote_asset_amount,
        swap_direction,
    )?;

    Ok((base_asset_value, pnl))
}

pub fn direction_to_close_position(base_asset_amount: i128) -> PositionDirection {
    if base_asset_amount > 0 {
        PositionDirection::Short
    } else {
        PositionDirection::Long
    }
}

pub fn swap_direction_to_close_position(base_asset_amount: i128) -> SwapDirection {
    if base_asset_amount >= 0 {
        SwapDirection::Add
    } else {
        SwapDirection::Remove
    }
}

pub fn calculated_settled_position_value(
    user: &User,
    user_positions: &UserPositions,
    markets: &Markets,
) -> ClearingHouseResult<u128> {
    let mut pnl: i128 = 0;

    for market_position in user_positions.positions.iter() {
        if market_position.base_asset_amount == 0 {
            continue;
        }

        let market = markets.get_market(market_position.market_index);
        let amm = &market.amm;
        let (_, position_pnl) = calculate_base_asset_value_and_pnl(market_position, amm)?;

        let position_pnl = if position_pnl > 0 {
            position_pnl
                .checked_mul(SETTLEMENT_RATIOS[market_position.market_index as usize])
                .ok_or_else(math_error!())?
                .checked_div(SETTLEMENT_RATIO_PRECISION)
                .ok_or_else(math_error!())?
        } else {
            position_pnl
        };

        pnl = pnl.checked_add(position_pnl).ok_or_else(math_error!())?;
    }

    let settled_position_value = calculate_updated_collateral(user.collateral, pnl)?;

    Ok(settled_position_value)
}
