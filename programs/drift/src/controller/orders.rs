use std::cell::RefMut;
use std::collections::BTreeMap;
use std::ops::DerefMut;
use std::u64;

use anchor_lang::prelude::*;
use solana_program::msg;

use crate::controller;
use crate::controller::funding::settle_funding_payment;
use crate::controller::lp::burn_lp_shares;
use crate::controller::position;
use crate::controller::position::{
    add_new_position, decrease_open_bids_and_asks, get_position_index, increase_open_bids_and_asks,
    update_lp_market_position, update_position_and_market, update_quote_asset_amount,
    PositionDirection,
};
use crate::controller::spot_balance::{
    update_spot_balances, update_spot_market_cumulative_interest,
};
use crate::controller::spot_position::{
    decrease_spot_open_bids_and_asks, increase_spot_open_bids_and_asks,
    update_spot_balances_and_cumulative_deposits,
};
use crate::error::DriftResult;
use crate::error::ErrorCode;
use crate::get_struct_values;
use crate::get_then_update_id;
use crate::load_mut;
use crate::math::amm_jit::calculate_amm_jit_liquidity;
use crate::math::auction::{calculate_auction_params_for_trigger_order, calculate_auction_prices};
use crate::math::casting::Cast;
use crate::math::constants::{
    BASE_PRECISION_U64, FIVE_MINUTE, ONE_HOUR, PERP_DECIMALS, QUOTE_SPOT_MARKET_INDEX,
};
use crate::math::fees::{determine_user_fee_tier, ExternalFillFees, FillFees};
use crate::math::fulfillment::{
    determine_perp_fulfillment_methods, determine_spot_fulfillment_methods,
};
use crate::math::liquidation::validate_user_not_being_liquidated;
use crate::math::matching::{
    are_orders_same_market_but_different_sides, calculate_fill_for_matched_orders,
    calculate_filler_multiplier_for_matched_orders, do_orders_cross, is_maker_for_taker,
};
use crate::math::oracle;
use crate::math::oracle::{is_oracle_valid_for_action, DriftAction, OracleValidity};
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::{get_signed_token_amount, get_token_amount};
use crate::math::stats::calculate_new_twap;
use crate::math::{amm, fees, margin::*, orders::*};
use crate::state::order_params::{
    ModifyOrderParams, ModifyOrderPolicy, OrderParams, PlaceOrderOptions, PostOnlyParam,
};

use crate::math::amm::calculate_amm_available_liquidity;
use crate::math::lp::calculate_lp_shares_to_burn_for_risk_reduction;
use crate::math::safe_unwrap::SafeUnwrap;
use crate::math::spot_swap::select_margin_type_for_swap;
use crate::print_error;
use crate::state::events::{
    emit_stack, get_order_action_record, LPAction, LPRecord, OrderActionRecord, OrderRecord,
};
use crate::state::events::{OrderAction, OrderActionExplanation};
use crate::state::fill_mode::FillMode;
use crate::state::fulfillment::{PerpFulfillmentMethod, SpotFulfillmentMethod};
use crate::state::margin_calculation::{MarginCalculation, MarginContext};
use crate::state::oracle::{OraclePriceData, StrictOraclePrice};
use crate::state::oracle_map::OracleMap;
use crate::state::paused_operations::PerpOperation;
use crate::state::perp_market::{AMMLiquiditySplit, MarketStatus, PerpMarket};
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_fulfillment_params::{ExternalSpotFill, SpotFulfillmentParams};
use crate::state::spot_market::{SpotBalanceType, SpotMarket};
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::state::FeeStructure;
use crate::state::state::*;
use crate::state::traits::Size;
use crate::state::user::{
    AssetType, Order, OrderStatus, OrderTriggerCondition, OrderType, UserStats,
};
use crate::state::user::{MarketType, User};
use crate::state::user_map::{UserMap, UserStatsMap};
use crate::validate;
use crate::validation;
use crate::validation::order::{
    validate_order, validate_order_for_force_reduce_only, validate_spot_order,
};

#[cfg(test)]
mod tests;

#[cfg(test)]
mod amm_jit_tests;
#[cfg(test)]
mod amm_lp_jit_tests;

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
) -> DriftResult {
    let now = clock.unix_timestamp;
    let slot = clock.slot;

    validate_user_not_being_liquidated(
        user,
        perp_market_map,
        spot_market_map,
        oracle_map,
        state.liquidation_margin_buffer_ratio,
    )?;

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
    let market = &perp_market_map.get_ref(&market_index)?;
    let force_reduce_only = market.is_reduce_only()?;

    validate!(
        !matches!(market.status, MarketStatus::Initialized),
        ErrorCode::MarketBeingInitialized,
        "Market is being initialized"
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
            params.base_asset_amount >= market.amm.order_step_size,
            ErrorCode::OrderAmountTooSmall,
            "params.base_asset_amount={} cannot be below market.amm.order_step_size={}",
            params.base_asset_amount,
            market.amm.order_step_size
        )?;

        let base_asset_amount = if params.base_asset_amount == u64::MAX {
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
            standardize_base_asset_amount(params.base_asset_amount, market.amm.order_step_size)?
        };

        let market_position = &user.perp_positions[position_index];
        let existing_position_direction = if market_position.base_asset_amount >= 0 {
            PositionDirection::Long
        } else {
            PositionDirection::Short
        };
        (existing_position_direction, base_asset_amount)
    };

    let oracle_price_data = oracle_map.get_price_data(&market.amm.oracle)?;

    // updates auction params for crossing limit orders w/out auction duration
    params.update_perp_auction_params(market, oracle_price_data.price)?;

    let (auction_start_price, auction_end_price, auction_duration) = get_auction_params(
        &params,
        oracle_price_data,
        market.amm.order_tick_size,
        state.min_perp_auction_duration,
    )?;

    let max_ts = match params.max_ts {
        Some(max_ts) => max_ts,
        None => match params.order_type {
            OrderType::Market | OrderType::Oracle => {
                now.safe_add(30_i64.max((auction_duration / 2) as i64))?
            }
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

    let new_order = Order {
        status: OrderStatus::Open,
        order_type: params.order_type,
        market_type: params.market_type,
        slot,
        order_id: get_then_update_id!(user, next_order_id),
        user_order_id: params.user_order_id,
        market_index: params.market_index,
        price: get_price_for_perp_order(
            params.price,
            params.direction,
            params.post_only,
            &market.amm,
        )?,
        existing_position_direction,
        base_asset_amount: order_base_asset_amount,
        base_asset_amount_filled: 0,
        quote_asset_amount_filled: 0,
        direction: params.direction,
        reduce_only: params.reduce_only || force_reduce_only,
        trigger_price: standardize_price(
            params.trigger_price.unwrap_or(0),
            market.amm.order_tick_size,
            params.direction,
        )?,
        trigger_condition: params.trigger_condition,
        post_only: params.post_only != PostOnlyParam::None,
        oracle_price_offset: params.oracle_price_offset.unwrap_or(0),
        immediate_or_cancel: params.immediate_or_cancel,
        auction_start_price,
        auction_end_price,
        auction_duration,
        max_ts,
        padding: [0; 3],
    };

    let valid_oracle_price = Some(oracle_map.get_price_data(&market.amm.oracle)?.price);
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
    if !new_order.must_be_triggered() {
        increase_open_bids_and_asks(
            &mut user.perp_positions[position_index],
            &params.direction,
            order_base_asset_amount,
        )?;
    }

    options.update_risk_increasing(risk_increasing);

    // when orders are placed in bulk, only need to check margin on last place
    if options.enforce_margin_check {
        meets_place_order_margin_requirement(
            user,
            perp_market_map,
            spot_market_map,
            oracle_map,
            options.risk_increasing,
        )?;
    }

    if force_reduce_only {
        validate_order_for_force_reduce_only(
            &user.orders[new_order_index],
            user.perp_positions[position_index].base_asset_amount,
        )?;
    }

    let max_oi = market.amm.max_open_interest;
    if max_oi != 0 && risk_increasing {
        let oi_plus_order = match params.direction {
            PositionDirection::Long => market
                .amm
                .base_asset_amount_long
                .safe_add(order_base_asset_amount.cast()?)?
                .unsigned_abs(),
            PositionDirection::Short => market
                .amm
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
        oracle_map.get_price_data(&market.amm.oracle)?.price,
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
) -> DriftResult<Vec<u32>> {
    let mut canceled_order_ids: Vec<u32> = vec![];
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

    let oracle = if is_perp_order {
        perp_market_map.get_ref(&order_market_index)?.amm.oracle
    } else {
        spot_market_map.get_ref(&order_market_index)?.oracle
    };

    if !skip_log {
        let (taker, taker_order, maker, maker_order) =
            get_taker_and_maker_for_order_record(user_key, &user.orders[order_index]);

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
            oracle_map.get_price_data(&oracle)?.price,
        )?;
        emit_stack::<_, { OrderActionRecord::SIZE }>(order_action_record)?;
    }

    user.decrement_open_orders(user.orders[order_index].has_auction());
    if is_perp_order {
        // Decrement open orders for existing position
        let position_index = get_position_index(&user.perp_positions, order_market_index)?;

        // only decrease open/bids ask if it's not a trigger order or if it's been triggered
        if !user.orders[order_index].must_be_triggered() || user.orders[order_index].triggered() {
            let base_asset_amount_unfilled =
                user.orders[order_index].get_base_asset_amount_unfilled(None)?;
            position::decrease_open_bids_and_asks(
                &mut user.perp_positions[position_index],
                &order_direction,
                base_asset_amount_unfilled.cast()?,
            )?;
        }

        user.perp_positions[position_index].open_orders -= 1;
        user.orders[order_index] = Order::default();
    } else {
        let spot_position_index = user.get_spot_position_index(order_market_index)?;

        // only decrease open/bids ask if it's not a trigger order or if it's been triggered
        if !user.orders[order_index].must_be_triggered() || user.orders[order_index].triggered() {
            let base_asset_amount_unfilled =
                user.orders[order_index].get_base_asset_amount_unfilled(None)?;
            decrease_spot_open_bids_and_asks(
                &mut user.spot_positions[spot_position_index],
                &order_direction,
                base_asset_amount_unfilled,
            )?;
        }
        user.spot_positions[spot_position_index].open_orders -= 1;
        user.orders[order_index] = Order::default();
    }

    Ok(())
}

pub enum ModifyOrderId {
    UserOrderId(u8),
    OrderId(u32),
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
                    if modify_order_params.policy == Some(ModifyOrderPolicy::MustModify) {
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
                if modify_order_params.policy == Some(ModifyOrderPolicy::MustModify) {
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

    if order_params.market_type == MarketType::Perp {
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
        )?;
    } else {
        place_spot_order(
            state,
            &mut user,
            user_key,
            perp_market_map,
            spot_market_map,
            oracle_map,
            clock,
            order_params,
            PlaceOrderOptions::default(),
        )?;
    }

    Ok(())
}

fn merge_modify_order_params_with_existing_order(
    existing_order: &Order,
    modify_order_params: &ModifyOrderParams,
) -> DriftResult<OrderParams> {
    let order_type = existing_order.order_type;
    let market_type = existing_order.market_type;
    let direction = modify_order_params
        .direction
        .unwrap_or(existing_order.direction);
    let user_order_id = existing_order.user_order_id;
    let base_asset_amount = modify_order_params
        .base_asset_amount
        .unwrap_or(existing_order.get_base_asset_amount_unfilled(None)?);
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
    let immediate_or_cancel = false;
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

    Ok(OrderParams {
        order_type,
        market_type,
        direction,
        user_order_id,
        base_asset_amount,
        price,
        market_index,
        reduce_only,
        post_only,
        immediate_or_cancel,
        max_ts,
        trigger_price,
        trigger_condition,
        oracle_price_offset,
        auction_duration,
        auction_start_price,
        auction_end_price,
    })
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
) -> DriftResult<u64> {
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

    let (order_status, market_index, order_market_type, order_direction) = get_struct_values!(
        user.orders[order_index],
        status,
        market_index,
        market_type,
        direction
    );

    validate!(
        order_market_type == MarketType::Perp,
        ErrorCode::InvalidOrderMarketType,
        "must be perp order"
    )?;

    // settle lp position so its tradeable
    let mut market = perp_market_map.get_ref_mut(&market_index)?;
    controller::lp::settle_funding_payment_then_lp(user, &user_key, &mut market, now)?;

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
        return Ok(0);
    }

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
            return Ok(0);
        }
    }

    let reserve_price_before: u64;
    let is_oracle_valid: bool;
    let oracle_validity: OracleValidity;
    let oracle_price: i64;
    let oracle_twap_5min: i64;
    let mut amm_is_available = !state.amm_paused()?;
    {
        let market = &mut perp_market_map.get_ref_mut(&market_index)?;
        amm_is_available &= !market.is_operation_paused(PerpOperation::AmmFill);
        amm_is_available &= !market.has_too_much_drawdown()?;
        validation::perp_market::validate_perp_market(market)?;
        validate!(
            !market.is_in_settlement(now),
            ErrorCode::MarketFillOrderPaused,
            "Market is in settlement mode",
        )?;

        let oracle_price_data = &oracle_map.get_price_data(&market.amm.oracle)?;
        oracle_validity = oracle::oracle_validity(
            market.amm.historical_oracle_data.last_oracle_price_twap,
            oracle_price_data,
            &state.oracle_guard_rails.validity,
        )?;

        is_oracle_valid =
            is_oracle_valid_for_action(oracle_validity, Some(DriftAction::FillOrderAmm))?;

        reserve_price_before = market.amm.reserve_price()?;
        oracle_price = oracle_price_data.price;
        oracle_twap_5min = market
            .amm
            .historical_oracle_data
            .last_oracle_price_twap_5min;
    }

    // allow oracle price to be used to calculate limit price if it's valid or stale for amm
    let valid_oracle_price = if is_oracle_valid || oracle_validity == OracleValidity::StaleForAMM {
        Some(oracle_price)
    } else {
        None
    };

    let is_filler_taker = user_key == filler_key;
    let is_filler_maker = makers_and_referrer.0.contains_key(&filler_key);
    let (mut filler, mut filler_stats) = if !is_filler_maker && !is_filler_taker {
        let filler = load_mut!(filler)?;
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

    let referrer_info = get_referrer_info(
        user_stats,
        makers_and_referrer,
        makers_and_referrer_stats,
        slot,
    )?;

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
        return Ok(0);
    }

    validate_perp_fill_possible(state, user, order_index, slot, makers_and_referrer.0.len())?;

    let should_expire_order = should_expire_order_before_fill(user, order_index, now)?;

    let position_index =
        get_position_index(&user.perp_positions, user.orders[order_index].market_index)?;
    let existing_base_asset_amount = user.perp_positions[position_index].base_asset_amount;
    let should_cancel_reduce_only = should_cancel_reduce_only_order(
        &user.orders[order_index],
        existing_base_asset_amount,
        perp_market_map
            .get_ref_mut(&market_index)?
            .amm
            .order_step_size,
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

        return Ok(0);
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
        &state.perp_fee_structure,
        reserve_price_before,
        valid_oracle_price,
        now,
        slot,
        state.min_perp_auction_duration,
        amm_is_available,
        fill_mode,
    )?;

    if base_asset_amount != 0 {
        let fill_price =
            calculate_fill_price(quote_asset_amount, base_asset_amount, BASE_PRECISION_U64)?;

        validate_fill_price_within_price_bands(
            fill_price,
            order_direction,
            oracle_price,
            oracle_twap_5min,
            perp_market_map.get_ref(&market_index)?.margin_ratio_initial,
            state
                .oracle_guard_rails
                .max_oracle_twap_5min_percent_divergence(),
        )?;
    }

    let base_asset_amount_after = user.perp_positions[position_index].base_asset_amount;
    let should_cancel_reduce_only = should_cancel_reduce_only_order(
        &user.orders[order_index],
        base_asset_amount_after,
        perp_market_map
            .get_ref_mut(&market_index)?
            .amm
            .order_step_size,
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

    if base_asset_amount == 0 {
        return Ok(0);
    }

    {
        let market = perp_market_map.get_ref(&market_index)?;

        let open_interest = market.get_open_interest();
        let max_open_interest = market.amm.max_open_interest;

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

    Ok(base_asset_amount)
}

pub fn validate_market_within_price_band(
    market: &PerpMarket,
    state: &State,
    potentially_risk_increasing: bool,
    oracle_reserve_price_spread_pct_before: Option<i64>,
) -> DriftResult<bool> {
    let reserve_price_after = market.amm.reserve_price()?;

    let is_oracle_mark_too_divergent_before = if let Some(oracle_reserve_price_spread_pct_before) =
        oracle_reserve_price_spread_pct_before
    {
        amm::is_oracle_mark_too_divergent(
            oracle_reserve_price_spread_pct_before,
            &state.oracle_guard_rails.price_divergence,
        )?
    } else {
        false
    };

    let oracle_reserve_price_spread_pct_after =
        amm::calculate_oracle_twap_5min_mark_spread_pct(&market.amm, Some(reserve_price_after))?;

    let breach_increases = if let Some(oracle_reserve_price_spread_pct_before) =
        oracle_reserve_price_spread_pct_before
    {
        oracle_reserve_price_spread_pct_after.unsigned_abs()
            >= oracle_reserve_price_spread_pct_before.unsigned_abs()
    } else {
        false
    };

    let is_oracle_mark_too_divergent_after = amm::is_oracle_mark_too_divergent(
        oracle_reserve_price_spread_pct_after,
        &state.oracle_guard_rails.price_divergence,
    )?;

    // if oracle-mark divergence pushed outside limit, block order
    if is_oracle_mark_too_divergent_after && !is_oracle_mark_too_divergent_before {
        msg!("price pushed outside bounds: last_oracle_price_twap_5min={} vs mark_price={},(breach spread {})",
                market.amm.historical_oracle_data.last_oracle_price_twap_5min,
                reserve_price_after,
                oracle_reserve_price_spread_pct_after,
            );
        return Err(ErrorCode::PriceBandsBreached);
    }

    // if oracle-mark divergence outside limit and risk-increasing, block order
    if is_oracle_mark_too_divergent_after && breach_increases && potentially_risk_increasing {
        msg!("risk-increasing outside bounds: last_oracle_price_twap_5min={} vs mark_price={}, (breach spread {})",
                market.amm.historical_oracle_data.last_oracle_price_twap_5min,
                reserve_price_after,
                oracle_reserve_price_spread_pct_after,
            );

        return Err(ErrorCode::PriceBandsBreached);
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

        if maker.is_being_liquidated() || maker.is_bankrupt() {
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
            market.amm.order_tick_size,
        )?;

        if maker_order_price_and_indexes.is_empty() {
            continue;
        }

        maker.update_last_active_slot(slot);

        settle_funding_payment(&mut maker, maker_key, &mut market, now)?;

        let initial_margin_ratio = market.margin_ratio_initial;
        let step_size = market.amm.order_step_size;

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
        let mut referrer = load_mut!(referrer)?;
        if referrer.authority != referrer_authority_key {
            continue;
        }

        if referrer.sub_account_id == 0 {
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
    fee_structure: &FeeStructure,
    reserve_price_before: u64,
    valid_oracle_price: Option<i64>,
    now: i64,
    slot: u64,
    min_auction_duration: u8,
    amm_is_available: bool,
    fill_mode: FillMode,
) -> DriftResult<(u64, u64)> {
    let market_index = user.orders[user_order_index].market_index;

    let user_order_position_decreasing =
        determine_if_user_order_is_position_decreasing(user, market_index, user_order_index)?;

    let limit_price = fill_mode.get_limit_price(
        &user.orders[user_order_index],
        valid_oracle_price,
        slot,
        perp_market_map.get_ref(&market_index)?.amm.order_tick_size,
    )?;

    let fulfillment_methods = {
        let market = perp_market_map.get_ref(&market_index)?;
        let oracle_price = oracle_map.get_price_data(&market.amm.oracle)?.price;

        determine_perp_fulfillment_methods(
            &user.orders[user_order_index],
            maker_orders_info,
            &market.amm,
            reserve_price_before,
            Some(oracle_price),
            limit_price,
            amm_is_available,
            slot,
            min_auction_duration,
        )?
    };

    if fulfillment_methods.is_empty() {
        return Ok((0, 0));
    }

    let mut base_asset_amount = 0_u64;
    let mut quote_asset_amount = 0_u64;
    let mut maker_fills: BTreeMap<Pubkey, i64> = BTreeMap::new();
    let maker_direction = user.orders[user_order_index].direction.opposite();
    for fulfillment_method in fulfillment_methods.iter() {
        if user.orders[user_order_index].status != OrderStatus::Open {
            break;
        }
        let mut market = perp_market_map.get_ref_mut(&market_index)?;
        let user_order_direction = user.orders[user_order_index].direction;

        let (fill_base_asset_amount, fill_quote_asset_amount) = match fulfillment_method {
            PerpFulfillmentMethod::AMM(maker_price) => {
                let (mut referrer, mut referrer_stats) = get_referrer(
                    &referrer_info,
                    makers_and_referrer,
                    makers_and_referrer_stats,
                    None,
                )?;

                let (fill_base_asset_amount, fill_quote_asset_amount) =
                    fulfill_perp_order_with_amm(
                        user,
                        user_stats,
                        user_order_index,
                        market.deref_mut(),
                        oracle_map,
                        reserve_price_before,
                        now,
                        slot,
                        user_key,
                        filler_key,
                        filler,
                        filler_stats,
                        &mut referrer.as_deref_mut(),
                        &mut referrer_stats.as_deref_mut(),
                        fee_structure,
                        limit_price,
                        None,
                        *maker_price,
                        AMMLiquiditySplit::Shared,
                    )?;

                (fill_base_asset_amount, fill_quote_asset_amount)
            }
            PerpFulfillmentMethod::Match(maker_key, maker_order_index) => {
                let mut maker = makers_and_referrer.get_ref_mut(maker_key)?;
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

                let (fill_base_asset_amount, fill_quote_asset_amount, maker_fill_base_asset_amount) =
                    fulfill_perp_order_with_match(
                        market.deref_mut(),
                        user,
                        user_stats,
                        user_order_index,
                        user_key,
                        &mut maker,
                        &mut maker_stats.as_deref_mut(),
                        *maker_order_index as usize,
                        maker_key,
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
                        fee_structure,
                        oracle_map,
                    )?;

                if maker_fill_base_asset_amount != 0 {
                    update_maker_fills_map(
                        &mut maker_fills,
                        maker_key,
                        maker_direction,
                        maker_fill_base_asset_amount,
                    )?;
                }

                (fill_base_asset_amount, fill_quote_asset_amount)
            }
        };

        base_asset_amount = base_asset_amount.safe_add(fill_base_asset_amount)?;
        quote_asset_amount = quote_asset_amount.safe_add(fill_quote_asset_amount)?;
        market
            .amm
            .update_volume_24h(fill_quote_asset_amount, user_order_direction, now)?;
    }

    validate!(
        (base_asset_amount > 0) == (quote_asset_amount > 0),
        ErrorCode::DefaultError,
        "invalid fill base = {} quote = {}",
        base_asset_amount,
        quote_asset_amount
    )?;

    let total_maker_fill = maker_fills.values().sum::<i64>();

    validate!(
        total_maker_fill.unsigned_abs() <= base_asset_amount,
        ErrorCode::DefaultError,
        "invalid total maker fill {} total fill {}",
        total_maker_fill,
        base_asset_amount
    )?;

    let taker_margin_calculation =
        calculate_margin_requirement_and_total_collateral_and_liability_info(
            user,
            perp_market_map,
            spot_market_map,
            oracle_map,
            MarginContext::standard(if user_order_position_decreasing {
                MarginRequirementType::Maintenance
            } else {
                MarginRequirementType::Fill
            }),
        )?;

    if !taker_margin_calculation.meets_margin_requirement() {
        msg!(
            "taker breached fill requirements (margin requirement {}) (total_collateral {})",
            taker_margin_calculation.margin_requirement,
            taker_margin_calculation.total_collateral
        );
        return Err(ErrorCode::InsufficientCollateral);
    }

    for (maker_key, maker_base_asset_amount_filled) in maker_fills {
        let maker = makers_and_referrer.get_ref(&maker_key)?;

        let margin_type = select_margin_type_for_perp_maker(
            &maker,
            maker_base_asset_amount_filled,
            market_index,
        )?;

        let maker_margin_calculation =
            calculate_margin_requirement_and_total_collateral_and_liability_info(
                &maker,
                perp_market_map,
                spot_market_map,
                oracle_map,
                MarginContext::standard(margin_type),
            )?;

        if !maker_margin_calculation.meets_margin_requirement() {
            msg!(
                "maker ({}) breached fill requirements (margin requirement {}) (total_collateral {})",
                maker_key,
                maker_margin_calculation.margin_requirement,
                maker_margin_calculation.total_collateral
            );
            return Err(ErrorCode::InsufficientCollateral);
        }
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
    map: &mut BTreeMap<Pubkey, i64>,
    maker_key: &Pubkey,
    maker_direction: PositionDirection,
    fill: u64,
) -> DriftResult {
    let signed_fill = match maker_direction {
        PositionDirection::Long => fill.cast::<i64>()?,
        PositionDirection::Short => -fill.cast::<i64>()?,
    };

    if let Some(maker_filled) = map.get_mut(maker_key) {
        *maker_filled = maker_filled.safe_add(signed_fill)?;
    } else {
        map.insert(*maker_key, signed_fill);
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

pub fn fulfill_perp_order_with_amm(
    user: &mut User,
    user_stats: &mut UserStats,
    order_index: usize,
    market: &mut PerpMarket,
    oracle_map: &mut OracleMap,
    reserve_price_before: u64,
    now: i64,
    slot: u64,
    user_key: &Pubkey,
    filler_key: &Pubkey,
    filler: &mut Option<&mut User>,
    filler_stats: &mut Option<&mut UserStats>,
    referrer: &mut Option<&mut User>,
    referrer_stats: &mut Option<&mut UserStats>,
    fee_structure: &FeeStructure,
    limit_price: Option<u64>,
    override_base_asset_amount: Option<u64>,
    override_fill_price: Option<u64>,
    liquidity_split: AMMLiquiditySplit,
) -> DriftResult<(u64, u64)> {
    let position_index = get_position_index(&user.perp_positions, market.market_index)?;
    let existing_base_asset_amount = user.perp_positions[position_index].base_asset_amount;

    // Determine the base asset amount the market can fill
    let (base_asset_amount, limit_price, fill_price) = match override_base_asset_amount {
        Some(override_base_asset_amount) => {
            (override_base_asset_amount, limit_price, override_fill_price)
        }
        None => {
            let fee_tier = determine_user_fee_tier(user_stats, fee_structure, &MarketType::Perp)?;
            let (base_asset_amount, limit_price) = calculate_base_asset_amount_for_amm_to_fulfill(
                &user.orders[order_index],
                market,
                limit_price,
                override_fill_price,
                existing_base_asset_amount,
                fee_tier,
            )?;

            let fill_price = if user.orders[order_index].post_only {
                limit_price
            } else {
                None
            };

            (base_asset_amount, limit_price, fill_price)
        }
    };

    // if user position is less than min order size, step size is the threshold
    let amm_size_threshold =
        if existing_base_asset_amount.unsigned_abs() > market.amm.min_order_size {
            market.amm.min_order_size
        } else {
            market.amm.order_step_size
        };

    if base_asset_amount < amm_size_threshold {
        // if is an actual swap (and not amm jit order) then msg!
        if override_base_asset_amount.is_none() {
            msg!(
                "Amm cant fulfill order. market index {} base asset amount {} market.amm.min_order_size {}",
                market.market_index,
                base_asset_amount,
                market.amm.min_order_size
            );
        }
        return Ok((0, 0));
    }

    let (order_post_only, order_slot, order_direction) =
        get_struct_values!(user.orders[order_index], post_only, slot, direction);

    validation::perp_market::validate_amm_account_for_fill(&market.amm, order_direction)?;

    let market_side_price = match order_direction {
        PositionDirection::Long => market.amm.ask_price(reserve_price_before)?,
        PositionDirection::Short => market.amm.bid_price(reserve_price_before)?,
    };

    let sanitize_clamp_denominator = market.get_sanitize_clamp_denominator()?;
    amm::update_mark_twap_from_estimates(
        &mut market.amm,
        now,
        Some(market_side_price),
        Some(order_direction),
        sanitize_clamp_denominator,
    )?;

    let (quote_asset_amount, quote_asset_amount_surplus, _) =
        controller::position::update_position_with_base_asset_amount(
            base_asset_amount,
            order_direction,
            market,
            user,
            position_index,
            fill_price,
        )?;

    if let Some(limit_price) = limit_price {
        validate_fill_price(
            quote_asset_amount,
            base_asset_amount,
            BASE_PRECISION_U64,
            order_direction,
            limit_price,
            !order_post_only,
        )?;
    }

    let reward_referrer = can_reward_user_with_perp_pnl(referrer, market.market_index);
    let reward_filler = can_reward_user_with_perp_pnl(filler, market.market_index);

    let FillFees {
        user_fee,
        fee_to_market,
        filler_reward,
        referee_discount,
        referrer_reward,
        fee_to_market_for_lp,
        maker_rebate,
    } = fees::calculate_fee_for_fulfillment_with_amm(
        user_stats,
        quote_asset_amount,
        fee_structure,
        order_slot,
        slot,
        reward_filler,
        reward_referrer,
        referrer_stats,
        quote_asset_amount_surplus,
        order_post_only,
        market.fee_adjustment,
    )?;

    let user_position_delta =
        get_position_delta_for_fill(base_asset_amount, quote_asset_amount, order_direction)?;

    if liquidity_split != AMMLiquiditySplit::ProtocolOwned {
        update_lp_market_position(
            market,
            &user_position_delta,
            fee_to_market_for_lp.cast()?,
            liquidity_split,
        )?;
    }

    if market.amm.user_lp_shares > 0 {
        let (new_terminal_quote_reserve, new_terminal_base_reserve) =
            crate::math::amm::calculate_terminal_reserves(&market.amm)?;
        market.amm.terminal_quote_asset_reserve = new_terminal_quote_reserve;

        let (min_base_asset_reserve, max_base_asset_reserve) =
            crate::math::amm::calculate_bid_ask_bounds(
                market.amm.concentration_coef,
                new_terminal_base_reserve,
            )?;
        market.amm.min_base_asset_reserve = min_base_asset_reserve;
        market.amm.max_base_asset_reserve = max_base_asset_reserve;
    }

    // Increment the protocol's total fee variables
    market.amm.total_fee = market.amm.total_fee.safe_add(fee_to_market.cast()?)?;
    market.amm.total_exchange_fee = market.amm.total_exchange_fee.safe_add(user_fee.cast()?)?;
    market.amm.total_mm_fee = market
        .amm
        .total_mm_fee
        .safe_add(quote_asset_amount_surplus.cast()?)?;
    market.amm.total_fee_minus_distributions = market
        .amm
        .total_fee_minus_distributions
        .safe_add(fee_to_market.cast()?)?;
    market.amm.net_revenue_since_last_funding = market
        .amm
        .net_revenue_since_last_funding
        .safe_add(fee_to_market)?;

    // Increment the user's total fee variables
    user_stats.increment_total_fees(user_fee)?;
    user_stats.increment_total_rebate(maker_rebate)?;
    user_stats.increment_total_referee_discount(referee_discount)?;

    if let (Some(referrer), Some(referrer_stats)) = (referrer.as_mut(), referrer_stats.as_mut()) {
        if let Ok(referrer_position) = referrer.force_get_perp_position_mut(market.market_index) {
            if referrer_reward > 0 {
                update_quote_asset_amount(referrer_position, market, referrer_reward.cast()?)?;
                referrer_stats.increment_total_referrer_reward(referrer_reward, now)?;
            }
        }
    }

    let position_index = get_position_index(&user.perp_positions, market.market_index)?;

    if user_fee != 0 {
        controller::position::update_quote_asset_and_break_even_amount(
            &mut user.perp_positions[position_index],
            market,
            -user_fee.cast()?,
        )?;
    }

    if maker_rebate != 0 {
        controller::position::update_quote_asset_and_break_even_amount(
            &mut user.perp_positions[position_index],
            market,
            maker_rebate.cast()?,
        )?;
    }

    if order_post_only {
        user_stats.update_maker_volume_30d(quote_asset_amount, now)?;
    } else {
        user_stats.update_taker_volume_30d(quote_asset_amount, now)?;
    }

    if let Some(filler) = filler.as_mut() {
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
    }

    update_order_after_fill(
        &mut user.orders[order_index],
        base_asset_amount,
        quote_asset_amount,
    )?;

    decrease_open_bids_and_asks(
        &mut user.perp_positions[position_index],
        &order_direction,
        base_asset_amount,
    )?;

    let (taker, taker_order, maker, maker_order) =
        get_taker_and_maker_for_order_record(user_key, &user.orders[order_index]);

    let fill_record_id = get_then_update_id!(market, next_fill_record_id);
    let order_action_explanation = match (override_base_asset_amount, override_fill_price) {
        (Some(_), Some(_)) => liquidity_split.get_order_action_explanation(),
        _ => OrderActionExplanation::OrderFilledWithAMM,
    };
    let order_action_record = get_order_action_record(
        now,
        OrderAction::Fill,
        order_action_explanation,
        market.market_index,
        Some(*filler_key),
        Some(fill_record_id),
        Some(filler_reward),
        Some(base_asset_amount),
        Some(quote_asset_amount),
        Some(user_fee),
        if maker_rebate != 0 {
            Some(maker_rebate)
        } else {
            None
        },
        Some(referrer_reward),
        Some(quote_asset_amount_surplus),
        None,
        taker,
        taker_order,
        maker,
        maker_order,
        oracle_map.get_price_data(&market.amm.oracle)?.price,
    )?;
    emit_stack::<_, { OrderActionRecord::SIZE }>(order_action_record)?;

    // Cant reset order until after its logged
    if user.orders[order_index].get_base_asset_amount_unfilled(None)? == 0 {
        user.decrement_open_orders(user.orders[order_index].has_auction());
        user.orders[order_index] = Order::default();
        let market_position = &mut user.perp_positions[position_index];
        market_position.open_orders -= 1;
    }

    Ok((base_asset_amount, quote_asset_amount))
}

pub fn fulfill_perp_order_with_match(
    market: &mut PerpMarket,
    taker: &mut User,
    taker_stats: &mut UserStats,
    taker_order_index: usize,
    taker_key: &Pubkey,
    maker: &mut User,
    maker_stats: &mut Option<&mut UserStats>,
    maker_order_index: usize,
    maker_key: &Pubkey,
    filler: &mut Option<&mut User>,
    filler_stats: &mut Option<&mut UserStats>,
    filler_key: &Pubkey,
    referrer: &mut Option<&mut User>,
    referrer_stats: &mut Option<&mut UserStats>,
    reserve_price_before: u64,
    valid_oracle_price: Option<i64>,
    taker_limit_price: Option<u64>,
    now: i64,
    slot: u64,
    fee_structure: &FeeStructure,
    oracle_map: &mut OracleMap,
) -> DriftResult<(u64, u64, u64)> {
    if !are_orders_same_market_but_different_sides(
        &maker.orders[maker_order_index],
        &taker.orders[taker_order_index],
    ) {
        return Ok((0_u64, 0_u64, 0_u64));
    }

    let oracle_price = oracle_map.get_price_data(&market.amm.oracle)?.price;
    let taker_direction: PositionDirection = taker.orders[taker_order_index].direction;

    let taker_price = if let Some(taker_limit_price) = taker_limit_price {
        taker_limit_price
    } else {
        let amm_available_liquidity =
            calculate_amm_available_liquidity(&market.amm, &taker_direction)?;
        market.amm.get_fallback_price(
            &taker_direction,
            amm_available_liquidity,
            oracle_price,
            taker.orders[taker_order_index].seconds_til_expiry(now),
        )?
    };

    let taker_existing_position = taker
        .get_perp_position(market.market_index)?
        .base_asset_amount;
    let taker_base_asset_amount = taker.orders[taker_order_index]
        .get_base_asset_amount_unfilled(Some(taker_existing_position))?;

    let maker_price = maker.orders[maker_order_index].force_get_limit_price(
        Some(oracle_price),
        None,
        slot,
        market.amm.order_tick_size,
    )?;
    let maker_direction = maker.orders[maker_order_index].direction;
    let maker_existing_position = maker
        .get_perp_position(market.market_index)?
        .base_asset_amount;
    let maker_base_asset_amount = maker.orders[maker_order_index]
        .get_base_asset_amount_unfilled(Some(maker_existing_position))?;

    let orders_cross = do_orders_cross(maker_direction, maker_price, taker_price);

    if !orders_cross {
        msg!(
            "orders dont cross. maker price {} taker price {}",
            maker_price,
            taker_price
        );
        return Ok((0_u64, 0_u64, 0_u64));
    }

    let (base_asset_amount, _) = calculate_fill_for_matched_orders(
        maker_base_asset_amount,
        maker_price,
        taker_base_asset_amount,
        PERP_DECIMALS,
        maker_direction,
    )?;

    if base_asset_amount == 0 {
        return Ok((0_u64, 0_u64, 0_u64));
    }

    let sanitize_clamp_denominator = market.get_sanitize_clamp_denominator()?;
    amm::update_mark_twap_from_estimates(
        &mut market.amm,
        now,
        Some(maker_price),
        Some(taker_direction),
        sanitize_clamp_denominator,
    )?;

    let mut total_quote_asset_amount = 0_u64;
    let mut total_base_asset_amount = 0_u64;

    let (jit_base_asset_amount, amm_liquidity_split) = calculate_amm_jit_liquidity(
        market,
        taker_direction,
        maker_price,
        valid_oracle_price,
        base_asset_amount,
        taker_base_asset_amount,
        maker_base_asset_amount,
        taker.orders[taker_order_index].has_limit_price(slot)?,
    )?;

    if jit_base_asset_amount > 0 {
        let (base_asset_amount_filled_by_amm, quote_asset_amount_filled_by_amm) =
            fulfill_perp_order_with_amm(
                taker,
                taker_stats,
                taker_order_index,
                market,
                oracle_map,
                reserve_price_before,
                now,
                slot,
                taker_key,
                filler_key,
                filler,
                filler_stats,
                &mut None,
                &mut None,
                fee_structure,
                taker_limit_price,
                Some(jit_base_asset_amount),
                Some(maker_price), // match the makers price
                amm_liquidity_split,
            )?;

        total_base_asset_amount = base_asset_amount_filled_by_amm;
        total_quote_asset_amount = quote_asset_amount_filled_by_amm
    }

    let taker_existing_position = taker
        .get_perp_position(market.market_index)?
        .base_asset_amount;

    let taker_base_asset_amount = taker.orders[taker_order_index]
        .get_base_asset_amount_unfilled(Some(taker_existing_position))?;

    let (base_asset_amount_fulfilled_by_maker, quote_asset_amount) =
        calculate_fill_for_matched_orders(
            maker_base_asset_amount,
            maker_price,
            taker_base_asset_amount,
            PERP_DECIMALS,
            maker_direction,
        )?;

    validate_fill_price(
        quote_asset_amount,
        base_asset_amount_fulfilled_by_maker,
        BASE_PRECISION_U64,
        taker_direction,
        taker_price,
        true,
    )?;

    validate_fill_price(
        quote_asset_amount,
        base_asset_amount_fulfilled_by_maker,
        BASE_PRECISION_U64,
        maker_direction,
        maker_price,
        false,
    )?;

    total_base_asset_amount =
        total_base_asset_amount.safe_add(base_asset_amount_fulfilled_by_maker)?;
    total_quote_asset_amount = total_quote_asset_amount.safe_add(quote_asset_amount)?;

    let maker_position_index = get_position_index(
        &maker.perp_positions,
        maker.orders[maker_order_index].market_index,
    )?;

    let maker_position_delta = get_position_delta_for_fill(
        base_asset_amount_fulfilled_by_maker,
        quote_asset_amount,
        maker.orders[maker_order_index].direction,
    )?;

    update_position_and_market(
        &mut maker.perp_positions[maker_position_index],
        market,
        &maker_position_delta,
    )?;

    // if maker is none, makes maker and taker authority was the same
    if let Some(maker_stats) = maker_stats {
        maker_stats.update_maker_volume_30d(quote_asset_amount, now)?;
    } else {
        taker_stats.update_maker_volume_30d(quote_asset_amount, now)?;
    };

    let taker_position_index = get_position_index(
        &taker.perp_positions,
        taker.orders[taker_order_index].market_index,
    )?;

    let taker_position_delta = get_position_delta_for_fill(
        base_asset_amount_fulfilled_by_maker,
        quote_asset_amount,
        taker.orders[taker_order_index].direction,
    )?;

    update_position_and_market(
        &mut taker.perp_positions[taker_position_index],
        market,
        &taker_position_delta,
    )?;

    taker_stats.update_taker_volume_30d(quote_asset_amount, now)?;

    let reward_referrer = can_reward_user_with_perp_pnl(referrer, market.market_index);
    let reward_filler = can_reward_user_with_perp_pnl(filler, market.market_index);

    let filler_multiplier = if reward_filler {
        calculate_filler_multiplier_for_matched_orders(maker_price, maker_direction, oracle_price)?
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
        ..
    } = fees::calculate_fee_for_fulfillment_with_match(
        taker_stats,
        maker_stats,
        quote_asset_amount,
        fee_structure,
        taker.orders[taker_order_index].slot,
        slot,
        filler_multiplier,
        reward_referrer,
        referrer_stats,
        &MarketType::Perp,
        market.fee_adjustment,
    )?;

    // Increment the markets house's total fee variables
    market.amm.total_fee = market.amm.total_fee.safe_add(fee_to_market.cast()?)?;
    market.amm.total_exchange_fee = market
        .amm
        .total_exchange_fee
        .safe_add(fee_to_market.cast()?)?;
    market.amm.total_fee_minus_distributions = market
        .amm
        .total_fee_minus_distributions
        .safe_add(fee_to_market.cast()?)?;
    market.amm.net_revenue_since_last_funding = market
        .amm
        .net_revenue_since_last_funding
        .safe_add(fee_to_market)?;

    controller::position::update_quote_asset_and_break_even_amount(
        &mut taker.perp_positions[taker_position_index],
        market,
        -taker_fee.cast()?,
    )?;

    taker_stats.increment_total_fees(taker_fee)?;
    taker_stats.increment_total_referee_discount(referee_discount)?;

    controller::position::update_quote_asset_and_break_even_amount(
        &mut maker.perp_positions[maker_position_index],
        market,
        maker_rebate.cast()?,
    )?;

    if let Some(maker_stats) = maker_stats {
        maker_stats.increment_total_rebate(maker_rebate)?;
    } else {
        taker_stats.increment_total_rebate(maker_rebate)?;
    }

    if let Some(filler) = filler {
        if filler_reward > 0 {
            let filler_position_index =
                get_position_index(&filler.perp_positions, market.market_index).or_else(|_| {
                    add_new_position(&mut filler.perp_positions, market.market_index)
                })?;

            controller::position::update_quote_asset_amount(
                &mut filler.perp_positions[filler_position_index],
                market,
                filler_reward.cast()?,
            )?;

            filler_stats
                .as_mut()
                .safe_unwrap()?
                .update_filler_volume(quote_asset_amount, now)?;
        }
        filler.update_last_active_slot(slot);
    }

    if let (Some(referrer), Some(referrer_stats)) = (referrer.as_mut(), referrer_stats.as_mut()) {
        if let Ok(referrer_position) = referrer.force_get_perp_position_mut(market.market_index) {
            if referrer_reward > 0 {
                update_quote_asset_amount(referrer_position, market, referrer_reward.cast()?)?;
                referrer_stats.increment_total_referrer_reward(referrer_reward, now)?;
            }
        }
    }

    update_order_after_fill(
        &mut taker.orders[taker_order_index],
        base_asset_amount_fulfilled_by_maker,
        quote_asset_amount,
    )?;

    decrease_open_bids_and_asks(
        &mut taker.perp_positions[taker_position_index],
        &taker.orders[taker_order_index].direction,
        base_asset_amount_fulfilled_by_maker,
    )?;

    update_order_after_fill(
        &mut maker.orders[maker_order_index],
        base_asset_amount_fulfilled_by_maker,
        quote_asset_amount,
    )?;

    decrease_open_bids_and_asks(
        &mut maker.perp_positions[maker_position_index],
        &maker.orders[maker_order_index].direction,
        base_asset_amount_fulfilled_by_maker,
    )?;

    let fill_record_id = get_then_update_id!(market, next_fill_record_id);
    let order_action_explanation = if maker.orders[maker_order_index].is_jit_maker() {
        OrderActionExplanation::OrderFilledWithMatchJit
    } else {
        OrderActionExplanation::OrderFilledWithMatch
    };
    let order_action_record = get_order_action_record(
        now,
        OrderAction::Fill,
        order_action_explanation,
        market.market_index,
        Some(*filler_key),
        Some(fill_record_id),
        Some(filler_reward),
        Some(base_asset_amount_fulfilled_by_maker),
        Some(quote_asset_amount),
        Some(taker_fee),
        Some(maker_rebate),
        Some(referrer_reward),
        None,
        None,
        Some(*taker_key),
        Some(taker.orders[taker_order_index]),
        Some(*maker_key),
        Some(maker.orders[maker_order_index]),
        oracle_map.get_price_data(&market.amm.oracle)?.price,
    )?;
    emit_stack::<_, { OrderActionRecord::SIZE }>(order_action_record)?;

    if taker.orders[taker_order_index].get_base_asset_amount_unfilled(None)? == 0 {
        taker.decrement_open_orders(taker.orders[taker_order_index].has_auction());
        taker.orders[taker_order_index] = Order::default();
        let market_position = &mut taker.perp_positions[taker_position_index];
        market_position.open_orders -= 1;
    }

    if maker.orders[maker_order_index].get_base_asset_amount_unfilled(None)? == 0 {
        maker.decrement_open_orders(maker.orders[maker_order_index].has_auction());
        maker.orders[maker_order_index] = Order::default();
        let market_position = &mut maker.perp_positions[maker_position_index];
        market_position.open_orders -= 1;
    }

    Ok((
        total_base_asset_amount,
        total_quote_asset_amount,
        base_asset_amount_fulfilled_by_maker,
    ))
}

pub fn update_order_after_fill(
    order: &mut Order,
    base_asset_amount: u64,
    quote_asset_amount: u64,
) -> DriftResult {
    order.base_asset_amount_filled = order.base_asset_amount_filled.safe_add(base_asset_amount)?;

    order.quote_asset_amount_filled = order
        .quote_asset_amount_filled
        .safe_add(quote_asset_amount)?;

    if order.get_base_asset_amount_unfilled(None)? == 0 {
        order.status = OrderStatus::Filled;
    }

    Ok(())
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
        .position(|order| order.order_id == order_id)
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

    validate!(
        !user.orders[order_index].triggered(),
        ErrorCode::OrderNotTriggerable,
        "Order is already triggered"
    )?;

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
    let oracle_price_data = &oracle_map.get_price_data(&perp_market.amm.oracle)?;

    let oracle_validity = oracle::oracle_validity(
        perp_market
            .amm
            .historical_oracle_data
            .last_oracle_price_twap,
        oracle_price_data,
        &state.oracle_guard_rails.validity,
    )?;
    let is_oracle_valid =
        is_oracle_valid_for_action(oracle_validity, Some(DriftAction::TriggerOrder))?;

    validate!(is_oracle_valid, ErrorCode::InvalidOracle)?;

    let oracle_price = oracle_price_data.price;

    let can_trigger = order_satisfies_trigger_condition(
        &user.orders[order_index],
        oracle_price.unsigned_abs().cast()?,
    )?;
    validate!(can_trigger, ErrorCode::OrderDidNotSatisfyTriggerCondition)?;

    let worst_case_base_asset_amount_before = user
        .get_perp_position(market_index)?
        .worst_case_base_asset_amount()?;

    {
        update_trigger_order_params(
            &mut user.orders[order_index],
            oracle_price_data,
            slot,
            30,
            Some(&perp_market),
        )?;

        if user.orders[order_index].has_auction() {
            user.increment_open_auctions();
        }

        let direction = user.orders[order_index].direction;
        let base_asset_amount = user.orders[order_index].base_asset_amount;

        let user_position = user.get_perp_position_mut(market_index)?;
        increase_open_bids_and_asks(user_position, &direction, base_asset_amount)?;
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
    )?;
    emit!(order_action_record);

    drop(perp_market);

    let worst_case_base_asset_amount_after = user
        .get_perp_position(market_index)?
        .worst_case_base_asset_amount()?;

    let is_risk_increasing = worst_case_base_asset_amount_after.unsigned_abs()
        > worst_case_base_asset_amount_before.unsigned_abs();

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

pub fn attempt_burn_user_lp_shares_for_risk_reduction(
    state: &State,
    user: &mut User,
    user_key: Pubkey,
    margin_calc: MarginCalculation,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    clock: &Clock,
    market_index: u16,
) -> DriftResult {
    let now = clock.unix_timestamp;
    let time_since_last_liquidity_change: i64 = now.safe_sub(user.last_add_perp_lp_shares_ts)?;
    // avoid spamming update if orders have already been set
    if time_since_last_liquidity_change >= state.lp_cooldown_time.cast()? {
        burn_user_lp_shares_for_risk_reduction(
            state,
            user,
            user_key,
            market_index,
            margin_calc,
            perp_market_map,
            spot_market_map,
            oracle_map,
            clock,
        )?;
        user.last_add_perp_lp_shares_ts = now;
    }

    Ok(())
}

pub fn burn_user_lp_shares_for_risk_reduction(
    state: &State,
    user: &mut User,
    user_key: Pubkey,
    market_index: u16,
    margin_calc: MarginCalculation,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    clock: &Clock,
) -> DriftResult {
    let position_index = get_position_index(&user.perp_positions, market_index)?;
    let is_lp = user.perp_positions[position_index].is_lp();
    if !is_lp {
        return Ok(());
    }

    let mut market = perp_market_map.get_ref_mut(&market_index)?;

    let quote_oracle = spot_market_map
        .get_ref(&market.quote_spot_market_index)?
        .oracle;
    let quote_oracle_price = oracle_map.get_price_data(&quote_oracle)?.price;

    let oracle_price_data = oracle_map.get_price_data(&market.amm.oracle)?;

    let oracle_price = if market.status == MarketStatus::Settlement {
        market.expiry_price
    } else {
        oracle_price_data.price
    };

    let user_custom_margin_ratio = user.max_margin_ratio;
    let (lp_shares_to_burn, base_asset_amount_to_close) =
        calculate_lp_shares_to_burn_for_risk_reduction(
            &user.perp_positions[position_index],
            &market,
            oracle_price,
            quote_oracle_price,
            margin_calc.margin_shortage()?,
            user_custom_margin_ratio,
        )?;

    let (position_delta, pnl) = burn_lp_shares(
        &mut user.perp_positions[position_index],
        &mut market,
        lp_shares_to_burn,
        oracle_price,
    )?;

    // emit LP record for shares removed
    emit_stack::<_, { LPRecord::SIZE }>(LPRecord {
        ts: clock.unix_timestamp,
        action: LPAction::RemoveLiquidityDerisk,
        user: user_key,
        n_shares: lp_shares_to_burn,
        market_index,
        delta_base_asset_amount: position_delta.base_asset_amount,
        delta_quote_asset_amount: position_delta.quote_asset_amount,
        pnl,
    })?;

    let direction_to_close = user.perp_positions[position_index].get_direction_to_close();

    let params = OrderParams::get_close_perp_params(
        &market,
        direction_to_close,
        base_asset_amount_to_close,
    )?;

    drop(market);

    controller::orders::place_perp_order(
        state,
        user,
        user_key,
        perp_market_map,
        spot_market_map,
        oracle_map,
        clock,
        params,
        PlaceOrderOptions::default().explanation(OrderActionExplanation::DeriskLp),
    )?;

    Ok(())
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

pub fn place_spot_order(
    state: &State,
    user: &mut User,
    user_key: Pubkey,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    clock: &Clock,
    params: OrderParams,
    mut options: PlaceOrderOptions,
) -> DriftResult {
    let now = clock.unix_timestamp;
    let slot = clock.slot;

    validate_user_not_being_liquidated(
        user,
        perp_market_map,
        spot_market_map,
        oracle_map,
        state.liquidation_margin_buffer_ratio,
    )?;

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

    let max_ts = match params.max_ts {
        Some(max_ts) => max_ts,
        None => match params.order_type {
            OrderType::Market | OrderType::Oracle => now.safe_add(30)?,
            _ => 0_i64,
        },
    };

    if max_ts != 0 && max_ts < now {
        msg!("max_ts ({}) < now ({}), skipping order", max_ts, now);
        return Ok(());
    }

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
    let spot_market = &spot_market_map.get_ref(&market_index)?;
    let force_reduce_only = spot_market.is_reduce_only();
    let step_size = spot_market.order_step_size;

    validate!(
        !matches!(spot_market.status, MarketStatus::Initialized),
        ErrorCode::MarketBeingInitialized,
        "Market is being initialized"
    )?;

    let spot_position_index = user
        .get_spot_position_index(market_index)
        .or_else(|_| user.add_spot_position(market_index, SpotBalanceType::Deposit))?;

    let balance_type = user.spot_positions[spot_position_index].balance_type;
    let token_amount = user.spot_positions[spot_position_index].get_token_amount(spot_market)?;
    let signed_token_amount = get_signed_token_amount(token_amount, &balance_type)?;

    let oracle_price_data = *oracle_map.get_price_data(&spot_market.oracle)?;

    // Increment open orders for existing position
    let (existing_position_direction, order_base_asset_amount) = {
        validate!(
            params.base_asset_amount >= step_size,
            ErrorCode::InvalidOrderSizeTooSmall,
            "params.base_asset_amount={} cannot be below spot_market.order_step_size={}",
            params.base_asset_amount,
            step_size
        )?;

        let base_asset_amount = if params.base_asset_amount == u64::MAX {
            calculate_max_spot_order_size(
                user,
                params.market_index,
                params.direction,
                perp_market_map,
                spot_market_map,
                oracle_map,
            )?
        } else {
            standardize_base_asset_amount(params.base_asset_amount, step_size)?
        };

        validate!(
            is_multiple_of_step_size(base_asset_amount, step_size)?,
            ErrorCode::InvalidOrderNotStepSizeMultiple,
            "Order base asset amount ({}), is not a multiple of step size ({})",
            base_asset_amount,
            step_size
        )?;

        let existing_position_direction = if signed_token_amount >= 0 {
            PositionDirection::Long
        } else {
            PositionDirection::Short
        };
        (
            existing_position_direction,
            base_asset_amount.cast::<u64>()?,
        )
    };

    let (auction_start_price, auction_end_price, auction_duration) = get_auction_params(
        &params,
        &oracle_price_data,
        spot_market.order_tick_size,
        state.default_spot_auction_duration,
    )?;

    validate!(spot_market.orders_enabled, ErrorCode::SpotOrdersDisabled)?;

    validate!(
        params.market_index != QUOTE_SPOT_MARKET_INDEX,
        ErrorCode::InvalidOrderBaseQuoteAsset,
        "can not place order for quote asset"
    )?;

    validate!(
        params.market_type == MarketType::Spot,
        ErrorCode::InvalidOrderMarketType,
        "must be spot order"
    )?;

    let new_order = Order {
        status: OrderStatus::Open,
        order_type: params.order_type,
        market_type: params.market_type,
        slot,
        order_id: get_then_update_id!(user, next_order_id),
        user_order_id: params.user_order_id,
        market_index: params.market_index,
        price: standardize_price(params.price, spot_market.order_tick_size, params.direction)?,
        existing_position_direction,
        base_asset_amount: order_base_asset_amount,
        base_asset_amount_filled: 0,
        quote_asset_amount_filled: 0,
        direction: params.direction,
        reduce_only: params.reduce_only || force_reduce_only,
        trigger_price: standardize_price(
            params.trigger_price.unwrap_or(0),
            spot_market.order_tick_size,
            params.direction,
        )?,
        trigger_condition: params.trigger_condition,
        post_only: params.post_only != PostOnlyParam::None,
        oracle_price_offset: params.oracle_price_offset.unwrap_or(0),
        immediate_or_cancel: params.immediate_or_cancel,
        auction_start_price,
        auction_end_price,
        auction_duration,
        max_ts,
        padding: [0; 3],
    };

    validate_spot_order(
        &new_order,
        spot_market.order_step_size,
        spot_market.min_order_size,
    )?;

    let risk_increasing = is_new_order_risk_increasing(
        &new_order,
        signed_token_amount.cast()?,
        user.spot_positions[spot_position_index].open_bids,
        user.spot_positions[spot_position_index].open_asks,
    )?;

    user.increment_open_orders(new_order.has_auction());
    user.orders[new_order_index] = new_order;
    user.spot_positions[spot_position_index].open_orders += 1;
    if !new_order.must_be_triggered() {
        increase_spot_open_bids_and_asks(
            &mut user.spot_positions[spot_position_index],
            &params.direction,
            order_base_asset_amount,
        )?;
    }

    options.update_risk_increasing(risk_increasing);

    if options.enforce_margin_check {
        meets_place_order_margin_requirement(
            user,
            perp_market_map,
            spot_market_map,
            oracle_map,
            options.risk_increasing,
        )?;
    }

    validate_spot_margin_trading(user, spot_market_map, oracle_map)?;

    if force_reduce_only {
        validate_order_for_force_reduce_only(
            &user.orders[new_order_index],
            signed_token_amount.cast()?,
        )?;
    }

    let (taker, taker_order, maker, maker_order) =
        get_taker_and_maker_for_order_record(&user_key, &new_order);

    let order_action_record = get_order_action_record(
        now,
        OrderAction::Place,
        OrderActionExplanation::None,
        params.market_index,
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
        oracle_price_data.price,
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

pub fn fill_spot_order(
    order_id: u32,
    state: &State,
    user: &AccountLoader<User>,
    user_stats: &AccountLoader<UserStats>,
    spot_market_map: &SpotMarketMap,
    perp_market_map: &PerpMarketMap,
    oracle_map: &mut OracleMap,
    filler: &AccountLoader<User>,
    filler_stats: &AccountLoader<UserStats>,
    maker: Option<&AccountLoader<User>>,
    maker_stats: Option<&AccountLoader<UserStats>>,
    maker_order_id: Option<u32>,
    clock: &Clock,
    fulfillment_params: &mut dyn SpotFulfillmentParams,
) -> DriftResult<u64> {
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

    let (order_status, order_market_index, order_market_type, order_direction) = get_struct_values!(
        user.orders[order_index],
        status,
        market_index,
        market_type,
        direction
    );

    {
        let spot_market = spot_market_map.get_ref(&order_market_index)?;
        validate!(
            spot_market.fills_enabled(),
            ErrorCode::MarketFillOrderPaused,
            "Market unavailable for fills"
        )?;
    }

    validate!(
        order_market_type == MarketType::Spot,
        ErrorCode::InvalidOrderMarketType,
        "must be spot order"
    )?;

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
        msg!("User is bankrupt");
        return Ok(0);
    }

    match validate_user_not_being_liquidated(
        user,
        perp_market_map,
        spot_market_map,
        oracle_map,
        state.liquidation_margin_buffer_ratio,
    ) {
        Ok(_) => {}
        Err(_) => {
            msg!("User is being liquidated");
            return Ok(0);
        }
    }

    let is_filler_taker = user_key == filler_key;
    let is_filler_maker = maker.map_or(false, |maker| maker.key() == filler_key);
    let (mut filler, mut filler_stats) = if !is_filler_maker && !is_filler_taker {
        let filler = load_mut!(filler)?;
        if filler.authority != user.authority {
            (Some(filler), Some(load_mut!(filler_stats)?))
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };

    let (mut maker, mut maker_stats, maker_key, maker_order_index) = get_spot_maker_order(
        perp_market_map,
        spot_market_map,
        oracle_map,
        maker,
        maker_stats,
        maker_order_id,
        &user_key,
        &user.authority,
        &user.orders[order_index],
        &mut filler.as_deref_mut(),
        &filler_key,
        state.spot_fee_structure.flat_filler_fee,
        now,
        slot,
    )?;

    {
        let mut quote_market = spot_market_map.get_quote_spot_market_mut()?;
        let oracle_price_data = oracle_map.get_price_data(&quote_market.oracle)?;
        update_spot_market_cumulative_interest(&mut quote_market, Some(oracle_price_data), now)?;

        let mut base_market = spot_market_map.get_ref_mut(&order_market_index)?;
        let oracle_price_data = oracle_map.get_price_data(&base_market.oracle)?;
        update_spot_market_cumulative_interest(&mut base_market, Some(oracle_price_data), now)?;

        let oracle_too_divergent_with_twap_5min = is_oracle_too_divergent_with_twap_5min(
            oracle_price_data.price,
            base_market
                .historical_oracle_data
                .last_oracle_price_twap_5min,
            state
                .oracle_guard_rails
                .max_oracle_twap_5min_percent_divergence()
                .cast()?,
        )?;

        if oracle_too_divergent_with_twap_5min {
            // update filler last active so tx doesn't revert
            if let Some(filler) = filler.as_mut() {
                filler.update_last_active_slot(slot);
            }

            return Ok(0);
        }
    }

    let should_expire_order = should_expire_order_before_fill(user, order_index, now)?;

    let should_cancel_reduce_only = if user.orders[order_index].reduce_only {
        let market_index = user.orders[order_index].market_index;
        let position_index = user.get_spot_position_index(market_index)?;
        let spot_market = spot_market_map.get_ref(&market_index)?;
        let signed_token_amount =
            user.spot_positions[position_index].get_signed_token_amount(&spot_market)?;
        should_cancel_reduce_only_order(
            &user.orders[order_index],
            signed_token_amount.cast()?,
            spot_market.order_step_size,
        )?
    } else {
        false
    };

    if should_expire_order || should_cancel_reduce_only {
        let filler_reward = {
            let mut quote_market = spot_market_map.get_quote_spot_market_mut()?;
            pay_keeper_flat_reward_for_spot(
                user,
                filler.as_deref_mut(),
                &mut quote_market,
                state.spot_fee_structure.flat_filler_fee,
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
        return Ok(0);
    }

    let (base_asset_amount, quote_asset_amount) = fulfill_spot_order(
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
        spot_market_map,
        perp_market_map,
        oracle_map,
        now,
        slot,
        &state.spot_fee_structure,
        fulfillment_params,
    )?;

    if base_asset_amount != 0 {
        let spot_market = spot_market_map.get_ref(&order_market_index)?;
        let fill_price = calculate_fill_price(
            quote_asset_amount,
            base_asset_amount,
            spot_market.get_precision(),
        )?;

        let oracle_price = oracle_map.get_price_data(&spot_market.oracle)?.price;
        let oracle_twap_5min = spot_market
            .historical_oracle_data
            .last_oracle_price_twap_5min;
        validate_fill_price_within_price_bands(
            fill_price,
            order_direction,
            oracle_price,
            oracle_twap_5min,
            spot_market.get_margin_ratio(&MarginRequirementType::Initial)?,
            state
                .oracle_guard_rails
                .max_oracle_twap_5min_percent_divergence(),
        )?;
    }

    let is_open = user.orders[order_index].status == OrderStatus::Open;
    let is_reduce_only = user.orders[order_index].reduce_only;
    let should_cancel_reduce_only = if is_open && is_reduce_only {
        let market_index = user.orders[order_index].market_index;
        let position_index = user.get_spot_position_index(market_index)?;
        let spot_market = spot_market_map.get_ref(&market_index)?;
        let signed_token_amount =
            user.spot_positions[position_index].get_signed_token_amount(&spot_market)?;
        should_cancel_reduce_only_order(
            &user.orders[order_index],
            signed_token_amount.cast()?,
            spot_market.order_step_size,
        )?
    } else {
        false
    };

    let should_cancel_for_no_borrow_liquidity = if is_open {
        let market_index = user.orders[order_index].market_index;
        let base_market = spot_market_map.get_ref(&market_index)?;
        let quote_market = spot_market_map.get_quote_spot_market()?;
        let (max_base_asset_amount, max_quote_asset_amount) =
            get_max_fill_amounts(user, order_index, &base_market, &quote_market, false)?;
        max_base_asset_amount == Some(0) || max_quote_asset_amount == Some(0)
    } else {
        false
    };

    if should_cancel_reduce_only || should_cancel_for_no_borrow_liquidity {
        let filler_reward = {
            let mut quote_market = spot_market_map.get_quote_spot_market_mut()?;
            pay_keeper_flat_reward_for_spot(
                user,
                filler.as_deref_mut(),
                &mut quote_market,
                state.spot_fee_structure.flat_filler_fee,
                slot,
            )?
        };

        let explanation = if should_cancel_reduce_only {
            OrderActionExplanation::ReduceOnlyOrderIncreasedPosition
        } else {
            OrderActionExplanation::NoBorrowLiquidity
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
        )?
    }

    spot_market_map
        .get_ref(&order_market_index)?
        .validate_max_token_deposits()?;

    user.update_last_active_slot(slot);

    Ok(base_asset_amount)
}

#[allow(clippy::type_complexity)]
fn get_spot_maker_order<'a>(
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    maker: Option<&'a AccountLoader<User>>,
    maker_stats: Option<&'a AccountLoader<UserStats>>,
    maker_order_id: Option<u32>,
    taker_key: &Pubkey,
    taker_authority: &Pubkey,
    taker_order: &Order,
    filler: &mut Option<&mut User>,
    filler_key: &Pubkey,
    filler_reward: u64,
    now: i64,
    slot: u64,
) -> DriftResult<(
    Option<RefMut<'a, User>>,
    Option<RefMut<'a, UserStats>>,
    Option<Pubkey>,
    Option<usize>,
)> {
    if maker.is_none() || maker_stats.is_none() {
        return Ok((None, None, None, None));
    }

    let maker = maker.safe_unwrap()?;
    if &maker.key() == taker_key {
        return Ok((None, None, None, None));
    }

    let maker_key = maker.key();
    let mut maker = load_mut!(maker)?;

    maker.update_last_active_slot(slot);

    let maker_stats = if &maker.authority == taker_authority {
        None
    } else {
        let maker_stats = load_mut!(maker_stats.safe_unwrap()?)?;

        validate!(
            maker.authority.eq(&maker_stats.authority),
            ErrorCode::InvalidMaker,
            "maker authority != maker stats authority"
        )?;

        Some(maker_stats)
    };

    let maker_order_id = maker_order_id.ok_or(ErrorCode::MakerOrderNotFound)?;
    let maker_order_index = match maker.get_order_index(maker_order_id) {
        Ok(order_index) => order_index,
        Err(_) => {
            msg!("Maker has no order id {}", maker_order_id);
            return Ok((None, None, None, None));
        }
    };

    {
        let maker_order = &maker.orders[maker_order_index];
        if !is_maker_for_taker(maker_order, taker_order, slot)? {
            return Ok((None, None, None, None));
        }

        if maker.is_being_liquidated() || maker.is_bankrupt() {
            return Ok((None, None, None, None));
        }

        validate!(
            !maker_order.must_be_triggered() || maker_order.triggered(),
            ErrorCode::OrderMustBeTriggeredFirst,
            "Maker order not triggered"
        )?;

        validate!(
            maker_order.market_type == MarketType::Spot,
            ErrorCode::InvalidOrderMarketType,
            "Maker order not a spot order"
        )?
    }

    let spot_market = spot_market_map.get_ref(&maker.orders[maker_order_index].market_index)?;
    let breaches_oracle_price_limits = {
        let oracle_price = oracle_map.get_price_data(&spot_market.oracle)?;
        let initial_margin_ratio = spot_market.get_margin_ratio(&MarginRequirementType::Initial)?;
        order_breaches_maker_oracle_price_bands(
            &maker.orders[maker_order_index],
            oracle_price.price,
            slot,
            spot_market.order_tick_size,
            initial_margin_ratio,
        )?
    };

    let should_expire_order = should_expire_order(&maker, maker_order_index, now)?;

    let should_cancel_reduce_only_order = if maker.orders[maker_order_index].reduce_only {
        let spot_position_index =
            maker.get_spot_position_index(maker.orders[maker_order_index].market_index)?;
        let signed_token_amount =
            maker.spot_positions[spot_position_index].get_signed_token_amount(&spot_market)?;
        should_cancel_reduce_only_order(
            &maker.orders[maker_order_index],
            signed_token_amount.cast()?,
            spot_market.order_step_size,
        )?
    } else {
        false
    };

    if breaches_oracle_price_limits || should_expire_order || should_cancel_reduce_only_order {
        let filler_reward = {
            let mut quote_market = spot_market_map.get_quote_spot_market_mut()?;
            pay_keeper_flat_reward_for_spot(
                &mut maker,
                filler.as_deref_mut(),
                &mut quote_market,
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
            &maker_key,
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

        return Ok((None, None, None, None));
    }

    Ok((
        Some(maker),
        maker_stats,
        Some(maker_key),
        Some(maker_order_index),
    ))
}

fn fulfill_spot_order(
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
    spot_market_map: &SpotMarketMap,
    perp_market_map: &PerpMarketMap,
    oracle_map: &mut OracleMap,
    now: i64,
    slot: u64,
    fee_structure: &FeeStructure,
    fulfillment_params: &mut dyn SpotFulfillmentParams,
) -> DriftResult<(u64, u64)> {
    let base_market_index = user.orders[user_order_index].market_index;
    let order_direction = user.orders[user_order_index].direction;

    let fulfillment_methods = determine_spot_fulfillment_methods(
        &user.orders[user_order_index],
        maker.is_some(),
        fulfillment_params.is_external(),
    )?;

    let mut quote_market = spot_market_map.get_quote_spot_market_mut()?;
    let mut base_market = spot_market_map.get_ref_mut(&base_market_index)?;

    let quote_token_amount_before = user
        .get_quote_spot_position()
        .get_signed_token_amount(&quote_market)?;
    let base_token_amount_before = user
        .force_get_spot_position_mut(base_market_index)?
        .get_signed_token_amount(&base_market)?;

    let mut base_asset_amount = 0_u64;
    let mut quote_asset_amount = 0_u64;
    for fulfillment_method in fulfillment_methods.iter() {
        if user.orders[user_order_index].status != OrderStatus::Open {
            break;
        }

        let (base_filled, quote_filled) = match fulfillment_method {
            SpotFulfillmentMethod::Match => fulfill_spot_order_with_match(
                &mut base_market,
                &mut quote_market,
                user,
                user_stats,
                user_order_index,
                user_key,
                maker.as_deref_mut().safe_unwrap()?,
                maker_stats,
                maker_order_index.safe_unwrap()?,
                maker_key.safe_unwrap()?,
                filler.as_deref_mut(),
                filler_stats.as_deref_mut(),
                filler_key,
                now,
                slot,
                oracle_map,
                fee_structure,
            )?,
            SpotFulfillmentMethod::ExternalMarket => fulfill_spot_order_with_external_market(
                &mut base_market,
                &mut quote_market,
                user,
                user_stats,
                user_order_index,
                user_key,
                filler.as_deref_mut(),
                filler_stats.as_deref_mut(),
                filler_key,
                now,
                slot,
                oracle_map,
                fee_structure,
                fulfillment_params,
            )?,
        };

        base_asset_amount = base_asset_amount.safe_add(base_filled)?;
        quote_asset_amount = quote_asset_amount.safe_add(quote_filled)?;
    }

    validate!(
        (base_asset_amount > 0) == (quote_asset_amount > 0),
        ErrorCode::DefaultError,
        "invalid fill base = {} quote = {}",
        base_asset_amount,
        quote_asset_amount
    )?;

    let quote_token_amount_after = user
        .get_quote_spot_position()
        .get_signed_token_amount(&quote_market)?;
    let base_token_amount_after = user
        .force_get_spot_position_mut(base_market_index)?
        .get_signed_token_amount(&base_market)?;

    let quote_price = oracle_map.get_price_data(&quote_market.oracle)?.price;
    let base_price = oracle_map.get_price_data(&base_market.oracle)?.price;

    let strict_quote_price = StrictOraclePrice::new(
        quote_price,
        quote_market
            .historical_oracle_data
            .last_oracle_price_twap_5min,
        true,
    );
    let strict_base_price = StrictOraclePrice::new(
        base_price,
        base_market
            .historical_oracle_data
            .last_oracle_price_twap_5min,
        true,
    );

    let margin_type = if order_direction == PositionDirection::Long {
        // sell quote, buy base
        select_margin_type_for_swap(
            &quote_market,
            &base_market,
            &strict_quote_price,
            &strict_base_price,
            quote_token_amount_before,
            base_token_amount_before,
            quote_token_amount_after,
            base_token_amount_after,
            MarginRequirementType::Fill,
        )?
    } else {
        // sell base, buy quote
        select_margin_type_for_swap(
            &base_market,
            &quote_market,
            &strict_base_price,
            &strict_quote_price,
            base_token_amount_before,
            quote_token_amount_before,
            base_token_amount_after,
            quote_token_amount_after,
            MarginRequirementType::Fill,
        )?
    };

    drop(base_market);
    drop(quote_market);

    let taker_margin_calculation =
        calculate_margin_requirement_and_total_collateral_and_liability_info(
            user,
            perp_market_map,
            spot_market_map,
            oracle_map,
            MarginContext::standard(margin_type),
        )?;

    if !taker_margin_calculation.meets_margin_requirement() {
        msg!(
            "taker breached maintenance requirements (margin requirement {}) (total_collateral {})",
            taker_margin_calculation.margin_requirement,
            taker_margin_calculation.total_collateral
        );
        return Err(ErrorCode::InsufficientCollateral);
    }

    if let Some(maker) = maker {
        let maker_margin_calculation =
            calculate_margin_requirement_and_total_collateral_and_liability_info(
                maker,
                perp_market_map,
                spot_market_map,
                oracle_map,
                MarginContext::standard(MarginRequirementType::Fill),
            )?;

        if !maker_margin_calculation.meets_margin_requirement() {
            msg!(
                "maker ({}) breached maintenance requirements (margin requirement {}) (total_collateral {})",
                maker_key.safe_unwrap()?,
                maker_margin_calculation.margin_requirement,
                maker_margin_calculation.total_collateral
            );
            return Err(ErrorCode::InsufficientCollateral);
        }
    }

    Ok((base_asset_amount, quote_asset_amount))
}

pub fn fulfill_spot_order_with_match(
    base_market: &mut SpotMarket,
    quote_market: &mut SpotMarket,
    taker: &mut User,
    taker_stats: &mut UserStats,
    taker_order_index: usize,
    taker_key: &Pubkey,
    maker: &mut User,
    maker_stats: &mut Option<&mut UserStats>,
    maker_order_index: usize,
    maker_key: &Pubkey,
    filler: Option<&mut User>,
    filler_stats: Option<&mut UserStats>,
    filler_key: &Pubkey,
    now: i64,
    slot: u64,
    oracle_map: &mut OracleMap,
    fee_structure: &FeeStructure,
) -> DriftResult<(u64, u64)> {
    if !are_orders_same_market_but_different_sides(
        &maker.orders[maker_order_index],
        &taker.orders[taker_order_index],
    ) {
        return Ok((0_u64, 0_u64));
    }

    let market_index = taker.orders[taker_order_index].market_index;
    let oracle_price = oracle_map.get_price_data(&base_market.oracle)?.price;
    let taker_price = match taker.orders[taker_order_index].get_limit_price(
        Some(oracle_price),
        None,
        slot,
        base_market.order_tick_size,
    )? {
        Some(price) => price,
        None => {
            return Ok((0_u64, 0_u64));
        }
    };

    let taker_spot_position_index = taker.get_spot_position_index(market_index)?;
    let taker_token_amount =
        taker.spot_positions[taker_spot_position_index].get_signed_token_amount(base_market)?;
    let taker_base_asset_amount = taker.orders[taker_order_index]
        .get_standardized_base_asset_amount_unfilled(
            Some(taker_token_amount.cast()?),
            base_market.order_step_size,
        )?;
    let taker_order_slot = taker.orders[taker_order_index].slot;
    let taker_direction = taker.orders[taker_order_index].direction;

    let maker_price = maker.orders[maker_order_index].force_get_limit_price(
        Some(oracle_price),
        None,
        slot,
        base_market.order_tick_size,
    )?;
    let maker_direction = maker.orders[maker_order_index].direction;
    let maker_spot_position_index = maker.get_spot_position_index(market_index)?;
    let maker_token_amount =
        maker.spot_positions[maker_spot_position_index].get_signed_token_amount(base_market)?;
    let maker_base_asset_amount = maker.orders[maker_order_index]
        .get_standardized_base_asset_amount_unfilled(
            Some(maker_token_amount.cast()?),
            base_market.order_step_size,
        )?;

    let orders_cross = do_orders_cross(maker_direction, maker_price, taker_price);

    if !orders_cross {
        msg!(
            "orders dont cross. maker price {} taker price {}",
            maker_price,
            taker_price
        );
        return Ok((0_u64, 0_u64));
    }

    let (taker_max_base_asset_amount, taker_max_quote_asset_amount) =
        get_max_fill_amounts(taker, taker_order_index, base_market, quote_market, false)?;

    let taker_base_asset_amount =
        if let Some(taker_max_quote_asset_amount) = taker_max_quote_asset_amount {
            let taker_implied_max_base_asset_amount = standardize_base_asset_amount(
                taker_max_quote_asset_amount
                    .cast::<u128>()?
                    .safe_mul(base_market.get_precision().cast()?)?
                    .safe_div(maker_price.cast()?)?
                    .cast::<u64>()?,
                base_market.order_step_size,
            )?;
            taker_base_asset_amount.min(taker_implied_max_base_asset_amount)
        } else if let Some(taker_max_base_asset_amount) = taker_max_base_asset_amount {
            taker_base_asset_amount.min(taker_max_base_asset_amount)
        } else {
            taker_base_asset_amount
        };

    let (maker_max_base_asset_amount, maker_max_quote_asset_amount) =
        get_max_fill_amounts(maker, maker_order_index, base_market, quote_market, false)?;

    let maker_base_asset_amount =
        if let Some(maker_max_quote_asset_amount) = maker_max_quote_asset_amount {
            let maker_implied_max_base_asset_amount = standardize_base_asset_amount(
                maker_max_quote_asset_amount
                    .cast::<u128>()?
                    .safe_mul(base_market.get_precision().cast()?)?
                    .safe_div(maker_price.cast()?)?
                    .cast::<u64>()?,
                base_market.order_step_size,
            )?;
            maker_base_asset_amount.min(maker_implied_max_base_asset_amount)
        } else if let Some(maker_max_base_asset_amount) = maker_max_base_asset_amount {
            maker_base_asset_amount.min(maker_max_base_asset_amount)
        } else {
            maker_base_asset_amount
        };

    let (base_asset_amount, quote_asset_amount) = calculate_fill_for_matched_orders(
        maker_base_asset_amount,
        maker_price,
        taker_base_asset_amount,
        base_market.decimals,
        maker_direction,
    )?;

    if base_asset_amount == 0 {
        return Ok((0_u64, 0_u64));
    }

    let base_precision = base_market.get_precision();
    validate_fill_price(
        quote_asset_amount,
        base_asset_amount,
        base_precision,
        taker_direction,
        taker_price,
        true,
    )?;
    validate_fill_price(
        quote_asset_amount,
        base_asset_amount,
        base_precision,
        maker_direction,
        maker_price,
        false,
    )?;

    let filler_multiplier = if filler.is_some() {
        calculate_filler_multiplier_for_matched_orders(maker_price, maker_direction, oracle_price)?
    } else {
        0
    };

    let FillFees {
        user_fee: taker_fee,
        maker_rebate,
        filler_reward,
        fee_to_market,
        ..
    } = fees::calculate_fee_for_fulfillment_with_match(
        taker_stats,
        maker_stats,
        quote_asset_amount,
        fee_structure,
        taker_order_slot,
        slot,
        filler_multiplier,
        false,
        &None,
        &MarketType::Spot,
        0,
    )?;

    // Update taker state
    update_spot_balances_and_cumulative_deposits(
        base_asset_amount.cast()?,
        &taker.orders[taker_order_index].get_spot_position_update_direction(AssetType::Base),
        base_market,
        &mut taker.spot_positions[taker_spot_position_index],
        false,
        None,
    )?;

    let taker_quote_asset_amount_delta = match &taker.orders[taker_order_index].direction {
        PositionDirection::Long => quote_asset_amount.safe_add(taker_fee)?,
        PositionDirection::Short => quote_asset_amount.safe_sub(taker_fee)?,
    };

    update_spot_balances_and_cumulative_deposits(
        taker_quote_asset_amount_delta.cast()?,
        &taker.orders[taker_order_index].get_spot_position_update_direction(AssetType::Quote),
        quote_market,
        taker.get_quote_spot_position_mut(),
        false,
        Some(quote_asset_amount.cast()?),
    )?;

    taker.update_cumulative_spot_fees(-taker_fee.cast()?)?;

    update_order_after_fill(
        &mut taker.orders[taker_order_index],
        base_asset_amount,
        quote_asset_amount,
    )?;

    let taker_order_direction = taker.orders[taker_order_index].direction;
    decrease_spot_open_bids_and_asks(
        &mut taker.spot_positions[taker_spot_position_index],
        &taker_order_direction,
        base_asset_amount,
    )?;

    taker_stats.update_taker_volume_30d(quote_asset_amount, now)?;

    taker_stats.increment_total_fees(taker_fee)?;

    // Update maker state
    update_spot_balances_and_cumulative_deposits(
        base_asset_amount.cast()?,
        &maker.orders[maker_order_index].get_spot_position_update_direction(AssetType::Base),
        base_market,
        &mut maker.spot_positions[maker_spot_position_index],
        false,
        None,
    )?;

    let maker_quote_asset_amount_delta = match &maker.orders[maker_order_index].direction {
        PositionDirection::Long => quote_asset_amount.safe_sub(maker_rebate)?,
        PositionDirection::Short => quote_asset_amount.safe_add(maker_rebate)?,
    };

    update_spot_balances_and_cumulative_deposits(
        maker_quote_asset_amount_delta.cast()?,
        &maker.orders[maker_order_index].get_spot_position_update_direction(AssetType::Quote),
        quote_market,
        maker.get_quote_spot_position_mut(),
        false,
        Some(quote_asset_amount.cast()?),
    )?;

    maker.update_cumulative_spot_fees(maker_rebate.cast()?)?;

    update_order_after_fill(
        &mut maker.orders[maker_order_index],
        base_asset_amount,
        quote_asset_amount,
    )?;

    let maker_order_direction = maker.orders[maker_order_index].direction;
    decrease_spot_open_bids_and_asks(
        &mut maker.spot_positions[maker_spot_position_index],
        &maker_order_direction,
        base_asset_amount,
    )?;

    if let Some(maker_stats) = maker_stats {
        maker_stats.update_maker_volume_30d(quote_asset_amount, now)?;
        maker_stats.increment_total_rebate(maker_rebate)?;
    } else {
        taker_stats.update_maker_volume_30d(quote_asset_amount, now)?;
        taker_stats.increment_total_rebate(maker_rebate)?;
    }

    // Update filler state
    if let (Some(filler), Some(filler_stats)) = (filler, filler_stats) {
        if filler_reward > 0 {
            update_spot_balances(
                filler_reward.cast()?,
                &SpotBalanceType::Deposit,
                quote_market,
                filler.get_quote_spot_position_mut(),
                false,
            )?;

            filler.update_cumulative_spot_fees(filler_reward.cast()?)?;
        }

        filler_stats.update_filler_volume(quote_asset_amount, now)?;
    }

    // Update base market
    base_market.total_spot_fee = base_market.total_spot_fee.safe_add(fee_to_market.cast()?)?;

    update_spot_balances(
        fee_to_market.cast()?,
        &SpotBalanceType::Deposit,
        quote_market,
        &mut base_market.spot_fee_pool,
        false,
    )?;

    let fill_record_id = get_then_update_id!(base_market, next_fill_record_id);
    let order_action_explanation = if maker.orders[maker_order_index].is_jit_maker() {
        OrderActionExplanation::OrderFilledWithMatchJit
    } else {
        OrderActionExplanation::OrderFilledWithMatch
    };
    let order_action_record = get_order_action_record(
        now,
        OrderAction::Fill,
        order_action_explanation,
        maker.orders[maker_order_index].market_index,
        Some(*filler_key),
        Some(fill_record_id),
        Some(filler_reward),
        Some(base_asset_amount),
        Some(quote_asset_amount.cast()?),
        Some(taker_fee),
        Some(maker_rebate),
        None,
        Some(0),
        Some(0),
        Some(*taker_key),
        Some(taker.orders[taker_order_index]),
        Some(*maker_key),
        Some(maker.orders[maker_order_index]),
        oracle_map.get_price_data(&base_market.oracle)?.price,
    )?;
    emit_stack::<_, { OrderActionRecord::SIZE }>(order_action_record)?;

    // Clear taker/maker order if completely filled
    if taker.orders[taker_order_index].get_base_asset_amount_unfilled(None)? == 0 {
        taker.decrement_open_orders(taker.orders[taker_order_index].has_auction());
        taker.orders[taker_order_index] = Order::default();
        taker.spot_positions[taker_spot_position_index].open_orders -= 1;
    }

    if maker.orders[maker_order_index].get_base_asset_amount_unfilled(None)? == 0 {
        maker.decrement_open_orders(maker.orders[maker_order_index].has_auction());
        maker.orders[maker_order_index] = Order::default();
        maker.spot_positions[maker_spot_position_index].open_orders -= 1;
    }

    Ok((base_asset_amount, quote_asset_amount))
}

pub fn fulfill_spot_order_with_external_market(
    base_market: &mut SpotMarket,
    quote_market: &mut SpotMarket,
    taker: &mut User,
    taker_stats: &mut UserStats,
    taker_order_index: usize,
    taker_key: &Pubkey,
    filler: Option<&mut User>,
    filler_stats: Option<&mut UserStats>,
    filler_key: &Pubkey,
    now: i64,
    slot: u64,
    oracle_map: &mut OracleMap,
    fee_structure: &FeeStructure,
    fulfillment_params: &mut dyn SpotFulfillmentParams,
) -> DriftResult<(u64, u64)> {
    let oracle_price = oracle_map.get_price_data(&base_market.oracle)?.price;
    let taker_price = taker.orders[taker_order_index].get_limit_price(
        Some(oracle_price),
        None,
        slot,
        base_market.order_tick_size,
    )?;
    let taker_token_amount = taker
        .force_get_spot_position_mut(base_market.market_index)?
        .get_signed_token_amount(base_market)?;
    let taker_base_asset_amount = taker.orders[taker_order_index]
        .get_standardized_base_asset_amount_unfilled(
            Some(taker_token_amount.cast()?),
            base_market.order_step_size,
        )?;
    let order_direction = taker.orders[taker_order_index].direction;
    let taker_order_slot = taker.orders[taker_order_index].slot;

    let (max_base_asset_amount, max_quote_asset_amount) =
        get_max_fill_amounts(taker, taker_order_index, base_market, quote_market, true)?;

    let taker_base_asset_amount =
        taker_base_asset_amount.min(max_base_asset_amount.unwrap_or(u64::MAX));

    let (best_bid, best_ask) = fulfillment_params.get_best_bid_and_ask()?;

    let mut mid_price = 0;
    if let Some(best_bid) = best_bid {
        base_market.historical_index_data.last_index_bid_price = best_bid;
        mid_price += best_bid;
    }

    if let Some(best_ask) = best_ask {
        base_market.historical_index_data.last_index_ask_price = best_ask;
        mid_price = if mid_price == 0 {
            best_ask
        } else {
            mid_price.safe_add(best_ask)?.safe_div(2)?
        };
    }

    base_market.historical_index_data.last_index_price_twap = calculate_new_twap(
        mid_price.cast()?,
        now,
        base_market
            .historical_index_data
            .last_index_price_twap
            .cast()?,
        base_market.historical_index_data.last_index_price_twap_ts,
        ONE_HOUR,
    )?
    .cast()?;

    base_market.historical_index_data.last_index_price_twap_5min = calculate_new_twap(
        mid_price.cast()?,
        now,
        base_market
            .historical_index_data
            .last_index_price_twap_5min
            .cast()?,
        base_market.historical_index_data.last_index_price_twap_ts,
        FIVE_MINUTE as i64,
    )?
    .cast()?;

    let taker_price = if let Some(price) = taker_price {
        price
    } else {
        match order_direction {
            PositionDirection::Long => {
                if let Some(ask) = best_ask {
                    ask.safe_add(ask / 100)?
                } else {
                    msg!("External market has no ask");
                    return Ok((0, 0));
                }
            }
            PositionDirection::Short => {
                if let Some(bid) = best_bid {
                    bid.safe_sub(bid / 100)?
                } else {
                    msg!("External market has no bid");
                    return Ok((0, 0));
                }
            }
        }
    };

    let ExternalSpotFill {
        base_asset_amount_filled,
        base_update_direction,
        quote_asset_amount_filled,
        quote_update_direction,
        fee: external_market_fee,
        settled_referrer_rebate,
        unsettled_referrer_rebate,
    } = fulfillment_params.fulfill_order(
        order_direction,
        taker_price,
        taker_base_asset_amount,
        max_quote_asset_amount.unwrap_or(u64::MAX),
    )?;

    if base_asset_amount_filled == 0 {
        return Ok((0, 0));
    }

    update_spot_balances(
        settled_referrer_rebate as u128,
        &SpotBalanceType::Deposit,
        quote_market,
        &mut base_market.spot_fee_pool,
        false,
    )?;

    validate_fill_price(
        quote_asset_amount_filled,
        base_asset_amount_filled,
        base_market.get_precision(),
        order_direction,
        taker_price,
        true,
    )?;

    let fee_pool_amount = get_token_amount(
        base_market.spot_fee_pool.scaled_balance,
        quote_market,
        &SpotBalanceType::Deposit,
    )?;

    let ExternalFillFees {
        user_fee: taker_fee,
        fee_to_market,
        fee_pool_delta,
        filler_reward,
    } = fees::calculate_fee_for_fulfillment_with_external_market(
        taker_stats,
        quote_asset_amount_filled,
        fee_structure,
        taker_order_slot,
        slot,
        filler.is_some(),
        external_market_fee,
        unsettled_referrer_rebate,
        fee_pool_amount.cast()?,
        0,
    )?;

    let quote_spot_position_delta = match quote_update_direction {
        SpotBalanceType::Deposit => quote_asset_amount_filled.safe_sub(taker_fee)?,
        SpotBalanceType::Borrow => quote_asset_amount_filled.safe_add(taker_fee)?,
    };

    validate!(
        base_update_direction
            == taker.orders[taker_order_index].get_spot_position_update_direction(AssetType::Base),
        ErrorCode::FailedToFillOnExternalMarket,
        "Fill on external spot market lead to unexpected to update direction"
    )?;

    let base_update_direction =
        taker.orders[taker_order_index].get_spot_position_update_direction(AssetType::Base);
    update_spot_balances_and_cumulative_deposits(
        base_asset_amount_filled.cast()?,
        &base_update_direction,
        base_market,
        taker.force_get_spot_position_mut(base_market.market_index)?,
        base_update_direction == SpotBalanceType::Borrow,
        None,
    )?;

    validate!(
        quote_update_direction
            == taker.orders[taker_order_index].get_spot_position_update_direction(AssetType::Quote),
        ErrorCode::FailedToFillOnExternalMarket,
        "Fill on external market lead to unexpected to update direction"
    )?;

    let quote_update_direction =
        taker.orders[taker_order_index].get_spot_position_update_direction(AssetType::Quote);
    update_spot_balances_and_cumulative_deposits(
        quote_spot_position_delta.cast()?,
        &quote_update_direction,
        quote_market,
        taker.get_quote_spot_position_mut(),
        quote_update_direction == SpotBalanceType::Borrow,
        Some(quote_asset_amount_filled.cast()?),
    )?;

    taker.update_cumulative_spot_fees(-taker_fee.cast()?)?;

    taker_stats.update_taker_volume_30d(quote_asset_amount_filled.cast()?, now)?;

    taker_stats.increment_total_fees(taker_fee.cast()?)?;

    update_order_after_fill(
        &mut taker.orders[taker_order_index],
        base_asset_amount_filled,
        quote_asset_amount_filled,
    )?;

    let taker_order_direction = taker.orders[taker_order_index].direction;
    decrease_spot_open_bids_and_asks(
        taker.force_get_spot_position_mut(base_market.market_index)?,
        &taker_order_direction,
        base_asset_amount_filled,
    )?;

    if let (Some(filler), Some(filler_stats)) = (filler, filler_stats) {
        if filler_reward > 0 {
            update_spot_balances(
                filler_reward.cast()?,
                &SpotBalanceType::Deposit,
                quote_market,
                filler.get_quote_spot_position_mut(),
                false,
            )?;

            filler.update_cumulative_spot_fees(filler_reward.cast()?)?;
        }

        filler_stats.update_filler_volume(quote_asset_amount_filled.cast()?, now)?;
    }

    if fee_pool_delta != 0 {
        update_spot_balances(
            fee_pool_delta.unsigned_abs().cast()?,
            if fee_pool_delta > 0 {
                &SpotBalanceType::Deposit
            } else {
                &SpotBalanceType::Borrow
            },
            quote_market,
            &mut base_market.spot_fee_pool,
            false,
        )?;
    }

    base_market.total_spot_fee = base_market.total_spot_fee.safe_add(fee_to_market.cast()?)?;

    let fill_record_id = get_then_update_id!(base_market, next_fill_record_id);
    let order_action_record = get_order_action_record(
        now,
        OrderAction::Fill,
        fulfillment_params.get_order_action_explanation()?,
        taker.orders[taker_order_index].market_index,
        Some(*filler_key),
        Some(fill_record_id),
        Some(filler_reward),
        Some(base_asset_amount_filled),
        Some(quote_asset_amount_filled.cast()?),
        Some(taker_fee),
        Some(0),
        None,
        Some(0),
        Some(external_market_fee),
        Some(*taker_key),
        Some(taker.orders[taker_order_index]),
        None,
        None,
        oracle_price,
    )?;
    emit_stack::<_, { OrderActionRecord::SIZE }>(order_action_record)?;

    if taker.orders[taker_order_index].get_base_asset_amount_unfilled(None)? == 0 {
        taker.decrement_open_orders(taker.orders[taker_order_index].has_auction());
        taker.orders[taker_order_index] = Order::default();
        taker
            .force_get_spot_position_mut(base_market.market_index)?
            .open_orders -= 1;
    }

    Ok((base_asset_amount_filled, quote_asset_amount_filled))
}

pub fn trigger_spot_order(
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
        .position(|order| order.order_id == order_id)
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

    validate!(
        !user.orders[order_index].triggered(),
        ErrorCode::OrderNotTriggerable,
        "Order is already triggered"
    )?;

    validate!(
        market_type == MarketType::Spot,
        ErrorCode::InvalidOrderMarketType,
        "Order must be a spot order"
    )?;

    validate_user_not_being_liquidated(
        user,
        perp_market_map,
        spot_market_map,
        oracle_map,
        state.liquidation_margin_buffer_ratio,
    )?;

    validate!(!user.is_bankrupt(), ErrorCode::UserBankrupt)?;

    let spot_market = spot_market_map.get_ref(&market_index)?;
    let (oracle_price_data, oracle_validity) = oracle_map.get_price_data_and_validity(
        &spot_market.oracle,
        spot_market.historical_oracle_data.last_oracle_price_twap,
    )?;
    let strict_oracle_price = StrictOraclePrice {
        current: oracle_price_data.price,
        twap_5min: Some(
            spot_market
                .historical_oracle_data
                .last_oracle_price_twap_5min,
        ),
    };

    validate!(
        is_oracle_valid_for_action(oracle_validity, Some(DriftAction::TriggerOrder))?,
        ErrorCode::InvalidOracle,
        "OracleValidity for spot marketIndex={} invalid for TriggerOrder",
        spot_market.market_index
    )?;

    let oracle_price = oracle_price_data.price;

    let can_trigger = order_satisfies_trigger_condition(
        &user.orders[order_index],
        oracle_price.unsigned_abs().cast()?,
    )?;
    validate!(can_trigger, ErrorCode::OrderDidNotSatisfyTriggerCondition)?;

    let position_index = user.get_spot_position_index(market_index)?;
    let signed_token_amount =
        user.spot_positions[position_index].get_signed_token_amount(&spot_market)?;

    let worst_case_simulation_before = user.spot_positions[position_index]
        .get_worst_case_fill_simulation(
            &spot_market,
            &strict_oracle_price,
            Some(signed_token_amount),
            MarginRequirementType::Initial,
        )?;

    {
        update_trigger_order_params(
            &mut user.orders[order_index],
            oracle_price_data,
            slot,
            30,
            None,
        )?;

        if user.orders[order_index].has_auction() {
            user.increment_open_auctions();
        }

        let direction = user.orders[order_index].direction;
        let base_asset_amount = user.orders[order_index].base_asset_amount;

        let user_position = user.force_get_spot_position_mut(market_index)?;
        increase_spot_open_bids_and_asks(user_position, &direction, base_asset_amount.cast()?)?;
    }

    let is_filler_taker = user_key == filler_key;
    let mut filler = if !is_filler_taker {
        Some(load_mut!(filler)?)
    } else {
        None
    };

    let mut quote_market = spot_market_map.get_quote_spot_market_mut()?;
    let filler_reward = pay_keeper_flat_reward_for_spot(
        user,
        filler.as_deref_mut(),
        &mut quote_market,
        state.spot_fee_structure.flat_filler_fee,
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
    )?;

    emit!(order_action_record);

    let worst_case_simulation_after = user
        .get_spot_position(market_index)?
        .get_worst_case_fill_simulation(
            &spot_market,
            &strict_oracle_price,
            Some(signed_token_amount),
            MarginRequirementType::Initial,
        )?;

    drop(spot_market);
    drop(quote_market);

    let is_risk_increasing =
        worst_case_simulation_before.risk_increasing(worst_case_simulation_after);

    // If order is risk increasing and user is below initial margin, cancel it
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
