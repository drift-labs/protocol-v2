use solana_program::msg;

use crate::controller::amm::SwapDirection;
use crate::controller::position::{PositionDelta, PositionDirection};
use crate::error::ClearingHouseResult;
use crate::math::amm;
use crate::math::amm::calculate_quote_asset_amount_swapped;
use crate::math::constants::{
    AMM_RESERVE_PRECISION, AMM_TO_QUOTE_PRECISION_RATIO, MARK_PRICE_PRECISION,
    PRICE_TO_QUOTE_PRECISION_RATIO,
};
use crate::math::pnl::calculate_pnl;
use crate::math_error;
use crate::state::market::AMM;
use crate::state::user::MarketPosition;
use std::cmp::min;

pub fn calculate_base_asset_value_and_pnl(
    market_position: &MarketPosition,
    amm: &AMM,
    use_spread: bool,
) -> ClearingHouseResult<(u128, i128)> {
    _calculate_base_asset_value_and_pnl(
        market_position.base_asset_amount,
        market_position.quote_asset_amount,
        amm,
        use_spread,
    )
}

pub fn calculate_position_pnl(
    market_position: &MarketPosition,
    amm: &AMM,
    use_spread: bool,
) -> ClearingHouseResult<i128> {
    let (_, pnl) = _calculate_base_asset_value_and_pnl(
        market_position.base_asset_amount,
        market_position.quote_asset_amount,
        amm,
        use_spread,
    )?;
    Ok(pnl)
}

pub fn _calculate_base_asset_value_and_pnl(
    base_asset_amount: i128,
    quote_asset_amount: u128,
    amm: &AMM,
    use_spread: bool,
) -> ClearingHouseResult<(u128, i128)> {
    if base_asset_amount == 0 {
        return Ok((0, 0));
    }
    let swap_direction = swap_direction_to_close_position(base_asset_amount);
    let base_asset_value = calculate_base_asset_value(base_asset_amount, amm, use_spread)?;
    let pnl = calculate_pnl(base_asset_value, quote_asset_amount, swap_direction)?;

    Ok((base_asset_value, pnl))
}

pub fn calculate_base_asset_value(
    base_asset_amount: i128,
    amm: &AMM,
    use_spread: bool,
) -> ClearingHouseResult<u128> {
    if base_asset_amount == 0 {
        return Ok(0);
    }

    let swap_direction = swap_direction_to_close_position(base_asset_amount);

    let (base_asset_reserve, quote_asset_reserve) = if use_spread && amm.base_spread > 0 {
        match swap_direction {
            SwapDirection::Add => (amm.bid_base_asset_reserve, amm.bid_quote_asset_reserve),
            SwapDirection::Remove => (amm.ask_base_asset_reserve, amm.ask_quote_asset_reserve),
        }
    } else {
        (amm.base_asset_reserve, amm.quote_asset_reserve)
    };

    let (new_quote_asset_reserve, _new_base_asset_reserve) = amm::calculate_swap_output(
        base_asset_amount.unsigned_abs(),
        base_asset_reserve,
        swap_direction,
        amm.sqrt_k,
    )?;

    let base_asset_value = calculate_quote_asset_amount_swapped(
        quote_asset_reserve,
        new_quote_asset_reserve,
        swap_direction,
        amm.peg_multiplier,
    )?;

    Ok(base_asset_value)
}

pub fn calculate_base_asset_value_with_oracle_price(
    base_asset_amount: i128,
    oracle_price: i128,
) -> ClearingHouseResult<u128> {
    if base_asset_amount == 0 {
        return Ok(0);
    }

    let oracle_price = if oracle_price > 0 {
        oracle_price.unsigned_abs()
    } else {
        0
    };

    let base_asset_value = base_asset_amount
        .unsigned_abs()
        .checked_mul(oracle_price)
        .ok_or_else(math_error!())?
        .checked_div(AMM_RESERVE_PRECISION * PRICE_TO_QUOTE_PRECISION_RATIO)
        .ok_or_else(math_error!())?;

    Ok(base_asset_value)
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

pub fn calculate_entry_price(
    quote_asset_amount: u128,
    base_asset_amount: u128,
) -> ClearingHouseResult<u128> {
    let price = quote_asset_amount
        .checked_mul(MARK_PRICE_PRECISION * AMM_TO_QUOTE_PRECISION_RATIO)
        .ok_or_else(math_error!())?
        .checked_div(base_asset_amount)
        .ok_or_else(math_error!())?;

    Ok(price)
}

pub fn calculate_position_new_quote_base_pnl(
    position: &MarketPosition,
    delta: &PositionDelta,
) -> ClearingHouseResult<(u128, u128, i128, i128)> {
    let new_position = position.base_asset_amount == 0;
    let increasing_position =
        new_position || position.base_asset_amount.signum() == delta.base_asset_amount.signum();

    let (new_quote_asset_amount, new_quote_entry_amount, new_base_asset_amount, pnl) =
        if !increasing_position && delta.base_asset_amount != 0 {
            let base_asset_amount_before_unsigned = position.base_asset_amount.unsigned_abs();
            let delta_base_asset_amount_unsigned = delta.base_asset_amount.unsigned_abs();

            let cost_basis = position
                .quote_asset_amount
                .checked_mul(min(
                    delta_base_asset_amount_unsigned,
                    base_asset_amount_before_unsigned,
                ))
                .ok_or_else(math_error!())?
                .checked_div(base_asset_amount_before_unsigned)
                .ok_or_else(math_error!())?;

            let exit_value = delta
                .quote_asset_amount
                .checked_mul(min(
                    delta_base_asset_amount_unsigned,
                    base_asset_amount_before_unsigned,
                ))
                .ok_or_else(math_error!())?
                .checked_div(delta_base_asset_amount_unsigned)
                .ok_or_else(math_error!())?;

            let pnl = calculate_pnl(
                exit_value,
                cost_basis,
                swap_direction_to_close_position(position.base_asset_amount),
            )?;

            let new_base_asset_amount = position
                .base_asset_amount
                .checked_add(delta.base_asset_amount)
                .ok_or_else(math_error!())?;

            let (new_quote_asset_amount, new_quote_entry_amount) =
                if delta.quote_asset_amount > exit_value {
                    let new_quote_asset_amount = delta
                        .quote_asset_amount
                        .checked_sub(exit_value)
                        .ok_or_else(math_error!())?;
                    (new_quote_asset_amount, new_quote_asset_amount)
                } else {
                    let entry_amount_delta = position
                        .quote_entry_amount
                        .checked_mul(delta_base_asset_amount_unsigned)
                        .ok_or_else(math_error!())?
                        .checked_div(base_asset_amount_before_unsigned)
                        .ok_or_else(math_error!())?;

                    let quote_entry_amount = position
                        .quote_entry_amount
                        .checked_sub(entry_amount_delta)
                        .ok_or_else(math_error!())?;

                    (
                        position
                            .quote_asset_amount
                            .checked_sub(cost_basis)
                            .ok_or_else(math_error!())?,
                        quote_entry_amount,
                    )
                };

            (
                new_quote_asset_amount,
                new_quote_entry_amount,
                new_base_asset_amount,
                pnl,
            )
        } else {
            let new_quote_asset_amount = position
                .quote_asset_amount
                .checked_add(delta.quote_asset_amount)
                .ok_or_else(math_error!())?;
            let new_quote_entry_amount = position
                .quote_entry_amount
                .checked_add(delta.quote_asset_amount)
                .ok_or_else(math_error!())?;
            let new_base_asset_amount = position
                .base_asset_amount
                .checked_add(delta.base_asset_amount)
                .ok_or_else(math_error!())?;

            (
                new_quote_asset_amount,
                new_quote_entry_amount,
                new_base_asset_amount,
                0_i128,
            )
        };

    Ok((
        new_quote_asset_amount,
        new_quote_entry_amount,
        new_base_asset_amount,
        pnl,
    ))
}
