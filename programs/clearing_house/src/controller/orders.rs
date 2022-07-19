use anchor_lang::prelude::*;
use solana_program::msg;

use crate::account_loader::load_mut;
use crate::context::*;
use crate::controller;
use crate::controller::position;
use crate::controller::position::{
    add_new_position, decrease_open_bids_and_asks, get_position_index, increase_open_bids_and_asks,
    update_position_and_market, PositionDirection,
};
use crate::error::ClearingHouseResult;
use crate::error::ErrorCode;
use crate::get_struct_values;
use crate::get_then_update_id;
use crate::math::amm::is_oracle_valid;
use crate::math::auction::{calculate_auction_end_price, calculate_auction_start_price};
use crate::math::casting::cast;
use crate::math::fulfillment::determine_fulfillment_methods;
use crate::math::matching::{
    are_orders_same_market_but_different_sides, calculate_fill_for_matched_orders, do_orders_cross,
    is_maker_for_taker,
};
use crate::math::{amm, fees, margin::*, orders::*};
use crate::math_error;
use crate::order_validation::validate_order;
use crate::print_error;
use crate::state::bank_map::BankMap;
use crate::state::events::OrderRecord;
use crate::state::events::{OrderAction, OrderActionExplanation};
use crate::state::fulfillment::FulfillmentMethod;
use crate::state::market::Market;
use crate::state::market_map::MarketMap;
use crate::state::oracle_map::OracleMap;
use crate::state::state::*;
use crate::state::user::{MarketPosition, Order, OrderStatus, OrderType, UserFees};
use crate::state::user::{OrderDiscountTier, User};
use crate::validate;
use std::alloc::{alloc_zeroed, Layout};
use std::cell::RefMut;
use std::ops::{Deref, DerefMut};

pub fn place_order(
    state: &State,
    user: &AccountLoader<User>,
    market_map: &MarketMap,
    bank_map: &BankMap,
    oracle_map: &mut OracleMap,
    clock: &Clock,
    params: OrderParams,
    oracle: Option<&AccountInfo>,
) -> ClearingHouseResult {
    let now = clock.unix_timestamp;
    let slot = clock.slot;
    let user_key = user.key();
    let user = &mut load_mut(user)?;
    controller::funding::settle_funding_payment(user, &user_key, market_map, now)?;

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

    if params.order_type == OrderType::TriggerMarket || params.order_type == OrderType::TriggerLimit
    {
        msg!("temp disabled trigger orders");
        panic!();
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

        increase_open_bids_and_asks(market_position, &params.direction, base_asset_amount)?;

        let existing_position_direction = if market_position.base_asset_amount >= 0 {
            PositionDirection::Long
        } else {
            PositionDirection::Short
        };
        (existing_position_direction, base_asset_amount)
    };

    let (auction_start_price, auction_end_price) = if let OrderType::Market = params.order_type {
        let auction_start_price = calculate_auction_start_price(market, params.direction)?;
        let auction_end_price =
            calculate_auction_end_price(market, params.direction, order_base_asset_amount)?;
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
        quote_asset_amount: params.quote_asset_amount,
        base_asset_amount_filled: 0,
        quote_asset_amount_filled: 0,
        fee: 0,
        direction: params.direction,
        reduce_only: params.reduce_only,
        discount_tier: OrderDiscountTier::None,
        trigger_price: params.trigger_price,
        trigger_condition: params.trigger_condition,
        referrer: Pubkey::default(),
        post_only: params.post_only,
        oracle_price_offset: params.oracle_price_offset,
        immediate_or_cancel: params.immediate_or_cancel,
        auction_start_price,
        auction_end_price,
        auction_duration: state.order_auction_duration,
        padding: [0; 3],
    };

    let valid_oracle_price = get_valid_oracle_price(
        oracle,
        market,
        &new_order,
        &state.oracle_guard_rails.validity,
        clock.slot,
    )?;

    validate_order(&new_order, market, state, valid_oracle_price, slot)?;

    user.orders[new_order_index] = new_order;

    let worst_case_base_asset_amount_after =
        user.positions[position_index].worst_case_base_asset_amount()?;

    // Order fails if it's risk increasing and it brings the user collateral below the margin requirement
    let risk_increasing = worst_case_base_asset_amount_after.unsigned_abs()
        > worst_case_base_asset_amount_before.unsigned_abs();
    let meets_initial_maintenance_requirement =
        meets_initial_margin_requirement(user, market_map, bank_map, oracle_map)?;
    if !meets_initial_maintenance_requirement && risk_increasing {
        return Err(ErrorCode::InsufficientCollateral);
    }

    let (taker, taker_order, taker_unsettled_pnl, maker, maker_order, maker_unsettled_pnl) =
        get_taker_and_maker_for_order_record(&user_key, &new_order, 0);

    // emit order record
    emit!(OrderRecord {
        ts: now,
        slot,
        taker,
        taker_order,
        maker,
        maker_order,
        maker_unsettled_pnl,
        taker_unsettled_pnl,
        action: OrderAction::Place,
        action_explanation: OrderActionExplanation::None,
        filler: Pubkey::default(),
        fill_record_id: 0,
        market_index: market.market_index,
        base_asset_amount_filled: 0,
        quote_asset_amount_filled: 0,
        filler_reward: 0,
        taker_fee: 0,
        maker_rebate: 0,
        quote_asset_amount_surplus: 0,
        oracle_price: oracle_map.get_price_data(&market.amm.oracle)?.price,
    });

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
    let user = &mut load_mut(user)?;
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
    let user = &mut load_mut(user)?;
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
    )
}

pub fn cancel_order(
    order_index: usize,
    user: &mut User,
    user_key: &Pubkey,
    market_map: &MarketMap,
    oracle_map: &mut OracleMap,
    now: i64,
    slot: u64,
    explanation: OrderActionExplanation,
) -> ClearingHouseResult {
    controller::funding::settle_funding_payment(user, user_key, market_map, now)?;

    let (order_status, order_market_index, order_direction) =
        get_struct_values!(user.orders[order_index], status, market_index, direction);

    if order_status != OrderStatus::Open {
        return Err(ErrorCode::OrderNotOpen);
    }

    let market = &market_map.get_ref(&order_market_index)?;

    // When save in the record, we want the status to be canceled
    user.orders[order_index].status = OrderStatus::Canceled;

    let (taker, taker_order, taker_unsettled_pnl, maker, maker_order, maker_unsettled_pnl) =
        get_taker_and_maker_for_order_record(user_key, &user.orders[order_index], 0);

    emit!(OrderRecord {
        ts: now,
        slot,
        taker,
        taker_order,
        maker,
        maker_order,
        maker_unsettled_pnl,
        taker_unsettled_pnl,
        action: OrderAction::Cancel,
        action_explanation: explanation,
        filler: Pubkey::default(),
        fill_record_id: 0,
        market_index: market.market_index,
        base_asset_amount_filled: 0,
        quote_asset_amount_filled: 0,
        filler_reward: 0,
        taker_fee: 0,
        maker_rebate: 0,
        quote_asset_amount_surplus: 0,
        oracle_price: oracle_map.get_price_data(&market.amm.oracle)?.price
    });

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
    bank_map: &BankMap,
    market_map: &MarketMap,
    oracle_map: &mut OracleMap,
    oracle: &AccountInfo,
    filler: &AccountLoader<User>,
    maker: Option<&AccountLoader<User>>,
    maker_order_id: Option<u64>,
    clock: &Clock,
) -> ClearingHouseResult<u128> {
    let now = clock.unix_timestamp;
    let slot = clock.slot;

    let filler_key = filler.key();
    let user_key = user.key();
    let user = &mut load_mut(user)?;
    controller::funding::settle_funding_payment(user, &user_key, market_map, now)?;

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

    let mark_price_before: u128;
    let oracle_mark_spread_pct_before: i128;
    let is_oracle_valid: bool;
    let oracle_price: i128;
    {
        let market = &mut market_map.get_ref_mut(&market_index)?;
        validate!(
            (slot == market.amm.last_update_slot || market.amm.curve_update_intensity == 0),
            ErrorCode::AMMNotUpdatedInSameSlot,
            "AMM must be updated in a prior instruction within same slot"
        )?;

        oracle_mark_spread_pct_before = market.amm.last_oracle_mark_spread_pct;

        let oracle_price_data = &oracle_map.get_price_data(&market.amm.oracle)?;

        is_oracle_valid = amm::is_oracle_valid(
            &market.amm,
            oracle_price_data,
            &state.oracle_guard_rails.validity,
        )?;

        mark_price_before = market.amm.mark_price()?;
        oracle_price = oracle_price_data.price;
    }

    let valid_oracle_price = if is_oracle_valid {
        Some(oracle_price)
    } else {
        None
    };

    let (mut maker, maker_key, maker_order_index) = sanitize_maker_order(
        market_map,
        oracle_map,
        maker,
        maker_order_id,
        &user.orders[order_index],
        oracle_price,
        now,
        slot,
    )?;

    let is_filler_taker = user_key == filler_key;
    let is_filler_maker = maker_key.map_or(false, |key| key == user_key);
    let mut filler = if !is_filler_maker && !is_filler_taker {
        Some(load_mut(filler)?)
    } else {
        None
    };

    let (base_asset_amount, potentially_risk_increasing) = fulfill_order(
        state,
        user,
        order_index,
        &user_key,
        &mut maker.as_deref_mut(),
        maker_order_index,
        maker_key.as_ref(),
        &mut filler.as_deref_mut(),
        &filler_key,
        bank_map,
        market_map,
        oracle_map,
        mark_price_before,
        valid_oracle_price,
        now,
        slot,
    )?;

    if base_asset_amount == 0 {
        return Ok(0);
    }

    let mark_price_after: u128;
    let oracle_mark_spread_pct_after: i128;
    {
        let market = market_map.get_ref_mut(&market_index)?;
        mark_price_after = market.amm.mark_price()?;
        let oracle_price_data = &oracle_map.get_price_data(&market.amm.oracle)?;
        oracle_mark_spread_pct_after = amm::calculate_oracle_mark_spread_pct(
            &market.amm,
            oracle_price_data,
            Some(mark_price_after),
        )?;
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
            oracle,
            now,
            slot,
            &state.oracle_guard_rails,
            state.funding_paused,
            Some(mark_price_before),
        )?;
    }

    Ok(base_asset_amount)
}

#[allow(clippy::type_complexity)]
fn sanitize_maker_order<'a>(
    market_map: &MarketMap,
    oracle_map: &mut OracleMap,
    maker: Option<&'a AccountLoader<User>>,
    maker_order_id: Option<u64>,
    taker_order: &Order,
    oracle_price: i128,
    now: i64,
    slot: u64,
) -> ClearingHouseResult<(Option<RefMut<'a, User>>, Option<Pubkey>, Option<usize>)> {
    if maker.is_none() {
        return Ok((None, None, None));
    }

    let maker = maker.unwrap();
    let maker_key = maker.key();
    let mut maker = load_mut(maker)?;
    let maker_order_index =
        maker.get_order_index(maker_order_id.ok_or(ErrorCode::MakerOrderNotFound)?)?;

    if !is_maker_for_taker(&maker.orders[maker_order_index], taker_order)? {
        return Ok((None, None, None));
    }

    // Dont fulfill with a maker order if oracle has diverged significantly
    if order_breaches_oracle_price_limits(&maker.orders[maker_order_index], oracle_price, slot)? {
        cancel_order(
            maker_order_index,
            maker.deref_mut(),
            &maker_key,
            market_map,
            oracle_map,
            now,
            slot,
            OrderActionExplanation::OraclePriceBreachedLimitPrice,
        )?;
        return Ok((None, None, None));
    }

    Ok((Some(maker), Some(maker_key), Some(maker_order_index)))
}

fn fulfill_order(
    state: &State,
    user: &mut User,
    user_order_index: usize,
    user_key: &Pubkey,
    maker: &mut Option<&mut User>,
    maker_order_index: Option<usize>,
    maker_key: Option<&Pubkey>,
    filler: &mut Option<&mut User>,
    filler_key: &Pubkey,
    bank_map: &BankMap,
    market_map: &MarketMap,
    oracle_map: &mut OracleMap,
    mark_price_before: u128,
    valid_oracle_price: Option<i128>,
    now: i64,
    slot: u64,
) -> ClearingHouseResult<(u128, bool)> {
    let market_index = user.orders[user_order_index].market_index;

    let user_checkpoint = checkpoint_user(user, market_index, Some(user_order_index))?;
    let maker_checkpoint = if let Some(maker) = maker {
        let maker_order_index = maker_order_index.ok_or(ErrorCode::MakerOrderNotFound)?;
        Some(checkpoint_user(
            maker,
            market_index,
            Some(maker_order_index),
        )?)
    } else {
        None
    };
    let filler_checkpoint = if let Some(filler) = filler {
        Some(checkpoint_user(filler, market_index, None)?)
    } else {
        None
    };

    let market_checkpoint = clone(market_map.get_ref(&market_index)?.deref());

    let fulfillment_methods =
        determine_fulfillment_methods(&user.orders[user_order_index], false, slot)?;

    if fulfillment_methods.is_empty() {
        return Ok((0, false));
    }

    let mut base_asset_amount = 0_u128;
    let mut potentially_risk_increasing = false;
    let mut order_records: Vec<OrderRecord> = vec![];
    for fulfillment_method in fulfillment_methods.iter() {
        if user.orders[user_order_index].status != OrderStatus::Open {
            break;
        }

        let mut market = market_map.get_ref_mut(&market_index)?;

        let (_base_asset_amount, _potentially_risk_increasing) = match fulfillment_method {
            FulfillmentMethod::AMM => fulfill_order_with_amm(
                state,
                user,
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
                &mut order_records,
            )?,
            FulfillmentMethod::Match => fulfill_order_with_match(
                market.deref_mut(),
                user,
                user_order_index,
                user_key,
                maker.as_deref_mut().unwrap(),
                maker_order_index.unwrap(),
                maker_key.unwrap(),
                filler.as_deref_mut(),
                filler_key,
                now,
                slot,
                &state.fee_structure,
                oracle_map,
                &mut order_records,
            )?,
        };

        potentially_risk_increasing = potentially_risk_increasing || _potentially_risk_increasing;
        base_asset_amount = base_asset_amount
            .checked_add(_base_asset_amount)
            .ok_or_else(math_error!())?;
    }

    let meets_initial_margin_requirement =
        meets_initial_margin_requirement(user, market_map, bank_map, oracle_map)?;

    if meets_initial_margin_requirement {
        for order_record in order_records {
            emit!(order_record)
        }
    } else {
        revert_to_checkpoint(user, user_checkpoint)?;
        if let Some(maker) = maker {
            revert_to_checkpoint(maker, maker_checkpoint.unwrap())?;
        }
        if let Some(filler) = filler {
            revert_to_checkpoint(filler, filler_checkpoint.unwrap())?;
        }
        {
            let mut market = market_map.get_ref_mut(&market_index)?;
            *market = *market_checkpoint;
        }

        cancel_order(
            user_order_index,
            user,
            user_key,
            market_map,
            oracle_map,
            now,
            slot,
            OrderActionExplanation::BreachedMarginRequirement,
        )?
    }

    Ok((base_asset_amount, potentially_risk_increasing))
}

struct UserCheckpoint {
    pub order_index: Option<usize>,
    pub order: Option<Box<Order>>,
    pub position_index: usize,
    pub position: Box<MarketPosition>,
    pub fees: Box<UserFees>,
}

fn checkpoint_user(
    user: &mut User,
    market_index: u64,
    order_index: Option<usize>,
) -> ClearingHouseResult<UserCheckpoint> {
    let order = if let Some(order_index) = order_index {
        let mut order = unsafe {
            let layout = Layout::new::<Order>();
            let raw_allocation = alloc_zeroed(layout) as *mut Order;
            Box::from_raw(raw_allocation)
        };
        *order = user.orders[order_index];
        Some(order)
    } else {
        None
    };

    let position_index = get_position_index(&user.positions, market_index)
        .or_else(|_| add_new_position(&mut user.positions, market_index))?;
    let mut position = unsafe {
        let layout = Layout::new::<MarketPosition>();
        let raw_allocation = alloc_zeroed(layout) as *mut MarketPosition;
        Box::from_raw(raw_allocation)
    };
    *position = user.positions[position_index];
    let mut fees = unsafe {
        let layout = Layout::new::<UserFees>();
        let raw_allocation = alloc_zeroed(layout) as *mut UserFees;
        Box::from_raw(raw_allocation)
    };
    *fees = user.fees;
    Ok(UserCheckpoint {
        order_index,
        order,
        position_index,
        position,
        fees,
    })
}

fn clone<T: Copy>(original: &T) -> Box<T> {
    let mut clone = unsafe {
        let layout = Layout::new::<T>();
        let raw_allocation = alloc_zeroed(layout) as *mut T;
        Box::from_raw(raw_allocation)
    };
    *clone = *original;
    clone
}

fn revert_to_checkpoint(user: &mut User, checkpoint: UserCheckpoint) -> ClearingHouseResult {
    user.fees = *checkpoint.fees;
    user.positions[checkpoint.position_index] = *checkpoint.position;
    if let Some(order) = checkpoint.order {
        user.orders[checkpoint.order_index.unwrap()] = *order;
    }
    Ok(())
}

pub fn fulfill_order_with_amm(
    state: &State,
    user: &mut User,
    order_index: usize,
    market: &mut Market,
    oracle_map: &mut OracleMap,
    mark_price_before: u128,
    now: i64,
    slot: u64,
    value_oracle_price: Option<i128>,
    user_key: &Pubkey,
    filler_key: &Pubkey,
    filler: &mut Option<&mut User>,
    order_records: &mut Vec<OrderRecord>,
) -> ClearingHouseResult<(u128, bool)> {
    let order_type = user.orders[order_index].order_type;
    let (
        base_asset_amount,
        quote_asset_amount,
        potentially_risk_increasing,
        quote_asset_amount_surplus,
        pnl,
    ) = match order_type {
        OrderType::Market => {
            execute_market_order(user, order_index, market, mark_price_before, now)?
        }
        _ => execute_non_market_order(
            user,
            order_index,
            market,
            mark_price_before,
            now,
            slot,
            value_oracle_price,
        )?,
    };

    let mut unsettled_pnl = pnl;

    let (order_post_only, order_ts, order_direction) =
        get_struct_values!(user.orders[order_index], post_only, ts, direction);

    let (user_fee, fee_to_market, filler_reward) =
        fees::calculate_fee_for_order_fulfill_against_amm(
            quote_asset_amount,
            &state.fee_structure,
            order_ts,
            now,
            filler.is_some(),
            quote_asset_amount_surplus,
            order_post_only,
        )?;

    let position_index = get_position_index(&user.positions, market.market_index)?;
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
    market.amm.total_mm_fee = market
        .amm
        .total_mm_fee
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
    user.fees.total_fee_paid = user
        .fees
        .total_fee_paid
        .checked_add(cast(user_fee)?)
        .ok_or_else(math_error!())?;

    controller::position::update_unsettled_pnl(
        &mut user.positions[position_index],
        market,
        -cast(user_fee)?,
    )?;

    unsettled_pnl = unsettled_pnl
        .checked_sub(cast(user_fee)?)
        .ok_or_else(math_error!())?;

    if let Some(filler) = filler.as_mut() {
        let position_index = get_position_index(&filler.positions, market.market_index)
            .or_else(|_| add_new_position(&mut filler.positions, market.market_index))?;

        controller::position::update_unsettled_pnl(
            &mut filler.positions[position_index],
            market,
            cast(filler_reward)?,
        )?;
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

    let (taker, taker_order, taker_unsettled_pnl, maker, maker_order, maker_unsettled_pnl) =
        get_taker_and_maker_for_order_record(user_key, &user.orders[order_index], unsettled_pnl);

    let fill_record_id = get_then_update_id!(market, next_fill_record_id);
    order_records.push(OrderRecord {
        ts: now,
        slot,
        taker,
        taker_order,
        maker,
        maker_order,
        taker_unsettled_pnl,
        maker_unsettled_pnl,
        action: OrderAction::Fill,
        action_explanation: OrderActionExplanation::None,
        filler: *filler_key,
        fill_record_id,
        market_index: market.market_index,
        base_asset_amount_filled: base_asset_amount,
        quote_asset_amount_filled: quote_asset_amount,
        filler_reward,
        taker_fee: user_fee,
        maker_rebate: 0,
        quote_asset_amount_surplus,
        oracle_price: oracle_map.get_price_data(&market.amm.oracle)?.price,
    });

    // Cant reset order until after its logged
    if user.orders[order_index].get_base_asset_amount_unfilled()? == 0
        || user.orders[order_index].order_type == OrderType::Market
    {
        user.orders[order_index] = Order::default();
        let market_position = &mut user.positions[position_index];
        market_position.open_orders -= 1;
    }

    Ok((base_asset_amount, potentially_risk_increasing))
}

pub fn fulfill_order_with_match(
    market: &mut Market,
    taker: &mut User,
    taker_order_index: usize,
    taker_key: &Pubkey,
    maker: &mut User,
    maker_order_index: usize,
    maker_key: &Pubkey,
    filler: Option<&mut User>,
    filler_key: &Pubkey,
    now: i64,
    slot: u64,
    fee_structure: &FeeStructure,
    oracle_map: &mut OracleMap,
    order_records: &mut Vec<OrderRecord>,
) -> ClearingHouseResult<(u128, bool)> {
    if !are_orders_same_market_but_different_sides(
        &maker.orders[maker_order_index],
        &taker.orders[taker_order_index],
    ) {
        return Ok((0_u128, false));
    }

    let taker_price = taker.orders[taker_order_index].get_limit_price(None, slot)?;
    let taker_base_asset_amount =
        taker.orders[taker_order_index].get_base_asset_amount_unfilled()?;

    let maker_price = maker.orders[maker_order_index].get_limit_price(None, slot)?;
    let maker_direction = &maker.orders[maker_order_index].direction;
    let maker_base_asset_amount =
        maker.orders[maker_order_index].get_base_asset_amount_unfilled()?;

    let orders_cross = do_orders_cross(maker_direction, maker_price, taker_price);

    if !orders_cross {
        return Ok((0_u128, false));
    }

    let (base_asset_amount, quote_asset_amount) = calculate_fill_for_matched_orders(
        maker_base_asset_amount,
        maker_price,
        taker_base_asset_amount,
    )?;

    if base_asset_amount == 0 {
        return Ok((0_u128, false));
    }

    let maker_position_index = get_position_index(
        &maker.positions,
        maker.orders[maker_order_index].market_index,
    )?;

    let maker_position_delta = get_position_delta_for_fill(
        base_asset_amount,
        quote_asset_amount,
        maker.orders[maker_order_index].direction,
    )?;

    let mut maker_unsettled_pnl = update_position_and_market(
        &mut maker.positions[maker_position_index],
        market,
        &maker_position_delta,
    )?;

    let taker_position_index = get_position_index(
        &taker.positions,
        taker.orders[maker_order_index].market_index,
    )?;

    let taker_position_delta = get_position_delta_for_fill(
        base_asset_amount,
        quote_asset_amount,
        taker.orders[maker_order_index].direction,
    )?;

    let mut taker_unsettled_pnl = update_position_and_market(
        &mut taker.positions[taker_position_index],
        market,
        &taker_position_delta,
    )?;

    let (taker_fee, maker_rebate, fee_to_market, filler_reward) =
        fees::calculate_fee_for_fulfillment_with_match(
            quote_asset_amount,
            fee_structure,
            taker.orders[taker_order_index].ts,
            now,
            filler.is_some(),
        )?;

    // Increment the markets house's total fee variables
    market.amm.total_fee = market
        .amm
        .total_fee
        .checked_add(fee_to_market)
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

    controller::position::update_unsettled_pnl(
        &mut taker.positions[taker_position_index],
        market,
        -cast(taker_fee)?,
    )?;

    taker.fees.total_fee_paid = taker
        .fees
        .total_fee_paid
        .checked_add(cast(taker_fee)?)
        .ok_or_else(math_error!())?;

    taker_unsettled_pnl = taker_unsettled_pnl
        .checked_sub(cast(taker_fee)?)
        .ok_or_else(math_error!())?;

    controller::position::update_unsettled_pnl(
        &mut maker.positions[maker_position_index],
        market,
        cast(maker_rebate)?,
    )?;

    maker.fees.total_fee_rebate = maker
        .fees
        .total_fee_rebate
        .checked_add(cast(maker_rebate)?)
        .ok_or_else(math_error!())?;

    maker_unsettled_pnl = maker_unsettled_pnl
        .checked_add(cast(maker_rebate)?)
        .ok_or_else(math_error!())?;

    if let Some(filler) = filler {
        let filler_position_index = get_position_index(&filler.positions, market.market_index)
            .or_else(|_| add_new_position(&mut filler.positions, market.market_index))?;

        controller::position::update_unsettled_pnl(
            &mut filler.positions[filler_position_index],
            market,
            cast(filler_reward)?,
        )?;
    }

    update_order_after_fill(
        &mut taker.orders[taker_order_index],
        market.amm.base_asset_amount_step_size,
        base_asset_amount,
        quote_asset_amount,
        cast(taker_fee)?,
    )?;

    decrease_open_bids_and_asks(
        &mut taker.positions[taker_position_index],
        &taker.orders[taker_order_index].direction,
        base_asset_amount,
    )?;

    update_order_after_fill(
        &mut maker.orders[maker_order_index],
        market.amm.base_asset_amount_step_size,
        base_asset_amount,
        quote_asset_amount,
        -cast(maker_rebate)?,
    )?;

    decrease_open_bids_and_asks(
        &mut maker.positions[maker_position_index],
        &maker.orders[maker_order_index].direction,
        base_asset_amount,
    )?;

    let fill_record_id = get_then_update_id!(market, next_fill_record_id);
    order_records.push(OrderRecord {
        ts: now,
        slot,
        taker: *taker_key,
        taker_order: taker.orders[taker_order_index],
        taker_unsettled_pnl,
        maker: *maker_key,
        maker_order: maker.orders[maker_order_index],
        maker_unsettled_pnl,
        action: OrderAction::Fill,
        action_explanation: OrderActionExplanation::None,
        filler: *filler_key,
        fill_record_id,
        market_index: market.market_index,
        base_asset_amount_filled: base_asset_amount,
        quote_asset_amount_filled: quote_asset_amount,
        filler_reward,
        taker_fee,
        maker_rebate,
        quote_asset_amount_surplus: 0,
        oracle_price: oracle_map.get_price_data(&market.amm.oracle)?.price,
    });

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

    Ok((base_asset_amount, false))
}

pub fn execute_market_order(
    user: &mut User,
    order_index: usize,
    market: &mut Market,
    mark_price_before: u128,
    now: i64,
) -> ClearingHouseResult<(u128, u128, bool, u128, i128)> {
    let position_index = get_position_index(&user.positions, market.market_index)?;

    let (order_direction, order_price, order_base_asset_amount) = get_struct_values!(
        user.orders[order_index],
        direction,
        price,
        base_asset_amount
    );

    let (
        potentially_risk_increasing,
        base_asset_amount,
        quote_asset_amount,
        quote_asset_amount_surplus,
        pnl,
    ) = controller::position::update_position_with_base_asset_amount(
        order_base_asset_amount,
        user.orders[order_index].direction,
        market,
        user,
        position_index,
        mark_price_before,
        now,
        None,
    )?;

    controller::position::update_unsettled_pnl(&mut user.positions[position_index], market, pnl)?;

    if order_price > 0
        && !limit_price_satisfied(
            order_price,
            quote_asset_amount,
            base_asset_amount,
            order_direction,
        )?
    {
        return Err(ErrorCode::SlippageOutsideLimit);
    }

    Ok((
        base_asset_amount,
        quote_asset_amount,
        potentially_risk_increasing,
        quote_asset_amount_surplus,
        pnl,
    ))
}

pub fn execute_non_market_order(
    user: &mut User,
    order_index: usize,
    market: &mut Market,
    mark_price_before: u128,
    now: i64,
    slot: u64,
    valid_oracle_price: Option<i128>,
) -> ClearingHouseResult<(u128, u128, bool, u128, i128)> {
    // Determine the base asset amount the market can fill
    let base_asset_amount = calculate_base_asset_amount_market_can_execute(
        &user.orders[order_index],
        market,
        Some(mark_price_before),
        valid_oracle_price,
        slot,
    )?;

    if base_asset_amount == 0 {
        msg!("Market cant execute order");
        return Ok((0, 0, false, 0, 0));
    }

    if base_asset_amount < market.amm.base_asset_amount_step_size {
        msg!("base asset amount too small {}", base_asset_amount);
        return Ok((0, 0, false, 0, 0));
    }

    let (order_direction, order_post_only, order_base_asset_amount, order_base_asset_amount_filled) = get_struct_values!(
        user.orders[order_index],
        direction,
        post_only,
        base_asset_amount,
        base_asset_amount_filled
    );

    let base_asset_amount_left_to_fill = order_base_asset_amount
        .checked_sub(
            order_base_asset_amount_filled
                .checked_add(base_asset_amount)
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?;

    if base_asset_amount_left_to_fill != 0
        && base_asset_amount_left_to_fill < market.amm.base_asset_amount_step_size
    {
        return Err(ErrorCode::OrderAmountTooSmall);
    }

    if base_asset_amount == 0 {
        return Ok((0, 0, false, 0, 0));
    }

    let position_index = get_position_index(&user.positions, market.market_index)?;

    let maker_limit_price = if order_post_only {
        Some(user.orders[order_index].get_limit_price(valid_oracle_price, slot)?)
    } else {
        None
    };
    let (potentially_risk_increasing, _, quote_asset_amount, quote_asset_amount_surplus, pnl) =
        controller::position::update_position_with_base_asset_amount(
            base_asset_amount,
            order_direction,
            market,
            user,
            position_index,
            mark_price_before,
            now,
            maker_limit_price,
        )?;

    controller::position::update_unsettled_pnl(&mut user.positions[position_index], market, pnl)?;

    Ok((
        base_asset_amount,
        quote_asset_amount,
        potentially_risk_increasing,
        quote_asset_amount_surplus,
        pnl,
    ))
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
    oracle: Option<&AccountInfo>,
    market: &Market,
    order: &Order,
    validity_guardrails: &ValidityGuardRails,
    slot: u64,
) -> ClearingHouseResult<Option<i128>> {
    let price = if let Some(oracle) = oracle {
        let oracle_data = market.amm.get_oracle_price(oracle, slot)?;
        let is_oracle_valid = is_oracle_valid(&market.amm, &oracle_data, validity_guardrails)?;
        if is_oracle_valid {
            Some(oracle_data.price)
        } else if order.has_oracle_price_offset() {
            msg!("Invalid oracle for order with oracle price offset");
            return Err(print_error!(ErrorCode::InvalidOracle)());
        } else {
            None
        }
    } else if order.has_oracle_price_offset() {
        msg!("Oracle not found for order with oracle price offset");
        return Err(print_error!(ErrorCode::OracleNotFound)());
    } else {
        None
    };

    Ok(price)
}

fn get_taker_and_maker_for_order_record(
    user_key: &Pubkey,
    user_order: &Order,
    unsettled_pnl: i128,
) -> (Pubkey, Order, i128, Pubkey, Order, i128) {
    if user_order.post_only {
        (
            Pubkey::default(),
            Order::default(),
            0,
            *user_key,
            *user_order,
            unsettled_pnl,
        )
    } else {
        (
            *user_key,
            *user_order,
            unsettled_pnl,
            Pubkey::default(),
            Order::default(),
            0,
        )
    }
}

#[cfg(test)]
mod tests {

    pub mod fulfill_order_with_maker_order {
        use crate::controller::orders::fulfill_order_with_match;
        use crate::controller::position::PositionDirection;
        use crate::math::constants::{
            BASE_PRECISION, BASE_PRECISION_I128, MARK_PRICE_PRECISION, QUOTE_PRECISION,
        };
        use crate::state::market::Market;
        use crate::state::oracle_map::OracleMap;
        use crate::state::state::FeeStructure;
        use crate::state::user::{MarketPosition, Order, OrderType, User};
        use anchor_lang::prelude::Pubkey;

        fn get_positions(order: MarketPosition) -> [MarketPosition; 5] {
            let mut positions = [MarketPosition::default(); 5];
            positions[0] = order;
            positions
        }

        fn get_orders(order: Order) -> [Order; 32] {
            let mut orders = [Order::default(); 32];
            orders[0] = order;
            orders
        }

        fn get_fee_structure() -> FeeStructure {
            FeeStructure {
                fee_numerator: 5,
                fee_denominator: 10000,
                maker_rebate_numerator: 3,
                maker_rebate_denominator: 5,
                ..FeeStructure::default()
            }
        }

        fn get_user_keys() -> (Pubkey, Pubkey, Pubkey) {
            (Pubkey::default(), Pubkey::default(), Pubkey::default())
        }

        fn get_oracle_map<'a>() -> OracleMap<'a> {
            OracleMap::empty()
        }

        #[test]
        fn long_taker_order_fulfilled_start_of_auction() {
            let mut taker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    order_type: OrderType::Market,
                    direction: PositionDirection::Long,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    slot: 0,
                    auction_start_price: 100 * MARK_PRICE_PRECISION,
                    auction_end_price: 200 * MARK_PRICE_PRECISION,
                    auction_duration: 5,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_bids: 1 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut maker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    post_only: true,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Short,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    price: 100 * MARK_PRICE_PRECISION,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_asks: -1 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut market = Market::default();

            let now = 1_i64;
            let slot = 1_u64;

            let fee_structure = get_fee_structure();

            let (taker_key, maker_key, filler_key) = get_user_keys();

            let mut order_records = vec![];

            fulfill_order_with_match(
                &mut market,
                &mut taker,
                0,
                &taker_key,
                &mut maker,
                0,
                &maker_key,
                None,
                &filler_key,
                now,
                slot,
                &fee_structure,
                &mut get_oracle_map(),
                &mut order_records,
            )
            .unwrap();

            let taker_position = &taker.positions[0];
            assert_eq!(taker_position.base_asset_amount, 1 * BASE_PRECISION_I128);
            assert_eq!(taker_position.quote_asset_amount, 100 * QUOTE_PRECISION);
            assert_eq!(taker_position.quote_entry_amount, 100 * QUOTE_PRECISION);
            assert_eq!(taker_position.unsettled_pnl, -50000);
            assert_eq!(taker_position.open_bids, 0);
            assert_eq!(taker_position.open_orders, 0);
            assert_eq!(taker.fees.total_fee_paid, 50000);
            assert_eq!(taker.fees.total_referee_discount, 0);
            assert_eq!(taker.fees.total_token_discount, 0);
            assert_eq!(taker.orders[0], Order::default());

            let maker_position = &maker.positions[0];
            assert_eq!(maker_position.base_asset_amount, -1 * BASE_PRECISION_I128);
            assert_eq!(maker_position.quote_asset_amount, 100 * QUOTE_PRECISION);
            assert_eq!(maker_position.quote_entry_amount, 100 * QUOTE_PRECISION);
            assert_eq!(maker_position.unsettled_pnl, 30000);
            assert_eq!(maker_position.open_orders, 0);
            assert_eq!(maker_position.open_asks, 0);
            assert_eq!(maker.fees.total_fee_rebate, 30000);
            assert_eq!(maker.orders[0], Order::default());

            assert_eq!(market.amm.net_base_asset_amount, 0);
            assert_eq!(market.base_asset_amount_long, BASE_PRECISION_I128);
            assert_eq!(market.base_asset_amount_short, -BASE_PRECISION_I128);
            assert_eq!(market.amm.quote_asset_amount_long, 100 * QUOTE_PRECISION);
            assert_eq!(market.amm.quote_asset_amount_short, 100 * QUOTE_PRECISION);
            assert_eq!(market.amm.total_fee, 20000);
            assert_eq!(market.amm.total_fee_minus_distributions, 20000);
            assert_eq!(market.amm.net_revenue_since_last_funding, 20000);
            assert_eq!(market.unsettled_profit, 30000);
            assert_eq!(market.unsettled_loss, 50000);
        }

        #[test]
        fn long_taker_order_fulfilled_middle_of_auction() {
            let mut taker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    order_type: OrderType::Market,
                    direction: PositionDirection::Long,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    slot: 0,
                    auction_start_price: 100 * MARK_PRICE_PRECISION,
                    auction_end_price: 200 * MARK_PRICE_PRECISION,
                    auction_duration: 5,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_bids: 1 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut maker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    post_only: true,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Short,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    price: 160 * MARK_PRICE_PRECISION,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_asks: -1 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut market = Market::default();

            let now = 3_i64;
            let slot = 3_u64;

            let fee_structure = get_fee_structure();

            let (taker_key, maker_key, filler_key) = get_user_keys();

            let mut order_records = vec![];

            fulfill_order_with_match(
                &mut market,
                &mut taker,
                0,
                &taker_key,
                &mut maker,
                0,
                &maker_key,
                None,
                &filler_key,
                now,
                slot,
                &fee_structure,
                &mut get_oracle_map(),
                &mut order_records,
            )
            .unwrap();

            let taker_position = &taker.positions[0];
            assert_eq!(taker_position.base_asset_amount, 1 * BASE_PRECISION_I128);
            assert_eq!(taker_position.quote_asset_amount, 160 * QUOTE_PRECISION);
            assert_eq!(taker_position.quote_entry_amount, 160 * QUOTE_PRECISION);
            assert_eq!(taker_position.unsettled_pnl, -80000);
            assert_eq!(taker_position.open_bids, 0);
            assert_eq!(taker_position.open_orders, 0);
            assert_eq!(taker.fees.total_fee_paid, 80000);
            assert_eq!(taker.fees.total_referee_discount, 0);
            assert_eq!(taker.fees.total_token_discount, 0);
            assert_eq!(taker.orders[0], Order::default());

            let maker_position = &maker.positions[0];
            assert_eq!(maker_position.base_asset_amount, -1 * BASE_PRECISION_I128);
            assert_eq!(maker_position.quote_asset_amount, 160 * QUOTE_PRECISION);
            assert_eq!(maker_position.quote_entry_amount, 160 * QUOTE_PRECISION);
            assert_eq!(maker_position.unsettled_pnl, 48000);
            assert_eq!(maker_position.open_orders, 0);
            assert_eq!(maker_position.open_asks, 0);
            assert_eq!(maker.fees.total_fee_rebate, 48000);
            assert_eq!(maker.orders[0], Order::default());

            assert_eq!(market.amm.net_base_asset_amount, 0);
            assert_eq!(market.base_asset_amount_long, BASE_PRECISION_I128);
            assert_eq!(market.base_asset_amount_short, -BASE_PRECISION_I128);
            assert_eq!(market.amm.quote_asset_amount_long, 160 * QUOTE_PRECISION);
            assert_eq!(market.amm.quote_asset_amount_short, 160 * QUOTE_PRECISION);
            assert_eq!(market.amm.total_fee, 32000);
            assert_eq!(market.amm.total_fee_minus_distributions, 32000);
            assert_eq!(market.amm.net_revenue_since_last_funding, 32000);
            assert_eq!(market.unsettled_profit, 48000);
            assert_eq!(market.unsettled_loss, 80000);
        }

        #[test]
        fn short_taker_order_fulfilled_start_of_auction() {
            let mut taker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    order_type: OrderType::Market,
                    direction: PositionDirection::Short,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    slot: 0,
                    auction_start_price: 200 * MARK_PRICE_PRECISION,
                    auction_end_price: 100 * MARK_PRICE_PRECISION,
                    auction_duration: 5,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_asks: -1 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut maker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    post_only: true,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Long,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    price: 180 * MARK_PRICE_PRECISION,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_bids: 1 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut market = Market::default();

            let now = 1_i64;
            let slot = 1_u64;

            let fee_structure = get_fee_structure();

            let (taker_key, maker_key, filler_key) = get_user_keys();

            let mut order_records = vec![];

            fulfill_order_with_match(
                &mut market,
                &mut taker,
                0,
                &taker_key,
                &mut maker,
                0,
                &maker_key,
                None,
                &filler_key,
                now,
                slot,
                &fee_structure,
                &mut get_oracle_map(),
                &mut order_records,
            )
            .unwrap();

            let taker_position = &taker.positions[0];
            assert_eq!(taker_position.base_asset_amount, -1 * BASE_PRECISION_I128);
            assert_eq!(taker_position.quote_asset_amount, 180 * QUOTE_PRECISION);
            assert_eq!(taker_position.quote_entry_amount, 180 * QUOTE_PRECISION);
            assert_eq!(taker_position.unsettled_pnl, -90000);
            assert_eq!(taker_position.open_asks, 0);
            assert_eq!(taker_position.open_orders, 0);
            assert_eq!(taker.fees.total_fee_paid, 90000);
            assert_eq!(taker.fees.total_referee_discount, 0);
            assert_eq!(taker.fees.total_token_discount, 0);
            assert_eq!(taker.orders[0], Order::default());

            let maker_position = &maker.positions[0];
            assert_eq!(maker_position.base_asset_amount, 1 * BASE_PRECISION_I128);
            assert_eq!(maker_position.quote_asset_amount, 180 * QUOTE_PRECISION);
            assert_eq!(maker_position.quote_entry_amount, 180 * QUOTE_PRECISION);
            assert_eq!(maker_position.unsettled_pnl, 54000);
            assert_eq!(maker_position.open_orders, 0);
            assert_eq!(maker_position.open_bids, 0);
            assert_eq!(maker.fees.total_fee_rebate, 54000);
            assert_eq!(maker.orders[0], Order::default());

            assert_eq!(market.amm.net_base_asset_amount, 0);
            assert_eq!(market.base_asset_amount_long, BASE_PRECISION_I128);
            assert_eq!(market.base_asset_amount_short, -BASE_PRECISION_I128);
            assert_eq!(market.amm.quote_asset_amount_long, 180 * QUOTE_PRECISION);
            assert_eq!(market.amm.quote_asset_amount_short, 180 * QUOTE_PRECISION);
            assert_eq!(market.amm.total_fee, 36000);
            assert_eq!(market.amm.total_fee_minus_distributions, 36000);
            assert_eq!(market.amm.net_revenue_since_last_funding, 36000);
            assert_eq!(market.unsettled_profit, 54000);
            assert_eq!(market.unsettled_loss, 90000);
        }

        #[test]
        fn short_taker_order_fulfilled_middle_of_auction() {
            let mut taker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    order_type: OrderType::Market,
                    direction: PositionDirection::Short,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    slot: 0,
                    auction_start_price: 200 * MARK_PRICE_PRECISION,
                    auction_end_price: 100 * MARK_PRICE_PRECISION,
                    auction_duration: 5,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_asks: -1 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut maker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    post_only: true,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Long,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    price: 140 * MARK_PRICE_PRECISION,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_bids: 1 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut market = Market::default();

            let now = 3_i64;
            let slot = 3_u64;

            let fee_structure = get_fee_structure();

            let (taker_key, maker_key, filler_key) = get_user_keys();

            let mut order_records = vec![];

            fulfill_order_with_match(
                &mut market,
                &mut taker,
                0,
                &taker_key,
                &mut maker,
                0,
                &maker_key,
                None,
                &filler_key,
                now,
                slot,
                &fee_structure,
                &mut get_oracle_map(),
                &mut order_records,
            )
            .unwrap();

            let taker_position = &taker.positions[0];
            assert_eq!(taker_position.base_asset_amount, -1 * BASE_PRECISION_I128);
            assert_eq!(taker_position.quote_asset_amount, 140 * QUOTE_PRECISION);
            assert_eq!(taker_position.quote_entry_amount, 140 * QUOTE_PRECISION);
            assert_eq!(taker_position.unsettled_pnl, -70000);
            assert_eq!(taker_position.open_asks, 0);
            assert_eq!(taker_position.open_orders, 0);
            assert_eq!(taker.fees.total_fee_paid, 70000);
            assert_eq!(taker.fees.total_referee_discount, 0);
            assert_eq!(taker.fees.total_token_discount, 0);
            assert_eq!(taker.orders[0], Order::default());

            let maker_position = &maker.positions[0];
            assert_eq!(maker_position.base_asset_amount, 1 * BASE_PRECISION_I128);
            assert_eq!(maker_position.quote_asset_amount, 140 * QUOTE_PRECISION);
            assert_eq!(maker_position.quote_entry_amount, 140 * QUOTE_PRECISION);
            assert_eq!(maker_position.unsettled_pnl, 42000);
            assert_eq!(maker_position.open_orders, 0);
            assert_eq!(maker_position.open_bids, 0);
            assert_eq!(maker.fees.total_fee_rebate, 42000);
            assert_eq!(maker.orders[0], Order::default());

            assert_eq!(market.amm.net_base_asset_amount, 0);
            assert_eq!(market.base_asset_amount_long, BASE_PRECISION_I128);
            assert_eq!(market.base_asset_amount_short, -BASE_PRECISION_I128);
            assert_eq!(market.amm.quote_asset_amount_long, 140 * QUOTE_PRECISION);
            assert_eq!(market.amm.quote_asset_amount_short, 140 * QUOTE_PRECISION);
            assert_eq!(market.amm.total_fee, 28000);
            assert_eq!(market.amm.total_fee_minus_distributions, 28000);
            assert_eq!(market.amm.net_revenue_since_last_funding, 28000);
            assert_eq!(market.unsettled_profit, 42000);
            assert_eq!(market.unsettled_loss, 70000);
        }

        #[test]
        fn long_taker_order_auction_price_does_not_satisfy_maker() {
            let mut taker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    order_type: OrderType::Market,
                    direction: PositionDirection::Long,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    slot: 0,
                    auction_start_price: 100 * MARK_PRICE_PRECISION,
                    auction_end_price: 200 * MARK_PRICE_PRECISION,
                    auction_duration: 5,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_bids: 100 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut maker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    post_only: true,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Short,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    price: 201 * MARK_PRICE_PRECISION,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_bids: 100 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut market = Market::default();

            let now = 1_i64;
            let slot = 3_u64;

            let fee_structure = FeeStructure::default();

            let (taker_key, maker_key, filler_key) = get_user_keys();

            let mut order_records = vec![];

            let (base_asset_amount, _) = fulfill_order_with_match(
                &mut market,
                &mut taker,
                0,
                &taker_key,
                &mut maker,
                0,
                &maker_key,
                None,
                &filler_key,
                now,
                slot,
                &fee_structure,
                &mut get_oracle_map(),
                &mut order_records,
            )
            .unwrap();

            assert_eq!(base_asset_amount, 0);
        }

        #[test]
        fn short_taker_order_auction_price_does_not_satisfy_maker() {
            let mut taker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    order_type: OrderType::Market,
                    direction: PositionDirection::Short,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    auction_start_price: 200 * MARK_PRICE_PRECISION,
                    auction_end_price: 100 * MARK_PRICE_PRECISION,
                    auction_duration: 5,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_bids: 100 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut maker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    post_only: true,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Long,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    price: 99 * MARK_PRICE_PRECISION,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_bids: 100 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut market = Market::default();

            let now = 1_i64;
            let slot = 3_u64;

            let fee_structure = FeeStructure::default();

            let (taker_key, maker_key, filler_key) = get_user_keys();

            let mut order_records = vec![];

            let (base_asset_amount, _) = fulfill_order_with_match(
                &mut market,
                &mut taker,
                0,
                &taker_key,
                &mut maker,
                0,
                &maker_key,
                None,
                &filler_key,
                now,
                slot,
                &fee_structure,
                &mut get_oracle_map(),
                &mut order_records,
            )
            .unwrap();

            assert_eq!(base_asset_amount, 0);
        }

        #[test]
        fn maker_taker_same_direction() {
            let mut taker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    order_type: OrderType::Market,
                    direction: PositionDirection::Short,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    slot: 0,
                    auction_start_price: 200 * MARK_PRICE_PRECISION,
                    auction_end_price: 100 * MARK_PRICE_PRECISION,
                    auction_duration: 5,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_bids: 100 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut maker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    post_only: true,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Short,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    price: 200 * MARK_PRICE_PRECISION,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_bids: 100 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut market = Market::default();

            let now = 1_i64;
            let slot = 1_u64;

            let fee_structure = FeeStructure::default();

            let (taker_key, maker_key, filler_key) = get_user_keys();

            let mut order_records = vec![];

            let (base_asset_amount, _) = fulfill_order_with_match(
                &mut market,
                &mut taker,
                0,
                &taker_key,
                &mut maker,
                0,
                &maker_key,
                None,
                &filler_key,
                now,
                slot,
                &fee_structure,
                &mut get_oracle_map(),
                &mut order_records,
            )
            .unwrap();

            assert_eq!(base_asset_amount, 0);
        }

        #[test]
        fn maker_taker_different_market_index() {
            let mut taker = User {
                orders: get_orders(Order {
                    market_index: 1,
                    order_type: OrderType::Market,
                    direction: PositionDirection::Short,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    auction_start_price: 200 * MARK_PRICE_PRECISION,
                    auction_end_price: 100 * MARK_PRICE_PRECISION,
                    auction_duration: 5,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_bids: 100 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut maker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    post_only: true,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Long,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    price: 200 * MARK_PRICE_PRECISION,
                    auction_duration: 5,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_bids: 100 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut market = Market::default();

            let now = 1_i64;
            let slot = 1_u64;

            let fee_structure = FeeStructure::default();

            let (taker_key, maker_key, filler_key) = get_user_keys();

            let mut order_records = vec![];

            let (base_asset_amount, _) = fulfill_order_with_match(
                &mut market,
                &mut taker,
                0,
                &taker_key,
                &mut maker,
                0,
                &maker_key,
                None,
                &filler_key,
                now,
                slot,
                &fee_structure,
                &mut get_oracle_map(),
                &mut order_records,
            )
            .unwrap();

            assert_eq!(base_asset_amount, 0);
        }

        #[test]
        fn long_taker_order_bigger_than_maker() {
            let mut taker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    order_type: OrderType::Market,
                    direction: PositionDirection::Long,
                    base_asset_amount: 100 * BASE_PRECISION,
                    ts: 0,
                    slot: 0,
                    auction_start_price: 100 * MARK_PRICE_PRECISION,
                    auction_end_price: 200 * MARK_PRICE_PRECISION,
                    auction_duration: 5,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_bids: 100 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut maker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    post_only: true,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Short,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    price: 120 * MARK_PRICE_PRECISION,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_asks: -1 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut market = Market::default();

            let now = 1_i64;
            let slot = 1_u64;
            let auction_duration = 5_i64;

            let fee_structure = FeeStructure::default();

            let (taker_key, maker_key, filler_key) = get_user_keys();

            let mut order_records = vec![];

            fulfill_order_with_match(
                &mut market,
                &mut taker,
                0,
                &taker_key,
                &mut maker,
                0,
                &maker_key,
                None,
                &filler_key,
                now,
                slot,
                &fee_structure,
                &mut get_oracle_map(),
                &mut order_records,
            )
            .unwrap();

            let taker_position = &taker.positions[0];
            assert_eq!(taker_position.base_asset_amount, 1 * BASE_PRECISION_I128);
            assert_eq!(taker_position.quote_asset_amount, 120 * QUOTE_PRECISION);
            assert_eq!(taker_position.quote_entry_amount, 120 * QUOTE_PRECISION);

            let maker_position = &maker.positions[0];
            assert_eq!(maker_position.base_asset_amount, -1 * BASE_PRECISION_I128);
            assert_eq!(maker_position.quote_asset_amount, 120 * QUOTE_PRECISION);
            assert_eq!(maker_position.quote_entry_amount, 120 * QUOTE_PRECISION);

            assert_eq!(market.amm.net_base_asset_amount, 0);
            assert_eq!(market.base_asset_amount_long, BASE_PRECISION_I128);
            assert_eq!(market.base_asset_amount_short, -BASE_PRECISION_I128);
            assert_eq!(market.amm.quote_asset_amount_long, 120 * QUOTE_PRECISION);
            assert_eq!(market.amm.quote_asset_amount_short, 120 * QUOTE_PRECISION);
        }

        #[test]
        fn long_taker_order_smaller_than_maker() {
            let mut taker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    order_type: OrderType::Market,
                    direction: PositionDirection::Long,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    slot: 0,
                    auction_start_price: 100 * MARK_PRICE_PRECISION,
                    auction_end_price: 200 * MARK_PRICE_PRECISION,
                    auction_duration: 5,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_bids: 100 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut maker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    post_only: true,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Short,
                    base_asset_amount: 100 * BASE_PRECISION,
                    ts: 0,
                    price: 120 * MARK_PRICE_PRECISION,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_bids: 100 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut market = Market::default();

            let now = 1_i64;
            let slot = 1_u64;
            let auction_duration = 5_i64;

            let fee_structure = FeeStructure::default();

            let (taker_key, maker_key, filler_key) = get_user_keys();

            let mut order_records = vec![];

            fulfill_order_with_match(
                &mut market,
                &mut taker,
                0,
                &taker_key,
                &mut maker,
                0,
                &maker_key,
                None,
                &filler_key,
                now,
                slot,
                &fee_structure,
                &mut get_oracle_map(),
                &mut order_records,
            )
            .unwrap();

            let taker_position = &taker.positions[0];
            assert_eq!(taker_position.base_asset_amount, 1 * BASE_PRECISION_I128);
            assert_eq!(taker_position.quote_asset_amount, 120 * QUOTE_PRECISION);
            assert_eq!(taker_position.quote_entry_amount, 120 * QUOTE_PRECISION);

            let maker_position = &maker.positions[0];
            assert_eq!(maker_position.base_asset_amount, -1 * BASE_PRECISION_I128);
            assert_eq!(maker_position.quote_asset_amount, 120 * QUOTE_PRECISION);
            assert_eq!(maker_position.quote_entry_amount, 120 * QUOTE_PRECISION);

            assert_eq!(market.amm.net_base_asset_amount, 0);
            assert_eq!(market.base_asset_amount_long, BASE_PRECISION_I128);
            assert_eq!(market.base_asset_amount_short, -BASE_PRECISION_I128);
            assert_eq!(market.amm.quote_asset_amount_long, 120 * QUOTE_PRECISION);
            assert_eq!(market.amm.quote_asset_amount_short, 120 * QUOTE_PRECISION);
        }

        #[test]
        fn double_dutch_auction() {
            let mut taker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    order_type: OrderType::Market,
                    direction: PositionDirection::Long,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    slot: 0,
                    auction_start_price: 100 * MARK_PRICE_PRECISION,
                    auction_end_price: 200 * MARK_PRICE_PRECISION,
                    auction_duration: 10,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_bids: 1 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut maker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    post_only: true,
                    order_type: OrderType::Market,
                    direction: PositionDirection::Short,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    slot: 0,
                    auction_start_price: 200 * MARK_PRICE_PRECISION,
                    auction_end_price: 100 * MARK_PRICE_PRECISION,
                    auction_duration: 10,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_asks: -1 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut market = Market::default();

            let now = 5_i64;
            let slot = 5_u64;

            let fee_structure = get_fee_structure();

            let (taker_key, maker_key, filler_key) = get_user_keys();

            let mut order_records = vec![];

            fulfill_order_with_match(
                &mut market,
                &mut taker,
                0,
                &taker_key,
                &mut maker,
                0,
                &maker_key,
                None,
                &filler_key,
                now,
                slot,
                &fee_structure,
                &mut get_oracle_map(),
                &mut order_records,
            )
            .unwrap();

            let taker_position = &taker.positions[0];
            assert_eq!(taker_position.base_asset_amount, 1 * BASE_PRECISION_I128);
            assert_eq!(taker_position.quote_asset_amount, 150 * QUOTE_PRECISION);
            assert_eq!(taker_position.quote_entry_amount, 150 * QUOTE_PRECISION);
            assert_eq!(taker_position.unsettled_pnl, -75000);
            assert_eq!(taker_position.open_bids, 0);
            assert_eq!(taker_position.open_orders, 0);
            assert_eq!(taker.fees.total_fee_paid, 75000);
            assert_eq!(taker.fees.total_referee_discount, 0);
            assert_eq!(taker.fees.total_token_discount, 0);
            assert_eq!(taker.orders[0], Order::default());

            let maker_position = &maker.positions[0];
            assert_eq!(maker_position.base_asset_amount, -1 * BASE_PRECISION_I128);
            assert_eq!(maker_position.quote_asset_amount, 150 * QUOTE_PRECISION);
            assert_eq!(maker_position.quote_entry_amount, 150 * QUOTE_PRECISION);
            assert_eq!(maker_position.unsettled_pnl, 45000);
            assert_eq!(maker_position.open_orders, 0);
            assert_eq!(maker_position.open_asks, 0);
            assert_eq!(maker.fees.total_fee_rebate, 45000);
            assert_eq!(maker.orders[0], Order::default());

            assert_eq!(market.amm.net_base_asset_amount, 0);
            assert_eq!(market.base_asset_amount_long, BASE_PRECISION_I128);
            assert_eq!(market.base_asset_amount_short, -BASE_PRECISION_I128);
            assert_eq!(market.amm.quote_asset_amount_long, 150 * QUOTE_PRECISION);
            assert_eq!(market.amm.quote_asset_amount_short, 150 * QUOTE_PRECISION);
            assert_eq!(market.amm.total_fee, 30000);
            assert_eq!(market.amm.total_fee_minus_distributions, 30000);
            assert_eq!(market.amm.net_revenue_since_last_funding, 30000);
            assert_eq!(market.unsettled_profit, 45000);
            assert_eq!(market.unsettled_loss, 75000);
        }

        #[test]
        fn taker_bid_crosses_maker_ask() {
            let mut maker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    post_only: true,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Short,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    slot: 0,
                    price: 100 * MARK_PRICE_PRECISION,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_asks: -1 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut taker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Long,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    price: 150 * MARK_PRICE_PRECISION,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_bids: 1 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut market = Market::default();

            let now = 5_i64;
            let slot = 5_u64;

            let fee_structure = get_fee_structure();
            let (maker_key, taker_key, filler_key) = get_user_keys();

            let mut order_records = vec![];

            fulfill_order_with_match(
                &mut market,
                &mut taker,
                0,
                &taker_key,
                &mut maker,
                0,
                &maker_key,
                None,
                &filler_key,
                now,
                slot,
                &fee_structure,
                &mut get_oracle_map(),
                &mut order_records,
            )
            .unwrap();

            let maker_position = &maker.positions[0];
            assert_eq!(maker_position.base_asset_amount, -1 * BASE_PRECISION_I128);
            assert_eq!(maker_position.quote_asset_amount, 100 * QUOTE_PRECISION);
            assert_eq!(maker_position.quote_entry_amount, 100 * QUOTE_PRECISION);
            assert_eq!(maker_position.unsettled_pnl, 30000);
            assert_eq!(maker_position.open_orders, 0);
            assert_eq!(maker_position.open_asks, 0);
            assert_eq!(maker.fees.total_fee_rebate, 30000);
            assert_eq!(maker.orders[0], Order::default());

            let taker_position = &taker.positions[0];
            assert_eq!(taker_position.base_asset_amount, 1 * BASE_PRECISION_I128);
            assert_eq!(taker_position.quote_asset_amount, 100 * QUOTE_PRECISION);
            assert_eq!(taker_position.quote_entry_amount, 100 * QUOTE_PRECISION);
            assert_eq!(taker_position.unsettled_pnl, -50000);
            assert_eq!(taker_position.open_bids, 0);
            assert_eq!(taker_position.open_orders, 0);
            assert_eq!(taker.fees.total_fee_paid, 50000);
            assert_eq!(taker.fees.total_referee_discount, 0);
            assert_eq!(taker.fees.total_token_discount, 0);
            assert_eq!(taker.orders[0], Order::default());

            assert_eq!(market.amm.net_base_asset_amount, 0);
            assert_eq!(market.base_asset_amount_long, BASE_PRECISION_I128);
            assert_eq!(market.base_asset_amount_short, -BASE_PRECISION_I128);
            assert_eq!(market.amm.quote_asset_amount_long, 100 * QUOTE_PRECISION);
            assert_eq!(market.amm.quote_asset_amount_short, 100 * QUOTE_PRECISION);
            assert_eq!(market.amm.total_fee, 20000);
            assert_eq!(market.amm.total_fee_minus_distributions, 20000);
            assert_eq!(market.amm.net_revenue_since_last_funding, 20000);
            assert_eq!(market.unsettled_profit, 30000);
            assert_eq!(market.unsettled_loss, 50000);
        }

        #[test]
        fn taker_ask_crosses_maker_bid() {
            let mut maker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    post_only: true,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Long,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    slot: 0,
                    price: 100 * MARK_PRICE_PRECISION,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_bids: 1 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut taker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Short,
                    base_asset_amount: 1 * BASE_PRECISION,
                    ts: 0,
                    price: 50 * MARK_PRICE_PRECISION,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_asks: -1 * BASE_PRECISION_I128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            let mut market = Market::default();

            let now = 5_i64;
            let slot = 5_u64;

            let fee_structure = get_fee_structure();

            let (maker_key, taker_key, filler_key) = get_user_keys();

            let mut order_records = vec![];

            fulfill_order_with_match(
                &mut market,
                &mut taker,
                0,
                &taker_key,
                &mut maker,
                0,
                &maker_key,
                None,
                &filler_key,
                now,
                slot,
                &fee_structure,
                &mut get_oracle_map(),
                &mut order_records,
            )
            .unwrap();

            let maker_position = &maker.positions[0];
            assert_eq!(maker_position.base_asset_amount, 1 * BASE_PRECISION_I128);
            assert_eq!(maker_position.quote_asset_amount, 100 * QUOTE_PRECISION);
            assert_eq!(maker_position.quote_entry_amount, 100 * QUOTE_PRECISION);
            assert_eq!(maker_position.unsettled_pnl, 30000);
            assert_eq!(maker_position.open_orders, 0);
            assert_eq!(maker_position.open_bids, 0);
            assert_eq!(maker.fees.total_fee_rebate, 30000);
            assert_eq!(maker.orders[0], Order::default());

            let taker_position = &taker.positions[0];
            assert_eq!(taker_position.base_asset_amount, -1 * BASE_PRECISION_I128);
            assert_eq!(taker_position.quote_asset_amount, 100 * QUOTE_PRECISION);
            assert_eq!(taker_position.quote_entry_amount, 100 * QUOTE_PRECISION);
            assert_eq!(taker_position.unsettled_pnl, -50000);
            assert_eq!(taker_position.open_asks, 0);
            assert_eq!(taker_position.open_orders, 0);
            assert_eq!(taker.fees.total_fee_paid, 50000);
            assert_eq!(taker.fees.total_referee_discount, 0);
            assert_eq!(taker.fees.total_token_discount, 0);
            assert_eq!(taker.orders[0], Order::default());

            assert_eq!(market.amm.net_base_asset_amount, 0);
            assert_eq!(market.base_asset_amount_long, BASE_PRECISION_I128);
            assert_eq!(market.base_asset_amount_short, -BASE_PRECISION_I128);
            assert_eq!(market.amm.quote_asset_amount_long, 100 * QUOTE_PRECISION);
            assert_eq!(market.amm.quote_asset_amount_short, 100 * QUOTE_PRECISION);
            assert_eq!(market.amm.total_fee, 20000);
            assert_eq!(market.amm.total_fee_minus_distributions, 20000);
            assert_eq!(market.amm.net_revenue_since_last_funding, 20000);
            assert_eq!(market.unsettled_profit, 30000);
            assert_eq!(market.unsettled_loss, 50000);
        }
    }
}
