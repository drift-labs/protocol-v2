use crate::controller::position::PositionDirection;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::get_then_update_id;
use crate::math::amm::{
    calculate_quote_asset_amount_swapped, calculate_spread_reserves, get_spread_reserves,
    get_update_k_result,
};
use crate::math::casting::{cast_to_i128, cast_to_i64, cast_to_u128};
use crate::math::constants::{
    CONCENTRATION_PRECISION, K_BPS_INCREASE_MAX, K_BPS_UPDATE_SCALE, MAX_CONCENTRATION_COEFFICIENT,
    PRICE_TO_PEG_PRECISION_RATIO,
};
use crate::math::repeg::get_total_fee_lower_bound;
use crate::math::spot_balance::{get_token_amount, validate_spot_balances};
use crate::math::{amm, bn, quote_asset::*};
use crate::math_error;
use crate::state::events::CurveRecord;
use crate::state::market::{PerpMarket, AMM};
use crate::state::oracle::OraclePriceData;
use crate::state::user::User;
use crate::validate;
use anchor_lang::prelude::*;
use solana_program::msg;
use std::cmp::{max, min};

use crate::controller::repeg::apply_cost_to_market;
use crate::controller::spot_balance::{update_revenue_pool_balances, update_spot_balances};
use crate::controller::spot_position::update_spot_position_balance;
use crate::state::spot_market::{SpotBalance, SpotBalanceType, SpotMarket};

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
    base_asset_swap_amount: u128,
    direction: SwapDirection,
    now: i64,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<(u128, i128)> {
    let position_direction = match direction {
        SwapDirection::Add => PositionDirection::Short,
        SwapDirection::Remove => PositionDirection::Long,
    };

    let mark_price = match precomputed_mark_price {
        Some(mark_price) => mark_price,
        None => amm.mark_price()?,
    };

    amm::update_mark_twap(
        amm,
        now,
        Some(match position_direction {
            PositionDirection::Long => amm.ask_price(mark_price)?,
            PositionDirection::Short => amm.bid_price(mark_price)?,
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
        cast_to_i128(quote_asset_amount_surplus)?,
    ))
}

pub fn calculate_base_swap_output_with_spread(
    amm: &AMM,
    base_asset_swap_amount: u128,
    direction: SwapDirection,
) -> ClearingHouseResult<(u128, u128, u128, u128)> {
    // first do the swap with spread reserves to figure out how much base asset is acquired
    let (base_asset_reserve_with_spread, quote_asset_reserve_with_spread) = get_spread_reserves(
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

pub fn update_spreads(amm: &mut AMM, mark_price: u128) -> ClearingHouseResult<(u128, u128)> {
    let (long_spread, short_spread) = if amm.curve_update_intensity > 0 {
        amm::calculate_spread(
            amm.base_spread,
            amm.last_oracle_mark_spread_pct,
            amm.last_oracle_conf_pct,
            amm.max_spread,
            amm.quote_asset_reserve,
            amm.terminal_quote_asset_reserve,
            amm.peg_multiplier,
            amm.net_base_asset_amount,
            mark_price,
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

    let (new_ask_base_asset_reserve, new_ask_quote_asset_reserve) =
        calculate_spread_reserves(amm, PositionDirection::Long)?;
    let (new_bid_base_asset_reserve, new_bid_quote_asset_reserve) =
        calculate_spread_reserves(amm, PositionDirection::Short)?;

    amm.ask_base_asset_reserve = new_ask_base_asset_reserve.min(amm.base_asset_reserve);
    amm.bid_base_asset_reserve = new_bid_base_asset_reserve.max(amm.base_asset_reserve);
    amm.ask_quote_asset_reserve = new_ask_quote_asset_reserve.max(amm.quote_asset_reserve);
    amm.bid_quote_asset_reserve = new_bid_quote_asset_reserve.min(amm.quote_asset_reserve);

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

    let mark_price_after = amm.mark_price()?;
    update_spreads(amm, mark_price_after)?;

    let (max_bids, max_asks) = amm::calculate_market_open_bids_asks(amm)?;
    validate!(
        max_bids > amm.net_base_asset_amount && max_asks < amm.net_base_asset_amount,
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
            + K_BPS_INCREASE_MAX * (market.amm.curve_update_intensity as i128) / 100;
        let (k_scale_numerator, k_scale_denominator) =
            amm::calculate_budgeted_k_scale(market, cast_to_i128(budget)?, k_update_max)?;

        let new_sqrt_k = bn::U192::from(market.amm.sqrt_k)
            .checked_mul(bn::U192::from(k_scale_numerator))
            .ok_or_else(math_error!())?
            .checked_div(bn::U192::from(k_scale_denominator))
            .ok_or_else(math_error!())?;

        let update_k_result = get_update_k_result(market, new_sqrt_k, true)?;

        let adjustment_cost = amm::adjust_k_cost(market, &update_k_result)?;

        let cost_applied = apply_cost_to_market(market, adjustment_cost, true)?;

        if cost_applied {
            amm::update_k(market, &update_k_result)?;

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
                base_asset_amount_long: market.base_asset_amount_long.unsigned_abs(),
                base_asset_amount_short: market.base_asset_amount_short.unsigned_abs(),
                net_base_asset_amount: market.amm.net_base_asset_amount,
                open_interest: market.open_interest,
                adjustment_cost,
                total_fee: market.amm.total_fee,
                total_fee_minus_distributions: market.amm.total_fee_minus_distributions,
                oracle_price: market.amm.last_oracle_price,
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
            update_spot_balances(
                pnl_pool_addition.unsigned_abs(),
                &SpotBalanceType::Borrow,
                spot_market,
                &mut market.amm.fee_pool,
                false,
            )?;

            update_spot_balances(
                pnl_pool_addition.unsigned_abs(),
                &SpotBalanceType::Deposit,
                spot_market,
                &mut market.pnl_pool,
                false,
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
                update_spot_balances(
                    pnl_pool_removal,
                    &SpotBalanceType::Borrow,
                    spot_market,
                    &mut market.pnl_pool,
                    false,
                )?;

                update_spot_balances(
                    pnl_pool_removal,
                    &SpotBalanceType::Deposit,
                    spot_market,
                    &mut market.amm.fee_pool,
                    false,
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
            if spot_market.last_revenue_settle_ts > market.last_revenue_withdraw_ts {
                validate!(now >= market.last_revenue_withdraw_ts && now >= spot_market.last_revenue_settle_ts,
                    ErrorCode::DefaultError,
                    "issue with clock unix timestamp {} < market.last_revenue_withdraw_ts={}/spot_market.last_revenue_settle_ts={}",
                    now,
                    market.last_revenue_withdraw_ts,
                    spot_market.last_revenue_settle_ts,
                )?;
                market.revenue_withdraw_since_last_settle = 0;
            }

            let max_revenue_withdraw_allowed = market
                .max_revenue_withdraw_per_period
                .checked_sub(market.revenue_withdraw_since_last_settle)
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

                update_revenue_pool_balances(
                    revenue_pool_transfer,
                    &SpotBalanceType::Borrow,
                    spot_market,
                )?;

                update_spot_balances(
                    revenue_pool_transfer,
                    &SpotBalanceType::Deposit,
                    spot_market,
                    &mut market.amm.fee_pool,
                    false,
                )?;

                market.amm.total_fee_minus_distributions = market
                    .amm
                    .total_fee_minus_distributions
                    .checked_add(cast_to_i128(revenue_pool_transfer)?)
                    .ok_or_else(math_error!())?;

                market.revenue_withdraw_since_last_settle = market
                    .revenue_withdraw_since_last_settle
                    .checked_add(revenue_pool_transfer)
                    .ok_or_else(math_error!())?;

                market.last_revenue_withdraw_ts = now;
            }
        } else {
            let revenue_pool_transfer = cast_to_i128(get_total_fee_lower_bound(market)?)?
                .checked_add(cast_to_i128(market.amm.total_liquidation_fee)?)
                .ok_or_else(math_error!())?
                .checked_sub(cast_to_i128(market.amm.total_fee_withdrawn)?)
                .ok_or_else(math_error!())?
                .max(0)
                .min(cast_to_i128(amm_fee_pool_token_amount_after)?);

            update_spot_balances(
                revenue_pool_transfer.unsigned_abs(),
                &SpotBalanceType::Borrow,
                spot_market,
                &mut market.amm.fee_pool,
                false,
            )?;

            update_revenue_pool_balances(
                revenue_pool_transfer.unsigned_abs(),
                &SpotBalanceType::Deposit,
                spot_market,
            )?;

            market.amm.total_fee_withdrawn = market
                .amm
                .total_fee_withdrawn
                .checked_add(revenue_pool_transfer.unsigned_abs())
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

    update_spot_balances(
        pnl_to_settle_with_user.unsigned_abs(),
        if pnl_to_settle_with_user < 0 {
            &SpotBalanceType::Deposit
        } else {
            &SpotBalanceType::Borrow
        },
        bank,
        &mut market.pnl_pool,
        false,
    )?;

    let user_spot_position = user.get_quote_spot_position_mut();
    update_spot_position_balance(
        pnl_to_settle_with_user.unsigned_abs(),
        if pnl_to_settle_with_user > 0 {
            &SpotBalanceType::Deposit
        } else {
            &SpotBalanceType::Borrow
        },
        bank,
        user_spot_position,
        false,
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

    let mark_price_after = amm.mark_price()?;
    update_spreads(amm, mark_price_after)?;

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

#[cfg(test)]
mod test {
    use super::*;
    use crate::controller::insurance::settle_revenue_to_insurance_fund;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, MARK_PRICE_PRECISION, MAX_CONCENTRATION_COEFFICIENT,
        QUOTE_PRECISION, SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_INTEREST_PRECISION,
    };
    use crate::state::market::PoolBalance;

    #[test]
    fn concentration_coef_tests() {
        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 5122950819670000,
                quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
                terminal_quote_asset_reserve: 500 * AMM_RESERVE_PRECISION,
                sqrt_k: 500 * AMM_RESERVE_PRECISION,
                peg_multiplier: 50000,
                concentration_coef: MAX_CONCENTRATION_COEFFICIENT,
                net_base_asset_amount: -122950819670000,
                total_fee_minus_distributions: 1000 * QUOTE_PRECISION as i128,
                curve_update_intensity: 100,
                ..AMM::default()
            },
            ..PerpMarket::default()
        };

        assert!(update_concentration_coef(&mut market.amm, 0).is_err());

        let new_scale = 1;
        update_concentration_coef(&mut market.amm, new_scale).unwrap();
        assert_eq!(market.amm.min_base_asset_reserve, 3535567812190637);
        assert_eq!(market.amm.max_base_asset_reserve, 7071000000000000);

        let (orig_open_bids, orig_open_asks) =
            amm::calculate_market_open_bids_asks(&market.amm).unwrap();
        assert_eq!(orig_open_bids, 1587383007479363);
        assert_eq!(orig_open_asks, -1948049180330000);

        let new_scale = 2;
        update_concentration_coef(&mut market.amm, new_scale).unwrap();
        assert_eq!(market.amm.min_base_asset_reserve, 4142158893215143);
        assert_eq!(market.amm.max_base_asset_reserve, 6035500000000000);

        let new_scale = 5;
        update_concentration_coef(&mut market.amm, new_scale).unwrap();
        assert_eq!(market.amm.min_base_asset_reserve, 4617487348084666);
        assert_eq!(market.amm.max_base_asset_reserve, 5414200000000000);
        let new_sqrt_k = market.amm.sqrt_k * new_scale;
        let update_k_result =
            get_update_k_result(&market, bn::U192::from(new_sqrt_k), false).unwrap();
        let adjustment_cost = amm::adjust_k_cost(&mut market, &update_k_result).unwrap();
        assert_eq!(adjustment_cost, 11_575_563);

        amm::update_k(&mut market, &update_k_result).unwrap();
        assert_eq!(market.amm.sqrt_k, new_sqrt_k);

        let (open_bids, open_asks) = amm::calculate_market_open_bids_asks(&market.amm).unwrap();
        assert_eq!(open_bids, 2073138274516378);
        assert_eq!(open_asks, -1988790163935851);

        assert_eq!(orig_open_bids - open_bids, -485755267037015);
        assert_eq!(orig_open_asks - open_asks, 40740983605851);

        let new_scale = 100; // moves boundary to prevent net_base_asset_amount to close
        assert!(update_concentration_coef(&mut market.amm, new_scale).is_err());

        // differe default market

        let mut market_balanced = PerpMarket::default_test();
        assert_eq!(market_balanced.amm.net_base_asset_amount, 0);
        assert_eq!(market_balanced.amm.sqrt_k, 1000000000000000);

        let new_scale = 20;
        update_concentration_coef(&mut market_balanced.amm, new_scale).unwrap();
        assert_eq!(market_balanced.amm.min_base_asset_reserve, 979710201722330);
        assert_eq!(market_balanced.amm.max_base_asset_reserve, 1020710000000000);

        let new_scale = AMM_RESERVE_PRECISION; // too large, err
        assert!(update_concentration_coef(&mut market_balanced.amm, new_scale).is_err());
        assert_eq!(market_balanced.amm.min_base_asset_reserve, 979710201722330);
        assert_eq!(market_balanced.amm.max_base_asset_reserve, 1020710000000000);

        let new_scale = 140000; // near limit, very little liquidity
        update_concentration_coef(&mut market_balanced.amm, new_scale).unwrap();
        assert_eq!(market_balanced.amm.min_base_asset_reserve, 999998000003999);
        assert_eq!(market_balanced.amm.max_base_asset_reserve, 1000002000000000);

        let new_sqrt_k = market_balanced.amm.sqrt_k * new_scale;
        let update_k_result =
            get_update_k_result(&market_balanced, bn::U192::from(new_sqrt_k), false).unwrap();
        let adjustment_cost = amm::adjust_k_cost(&mut market_balanced, &update_k_result).unwrap();
        assert_eq!(adjustment_cost, 0);

        amm::update_k(&mut market_balanced, &update_k_result).unwrap();
        assert_eq!(market_balanced.amm.sqrt_k, new_sqrt_k);

        let (open_bids, open_asks) =
            amm::calculate_market_open_bids_asks(&market_balanced.amm).unwrap();
        assert_eq!(open_bids, 279999440001120);
        assert_eq!(open_asks, -280000000000000);
    }

    #[test]
    fn formualic_k_tests() {
        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 5122950819670000,
                quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
                sqrt_k: 500 * AMM_RESERVE_PRECISION,
                peg_multiplier: 50000,
                concentration_coef: MAX_CONCENTRATION_COEFFICIENT,
                net_base_asset_amount: -122950819670000,
                total_fee_minus_distributions: 1000 * QUOTE_PRECISION as i128,
                curve_update_intensity: 100,
                ..AMM::default()
            },
            ..PerpMarket::default()
        };

        let prev_sqrt_k = market.amm.sqrt_k;

        // let mark_price = market.amm.mark_price().unwrap();
        let now = 10000;
        let oracle_price_data = OraclePriceData {
            price: (50 * MARK_PRICE_PRECISION) as i128,
            confidence: 0,
            delay: 2,
            has_sufficient_number_of_data_points: true,
        };

        // zero funding cost
        let funding_cost: i128 = 0;
        formulaic_update_k(&mut market, &oracle_price_data, funding_cost, now).unwrap();
        assert_eq!(prev_sqrt_k, market.amm.sqrt_k);

        // positive means amm supossedly paid $500 in funding payments for interval
        let funding_cost_2: i128 = (500 * QUOTE_PRECISION) as i128;
        formulaic_update_k(&mut market, &oracle_price_data, funding_cost_2, now).unwrap();

        assert!(prev_sqrt_k > market.amm.sqrt_k);
        assert_eq!(market.amm.sqrt_k, 4890000000000000); // max k decrease (2.2%)
        assert_eq!(market.amm.total_fee_minus_distributions, 1000332075); //$.33 acquired from slippage increase

        // negative means amm recieved $500 in funding payments for interval
        let funding_cost_2: i128 = -((500 * QUOTE_PRECISION) as i128);
        formulaic_update_k(&mut market, &oracle_price_data, funding_cost_2, now).unwrap();

        assert_eq!(market.amm.sqrt_k, 4894890000000000); // max k increase (.1%)
        assert_eq!(market.amm.total_fee_minus_distributions, 1000316988); //$.33 acquired from slippage increase

        // negative means amm recieved $.001 in funding payments for interval
        let funding_cost_2: i128 = -((QUOTE_PRECISION / 1000) as i128);
        formulaic_update_k(&mut market, &oracle_price_data, funding_cost_2, now).unwrap();

        // new numbers bc of increased sqrt_k precision
        assert_eq!(market.amm.sqrt_k, 4895052229260015); // increase k by 1.00003314258x
        assert_eq!(market.amm.total_fee_minus_distributions, 1000316488); // ~$.005 spent from slippage decrease
                                                                          // todo: (316988-316491)/1e6 * 2 = 0.000994 < .001
    }

    #[test]
    fn update_pool_balances_test() {
        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 5122950819670000,
                quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
                sqrt_k: 500 * AMM_RESERVE_PRECISION,
                peg_multiplier: 50000,
                net_base_asset_amount: -122950819670000,
                total_fee_minus_distributions: 1000 * QUOTE_PRECISION as i128,
                curve_update_intensity: 100,
                ..AMM::default()
            },
            ..PerpMarket::default()
        };
        let now = 33928058;

        let mut spot_market = SpotMarket {
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            ..SpotMarket::default()
        };
        let to_settle_with_user =
            update_pool_balances(&mut market, &mut spot_market, 100, now).unwrap();
        assert_eq!(to_settle_with_user, 0);

        let to_settle_with_user =
            update_pool_balances(&mut market, &mut spot_market, -100, now).unwrap();
        assert_eq!(to_settle_with_user, -100);
        assert!(market.amm.fee_pool.balance() > 0);

        let amm_fee_pool_token_amount = get_token_amount(
            market.amm.fee_pool.balance(),
            &spot_market,
            market.amm.fee_pool.balance_type(),
        )
        .unwrap();
        let pnl_pool_token_amount = get_token_amount(
            market.pnl_pool.balance(),
            &spot_market,
            market.pnl_pool.balance_type(),
        )
        .unwrap();
        assert_eq!(pnl_pool_token_amount, 99);
        assert_eq!(amm_fee_pool_token_amount, 1);

        let to_settle_with_user =
            update_pool_balances(&mut market, &mut spot_market, 100, now).unwrap();
        assert_eq!(to_settle_with_user, 99);
        let amm_fee_pool_token_amount = get_token_amount(
            market.amm.fee_pool.balance(),
            &spot_market,
            market.amm.fee_pool.balance_type(),
        )
        .unwrap();
        let pnl_pool_token_amount = get_token_amount(
            market.pnl_pool.balance(),
            &spot_market,
            market.pnl_pool.balance_type(),
        )
        .unwrap();
        assert_eq!(pnl_pool_token_amount, 0);
        assert_eq!(amm_fee_pool_token_amount, 1);

        market.amm.total_fee_minus_distributions = 0;
        update_pool_balances(&mut market, &mut spot_market, -1, now).unwrap();
        let amm_fee_pool_token_amount = get_token_amount(
            market.amm.fee_pool.balance(),
            &spot_market,
            market.amm.fee_pool.balance_type(),
        )
        .unwrap();
        let pnl_pool_token_amount = get_token_amount(
            market.pnl_pool.balance(),
            &spot_market,
            market.pnl_pool.balance_type(),
        )
        .unwrap();
        assert_eq!(pnl_pool_token_amount, 2);
        assert_eq!(amm_fee_pool_token_amount, 0);

        market.amm.total_fee_minus_distributions = 90_000 * QUOTE_PRECISION as i128;
        update_pool_balances(
            &mut market,
            &mut spot_market,
            -(100_000 * QUOTE_PRECISION as i128),
            now,
        )
        .unwrap();
        let amm_fee_pool_token_amount = get_token_amount(
            market.amm.fee_pool.balance(),
            &spot_market,
            market.amm.fee_pool.balance_type(),
        )
        .unwrap();
        let pnl_pool_token_amount = get_token_amount(
            market.pnl_pool.balance(),
            &spot_market,
            market.pnl_pool.balance_type(),
        )
        .unwrap();
        assert_eq!(pnl_pool_token_amount, 99_000_000_000 + 2);
        assert_eq!(amm_fee_pool_token_amount, (1_000 * QUOTE_PRECISION));

        // negative fee pool
        market.amm.total_fee_minus_distributions = -8_008_123_456;

        update_pool_balances(&mut market, &mut spot_market, 1_000_987_789, now).unwrap();
        let amm_fee_pool_token_amount = get_token_amount(
            market.amm.fee_pool.balance(),
            &spot_market,
            market.amm.fee_pool.balance_type(),
        )
        .unwrap();
        let pnl_pool_token_amount = get_token_amount(
            market.pnl_pool.balance(),
            &spot_market,
            market.pnl_pool.balance_type(),
        )
        .unwrap();
        assert_eq!(pnl_pool_token_amount, 99_000_000_000 + 2 - 987_789);
        assert_eq!(amm_fee_pool_token_amount, 0);
    }

    #[test]
    fn update_pool_balances_fee_to_revenue_test() {
        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 5122950819670000,
                quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
                sqrt_k: 500 * AMM_RESERVE_PRECISION,
                peg_multiplier: 50000,
                net_base_asset_amount: -122950819670000,

                total_exchange_fee: 10 * QUOTE_PRECISION,
                total_fee: 10 * QUOTE_PRECISION as i128,
                total_mm_fee: 990 * QUOTE_PRECISION as i128,
                total_fee_minus_distributions: 1000 * QUOTE_PRECISION as i128,
                total_liquidation_fee: QUOTE_PRECISION,

                curve_update_intensity: 100,

                fee_pool: PoolBalance {
                    balance: 50 * QUOTE_PRECISION * SPOT_INTEREST_PRECISION,
                },
                ..AMM::default()
            },
            pnl_pool: PoolBalance {
                balance: 50 * QUOTE_PRECISION * SPOT_INTEREST_PRECISION,
            },
            ..PerpMarket::default()
        };
        let now = 33928058;

        let mut spot_market = SpotMarket {
            deposit_balance: 100 * QUOTE_PRECISION * SPOT_INTEREST_PRECISION,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            revenue_pool: PoolBalance { balance: 0 },
            ..SpotMarket::default()
        };

        let prev_fee_pool = market.amm.fee_pool.balance;
        let prev_pnl_pool = market.amm.fee_pool.balance;
        let prev_rev_pool = spot_market.revenue_pool.balance;

        assert_eq!(market.amm.total_fee_withdrawn, 0);

        assert_eq!(
            get_token_amount(
                market.amm.fee_pool.balance(),
                &spot_market,
                &SpotBalanceType::Deposit
            )
            .unwrap(),
            50 * QUOTE_PRECISION
        );

        assert_eq!(
            get_token_amount(
                spot_market.deposit_balance,
                &spot_market,
                &SpotBalanceType::Deposit
            )
            .unwrap(),
            100 * QUOTE_PRECISION
        );

        update_pool_balances(&mut market, &mut spot_market, 0, now).unwrap();

        assert_eq!(market.amm.fee_pool.balance, 44000000000000);
        assert_eq!(market.pnl_pool.balance, 50000000000000);
        assert_eq!(spot_market.revenue_pool.balance, 6000000000000);
        assert_eq!(market.amm.total_fee_withdrawn, 6000000);

        assert!(market.amm.fee_pool.balance < prev_fee_pool);
        assert_eq!(market.pnl_pool.balance, prev_pnl_pool);
        assert!(spot_market.revenue_pool.balance > prev_rev_pool);
    }

    #[test]
    fn update_pool_balances_revenue_to_fee_test() {
        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 5122950819670000,
                quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
                sqrt_k: 500 * AMM_RESERVE_PRECISION,
                peg_multiplier: 50000,
                net_base_asset_amount: -122950819670000,

                total_exchange_fee: 10 * QUOTE_PRECISION,
                total_fee: 10 * QUOTE_PRECISION as i128,
                total_mm_fee: 990 * QUOTE_PRECISION as i128,
                total_fee_minus_distributions: -(10000 * QUOTE_PRECISION as i128),

                curve_update_intensity: 100,

                fee_pool: PoolBalance {
                    balance: 50 * SPOT_INTEREST_PRECISION,
                },
                ..AMM::default()
            },
            pnl_pool: PoolBalance {
                balance: 50 * SPOT_INTEREST_PRECISION,
            },
            ..PerpMarket::default()
        };
        let now = 33928058;

        let mut spot_market = SpotMarket {
            deposit_balance: 200 * SPOT_INTEREST_PRECISION,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            revenue_pool: PoolBalance {
                balance: 100 * SPOT_INTEREST_PRECISION,
            },
            decimals: 6,
            ..SpotMarket::default()
        };

        let prev_fee_pool = market.amm.fee_pool.balance;
        let prev_pnl_pool = market.amm.fee_pool.balance;
        let prev_rev_pool = spot_market.revenue_pool.balance;
        let prev_tfmd = market.amm.total_fee_minus_distributions;

        assert_eq!(market.amm.total_fee_withdrawn, 0);

        assert_eq!(
            get_token_amount(
                market.amm.fee_pool.balance(),
                &spot_market,
                &SpotBalanceType::Deposit
            )
            .unwrap(),
            50 * QUOTE_PRECISION
        );

        assert_eq!(
            get_token_amount(
                spot_market.deposit_balance,
                &spot_market,
                &SpotBalanceType::Deposit
            )
            .unwrap(),
            200 * QUOTE_PRECISION
        );
        assert_eq!(spot_market.revenue_pool.balance, 100000000);

        update_pool_balances(&mut market, &mut spot_market, 0, now).unwrap();

        assert_eq!(market.amm.fee_pool.balance, 5000000);
        assert_eq!(market.pnl_pool.balance, 95000000);
        assert_eq!(spot_market.revenue_pool.balance, 100000000);
        assert_eq!(market.amm.total_fee_withdrawn, 0);
        assert_eq!(market.amm.total_fee_minus_distributions, prev_tfmd);

        assert!(market.amm.fee_pool.balance < prev_fee_pool);
        assert_eq!(market.pnl_pool.balance > prev_pnl_pool, true);
        assert_eq!(spot_market.revenue_pool.balance == prev_rev_pool, true);
        assert_eq!(market.revenue_withdraw_since_last_settle, 0);
        assert_eq!(market.last_revenue_withdraw_ts, 0);

        market.max_revenue_withdraw_per_period = 100000000 * 2;
        assert_eq!(spot_market.deposit_balance, 200000000);
        assert_eq!(spot_market.revenue_pool.balance, 100000000);

        update_pool_balances(&mut market, &mut spot_market, 0, now).unwrap();

        assert_eq!(market.amm.fee_pool.balance, 105000000);
        assert_eq!(market.pnl_pool.balance, 95000000);
        assert_eq!(spot_market.revenue_pool.balance, 0);
        assert_eq!(market.amm.total_fee_withdrawn, 0);
        assert_eq!(market.amm.total_fee_minus_distributions, -9900000000);
        assert_eq!(market.revenue_withdraw_since_last_settle, 100000000);
        assert_eq!(market.last_revenue_withdraw_ts, 33928058);

        let spot_market_vault_amount = get_token_amount(
            spot_market.deposit_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap() as u64;
        assert_eq!(spot_market_vault_amount, 200000000); // total spot_market deposit balance unchanged during transfers

        // calling multiple times doesnt effect other than fee pool -> pnl pool
        update_pool_balances(&mut market, &mut spot_market, 0, now).unwrap();
        assert_eq!(market.amm.fee_pool.balance, 5000000);
        assert_eq!(market.pnl_pool.balance, 195000000);
        assert_eq!(market.amm.total_fee_minus_distributions, -9900000000);
        assert_eq!(market.amm.total_fee_withdrawn, 0);
        assert_eq!(spot_market.revenue_pool.balance, 0);

        update_pool_balances(&mut market, &mut spot_market, 0, now).unwrap();
        assert_eq!(market.amm.fee_pool.balance, 5000000);
        assert_eq!(market.pnl_pool.balance, 195000000);
        assert_eq!(market.amm.total_fee_minus_distributions, -9900000000);
        assert_eq!(market.amm.total_fee_withdrawn, 0);
        assert_eq!(spot_market.revenue_pool.balance, 0);

        // add deposits and revenue to pool
        assert_eq!(spot_market.deposit_balance, 200000000);
        spot_market.revenue_pool.balance = 9900000001;

        let spot_market_backup = spot_market;
        let market_backup = market;
        assert!(update_pool_balances(&mut market, &mut spot_market, 0, now).is_err()); // assert is_err if any way has revenue pool above deposit balances
        spot_market = spot_market_backup;
        market = market_backup;
        spot_market.deposit_balance += 9900000001;
        let spot_market_vault_amount = get_token_amount(
            spot_market.deposit_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap() as u64;
        assert_eq!(spot_market.deposit_balance, 10100000001);
        assert_eq!(spot_market_vault_amount, 10100000001);

        update_pool_balances(&mut market, &mut spot_market, 0, now).unwrap();
        assert_eq!(spot_market.deposit_balance, 10100000001);
        assert_eq!(spot_market.revenue_pool.balance, 9800000001);
        assert_eq!(market.amm.fee_pool.balance, 105000000);
        assert_eq!(market.pnl_pool.balance, 195000000);
        assert_eq!(market.amm.total_fee_minus_distributions, -9800000000);
        assert_eq!(market.amm.total_fee_withdrawn, 0);
        assert_eq!(
            market.revenue_withdraw_since_last_settle,
            market.max_revenue_withdraw_per_period
        );
        assert_eq!(market.last_revenue_withdraw_ts, 33928058);

        // calling again only does fee -> pnl pool
        update_pool_balances(&mut market, &mut spot_market, 0, now).unwrap();
        assert_eq!(market.amm.fee_pool.balance, 5000000);
        assert_eq!(market.pnl_pool.balance, 295000000);
        assert_eq!(market.amm.total_fee_minus_distributions, -9800000000);
        assert_eq!(market.amm.total_fee_withdrawn, 0);
        assert_eq!(spot_market.revenue_pool.balance, 9800000001);
        assert_eq!(
            market.revenue_withdraw_since_last_settle,
            market.max_revenue_withdraw_per_period
        );
        assert_eq!(market.last_revenue_withdraw_ts, 33928058);

        // calling again does nothing
        update_pool_balances(&mut market, &mut spot_market, 0, now).unwrap();
        assert_eq!(market.amm.fee_pool.balance, 5000000);
        assert_eq!(market.pnl_pool.balance, 295000000);
        assert_eq!(market.amm.total_fee_minus_distributions, -9800000000);
        assert_eq!(market.amm.total_fee_withdrawn, 0);
        assert_eq!(spot_market.revenue_pool.balance, 9800000001);
        assert_eq!(
            market.revenue_withdraw_since_last_settle,
            market.max_revenue_withdraw_per_period
        );
        assert_eq!(market.last_revenue_withdraw_ts, 33928058);

        // do a revenue settlement to allow up to max again
        assert_eq!(spot_market.last_revenue_settle_ts, 0);
        assert_eq!(spot_market.deposit_balance, 10100000001);

        spot_market.total_if_factor = 1;
        spot_market.revenue_settle_period = 1;
        let res = settle_revenue_to_insurance_fund(
            spot_market_vault_amount,
            0,
            &mut spot_market,
            now + 3600,
        )
        .unwrap();
        assert_eq!(res, 9800000001);

        let spot_market_vault_amount = get_token_amount(
            spot_market.deposit_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap() as u64;

        assert_eq!(spot_market.deposit_balance, 300000000); // 100000000 was added to market fee/pnl pool
        assert_eq!(spot_market.borrow_balance, 0);
        assert_eq!(spot_market_vault_amount, 300000000);

        assert_eq!(spot_market.revenue_pool.balance, 0);
        assert_eq!(spot_market.last_revenue_settle_ts, now + 3600);

        // add deposits and revenue to pool
        spot_market.revenue_pool.balance = 9800000001;
        let market_backup = market;
        let spot_market_backup = spot_market;
        assert!(update_pool_balances(&mut market, &mut spot_market, 0, now + 3600).is_err()); // assert is_err if any way has revenue pool above deposit balances
        market = market_backup;
        spot_market = spot_market_backup;
        spot_market.deposit_balance += 9800000001;

        assert_eq!(market.amm.fee_pool.balance, 5000000);
        assert_eq!(market.pnl_pool.balance, 295000000);
        assert_eq!(market.amm.total_fee_minus_distributions, -9800000000);
        assert_eq!(market.amm.total_fee_withdrawn, 0);
        assert_eq!(spot_market.revenue_pool.balance, 9800000001);
        assert_eq!(market.last_revenue_withdraw_ts, 33928058);
        assert_eq!(spot_market.last_revenue_settle_ts, 33928058 + 3600);

        assert!(update_pool_balances(&mut market, &mut spot_market, 0, now).is_err()); // now timestamp passed is wrong
        update_pool_balances(&mut market, &mut spot_market, 0, now + 3600).unwrap();

        assert_eq!(market.last_revenue_withdraw_ts, 33931658);
        assert_eq!(spot_market.last_revenue_settle_ts, 33931658);
        assert_eq!(market.amm.fee_pool.balance, 205000000);
        assert_eq!(market.pnl_pool.balance, 295000000);
        assert_eq!(market.amm.total_fee_minus_distributions, -9600000000);
        assert_eq!(market.amm.total_fee_withdrawn, 0);
        assert_eq!(spot_market.revenue_pool.balance, 9600000001);
        assert_eq!(
            market.revenue_withdraw_since_last_settle,
            market.max_revenue_withdraw_per_period
        );
    }
}
