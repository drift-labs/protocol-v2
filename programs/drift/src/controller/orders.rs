//! Order lifecycle: placement validation, cancellation, and fill matching (perp + spot).
//! Margin math → `crate::math::margin`. Liquidation fills → `crate::controller::liquidation`.
//! `fill_perp_order` / `fulfill_perp_order_step` = keeper fill dispatch and maker matching.
//! `place_perp_order` / `place_spot_order` = user-facing placement with auction parameter derivation.
//! `cancel_order` / `cancel_orders_by_*` = cancellation paths (user-initiated and expiry).

use std::cell::RefMut;
use std::collections::BTreeMap;
use std::ops::DerefMut;

use crate::msg;
use crate::state::revenue_share::{
    RevenueShareEscrowZeroCopyMut, RevenueShareOrder, RevenueShareOrderBitFlag,
};
use anchor_lang::prelude::*;

use crate::amm::math::amm::calculate_amm_available_liquidity;
use crate::amm::AmmQuoter;
use crate::controller;
use crate::controller::funding::settle_funding_payment;
use crate::controller::position;
use crate::controller::position::{
    add_new_position, decrease_open_bids_and_asks, get_position_index, increase_open_bids_and_asks,
    update_position_and_market, update_quote_asset_amount, PositionDirection,
};
use crate::controller::spot_balance::update_spot_balances;
use crate::controller::spot_position::decrease_spot_open_bids_and_asks;
use crate::error::DriftResult;
use crate::error::ErrorCode;
use crate::get_struct_values;
use crate::get_then_update_id;
use crate::load_mut;
use crate::math::auction::{calculate_auction_params_for_trigger_order, calculate_auction_prices};
use crate::math::casting::Cast;
use crate::math::constants::{BASE_PRECISION_U64, MARGIN_PRECISION};
use crate::math::fees::{determine_user_fee_tier, FillFees};
use crate::math::fulfillment::determine_perp_fulfillment_methods;
use crate::math::liquidation::validate_user_not_being_liquidated;
use crate::math::matching::{
    are_orders_same_market_but_different_sides, calculate_filler_multiplier_for_matched_orders,
    is_maker_for_taker,
};
use crate::math::oracle::{
    self, is_oracle_valid_for_action, oracle_validity, DriftAction, OracleValidity,
};
use crate::math::safe_math::SafeMath;
use crate::math::safe_unwrap::SafeUnwrap;
use crate::math::{fees, margin::*, orders::*};
use crate::print_error;
use crate::state::events::{emit_stack, get_order_action_record, OrderActionRecord, OrderRecord};
use crate::state::events::{OrderAction, OrderActionExplanation};
use crate::state::fill_mode::FillMode;
use crate::state::fulfillment::PerpFulfillmentMethod;
use crate::state::margin_calculation::{MarginContext, MarginTypeConfig};
use crate::state::market_status::MarketStatus;
use crate::state::oracle::OraclePriceData;
use crate::state::oracle_map::OracleMap;
use crate::state::order_params::{
    ModifyOrderParams, OrderParams, PlaceOrderOptions, PostOnlyParam,
};
use crate::state::paused_operations::PerpOperation;
use crate::state::perp_market::PerpMarket;
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::quoter::{
    DlobOrderQuoter, FillFeePolicy, QuoteContext, Quoter, QuoterCommit, QuoterFill,
};
use crate::state::spot_market::{SpotBalanceType, SpotMarket};
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::state::FeeStructure;
use crate::state::state::*;
use crate::state::traits::Size;
use crate::state::user::{MarketType, User};
use crate::state::user::{
    Order, OrderBitFlag, OrderStatus, OrderTriggerCondition, OrderType, UserStats,
};
use crate::state::user_map::{UserMap, UserStatsMap};
use crate::validate;
use crate::validation;
use crate::validation::order::{validate_order, validate_order_for_force_reduce_only};

#[cfg(test)]
mod tests;

#[cfg(test)]
mod amm_jit_tests;

pub fn place_perp_order(
    state: &State,
    user: &mut User,
    user_key: Pubkey,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    clock: &Clock,
    mut params: OrderParams,
    mut options: PlaceOrderOptions,
    rev_share_order: &mut Option<&mut RevenueShareOrder>,
) -> DriftResult {
    let now = clock.unix_timestamp;
    let slot: u64 = clock.slot;

    if !options.is_liquidation() {
        validate_user_not_being_liquidated(
            user,
            perp_market_map,
            spot_market_map,
            oracle_map,
            state.liquidation_margin_buffer_ratio,
        )?;
    }

    validate!(!user.is_bankrupt(), ErrorCode::UserBankrupt)?;

    if options.try_expire_orders {
        expire_orders(
            user,
            &user_key,
            perp_market_map,
            spot_market_map,
            oracle_map,
            now,
            slot,
        )?;
    }

    if user.is_reduce_only() {
        validate!(
            params.reduce_only,
            ErrorCode::UserReduceOnly,
            "order must be reduce only"
        )?;
    }

    let new_order_index = user
        .orders
        .iter()
        .position(|order| order.is_available())
        .ok_or(ErrorCode::MaxNumberOfOrders)?;

    if params.user_order_id > 0 {
        let user_order_id_already_used = user
            .orders
            .iter()
            .position(|order| order.user_order_id == params.user_order_id && !order.is_available());

        if user_order_id_already_used.is_some() {
            msg!("user_order_id is already in use {}", params.user_order_id);
            return Err(ErrorCode::UserOrderIdAlreadyInUse);
        }
    }

    let market_index = params.market_index;
    let market = &perp_market_map.get_ref(&market_index)?;
    let force_reduce_only = market.is_reduce_only()?;

    validate!(
        !matches!(market.status, MarketStatus::Initialized),
        ErrorCode::MarketBeingInitialized,
        "Market is being initialized"
    )?;

    validate!(
        user.pool_id == 0,
        ErrorCode::InvalidPoolId,
        "user pool id ({}) != 0",
        user.pool_id
    )?;

    validate!(
        !market.is_in_settlement(now),
        ErrorCode::MarketPlaceOrderPaused,
        "Market is in settlement mode",
    )?;

    let position_index = get_position_index(&user.perp_positions, market_index)
        .or_else(|_| add_new_position(&mut user.perp_positions, market_index))?;

    // Increment open orders for existing position
    let (existing_position_direction, order_base_asset_amount) = {
        validate!(
            params.base_asset_amount >= market.order_step_size,
            ErrorCode::OrderAmountTooSmall,
            "params.base_asset_amount={} cannot be below market.order_step_size={}",
            params.base_asset_amount,
            market.order_step_size
        )?;

        let base_asset_amount = if params.base_asset_amount == u64::MAX
            && !(params.is_trigger_order() && params.reduce_only)
        {
            calculate_max_perp_order_size(
                user,
                position_index,
                params.market_index,
                params.direction,
                perp_market_map,
                spot_market_map,
                oracle_map,
            )?
        } else {
            standardize_base_asset_amount(params.base_asset_amount, market.order_step_size)?
        };

        let existing_position_direction = if let Some(existing_position_direction_override) =
            options.existing_position_direction_override
        {
            existing_position_direction_override
        } else {
            let market_position = &user.perp_positions[position_index];
            if market_position.base_asset_amount >= 0 {
                PositionDirection::Long
            } else {
                PositionDirection::Short
            }
        };

        (existing_position_direction, base_asset_amount)
    };

    let oracle_price_data = oracle_map.get_price_data(&market.oracle_id())?;

    // Downstream auction-param / price / validation logic reads the AMM's
    // cached spread state directly (refreshed by the keeper crank / fill
    // setup), matching pre-decoupling behaviour where order placement quoted
    // off the last-cranked spread rather than recomputing it here.

    // updates auction params for crossing limit orders w/out auction duration
    // dont modify if it's a liquidation
    if !options.is_liquidation() {
        params.update_perp_auction_params(
            market,
            oracle_price_data.price,
            options.is_signed_msg_order(),
        )?;
    }

    let (auction_start_price, auction_end_price, auction_duration) = get_auction_params(
        &params,
        oracle_price_data,
        market.order_tick_size,
        state.min_perp_auction_duration,
    )?;

    let max_ts = match params.max_ts {
        Some(max_ts) => max_ts,
        None => match params.order_type {
            OrderType::Market | OrderType::Oracle => now.safe_add(
                30_i64.max(
                    (auction_duration.safe_div(2)?)
                        .cast::<i64>()?
                        .safe_add(10_i64)?,
                ),
            )?,
            _ => 0_i64,
        },
    };

    if max_ts != 0 && max_ts < now {
        msg!("max_ts ({}) < now ({}), skipping order", max_ts, now);
        return Ok(());
    }

    validate!(
        params.market_type == MarketType::Perp,
        ErrorCode::InvalidOrderMarketType,
        "must be perp order"
    )?;

    // Start with 0 and set bit flags
    let mut bit_flags: u8 = 0;
    bit_flags = set_order_bit_flag(
        bit_flags,
        options.is_signed_msg_order(),
        OrderBitFlag::SignedMessage,
    );

    let reduce_only = params.reduce_only || force_reduce_only;
    bit_flags = set_order_bit_flag(
        bit_flags,
        params.is_trigger_order() && reduce_only,
        OrderBitFlag::NewTriggerReduceOnly,
    );

    if rev_share_order.is_some() {
        bit_flags = set_order_bit_flag(bit_flags, true, OrderBitFlag::HasBuilder);
    }

    if user.perp_positions[position_index].is_isolated() {
        bit_flags = set_order_bit_flag(bit_flags, true, OrderBitFlag::IsIsolatedPosition);
    }

    let new_order = Order {
        status: OrderStatus::Open,
        order_type: params.order_type,
        market_type: params.market_type,
        slot: options.get_order_slot(slot),
        order_id: get_then_update_id!(user, next_order_id),
        user_order_id: params.user_order_id,
        market_index: params.market_index,
        price: get_price_for_perp_order(
            params.price,
            params.direction,
            params.post_only,
            &market.amm,
            market.order_tick_size,
        )?,
        existing_position_direction,
        base_asset_amount: order_base_asset_amount,
        base_asset_amount_filled: 0,
        quote_asset_amount_filled: 0,
        direction: params.direction,
        reduce_only,
        trigger_price: standardize_price(
            params.trigger_price.unwrap_or(0),
            market.order_tick_size,
            params.direction,
        )?,
        trigger_condition: params.trigger_condition,
        post_only: params.post_only != PostOnlyParam::None,
        oracle_price_offset: params.oracle_price_offset.unwrap_or(0),
        immediate_or_cancel: params.is_immediate_or_cancel(),
        auction_start_price,
        auction_end_price,
        auction_duration,
        max_ts,
        posted_slot_tail: get_posted_slot_from_clock_slot(slot),
        bit_flags,
        padding: [0; 5],
    };

    let valid_oracle_price = Some(oracle_price_data.price);
    match validate_order(&new_order, market, valid_oracle_price, slot) {
        Ok(()) => {}
        Err(ErrorCode::PlacePostOnlyLimitFailure)
            if params.post_only == PostOnlyParam::TryPostOnly =>
        {
            // just want place to succeeds without error if TryPostOnly
            return Ok(());
        }
        Err(err) => return Err(err),
    };

    let risk_increasing = is_new_order_risk_increasing(
        &new_order,
        user.perp_positions[position_index].base_asset_amount,
        user.perp_positions[position_index].open_bids,
        user.perp_positions[position_index].open_asks,
    )?;

    user.increment_open_orders(new_order.has_auction());
    user.orders[new_order_index] = new_order;
    user.perp_positions[position_index].open_orders += 1;
    increase_open_bids_and_asks(
        &mut user.perp_positions[position_index],
        &params.direction,
        order_base_asset_amount,
        new_order.update_open_bids_and_asks(),
    )?;

    options.update_risk_increasing(risk_increasing);

    // when orders are placed in bulk, only need to check margin on last place
    if options.enforce_margin_check && !options.is_liquidation() {
        // if isolated position, use the isolated margin calculation
        let isolated_market_index = if user.perp_positions[position_index].is_isolated() {
            Some(market_index)
        } else {
            None
        };
        meets_place_order_margin_requirement(
            user,
            perp_market_map,
            spot_market_map,
            oracle_map,
            options.risk_increasing,
            isolated_market_index,
        )?;
    }

    if force_reduce_only {
        validate_order_for_force_reduce_only(
            &user.orders[new_order_index],
            user.perp_positions[position_index].base_asset_amount,
        )?;
    }

    let max_oi = market.max_open_interest;
    if max_oi != 0 && risk_increasing {
        let oi_plus_order = match params.direction {
            PositionDirection::Long => market
                .base_asset_amount_long
                .safe_add(order_base_asset_amount.cast()?)?
                .unsigned_abs(),
            PositionDirection::Short => market
                .base_asset_amount_short
                .safe_sub(order_base_asset_amount.cast()?)?
                .unsigned_abs(),
        };

        validate!(
            oi_plus_order <= max_oi,
            ErrorCode::MaxOpenInterest,
            "Order Base Amount={} could breach Max Open Interest for Perp Market={}",
            order_base_asset_amount,
            params.market_index
        )?;
    }

    let (taker, taker_order, maker, maker_order) =
        get_taker_and_maker_for_order_record(&user_key, &new_order);

    let order_action_record = get_order_action_record(
        now,
        OrderAction::Place,
        options.explanation,
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
        taker,
        taker_order,
        maker,
        maker_order,
        oracle_map.get_price_data(&market.oracle_id())?.price,
        bit_flags,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )?;
    emit_stack::<_, { OrderActionRecord::SIZE }>(order_action_record)?;

    let order_record = OrderRecord {
        ts: now,
        user: user_key,
        order: user.orders[new_order_index],
    };
    emit_stack::<_, { OrderRecord::SIZE }>(order_record)?;

    user.update_last_active_slot(slot);

    Ok(())
}

fn get_auction_params(
    params: &OrderParams,
    oracle_price_data: &OraclePriceData,
    tick_size: u64,
    min_auction_duration: u8,
) -> DriftResult<(i64, i64, u8)> {
    if !matches!(
        params.order_type,
        OrderType::Market | OrderType::Oracle | OrderType::Limit
    ) {
        return Ok((0_i64, 0_i64, 0_u8));
    }

    if params.order_type == OrderType::Limit {
        return match (
            params.auction_start_price,
            params.auction_end_price,
            params.auction_duration,
        ) {
            (Some(auction_start_price), Some(auction_end_price), Some(auction_duration)) => {
                let auction_duration = if auction_duration == 0 {
                    auction_duration
                } else {
                    // if auction is non-zero, force it to be at least min_auction_duration
                    auction_duration.max(min_auction_duration)
                };

                Ok((
                    standardize_price_i64(
                        auction_start_price,
                        tick_size.cast()?,
                        params.direction,
                    )?,
                    standardize_price_i64(auction_end_price, tick_size.cast()?, params.direction)?,
                    auction_duration,
                ))
            }
            _ => Ok((0_i64, 0_i64, 0_u8)),
        };
    }

    let auction_duration = params
        .auction_duration
        .unwrap_or(0)
        .max(min_auction_duration);

    let (auction_start_price, auction_end_price) =
        match (params.auction_start_price, params.auction_end_price) {
            (Some(auction_start_price), Some(auction_end_price)) => {
                (auction_start_price, auction_end_price)
            }
            _ if params.order_type == OrderType::Oracle => {
                msg!("Oracle order must specify auction start and end price offsets");
                return Err(ErrorCode::InvalidOrderAuction);
            }
            _ => calculate_auction_prices(oracle_price_data, params.direction, params.price)?,
        };

    Ok((
        standardize_price_i64(auction_start_price, tick_size.cast()?, params.direction)?,
        standardize_price_i64(auction_end_price, tick_size.cast()?, params.direction)?,
        auction_duration,
    ))
}

pub fn cancel_orders(
    user: &mut User,
    user_key: &Pubkey,
    filler_key: Option<&Pubkey>,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    now: i64,
    slot: u64,
    explanation: OrderActionExplanation,
    market_type: Option<MarketType>,
    market_index: Option<u16>,
    direction: Option<PositionDirection>,
    skip_isolated_positions: bool,
) -> DriftResult<Vec<u32>> {
    let mut canceled_order_ids: Vec<u32> = vec![];
    let isolated_position_market_indexes = user
        .perp_positions
        .iter()
        .filter(|position| position.is_isolated())
        .map(|position| position.market_index)
        .collect::<Vec<u16>>();
    for order_index in 0..user.orders.len() {
        if user.orders[order_index].status != OrderStatus::Open {
            continue;
        }

        if let (Some(market_type), Some(market_index)) = (market_type, market_index) {
            if user.orders[order_index].market_type != market_type {
                continue;
            }

            if user.orders[order_index].market_index != market_index {
                continue;
            }
        } else if skip_isolated_positions
            && isolated_position_market_indexes.contains(&user.orders[order_index].market_index)
        {
            continue;
        }

        if let Some(direction) = direction {
            if user.orders[order_index].direction != direction {
                continue;
            }
        }

        canceled_order_ids.push(user.orders[order_index].order_id);
        cancel_order(
            order_index,
            user,
            user_key,
            perp_market_map,
            spot_market_map,
            oracle_map,
            now,
            slot,
            explanation,
            filler_key,
            0,
            false,
        )?;
    }

    user.update_last_active_slot(slot);

    Ok(canceled_order_ids)
}

pub fn cancel_order_by_order_id(
    order_id: u32,
    user: &AccountLoader<User>,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    clock: &Clock,
) -> DriftResult {
    let user_key = user.key();
    let user = &mut load_mut!(user)?;
    let order_index = match user.get_order_index(order_id) {
        Ok(order_index) => order_index,
        Err(_) => {
            msg!("could not find order id {}", order_id);
            return Ok(());
        }
    };

    cancel_order(
        order_index,
        user,
        &user_key,
        perp_market_map,
        spot_market_map,
        oracle_map,
        clock.unix_timestamp,
        clock.slot,
        OrderActionExplanation::None,
        None,
        0,
        false,
    )?;

    user.update_last_active_slot(clock.slot);

    Ok(())
}

pub fn cancel_order_by_user_order_id(
    user_order_id: u8,
    user: &AccountLoader<User>,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    clock: &Clock,
) -> DriftResult {
    let user_key = user.key();
    let user = &mut load_mut!(user)?;
    let order_index = match user
        .orders
        .iter()
        .position(|order| order.user_order_id == user_order_id)
    {
        Some(order_index) => order_index,
        None => {
            msg!("could not find user order id {}", user_order_id);
            return Ok(());
        }
    };

    cancel_order(
        order_index,
        user,
        &user_key,
        perp_market_map,
        spot_market_map,
        oracle_map,
        clock.unix_timestamp,
        clock.slot,
        OrderActionExplanation::None,
        None,
        0,
        false,
    )?;

    user.update_last_active_slot(clock.slot);

    Ok(())
}

pub fn cancel_order(
    order_index: usize,
    user: &mut User,
    user_key: &Pubkey,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    now: i64,
    _slot: u64,
    explanation: OrderActionExplanation,
    filler_key: Option<&Pubkey>,
    filler_reward: u64,
    skip_log: bool,
) -> DriftResult {
    let (order_status, order_market_index, order_direction, order_market_type) = get_struct_values!(
        user.orders[order_index],
        status,
        market_index,
        direction,
        market_type
    );

    let is_perp_order = order_market_type == MarketType::Perp;

    validate!(order_status == OrderStatus::Open, ErrorCode::OrderNotOpen)?;

    let oracle_id = if is_perp_order {
        perp_market_map.get_ref(&order_market_index)?.oracle_id()
    } else {
        spot_market_map.get_ref(&order_market_index)?.oracle_id()
    };

    if !skip_log {
        let (taker, taker_order, maker, maker_order) =
            get_taker_and_maker_for_order_record(user_key, &user.orders[order_index]);

        let mut bit_flags = 0;
        if is_perp_order {
            let position_index = get_position_index(&user.perp_positions, order_market_index)?;
            if user.perp_positions[position_index].is_isolated() {
                bit_flags = set_order_bit_flag(bit_flags, true, OrderBitFlag::IsIsolatedPosition);
            }
        }

        let order_action_record = get_order_action_record(
            now,
            OrderAction::Cancel,
            explanation,
            order_market_index,
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
            taker,
            taker_order,
            maker,
            maker_order,
            oracle_map.get_price_data(&oracle_id)?.price,
            bit_flags,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )?;
        emit_stack::<_, { OrderActionRecord::SIZE }>(order_action_record)?;
    }

    user.decrement_open_orders(user.orders[order_index].has_auction());
    if is_perp_order {
        // Decrement open orders for existing position
        let position_index = get_position_index(&user.perp_positions, order_market_index)?;

        // only decrease open/bids ask if it's not a trigger order or if it's been triggered
        let update_open_bids_and_asks = user.orders[order_index].update_open_bids_and_asks();
        if update_open_bids_and_asks {
            let base_asset_amount_unfilled =
                user.orders[order_index].get_base_asset_amount_unfilled(None)?;
            position::decrease_open_bids_and_asks(
                &mut user.perp_positions[position_index],
                &order_direction,
                base_asset_amount_unfilled.cast()?,
                update_open_bids_and_asks,
            )?;
        }

        user.perp_positions[position_index].open_orders -= 1;
        user.orders[order_index].status = OrderStatus::Canceled;
    } else {
        let spot_position_index = user.get_spot_position_index(order_market_index)?;

        // only decrease open/bids ask if it's not a trigger order or if it's been triggered
        let update_open_bids_and_asks = user.orders[order_index].update_open_bids_and_asks();
        if update_open_bids_and_asks {
            let base_asset_amount_unfilled =
                user.orders[order_index].get_base_asset_amount_unfilled(None)?;
            decrease_spot_open_bids_and_asks(
                &mut user.spot_positions[spot_position_index],
                &order_direction,
                base_asset_amount_unfilled,
                update_open_bids_and_asks,
            )?;
        }
        user.spot_positions[spot_position_index].open_orders -= 1;
        user.orders[order_index].status = OrderStatus::Canceled;
    }

    Ok(())
}

pub enum ModifyOrderId {
    UserOrderId(u8),
    OrderId(u32),
}

pub fn validate_spot_dlob_trading_enabled_for_market_type(market_type: MarketType) -> DriftResult {
    if market_type == MarketType::Spot {
        return Err(ErrorCode::SpotDlobTradingDisabled);
    }

    Ok(())
}

pub fn modify_order(
    order_id: ModifyOrderId,
    modify_order_params: ModifyOrderParams,
    user_loader: &AccountLoader<User>,
    state: &State,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    clock: &Clock,
) -> DriftResult {
    let user_key = user_loader.key();
    let mut user = load_mut!(user_loader)?;

    let order_index = match order_id {
        ModifyOrderId::UserOrderId(user_order_id) => {
            match user.get_order_index_by_user_order_id(user_order_id) {
                Ok(order_index) => order_index,
                Err(e) => {
                    msg!("User order id {} not found", user_order_id);
                    if modify_order_params.must_modify() {
                        return Err(e);
                    } else {
                        return Ok(());
                    }
                }
            }
        }
        ModifyOrderId::OrderId(order_id) => match user.get_order_index(order_id) {
            Ok(order_index) => order_index,
            Err(e) => {
                msg!("Order id {} not found", order_id);
                if modify_order_params.must_modify() {
                    return Err(e);
                } else {
                    return Ok(());
                }
            }
        },
    };

    let existing_order = user.orders[order_index];

    cancel_order(
        order_index,
        &mut user,
        &user_key,
        perp_market_map,
        spot_market_map,
        oracle_map,
        clock.unix_timestamp,
        clock.slot,
        OrderActionExplanation::None,
        None,
        0,
        false,
    )?;

    user.update_last_active_slot(clock.slot);

    let order_params =
        merge_modify_order_params_with_existing_order(&existing_order, &modify_order_params)?;

    if let Some(order_params) = order_params {
        validate_spot_dlob_trading_enabled_for_market_type(order_params.market_type)?;

        place_perp_order(
            state,
            &mut user,
            user_key,
            perp_market_map,
            spot_market_map,
            oracle_map,
            clock,
            order_params,
            PlaceOrderOptions::default(),
            &mut None,
        )?;
    }

    Ok(())
}

fn merge_modify_order_params_with_existing_order(
    existing_order: &Order,
    modify_order_params: &ModifyOrderParams,
) -> DriftResult<Option<OrderParams>> {
    let order_type = existing_order.order_type;
    let market_type = existing_order.market_type;
    let direction = modify_order_params
        .direction
        .unwrap_or(existing_order.direction);
    let user_order_id = existing_order.user_order_id;
    let base_asset_amount = match modify_order_params.base_asset_amount {
        Some(base_asset_amount) if modify_order_params.exclude_previous_fill() => {
            let base_asset_amount =
                base_asset_amount.saturating_sub(existing_order.base_asset_amount_filled);

            if base_asset_amount == 0 {
                return Ok(None);
            }

            base_asset_amount
        }
        Some(base_asset_amount) => base_asset_amount,
        None => existing_order.get_base_asset_amount_unfilled(None)?,
    };
    let price = modify_order_params.price.unwrap_or(existing_order.price);
    let market_index = existing_order.market_index;
    let reduce_only = modify_order_params
        .reduce_only
        .unwrap_or(existing_order.reduce_only);
    let post_only = modify_order_params
        .post_only
        .unwrap_or(if existing_order.post_only {
            PostOnlyParam::MustPostOnly
        } else {
            PostOnlyParam::None
        });
    let bit_flags = 0;
    let max_ts = modify_order_params.max_ts.or(Some(existing_order.max_ts));
    let trigger_price = modify_order_params
        .trigger_price
        .or(Some(existing_order.trigger_price));
    let trigger_condition =
        modify_order_params
            .trigger_condition
            .unwrap_or(match existing_order.trigger_condition {
                OrderTriggerCondition::TriggeredAbove | OrderTriggerCondition::Above => {
                    OrderTriggerCondition::Above
                }
                OrderTriggerCondition::TriggeredBelow | OrderTriggerCondition::Below => {
                    OrderTriggerCondition::Below
                }
            });
    let oracle_price_offset = modify_order_params
        .oracle_price_offset
        .or(Some(existing_order.oracle_price_offset));
    let (auction_duration, auction_start_price, auction_end_price) =
        if modify_order_params.auction_duration.is_some()
            && modify_order_params.auction_start_price.is_some()
            && modify_order_params.auction_end_price.is_some()
        {
            (
                modify_order_params.auction_duration,
                modify_order_params.auction_start_price,
                modify_order_params.auction_end_price,
            )
        } else {
            (None, None, None)
        };

    Ok(Some(OrderParams {
        order_type,
        market_type,
        direction,
        user_order_id,
        base_asset_amount,
        price,
        market_index,
        reduce_only,
        post_only,
        bit_flags,
        max_ts,
        trigger_price,
        trigger_condition,
        oracle_price_offset,
        auction_duration,
        auction_start_price,
        auction_end_price,
    }))
}

pub fn fill_perp_order(
    order_id: u32,
    state: &State,
    user: &AccountLoader<User>,
    user_stats: &AccountLoader<UserStats>,
    spot_market_map: &SpotMarketMap,
    perp_market_map: &PerpMarketMap,
    oracle_map: &mut OracleMap,
    filler: &AccountLoader<User>,
    filler_stats: &AccountLoader<UserStats>,
    makers_and_referrer: &UserMap,
    makers_and_referrer_stats: &UserStatsMap,
    jit_maker_order_id: Option<u32>,
    clock: &Clock,
    fill_mode: FillMode,
    rev_share_escrow: &mut Option<&mut RevenueShareEscrowZeroCopyMut>,
    builder_referral_feature_enabled: bool,
) -> DriftResult<(u64, u64)> {
    let now = clock.unix_timestamp;
    let slot = clock.slot;

    let filler_key = filler.key();
    let user_key = user.key();
    let user = &mut load_mut!(user)?;
    let user_stats = &mut load_mut!(user_stats)?;

    let order_index = user
        .orders
        .iter()
        .position(|order| order.order_id == order_id && order.status == OrderStatus::Open)
        .ok_or_else(print_error!(ErrorCode::OrderDoesNotExist))?;

    let (order_status, market_index, order_market_type, order_reduce_only) = get_struct_values!(
        user.orders[order_index],
        status,
        market_index,
        market_type,
        reduce_only
    );

    validate!(
        order_market_type == MarketType::Perp,
        ErrorCode::InvalidOrderMarketType,
        "must be perp order"
    )?;

    // settle lp position so its tradeable
    let mut market = perp_market_map.get_ref_mut(&market_index)?;
    settle_funding_payment(user, &user_key, &mut market, now)?;

    validate!(
        matches!(
            market.status,
            MarketStatus::Active | MarketStatus::ReduceOnly
        ),
        ErrorCode::MarketFillOrderPaused,
        "Market not active",
    )?;

    validate!(
        !market.is_operation_paused(PerpOperation::Fill),
        ErrorCode::MarketFillOrderPaused,
        "Market fills paused",
    )?;

    drop(market);

    validate!(
        order_status == OrderStatus::Open,
        ErrorCode::OrderNotOpen,
        "Order not open"
    )?;

    validate!(
        !user.orders[order_index].must_be_triggered() || user.orders[order_index].triggered(),
        ErrorCode::OrderMustBeTriggeredFirst,
        "Order must be triggered first"
    )?;

    if user.is_bankrupt() {
        msg!("user is bankrupt");
        return Ok((0, 0));
    }

    if !fill_mode.is_liquidation() {
        match validate_user_not_being_liquidated(
            user,
            perp_market_map,
            spot_market_map,
            oracle_map,
            state.liquidation_margin_buffer_ratio,
        ) {
            Ok(_) => {}
            Err(_) => {
                msg!("user is being liquidated");
                return Ok((0, 0));
            }
        }
    }

    let reserve_price_before: u64;
    let safe_oracle_validity: OracleValidity;
    let oracle_price: i64;
    let oracle_twap_5min: i64;
    let user_can_skip_duration: bool;
    let oracle_stale_for_margin: bool;
    let mut amm_is_available: bool = !state.amm_paused()?;
    {
        let market = &mut perp_market_map.get_ref_mut(&market_index)?;
        validation::perp_market::validate_perp_market(market)?;
        validate!(
            !market.is_in_settlement(now),
            ErrorCode::MarketFillOrderPaused,
            "Market is in settlement mode",
        )?;

        let oracle_price_data = oracle_map.get_price_data(&market.oracle_id())?;
        let mm_oracle_price_data = market.get_mm_oracle_price_data(
            *oracle_price_data,
            slot,
            &state.oracle_guard_rails.validity,
        )?;
        let safe_oracle_price_data = mm_oracle_price_data.get_safe_oracle_price_data();
        safe_oracle_validity = oracle_validity(
            MarketType::Perp,
            market.market_index,
            market
                .market_stats
                .historical_oracle_data
                .last_oracle_price_twap,
            &safe_oracle_price_data,
            &state.oracle_guard_rails.validity,
            market.get_max_confidence_interval_multiplier()?,
            &market.oracle_source,
            oracle::LogMode::SafeMMOracle,
            market.oracle_slot_delay_override,
            market.oracle_low_risk_slot_delay_override,
        )?;

        user_can_skip_duration = user.can_skip_auction_duration(user_stats, order_reduce_only)?;
        amm_is_available &= market.amm_can_fill_order(
            &user.orders[order_index],
            slot,
            fill_mode,
            state,
            safe_oracle_validity,
            user_can_skip_duration,
            &mm_oracle_price_data,
        )?;

        oracle_stale_for_margin = mm_oracle_price_data.get_delay()
            > state
                .oracle_guard_rails
                .validity
                .slots_before_stale_for_margin;

        // No AMM mutation here — `fulfill_perp_order_step` constructs an
        // `AmmQuoter` and calls `Quoter::setup` before quoting, which is
        // the sole non-admin AMM-refresh entrypoint. PerpMarket-level
        // oracle bookkeeping (TWAPs, reference-price-offset,
        // last_oracle_valid) is PerpMarket's own concern and stays here
        // (no AMM reacharound — PerpMarket reading its own AMM field).
        let amm_refresh_validity =
            crate::amm::refresh::compute_amm_refresh_validity_with_guard_rails(
                market,
                &mm_oracle_price_data,
                &state.oracle_guard_rails.validity,
            )?;
        market.update_oracle_derived_stats(
            &mm_oracle_price_data,
            amm_refresh_validity,
            now,
            slot,
        )?;

        reserve_price_before = market.amm.reserve_price()?;
        oracle_price = mm_oracle_price_data.get_price();
        oracle_twap_5min = market
            .market_stats
            .historical_oracle_data
            .last_oracle_price_twap_5min;
    }

    // allow oracle price to be used to calculate limit price if it's valid or stale for amm
    let valid_oracle_price =
        if is_oracle_valid_for_action(safe_oracle_validity, Some(DriftAction::OracleOrderPrice))? {
            Some(oracle_price)
        } else {
            msg!("Perp market = {} oracle deemed invalid", market_index);
            None
        };

    let is_filler_taker = user_key == filler_key;
    let is_filler_maker = makers_and_referrer.0.contains_key(&filler_key);
    let (mut filler, mut filler_stats) = if !is_filler_maker && !is_filler_taker {
        let filler = load_mut!(filler)?;

        validate!(
            filler.pool_id == 0,
            ErrorCode::InvalidPoolId,
            "filler pool id ({}) != 0",
            filler.pool_id
        )?;

        if filler.authority != user.authority {
            (Some(filler), Some(load_mut!(filler_stats)?))
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };

    let maker_orders_info = get_maker_orders_info(
        perp_market_map,
        spot_market_map,
        oracle_map,
        makers_and_referrer,
        &user_key,
        &user.orders[order_index],
        &mut filler.as_deref_mut(),
        &filler_key,
        state.perp_fee_structure.flat_filler_fee,
        oracle_price,
        jit_maker_order_id,
        now,
        slot,
    )?;

    // no referrer bonus for liquidations
    let referrer_info = if !fill_mode.is_liquidation() {
        get_referrer_info(
            user_stats,
            &user_key,
            makers_and_referrer,
            makers_and_referrer_stats,
            slot,
        )?
    } else {
        None
    };

    let oracle_too_divergent_with_twap_5min = is_oracle_too_divergent_with_twap_5min(
        oracle_price,
        oracle_twap_5min,
        state
            .oracle_guard_rails
            .max_oracle_twap_5min_percent_divergence()
            .cast()?,
    )?;

    if oracle_too_divergent_with_twap_5min {
        // update filler last active so tx doesn't revert
        if let Some(filler) = filler.as_deref_mut() {
            filler.update_last_active_slot(slot);
        }
        return Ok((0, 0));
    }

    let should_expire_order = should_expire_order(user, order_index, now)?;

    let position_index =
        get_position_index(&user.perp_positions, user.orders[order_index].market_index)?;
    let existing_base_asset_amount = user.perp_positions[position_index].base_asset_amount;
    let should_cancel_reduce_only = should_cancel_reduce_only_order(
        &user.orders[order_index],
        existing_base_asset_amount,
        perp_market_map.get_ref_mut(&market_index)?.order_step_size,
    )?;

    if should_expire_order || should_cancel_reduce_only {
        let filler_reward = {
            let mut market = perp_market_map.get_ref_mut(&market_index)?;
            pay_keeper_flat_reward_for_perps(
                user,
                filler.as_deref_mut(),
                market.deref_mut(),
                state.perp_fee_structure.flat_filler_fee,
                slot,
            )?
        };

        let explanation = if should_expire_order {
            OrderActionExplanation::OrderExpired
        } else {
            OrderActionExplanation::ReduceOnlyOrderIncreasedPosition
        };

        cancel_order(
            order_index,
            user,
            &user_key,
            perp_market_map,
            spot_market_map,
            oracle_map,
            now,
            slot,
            explanation,
            Some(&filler_key),
            filler_reward,
            false,
        )?;

        return Ok((0, 0));
    }

    let (base_asset_amount, quote_asset_amount) = fulfill_perp_order(
        user,
        order_index,
        &user_key,
        user_stats,
        makers_and_referrer,
        makers_and_referrer_stats,
        &maker_orders_info,
        &mut filler.as_deref_mut(),
        &filler_key,
        &mut filler_stats.as_deref_mut(),
        referrer_info,
        spot_market_map,
        perp_market_map,
        oracle_map,
        &state.oracle_guard_rails.validity,
        &state.perp_fee_structure,
        reserve_price_before,
        valid_oracle_price,
        now,
        slot,
        amm_is_available,
        fill_mode,
        oracle_stale_for_margin,
        rev_share_escrow,
        builder_referral_feature_enabled,
    )?;

    if base_asset_amount != 0 {
        let fill_price =
            calculate_fill_price(quote_asset_amount, base_asset_amount, BASE_PRECISION_U64)?;

        let mut perp_market = perp_market_map.get_ref_mut(&market_index)?;
        validate_fill_price_within_price_bands(
            fill_price,
            oracle_price,
            oracle_twap_5min,
            perp_market.margin_ratio_initial,
            state
                .oracle_guard_rails
                .max_oracle_twap_5min_percent_divergence(),
            None,
        )?;

        perp_market.last_fill_price = fill_price;
    }

    let base_asset_amount_after = user.perp_positions[position_index].base_asset_amount;
    let should_cancel_reduce_only = should_cancel_reduce_only_order(
        &user.orders[order_index],
        base_asset_amount_after,
        perp_market_map.get_ref_mut(&market_index)?.order_step_size,
    )?;

    if should_cancel_reduce_only {
        let filler_reward = {
            let mut market = perp_market_map.get_ref_mut(&market_index)?;
            pay_keeper_flat_reward_for_perps(
                user,
                filler.as_deref_mut(),
                market.deref_mut(),
                state.perp_fee_structure.flat_filler_fee,
                slot,
            )?
        };

        let explanation = OrderActionExplanation::ReduceOnlyOrderIncreasedPosition;

        cancel_order(
            order_index,
            user,
            &user_key,
            perp_market_map,
            spot_market_map,
            oracle_map,
            now,
            slot,
            explanation,
            Some(&filler_key),
            filler_reward,
            false,
        )?
    }

    if base_asset_amount_after == 0
        && user.perp_positions[position_index].open_asks == 0
        && user.perp_positions[position_index].open_bids == 0
    {
        cancel_reduce_only_trigger_orders(
            user,
            &user_key,
            Some(&filler_key),
            perp_market_map,
            spot_market_map,
            oracle_map,
            now,
            slot,
            market_index,
        )?;
    }

    if base_asset_amount == 0 {
        return Ok((base_asset_amount, quote_asset_amount));
    }

    {
        let market = perp_market_map.get_ref(&market_index)?;

        let open_interest = market.get_open_interest();
        let max_open_interest = market.max_open_interest;

        validate!(
            max_open_interest == 0 || max_open_interest > open_interest,
            ErrorCode::MaxOpenInterest,
            "open interest ({}) > max open interest ({})",
            open_interest,
            max_open_interest
        )?;
    }

    // Try to update the funding rate at the end of every trade
    {
        let market = &mut perp_market_map.get_ref_mut(&market_index)?;
        let funding_paused =
            state.funding_paused()? || market.is_operation_paused(PerpOperation::UpdateFunding);

        controller::funding::update_funding_rate(
            market_index,
            market,
            oracle_map,
            now,
            slot,
            &state.oracle_guard_rails,
            funding_paused,
            Some(reserve_price_before),
        )?;
    }

    user.update_last_active_slot(slot);

    Ok((base_asset_amount, quote_asset_amount))
}

pub fn validate_market_within_price_band(
    market: &PerpMarket,
    state: &State,
    oracle_price: i64,
) -> DriftResult<bool> {
    let reserve_price = market.amm.reserve_price()?;

    let reserve_spread_pct = market
        .market_stats
        .historical_oracle_data
        .twap_5min_spread_pct(reserve_price)?;

    let oracle_spread_pct = market
        .market_stats
        .historical_oracle_data
        .twap_5min_spread_pct(oracle_price.unsigned_abs())?;

    if reserve_spread_pct.abs() > oracle_spread_pct.abs() {
        let is_reserve_too_divergent = crate::math::oracle::is_mark_oracle_too_divergent(
            reserve_spread_pct,
            &state.oracle_guard_rails.price_divergence,
        )?;

        // if oracle-mark divergence pushed outside limit, block order
        if is_reserve_too_divergent {
            msg!("Perp market = {} price pushed outside bounds: last_oracle_price_twap_5min={} vs reserve_price={},(breach spread {})",
                market.market_index,
                market
                    .market_stats
                    .historical_oracle_data
                    .last_oracle_price_twap_5min,
                reserve_price,
                reserve_spread_pct,
            );
            return Err(ErrorCode::PriceBandsBreached);
        }
    } else {
        let is_oracle_too_divergent = crate::math::oracle::is_mark_oracle_too_divergent(
            oracle_spread_pct,
            &state.oracle_guard_rails.price_divergence,
        )?;

        // if oracle-mark divergence pushed outside limit, block order
        if is_oracle_too_divergent {
            msg!("Perp market = {} price pushed outside bounds: last_oracle_price_twap_5min={} vs oracle_price={},(breach spread {})",
                market.market_index,
                market
                    .market_stats
                    .historical_oracle_data
                    .last_oracle_price_twap_5min,
                oracle_price,
                oracle_spread_pct,
            );
            return Err(ErrorCode::PriceBandsBreached);
        }
    }

    Ok(true)
}

#[allow(clippy::type_complexity)]
fn get_maker_orders_info(
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    makers_and_referrer: &UserMap,
    taker_key: &Pubkey,
    taker_order: &Order,
    filler: &mut Option<&mut User>,
    filler_key: &Pubkey,
    filler_reward: u64,
    oracle_price: i64,
    jit_maker_order_id: Option<u32>,
    now: i64,
    slot: u64,
) -> DriftResult<Vec<(Pubkey, usize, u64)>> {
    let maker_direction = taker_order.direction.opposite();

    let mut maker_orders_info = Vec::with_capacity(16);

    for (maker_key, user_account_loader) in makers_and_referrer.0.iter() {
        if maker_key == taker_key {
            continue;
        }

        let mut maker = load_mut!(user_account_loader)?;

        if maker.is_being_liquidated() {
            continue;
        }

        let mut market = perp_market_map.get_ref_mut(&taker_order.market_index)?;
        let maker_order_price_and_indexes = find_maker_orders(
            &maker,
            &maker_direction,
            &MarketType::Perp,
            taker_order.market_index,
            Some(oracle_price),
            slot,
            market.order_tick_size,
        )?;

        if maker_order_price_and_indexes.is_empty() {
            continue;
        }

        maker.update_last_active_slot(slot);

        settle_funding_payment(&mut maker, maker_key, &mut market, now)?;

        let initial_margin_ratio = market.margin_ratio_initial;
        let step_size = market.order_step_size;

        drop(market);

        for (maker_order_index, maker_order_price) in maker_order_price_and_indexes.iter() {
            let maker_order_index = *maker_order_index;
            let maker_order_price = *maker_order_price;

            let maker_order = &maker.orders[maker_order_index];
            if !is_maker_for_taker(maker_order, taker_order, slot)? {
                continue;
            }

            if !are_orders_same_market_but_different_sides(maker_order, taker_order) {
                continue;
            }

            if let Some(jit_maker_order_id) = jit_maker_order_id {
                // if jit maker order id exists, must only use that order
                if maker_order.order_id != jit_maker_order_id {
                    continue;
                }
            }

            let breaches_oracle_price_limits = {
                limit_price_breaches_maker_oracle_price_bands(
                    maker_order_price,
                    maker_order.direction,
                    oracle_price,
                    initial_margin_ratio,
                )?
            };

            let should_expire_order = should_expire_order(&maker, maker_order_index, now)?;

            let existing_base_asset_amount = maker
                .get_perp_position(maker.orders[maker_order_index].market_index)?
                .base_asset_amount;
            let should_cancel_reduce_only_order = should_cancel_reduce_only_order(
                &maker.orders[maker_order_index],
                existing_base_asset_amount,
                step_size,
            )?;

            if breaches_oracle_price_limits
                || should_expire_order
                || should_cancel_reduce_only_order
            {
                let filler_reward = {
                    let mut market = perp_market_map
                        .get_ref_mut(&maker.orders[maker_order_index].market_index)?;
                    pay_keeper_flat_reward_for_perps(
                        &mut maker,
                        filler.as_deref_mut(),
                        market.deref_mut(),
                        filler_reward,
                        slot,
                    )?
                };

                let explanation = if breaches_oracle_price_limits {
                    OrderActionExplanation::OraclePriceBreachedLimitPrice
                } else if should_expire_order {
                    OrderActionExplanation::OrderExpired
                } else {
                    OrderActionExplanation::ReduceOnlyOrderIncreasedPosition
                };

                cancel_order(
                    maker_order_index,
                    maker.deref_mut(),
                    maker_key,
                    perp_market_map,
                    spot_market_map,
                    oracle_map,
                    now,
                    slot,
                    explanation,
                    Some(filler_key),
                    filler_reward,
                    false,
                )?;

                continue;
            }

            insert_maker_order_info(
                &mut maker_orders_info,
                (*maker_key, maker_order_index, maker_order_price),
                maker_direction,
            );
        }
    }

    Ok(maker_orders_info)
}

#[inline(always)]
fn insert_maker_order_info(
    maker_orders_info: &mut Vec<(Pubkey, usize, u64)>,
    maker_order_info: (Pubkey, usize, u64),
    direction: PositionDirection,
) {
    let price = maker_order_info.2;
    let index = match maker_orders_info.binary_search_by(|item| match direction {
        PositionDirection::Short => item.2.cmp(&price),
        PositionDirection::Long => price.cmp(&item.2),
    }) {
        Ok(index) => index,
        Err(index) => index,
    };

    if index < maker_orders_info.capacity() {
        maker_orders_info.insert(index, maker_order_info);
    }
}

fn get_referrer_info(
    user_stats: &UserStats,
    user_key: &Pubkey,
    makers_and_referrer: &UserMap,
    makers_and_referrer_stats: &UserStatsMap,
    slot: u64,
) -> DriftResult<Option<(Pubkey, Pubkey)>> {
    if user_stats.referrer.eq(&Pubkey::default()) {
        return Ok(None);
    }

    validate!(
        makers_and_referrer_stats
            .0
            .contains_key(&user_stats.referrer),
        ErrorCode::ReferrerStatsNotFound
    )?;

    let referrer_authority_key = user_stats.referrer;
    let mut referrer_user_key = Pubkey::default();
    for (referrer_key, referrer) in makers_and_referrer.0.iter() {
        // if user is in makers and referrer map, skip to avoid invalid borrow
        if referrer_key == user_key {
            continue;
        }

        let mut referrer = load_mut!(referrer)?;
        if referrer.authority != referrer_authority_key {
            continue;
        }

        if referrer.sub_account_id == 0 {
            if referrer.pool_id != 0 {
                return Ok(None);
            }

            referrer.update_last_active_slot(slot);
            referrer_user_key = *referrer_key;
            break;
        }
    }

    if referrer_user_key == Pubkey::default() {
        return Err(ErrorCode::ReferrerNotFound);
    }

    Ok(Some((referrer_authority_key, referrer_user_key)))
}

#[inline(always)]
fn get_builder_escrow_info(
    escrow_opt: &mut Option<&mut RevenueShareEscrowZeroCopyMut>,
    sub_account_id: u16,
    order_id: u32,
    market_index: u16,
    builder_referral_feature_enabled: bool,
) -> (Option<u32>, Option<u32>, Option<u16>, Option<u8>) {
    if let Some(escrow) = escrow_opt {
        let builder_order_idx = escrow.find_order_index(sub_account_id, order_id);
        let referrer_builder_order_idx = if builder_referral_feature_enabled {
            escrow.find_or_create_referral_index(market_index)
        } else {
            None
        };

        let builder_order = builder_order_idx.and_then(|idx| escrow.get_order(idx).ok());
        let builder_order_fee_bps = builder_order.map(|order| order.fee_tenth_bps);
        let builder_idx = builder_order.map(|order| order.builder_idx);

        (
            builder_order_idx,
            referrer_builder_order_idx,
            builder_order_fee_bps,
            builder_idx,
        )
    } else {
        (None, None, None, None)
    }
}

fn fulfill_perp_order(
    user: &mut User,
    user_order_index: usize,
    user_key: &Pubkey,
    user_stats: &mut UserStats,
    makers_and_referrer: &UserMap,
    makers_and_referrer_stats: &UserStatsMap,
    maker_orders_info: &[(Pubkey, usize, u64)],
    filler: &mut Option<&mut User>,
    filler_key: &Pubkey,
    filler_stats: &mut Option<&mut UserStats>,
    referrer_info: Option<(Pubkey, Pubkey)>,
    spot_market_map: &SpotMarketMap,
    perp_market_map: &PerpMarketMap,
    oracle_map: &mut OracleMap,
    validity_guard_rails: &ValidityGuardRails,
    fee_structure: &FeeStructure,
    reserve_price_before: u64,
    valid_oracle_price: Option<i64>,
    now: i64,
    slot: u64,
    amm_is_available: bool,
    fill_mode: FillMode,
    oracle_stale_for_margin: bool,
    rev_share_escrow: &mut Option<&mut RevenueShareEscrowZeroCopyMut>,
    builder_referral_feature_enabled: bool,
) -> DriftResult<(u64, u64)> {
    let market_index = user.orders[user_order_index].market_index;

    let user_order_position_decreasing =
        determine_if_user_order_is_position_decreasing(user, market_index, user_order_index)?;
    let user_is_isolated_position = user.get_perp_position(market_index)?.is_isolated();

    let perp_market = perp_market_map.get_ref(&market_index)?;
    let limit_price = fill_mode.get_limit_price(
        &user.orders[user_order_index],
        valid_oracle_price,
        slot,
        perp_market.order_tick_size,
    )?;
    let perp_market_oi_before = perp_market.get_open_interest();
    drop(perp_market);

    let fulfillment_methods = {
        let mut market = perp_market_map.get_ref_mut(&market_index)?;
        // Refresh the AMM's cached spread state (off the current reserves)
        // before routing so fulfillment decisions quote off live spread —
        // even on the very first fill of a slot before any keeper crank. The
        // matcher's `setup` re-refreshes against the post-projection curve.
        let oracle_pd = *oracle_map.get_price_data(&market.oracle_id())?;
        let mm_oracle_pd =
            market.get_mm_oracle_price_data(oracle_pd, slot, validity_guard_rails)?;
        {
            let crate::state::perp_market::PerpMarket {
                amm, market_stats, ..
            } = &mut *market;
            crate::amm::math::spread::update_amm_quote_state(
                amm,
                market_stats,
                &mm_oracle_pd,
                reserve_price_before,
                slot,
            )?;
        }
        determine_perp_fulfillment_methods(
            &user.orders[user_order_index],
            maker_orders_info,
            &market.amm,
            reserve_price_before,
            limit_price,
            amm_is_available,
        )?
    };

    if fulfillment_methods.is_empty() {
        msg!("no fulfillment methods found");
        return Ok((0, 0));
    }

    let mut base_asset_amount = 0_u64;
    let mut quote_asset_amount = 0_u64;
    let mut maker_fills: BTreeMap<Pubkey, (i64, bool)> = BTreeMap::new();
    let maker_direction = user.orders[user_order_index].direction.opposite();
    for fulfillment_method in fulfillment_methods.iter() {
        if user.orders[user_order_index].status != OrderStatus::Open {
            break;
        }
        let mut market = perp_market_map.get_ref_mut(&market_index)?;
        let user_order_direction: PositionDirection = user.orders[user_order_index].direction;

        let (fill_base_asset_amount, fill_quote_asset_amount) = match fulfillment_method {
            PerpFulfillmentMethod::AMM(maker_price) => {
                let (mut referrer, mut referrer_stats) = get_referrer(
                    &referrer_info,
                    makers_and_referrer,
                    makers_and_referrer_stats,
                    None,
                )?;

                // maker may try to fill their own order (e.g. via jit)
                // if amm takes fill, give maker filler reward
                let (mut maker, mut maker_stats) =
                    if makers_and_referrer.0.contains_key(filler_key) && filler.is_none() {
                        let maker = makers_and_referrer.get_ref_mut(filler_key)?;
                        if maker.authority == user.authority {
                            (None, None)
                        } else {
                            let maker_stats =
                                makers_and_referrer_stats.get_ref_mut(&maker.authority)?;
                            (Some(maker), Some(maker_stats))
                        }
                    } else {
                        (None, None)
                    };

                let (fill_base, fill_quote, _) = fulfill_perp_order_step(
                    market.deref_mut(),
                    user,
                    user_stats,
                    user_order_index,
                    user_key,
                    PerpFulfillmentMethod::AMM(*maker_price),
                    &mut maker.as_deref_mut(),
                    &mut maker_stats.as_deref_mut(),
                    None,
                    None,
                    filler,
                    filler_stats,
                    filler_key,
                    &mut referrer.as_deref_mut(),
                    &mut referrer_stats.as_deref_mut(),
                    reserve_price_before,
                    valid_oracle_price,
                    limit_price,
                    now,
                    slot,
                    validity_guard_rails,
                    fee_structure,
                    oracle_map,
                    fill_mode.is_liquidation(),
                    rev_share_escrow,
                    builder_referral_feature_enabled,
                )?;
                (fill_base, fill_quote)
            }
            PerpFulfillmentMethod::Match(maker_key, maker_order_index, maker_price) => {
                let mut maker = makers_and_referrer.get_ref_mut(maker_key)?;
                let maker_is_isolated_position =
                    maker.get_perp_position(market_index)?.is_isolated();
                let mut maker_stats = if maker.authority == user.authority {
                    None
                } else {
                    Some(makers_and_referrer_stats.get_ref_mut(&maker.authority)?)
                };

                let (mut referrer, mut referrer_stats) = get_referrer(
                    &referrer_info,
                    makers_and_referrer,
                    makers_and_referrer_stats,
                    Some(&maker),
                )?;

                let mut maker_opt: Option<&mut User> = Some(&mut *maker);
                let mut maker_stats_opt: Option<&mut UserStats> = maker_stats.as_deref_mut();
                let (fill_base, fill_quote, maker_fill_base) = fulfill_perp_order_step(
                    market.deref_mut(),
                    user,
                    user_stats,
                    user_order_index,
                    user_key,
                    PerpFulfillmentMethod::Match(*maker_key, *maker_order_index, *maker_price),
                    &mut maker_opt,
                    &mut maker_stats_opt,
                    Some(*maker_order_index as usize),
                    Some(maker_key),
                    filler,
                    filler_stats,
                    filler_key,
                    &mut referrer.as_deref_mut(),
                    &mut referrer_stats.as_deref_mut(),
                    reserve_price_before,
                    valid_oracle_price,
                    limit_price,
                    now,
                    slot,
                    validity_guard_rails,
                    fee_structure,
                    oracle_map,
                    fill_mode.is_liquidation(),
                    rev_share_escrow,
                    builder_referral_feature_enabled,
                )?;

                if maker_fill_base != 0 {
                    update_maker_fills_map(
                        &mut maker_fills,
                        maker_key,
                        maker_direction,
                        maker_fill_base,
                        maker_is_isolated_position,
                    )?;
                }

                (fill_base, fill_quote)
            }
        };

        base_asset_amount = base_asset_amount.safe_add(fill_base_asset_amount)?;
        quote_asset_amount = quote_asset_amount.safe_add(fill_quote_asset_amount)?;
        market.market_stats.update_volume_24h(
            fill_quote_asset_amount,
            user_order_direction,
            now,
        )?;
    }

    validate!(
        (base_asset_amount > 0) == (quote_asset_amount > 0),
        ErrorCode::DefaultError,
        "invalid fill base = {} quote = {}",
        base_asset_amount,
        quote_asset_amount
    )?;

    let total_maker_fill = maker_fills.values().map(|(fill, _)| fill).sum::<i64>();

    validate!(
        total_maker_fill.unsigned_abs() <= base_asset_amount,
        ErrorCode::DefaultError,
        "invalid total maker fill {} total fill {}",
        total_maker_fill,
        base_asset_amount
    )?;

    if !fill_mode.is_liquidation() {
        // if the maker is long, the user sold so
        let _taker_base_asset_amount_delta = if maker_direction == PositionDirection::Long {
            base_asset_amount as i64
        } else {
            -(base_asset_amount as i64)
        };

        let margin_requirement_type = if user_order_position_decreasing {
            MarginRequirementType::Maintenance
        } else {
            MarginRequirementType::Fill
        };

        let margin_type_config = if user_is_isolated_position {
            MarginTypeConfig::IsolatedPositionOverride {
                market_index,
                margin_requirement_type,
                default_isolated_margin_requirement_type: MarginRequirementType::Maintenance,
                cross_margin_requirement_type: MarginRequirementType::Maintenance,
            }
        } else {
            MarginTypeConfig::CrossMarginOverride {
                margin_requirement_type,
                default_margin_requirement_type: MarginRequirementType::Maintenance,
            }
        };

        let mut context = MarginContext::standard_with_config(margin_type_config);

        if oracle_stale_for_margin && !user_order_position_decreasing {
            context = context.margin_ratio_override(MARGIN_PRECISION);
        }

        let taker_margin_calculation =
            calculate_margin_requirement_and_total_collateral_and_liability_info(
                user,
                perp_market_map,
                spot_market_map,
                oracle_map,
                context,
            )?;

        if !taker_margin_calculation.meets_margin_requirement() {
            let (margin_requirement, total_collateral) =
                if taker_margin_calculation.has_isolated_margin_calculation(market_index) {
                    let isolated_margin_calculation =
                        taker_margin_calculation.get_isolated_margin_calculation(market_index)?;
                    (
                        isolated_margin_calculation.margin_requirement,
                        isolated_margin_calculation.total_collateral,
                    )
                } else {
                    (
                        taker_margin_calculation.margin_requirement,
                        taker_margin_calculation.total_collateral,
                    )
                };

            msg!(
                "taker breached fill requirements (margin requirement {}) (total_collateral {})",
                margin_requirement,
                total_collateral
            );
            return Err(ErrorCode::InsufficientCollateral);
        }
    }

    for (maker_key, (maker_base_asset_amount_filled, maker_is_isolated_position)) in maker_fills {
        let maker = makers_and_referrer.get_ref_mut(&maker_key)?;

        let _maker_stats = if maker.authority == user.authority {
            None
        } else {
            Some(makers_and_referrer_stats.get_ref_mut(&maker.authority)?)
        };

        let (margin_type, maker_risk_increasing) = select_margin_type_for_perp_maker(
            &maker,
            maker_base_asset_amount_filled,
            market_index,
        )?;

        let margin_type_config = if maker_is_isolated_position {
            MarginTypeConfig::IsolatedPositionOverride {
                market_index,
                margin_requirement_type: margin_type,
                default_isolated_margin_requirement_type: MarginRequirementType::Maintenance,
                cross_margin_requirement_type: MarginRequirementType::Maintenance,
            }
        } else {
            MarginTypeConfig::CrossMarginOverride {
                margin_requirement_type: margin_type,
                default_margin_requirement_type: MarginRequirementType::Maintenance,
            }
        };

        let mut context = MarginContext::standard_with_config(margin_type_config);

        if oracle_stale_for_margin {
            validate!(
                user_order_position_decreasing || !maker_risk_increasing,
                ErrorCode::InvalidOracle,
                "taker or maker must be reducing position if oracle stale for margin"
            )?;

            if maker_risk_increasing {
                context = context.margin_ratio_override(MARGIN_PRECISION);
            }
        }

        let maker_margin_calculation =
            calculate_margin_requirement_and_total_collateral_and_liability_info(
                &maker,
                perp_market_map,
                spot_market_map,
                oracle_map,
                context,
            )?;

        if !maker_margin_calculation.meets_margin_requirement() {
            let (margin_requirement, total_collateral) =
                if maker_margin_calculation.has_isolated_margin_calculation(market_index) {
                    let isolated_margin_calculation =
                        maker_margin_calculation.get_isolated_margin_calculation(market_index)?;
                    (
                        isolated_margin_calculation.margin_requirement,
                        isolated_margin_calculation.total_collateral,
                    )
                } else {
                    (
                        maker_margin_calculation.margin_requirement,
                        maker_margin_calculation.total_collateral,
                    )
                };

            msg!(
                "maker ({}) breached fill requirements (margin requirement {}) (total_collateral {})",
                maker_key,
                margin_requirement,
                total_collateral
            );
            return Err(ErrorCode::InsufficientCollateral);
        }
    }

    if oracle_stale_for_margin {
        let perp_market_oi_after = perp_market_map.get_ref(&market_index)?.get_open_interest();
        validate!(
            perp_market_oi_after <= perp_market_oi_before,
            ErrorCode::InvalidOracle,
            "oracle stale for margin but open interest increased"
        )?;
    }

    Ok((base_asset_amount, quote_asset_amount))
}

#[allow(clippy::type_complexity)]
fn get_referrer<'a>(
    referrer_info: &'a Option<(Pubkey, Pubkey)>,
    makers_and_referrer: &'a UserMap,
    makers_and_referrer_stats: &'a UserStatsMap,
    maker: Option<&User>,
) -> DriftResult<(Option<RefMut<'a, User>>, Option<RefMut<'a, UserStats>>)> {
    let (referrer_authority_key, referrer_user_key) = match referrer_info {
        Some(referrer_keys) => referrer_keys,
        None => return Ok((None, None)),
    };

    if let Some(maker) = maker {
        if &maker.authority == referrer_authority_key {
            return Ok((None, None));
        }
    }

    let referrer = makers_and_referrer.get_ref_mut(referrer_user_key)?;
    let referrer_stats = makers_and_referrer_stats.get_ref_mut(referrer_authority_key)?;

    Ok((Some(referrer), Some(referrer_stats)))
}

#[inline(always)]
fn update_maker_fills_map(
    map: &mut BTreeMap<Pubkey, (i64, bool)>,
    maker_key: &Pubkey,
    maker_direction: PositionDirection,
    fill: u64,
    is_isolated_position: bool,
) -> DriftResult {
    let signed_fill = match maker_direction {
        PositionDirection::Long => fill.cast::<i64>()?,
        PositionDirection::Short => -fill.cast::<i64>()?,
    };

    if let Some(maker_filled) = map.get_mut(maker_key) {
        *maker_filled = (maker_filled.0.safe_add(signed_fill)?, is_isolated_position);
    } else {
        map.insert(*maker_key, (signed_fill, is_isolated_position));
    }

    Ok(())
}

fn determine_if_user_order_is_position_decreasing(
    user: &User,
    market_index: u16,
    order_index: usize,
) -> DriftResult<bool> {
    let position_index = get_position_index(&user.perp_positions, market_index)?;
    let order_direction = user.orders[order_index].direction;
    let position_base_asset_amount_before = user.perp_positions[position_index].base_asset_amount;
    is_order_position_reducing(
        &order_direction,
        user.orders[order_index]
            .get_base_asset_amount_unfilled(Some(position_base_asset_amount_before))?,
        position_base_asset_amount_before.cast()?,
    )
}

pub fn credit_filler_perp_pnl(
    filler: &mut User,
    filler_stats: &mut Option<&mut UserStats>,
    market: &mut PerpMarket,
    filler_reward: u64,
    quote_asset_amount: u64,
    now: i64,
    slot: u64,
) -> DriftResult {
    if filler_reward > 0 {
        let position_index = get_position_index(&filler.perp_positions, market.market_index)
            .or_else(|_| add_new_position(&mut filler.perp_positions, market.market_index))?;

        controller::position::update_quote_asset_amount(
            &mut filler.perp_positions[position_index],
            market,
            filler_reward.cast()?,
        )?;

        filler_stats
            .as_mut()
            .safe_unwrap()?
            .update_filler_volume(quote_asset_amount, now)?;
    }

    filler.update_last_active_slot(slot);

    Ok(())
}

/// Build and emit an `OrderActionRecord`. Extracted out of
/// `fulfill_perp_order_step` so its 480-byte `OrderActionRecord` plus the
/// two `Option<Order>` copies live in this helper's frame rather than the
/// already-large orchestrator's frame — the SBPF stack-overwrite check
/// otherwise fires.
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn emit_perp_action_record(
    market: &mut PerpMarket,
    oracle_map: &mut OracleMap,
    now: i64,
    action_explanation: OrderActionExplanation,
    filler_key: &Pubkey,
    filler_reward: u64,
    base_filled: u64,
    quote_filled: u64,
    taker_fee_plus_builder: u64,
    maker_rebate: Option<u64>,
    referrer_reward: u64,
    quote_asset_amount_surplus: Option<i64>,
    taker_record_key: Option<Pubkey>,
    taker_record_order: Option<Order>,
    maker_record_key: Option<Pubkey>,
    maker_record_order: Option<Order>,
    order_action_bit_flags: u8,
    taker_existing_quote_entry_amount: Option<u64>,
    taker_existing_base_asset_amount: Option<u64>,
    maker_existing_quote_entry_amount: Option<u64>,
    maker_existing_base_asset_amount: Option<u64>,
    builder_idx: Option<u8>,
    builder_fee_option: Option<u64>,
) -> DriftResult {
    let fill_record_id = get_then_update_id!(market, next_fill_record_id);
    let oracle_price = oracle_map.get_price_data(&market.oracle_id())?.price;
    let record = get_order_action_record(
        now,
        OrderAction::Fill,
        action_explanation,
        market.market_index,
        Some(*filler_key),
        Some(fill_record_id),
        Some(filler_reward),
        Some(base_filled),
        Some(quote_filled),
        Some(taker_fee_plus_builder),
        maker_rebate,
        Some(referrer_reward),
        quote_asset_amount_surplus,
        None,
        taker_record_key,
        taker_record_order,
        maker_record_key,
        maker_record_order,
        oracle_price,
        order_action_bit_flags,
        taker_existing_quote_entry_amount,
        taker_existing_base_asset_amount,
        maker_existing_quote_entry_amount,
        maker_existing_base_asset_amount,
        None,
        builder_idx,
        builder_fee_option,
    )?;
    emit_stack::<_, { OrderActionRecord::SIZE }>(record)
}

#[allow(clippy::too_many_arguments)]
/// Settle a single `AmmHouse` fill (sole-AMM step, or a JIT slice inside a
/// Match step). Returns `(base_filled, quote_filled)` to accumulate.
fn settle_amm_house_fill(
    fill: &QuoterFill,
    market: &mut PerpMarket,
    taker: &mut User,
    taker_stats: &mut UserStats,
    taker_position_index: usize,
    taker_order_index: usize,
    taker_key: &Pubkey,
    taker_direction: PositionDirection,
    taker_existing_position_params_before: Option<(u64, u64)>,
    order_post_only: bool,
    order_slot: u64,
    order_id: u32,
    taker_limit_price: Option<u64>,
    is_jit_within_match: bool,
    is_liquidation: bool,
    maker: &mut Option<&mut User>,
    maker_stats: &mut Option<&mut UserStats>,
    filler: &mut Option<&mut User>,
    filler_stats: &mut Option<&mut UserStats>,
    filler_key: &Pubkey,
    referrer: &mut Option<&mut User>,
    referrer_stats: &mut Option<&mut UserStats>,
    rev_share_escrow: &mut Option<&mut RevenueShareEscrowZeroCopyMut>,
    builder_referral_feature_enabled: bool,
    fee_structure: &FeeStructure,
    oracle_map: &mut OracleMap,
    now: i64,
    slot: u64,
) -> DriftResult<(u64, u64)> {
    // For sole-AMM steps with a post_only taker, override the
    // fill's quote at the order's limit price (the taker, acting
    // as maker, transacts at limit; the AMM captures the curve
    // ↔ limit gap as spread surplus). For JIT slices inside a
    // Match step, `AmmJitQuoter::try_fill_solo` already returns
    // the jit-price quote + curve↔jit surplus — pass through.
    let (taker_quote, taker_surplus) =
        if !is_jit_within_match && order_post_only && taker_limit_price.is_some() {
            crate::controller::position::calculate_quote_asset_amount_surplus(
                taker_direction,
                fill.quote_filled,
                fill.base_filled,
                taker_limit_price.unwrap(),
            )?
        } else {
            (fill.quote_filled, fill.quote_asset_amount_surplus)
        };

    let reward_referrer = can_reward_user_with_referral_reward(
        referrer,
        market.market_index,
        rev_share_escrow,
        builder_referral_feature_enabled,
    );
    let reward_filler = can_reward_user_with_perp_pnl(filler, market.market_index)
        || (!is_jit_within_match && can_reward_user_with_perp_pnl(maker, market.market_index));

    let (builder_order_idx, referrer_builder_order_idx, builder_order_fee_bps, builder_idx) =
        get_builder_escrow_info(
            rev_share_escrow,
            taker.sub_account_id,
            order_id,
            market.market_index,
            builder_referral_feature_enabled,
        );

    let FillFees {
        user_fee,
        fee_to_market,
        filler_reward,
        referee_discount,
        referrer_reward,
        fee_to_market_for_lp: _fee_to_market_for_lp,
        maker_rebate,
        builder_fee: builder_fee_option,
    } = fees::calculate_fee_for_fulfillment_with_amm(
        taker_stats,
        taker_quote,
        fee_structure,
        order_slot,
        slot,
        reward_filler,
        reward_referrer,
        referrer_stats,
        taker_surplus,
        order_post_only,
        market.fee_adjustment,
        builder_order_fee_bps,
    )?;
    let builder_fee = builder_fee_option.unwrap_or(0);

    if builder_fee != 0 {
        if let (Some(idx), Some(escrow)) = (builder_order_idx, rev_share_escrow.as_mut()) {
            let order = escrow.get_order_mut(idx)?;
            order.fees_accrued = order.fees_accrued.safe_add(builder_fee)?;
        } else {
            validate!(
                false,
                ErrorCode::UnableToLoadRevenueShareAccount,
                "Order has builder fee but no escrow account found"
            )?;
        }
    }

    let taker_pd = get_position_delta_for_fill(fill.base_filled, taker_quote, taker_direction)?;
    update_position_and_market(
        &mut taker.perp_positions[taker_position_index],
        market,
        &taker_pd,
    )?;

    market.total_exchange_fee = market.total_exchange_fee.safe_add(user_fee.cast()?)?;
    <crate::amm::AMM as crate::amm::quoter::AmmContract>::apply_fill_fees(
        &mut market.amm,
        fee_to_market,
        taker_surplus,
    )?;

    taker_stats.increment_total_fees(user_fee)?;
    taker_stats.increment_total_rebate(maker_rebate)?;
    taker_stats.increment_total_referee_discount(referee_discount)?;

    if let (Some(idx), Some(escrow)) = (referrer_builder_order_idx, rev_share_escrow.as_mut()) {
        let order = escrow.get_order_mut(idx)?;
        order.fees_accrued = order.fees_accrued.safe_add(referrer_reward)?;
    } else if let (Some(referrer_user), Some(referrer_stats_ref)) =
        (referrer.as_mut(), referrer_stats.as_mut())
    {
        if let Ok(referrer_position) =
            referrer_user.force_get_perp_position_mut(market.market_index)
        {
            if referrer_reward > 0 {
                update_quote_asset_amount(referrer_position, market, referrer_reward.cast()?)?;
            }
            referrer_stats_ref.increment_total_referrer_reward(referrer_reward, now)?;
        }
    }

    if user_fee != 0 || builder_fee != 0 {
        controller::position::update_quote_asset_and_break_even_amount(
            &mut taker.perp_positions[taker_position_index],
            market,
            -(user_fee.safe_add(builder_fee)?).cast()?,
        )?;
    }
    if maker_rebate != 0 {
        controller::position::update_quote_asset_and_break_even_amount(
            &mut taker.perp_positions[taker_position_index],
            market,
            maker_rebate.cast()?,
        )?;
    }

    if order_post_only {
        taker_stats.update_maker_volume_30d(taker_quote, now)?;
    } else {
        taker_stats.update_taker_volume_30d(taker_quote, now)?;
    }

    if let Some(filler_user) = filler.as_mut() {
        credit_filler_perp_pnl(
            filler_user,
            filler_stats,
            market,
            filler_reward,
            taker_quote,
            now,
            slot,
        )?;
    } else if !is_jit_within_match {
        if let Some(maker_user) = maker.as_mut() {
            credit_filler_perp_pnl(
                maker_user,
                maker_stats,
                market,
                filler_reward,
                taker_quote,
                now,
                slot,
            )?;
        }
    }

    // Update taker order BEFORE event emit.
    let is_taker_filled_after_this = update_order_after_fill(
        &mut taker.orders[taker_order_index],
        fill.base_filled,
        taker_quote,
    )?;
    if is_taker_filled_after_this {
        if let (Some(idx), Some(escrow)) = (builder_order_idx, rev_share_escrow.as_mut()) {
            let _ = escrow
                .get_order_mut(idx)
                .map(|o| o.add_bit_flag(RevenueShareOrderBitFlag::Completed));
        }
    }
    decrease_open_bids_and_asks(
        &mut taker.perp_positions[taker_position_index],
        &taker_direction,
        fill.base_filled,
        taker.orders[taker_order_index].update_open_bids_and_asks(),
    )?;

    let (taker_record_key, taker_record_order, maker_record_key, maker_record_order) =
        get_taker_and_maker_for_order_record(taker_key, &taker.orders[taker_order_index]);

    let order_action_explanation = if is_liquidation {
        OrderActionExplanation::Liquidation
    } else if is_jit_within_match {
        OrderActionExplanation::OrderFilledWithAMMJit
    } else {
        OrderActionExplanation::OrderFilledWithAMM
    };
    let mut order_action_bit_flags: u8 = 0;
    order_action_bit_flags = set_order_bit_flag(
        order_action_bit_flags,
        taker.orders[taker_order_index].is_signed_msg(),
        OrderBitFlag::SignedMessage,
    );
    if taker.perp_positions[taker_position_index].is_isolated() {
        order_action_bit_flags = set_order_bit_flag(
            order_action_bit_flags,
            true,
            OrderBitFlag::IsIsolatedPosition,
        );
    }

    let (
        taker_existing_quote_entry_amount,
        taker_existing_base_asset_amount,
        maker_existing_quote_entry_amount,
        maker_existing_base_asset_amount,
    ) = {
        let (existing_quote_entry_amount, existing_base_asset_amount) =
            calculate_existing_position_fields_for_order_action(
                fill.base_filled,
                taker_existing_position_params_before,
            )?;
        if taker_record_key.is_some() {
            (
                existing_quote_entry_amount,
                existing_base_asset_amount,
                None,
                None,
            )
        } else {
            (
                None,
                None,
                existing_quote_entry_amount,
                existing_base_asset_amount,
            )
        }
    };

    emit_perp_action_record(
        market,
        oracle_map,
        now,
        order_action_explanation,
        filler_key,
        filler_reward,
        fill.base_filled,
        taker_quote,
        user_fee.safe_add(builder_fee)?,
        if maker_rebate != 0 {
            Some(maker_rebate)
        } else {
            None
        },
        referrer_reward,
        Some(taker_surplus),
        taker_record_key,
        taker_record_order,
        maker_record_key,
        maker_record_order,
        order_action_bit_flags,
        taker_existing_quote_entry_amount,
        taker_existing_base_asset_amount,
        maker_existing_quote_entry_amount,
        maker_existing_base_asset_amount,
        builder_idx,
        builder_fee_option,
    )?;

    Ok((fill.base_filled, taker_quote))
}

#[allow(clippy::too_many_arguments)]
/// Settle a single `DlobMatch` fill (taker vs a resting DLOB maker order).
/// Returns `(base_filled, quote_filled, maker_base_filled)` to accumulate.
fn settle_dlob_match_fill(
    fill: &QuoterFill,
    market: &mut PerpMarket,
    taker: &mut User,
    taker_stats: &mut UserStats,
    taker_position_index: usize,
    taker_order_index: usize,
    taker_key: &Pubkey,
    taker_direction: PositionDirection,
    taker_existing_position_params_before: Option<(u64, u64)>,
    maker: &mut Option<&mut User>,
    maker_stats: &mut Option<&mut UserStats>,
    maker_order_index: Option<usize>,
    maker_key_opt: Option<&Pubkey>,
    maker_existing_position_params: Option<(u64, u64)>,
    match_maker_price: Option<u64>,
    taker_price_for_match: Option<u64>,
    oracle_price: i64,
    filler: &mut Option<&mut User>,
    filler_stats: &mut Option<&mut UserStats>,
    filler_key: &Pubkey,
    referrer: &mut Option<&mut User>,
    referrer_stats: &mut Option<&mut UserStats>,
    rev_share_escrow: &mut Option<&mut RevenueShareEscrowZeroCopyMut>,
    builder_referral_feature_enabled: bool,
    fee_structure: &FeeStructure,
    oracle_map: &mut OracleMap,
    is_liquidation: bool,
    now: i64,
    slot: u64,
) -> DriftResult<(u64, u64, u64)> {
    // DlobMatch fills only land from a Match step, which always
    // populates `match_maker_price`.
    let match_maker_price = match_maker_price.ok_or_else(print_error!(ErrorCode::DefaultError))?;
    let m_idx = maker_order_index.ok_or_else(print_error!(ErrorCode::DefaultError))?;
    let m_key = maker_key_opt.ok_or_else(print_error!(ErrorCode::DefaultError))?;
    let maker_user = maker
        .as_deref_mut()
        .ok_or_else(print_error!(ErrorCode::DefaultError))?;
    let maker_position_index = get_position_index(&maker_user.perp_positions, market.market_index)?;
    let maker_direction = maker_user.orders[m_idx].direction;
    let maker_order_has_jit_flag = maker_user.orders[m_idx].is_jit_maker();

    let taker_price_validate =
        taker_price_for_match.ok_or_else(print_error!(ErrorCode::DefaultError))?;
    validate_fill_price(
        fill.quote_filled,
        fill.base_filled,
        BASE_PRECISION_U64,
        taker_direction,
        taker_price_validate,
        true,
    )?;
    validate_fill_price(
        fill.quote_filled,
        fill.base_filled,
        BASE_PRECISION_U64,
        maker_direction,
        match_maker_price,
        false,
    )?;

    let maker_pd =
        get_position_delta_for_fill(fill.base_filled, fill.quote_filled, maker_direction)?;
    update_position_and_market(
        &mut maker_user.perp_positions[maker_position_index],
        market,
        &maker_pd,
    )?;

    if let Some(ms) = maker_stats.as_mut() {
        ms.update_maker_volume_30d(fill.quote_filled, now)?;
    } else {
        taker_stats.update_maker_volume_30d(fill.quote_filled, now)?;
    }

    let taker_pd =
        get_position_delta_for_fill(fill.base_filled, fill.quote_filled, taker_direction)?;
    update_position_and_market(
        &mut taker.perp_positions[taker_position_index],
        market,
        &taker_pd,
    )?;
    taker_stats.update_taker_volume_30d(fill.quote_filled, now)?;

    let reward_referrer = can_reward_user_with_referral_reward(
        referrer,
        market.market_index,
        rev_share_escrow,
        builder_referral_feature_enabled,
    );
    let reward_filler = can_reward_user_with_perp_pnl(filler, market.market_index);

    let (builder_order_idx, referrer_builder_order_idx, builder_order_fee_bps, builder_idx) =
        get_builder_escrow_info(
            rev_share_escrow,
            taker.sub_account_id,
            taker.orders[taker_order_index].order_id,
            market.market_index,
            builder_referral_feature_enabled,
        );

    let filler_multiplier = if reward_filler {
        calculate_filler_multiplier_for_matched_orders(
            match_maker_price,
            maker_direction,
            oracle_price,
        )?
    } else {
        0
    };

    let FillFees {
        user_fee: taker_fee,
        maker_rebate,
        fee_to_market,
        filler_reward,
        referrer_reward,
        referee_discount,
        builder_fee: builder_fee_option,
        ..
    } = fees::calculate_fee_for_fulfillment_with_match(
        taker_stats,
        maker_stats,
        fill.quote_filled,
        fee_structure,
        taker.orders[taker_order_index].slot,
        slot,
        filler_multiplier,
        reward_referrer,
        referrer_stats,
        &MarketType::Perp,
        market.fee_adjustment,
        builder_order_fee_bps,
    )?;
    let builder_fee = builder_fee_option.unwrap_or(0);

    if builder_fee != 0 {
        if let (Some(idx), Some(escrow)) = (builder_order_idx, rev_share_escrow.as_deref_mut()) {
            let order = escrow.get_order_mut(idx)?;
            order.fees_accrued = order.fees_accrued.safe_add(builder_fee)?;
        } else {
            validate!(
                false,
                ErrorCode::UnableToLoadRevenueShareAccount,
                "Order has builder fee but no escrow account found"
            )?;
        }
    }

    market.total_exchange_fee = market.total_exchange_fee.safe_add(fee_to_market.cast()?)?;

    controller::position::update_quote_asset_and_break_even_amount(
        &mut taker.perp_positions[taker_position_index],
        market,
        -(taker_fee.safe_add(builder_fee)?).cast()?,
    )?;

    taker_stats.increment_total_fees(taker_fee)?;
    taker_stats.increment_total_referee_discount(referee_discount)?;

    controller::position::update_quote_asset_and_break_even_amount(
        &mut maker_user.perp_positions[maker_position_index],
        market,
        maker_rebate.cast()?,
    )?;

    if let Some(ms) = maker_stats.as_mut() {
        ms.increment_total_rebate(maker_rebate)?;
    } else {
        taker_stats.increment_total_rebate(maker_rebate)?;
    }

    if let Some(filler_user) = filler.as_mut() {
        if filler_reward > 0 {
            let filler_position_index =
                get_position_index(&filler_user.perp_positions, market.market_index).or_else(
                    |_| add_new_position(&mut filler_user.perp_positions, market.market_index),
                )?;
            controller::position::update_quote_asset_amount(
                &mut filler_user.perp_positions[filler_position_index],
                market,
                filler_reward.cast()?,
            )?;
            filler_stats
                .as_mut()
                .safe_unwrap()?
                .update_filler_volume(fill.quote_filled, now)?;
        }
        filler_user.update_last_active_slot(slot);
    }

    if let (Some(idx), Some(escrow)) = (referrer_builder_order_idx, rev_share_escrow.as_deref_mut())
    {
        let order = escrow.get_order_mut(idx)?;
        order.fees_accrued = order.fees_accrued.safe_add(referrer_reward)?;
    } else if let (Some(referrer_user), Some(referrer_stats_ref)) =
        (referrer.as_mut(), referrer_stats.as_mut())
    {
        if let Ok(referrer_position) =
            referrer_user.force_get_perp_position_mut(market.market_index)
        {
            if referrer_reward > 0 {
                update_quote_asset_amount(referrer_position, market, referrer_reward.cast()?)?;
            }
            referrer_stats_ref.increment_total_referrer_reward(referrer_reward, now)?;
        }
    }

    // Update taker order BEFORE event emit.
    let is_taker_filled_after_this = update_order_after_fill(
        &mut taker.orders[taker_order_index],
        fill.base_filled,
        fill.quote_filled,
    )?;
    if is_taker_filled_after_this {
        if let (Some(idx), Some(escrow)) = (builder_order_idx, rev_share_escrow.as_deref_mut()) {
            let _ = escrow
                .get_order_mut(idx)
                .map(|o| o.add_bit_flag(RevenueShareOrderBitFlag::Completed));
        }
    }
    decrease_open_bids_and_asks(
        &mut taker.perp_positions[taker_position_index],
        &taker_direction,
        fill.base_filled,
        taker.orders[taker_order_index].update_open_bids_and_asks(),
    )?;

    // Maker open-bids/asks bookkeeping. commit_fill already
    // updated maker order's filled counters; we only need open
    // bids/asks decrement + status flip.
    decrease_open_bids_and_asks(
        &mut maker_user.perp_positions[maker_position_index],
        &maker_direction,
        fill.base_filled,
        maker_user.orders[m_idx].update_open_bids_and_asks(),
    )?;
    if maker_user.orders[m_idx].get_base_asset_amount_unfilled(None)? == 0 {
        maker_user.orders[m_idx].status = OrderStatus::Filled;
    }

    let order_action_explanation = if is_liquidation {
        OrderActionExplanation::Liquidation
    } else if maker_order_has_jit_flag {
        OrderActionExplanation::OrderFilledWithMatchJit
    } else {
        OrderActionExplanation::OrderFilledWithMatch
    };
    let mut order_action_bit_flags: u8 = 0;
    order_action_bit_flags = set_order_bit_flag(
        order_action_bit_flags,
        taker.orders[taker_order_index].is_signed_msg(),
        OrderBitFlag::SignedMessage,
    );
    if taker.perp_positions[taker_position_index].is_isolated()
        || maker_user.perp_positions[maker_position_index].is_isolated()
    {
        order_action_bit_flags = set_order_bit_flag(
            order_action_bit_flags,
            true,
            OrderBitFlag::IsIsolatedPosition,
        );
    }

    let (taker_existing_quote_entry_amount, taker_existing_base_asset_amount) =
        calculate_existing_position_fields_for_order_action(
            fill.base_filled,
            taker_existing_position_params_before,
        )?;
    let (maker_existing_quote_entry_amount, maker_existing_base_asset_amount) =
        calculate_existing_position_fields_for_order_action(
            fill.base_filled,
            maker_existing_position_params,
        )?;
    let taker_order_for_record = taker.orders[taker_order_index];
    let maker_order_for_record = maker_user.orders[m_idx];
    let m_key_owned = *m_key;
    emit_perp_action_record(
        market,
        oracle_map,
        now,
        order_action_explanation,
        filler_key,
        filler_reward,
        fill.base_filled,
        fill.quote_filled,
        taker_fee.safe_add(builder_fee)?,
        Some(maker_rebate),
        referrer_reward,
        None,
        Some(*taker_key),
        Some(taker_order_for_record),
        Some(m_key_owned),
        Some(maker_order_for_record),
        order_action_bit_flags,
        taker_existing_quote_entry_amount,
        taker_existing_base_asset_amount,
        maker_existing_quote_entry_amount,
        maker_existing_base_asset_amount,
        builder_idx,
        builder_fee_option,
    )?;

    Ok((fill.base_filled, fill.quote_filled, fill.base_filled))
}

/// Unified fulfill step. Replaces `fulfill_perp_order_with_amm` and
/// `fulfill_perp_order_with_match` with a single matcher-driven path: build
/// the right quoter set from the `PerpFulfillmentMethod`, run `match_take`
/// once, then walk `match.fills` and dispatch per-fill on `FillFeePolicy`.
///
/// Returns `(taker_base_filled, taker_quote_filled, maker_base_filled)`.
/// `maker_base_filled` is the sum of base across `DlobMatch` fills (zero for
/// AMM-only steps).
#[allow(clippy::too_many_arguments)]
pub fn fulfill_perp_order_step(
    market: &mut PerpMarket,
    taker: &mut User,
    taker_stats: &mut UserStats,
    taker_order_index: usize,
    taker_key: &Pubkey,
    method: PerpFulfillmentMethod,
    maker: &mut Option<&mut User>,
    maker_stats: &mut Option<&mut UserStats>,
    maker_order_index: Option<usize>,
    maker_key_opt: Option<&Pubkey>,
    filler: &mut Option<&mut User>,
    filler_stats: &mut Option<&mut UserStats>,
    filler_key: &Pubkey,
    referrer: &mut Option<&mut User>,
    referrer_stats: &mut Option<&mut UserStats>,
    // AmmQuoter::setup is what materialises the pre-quote reserves now;
    // this orchestrator-supplied value is informational only. Kept on the
    // signature to avoid churning all call sites.
    _reserve_price_before: u64,
    valid_oracle_price: Option<i64>,
    taker_limit_price: Option<u64>,
    now: i64,
    slot: u64,
    validity_guard_rails: &ValidityGuardRails,
    fee_structure: &FeeStructure,
    oracle_map: &mut OracleMap,
    is_liquidation: bool,
    rev_share_escrow: &mut Option<&mut RevenueShareEscrowZeroCopyMut>,
    builder_referral_feature_enabled: bool,
) -> DriftResult<(u64, u64, u64)> {
    // ---- 1. Capture taker order fields. ----
    let market_index = market.market_index;
    let taker_position_index = get_position_index(&taker.perp_positions, market_index)?;
    let taker_existing_position_before =
        taker.perp_positions[taker_position_index].base_asset_amount;
    let taker_existing_position_params_before = taker.perp_positions[taker_position_index]
        .get_existing_position_params_for_order_action(taker.orders[taker_order_index].direction);
    let (order_post_only, order_slot, taker_direction, order_id) = get_struct_values!(
        taker.orders[taker_order_index],
        post_only,
        slot,
        direction,
        order_id
    );
    let taker_order_has_builder = taker.orders[taker_order_index].is_has_builder();
    if taker_order_has_builder && rev_share_escrow.is_none() {
        msg!("Order has builder but no escrow account included, in the future this will fail.");
    }

    let oracle_pd = *oracle_map.get_price_data(&market.oracle_id())?;
    let oracle_price = oracle_pd.price;
    let mm_oracle_price_data =
        market.get_mm_oracle_price_data(oracle_pd, slot, validity_guard_rails)?;
    let sanitize_clamp_denom = market.get_sanitize_clamp_denominator()?;

    // Construct the AMM-side `Quoter` and run setup once. `Quoter::setup`
    // is the sole non-admin AMM-refresh path. The quoter lives until the
    // end of this function — the AMM-match arm uses it directly; the
    // DLOB-Match arm explicitly drops it before constructing an
    // `AmmJitQuoter` over the same `&mut market`.
    let amm_refresh_validity = crate::amm::refresh::compute_amm_refresh_validity_with_guard_rails(
        market,
        &mm_oracle_price_data,
        validity_guard_rails,
    )?;
    let market_stats_snapshot = market.market_stats;
    let safe_oracle = mm_oracle_price_data.get_safe_oracle_price_data();
    let order_tick_size = market.order_tick_size;
    let order_step_size = market.order_step_size;
    let market_status_local = market.status;
    let market_config_local = market.market_config;
    let setup_ctx = QuoteContext {
        stats: &market_stats_snapshot,
        oracle: &safe_oracle,
        mm_oracle: Some(&mm_oracle_price_data),
        oracle_validity: amm_refresh_validity,
        fee_budget: 0,
        tick: order_tick_size,
        step_size: order_step_size,
        slot,
        base_precision: BASE_PRECISION_U64,
        market_status: market_status_local,
        market_config: market_config_local,
    };
    let mut amm_quoter = AmmQuoter::for_amm(&mut market.amm);
    <AmmQuoter as Quoter>::setup(&mut amm_quoter, &setup_ctx)?;
    let reserve_after_setup = amm_quoter.amm.reserve_price()?;
    let (amm_bid_price, amm_ask_price) = amm_quoter.amm_bid_ask(reserve_after_setup)?;
    let amm_base_spread = amm_quoter.amm_base_spread();
    // Snapshot the just-refreshed cached spreads for the mark-twap update
    // below (which takes scalars, not an `&AMM` borrow).
    let amm_long_spread = amm_quoter.amm.long_spread;
    let amm_short_spread = amm_quoter.amm.short_spread;

    // ---- 2. Per-fill validate / event metadata. ----
    let taker_base_unfilled = taker.orders[taker_order_index]
        .get_base_asset_amount_unfilled(Some(taker_existing_position_before))?;
    let taker_price_for_match: Option<u64>;
    let match_maker_price: Option<u64>;
    let maker_existing_position_params: Option<(u64, u64)>;
    match method {
        PerpFulfillmentMethod::AMM(_) => {
            taker_price_for_match = None;
            match_maker_price = None;
            maker_existing_position_params = None;
        }
        PerpFulfillmentMethod::Match(_, m_idx, maker_price) => {
            let m_idx = m_idx as usize;
            let maker_ref = maker
                .as_deref()
                .ok_or_else(print_error!(ErrorCode::DefaultError))?;
            if !are_orders_same_market_but_different_sides(
                &maker_ref.orders[m_idx],
                &taker.orders[taker_order_index],
            ) {
                return Ok((0, 0, 0));
            }
            // Taker's price ceiling for the matcher + per-fill validate:
            // explicit limit, or the auction fallback for market orders.
            let taker_price = match taker_limit_price {
                Some(p) => p,
                None => {
                    // Reborrow `amm_quoter.amm` immutably to read AMM-side
                    // fields without dropping the quoter (it still owns the
                    // &mut for the matcher below). `market.market_stats` is
                    // a disjoint PerpMarket field.
                    let amm_ref: &crate::amm::AMM = amm_quoter.amm;
                    let amm_available = calculate_amm_available_liquidity(
                        amm_ref,
                        &taker_direction,
                        order_step_size,
                    )?;
                    let min_order_size = market.market_stats.min_order_size;
                    amm_ref.get_fallback_price(
                        &market.market_stats,
                        &taker_direction,
                        amm_available,
                        oracle_price,
                        taker.orders[taker_order_index].seconds_til_expiry(now),
                        min_order_size,
                    )?
                }
            };
            let maker_direction = maker_ref.orders[m_idx].direction;
            let maker_position = maker_ref.get_perp_position(market_index)?;
            taker_price_for_match = Some(taker_price);
            match_maker_price = Some(maker_price);
            maker_existing_position_params =
                maker_position.get_existing_position_params_for_order_action(maker_direction);
        }
    }

    let target_size = taker_base_unfilled;
    if target_size == 0 {
        return Ok((0, 0, 0));
    }

    // ---- 3. Mark-TWAP update. ----
    // Market-level mutation, kept out of the quoter constructors. Trade-
    // price hint: the AMM's natural ask/bid for AMM-only steps; the maker
    // price for Match steps. `update_mark_twap_with_amm_bid_ask` takes the
    // AMM inputs as scalars — no `&AMM` borrow — so this call is shaped
    // for the target architecture where the AMM is an isolated module:
    // bid/ask/base-spread come back through the AMM's contract methods
    // rather than from reaching into its struct.
    let twap_trade_price = match_maker_price.unwrap_or(match taker_direction {
        PositionDirection::Long => amm_ask_price,
        PositionDirection::Short => amm_bid_price,
    });
    market.market_stats.update_mark_twap_with_amm_bid_ask(
        amm_bid_price,
        amm_ask_price,
        amm_base_spread,
        amm_long_spread,
        amm_short_spread,
        now,
        Some(twap_trade_price),
        Some(taker_direction),
        sanitize_clamp_denom,
        order_tick_size,
    )?;

    // ---- 4. Build QuoteContext for the matcher. AMM-projection fields
    // not needed here — setup has already run on amm_quoter.
    let stats_snapshot = market.market_stats;
    let oracle_stub = OraclePriceData::default();
    let ctx = QuoteContext {
        stats: &stats_snapshot,
        oracle: &oracle_stub,
        mm_oracle: None,
        oracle_validity: None,
        fee_budget: 0,
        tick: order_tick_size,
        step_size: order_step_size,
        slot,
        base_precision: BASE_PRECISION_U64,
        market_status: MarketStatus::default(),
        market_config: 0,
    };

    // ---- 5. Build quoters + match_take. ----
    let match_result = match method {
        PerpFulfillmentMethod::AMM(override_fill_price) => {
            // Effective price ceiling for the AMM: the order's limit
            // (buffered by maker rebate if post_only), `min`-ed with any
            // override price from the FFM payload, stepped one tick inside
            // the limit. Computed at the orchestrator — the AMM Quoter
            // itself is taker-agnostic.
            let fee_tier = determine_user_fee_tier(taker_stats, fee_structure, &MarketType::Perp)?;
            let effective_taker_limit = crate::math::orders::calculate_effective_amm_taker_limit(
                &taker.orders[taker_order_index],
                taker_limit_price,
                override_fill_price,
                &fee_tier,
                market.fee_adjustment,
                market.order_tick_size,
            )?;
            // Reuse the `amm_quoter` constructed at the top of this fn —
            // it's already been setup and holds &mut market.amm. The AMM is
            // the sole continuous maker, so it takes the dedicated analytical
            // fill path rather than the discrete level walk.
            amm_quoter.validate_for_fill(taker_direction)?;
            crate::controller::matching::fill_amm_only(
                &mut amm_quoter,
                &ctx,
                taker_direction,
                target_size,
                effective_taker_limit,
            )?
        }
        PerpFulfillmentMethod::Match(_, m_idx, maker_price) => {
            // Release the AMM-only quoter so `AmmJitQuoter::from_match_context`
            // can take `&mut market` (`amm_quoter` holds `&mut market.amm`).
            // The AMM has already been refreshed by `amm_quoter`'s setup; the
            // JIT quoter doesn't re-refresh. Discarding the binding ends the
            // borrow scope (no `Drop` impl to run).
            let _ = amm_quoter;
            let m_idx = m_idx as usize;
            let maker_user = maker
                .as_deref_mut()
                .ok_or_else(print_error!(ErrorCode::DefaultError))?;
            let maker_unfilled = maker_user.orders[m_idx].get_base_asset_amount_unfilled(Some(
                maker_user
                    .get_perp_position(market_index)?
                    .base_asset_amount,
            ))?;
            let taker_has_limit_price = taker.orders[taker_order_index].has_limit_price(slot)?;
            let mut amm_jit = crate::amm::AmmJitQuoter::from_match_context(
                market,
                maker_price,
                taker_direction,
                valid_oracle_price,
                target_size,
                maker_unfilled,
                taker_has_limit_price,
            )?;
            let mut dlob = DlobOrderQuoter::new(&mut maker_user.orders[m_idx]);
            let mut quoters: Vec<&mut dyn QuoterCommit> = vec![&mut amm_jit, &mut dlob];
            crate::controller::matching::match_take(
                &mut quoters,
                &ctx,
                taker_direction,
                target_size,
                taker_price_for_match,
            )?
        }
    };

    if match_result.total_base_filled == 0 {
        return Ok((0, 0, 0));
    }

    // An AmmHouse fill emitted from a Match step is always a JIT slice
    // (the only AMM-side quoter present in a Match step is `AmmJitQuoter`),
    // so we map the explanation off the method alone.
    let is_jit_within_match = matches!(method, PerpFulfillmentMethod::Match(..));

    // ---- 7. Per-fill dispatch. ----
    let mut total_base_filled = 0u64;
    let mut total_quote_filled = 0u64;
    let mut maker_base_filled = 0u64;

    for (_quoter_id, fill) in match_result.fills.iter() {
        if fill.base_filled == 0 {
            continue;
        }
        match fill.fee_policy {
            FillFeePolicy::AmmHouse => {
                let (base_filled, quote_filled) = settle_amm_house_fill(
                    fill,
                    market,
                    taker,
                    taker_stats,
                    taker_position_index,
                    taker_order_index,
                    taker_key,
                    taker_direction,
                    taker_existing_position_params_before,
                    order_post_only,
                    order_slot,
                    order_id,
                    taker_limit_price,
                    is_jit_within_match,
                    is_liquidation,
                    maker,
                    maker_stats,
                    filler,
                    filler_stats,
                    filler_key,
                    referrer,
                    referrer_stats,
                    rev_share_escrow,
                    builder_referral_feature_enabled,
                    fee_structure,
                    oracle_map,
                    now,
                    slot,
                )?;
                total_base_filled = total_base_filled.safe_add(base_filled)?;
                total_quote_filled = total_quote_filled.safe_add(quote_filled)?;
            }
            FillFeePolicy::DlobMatch => {
                let (base_filled, quote_filled, maker_filled) = settle_dlob_match_fill(
                    fill,
                    market,
                    taker,
                    taker_stats,
                    taker_position_index,
                    taker_order_index,
                    taker_key,
                    taker_direction,
                    taker_existing_position_params_before,
                    maker,
                    maker_stats,
                    maker_order_index,
                    maker_key_opt,
                    maker_existing_position_params,
                    match_maker_price,
                    taker_price_for_match,
                    oracle_price,
                    filler,
                    filler_stats,
                    filler_key,
                    referrer,
                    referrer_stats,
                    rev_share_escrow,
                    builder_referral_feature_enabled,
                    fee_structure,
                    oracle_map,
                    is_liquidation,
                    now,
                    slot,
                )?;
                total_base_filled = total_base_filled.safe_add(base_filled)?;
                total_quote_filled = total_quote_filled.safe_add(quote_filled)?;
                maker_base_filled = maker_base_filled.safe_add(maker_filled)?;
            }
        }
    }

    if total_base_filled == 0 {
        return Ok((0, 0, 0));
    }

    // ---- 9. Finalize open-orders counters once-per-order. ----
    if taker.orders[taker_order_index].get_base_asset_amount_unfilled(None)? == 0 {
        taker.decrement_open_orders(taker.orders[taker_order_index].has_auction());
        taker.perp_positions[taker_position_index].open_orders -= 1;
    }

    if maker_base_filled > 0 {
        if let Some(m_idx) = maker_order_index {
            if let Some(maker_user) = maker.as_deref_mut() {
                let maker_position_index =
                    get_position_index(&maker_user.perp_positions, market.market_index)?;
                if maker_user.orders[m_idx].get_base_asset_amount_unfilled(None)? == 0 {
                    maker_user.decrement_open_orders(maker_user.orders[m_idx].has_auction());
                    maker_user.perp_positions[maker_position_index].open_orders -= 1;
                }
            }
        }
    }

    Ok((total_base_filled, total_quote_filled, maker_base_filled))
}

pub fn update_order_after_fill(
    order: &mut Order,
    base_asset_amount: u64,
    quote_asset_amount: u64,
) -> DriftResult<bool> {
    order.base_asset_amount_filled = order.base_asset_amount_filled.safe_add(base_asset_amount)?;

    order.quote_asset_amount_filled = order
        .quote_asset_amount_filled
        .safe_add(quote_asset_amount)?;

    let is_filled = order.get_base_asset_amount_unfilled(None)? == 0;
    if is_filled {
        order.status = OrderStatus::Filled;
    }

    Ok(is_filled)
}

#[allow(clippy::type_complexity)]
fn get_taker_and_maker_for_order_record(
    user_key: &Pubkey,
    user_order: &Order,
) -> (Option<Pubkey>, Option<Order>, Option<Pubkey>, Option<Order>) {
    if user_order.post_only {
        (None, None, Some(*user_key), Some(*user_order))
    } else {
        (Some(*user_key), Some(*user_order), None, None)
    }
}

fn cancel_reduce_only_trigger_orders(
    user: &mut User,
    user_key: &Pubkey,
    filler_key: Option<&Pubkey>,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    now: i64,
    slot: u64,
    perp_market_index: u16,
) -> DriftResult {
    for order_index in 0..user.orders.len() {
        if user.orders[order_index].status != OrderStatus::Open {
            continue;
        }

        if user.orders[order_index].market_type != MarketType::Perp {
            continue;
        }

        if user.orders[order_index].market_index != perp_market_index {
            continue;
        }

        if !user.orders[order_index].must_be_triggered() || user.orders[order_index].triggered() {
            continue;
        }

        if !user.orders[order_index].reduce_only {
            continue;
        }

        cancel_order(
            order_index,
            user,
            user_key,
            perp_market_map,
            spot_market_map,
            oracle_map,
            now,
            slot,
            OrderActionExplanation::ReduceOnlyOrderIncreasedPosition,
            filler_key,
            0,
            false,
        )?;
    }

    Ok(())
}

pub fn trigger_order(
    order_id: u32,
    state: &State,
    user: &AccountLoader<User>,
    spot_market_map: &SpotMarketMap,
    perp_market_map: &PerpMarketMap,
    oracle_map: &mut OracleMap,
    filler: &AccountLoader<User>,
    clock: &Clock,
) -> DriftResult {
    let now = clock.unix_timestamp;
    let slot = clock.slot;

    let filler_key = filler.key();
    let user_key = user.key();
    let user = &mut load_mut!(user)?;

    let order_index = user
        .orders
        .iter()
        .position(|order| order.order_id == order_id && order.status == OrderStatus::Open)
        .ok_or_else(print_error!(ErrorCode::OrderDoesNotExist))?;

    let (order_status, market_index, market_type) =
        get_struct_values!(user.orders[order_index], status, market_index, market_type);

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

    if user.orders[order_index].triggered() {
        msg!("Order is already triggered");
        return Ok(());
    }

    validate!(
        market_type == MarketType::Perp,
        ErrorCode::InvalidOrderMarketType,
        "Order must be a perp order"
    )?;

    validate_user_not_being_liquidated(
        user,
        perp_market_map,
        spot_market_map,
        oracle_map,
        state.liquidation_margin_buffer_ratio,
    )?;

    validate!(!user.is_bankrupt(), ErrorCode::UserBankrupt)?;

    let mut perp_market = perp_market_map.get_ref_mut(&market_index)?;
    let (oracle_price_data, oracle_validity) = oracle_map.get_price_data_and_validity(
        MarketType::Perp,
        perp_market.market_index,
        &perp_market.oracle_id(),
        perp_market
            .market_stats
            .historical_oracle_data
            .last_oracle_price_twap,
        perp_market.get_max_confidence_interval_multiplier()?,
        perp_market.oracle_slot_delay_override,
        perp_market.oracle_low_risk_slot_delay_override,
        None,
    )?;

    let is_oracle_valid =
        is_oracle_valid_for_action(oracle_validity, Some(DriftAction::TriggerOrder))?;

    validate!(is_oracle_valid, ErrorCode::InvalidOracle)?;

    let oracle_price = oracle_price_data.price;

    let oracle_too_divergent_with_twap_5min = is_oracle_too_divergent_with_twap_5min(
        oracle_price_data.price,
        perp_market
            .market_stats
            .historical_oracle_data
            .last_oracle_price_twap_5min,
        state
            .oracle_guard_rails
            .max_oracle_twap_5min_percent_divergence()
            .cast()?,
    )?;

    validate!(
        !oracle_too_divergent_with_twap_5min,
        ErrorCode::OrderBreachesOraclePriceLimits,
        "oracle price vs twap too divergent"
    )?;

    let trigger_price =
        perp_market.get_trigger_price(oracle_price, now, state.use_median_trigger_price())?;
    let can_trigger = order_satisfies_trigger_condition(&user.orders[order_index], trigger_price)?;

    validate!(
        can_trigger,
        ErrorCode::OrderDidNotSatisfyTriggerCondition,
        "Order did not satisfy trigger condition. trigger_price: {} oracle_price: {} trigger_condition: {:?}",
        trigger_price,
        &user.orders[order_index].trigger_price,
        &user.orders[order_index].trigger_condition
    )?;

    let (_, worst_case_liability_value_before) = user
        .get_perp_position(market_index)?
        .worst_case_liability_value(oracle_price)?;

    let mut bit_flags = 0;
    {
        // Trigger-order auction params quote off the AMM's cached spread
        // state (refreshed by the keeper crank / fill setup for this slot).
        update_trigger_order_params(
            &mut user.orders[order_index],
            oracle_price_data,
            slot,
            20,
            Some(&perp_market),
        )?;

        if user.orders[order_index].has_auction() {
            user.increment_open_auctions();
        }

        let direction = user.orders[order_index].direction;
        let base_asset_amount = user.orders[order_index].base_asset_amount;
        let update_open_bids_and_asks = user.orders[order_index].update_open_bids_and_asks();

        let user_position = user.get_perp_position_mut(market_index)?;
        increase_open_bids_and_asks(
            user_position,
            &direction,
            base_asset_amount,
            update_open_bids_and_asks,
        )?;
        if user_position.is_isolated() {
            bit_flags = set_order_bit_flag(bit_flags, true, OrderBitFlag::IsIsolatedPosition);
        }
    }

    let is_filler_taker = user_key == filler_key;
    let mut filler = if !is_filler_taker {
        Some(load_mut!(filler)?)
    } else {
        None
    };

    let filler_reward = pay_keeper_flat_reward_for_perps(
        user,
        filler.as_deref_mut(),
        &mut perp_market,
        state.perp_fee_structure.flat_filler_fee,
        slot,
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
        Some(filler_reward),
        None,
        None,
        None,
        None,
        Some(user_key),
        Some(user.orders[order_index]),
        None,
        None,
        oracle_price,
        bit_flags,
        None,
        None,
        None,
        None,
        Some(trigger_price),
        None,
        None,
    )?;
    emit!(order_action_record);

    let (_, worst_case_liability_value_after) = user
        .get_perp_position(market_index)?
        .worst_case_liability_value(oracle_price)?;

    let is_risk_increasing = worst_case_liability_value_after > worst_case_liability_value_before;

    drop(perp_market);

    // If order increases risk and user is below initial margin, cancel it
    if is_risk_increasing && !user.orders[order_index].reduce_only {
        let meets_initial_margin_requirement =
            meets_initial_margin_requirement(user, perp_market_map, spot_market_map, oracle_map)?;

        if !meets_initial_margin_requirement {
            cancel_order(
                order_index,
                user,
                &user_key,
                perp_market_map,
                spot_market_map,
                oracle_map,
                now,
                slot,
                OrderActionExplanation::InsufficientFreeCollateral,
                Some(&filler_key),
                0,
                false,
            )?;
        }
    }

    user.update_last_active_slot(slot);

    Ok(())
}

fn update_trigger_order_params(
    order: &mut Order,
    oracle_price_data: &OraclePriceData,
    slot: u64,
    min_auction_duration: u8,
    perp_market: Option<&PerpMarket>,
) -> DriftResult {
    order.trigger_condition = match order.trigger_condition {
        OrderTriggerCondition::Above => OrderTriggerCondition::TriggeredAbove,
        OrderTriggerCondition::Below => OrderTriggerCondition::TriggeredBelow,
        _ => {
            return Err(print_error!(ErrorCode::InvalidTriggerOrderCondition)());
        }
    };

    if slot.saturating_sub(order.slot) > 150 && order.reduce_only {
        order.add_bit_flag(OrderBitFlag::SafeTriggerOrder);
    }

    order.slot = slot;

    let (auction_duration, auction_start_price, auction_end_price) =
        calculate_auction_params_for_trigger_order(
            order,
            oracle_price_data,
            min_auction_duration,
            perp_market,
        )?;

    msg!(
        "new auction duration {} start price {} end price {}",
        auction_duration,
        auction_start_price,
        auction_end_price
    );

    order.auction_duration = auction_duration;
    order.auction_start_price = auction_start_price;
    order.auction_end_price = auction_end_price;

    if matches!(order.order_type, OrderType::TriggerMarket) {
        order.add_bit_flag(OrderBitFlag::OracleTriggerMarket);
    }

    Ok(())
}

pub fn force_cancel_orders(
    state: &State,
    user_account_loader: &AccountLoader<User>,
    spot_market_map: &SpotMarketMap,
    perp_market_map: &PerpMarketMap,
    oracle_map: &mut OracleMap,
    filler: &AccountLoader<User>,
    clock: &Clock,
) -> DriftResult {
    let now = clock.unix_timestamp;
    let slot = clock.slot;

    let filler_key = filler.key();
    let user_key = user_account_loader.key();
    let user = &mut load_mut!(user_account_loader)?;
    let filler = &mut load_mut!(filler)?;

    validate!(
        !user.is_being_liquidated(),
        ErrorCode::UserIsBeingLiquidated
    )?;

    validate!(!user.is_bankrupt(), ErrorCode::UserBankrupt)?;

    let margin_calc = calculate_margin_requirement_and_total_collateral_and_liability_info(
        user,
        perp_market_map,
        spot_market_map,
        oracle_map,
        MarginContext::standard(MarginRequirementType::Initial),
    )?;

    let meets_initial_margin_requirement = margin_calc.meets_margin_requirement();

    validate!(
        !meets_initial_margin_requirement,
        ErrorCode::SufficientCollateral
    )?;

    let cross_margin_meets_initial_margin_requirement =
        margin_calc.meets_cross_margin_requirement();

    let mut total_fee = 0_u64;

    for order_index in 0..user.orders.len() {
        if user.orders[order_index].status != OrderStatus::Open {
            continue;
        }

        let market_index = user.orders[order_index].market_index;
        let market_type = user.orders[order_index].market_type;

        let fee = match market_type {
            MarketType::Spot => {
                let spot_market = spot_market_map.get_ref(&market_index)?;
                let token_amount = user
                    .get_spot_position(market_index)?
                    .get_signed_token_amount(&spot_market)?
                    .cast::<i64>()?;
                let is_position_reducing = is_order_position_reducing(
                    &user.orders[order_index].direction,
                    user.orders[order_index].get_base_asset_amount_unfilled(Some(token_amount))?,
                    token_amount,
                )?;
                if is_position_reducing {
                    continue;
                }

                if cross_margin_meets_initial_margin_requirement {
                    continue;
                }

                state.spot_fee_structure.flat_filler_fee
            }
            MarketType::Perp => {
                let base_asset_amount = user.get_perp_position(market_index)?.base_asset_amount;
                let is_position_reducing = is_order_position_reducing(
                    &user.orders[order_index].direction,
                    user.orders[order_index]
                        .get_base_asset_amount_unfilled(Some(base_asset_amount))?,
                    base_asset_amount,
                )?;
                if is_position_reducing {
                    continue;
                }

                if !user.get_perp_position(market_index)?.is_isolated() {
                    if cross_margin_meets_initial_margin_requirement {
                        continue;
                    }
                } else {
                    let meets_isolated_margin_requirement =
                        margin_calc.meets_isolated_margin_requirement(market_index)?;
                    if meets_isolated_margin_requirement {
                        continue;
                    }
                }

                state.perp_fee_structure.flat_filler_fee
            }
        };

        total_fee = total_fee.safe_add(fee)?;

        cancel_order(
            order_index,
            user,
            &user_key,
            perp_market_map,
            spot_market_map,
            oracle_map,
            now,
            slot,
            OrderActionExplanation::InsufficientFreeCollateral,
            Some(&filler_key),
            fee,
            false,
        )?;
    }

    pay_keeper_flat_reward_for_spot(
        user,
        Some(filler),
        spot_market_map.get_quote_spot_market_mut()?.deref_mut(),
        total_fee,
        slot,
    )?;

    user.update_last_active_slot(slot);

    Ok(())
}

pub fn can_reward_user_with_perp_pnl(user: &mut Option<&mut User>, market_index: u16) -> bool {
    match user.as_mut() {
        Some(user) => user.force_get_perp_position_mut(market_index).is_ok(),
        None => false,
    }
}

pub fn can_reward_user_with_referral_reward(
    user: &mut Option<&mut User>,
    market_index: u16,
    rev_share_escrow: &mut Option<&mut RevenueShareEscrowZeroCopyMut>,
    builder_referral_feature_enabled: bool,
) -> bool {
    if builder_referral_feature_enabled {
        if let Some(escrow) = rev_share_escrow {
            return escrow.find_or_create_referral_index(market_index).is_some();
        }
        false
    } else {
        can_reward_user_with_perp_pnl(user, market_index)
    }
}

pub fn pay_keeper_flat_reward_for_perps(
    user: &mut User,
    filler: Option<&mut User>,
    market: &mut PerpMarket,
    filler_reward: u64,
    slot: u64,
) -> DriftResult<u64> {
    let filler_reward = if let Some(filler) = filler {
        let user_position = user.get_perp_position_mut(market.market_index)?;
        controller::position::update_quote_asset_and_break_even_amount(
            user_position,
            market,
            -filler_reward.cast()?,
        )?;

        filler.update_last_active_slot(slot);
        // Dont throw error if filler doesnt have position available
        let filler_position = match filler.force_get_perp_position_mut(market.market_index) {
            Ok(position) => position,
            Err(_) => return Ok(0),
        };
        controller::position::update_quote_asset_amount(
            filler_position,
            market,
            filler_reward.cast()?,
        )?;

        filler_reward
    } else {
        0
    };

    Ok(filler_reward)
}

pub fn pay_keeper_flat_reward_for_spot(
    user: &mut User,
    filler: Option<&mut User>,
    quote_market: &mut SpotMarket,
    filler_reward: u64,
    slot: u64,
) -> DriftResult<u64> {
    let filler_reward = if let Some(filler) = filler {
        update_spot_balances(
            filler_reward as u128,
            &SpotBalanceType::Deposit,
            quote_market,
            filler.get_quote_spot_position_mut(),
            false,
        )?;

        filler.update_last_active_slot(slot);

        filler.update_cumulative_spot_fees(filler_reward.cast()?)?;

        update_spot_balances(
            filler_reward as u128,
            &SpotBalanceType::Borrow,
            quote_market,
            user.get_quote_spot_position_mut(),
            false,
        )?;

        user.update_cumulative_spot_fees(-filler_reward.cast()?)?;

        filler_reward
    } else {
        0
    };

    Ok(filler_reward)
}

pub fn expire_orders(
    user: &mut User,
    user_key: &Pubkey,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    now: i64,
    slot: u64,
) -> DriftResult {
    for order_index in 0..user.orders.len() {
        if !should_expire_order(user, order_index, now)? {
            continue;
        }

        cancel_order(
            order_index,
            user,
            user_key,
            perp_market_map,
            spot_market_map,
            oracle_map,
            now,
            slot,
            OrderActionExplanation::OrderExpired,
            None,
            0,
            false,
        )?;
    }

    Ok(())
}
