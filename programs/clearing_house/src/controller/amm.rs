use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::constants::{
    AMM_ASSET_AMOUNT_PRECISION, MARK_PRICE_MANTISSA, PRICE_TO_PEG_PRECISION_RATIO, USDC_PRECISION,
};
use crate::math::{amm, bn, position::*, quote_asset::*};
use crate::math_error;
use crate::state::market::{Market, AMM};
use solana_program::msg;

#[derive(Clone, Copy)]
pub enum SwapDirection {
    Add,
    Remove,
}

pub fn swap_quote_asset(
    amm: &mut AMM,
    quote_asset_swap_amount: u128,
    direction: SwapDirection,
    now: i64,
) -> ClearingHouseResult<i128> {
    amm::update_mark_twap(amm, now)?;

    let scaled_quote_asset_amount = scale_to_amm_precision(quote_asset_swap_amount)?;
    let unpegged_scaled_quote_asset_amount =
        unpeg_quote_asset_amount(scaled_quote_asset_amount, amm.peg_multiplier)?;

    if unpegged_scaled_quote_asset_amount == 0 {
        return Err(ErrorCode::TradeSizeTooSmall);
    }

    let initial_base_asset_amount = amm.base_asset_reserve;
    let (new_base_asset_amount, new_quote_asset_amount) = amm::calculate_swap_output(
        unpegged_scaled_quote_asset_amount,
        amm.quote_asset_reserve,
        direction,
        amm.sqrt_k,
    )?;
    let mark_price_before = amm.mark_price()?;

    amm.base_asset_reserve = new_base_asset_amount;
    amm.quote_asset_reserve = new_quote_asset_amount;

    let acquired_base_asset_amount = (initial_base_asset_amount as i128)
        .checked_sub(new_base_asset_amount as i128)
        .ok_or_else(math_error!())?;
    let mark_price_after = amm.mark_price()?;

    let entry_price = amm::calculate_price(
        unpegged_scaled_quote_asset_amount,
        acquired_base_asset_amount.unsigned_abs(),
        amm.peg_multiplier,
    )?;

    let trade_size_too_small = match direction {
        SwapDirection::Add => entry_price > mark_price_after || entry_price < mark_price_before,
        SwapDirection::Remove => entry_price < mark_price_after || entry_price > mark_price_before,
    };

    if trade_size_too_small {
        return Err(ErrorCode::TradeSizeTooSmall);
    }

    return Ok(acquired_base_asset_amount);
}

pub fn swap_base_asset(
    amm: &mut AMM,
    base_asset_swap_amount: u128,
    direction: SwapDirection,
    now: i64,
) -> ClearingHouseResult {
    amm::update_mark_twap(amm, now)?;

    let (new_quote_asset_amount, new_base_asset_amount) = amm::calculate_swap_output(
        base_asset_swap_amount,
        amm.base_asset_reserve,
        direction,
        amm.sqrt_k,
    )?;

    amm.base_asset_reserve = new_base_asset_amount;
    amm.quote_asset_reserve = new_quote_asset_amount;

    Ok(())
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

pub fn adjust_k_cost(market: &mut Market, new_sqrt_k: bn::U256) -> ClearingHouseResult<i128> {
    // price is fixed, calculate cost of changing k in market
    let (cur_net_value, _) =
        _calculate_base_asset_value_and_pnl(market.base_asset_amount, 0, &market.amm)?;

    let k_mult = new_sqrt_k
        .checked_mul(bn::U256::from(MARK_PRICE_MANTISSA))
        .ok_or_else(math_error!())?
        .checked_div(bn::U256::from(market.amm.sqrt_k))
        .ok_or_else(math_error!())?;

    market.amm.sqrt_k = new_sqrt_k.try_to_u128().unwrap();
    market.amm.base_asset_reserve = bn::U256::from(market.amm.base_asset_reserve)
        .checked_mul(k_mult)
        .ok_or_else(math_error!())?
        .checked_div(bn::U256::from(MARK_PRICE_MANTISSA))
        .ok_or_else(math_error!())?
        .try_to_u128()
        .unwrap();
    market.amm.quote_asset_reserve = bn::U256::from(market.amm.quote_asset_reserve)
        .checked_mul(k_mult)
        .ok_or_else(math_error!())?
        .checked_div(bn::U256::from(MARK_PRICE_MANTISSA))
        .ok_or_else(math_error!())?
        .try_to_u128()
        .unwrap();

    let (_new_net_value, cost) =
        _calculate_base_asset_value_and_pnl(market.base_asset_amount, cur_net_value, &market.amm)
            .unwrap();

    Ok(cost)
}

#[allow(dead_code)]
pub fn calculate_cost_of_k(market: &mut Market, new_sqrt_k: bn::U256) -> i128 {
    // RESEARCH ONLY - mimic paper's alternative formula
    let p = bn::U256::from(market.amm.sqrt_k)
        .checked_mul(bn::U256::from(AMM_ASSET_AMOUNT_PRECISION))
        .unwrap()
        .checked_div(new_sqrt_k)
        .unwrap();

    let net_market_position = market.base_asset_amount;

    let net_market_position_sign = if net_market_position > 0 { 1 } else { -1 };

    let cost_numer_1_mantissa = p;

    let cost_denom_1 = p
        .checked_mul(bn::U256::from(market.amm.base_asset_reserve))
        .unwrap()
        .checked_div(bn::U256::from(AMM_ASSET_AMOUNT_PRECISION))
        .unwrap();

    if net_market_position > 0 {
        cost_denom_1
            .checked_add(bn::U256::from(net_market_position.unsigned_abs()))
            .unwrap();
    } else {
        cost_denom_1
            .checked_sub(bn::U256::from(net_market_position.unsigned_abs()))
            .unwrap();
    }

    let cost_numer_2_mantissa = bn::U256::from(AMM_ASSET_AMOUNT_PRECISION);

    // same as amm.sqrt_k
    let cost_denom_2;

    if net_market_position > 0 {
        cost_denom_2 = bn::U256::from(market.amm.base_asset_reserve)
            .checked_add(bn::U256::from(net_market_position.unsigned_abs()))
            .unwrap();
    } else {
        cost_denom_2 = bn::U256::from(market.amm.base_asset_reserve)
            .checked_sub(bn::U256::from(net_market_position.unsigned_abs()))
            .unwrap();
    }

    let cost_scalar = bn::U256::from(net_market_position.unsigned_abs())
        .checked_mul(bn::U256::from(market.amm.quote_asset_reserve))
        .unwrap();

    let cost_1 = cost_numer_1_mantissa
        .checked_mul(cost_scalar)
        .unwrap()
        .checked_div(cost_denom_1)
        .unwrap()
        .try_to_u128()
        .unwrap();

    let cost_2 = cost_numer_2_mantissa
        .checked_mul(cost_scalar)
        .unwrap()
        .checked_div(cost_denom_2)
        .unwrap()
        .try_to_u128()
        .unwrap();

    let cost = (cost_1 as i128)
        .checked_sub(cost_2 as i128)
        .unwrap()
        .checked_mul(net_market_position_sign)
        .unwrap()
        .checked_div(AMM_ASSET_AMOUNT_PRECISION as i128)
        .unwrap()
        .checked_div(
            AMM_ASSET_AMOUNT_PRECISION
                .checked_div(USDC_PRECISION)
                .unwrap() as i128,
        )
        .unwrap();

    if cost > market.amm.cumulative_fee_realized as i128 {
        //todo throw an error
        assert_eq!(cost, 0);
    }

    return cost;
}
