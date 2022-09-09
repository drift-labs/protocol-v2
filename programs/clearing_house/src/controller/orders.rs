use anchor_lang::prelude::*;
use solana_program::msg;

use crate::context::*;
use crate::controller;
use crate::controller::funding::settle_funding_payment;
use crate::controller::position;
use crate::controller::position::{
    add_new_position, decrease_open_bids_and_asks, get_position_index, increase_open_bids_and_asks,
    update_amm_and_lp_market_position, update_position_and_market, update_quote_asset_amount,
    PositionDirection,
};
use crate::error::ClearingHouseResult;
use crate::error::ErrorCode;
use crate::get_struct_values;
use crate::get_then_update_id;
use crate::load_mut;
use crate::math::amm::is_oracle_valid;
use crate::math::auction::{
    calculate_auction_end_price, calculate_auction_start_price, is_auction_complete,
};
use crate::math::casting::{cast, cast_to_i128};
use crate::math::fees::FillFees;
use crate::math::fulfillment::determine_fulfillment_methods;
use crate::math::liquidation::validate_user_not_being_liquidated;
use crate::math::matching::{
    are_orders_same_market_but_different_sides, calculate_fill_for_matched_orders, do_orders_cross,
    is_maker_for_taker,
};
use crate::math::{amm, fees, margin::*, orders::*};
use crate::math_error;
use crate::order_validation::validate_order;
use crate::print_error;
use crate::state::bank_map::BankMap;
use crate::state::events::{get_order_action_record, OrderActionRecord, OrderRecord};
use crate::state::events::{OrderAction, OrderActionExplanation};
use crate::state::fulfillment::FulfillmentMethod;
use crate::state::market::Market;
use crate::state::market_map::MarketMap;
use crate::state::oracle::OraclePriceData;
use crate::state::oracle_map::OracleMap;
use crate::state::state::*;
use crate::state::user::User;
use crate::state::user::{Order, OrderStatus, OrderType, UserStats};
use crate::validate;
use std::cell::RefMut;
use std::cmp::{max, min};
use std::ops::{Deref, DerefMut};

#[cfg(test)]
mod tests;

#[cfg(test)]
mod amm_jit_tests;

pub fn place_order(
    state: &State,
    user: &AccountLoader<User>,
    market_map: &MarketMap,
    bank_map: &BankMap,
    oracle_map: &mut OracleMap,
    clock: &Clock,
    params: OrderParams,
) -> ClearingHouseResult {
    let now = clock.unix_timestamp;
    let slot = clock.slot;
    let user_key = user.key();
    let user = &mut load_mut!(user)?;

    validate_user_not_being_liquidated(
        user,
        market_map,
        bank_map,
        oracle_map,
        state.liquidation_margin_buffer_ratio,
    )?;

    validate!(!user.bankrupt, ErrorCode::UserBankrupt)?;

    let new_order_index = user
        .orders
        .iter()
        .position(|order| order.status.eq(&OrderStatus::Init))
        .ok_or(ErrorCode::MaxNumberOfOrders)?;

    if params.user_order_id > 0 {
        let user_order_id_already_used = user
            .orders
            .iter()
            .position(|order| order.user_order_id == params.user_order_id);

        if user_order_id_already_used.is_some() {
            msg!("user_order_id is already in use {}", params.user_order_id);
            return Err(ErrorCode::UserOrderIdAlreadyInUse);
        }
    }

    let market_index = params.market_index;
    let market = &market_map.get_ref(&market_index)?;

    let position_index = get_position_index(&user.positions, market_index)
        .or_else(|_| add_new_position(&mut user.positions, market_index))?;

    let worst_case_base_asset_amount_before =
        user.positions[position_index].worst_case_base_asset_amount()?;

    // Increment open orders for existing position
    let (existing_position_direction, order_base_asset_amount) = {
        let market_position = &mut user.positions[position_index];
        market_position.open_orders += 1;

        let standardized_base_asset_amount = standardize_base_asset_amount(
            params.base_asset_amount,
            market.amm.base_asset_amount_step_size,
        )?;

        let base_asset_amount = if params.reduce_only {
            calculate_base_asset_amount_for_reduce_only_order(
                standardized_base_asset_amount,
                params.direction,
                market_position.base_asset_amount,
            )
        } else {
            standardized_base_asset_amount
        };

        validate!(
            base_asset_amount >= market.amm.base_asset_amount_step_size,
            ErrorCode::TradeSizeTooSmall,
            "Order base asset amount ({}), smaller than step size ({})",
            params.base_asset_amount,
            market.amm.base_asset_amount_step_size
        )?;

        if !matches!(
            &params.order_type,
            OrderType::TriggerMarket | OrderType::TriggerLimit
        ) {
            increase_open_bids_and_asks(market_position, &params.direction, base_asset_amount)?;
        }

        let existing_position_direction = if market_position.base_asset_amount >= 0 {
            PositionDirection::Long
        } else {
            PositionDirection::Short
        };
        (existing_position_direction, base_asset_amount)
    };

    let (auction_start_price, auction_end_price) = if let OrderType::Market = params.order_type {
        let auction_start_price = calculate_auction_start_price(market, params.direction)?;
        let auction_end_price = if params.price == 0 {
            calculate_auction_end_price(market, params.direction, order_base_asset_amount)?
        } else {
            params.price
        };
        (auction_start_price, auction_end_price)
    } else {
        (0_u128, 0_u128)
    };

    let new_order = Order {
        status: OrderStatus::Open,
        order_type: params.order_type,
        ts: now,
        slot,
        order_id: get_then_update_id!(user, next_order_id),
        user_order_id: params.user_order_id,
        market_index: params.market_index,
        price: params.price,
        existing_position_direction,
        base_asset_amount: order_base_asset_amount,
        base_asset_amount_filled: 0,
        quote_asset_amount_filled: 0,
        fee: 0,
        direction: params.direction,
        reduce_only: params.reduce_only,
        trigger_price: params.trigger_price,
        trigger_condition: params.trigger_condition,
        triggered: false,
        post_only: params.post_only,
        oracle_price_offset: params.oracle_price_offset,
        immediate_or_cancel: params.immediate_or_cancel,
        auction_start_price,
        auction_end_price,
        auction_duration: min(
            max(state.min_auction_duration, params.auction_duration),
            state.max_auction_duration,
        ),
        padding: [0; 3],
    };

    let valid_oracle_price = get_valid_oracle_price(
        oracle_map.get_price_data(&market.amm.oracle)?,
        market,
        &new_order,
        &state.oracle_guard_rails.validity,
    )?;

    validate_order(&new_order, market, state, valid_oracle_price, slot)?;

    user.orders[new_order_index] = new_order;

    let worst_case_base_asset_amount_after =
        user.positions[position_index].worst_case_base_asset_amount()?;

    // Order fails if it's risk increasing and it brings the user collateral below the margin requirement
    let risk_decreasing = worst_case_base_asset_amount_after.unsigned_abs()
        <= worst_case_base_asset_amount_before.unsigned_abs();

    let meets_initial_maintenance_requirement =
        meets_initial_margin_requirement(user, market_map, bank_map, oracle_map)?;

    if !meets_initial_maintenance_requirement && !risk_decreasing {
        return Err(ErrorCode::InsufficientCollateral);
    }

    let (taker, taker_order, taker_pnl, maker, maker_order, maker_pnl) =
        get_taker_and_maker_for_order_record(&user_key, &new_order, None);

    let order_action_record = get_order_action_record(
        now,
        OrderAction::Place,
        OrderActionExplanation::None,
        market_index,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        taker,
        taker_order,
        taker_pnl,
        maker,
        maker_order,
        maker_pnl,
        oracle_map.get_price_data(&market.amm.oracle)?.price,
    )?;
    emit!(order_action_record);

    let order_record = OrderRecord {
        ts: now,
        user: user_key,
        order: user.orders[new_order_index],
    };
    emit!(order_record);

    Ok(())
}

pub fn cancel_order_by_order_id(
    order_id: u64,
    user: &AccountLoader<User>,
    market_map: &MarketMap,
    oracle_map: &mut OracleMap,
    clock: &Clock,
) -> ClearingHouseResult {
    let user_key = user.key();
    let user = &mut load_mut!(user)?;
    let order_index = user
        .orders
        .iter()
        .position(|order| order.order_id == order_id)
        .ok_or_else(print_error!(ErrorCode::OrderDoesNotExist))?;

    cancel_order(
        order_index,
        user,
        &user_key,
        market_map,
        oracle_map,
        clock.unix_timestamp,
        clock.slot,
        OrderActionExplanation::None,
        None,
        0,
        false,
    )
}

pub fn cancel_order_by_user_order_id(
    user_order_id: u8,
    user: &AccountLoader<User>,
    market_map: &MarketMap,
    oracle_map: &mut OracleMap,
    clock: &Clock,
) -> ClearingHouseResult {
    let user_key = user.key();
    let user = &mut load_mut!(user)?;
    let order_index = user
        .orders
        .iter()
        .position(|order| order.user_order_id == user_order_id)
        .ok_or_else(print_error!(ErrorCode::OrderDoesNotExist))?;

    cancel_order(
        order_index,
        user,
        &user_key,
        market_map,
        oracle_map,
        clock.unix_timestamp,
        clock.slot,
        OrderActionExplanation::None,
        None,
        0,
        false,
    )
}

pub fn cancel_order(
    order_index: usize,
    user: &mut User,
    user_key: &Pubkey,
    market_map: &MarketMap,
    oracle_map: &mut OracleMap,
    now: i64,
    _slot: u64,
    explanation: OrderActionExplanation,
    filler_key: Option<&Pubkey>,
    filler_reward: u128,
    skip_log: bool,
) -> ClearingHouseResult {
    let (order_status, order_market_index, order_direction) =
        get_struct_values!(user.orders[order_index], status, market_index, direction);

    validate!(order_status == OrderStatus::Open, ErrorCode::OrderNotOpen)?;

    let market = &market_map.get_ref(&order_market_index)?;

    // When save in the record, we want the status to be canceled
    user.orders[order_index].status = OrderStatus::Canceled;

    if !skip_log {
        let (taker, taker_order, taker_pnl, maker, maker_order, maker_pnl) =
            get_taker_and_maker_for_order_record(
                user_key,
                &user.orders[order_index],
                Some(-cast(filler_reward)?),
            );

        let order_action_record = get_order_action_record(
            now,
            OrderAction::Cancel,
            explanation,
            market.market_index,
            filler_key.copied(),
            None,
            Some(filler_reward),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            taker,
            taker_order,
            taker_pnl,
            maker,
            maker_order,
            maker_pnl,
            oracle_map.get_price_data(&market.amm.oracle)?.price,
        )?;
        emit!(order_action_record);
    }

    // Decrement open orders for existing position
    let position_index = get_position_index(&user.positions, order_market_index)?;
    let base_asset_amount_unfilled = user.orders[order_index].get_base_asset_amount_unfilled()?;
    position::decrease_open_bids_and_asks(
        &mut user.positions[position_index],
        &order_direction,
        base_asset_amount_unfilled,
    )?;
    user.positions[position_index].open_orders -= 1;
    user.orders[order_index] = Order::default();

    Ok(())
}

pub fn fill_order(
    order_id: u64,
    state: &State,
    user: &AccountLoader<User>,
    user_stats: &AccountLoader<UserStats>,
    bank_map: &BankMap,
    market_map: &MarketMap,
    oracle_map: &mut OracleMap,
    filler: &AccountLoader<User>,
    filler_stats: &AccountLoader<UserStats>,
    maker: Option<&AccountLoader<User>>,
    maker_stats: Option<&AccountLoader<UserStats>>,
    maker_order_id: Option<u64>,
    referrer: Option<&AccountLoader<User>>,
    referrer_stats: Option<&AccountLoader<UserStats>>,
    clock: &Clock,
) -> ClearingHouseResult<(u128, bool)> {
    let now = clock.unix_timestamp;
    let slot = clock.slot;

    let filler_key = filler.key();
    let user_key = user.key();
    let user = &mut load_mut!(user)?;
    let user_stats = &mut load_mut!(user_stats)?;

    let order_index = user
        .orders
        .iter()
        .position(|order| order.order_id == order_id)
        .ok_or_else(print_error!(ErrorCode::OrderDoesNotExist))?;

    let (order_status, market_index) =
        get_struct_values!(user.orders[order_index], status, market_index);

    // settle lp position so its tradeable
    let mut market = market_map.get_ref_mut(&market_index)?;

    controller::lp::settle_lp(user, &user_key, &mut market, now)?;
    controller::funding::settle_funding_payment(user, &user_key, &mut market, now)?;

    drop(market);

    validate!(
        order_status == OrderStatus::Open,
        ErrorCode::OrderNotOpen,
        "Order not open"
    )?;

    validate!(
        !user.orders[order_index].must_be_triggered() || user.orders[order_index].triggered,
        ErrorCode::OrderMustBeTriggeredFirst,
        "Order must be triggered first"
    )?;

    validate!(!user.bankrupt, ErrorCode::UserBankrupt)?;

    validate_user_not_being_liquidated(
        user,
        market_map,
        bank_map,
        oracle_map,
        state.liquidation_margin_buffer_ratio,
    )?;

    let mark_price_before: u128;
    let oracle_mark_spread_pct_before: i128;
    let is_oracle_valid: bool;
    let oracle_price: i128;
    {
        let market = &mut market_map.get_ref_mut(&market_index)?;
        controller::validate::validate_market_account(market)?;

        validate!(
            ((oracle_map.slot == market.amm.last_update_slot && market.amm.last_oracle_valid)
                || market.amm.curve_update_intensity == 0),
            ErrorCode::AMMNotUpdatedInSameSlot,
            "AMM must be updated in a prior instruction within same slot"
        )?;

        let oracle_price_data = &oracle_map.get_price_data(&market.amm.oracle)?;

        is_oracle_valid = amm::is_oracle_valid(
            &market.amm,
            oracle_price_data,
            &state.oracle_guard_rails.validity,
        )?;

        mark_price_before = market.amm.mark_price()?;
        oracle_mark_spread_pct_before =
            amm::calculate_oracle_twap_5min_mark_spread_pct(&market.amm, Some(mark_price_before))?;
        oracle_price = oracle_price_data.price;
    }

    let valid_oracle_price = if is_oracle_valid {
        Some(oracle_price)
    } else {
        None
    };

    let is_filler_taker = user_key == filler_key;
    let is_filler_maker = maker.map_or(false, |maker| maker.key() == filler_key);
    let (mut filler, mut filler_stats) = if !is_filler_maker && !is_filler_taker {
        (Some(load_mut!(filler)?), Some(load_mut!(filler_stats)?))
    } else {
        (None, None)
    };

    let (mut maker, mut maker_stats, maker_key, maker_order_index) = sanitize_maker_order(
        market_map,
        oracle_map,
        maker,
        maker_stats,
        maker_order_id,
        &user_key,
        &user.orders[order_index],
        &mut filler.as_deref_mut(),
        &filler_key,
        state.fee_structure.cancel_order_fee,
        oracle_price,
        now,
        slot,
    )?;

    let (mut referrer, mut referrer_stats) =
        sanitize_referrer(referrer, referrer_stats, user_stats)?;

    let order_breaches_oracle_price = order_breaches_oracle_price_limits(
        market_map.get_ref_mut(&market_index)?.deref(),
        &user.orders[order_index],
        oracle_price,
        slot,
    )?;
    if order_breaches_oracle_price {
        let filler_reward = pay_keeper_flat_reward(
            user,
            filler.as_deref_mut(),
            market_map.get_ref_mut(&market_index)?.deref_mut(),
            state.fee_structure.cancel_order_fee,
        )?;

        cancel_order(
            order_index,
            user.deref_mut(),
            &user_key,
            market_map,
            oracle_map,
            now,
            slot,
            OrderActionExplanation::OraclePriceBreachedLimitPrice,
            Some(&filler_key),
            filler_reward,
            false,
        )?;

        return Ok((0, true));
    }

    let should_expire_order =
        should_expire_order(user, order_index, slot, state.max_auction_duration)?;
    if should_expire_order {
        let filler_reward = {
            let mut market = market_map.get_ref_mut(&market_index)?;
            pay_keeper_flat_reward(
                user,
                filler.as_deref_mut(),
                market.deref_mut(),
                state.fee_structure.cancel_order_fee,
            )?
        };

        cancel_order(
            order_index,
            user,
            &user_key,
            market_map,
            oracle_map,
            now,
            slot,
            OrderActionExplanation::MarketOrderAuctionExpired,
            Some(&filler_key),
            filler_reward,
            false,
        )?;
        return Ok((0, true));
    }

    let (base_asset_amount, potentially_risk_increasing, mut updated_user_state) = fulfill_order(
        user,
        order_index,
        &user_key,
        user_stats,
        &mut maker.as_deref_mut(),
        &mut maker_stats.as_deref_mut(),
        maker_order_index,
        maker_key.as_ref(),
        &mut filler.as_deref_mut(),
        &filler_key,
        &mut filler_stats.as_deref_mut(),
        &mut referrer.as_deref_mut(),
        &mut referrer_stats.as_deref_mut(),
        bank_map,
        market_map,
        oracle_map,
        &state.fee_structure,
        mark_price_before,
        valid_oracle_price,
        now,
        slot,
    )?;

    if should_cancel_order_after_fulfill(user, order_index, slot)? {
        updated_user_state = true;

        let filler_reward = {
            let mut market = market_map.get_ref_mut(&market_index)?;
            pay_keeper_flat_reward(
                user,
                filler.as_deref_mut(),
                market.deref_mut(),
                state.fee_structure.cancel_order_fee,
            )?
        };

        cancel_order(
            order_index,
            user,
            &user_key,
            market_map,
            oracle_map,
            now,
            slot,
            OrderActionExplanation::MarketOrderFilledToLimitPrice,
            Some(&filler_key),
            filler_reward,
            false,
        )?
    }

    if !updated_user_state {
        return Ok((base_asset_amount, updated_user_state));
    }

    let mark_price_after: u128;
    let oracle_mark_spread_pct_after: i128;
    {
        let market = market_map.get_ref_mut(&market_index)?;
        mark_price_after = market.amm.mark_price()?;
        oracle_mark_spread_pct_after =
            amm::calculate_oracle_twap_5min_mark_spread_pct(&market.amm, Some(mark_price_after))?;
    }

    let is_oracle_mark_too_divergent_before = amm::is_oracle_mark_too_divergent(
        oracle_mark_spread_pct_before,
        &state.oracle_guard_rails.price_divergence,
    )?;

    let is_oracle_mark_too_divergent_after = amm::is_oracle_mark_too_divergent(
        oracle_mark_spread_pct_after,
        &state.oracle_guard_rails.price_divergence,
    )?;

    // if oracle-mark divergence pushed outside limit, block order
    if is_oracle_mark_too_divergent_after && !is_oracle_mark_too_divergent_before && is_oracle_valid
    {
        return Err(ErrorCode::OracleMarkSpreadLimit);
    }

    // if oracle-mark divergence outside limit and risk-increasing, block order
    if is_oracle_mark_too_divergent_after
        && oracle_mark_spread_pct_after.unsigned_abs()
            >= oracle_mark_spread_pct_before.unsigned_abs()
        && is_oracle_valid
        && potentially_risk_increasing
    {
        return Err(ErrorCode::OracleMarkSpreadLimit);
    }

    // Try to update the funding rate at the end of every trade
    {
        let market = &mut market_map.get_ref_mut(&market_index)?;
        controller::funding::update_funding_rate(
            market_index,
            market,
            oracle_map,
            now,
            &state.oracle_guard_rails,
            state.funding_paused,
            Some(mark_price_before),
        )?;
    }

    Ok((base_asset_amount, updated_user_state))
}

#[allow(clippy::type_complexity)]
fn sanitize_maker_order<'a>(
    market_map: &MarketMap,
    oracle_map: &mut OracleMap,
    maker: Option<&'a AccountLoader<User>>,
    maker_stats: Option<&'a AccountLoader<UserStats>>,
    maker_order_id: Option<u64>,
    taker_key: &Pubkey,
    taker_order: &Order,
    filler: &mut Option<&mut User>,
    filler_key: &Pubkey,
    filler_reward: u128,
    oracle_price: i128,
    now: i64,
    slot: u64,
) -> ClearingHouseResult<(
    Option<RefMut<'a, User>>,
    Option<RefMut<'a, UserStats>>,
    Option<Pubkey>,
    Option<usize>,
)> {
    if maker.is_none() || maker_stats.is_none() {
        return Ok((None, None, None, None));
    }

    let maker = maker.unwrap();
    let maker_stats = maker_stats.unwrap();
    if &maker.key() == taker_key {
        return Ok((None, None, None, None));
    }

    let maker_key = maker.key();
    let mut maker = load_mut!(maker)?;
    let maker_stats = load_mut!(maker_stats)?;
    let maker_order_index =
        maker.get_order_index(maker_order_id.ok_or(ErrorCode::MakerOrderNotFound)?)?;

    {
        let maker_order = &maker.orders[maker_order_index];
        if !is_maker_for_taker(maker_order, taker_order)? {
            return Ok((None, None, None, None));
        }

        if maker.being_liquidated || maker.bankrupt {
            return Ok((None, None, None, None));
        }

        validate!(
            !maker_order.must_be_triggered() || maker_order.triggered,
            ErrorCode::OrderMustBeTriggeredFirst,
            "Maker order not triggered"
        )?;
    }

    // Dont fulfill with a maker order if oracle has diverged significantly
    if order_breaches_oracle_price_limits(
        market_map
            .get_ref(&maker.orders[maker_order_index].market_index)?
            .deref(),
        &maker.orders[maker_order_index],
        oracle_price,
        slot,
    )? {
        let filler_reward = {
            let mut market =
                market_map.get_ref_mut(&maker.orders[maker_order_index].market_index)?;
            pay_keeper_flat_reward(
                &mut maker,
                filler.as_deref_mut(),
                market.deref_mut(),
                filler_reward,
            )?
        };

        cancel_order(
            maker_order_index,
            maker.deref_mut(),
            &maker_key,
            market_map,
            oracle_map,
            now,
            slot,
            OrderActionExplanation::OraclePriceBreachedLimitPrice,
            Some(filler_key),
            filler_reward,
            false,
        )?;
        return Ok((None, None, None, None));
    }

    let market_index = maker.orders[maker_order_index].market_index;
    settle_funding_payment(
        &mut maker,
        &maker_key,
        market_map.get_ref_mut(&market_index)?.deref_mut(),
        now,
    )?;

    Ok((
        Some(maker),
        Some(maker_stats),
        Some(maker_key),
        Some(maker_order_index),
    ))
}

#[allow(clippy::type_complexity)]
fn sanitize_referrer<'a>(
    referrer: Option<&'a AccountLoader<User>>,
    referrer_stats: Option<&'a AccountLoader<UserStats>>,
    user_stats: &UserStats,
) -> ClearingHouseResult<(Option<RefMut<'a, User>>, Option<RefMut<'a, UserStats>>)> {
    if referrer.is_none() || referrer_stats.is_none() {
        validate!(
            !user_stats.has_referrer(),
            ErrorCode::InvalidReferrer,
            "User has referrer but referrer/referrer stats missing"
        )?;

        return Ok((None, None));
    }

    let referrer = load_mut!(referrer.unwrap())?;
    let referrer_stats = load_mut!(referrer_stats.unwrap())?;
    validate!(
        referrer.user_id == 0,
        ErrorCode::InvalidReferrer,
        "Referrer must be user id 0"
    )?;

    validate!(
        referrer.authority.eq(&referrer_stats.authority),
        ErrorCode::InvalidReferrer,
        "Referrer authority != Referrer stats authority"
    )?;

    validate!(
        referrer.authority.eq(&user_stats.referrer),
        ErrorCode::InvalidReferrer,
        "Referrer authority != user stats authority"
    )?;

    Ok((Some(referrer), Some(referrer_stats)))
}

fn fulfill_order(
    user: &mut User,
    user_order_index: usize,
    user_key: &Pubkey,
    user_stats: &mut UserStats,
    maker: &mut Option<&mut User>,
    maker_stats: &mut Option<&mut UserStats>,
    maker_order_index: Option<usize>,
    maker_key: Option<&Pubkey>,
    filler: &mut Option<&mut User>,
    filler_key: &Pubkey,
    filler_stats: &mut Option<&mut UserStats>,
    referrer: &mut Option<&mut User>,
    referrer_stats: &mut Option<&mut UserStats>,
    bank_map: &BankMap,
    market_map: &MarketMap,
    oracle_map: &mut OracleMap,
    fee_structure: &FeeStructure,
    mark_price_before: u128,
    valid_oracle_price: Option<i128>,
    now: i64,
    slot: u64,
) -> ClearingHouseResult<(u128, bool, bool)> {
    let market_index = user.orders[user_order_index].market_index;

    let position_index = get_position_index(&user.positions, market_index)?;
    let order_direction = user.orders[user_order_index].direction;
    let position_base_asset_amount_before = user.positions[position_index].base_asset_amount;
    let risk_decreasing = is_order_risk_decreasing(
        &order_direction,
        user.orders[user_order_index].get_base_asset_amount_unfilled()?,
        position_base_asset_amount_before,
    )?;

    let free_collateral = calculate_free_collateral(user, market_map, bank_map, oracle_map)?;
    if free_collateral < 0 && !risk_decreasing {
        cancel_risk_increasing_order(
            user,
            user_order_index,
            user_key,
            filler,
            filler_key,
            market_map,
            oracle_map,
            fee_structure,
            now,
            slot,
        )?;

        return Ok((0, false, true));
    }

    let fulfillment_methods =
        determine_fulfillment_methods(&user.orders[user_order_index], maker.is_some(), slot)?;

    if fulfillment_methods.is_empty() {
        return Ok((0, false, false));
    }

    let mut base_asset_amount = 0_u128;
    let mut quote_asset_amount = 0_u128;
    let mut order_records: Vec<OrderActionRecord> = vec![];
    for fulfillment_method in fulfillment_methods.iter() {
        if user.orders[user_order_index].status != OrderStatus::Open {
            break;
        }

        let mut market = market_map.get_ref_mut(&market_index)?;

        let (_base_asset_amount, _quote_asset_amount) = match fulfillment_method {
            FulfillmentMethod::AMM => fulfill_order_with_amm(
                user,
                user_stats,
                user_order_index,
                market.deref_mut(),
                oracle_map,
                mark_price_before,
                now,
                slot,
                valid_oracle_price,
                user_key,
                filler_key,
                filler,
                filler_stats,
                referrer,
                referrer_stats,
                fee_structure,
                &mut order_records,
                None,
                None,
            )?,
            FulfillmentMethod::Match => fulfill_order_with_match(
                market.deref_mut(),
                user,
                user_stats,
                user_order_index,
                user_key,
                maker.as_deref_mut().unwrap(),
                maker_stats.as_deref_mut().unwrap(),
                maker_order_index.unwrap(),
                maker_key.unwrap(),
                filler,
                filler_stats,
                filler_key,
                referrer,
                referrer_stats,
                mark_price_before,
                valid_oracle_price,
                now,
                slot,
                fee_structure,
                oracle_map,
                &mut order_records,
            )?,
        };

        base_asset_amount = base_asset_amount
            .checked_add(_base_asset_amount)
            .ok_or_else(math_error!())?;
        quote_asset_amount = quote_asset_amount
            .checked_add(_quote_asset_amount)
            .ok_or_else(math_error!())?;
    }

    for order_record in order_records {
        emit!(order_record)
    }

    let (margin_requirement, total_collateral) = calculate_margin_requirement_and_total_collateral(
        user,
        market_map,
        MarginRequirementType::Maintenance,
        bank_map,
        oracle_map,
    )?;
    if total_collateral < cast_to_i128(margin_requirement)? {
        msg!(
            "taker breached maintenance requirements (margin requirement {}) (total_collateral {})",
            margin_requirement,
            total_collateral
        );
        return Err(ErrorCode::InsufficientCollateral);
    }

    let position_base_asset_amount_after = user.positions[position_index].base_asset_amount;
    let risk_increasing = position_base_asset_amount_before == 0
        || position_base_asset_amount_before.signum() == position_base_asset_amount_after.signum()
        || position_base_asset_amount_before.abs() < position_base_asset_amount_after.abs();

    let updated_user_state = base_asset_amount != 0;

    Ok((base_asset_amount, risk_increasing, updated_user_state))
}

fn cancel_risk_increasing_order(
    user: &mut User,
    user_order_index: usize,
    user_key: &Pubkey,
    filler: &mut Option<&mut User>,
    filler_key: &Pubkey,
    market_map: &MarketMap,
    oracle_map: &mut OracleMap,
    fee_structure: &FeeStructure,
    now: i64,
    slot: u64,
) -> ClearingHouseResult {
    let market_index = user.orders[user_order_index].market_index;
    let filler_reward = {
        let mut market = market_map.get_ref_mut(&market_index)?;
        pay_keeper_flat_reward(
            user,
            filler.as_deref_mut(),
            market.deref_mut(),
            fee_structure.cancel_order_fee,
        )?
    };

    cancel_order(
        user_order_index,
        user,
        user_key,
        market_map,
        oracle_map,
        now,
        slot,
        OrderActionExplanation::InsufficientFreeCollateral,
        Some(filler_key),
        filler_reward,
        false,
    )?;

    Ok(())
}

pub fn fulfill_order_with_amm(
    user: &mut User,
    user_stats: &mut UserStats,
    order_index: usize,
    market: &mut Market,
    oracle_map: &mut OracleMap,
    mark_price_before: u128,
    now: i64,
    slot: u64,
    valid_oracle_price: Option<i128>,
    user_key: &Pubkey,
    filler_key: &Pubkey,
    filler: &mut Option<&mut User>,
    filler_stats: &mut Option<&mut UserStats>,
    referrer: &mut Option<&mut User>,
    referrer_stats: &mut Option<&mut UserStats>,
    fee_structure: &FeeStructure,
    order_records: &mut Vec<OrderActionRecord>,
    override_base_asset_amount: Option<u128>,
    override_fill_price: Option<u128>, // todo probs dont need this since its the user_limit_price / current auction time
) -> ClearingHouseResult<(u128, u128)> {
    // Determine the base asset amount the market can fill
    let (base_asset_amount, fill_price) = match override_base_asset_amount {
        Some(override_base_asset_amount) => (override_base_asset_amount, override_fill_price),
        None => {
            let fill_price = if user.orders[order_index].post_only {
                Some(user.orders[order_index].get_limit_price(
                    &market.amm,
                    valid_oracle_price,
                    slot,
                )?)
            } else {
                None
            };

            (
                calculate_base_asset_amount_for_amm_to_fulfill(
                    &user.orders[order_index],
                    market,
                    valid_oracle_price,
                    slot,
                )?,
                fill_price,
            )
        }
    };

    if base_asset_amount == 0 {
        // if is an actual swap (and not amm jit order) then msg!
        if override_base_asset_amount.is_none() {
            msg!("Amm cant fulfill order");
        }
        return Ok((0, 0));
    }

    let position_index = get_position_index(&user.positions, market.market_index)?;

    let (order_post_only, order_ts, order_direction) =
        get_struct_values!(user.orders[order_index], post_only, ts, direction);

    let (quote_asset_amount, quote_asset_amount_surplus, mut pnl) =
        controller::position::update_position_with_base_asset_amount(
            base_asset_amount,
            order_direction,
            market,
            user,
            position_index,
            mark_price_before,
            now,
            fill_price,
        )?;

    let reward_referrer = referrer.is_some()
        && referrer_stats.is_some()
        && referrer
            .as_mut()
            .unwrap()
            .force_get_position_mut(market.market_index)
            .is_ok();

    let FillFees {
        user_fee,
        fee_to_market,
        filler_reward,
        referee_discount,
        referrer_reward,
        fee_to_market_for_lp,
        ..
    } = fees::calculate_fee_for_order_fulfill_against_amm(
        quote_asset_amount,
        fee_structure,
        order_ts,
        now,
        filler.is_some(),
        reward_referrer,
        quote_asset_amount_surplus,
        order_post_only,
    )?;

    amm::update_amm_long_short_intensity(
        &mut market.amm,
        now,
        quote_asset_amount,
        order_direction,
    )?;

    let user_position_delta =
        get_position_delta_for_fill(base_asset_amount, quote_asset_amount, order_direction)?;

    update_amm_and_lp_market_position(
        market,
        &user_position_delta,
        cast_to_i128(fee_to_market_for_lp)?,
    )?;

    // Increment the clearing house's total fee variables
    market.amm.total_fee = market
        .amm
        .total_fee
        .checked_add(fee_to_market)
        .ok_or_else(math_error!())?;
    market.amm.total_exchange_fee = market
        .amm
        .total_exchange_fee
        .checked_add(user_fee)
        .ok_or_else(math_error!())?;
    market.amm.total_mm_fee = cast_to_i128(market.amm.total_mm_fee)?
        .checked_add(quote_asset_amount_surplus)
        .ok_or_else(math_error!())?;
    market.amm.total_fee_minus_distributions = market
        .amm
        .total_fee_minus_distributions
        .checked_add(fee_to_market as i128)
        .ok_or_else(math_error!())?;
    market.amm.net_revenue_since_last_funding = market
        .amm
        .net_revenue_since_last_funding
        .checked_add(fee_to_market as i64)
        .ok_or_else(math_error!())?;

    // Increment the user's total fee variables
    user_stats.fees.total_fee_paid = user_stats
        .fees
        .total_fee_paid
        .checked_add(cast(user_fee)?)
        .ok_or_else(math_error!())?;
    user_stats.fees.total_referee_discount = user_stats
        .fees
        .total_referee_discount
        .checked_add(referee_discount)
        .ok_or_else(math_error!())?;

    if let (Some(referrer), Some(referrer_stats)) = (referrer.as_mut(), referrer_stats.as_mut()) {
        if let Ok(referrer_position) = referrer.force_get_position_mut(market.market_index) {
            update_quote_asset_amount(referrer_position, market, cast(referrer_reward)?)?;

            referrer_stats.total_referrer_reward = referrer_stats
                .total_referrer_reward
                .checked_add(referrer_reward)
                .ok_or_else(math_error!())?;
        }
    }

    let position_index = get_position_index(&user.positions, market.market_index)?;

    controller::position::update_quote_asset_amount(
        &mut user.positions[position_index],
        market,
        -cast(user_fee)?,
    )?;

    if order_post_only {
        user_stats.update_maker_volume_30d(cast(quote_asset_amount)?, now)?;
    } else {
        user_stats.update_taker_volume_30d(cast(quote_asset_amount)?, now)?;
    }

    pnl = pnl.checked_sub(cast(user_fee)?).ok_or_else(math_error!())?;

    if let Some(filler) = filler.as_mut() {
        let position_index = get_position_index(&filler.positions, market.market_index)
            .or_else(|_| add_new_position(&mut filler.positions, market.market_index))?;

        controller::position::update_quote_asset_amount(
            &mut filler.positions[position_index],
            market,
            cast(filler_reward)?,
        )?;

        filler_stats
            .as_mut()
            .unwrap()
            .update_filler_volume(cast(quote_asset_amount)?, now)?;
    }

    update_order_after_fill(
        &mut user.orders[order_index],
        market.amm.base_asset_amount_step_size,
        base_asset_amount,
        quote_asset_amount,
        cast(user_fee)?,
    )?;

    decrease_open_bids_and_asks(
        &mut user.positions[position_index],
        &order_direction,
        base_asset_amount,
    )?;

    let (taker, taker_order, taker_pnl, maker, maker_order, maker_pnl) =
        get_taker_and_maker_for_order_record(user_key, &user.orders[order_index], Some(pnl));

    let fill_record_id = get_then_update_id!(market, next_fill_record_id);
    let order_action_record = get_order_action_record(
        now,
        OrderAction::Fill,
        OrderActionExplanation::OrderFilledWithAMM,
        market.market_index,
        Some(*filler_key),
        Some(fill_record_id),
        Some(filler_reward),
        if user_stats.referrer.eq(&Pubkey::default()) {
            None
        } else {
            Some(user_stats.referrer)
        },
        Some(base_asset_amount),
        Some(quote_asset_amount),
        Some(user_fee),
        None,
        Some(referrer_reward),
        Some(referee_discount),
        Some(quote_asset_amount_surplus),
        taker,
        taker_order,
        taker_pnl,
        maker,
        maker_order,
        maker_pnl,
        oracle_map.get_price_data(&market.amm.oracle)?.price,
    )?;
    order_records.push(order_action_record);

    // Cant reset order until after its logged
    if user.orders[order_index].get_base_asset_amount_unfilled()? == 0 {
        user.orders[order_index] = Order::default();
        let market_position = &mut user.positions[position_index];
        market_position.open_orders -= 1;
    }

    Ok((base_asset_amount, quote_asset_amount))
}

pub fn fulfill_order_with_match(
    market: &mut Market,
    taker: &mut User,
    taker_stats: &mut UserStats,
    taker_order_index: usize,
    taker_key: &Pubkey,
    maker: &mut User,
    maker_stats: &mut UserStats,
    maker_order_index: usize,
    maker_key: &Pubkey,
    filler: &mut Option<&mut User>,
    filler_stats: &mut Option<&mut UserStats>,
    filler_key: &Pubkey,
    referrer: &mut Option<&mut User>,
    referrer_stats: &mut Option<&mut UserStats>,
    mark_price_before: u128,
    valid_oracle_price: Option<i128>,
    now: i64,
    slot: u64,
    fee_structure: &FeeStructure,
    oracle_map: &mut OracleMap,
    order_records: &mut Vec<OrderActionRecord>,
) -> ClearingHouseResult<(u128, u128)> {
    if !are_orders_same_market_but_different_sides(
        &maker.orders[maker_order_index],
        &taker.orders[taker_order_index],
    ) {
        return Ok((0_u128, 0_u128));
    }

    let oracle_price = oracle_map.get_price_data(&market.amm.oracle)?.price;
    let taker_price =
        taker.orders[taker_order_index].get_limit_price(&market.amm, Some(oracle_price), slot)?;
    let taker_direction = taker.orders[taker_order_index].direction;
    let taker_base_asset_amount =
        taker.orders[taker_order_index].get_base_asset_amount_unfilled()?;

    let maker_price =
        maker.orders[maker_order_index].get_limit_price(&market.amm, Some(oracle_price), slot)?;
    let maker_direction = &maker.orders[maker_order_index].direction;
    let maker_base_asset_amount =
        maker.orders[maker_order_index].get_base_asset_amount_unfilled()?;

    amm::update_mark_twap(
        &mut market.amm,
        now,
        Some(maker_price),
        Some(taker_direction),
    )?;

    let orders_cross = do_orders_cross(maker_direction, maker_price, taker_price);

    if !orders_cross {
        return Ok((0_u128, 0_u128));
    }

    let (base_asset_amount, _) = calculate_fill_for_matched_orders(
        maker_base_asset_amount,
        maker_price,
        taker_base_asset_amount,
    )?;

    if base_asset_amount == 0 {
        return Ok((0_u128, 0_u128));
    }

    let amm_wants_to_make = match taker_direction {
        PositionDirection::Long => market.amm.net_base_asset_amount < 0,
        PositionDirection::Short => market.amm.net_base_asset_amount > 0,
    };

    let mut total_quote_asset_amount = 0_u128;
    let base_asset_amount_left_to_fill = if amm_wants_to_make && market.amm.amm_jit_is_active() {
        let jit_base_asset_amount =
            crate::math::amm_jit::calculate_jit_base_asset_amount(market, base_asset_amount)?;

        if jit_base_asset_amount > 0 {
            let (base_asset_amount_filled_by_amm, quote_asset_amount_filled_by_amm) =
                fulfill_order_with_amm(
                    taker,
                    taker_stats,
                    taker_order_index,
                    market,
                    oracle_map,
                    mark_price_before,
                    now,
                    slot,
                    valid_oracle_price,
                    taker_key,
                    filler_key,
                    filler,
                    filler_stats,
                    &mut None,
                    &mut None,
                    fee_structure,
                    order_records,
                    Some(jit_base_asset_amount),
                    Some(taker_price), // current auction price
                )?;

            total_quote_asset_amount = quote_asset_amount_filled_by_amm;

            base_asset_amount
                .checked_sub(base_asset_amount_filled_by_amm)
                .ok_or_else(math_error!())?
        } else {
            base_asset_amount
        }
    } else {
        base_asset_amount
    };

    let taker_base_asset_amount =
        taker.orders[taker_order_index].get_base_asset_amount_unfilled()?;

    let (_, quote_asset_amount) = calculate_fill_for_matched_orders(
        base_asset_amount_left_to_fill,
        maker_price,
        taker_base_asset_amount,
    )?;

    total_quote_asset_amount = total_quote_asset_amount
        .checked_add(quote_asset_amount)
        .ok_or_else(math_error!())?;

    let maker_position_index = get_position_index(
        &maker.positions,
        maker.orders[maker_order_index].market_index,
    )?;

    let maker_position_delta = get_position_delta_for_fill(
        base_asset_amount_left_to_fill,
        quote_asset_amount,
        maker.orders[maker_order_index].direction,
    )?;

    let mut maker_pnl = update_position_and_market(
        &mut maker.positions[maker_position_index],
        market,
        &maker_position_delta,
    )?;

    maker_stats.update_maker_volume_30d(cast(quote_asset_amount)?, now)?;

    let taker_position_index = get_position_index(
        &taker.positions,
        taker.orders[taker_order_index].market_index,
    )?;

    let taker_position_delta = get_position_delta_for_fill(
        base_asset_amount_left_to_fill,
        quote_asset_amount,
        taker.orders[taker_order_index].direction,
    )?;

    let mut taker_pnl = update_position_and_market(
        &mut taker.positions[taker_position_index],
        market,
        &taker_position_delta,
    )?;

    taker_stats.update_taker_volume_30d(cast(quote_asset_amount)?, now)?;

    let reward_referrer = referrer.is_some()
        && referrer_stats.is_some()
        && referrer
            .as_mut()
            .unwrap()
            .force_get_position_mut(market.market_index)
            .is_ok();

    let FillFees {
        user_fee: taker_fee,
        maker_rebate,
        fee_to_market,
        filler_reward,
        referrer_reward,
        referee_discount,
        ..
    } = fees::calculate_fee_for_fulfillment_with_match(
        quote_asset_amount,
        fee_structure,
        taker.orders[taker_order_index].ts,
        now,
        filler.is_some(),
        reward_referrer,
    )?;

    // Increment the markets house's total fee variables
    market.amm.market_position.quote_asset_amount = market
        .amm
        .market_position
        .quote_asset_amount
        .checked_add(cast_to_i128(fee_to_market)?)
        .ok_or_else(math_error!())?;

    market.amm.total_fee = market
        .amm
        .total_fee
        .checked_add(cast_to_i128(fee_to_market)?)
        .ok_or_else(math_error!())?;
    market.amm.total_fee_minus_distributions = market
        .amm
        .total_fee_minus_distributions
        .checked_add(fee_to_market as i128)
        .ok_or_else(math_error!())?;
    market.amm.net_revenue_since_last_funding = market
        .amm
        .net_revenue_since_last_funding
        .checked_add(fee_to_market as i64)
        .ok_or_else(math_error!())?;

    controller::position::update_quote_asset_amount(
        &mut taker.positions[taker_position_index],
        market,
        -cast(taker_fee)?,
    )?;

    taker_stats.fees.total_fee_paid = taker_stats
        .fees
        .total_fee_paid
        .checked_add(cast(taker_fee)?)
        .ok_or_else(math_error!())?;
    taker_stats.fees.total_referee_discount = taker_stats
        .fees
        .total_referee_discount
        .checked_add(referee_discount)
        .ok_or_else(math_error!())?;

    taker_pnl = taker_pnl
        .checked_sub(cast(taker_fee)?)
        .ok_or_else(math_error!())?;

    controller::position::update_quote_asset_amount(
        &mut maker.positions[maker_position_index],
        market,
        cast(maker_rebate)?,
    )?;

    maker_stats.fees.total_fee_rebate = maker_stats
        .fees
        .total_fee_rebate
        .checked_add(cast(maker_rebate)?)
        .ok_or_else(math_error!())?;

    maker_pnl = maker_pnl
        .checked_add(cast(maker_rebate)?)
        .ok_or_else(math_error!())?;

    if let Some(filler) = filler {
        let filler_position_index = get_position_index(&filler.positions, market.market_index)
            .or_else(|_| add_new_position(&mut filler.positions, market.market_index))?;

        controller::position::update_quote_asset_amount(
            &mut filler.positions[filler_position_index],
            market,
            cast(filler_reward)?,
        )?;

        filler_stats
            .as_mut()
            .unwrap()
            .update_filler_volume(cast(quote_asset_amount)?, now)?;
    }

    if let (Some(referrer), Some(referrer_stats)) = (referrer.as_mut(), referrer_stats.as_mut()) {
        if let Ok(referrer_position) = referrer.force_get_position_mut(market.market_index) {
            update_quote_asset_amount(referrer_position, market, cast(referrer_reward)?)?;

            referrer_stats.total_referrer_reward = referrer_stats
                .total_referrer_reward
                .checked_add(referrer_reward)
                .ok_or_else(math_error!())?;
        }
    }

    update_order_after_fill(
        &mut taker.orders[taker_order_index],
        market.amm.base_asset_amount_step_size,
        base_asset_amount_left_to_fill,
        quote_asset_amount,
        cast(taker_fee)?,
    )?;

    decrease_open_bids_and_asks(
        &mut taker.positions[taker_position_index],
        &taker.orders[taker_order_index].direction,
        base_asset_amount_left_to_fill,
    )?;

    update_order_after_fill(
        &mut maker.orders[maker_order_index],
        market.amm.base_asset_amount_step_size,
        base_asset_amount_left_to_fill,
        quote_asset_amount,
        -cast(maker_rebate)?,
    )?;

    decrease_open_bids_and_asks(
        &mut maker.positions[maker_position_index],
        &maker.orders[maker_order_index].direction,
        base_asset_amount_left_to_fill,
    )?;

    let fill_record_id = get_then_update_id!(market, next_fill_record_id);
    let order_action_record = get_order_action_record(
        now,
        OrderAction::Fill,
        OrderActionExplanation::None,
        market.market_index,
        Some(*filler_key),
        Some(fill_record_id),
        Some(filler_reward),
        if taker_stats.referrer.eq(&Pubkey::default()) {
            None
        } else {
            Some(taker_stats.referrer)
        },
        Some(base_asset_amount_left_to_fill),
        Some(cast(quote_asset_amount)?),
        Some(taker_fee),
        Some(maker_rebate),
        Some(referrer_reward),
        Some(referee_discount),
        None,
        Some(*taker_key),
        Some(taker.orders[taker_order_index]),
        Some(taker_pnl),
        Some(*maker_key),
        Some(maker.orders[maker_order_index]),
        Some(maker_pnl),
        oracle_map.get_price_data(&market.amm.oracle)?.price,
    )?;
    order_records.push(order_action_record);

    if taker.orders[taker_order_index].get_base_asset_amount_unfilled()? == 0 {
        taker.orders[taker_order_index] = Order::default();
        let market_position = &mut taker.positions[taker_position_index];
        market_position.open_orders -= 1;
    }

    if maker.orders[maker_order_index].get_base_asset_amount_unfilled()? == 0 {
        maker.orders[maker_order_index] = Order::default();
        let market_position = &mut maker.positions[maker_position_index];
        market_position.open_orders -= 1;
    }

    Ok((base_asset_amount, total_quote_asset_amount))
}

pub fn update_order_after_fill(
    order: &mut Order,
    minimum_base_asset_trade_size: u128,
    base_asset_amount: u128,
    quote_asset_amount: u128,
    fee: i128,
) -> ClearingHouseResult {
    order.base_asset_amount_filled = order
        .base_asset_amount_filled
        .checked_add(base_asset_amount)
        .ok_or_else(math_error!())?;

    order.quote_asset_amount_filled = order
        .quote_asset_amount_filled
        .checked_add(quote_asset_amount)
        .ok_or_else(math_error!())?;

    // redundant test to make sure no min trade size remaining
    let base_asset_amount_to_fill = order
        .base_asset_amount
        .checked_sub(order.base_asset_amount_filled)
        .ok_or_else(math_error!())?;

    if base_asset_amount_to_fill > 0 && base_asset_amount_to_fill < minimum_base_asset_trade_size {
        return Err(ErrorCode::OrderAmountTooSmall);
    }

    order.fee = order.fee.checked_add(fee).ok_or_else(math_error!())?;

    if order.get_base_asset_amount_unfilled()? == 0 {
        order.status = OrderStatus::Filled;
    }

    Ok(())
}

fn get_valid_oracle_price(
    oracle_price_data: &OraclePriceData,
    market: &Market,
    order: &Order,
    validity_guardrails: &ValidityGuardRails,
) -> ClearingHouseResult<Option<i128>> {
    let price = {
        let is_oracle_valid = is_oracle_valid(&market.amm, oracle_price_data, validity_guardrails)?;
        if is_oracle_valid {
            Some(oracle_price_data.price)
        } else if order.has_oracle_price_offset() {
            msg!("Invalid oracle for order with oracle price offset");
            return Err(print_error!(ErrorCode::InvalidOracle)());
        } else {
            msg!("Oracle is invalid");
            None
        }
    };

    Ok(price)
}

#[allow(clippy::type_complexity)]
fn get_taker_and_maker_for_order_record(
    user_key: &Pubkey,
    user_order: &Order,
    pnl: Option<i128>,
) -> (
    Option<Pubkey>,
    Option<Order>,
    Option<i128>,
    Option<Pubkey>,
    Option<Order>,
    Option<i128>,
) {
    if user_order.post_only {
        (None, None, None, Some(*user_key), Some(*user_order), pnl)
    } else {
        (Some(*user_key), Some(*user_order), pnl, None, None, None)
    }
}

pub fn trigger_order(
    order_id: u64,
    state: &State,
    user: &AccountLoader<User>,
    market_map: &MarketMap,
    oracle_map: &mut OracleMap,
    filler: &AccountLoader<User>,
    clock: &Clock,
) -> ClearingHouseResult {
    let now = clock.unix_timestamp;
    let slot = clock.slot;

    let filler_key = filler.key();
    let user_key = user.key();
    let user = &mut load_mut!(user)?;

    let order_index = user
        .orders
        .iter()
        .position(|order| order.order_id == order_id)
        .ok_or_else(print_error!(ErrorCode::OrderDoesNotExist))?;

    let (order_status, market_index) =
        get_struct_values!(user.orders[order_index], status, market_index);

    validate!(
        order_status == OrderStatus::Open,
        ErrorCode::OrderNotOpen,
        "Order not open"
    )?;

    validate!(
        user.orders[order_index].must_be_triggered(),
        ErrorCode::OrderNotTriggerable,
        "Order is not triggerable"
    )?;

    let market = &mut market_map.get_ref_mut(&market_index)?;
    let oracle_price_data = &oracle_map.get_price_data(&market.amm.oracle)?;

    let is_oracle_valid = amm::is_oracle_valid(
        &market.amm,
        oracle_price_data,
        &state.oracle_guard_rails.validity,
    )?;
    validate!(is_oracle_valid, ErrorCode::InvalidOracle)?;
    let oracle_price = oracle_price_data.price;

    let order_slot = user.orders[order_index].slot;
    let auction_duration = user.orders[order_index].auction_duration;
    validate!(
        is_auction_complete(order_slot, auction_duration, slot)?,
        ErrorCode::OrderDidNotSatisfyTriggerCondition,
        "Auction duration must elapse before triggering"
    )?;

    let can_trigger =
        order_satisfies_trigger_condition(&user.orders[order_index], oracle_price.unsigned_abs());
    validate!(can_trigger, ErrorCode::OrderDidNotSatisfyTriggerCondition)?;

    {
        let direction = user.orders[order_index].direction;
        let base_asset_amount = user.orders[order_index].base_asset_amount;

        user.orders[order_index].triggered = true;
        user.orders[order_index].slot = slot;
        let order_type = user.orders[order_index].order_type;
        if let OrderType::TriggerMarket = order_type {
            let auction_start_price = calculate_auction_start_price(market, direction)?;
            let auction_end_price =
                calculate_auction_end_price(market, direction, base_asset_amount)?;
            user.orders[order_index].auction_start_price = auction_start_price;
            user.orders[order_index].auction_end_price = auction_end_price;
        }

        let user_position = user.get_position_mut(market_index)?;
        increase_open_bids_and_asks(user_position, &direction, base_asset_amount)?;
    }

    let is_filler_taker = user_key == filler_key;
    let mut filler = if !is_filler_taker {
        Some(load_mut!(filler)?)
    } else {
        None
    };

    let filler_reward = pay_keeper_flat_reward(
        user,
        filler.as_deref_mut(),
        market,
        state.fee_structure.cancel_order_fee,
    )?;

    let order_action_record = get_order_action_record(
        now,
        OrderAction::Trigger,
        OrderActionExplanation::None,
        market_index,
        Some(filler_key),
        None,
        Some(filler_reward),
        None,
        None,
        None,
        Some(filler_reward),
        None,
        None,
        None,
        None,
        Some(user_key),
        Some(user.orders[order_index]),
        Some(-cast(filler_reward)?),
        None,
        None,
        None,
        oracle_price,
    )?;
    emit!(order_action_record);

    Ok(())
}

pub fn pay_keeper_flat_reward(
    user: &mut User,
    filler: Option<&mut User>,
    market: &mut Market,
    filler_reward: u128,
) -> ClearingHouseResult<u128> {
    let filler_reward = if let Some(filler) = filler {
        let user_position = user.get_position_mut(market.market_index)?;
        controller::position::update_quote_asset_amount(
            user_position,
            market,
            -cast(filler_reward)?,
        )?;

        let filler_position = filler.force_get_position_mut(market.market_index)?;
        controller::position::update_quote_asset_amount(
            filler_position,
            market,
            cast(filler_reward)?,
        )?;

        filler_reward
    } else {
        0
    };

    Ok(filler_reward)
}
