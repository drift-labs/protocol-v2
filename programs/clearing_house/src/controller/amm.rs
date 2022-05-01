use solana_program::msg;

use crate::controller::position::PositionDirection;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::amm::{calculate_quote_asset_amount_swapped, calculate_spread_reserves};
use crate::math::casting::{cast, cast_to_i128};
use crate::math::constants::PRICE_TO_PEG_PRECISION_RATIO;
use crate::math::{amm, bn, quote_asset::*};
use crate::math_error;
use crate::state::market::AMM;

#[derive(Clone, Copy, PartialEq)]
pub enum SwapDirection {
    Add,
    Remove,
}

pub fn swap_quote_asset(
    amm: &mut AMM,
    quote_asset_amount: u128,
    direction: SwapDirection,
    now: i64,
    precomputed_mark_price: Option<u128>,
    use_spread: bool,
) -> ClearingHouseResult<(i128, u128)> {
    amm::update_mark_twap(amm, now, precomputed_mark_price)?;

    let (
        new_base_asset_reserve,
        new_quote_asset_reserve,
        base_asset_amount,
        quote_asset_amount_surplus,
    ) = match use_spread && amm.base_spread > 0 {
        true => calculate_quote_swap_output_with_spread(amm, quote_asset_amount, direction)?,
        false => calculate_quote_swap_output_without_spread(amm, quote_asset_amount, direction)?,
    };

    amm.base_asset_reserve = new_base_asset_reserve;
    amm.quote_asset_reserve = new_quote_asset_reserve;

    Ok((base_asset_amount, quote_asset_amount_surplus))
}

fn calculate_quote_swap_output_without_spread(
    amm: &mut AMM,
    quote_asset_amount: u128,
    direction: SwapDirection,
) -> ClearingHouseResult<(u128, u128, i128, u128)> {
    let quote_asset_reserve_amount =
        asset_to_reserve_amount(quote_asset_amount, amm.peg_multiplier)?;

    if quote_asset_reserve_amount < amm.minimum_quote_asset_trade_size {
        return Err(ErrorCode::TradeSizeTooSmall);
    }

    let initial_base_asset_reserve = amm.base_asset_reserve;
    let (new_base_asset_reserve, new_quote_asset_reserve) = amm::calculate_swap_output(
        quote_asset_reserve_amount,
        amm.quote_asset_reserve,
        direction,
        amm.sqrt_k,
    )?;

    let base_asset_amount = cast_to_i128(initial_base_asset_reserve)?
        .checked_sub(cast(new_base_asset_reserve)?)
        .ok_or_else(math_error!())?;

    Ok((
        new_base_asset_reserve,
        new_quote_asset_reserve,
        base_asset_amount,
        0,
    ))
}

fn calculate_quote_swap_output_with_spread(
    amm: &mut AMM,
    quote_asset_amount: u128,
    direction: SwapDirection,
) -> ClearingHouseResult<(u128, u128, i128, u128)> {
    let quote_asset_reserve_amount =
        asset_to_reserve_amount(quote_asset_amount, amm.peg_multiplier)?;

    if quote_asset_reserve_amount < amm.minimum_quote_asset_trade_size {
        return Err(ErrorCode::TradeSizeTooSmall);
    }

    // first do the swap with spread reserves to figure out how much base asset is acquired
    let (base_asset_reserve_with_spread, quote_asset_reserve_with_spread) =
        calculate_spread_reserves(
            amm,
            match direction {
                SwapDirection::Add => PositionDirection::Long,
                SwapDirection::Remove => PositionDirection::Short,
            },
        )?;

    let (new_base_asset_reserve_with_spread, _) = amm::calculate_swap_output(
        quote_asset_reserve_amount,
        quote_asset_reserve_with_spread,
        direction,
        amm.sqrt_k,
    )?;

    let base_asset_amount_with_spread = cast_to_i128(base_asset_reserve_with_spread)?
        .checked_sub(cast(new_base_asset_reserve_with_spread)?)
        .ok_or_else(math_error!())?;

    // second do the swap based on normal reserves to get updated reserves
    let (new_base_asset_reserve, new_quote_asset_reserve) = amm::calculate_swap_output(
        quote_asset_reserve_amount,
        amm.quote_asset_reserve,
        direction,
        amm.sqrt_k,
    )?;

    // find the quote asset reserves if the position were closed
    let (quote_asset_reserve_if_closed, _) = amm::calculate_swap_output(
        base_asset_amount_with_spread.unsigned_abs(),
        new_base_asset_reserve,
        direction,
        amm.sqrt_k,
    )?;

    // calculate the quote asset surplus by taking the difference between what quote_asset_amount is
    // with and without spread
    let quote_asset_amount_surplus = calculate_quote_asset_amount_surplus(
        new_quote_asset_reserve,
        quote_asset_reserve_if_closed,
        direction,
        amm.peg_multiplier,
        quote_asset_amount,
        false,
    )?;

    Ok((
        new_base_asset_reserve,
        new_quote_asset_reserve,
        base_asset_amount_with_spread,
        quote_asset_amount_surplus,
    ))
}

fn calculate_quote_asset_amount_surplus(
    quote_asset_reserve_before: u128,
    quote_asset_reserve_after: u128,
    swap_direction: SwapDirection,
    peg_multiplier: u128,
    initial_quote_asset_amount: u128,
    round_down: bool,
) -> ClearingHouseResult<u128> {
    let quote_asset_reserve_change = match swap_direction {
        SwapDirection::Add => quote_asset_reserve_before
            .checked_sub(quote_asset_reserve_after)
            .ok_or_else(math_error!())?,

        SwapDirection::Remove => quote_asset_reserve_after
            .checked_sub(quote_asset_reserve_before)
            .ok_or_else(math_error!())?,
    };

    let mut actual_quote_asset_amount =
        reserve_to_asset_amount(quote_asset_reserve_change, peg_multiplier)?;

    // Compensate for +1 quote asset amount added when removing base asset
    if round_down {
        actual_quote_asset_amount = actual_quote_asset_amount
            .checked_add(1)
            .ok_or_else(math_error!())?;
    }

    let quote_asset_amount_surplus = if actual_quote_asset_amount > initial_quote_asset_amount {
        actual_quote_asset_amount
            .checked_sub(initial_quote_asset_amount)
            .ok_or_else(math_error!())?
    } else {
        initial_quote_asset_amount
            .checked_sub(actual_quote_asset_amount)
            .ok_or_else(math_error!())?
    };

    Ok(quote_asset_amount_surplus)
}

pub fn swap_base_asset(
    amm: &mut AMM,
    base_asset_swap_amount: u128,
    direction: SwapDirection,
    now: i64,
    precomputed_mark_price: Option<u128>,
    use_spread: bool,
) -> ClearingHouseResult<(u128, u128)> {
    amm::update_mark_twap(amm, now, precomputed_mark_price)?;

    let (
        new_base_asset_reserve,
        new_quote_asset_reserve,
        quote_asset_amount,
        quote_asset_amount_surplus,
    ) = match use_spread && amm.base_spread > 0 {
        true => calculate_base_swap_output_with_spread(amm, base_asset_swap_amount, direction)?,
        false => calculate_base_swap_output_without_spread(amm, base_asset_swap_amount, direction)?,
    };

    amm.base_asset_reserve = new_base_asset_reserve;
    amm.quote_asset_reserve = new_quote_asset_reserve;

    Ok((quote_asset_amount, quote_asset_amount_surplus))
}

fn calculate_base_swap_output_without_spread(
    amm: &mut AMM,
    base_asset_swap_amount: u128,
    direction: SwapDirection,
) -> ClearingHouseResult<(u128, u128, u128, u128)> {
    let initial_quote_asset_reserve = amm.quote_asset_reserve;
    let (new_quote_asset_reserve, new_base_asset_reserve) = amm::calculate_swap_output(
        base_asset_swap_amount,
        amm.base_asset_reserve,
        direction,
        amm.sqrt_k,
    )?;

    let quote_asset_amount = calculate_quote_asset_amount_swapped(
        initial_quote_asset_reserve,
        new_quote_asset_reserve,
        direction,
        amm.peg_multiplier,
    )?;

    Ok((
        new_base_asset_reserve,
        new_quote_asset_reserve,
        quote_asset_amount,
        0,
    ))
}

fn calculate_base_swap_output_with_spread(
    amm: &mut AMM,
    base_asset_swap_amount: u128,
    direction: SwapDirection,
) -> ClearingHouseResult<(u128, u128, u128, u128)> {
    // first do the swap with spread reserves to figure out how much base asset is acquired
    let (base_asset_reserve_with_spread, quote_asset_reserve_with_spread) =
        calculate_spread_reserves(
            amm,
            match direction {
                SwapDirection::Add => PositionDirection::Short,
                SwapDirection::Remove => PositionDirection::Long,
            },
        )?;

    let (new_quote_asset_reserve_with_spread, _) = amm::calculate_swap_output(
        base_asset_swap_amount,
        base_asset_reserve_with_spread,
        direction,
        amm.sqrt_k,
    )?;

    let quote_asset_amount = calculate_quote_asset_amount_swapped(
        quote_asset_reserve_with_spread,
        new_quote_asset_reserve_with_spread,
        direction,
        amm.peg_multiplier,
    )?;

    let (new_quote_asset_reserve, new_base_asset_reserve) = amm::calculate_swap_output(
        base_asset_swap_amount,
        amm.base_asset_reserve,
        direction,
        amm.sqrt_k,
    )?;

    // calculate the quote asset surplus by taking the difference between what quote_asset_amount is
    // with and without spread
    let quote_asset_amount_surplus = calculate_quote_asset_amount_surplus(
        new_quote_asset_reserve,
        amm.quote_asset_reserve,
        match direction {
            SwapDirection::Remove => SwapDirection::Add,
            SwapDirection::Add => SwapDirection::Remove,
        },
        amm.peg_multiplier,
        quote_asset_amount,
        direction == SwapDirection::Remove,
    )?;

    Ok((
        new_base_asset_reserve,
        new_quote_asset_reserve,
        quote_asset_amount,
        quote_asset_amount_surplus,
    ))
}

pub fn move_price(
    amm: &mut AMM,
    base_asset_reserve: u128,
    quote_asset_reserve: u128,
) -> ClearingHouseResult {
    amm.base_asset_reserve = base_asset_reserve;
    amm.quote_asset_reserve = quote_asset_reserve;

    let k = bn::U256::from(base_asset_reserve)
        .checked_mul(bn::U256::from(quote_asset_reserve))
        .ok_or_else(math_error!())?;

    amm.sqrt_k = k.integer_sqrt().try_to_u128()?;

    Ok(())
}

#[allow(dead_code)]
pub fn move_to_price(amm: &mut AMM, target_price: u128) -> ClearingHouseResult {
    let sqrt_k = bn::U256::from(amm.sqrt_k);
    let k = sqrt_k.checked_mul(sqrt_k).ok_or_else(math_error!())?;

    let new_base_asset_amount_squared = k
        .checked_mul(bn::U256::from(amm.peg_multiplier))
        .ok_or_else(math_error!())?
        .checked_mul(bn::U256::from(PRICE_TO_PEG_PRECISION_RATIO))
        .ok_or_else(math_error!())?
        .checked_div(bn::U256::from(target_price))
        .ok_or_else(math_error!())?;

    let new_base_asset_amount = new_base_asset_amount_squared.integer_sqrt();
    let new_quote_asset_amount = k
        .checked_div(new_base_asset_amount)
        .ok_or_else(math_error!())?;

    amm.base_asset_reserve = new_base_asset_amount.try_to_u128()?;
    amm.quote_asset_reserve = new_quote_asset_amount.try_to_u128()?;

    Ok(())
}
