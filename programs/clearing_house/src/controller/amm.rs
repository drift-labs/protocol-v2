use std::cmp::{max, min};

use anchor_lang::prelude::*;
use solana_program::msg;

use crate::controller::position::PositionDirection;
use crate::controller::repeg::apply_cost_to_market;
use crate::controller::spot_balance::{
    transfer_revenue_pool_to_spot_balance, transfer_spot_balance_to_revenue_pool,
    transfer_spot_balances, update_spot_balances,
};
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::get_then_update_id;
use crate::math::amm::calculate_quote_asset_amount_swapped;
use crate::math::amm_spread::{calculate_spread_reserves, get_spread_reserves};
use crate::math::casting::{cast_to_i128, cast_to_i64, cast_to_u128, Cast};
use crate::math::constants::{
    CONCENTRATION_PRECISION, K_BPS_UPDATE_SCALE, MAX_CONCENTRATION_COEFFICIENT, MAX_K_BPS_INCREASE,
    PRICE_TO_PEG_PRECISION_RATIO,
};
use crate::math::cp_curve::get_update_k_result;
use crate::math::repeg::get_total_fee_lower_bound;
use crate::math::spot_balance::{get_token_amount, validate_spot_balances};
use crate::math::{amm, amm_spread, bn, cp_curve, quote_asset::*};
use crate::math_error;
use crate::state::events::CurveRecord;
use crate::state::oracle::OraclePriceData;
use crate::state::perp_market::{PerpMarket, AMM};
use crate::state::spot_market::{SpotBalance, SpotBalanceType, SpotMarket};
use crate::state::user::User;
use crate::validate;

#[cfg(test)]
#[path = "../../tests/controller/amm.rs"]
mod tests;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SwapDirection {
    Add,
    Remove,
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
    base_asset_swap_amount: u64,
    direction: SwapDirection,
    now: i64,
    precomputed_reserve_price: Option<u128>,
) -> ClearingHouseResult<(u64, i64)> {
    let position_direction = match direction {
        SwapDirection::Add => PositionDirection::Short,
        SwapDirection::Remove => PositionDirection::Long,
    };

    let reserve_price = match precomputed_reserve_price {
        Some(reserve_price) => reserve_price,
        None => amm.reserve_price()?,
    };

    amm::update_mark_twap(
        amm,
        now,
        Some(match position_direction {
            PositionDirection::Long => amm.ask_price(reserve_price)?,
            PositionDirection::Short => amm.bid_price(reserve_price)?,
        }),
        Some(position_direction),
    )?;

    let (
        new_base_asset_reserve,
        new_quote_asset_reserve,
        quote_asset_amount,
        quote_asset_amount_surplus,
    ) = calculate_base_swap_output_with_spread(amm, base_asset_swap_amount, direction)?;

    amm.base_asset_reserve = new_base_asset_reserve;
    amm.quote_asset_reserve = new_quote_asset_reserve;

    Ok((
        quote_asset_amount,
        quote_asset_amount_surplus.cast::<i64>()?,
    ))
}

pub fn calculate_base_swap_output_with_spread(
    amm: &AMM,
    base_asset_swap_amount: u64,
    direction: SwapDirection,
) -> ClearingHouseResult<(u128, u128, u64, u64)> {
    // first do the swap with spread reserves to figure out how much base asset is acquired
    let (base_asset_reserve_with_spread, quote_asset_reserve_with_spread) = get_spread_reserves(
        amm,
        match direction {
            SwapDirection::Add => PositionDirection::Short,
            SwapDirection::Remove => PositionDirection::Long,
        },
    )?;

    let (new_quote_asset_reserve_with_spread, _) = amm::calculate_swap_output(
        base_asset_swap_amount.cast()?,
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
        base_asset_swap_amount.cast()?,
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
        quote_asset_amount.cast::<u64>()?,
        quote_asset_amount_surplus.cast::<u64>()?,
    ))
}

#[allow(dead_code)]
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

pub fn update_spread_reserves(amm: &mut AMM) -> ClearingHouseResult {
    let (new_ask_base_asset_reserve, new_ask_quote_asset_reserve) =
        calculate_spread_reserves(amm, PositionDirection::Long)?;
    let (new_bid_base_asset_reserve, new_bid_quote_asset_reserve) =
        calculate_spread_reserves(amm, PositionDirection::Short)?;

    amm.ask_base_asset_reserve = new_ask_base_asset_reserve.min(amm.base_asset_reserve);
    amm.bid_base_asset_reserve = new_bid_base_asset_reserve.max(amm.base_asset_reserve);
    amm.ask_quote_asset_reserve = new_ask_quote_asset_reserve.max(amm.quote_asset_reserve);
    amm.bid_quote_asset_reserve = new_bid_quote_asset_reserve.min(amm.quote_asset_reserve);

    Ok(())
}

pub fn update_spreads(amm: &mut AMM, reserve_price: u128) -> ClearingHouseResult<(u128, u128)> {
    let (long_spread, short_spread) = if amm.curve_update_intensity > 0 {
        amm_spread::calculate_spread(
            amm.base_spread,
            amm.last_oracle_reserve_price_spread_pct,
            amm.last_oracle_conf_pct,
            amm.max_spread,
            amm.quote_asset_reserve,
            amm.terminal_quote_asset_reserve,
            amm.peg_multiplier,
            amm.base_asset_amount_with_amm,
            reserve_price,
            amm.total_fee_minus_distributions,
            amm.base_asset_reserve,
            amm.min_base_asset_reserve,
            amm.max_base_asset_reserve,
        )?
    } else {
        let half_base_spread = cast_to_u128(amm.base_spread / 2)?;
        (half_base_spread, half_base_spread)
    };

    amm.long_spread = long_spread;
    amm.short_spread = short_spread;

    update_spread_reserves(amm)?;

    Ok((long_spread, short_spread))
}

pub fn update_concentration_coef(amm: &mut AMM, scale: u128) -> ClearingHouseResult {
    validate!(scale > 0, ErrorCode::DefaultError, "invalid scale",)?;

    let new_concentration_coef =
        CONCENTRATION_PRECISION + (MAX_CONCENTRATION_COEFFICIENT - CONCENTRATION_PRECISION) / scale;

    validate!(
        new_concentration_coef > CONCENTRATION_PRECISION
            && new_concentration_coef <= MAX_CONCENTRATION_COEFFICIENT,
        ErrorCode::DefaultError,
        "invalid new_concentration_coef",
    )?;

    amm.concentration_coef = new_concentration_coef;

    let (_, terminal_quote_reserves, terminal_base_reserves) =
        amm::calculate_terminal_price_and_reserves(amm)?;

    validate!(
        terminal_quote_reserves == amm.terminal_quote_asset_reserve,
        ErrorCode::DefaultError,
        "invalid terminal_quote_reserves",
    )?;

    // updating the concentration_coef changes the min/max base_asset_reserve
    // doing so adds ability to improve amm constant product curve's slippage
    // by increasing k as same factor as scale w/o increasing imbalance risk
    let (min_base_asset_reserve, max_base_asset_reserve) =
        amm::calculate_bid_ask_bounds(amm.concentration_coef, terminal_base_reserves)?;

    amm.max_base_asset_reserve = max_base_asset_reserve;
    amm.min_base_asset_reserve = min_base_asset_reserve;

    let reserve_price_after = amm.reserve_price()?;
    update_spreads(amm, reserve_price_after)?;

    let (max_bids, max_asks) = amm::calculate_market_open_bids_asks(amm)?;
    validate!(
        max_bids > amm.base_asset_amount_with_amm && max_asks < amm.base_asset_amount_with_amm,
        ErrorCode::DefaultError,
        "amm.net_base_asset_amount exceeds the unload liquidity available after concentration adjustment"
    )?;

    Ok(())
}

pub fn formulaic_update_k(
    market: &mut PerpMarket,
    _oracle_price_data: &OraclePriceData,
    funding_imbalance_cost: i128,
    now: i64,
) -> ClearingHouseResult {
    let peg_multiplier_before = market.amm.peg_multiplier;
    let base_asset_reserve_before = market.amm.base_asset_reserve;
    let quote_asset_reserve_before = market.amm.quote_asset_reserve;
    let sqrt_k_before = market.amm.sqrt_k;

    let funding_imbalance_cost_i64 = cast_to_i64(funding_imbalance_cost)?;

    // calculate budget
    let budget = if funding_imbalance_cost_i64 < 0 {
        // negative cost is period revenue, if spread is low give back half in k increase
        if max(market.amm.long_spread, market.amm.short_spread)
            <= cast_to_u128(market.amm.base_spread)?
        {
            funding_imbalance_cost_i64
                .checked_div(2)
                .ok_or_else(math_error!())?
                .abs()
        } else {
            0
        }
    } else if market.amm.net_revenue_since_last_funding < funding_imbalance_cost_i64 {
        // cost exceeded period revenue, take back half in k decrease
        max(0, market.amm.net_revenue_since_last_funding)
            .checked_sub(funding_imbalance_cost_i64)
            .ok_or_else(math_error!())?
            .checked_div(2)
            .ok_or_else(math_error!())?
    } else {
        0
    };

    if budget > 0 || (budget < 0 && market.amm.can_lower_k()?) {
        // single k scale is capped by .1% increase and 2.2% decrease (regardless of budget)
        let k_update_max = K_BPS_UPDATE_SCALE
            + MAX_K_BPS_INCREASE * (market.amm.curve_update_intensity as i128) / 100;
        let (k_scale_numerator, k_scale_denominator) =
            cp_curve::calculate_budgeted_k_scale(market, cast_to_i128(budget)?, k_update_max)?;

        let new_sqrt_k = bn::U192::from(market.amm.sqrt_k)
            .checked_mul(bn::U192::from(k_scale_numerator))
            .ok_or_else(math_error!())?
            .checked_div(bn::U192::from(k_scale_denominator))
            .ok_or_else(math_error!())?;

        let update_k_result = get_update_k_result(market, new_sqrt_k, true)?;

        let adjustment_cost = cp_curve::adjust_k_cost(market, &update_k_result)?;

        let cost_applied = apply_cost_to_market(market, adjustment_cost, true)?;

        if cost_applied {
            cp_curve::update_k(market, &update_k_result)?;

            let peg_multiplier_after = market.amm.peg_multiplier;
            let base_asset_reserve_after = market.amm.base_asset_reserve;
            let quote_asset_reserve_after = market.amm.quote_asset_reserve;
            let sqrt_k_after = market.amm.sqrt_k;

            emit!(CurveRecord {
                ts: now,
                record_id: get_then_update_id!(market, next_curve_record_id),
                market_index: market.market_index,
                peg_multiplier_before,
                base_asset_reserve_before,
                quote_asset_reserve_before,
                sqrt_k_before,
                peg_multiplier_after,
                base_asset_reserve_after,
                quote_asset_reserve_after,
                sqrt_k_after,
                base_asset_amount_long: market.amm.base_asset_amount_long.unsigned_abs(),
                base_asset_amount_short: market.amm.base_asset_amount_short.unsigned_abs(),
                base_asset_amount_with_amm: market.amm.base_asset_amount_with_amm,
                number_of_users: market.number_of_users,
                adjustment_cost,
                total_fee: market.amm.total_fee,
                total_fee_minus_distributions: market.amm.total_fee_minus_distributions,
                oracle_price: market.amm.historical_oracle_data.last_oracle_price,
                fill_record: market.next_fill_record_id as u128,
            });
        }
    }
    Ok(())
}

pub fn get_fee_pool_tokens(
    perp_market: &mut PerpMarket,
    spot_market: &mut SpotMarket,
) -> ClearingHouseResult<i128> {
    let amm_fee_pool_token_amount = cast_to_i128(get_token_amount(
        perp_market.amm.fee_pool.balance(),
        spot_market,
        perp_market.amm.fee_pool.balance_type(),
    )?)?;

    Ok(amm_fee_pool_token_amount)
}

pub fn update_pool_balances(
    market: &mut PerpMarket,
    spot_market: &mut SpotMarket,
    user_unsettled_pnl: i128,
    now: i64,
) -> ClearingHouseResult<i128> {
    // current spot_market balance of amm fee pool
    let amm_fee_pool_token_amount = cast_to_i128(get_token_amount(
        market.amm.fee_pool.balance(),
        spot_market,
        market.amm.fee_pool.balance_type(),
    )?)?;

    let mut fraction_for_amm = 100;

    let amm_target_max_fee_pool_token_amount = market
        .amm
        .total_fee_minus_distributions
        .checked_add(cast_to_i128(market.amm.total_liquidation_fee)?)
        .ok_or_else(math_error!())?
        .checked_sub(cast_to_i128(market.amm.total_fee_withdrawn)?)
        .ok_or_else(math_error!())?;

    if amm_target_max_fee_pool_token_amount <= amm_fee_pool_token_amount {
        // owe the market pnl pool before settling user
        let pnl_pool_addition = max(0, amm_target_max_fee_pool_token_amount)
            .checked_sub(amm_fee_pool_token_amount)
            .ok_or_else(math_error!())?;

        if pnl_pool_addition < 0 {
            transfer_spot_balances(
                pnl_pool_addition.abs(),
                spot_market,
                &mut market.amm.fee_pool,
                &mut market.pnl_pool,
            )?;
        }

        fraction_for_amm = 0;
    }

    {
        let amm_target_min_fee_pool_token_amount = get_total_fee_lower_bound(market)?
            .checked_add(market.amm.total_liquidation_fee)
            .ok_or_else(math_error!())?
            .checked_sub(market.amm.total_fee_withdrawn)
            .ok_or_else(math_error!())?;

        let amm_fee_pool_token_amount = get_token_amount(
            market.amm.fee_pool.balance(),
            spot_market,
            market.amm.fee_pool.balance_type(),
        )?;

        if amm_fee_pool_token_amount < amm_target_min_fee_pool_token_amount {
            let pnl_pool_token_amount = get_token_amount(
                market.pnl_pool.balance(),
                spot_market,
                market.pnl_pool.balance_type(),
            )?;

            let pnl_pool_removal = amm_target_min_fee_pool_token_amount
                .checked_sub(amm_fee_pool_token_amount)
                .ok_or_else(math_error!())?
                .min(pnl_pool_token_amount);

            if pnl_pool_removal > 0 {
                transfer_spot_balances(
                    cast_to_i128(pnl_pool_removal)?,
                    spot_market,
                    &mut market.pnl_pool,
                    &mut market.amm.fee_pool,
                )?;
            }
        }

        let amm_fee_pool_token_amount_after = get_token_amount(
            market.amm.fee_pool.balance(),
            spot_market,
            market.amm.fee_pool.balance_type(),
        )?;

        if market.amm.total_fee_minus_distributions < 0 {
            // market can perform withdraw from revenue pool
            if spot_market.insurance_fund.last_revenue_settle_ts
                > market.insurance_claim.last_revenue_withdraw_ts
            {
                validate!(now >= market.insurance_claim.last_revenue_withdraw_ts && now >= spot_market.insurance_fund.last_revenue_settle_ts,
                    ErrorCode::DefaultError,
                    "issue with clock unix timestamp {} < market.insurance_claim.last_revenue_withdraw_ts={}/spot_market.last_revenue_settle_ts={}",
                    now,
                    market.insurance_claim.last_revenue_withdraw_ts,
                    spot_market.insurance_fund.last_revenue_settle_ts,
                )?;
                market.insurance_claim.revenue_withdraw_since_last_settle = 0;
            }

            let max_revenue_withdraw_allowed = market
                .insurance_claim
                .max_revenue_withdraw_per_period
                .checked_sub(market.insurance_claim.revenue_withdraw_since_last_settle)
                .ok_or_else(math_error!())?;

            if max_revenue_withdraw_allowed > 0 {
                let spot_market_revenue_pool_amount = get_token_amount(
                    spot_market.revenue_pool.balance,
                    spot_market,
                    &SpotBalanceType::Deposit,
                )?;

                let revenue_pool_transfer = market
                    .amm
                    .total_fee_minus_distributions
                    .unsigned_abs()
                    .min(spot_market_revenue_pool_amount)
                    .min(max_revenue_withdraw_allowed);

                transfer_revenue_pool_to_spot_balance(
                    revenue_pool_transfer,
                    spot_market,
                    &mut market.amm.fee_pool,
                )?;

                market.amm.total_fee_minus_distributions = market
                    .amm
                    .total_fee_minus_distributions
                    .checked_add(cast_to_i128(revenue_pool_transfer)?)
                    .ok_or_else(math_error!())?;

                market.insurance_claim.revenue_withdraw_since_last_settle = market
                    .insurance_claim
                    .revenue_withdraw_since_last_settle
                    .checked_add(revenue_pool_transfer)
                    .ok_or_else(math_error!())?;

                market.insurance_claim.last_revenue_withdraw_ts = now;
            }
        } else {
            let revenue_pool_transfer = cast_to_i128(get_total_fee_lower_bound(market)?)?
                .checked_add(cast_to_i128(market.amm.total_liquidation_fee)?)
                .ok_or_else(math_error!())?
                .checked_sub(cast_to_i128(market.amm.total_fee_withdrawn)?)
                .ok_or_else(math_error!())?
                .max(0)
                .min(cast_to_i128(amm_fee_pool_token_amount_after)?)
                .unsigned_abs();

            transfer_spot_balance_to_revenue_pool(
                revenue_pool_transfer,
                spot_market,
                &mut market.amm.fee_pool,
            )?;

            market.amm.total_fee_withdrawn = market
                .amm
                .total_fee_withdrawn
                .checked_add(revenue_pool_transfer)
                .ok_or_else(math_error!())?;
        }
    }

    // market pnl pool pays (what it can to) user_unsettled_pnl and pnl_to_settle_to_amm
    let pnl_pool_token_amount = get_token_amount(
        market.pnl_pool.balance(),
        spot_market,
        market.pnl_pool.balance_type(),
    )?;

    let pnl_to_settle_with_user = if user_unsettled_pnl > 0 {
        min(user_unsettled_pnl, cast_to_i128(pnl_pool_token_amount)?)
    } else {
        user_unsettled_pnl
    };

    let pnl_fraction_for_amm = if fraction_for_amm > 0 {
        let pnl_fraction_for_amm = pnl_to_settle_with_user
            .checked_div(fraction_for_amm)
            .ok_or_else(math_error!())?;
        update_spot_balances(
            pnl_fraction_for_amm.unsigned_abs(),
            &SpotBalanceType::Deposit,
            spot_market,
            &mut market.amm.fee_pool,
            false,
        )?;
        pnl_fraction_for_amm
    } else {
        0
    };

    let pnl_to_settle_with_market = -(pnl_to_settle_with_user
        .checked_sub(pnl_fraction_for_amm)
        .ok_or_else(math_error!())?);

    update_spot_balances(
        pnl_to_settle_with_market.unsigned_abs(),
        if pnl_to_settle_with_market >= 0 {
            &SpotBalanceType::Deposit
        } else {
            &SpotBalanceType::Borrow
        },
        spot_market,
        &mut market.pnl_pool,
        false,
    )?;

    let _depositors_claim = validate_spot_balances(spot_market)?;

    Ok(pnl_to_settle_with_user)
}

pub fn update_pnl_pool_and_user_balance(
    market: &mut PerpMarket,
    bank: &mut SpotMarket,
    user: &mut User,
    unrealized_pnl_with_fee: i128,
) -> ClearingHouseResult<i128> {
    let pnl_to_settle_with_user = if unrealized_pnl_with_fee > 0 {
        unrealized_pnl_with_fee.min(cast_to_i128(get_token_amount(
            market.pnl_pool.balance,
            bank,
            market.pnl_pool.balance_type(),
        )?)?)
    } else {
        unrealized_pnl_with_fee
    };

    validate!(
        unrealized_pnl_with_fee == pnl_to_settle_with_user,
        ErrorCode::DefaultError,
        "pnl_pool_amount doesnt have enough ({} < {})",
        pnl_to_settle_with_user,
        unrealized_pnl_with_fee
    )?;

    if unrealized_pnl_with_fee == 0 {
        msg!(
            "User has no unsettled pnl for market {}",
            market.market_index
        );
        return Ok(0);
    } else if pnl_to_settle_with_user == 0 {
        msg!(
            "Pnl Pool cannot currently settle with user for market {}",
            market.market_index
        );
        return Ok(0);
    }

    let user_spot_position = user.get_quote_spot_position_mut();

    transfer_spot_balances(
        pnl_to_settle_with_user,
        bank,
        &mut market.pnl_pool,
        user_spot_position,
    )?;

    Ok(pnl_to_settle_with_user)
}

pub fn move_price(
    amm: &mut AMM,
    base_asset_reserve: u128,
    quote_asset_reserve: u128,
    sqrt_k: u128,
) -> ClearingHouseResult {
    amm.base_asset_reserve = base_asset_reserve;

    let k = bn::U256::from(sqrt_k)
        .checked_mul(bn::U256::from(sqrt_k))
        .ok_or_else(math_error!())?;

    amm.quote_asset_reserve = k
        .checked_div(bn::U256::from(base_asset_reserve))
        .ok_or_else(math_error!())?
        .try_to_u128()?;

    validate!(
        (cast_to_i128(quote_asset_reserve)? - cast_to_i128(amm.quote_asset_reserve)?).abs() < 100,
        ErrorCode::DefaultError,
        "quote_asset_reserve passed doesnt reconcile enough"
    )?;

    amm.sqrt_k = sqrt_k;

    let (_, terminal_quote_reserves, terminal_base_reserves) =
        amm::calculate_terminal_price_and_reserves(amm)?;
    amm.terminal_quote_asset_reserve = terminal_quote_reserves;

    let (min_base_asset_reserve, max_base_asset_reserve) =
        amm::calculate_bid_ask_bounds(amm.concentration_coef, terminal_base_reserves)?;

    amm.max_base_asset_reserve = max_base_asset_reserve;
    amm.min_base_asset_reserve = min_base_asset_reserve;

    let reserve_price_after = amm.reserve_price()?;
    update_spreads(amm, reserve_price_after)?;

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
