use std::cell::RefMut;
use std::cmp::max;
use std::num::NonZeroU64;
use std::ops::{Deref, DerefMut};

use anchor_lang::prelude::*;
use serum_dex::instruction::{NewOrderInstructionV3, SelfTradeBehavior};
use serum_dex::matching::Side;
use solana_program::msg;

use crate::controller;
use crate::controller::funding::settle_funding_payment;
use crate::controller::position;
use crate::controller::position::{
    add_new_position, decrease_open_bids_and_asks, get_position_index, increase_open_bids_and_asks,
    update_lp_market_position, update_position_and_market, update_quote_asset_amount,
    PositionDirection,
};
use crate::controller::serum::{invoke_new_order, invoke_settle_funds, SerumFulfillmentParams};
use crate::controller::spot_balance::{
    transfer_spot_balance_to_revenue_pool, update_spot_balances,
};
use crate::controller::spot_position::{
    decrease_spot_open_bids_and_asks, increase_spot_open_bids_and_asks,
    update_spot_balances_and_cumulative_deposits,
};
use crate::error::ClearingHouseResult;
use crate::error::ErrorCode;
use crate::get_struct_values;
use crate::get_then_update_id;
use crate::instructions::OrderParams;
use crate::load_mut;
use crate::math::auction::{calculate_auction_prices, is_auction_complete};
use crate::math::casting::{cast, cast_to_u64, Cast};
use crate::math::constants::{
    BASE_PRECISION_U64, FIVE_MINUTE, ONE_HOUR, PERP_DECIMALS, QUOTE_SPOT_MARKET_INDEX,
    SPOT_FEE_POOL_TO_REVENUE_POOL_THRESHOLD,
};
use crate::math::fees::{FillFees, SerumFillFees};
use crate::math::fulfillment::{
    determine_perp_fulfillment_methods, determine_spot_fulfillment_methods,
};
use crate::math::liquidation::validate_user_not_being_liquidated;
use crate::math::matching::{
    are_orders_same_market_but_different_sides, calculate_fill_for_matched_orders,
    calculate_filler_multiplier_for_matched_orders, do_orders_cross, is_maker_for_taker,
};
use crate::math::oracle;
use crate::math::oracle::{is_oracle_valid_for_action, DriftAction};
use crate::math::safe_math::SafeMath;
use crate::math::serum::{
    calculate_serum_limit_price, calculate_serum_max_coin_qty,
    calculate_serum_max_native_pc_quantity,
};
use crate::math::spot_balance::get_token_amount;
use crate::math::stats::calculate_new_twap;
use crate::math::{amm, fees, margin::*, orders::*};

use crate::print_error;
use crate::state::events::{emit_stack, get_order_action_record, OrderActionRecord, OrderRecord};
use crate::state::events::{OrderAction, OrderActionExplanation};
use crate::state::fulfillment::{PerpFulfillmentMethod, SpotFulfillmentMethod};
use crate::state::oracle::OraclePriceData;
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::{MarketStatus, PerpMarket};
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::serum::{get_best_bid_and_ask, load_open_orders, load_serum_market};
use crate::state::spot_market::{SpotBalanceType, SpotMarket};
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::state::FeeStructure;
use crate::state::state::*;
use crate::state::user::{AssetType, Order, OrderStatus, OrderType, UserStats};
use crate::state::user::{MarketType, User};
use crate::validate;
use crate::validation;
use crate::validation::order::{validate_order, validate_spot_order};

#[cfg(test)]
mod tests;

#[cfg(test)]
mod amm_jit_tests;

pub fn place_perp_order(
    state: &State,
    user: &AccountLoader<User>,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
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
        perp_market_map,
        spot_market_map,
        oracle_map,
        state.liquidation_margin_buffer_ratio,
    )?;

    validate!(!user.is_bankrupt, ErrorCode::UserBankrupt)?;

    expire_orders(
        user,
        &user_key,
        perp_market_map,
        spot_market_map,
        oracle_map,
        now,
        slot,
    )?;

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
        market.is_active(now)?,
        ErrorCode::MarketActionPaused,
        "Market is in settlement mode",
    )?;

    let position_index = get_position_index(&user.perp_positions, market_index)
        .or_else(|_| add_new_position(&mut user.perp_positions, market_index))?;

    let worst_case_base_asset_amount_before =
        user.perp_positions[position_index].worst_case_base_asset_amount()?;

    // Increment open orders for existing position
    let (existing_position_direction, order_base_asset_amount) = {
        let market_position = &mut user.perp_positions[position_index];
        market_position.open_orders += 1;

        validate!(
            params.base_asset_amount >= market.amm.order_step_size,
            ErrorCode::InvalidOrder,
            "params.base_asset_amount={} cannot be below market.amm.order_step_size={}",
            params.base_asset_amount,
            market.amm.order_step_size
        )?;

        let standardized_base_asset_amount =
            standardize_base_asset_amount(params.base_asset_amount, market.amm.order_step_size)?;

        let base_asset_amount = if params.reduce_only || force_reduce_only {
            calculate_base_asset_amount_for_reduce_only_order(
                standardized_base_asset_amount,
                params.direction,
                market_position.base_asset_amount,
            )?
        } else {
            standardized_base_asset_amount
        };

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

    let oracle_price_data = oracle_map.get_price_data(&market.amm.oracle)?;
    let (auction_start_price, auction_end_price) = if let OrderType::Market = params.order_type {
        let (auction_start_price, auction_end_price) =
            match (params.auction_start_price, params.auction_end_price) {
                (Some(auction_start_price), Some(auction_end_price)) => {
                    (auction_start_price, auction_end_price)
                }
                _ => calculate_auction_prices(oracle_price_data, params.direction, params.price)?,
            };

        (
            standardize_price(
                auction_start_price,
                market.amm.order_tick_size,
                params.direction,
            )?,
            standardize_price(
                auction_end_price,
                market.amm.order_tick_size,
                params.direction,
            )?,
        )
    } else {
        (0_u64, 0_u64)
    };

    validate!(
        params.market_type == MarketType::Perp,
        ErrorCode::InvalidOrder,
        "must be perp order"
    )?;

    let auction_duration = max(
        params.auction_duration.unwrap_or(0),
        state.min_perp_auction_duration,
    );

    let max_ts = params.max_ts.unwrap_or(0);
    validate!(
        max_ts == 0 || max_ts > now,
        ErrorCode::InvalidOrder,
        "max_ts ({}) <= now ({})",
        max_ts,
        now
    )?;

    let new_order = Order {
        status: OrderStatus::Open,
        order_type: params.order_type,
        market_type: params.market_type,
        slot,
        order_id: get_then_update_id!(user, next_order_id),
        user_order_id: params.user_order_id,
        market_index: params.market_index,
        price: standardize_price(params.price, market.amm.order_tick_size, params.direction)?,
        existing_position_direction,
        base_asset_amount: order_base_asset_amount,
        base_asset_amount_filled: 0,
        quote_asset_amount_filled: 0,
        direction: params.direction,
        reduce_only: params.reduce_only || force_reduce_only,
        trigger_price: params.trigger_price.unwrap_or(0),
        trigger_condition: params.trigger_condition,
        triggered: false,
        post_only: params.post_only,
        oracle_price_offset: params.oracle_price_offset.unwrap_or(0),
        immediate_or_cancel: params.immediate_or_cancel,
        auction_start_price,
        auction_end_price,
        auction_duration,
        max_ts,
        padding: [0; 2],
    };

    let valid_oracle_price = get_valid_oracle_price(
        oracle_map.get_price_data(&market.amm.oracle)?,
        market,
        &new_order,
        &state.oracle_guard_rails.validity,
    )?;

    validate_order(&new_order, market, valid_oracle_price, slot)?;

    user.orders[new_order_index] = new_order;

    let worst_case_base_asset_amount_after =
        user.perp_positions[position_index].worst_case_base_asset_amount()?;

    // Order fails if it's risk increasing and it brings the user collateral below the margin requirement
    let risk_decreasing = worst_case_base_asset_amount_after.unsigned_abs()
        <= worst_case_base_asset_amount_before.unsigned_abs();

    let meets_initial_margin_requirement = meets_place_order_margin_requirement(
        user,
        perp_market_map,
        spot_market_map,
        oracle_map,
        risk_decreasing,
    )?;

    if !meets_initial_margin_requirement || (force_reduce_only && !risk_decreasing) {
        return Err(ErrorCode::InvalidOrder);
    }

    let (taker, taker_order, maker, maker_order) =
        get_taker_and_maker_for_order_record(&user_key, &new_order);

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
        taker,
        taker_order,
        maker,
        maker_order,
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
) -> ClearingHouseResult<Vec<u32>> {
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

    Ok(canceled_order_ids)
}

pub fn cancel_order_by_order_id(
    order_id: u32,
    user: &AccountLoader<User>,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    clock: &Clock,
) -> ClearingHouseResult {
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
    )
}

pub fn cancel_order_by_user_order_id(
    user_order_id: u8,
    user: &AccountLoader<User>,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    clock: &Clock,
) -> ClearingHouseResult {
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
    )
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
) -> ClearingHouseResult {
    let (order_status, order_market_index, order_direction, order_market_type) = get_struct_values!(
        user.orders[order_index],
        status,
        market_index,
        direction,
        market_type
    );

    let is_perp_order = order_market_type == MarketType::Perp;

    validate!(order_status == OrderStatus::Open, ErrorCode::OrderNotOpen)?;

    // When save in the record, we want the status to be canceled
    user.orders[order_index].status = OrderStatus::Canceled;

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
        emit_stack::<_, 424>(order_action_record);
    }

    if is_perp_order {
        // Decrement open orders for existing position
        let position_index = get_position_index(&user.perp_positions, order_market_index)?;

        // only decrease open/bids ask if it's not a trigger order or if it's been triggered
        if !user.orders[order_index].must_be_triggered() || user.orders[order_index].triggered {
            let base_asset_amount_unfilled =
                user.orders[order_index].get_base_asset_amount_unfilled()?;
            position::decrease_open_bids_and_asks(
                &mut user.perp_positions[position_index],
                &order_direction,
                cast(base_asset_amount_unfilled)?,
            )?;
        }

        user.perp_positions[position_index].open_orders -= 1;
        user.orders[order_index] = Order::default();
    } else {
        let spot_position_index = user.get_spot_position_index(order_market_index)?;

        // only decrease open/bids ask if it's not a trigger order or if it's been triggered
        if !user.orders[order_index].must_be_triggered() || user.orders[order_index].triggered {
            let base_asset_amount_unfilled =
                user.orders[order_index].get_base_asset_amount_unfilled()?;
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
    maker: Option<&AccountLoader<User>>,
    maker_stats: Option<&AccountLoader<UserStats>>,
    maker_order_id: Option<u32>,
    referrer: Option<&AccountLoader<User>>,
    referrer_stats: Option<&AccountLoader<UserStats>>,
    clock: &Clock,
) -> ClearingHouseResult<(u64, bool)> {
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

    let (order_status, market_index, order_market_type) =
        get_struct_values!(user.orders[order_index], status, market_index, market_type);

    validate!(
        order_market_type == MarketType::Perp,
        ErrorCode::InvalidOrder,
        "must be perp order"
    )?;

    // settle lp position so its tradeable
    let mut market = perp_market_map.get_ref_mut(&market_index)?;
    controller::lp::settle_funding_payment_then_lp(user, &user_key, &mut market, now)?;

    validate!(
        matches!(
            market.status,
            MarketStatus::Active
                | MarketStatus::FundingPaused
                | MarketStatus::ReduceOnly
                | MarketStatus::WithdrawPaused
        ),
        ErrorCode::DefaultError,
        "Market unavailable for fills"
    )?;

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

    if user.is_bankrupt {
        msg!("user is bankrupt");
        return Ok((0, false));
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
            return Ok((0, false));
        }
    }

    let reserve_price_before: u128;
    let oracle_reserve_price_spread_pct_before: i128;
    let is_oracle_valid: bool;
    let oracle_price: i128;
    let market_is_reduce_only: bool;
    let mut amm_is_available = state.exchange_status != ExchangeStatus::AmmPaused;

    {
        let market = &mut perp_market_map.get_ref_mut(&market_index)?;
        market_is_reduce_only = market.is_reduce_only()?;
        amm_is_available &= market.status != MarketStatus::AmmPaused;
        validation::market::validate_perp_market(market)?;
        validate!(
            market.is_active(now)?,
            ErrorCode::MarketActionPaused,
            "Market is in settlement mode",
        )?;

        let oracle_price_data = &oracle_map.get_price_data(&market.amm.oracle)?;
        let oracle_validity = oracle::oracle_validity(
            market.amm.historical_oracle_data.last_oracle_price_twap,
            oracle_price_data,
            &state.oracle_guard_rails.validity,
        )?;

        is_oracle_valid =
            is_oracle_valid_for_action(oracle_validity, Some(DriftAction::FillOrderAmm))?;

        reserve_price_before = market.amm.reserve_price()?;
        oracle_reserve_price_spread_pct_before = amm::calculate_oracle_twap_5min_mark_spread_pct(
            &market.amm,
            Some(reserve_price_before),
        )?;
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
        perp_market_map,
        spot_market_map,
        oracle_map,
        maker,
        maker_stats,
        maker_order_id,
        &user_key,
        &user.orders[order_index],
        &mut filler.as_deref_mut(),
        &filler_key,
        state.perp_fee_structure.flat_filler_fee,
        oracle_price,
        now,
        slot,
    )?;

    let (mut referrer, mut referrer_stats) =
        sanitize_referrer(referrer, referrer_stats, user_stats)?;

    let order_breaches_oracle_price = {
        let market = perp_market_map.get_ref(&market_index)?;
        order_breaches_oracle_price_limits(
            &user.orders[order_index],
            oracle_price,
            slot,
            market.amm.order_tick_size,
            market.margin_ratio_initial as u128,
            market.margin_ratio_maintenance as u128,
        )?
    };

    if order_breaches_oracle_price {
        let filler_reward = pay_keeper_flat_reward_for_perps(
            user,
            filler.as_deref_mut(),
            perp_market_map.get_ref_mut(&market_index)?.deref_mut(),
            state.perp_fee_structure.flat_filler_fee,
        )?;

        cancel_order(
            order_index,
            user.deref_mut(),
            &user_key,
            perp_market_map,
            spot_market_map,
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

    let should_expire_order = should_expire_order(user, order_index, now)?;
    if should_expire_order {
        let filler_reward = {
            let mut market = perp_market_map.get_ref_mut(&market_index)?;
            pay_keeper_flat_reward_for_perps(
                user,
                filler.as_deref_mut(),
                market.deref_mut(),
                state.perp_fee_structure.flat_filler_fee,
            )?
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
            OrderActionExplanation::OrderExpired,
            Some(&filler_key),
            filler_reward,
            false,
        )?;
        return Ok((0, true));
    }

    let (base_asset_amount, potentially_risk_increasing, mut updated_user_state) =
        fulfill_perp_order(
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
            spot_market_map,
            perp_market_map,
            oracle_map,
            &state.perp_fee_structure,
            reserve_price_before,
            valid_oracle_price,
            now,
            slot,
            market_is_reduce_only,
            amm_is_available,
        )?;

    if should_cancel_order_after_fulfill(user, order_index, slot)? {
        updated_user_state = true;

        let filler_reward = {
            let mut market = perp_market_map.get_ref_mut(&market_index)?;
            pay_keeper_flat_reward_for_perps(
                user,
                filler.as_deref_mut(),
                market.deref_mut(),
                state.perp_fee_structure.flat_filler_fee,
            )?
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
            OrderActionExplanation::MarketOrderFilledToLimitPrice,
            Some(&filler_key),
            filler_reward,
            false,
        )?
    }

    if !updated_user_state {
        return Ok((base_asset_amount, updated_user_state));
    }

    {
        let market = perp_market_map.get_ref(&market_index)?;
        validate_market_within_price_band(
            &market,
            state,
            potentially_risk_increasing,
            Some(oracle_reserve_price_spread_pct_before),
        )?;

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
        let funding_paused = matches!(state.exchange_status, ExchangeStatus::FundingPaused)
            || matches!(market.status, MarketStatus::FundingPaused);

        controller::funding::update_funding_rate(
            market_index,
            market,
            oracle_map,
            now,
            &state.oracle_guard_rails,
            funding_paused,
            Some(reserve_price_before),
        )?;
    }

    Ok((base_asset_amount, updated_user_state))
}

pub fn validate_market_within_price_band(
    market: &PerpMarket,
    state: &State,
    potentially_risk_increasing: bool,
    oracle_reserve_price_spread_pct_before: Option<i128>,
) -> ClearingHouseResult<bool> {
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
fn sanitize_maker_order<'a>(
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    maker: Option<&'a AccountLoader<User>>,
    maker_stats: Option<&'a AccountLoader<UserStats>>,
    maker_order_id: Option<u32>,
    taker_key: &Pubkey,
    taker_order: &Order,
    filler: &mut Option<&mut User>,
    filler_key: &Pubkey,
    filler_reward: u64,
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

        if maker.is_being_liquidated || maker.is_bankrupt {
            return Ok((None, None, None, None));
        }

        validate!(
            !maker_order.must_be_triggered() || maker_order.triggered,
            ErrorCode::OrderMustBeTriggeredFirst,
            "Maker order not triggered"
        )?;

        validate!(
            maker_order.market_type == MarketType::Perp,
            ErrorCode::InvalidOrder,
            "Maker order not a perp order"
        )?
    }

    let breaches_oracle_price_limits = {
        let market = perp_market_map.get_ref(&maker.orders[maker_order_index].market_index)?;

        order_breaches_oracle_price_limits(
            &maker.orders[maker_order_index],
            oracle_price,
            slot,
            market.amm.order_tick_size,
            market.margin_ratio_initial as u128,
            market.margin_ratio_maintenance as u128,
        )?
    };

    let should_expire_order = should_expire_order(&maker, maker_order_index, now)?;

    // Dont fulfill with a maker order if oracle has diverged significantly
    if breaches_oracle_price_limits || should_expire_order {
        let filler_reward = {
            let mut market =
                perp_market_map.get_ref_mut(&maker.orders[maker_order_index].market_index)?;
            pay_keeper_flat_reward_for_perps(
                &mut maker,
                filler.as_deref_mut(),
                market.deref_mut(),
                filler_reward,
            )?
        };

        let explanation = if breaches_oracle_price_limits {
            OrderActionExplanation::OraclePriceBreachedLimitPrice
        } else {
            OrderActionExplanation::OrderExpired
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

    let market_index = maker.orders[maker_order_index].market_index;
    settle_funding_payment(
        &mut maker,
        &maker_key,
        perp_market_map.get_ref_mut(&market_index)?.deref_mut(),
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
        referrer.sub_account_id == 0,
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

fn fulfill_perp_order(
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
    spot_market_map: &SpotMarketMap,
    perp_market_map: &PerpMarketMap,
    oracle_map: &mut OracleMap,
    fee_structure: &FeeStructure,
    reserve_price_before: u128,
    valid_oracle_price: Option<i128>,
    now: i64,
    slot: u64,
    market_is_reduce_only: bool,
    amm_is_available: bool,
) -> ClearingHouseResult<(u64, bool, bool)> {
    let market_index = user.orders[user_order_index].market_index;

    let position_index = get_position_index(&user.perp_positions, market_index)?;
    let order_direction = user.orders[user_order_index].direction;
    let position_base_asset_amount_before = user.perp_positions[position_index].base_asset_amount;
    let risk_decreasing = is_order_risk_decreasing(
        &order_direction,
        user.orders[user_order_index].get_base_asset_amount_unfilled()?,
        position_base_asset_amount_before.cast()?,
    )?;

    let free_collateral =
        calculate_free_collateral(user, perp_market_map, spot_market_map, oracle_map)?;
    if !risk_decreasing && (free_collateral < 0 || market_is_reduce_only) {
        cancel_risk_increasing_order(
            user,
            user_order_index,
            user_key,
            filler,
            filler_key,
            perp_market_map,
            spot_market_map,
            oracle_map,
            fee_structure,
            now,
            slot,
        )?;

        return Ok((0, false, true));
    }

    let fulfillment_methods = {
        let market = perp_market_map.get_ref(&market_index)?;

        determine_perp_fulfillment_methods(
            &user.orders[user_order_index],
            if let Some(maker) = maker {
                Some(&maker.orders[maker_order_index.unwrap()])
            } else {
                None
            },
            &market.amm,
            reserve_price_before,
            valid_oracle_price,
            amm_is_available,
            slot,
        )?
    };

    if fulfillment_methods.is_empty() {
        return Ok((0, false, false));
    }

    let mut base_asset_amount = 0_u64;
    let mut quote_asset_amount = 0_u64;
    let mut order_records: Vec<OrderActionRecord> = vec![];
    for fulfillment_method in fulfillment_methods.iter() {
        if user.orders[user_order_index].status != OrderStatus::Open {
            break;
        }
        let mut market = perp_market_map.get_ref_mut(&market_index)?;

        let (fill_base_asset_amount, fill_quote_asset_amount) = match fulfillment_method {
            PerpFulfillmentMethod::AMM(maker_price) => fulfill_perp_order_with_amm(
                user,
                user_stats,
                user_order_index,
                market.deref_mut(),
                oracle_map,
                reserve_price_before,
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
                *maker_price,
                true,
            )?,
            PerpFulfillmentMethod::Match => fulfill_perp_order_with_match(
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
                reserve_price_before,
                valid_oracle_price,
                now,
                slot,
                fee_structure,
                oracle_map,
                &mut order_records,
            )?,
        };

        base_asset_amount = base_asset_amount.safe_add(fill_base_asset_amount)?;
        quote_asset_amount = quote_asset_amount.safe_add(fill_quote_asset_amount)?;
        market.amm.update_volume_24h(
            fill_quote_asset_amount,
            user.orders[user_order_index].direction,
            now,
        )?;
    }

    for order_record in order_records {
        emit!(order_record)
    }

    let (taker_margin_requirement, taker_total_collateral, _, _) =
        calculate_margin_requirement_and_total_collateral(
            user,
            perp_market_map,
            MarginRequirementType::Maintenance,
            spot_market_map,
            oracle_map,
            None,
        )?;
    if taker_total_collateral < taker_margin_requirement.cast()? {
        msg!(
            "taker breached maintenance requirements (margin requirement {}) (total_collateral {})",
            taker_margin_requirement,
            taker_total_collateral
        );
        return Err(ErrorCode::InsufficientCollateral);
    }

    if let Some(maker) = maker {
        let (maker_margin_requirement, maker_total_collateral, _, _) =
            calculate_margin_requirement_and_total_collateral(
                maker,
                perp_market_map,
                MarginRequirementType::Maintenance,
                spot_market_map,
                oracle_map,
                None,
            )?;

        if maker_total_collateral < maker_margin_requirement.cast()? {
            msg!(
            "maker breached maintenance requirements (margin requirement {}) (total_collateral {})",
            maker_margin_requirement,
            maker_total_collateral
        );
            return Err(ErrorCode::InsufficientCollateral);
        }
    }

    let position_base_asset_amount_after = user.perp_positions[position_index].base_asset_amount;
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
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    fee_structure: &FeeStructure,
    now: i64,
    slot: u64,
) -> ClearingHouseResult {
    let market_index = user.orders[user_order_index].market_index;
    let filler_reward = {
        let mut market = perp_market_map.get_ref_mut(&market_index)?;
        pay_keeper_flat_reward_for_perps(
            user,
            filler.as_deref_mut(),
            market.deref_mut(),
            fee_structure.flat_filler_fee,
        )?
    };

    cancel_order(
        user_order_index,
        user,
        user_key,
        perp_market_map,
        spot_market_map,
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

pub fn fulfill_perp_order_with_amm(
    user: &mut User,
    user_stats: &mut UserStats,
    order_index: usize,
    market: &mut PerpMarket,
    oracle_map: &mut OracleMap,
    reserve_price_before: u128,
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
    override_base_asset_amount: Option<u64>,
    override_fill_price: Option<u128>,
    split_with_lps: bool,
) -> ClearingHouseResult<(u64, u64)> {
    // Determine the base asset amount the market can fill
    let (base_asset_amount, limit_price, fill_price) = match override_base_asset_amount {
        Some(override_base_asset_amount) => {
            let limit_price = user.orders[order_index].get_optional_limit_price(
                valid_oracle_price,
                slot,
                market.amm.order_tick_size,
            )?;

            (override_base_asset_amount, limit_price, override_fill_price)
        }
        None => {
            let (base_asset_amount, limit_price) = calculate_base_asset_amount_for_amm_to_fulfill(
                &user.orders[order_index],
                market,
                valid_oracle_price,
                slot,
                override_fill_price,
            )?;

            let fill_price = if user.orders[order_index].post_only {
                limit_price
            } else {
                None
            };

            (base_asset_amount, limit_price, fill_price)
        }
    };

    if base_asset_amount == 0 {
        // if is an actual swap (and not amm jit order) then msg!
        if override_base_asset_amount.is_none() {
            msg!("Amm cant fulfill order");
        }
        return Ok((0, 0));
    }

    let position_index = get_position_index(&user.perp_positions, market.market_index)?;

    let (order_post_only, order_slot, order_direction) =
        get_struct_values!(user.orders[order_index], post_only, slot, direction);

    validation::market::validate_amm_account_for_fill(&market.amm, order_direction)?;

    let market_side_price = match order_direction {
        PositionDirection::Long => market.amm.ask_price(reserve_price_before)?,
        PositionDirection::Short => market.amm.bid_price(reserve_price_before)?,
    };

    let sanitize_clamp_denominator = market.get_sanitize_clamp_denominator()?;
    amm::update_mark_twap(
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

    let reward_referrer = referrer.is_some()
        && referrer_stats.is_some()
        && referrer
            .as_mut()
            .unwrap()
            .force_get_perp_position_mut(market.market_index)
            .is_ok();

    let FillFees {
        user_fee,
        fee_to_market,
        filler_reward,
        referee_discount,
        referrer_reward,
        fee_to_market_for_lp,
        ..
    } = fees::calculate_fee_for_fulfillment_with_amm(
        user_stats,
        quote_asset_amount,
        fee_structure,
        order_slot,
        slot,
        filler.is_some(),
        reward_referrer,
        referrer_stats,
        quote_asset_amount_surplus,
        order_post_only,
    )?;

    let user_position_delta =
        get_position_delta_for_fill(base_asset_amount, quote_asset_amount, order_direction)?;

    if split_with_lps {
        update_lp_market_position(market, &user_position_delta, fee_to_market_for_lp.cast()?)?;
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

    // Increment the clearing house's total fee variables
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

    controller::position::update_quote_asset_amount(
        &mut user.perp_positions[position_index],
        market,
        -user_fee.cast()?,
    )?;

    if order_post_only {
        user_stats.update_maker_volume_30d(quote_asset_amount, now)?;
    } else {
        user_stats.update_taker_volume_30d(quote_asset_amount, now)?;
    }

    if let Some(filler) = filler.as_mut() {
        let position_index = get_position_index(&filler.perp_positions, market.market_index)
            .or_else(|_| add_new_position(&mut filler.perp_positions, market.market_index))?;

        controller::position::update_quote_asset_amount(
            &mut filler.perp_positions[position_index],
            market,
            filler_reward.cast()?,
        )?;

        filler_stats
            .as_mut()
            .unwrap()
            .update_filler_volume(quote_asset_amount, now)?;
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
    let order_action_record = get_order_action_record(
        now,
        OrderAction::Fill,
        OrderActionExplanation::OrderFilledWithAMM,
        market.market_index,
        Some(*filler_key),
        Some(fill_record_id),
        Some(filler_reward),
        Some(base_asset_amount),
        Some(quote_asset_amount),
        Some(user_fee),
        None,
        Some(referrer_reward),
        Some(quote_asset_amount_surplus),
        None,
        taker,
        taker_order,
        maker,
        maker_order,
        oracle_map.get_price_data(&market.amm.oracle)?.price,
    )?;
    order_records.push(order_action_record);

    // Cant reset order until after its logged
    if user.orders[order_index].get_base_asset_amount_unfilled()? == 0 {
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
    maker_stats: &mut UserStats,
    maker_order_index: usize,
    maker_key: &Pubkey,
    filler: &mut Option<&mut User>,
    filler_stats: &mut Option<&mut UserStats>,
    filler_key: &Pubkey,
    referrer: &mut Option<&mut User>,
    referrer_stats: &mut Option<&mut UserStats>,
    reserve_price_before: u128,
    valid_oracle_price: Option<i128>,
    now: i64,
    slot: u64,
    fee_structure: &FeeStructure,
    oracle_map: &mut OracleMap,
    order_records: &mut Vec<OrderActionRecord>,
) -> ClearingHouseResult<(u64, u64)> {
    if !are_orders_same_market_but_different_sides(
        &maker.orders[maker_order_index],
        &taker.orders[taker_order_index],
    ) {
        return Ok((0_u64, 0_u64));
    }

    let oracle_price = oracle_map.get_price_data(&market.amm.oracle)?.price;
    let taker_price = taker.orders[taker_order_index].get_limit_price(
        Some(oracle_price),
        slot,
        market.amm.order_tick_size,
    )?;
    let taker_direction = taker.orders[taker_order_index].direction;
    let taker_base_asset_amount =
        taker.orders[taker_order_index].get_base_asset_amount_unfilled()?;

    let maker_price = maker.orders[maker_order_index].get_limit_price(
        Some(oracle_price),
        slot,
        market.amm.order_tick_size,
    )?;
    let maker_direction = maker.orders[maker_order_index].direction;
    let maker_base_asset_amount =
        maker.orders[maker_order_index].get_base_asset_amount_unfilled()?;

    let orders_cross = do_orders_cross(maker_direction, maker_price, taker_price);

    if !orders_cross {
        return Ok((0_u64, 0_u64));
    }

    let (base_asset_amount, _) = calculate_fill_for_matched_orders(
        maker_base_asset_amount,
        maker_price,
        taker_base_asset_amount,
        PERP_DECIMALS,
        maker_direction,
    )?;

    if base_asset_amount == 0 {
        return Ok((0_u64, 0_u64));
    }

    let sanitize_clamp_denominator = market.get_sanitize_clamp_denominator()?;
    amm::update_mark_twap(
        &mut market.amm,
        now,
        Some(maker_price),
        Some(taker_direction),
        sanitize_clamp_denominator,
    )?;

    let amm_wants_to_make = match taker_direction {
        PositionDirection::Long => market.amm.base_asset_amount_with_amm < 0,
        PositionDirection::Short => market.amm.base_asset_amount_with_amm > 0,
    };

    let mut total_quote_asset_amount = 0_u64;
    let base_asset_amount_left_to_fill = if amm_wants_to_make && market.amm.amm_jit_is_active() {
        let jit_base_asset_amount = crate::math::amm_jit::calculate_jit_base_asset_amount(
            market,
            base_asset_amount,
            taker_price,
            valid_oracle_price,
            taker_direction,
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
                    false,             // dont split with the lps
                )?;

            total_quote_asset_amount = quote_asset_amount_filled_by_amm;

            base_asset_amount.safe_sub(base_asset_amount_filled_by_amm)?
        } else {
            base_asset_amount
        }
    } else {
        base_asset_amount
    };

    let taker_base_asset_amount =
        taker.orders[taker_order_index].get_base_asset_amount_unfilled()?;

    let (base_asset_amount_fulfilled, quote_asset_amount) = calculate_fill_for_matched_orders(
        base_asset_amount_left_to_fill,
        maker_price,
        taker_base_asset_amount,
        PERP_DECIMALS,
        maker_direction,
    )?;

    validate_fill_price(
        quote_asset_amount,
        base_asset_amount_fulfilled,
        BASE_PRECISION_U64,
        taker_direction,
        taker_price,
        true,
    )?;
    validate_fill_price(
        quote_asset_amount,
        base_asset_amount_fulfilled,
        BASE_PRECISION_U64,
        maker_direction,
        maker_price,
        false,
    )?;

    total_quote_asset_amount = total_quote_asset_amount.safe_add(quote_asset_amount)?;

    let maker_position_index = get_position_index(
        &maker.perp_positions,
        maker.orders[maker_order_index].market_index,
    )?;

    let maker_position_delta = get_position_delta_for_fill(
        base_asset_amount_left_to_fill,
        quote_asset_amount,
        maker.orders[maker_order_index].direction,
    )?;

    update_position_and_market(
        &mut maker.perp_positions[maker_position_index],
        market,
        &maker_position_delta,
    )?;

    maker_stats.update_maker_volume_30d(quote_asset_amount, now)?;

    let taker_position_index = get_position_index(
        &taker.perp_positions,
        taker.orders[taker_order_index].market_index,
    )?;

    let taker_position_delta = get_position_delta_for_fill(
        base_asset_amount_left_to_fill,
        quote_asset_amount,
        taker.orders[taker_order_index].direction,
    )?;

    update_position_and_market(
        &mut taker.perp_positions[taker_position_index],
        market,
        &taker_position_delta,
    )?;

    taker_stats.update_taker_volume_30d(quote_asset_amount, now)?;

    let reward_referrer = referrer.is_some()
        && referrer_stats.is_some()
        && referrer
            .as_mut()
            .unwrap()
            .force_get_perp_position_mut(market.market_index)
            .is_ok();

    let filler_multiplier = if filler.is_some() {
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

    controller::position::update_quote_asset_amount(
        &mut taker.perp_positions[taker_position_index],
        market,
        -taker_fee.cast()?,
    )?;

    taker_stats.increment_total_fees(taker_fee)?;
    taker_stats.increment_total_referee_discount(referee_discount)?;

    controller::position::update_quote_asset_amount(
        &mut maker.perp_positions[maker_position_index],
        market,
        maker_rebate.cast()?,
    )?;

    maker_stats.increment_total_rebate(maker_rebate)?;

    if let Some(filler) = filler {
        let filler_position_index = get_position_index(&filler.perp_positions, market.market_index)
            .or_else(|_| add_new_position(&mut filler.perp_positions, market.market_index))?;

        controller::position::update_quote_asset_amount(
            &mut filler.perp_positions[filler_position_index],
            market,
            filler_reward.cast()?,
        )?;

        filler_stats
            .as_mut()
            .unwrap()
            .update_filler_volume(quote_asset_amount, now)?;
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
        base_asset_amount_left_to_fill,
        quote_asset_amount,
    )?;

    decrease_open_bids_and_asks(
        &mut taker.perp_positions[taker_position_index],
        &taker.orders[taker_order_index].direction,
        base_asset_amount_left_to_fill,
    )?;

    update_order_after_fill(
        &mut maker.orders[maker_order_index],
        base_asset_amount_left_to_fill,
        quote_asset_amount,
    )?;

    decrease_open_bids_and_asks(
        &mut maker.perp_positions[maker_position_index],
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
        Some(base_asset_amount_left_to_fill),
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
    order_records.push(order_action_record);

    if taker.orders[taker_order_index].get_base_asset_amount_unfilled()? == 0 {
        taker.orders[taker_order_index] = Order::default();
        let market_position = &mut taker.perp_positions[taker_position_index];
        market_position.open_orders -= 1;
    }

    if maker.orders[maker_order_index].get_base_asset_amount_unfilled()? == 0 {
        maker.orders[maker_order_index] = Order::default();
        let market_position = &mut maker.perp_positions[maker_position_index];
        market_position.open_orders -= 1;
    }

    Ok((base_asset_amount, total_quote_asset_amount))
}

pub fn update_order_after_fill(
    order: &mut Order,
    base_asset_amount: u64,
    quote_asset_amount: u64,
) -> ClearingHouseResult {
    order.base_asset_amount_filled = order.base_asset_amount_filled.safe_add(base_asset_amount)?;

    order.quote_asset_amount_filled = order
        .quote_asset_amount_filled
        .safe_add(quote_asset_amount)?;

    if order.get_base_asset_amount_unfilled()? == 0 {
        order.status = OrderStatus::Filled;
    }

    Ok(())
}

fn get_valid_oracle_price(
    oracle_price_data: &OraclePriceData,
    market: &PerpMarket,
    order: &Order,
    validity_guardrails: &ValidityGuardRails,
) -> ClearingHouseResult<Option<i128>> {
    let price = {
        let oracle_validity = oracle::oracle_validity(
            market.amm.historical_oracle_data.last_oracle_price_twap,
            oracle_price_data,
            validity_guardrails,
        )?;

        let is_oracle_valid =
            is_oracle_valid_for_action(oracle_validity, Some(DriftAction::FillOrderAmm))?;

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
        market_type == MarketType::Perp,
        ErrorCode::InvalidOrder,
        "Order must be a perp order"
    )?;

    validate_user_not_being_liquidated(
        user,
        perp_market_map,
        spot_market_map,
        oracle_map,
        state.liquidation_margin_buffer_ratio,
    )?;

    validate!(!user.is_bankrupt, ErrorCode::UserBankrupt)?;

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

    let order_slot = user.orders[order_index].slot;
    let auction_duration = user.orders[order_index].auction_duration;
    validate!(
        is_auction_complete(order_slot, auction_duration, slot)?,
        ErrorCode::OrderDidNotSatisfyTriggerCondition,
        "Auction duration must elapse before triggering"
    )?;

    let can_trigger = order_satisfies_trigger_condition(
        &user.orders[order_index],
        cast(oracle_price.unsigned_abs())?,
    );
    validate!(can_trigger, ErrorCode::OrderDidNotSatisfyTriggerCondition)?;

    {
        let direction = user.orders[order_index].direction;
        let base_asset_amount = user.orders[order_index].base_asset_amount;

        user.orders[order_index].triggered = true;
        user.orders[order_index].slot = slot;
        let order_type = user.orders[order_index].order_type;
        if let OrderType::TriggerMarket = order_type {
            let (auction_start_price, auction_end_price) =
                calculate_auction_prices(oracle_price_data, direction, 0)?;
            user.orders[order_index].auction_start_price = auction_start_price;
            user.orders[order_index].auction_end_price = auction_end_price;
        }

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

    // If order is risk increasing and user is below initial margin, cancel it
    let order_direction = user.orders[order_index].direction;
    let order_base_asset_amount = user.orders[order_index].base_asset_amount;
    let position_base_asset_amount = user
        .force_get_perp_position_mut(market_index)?
        .base_asset_amount;
    let is_risk_increasing = is_order_risk_increasing(
        &order_direction,
        order_base_asset_amount,
        position_base_asset_amount,
    )?;

    let meets_initial_margin_requirement =
        meets_initial_margin_requirement(user, perp_market_map, spot_market_map, oracle_map)?;

    if is_risk_increasing && !meets_initial_margin_requirement {
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

    Ok(())
}

pub fn pay_keeper_flat_reward_for_perps(
    user: &mut User,
    filler: Option<&mut User>,
    market: &mut PerpMarket,
    filler_reward: u64,
) -> ClearingHouseResult<u64> {
    let filler_reward = if let Some(filler) = filler {
        let user_position = user.get_perp_position_mut(market.market_index)?;
        controller::position::update_quote_asset_amount(
            user_position,
            market,
            -filler_reward.cast()?,
        )?;

        let filler_position = filler.force_get_perp_position_mut(market.market_index)?;
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
) -> ClearingHouseResult<u64> {
    let filler_reward = if let Some(filler) = filler {
        update_spot_balances(
            filler_reward as u128,
            &SpotBalanceType::Deposit,
            quote_market,
            filler.get_quote_spot_position_mut(),
            false,
        )?;

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
    user: &AccountLoader<User>,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
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
        perp_market_map,
        spot_market_map,
        oracle_map,
        state.liquidation_margin_buffer_ratio,
    )?;

    validate!(!user.is_bankrupt, ErrorCode::UserBankrupt)?;

    expire_orders(
        user,
        &user_key,
        perp_market_map,
        spot_market_map,
        oracle_map,
        now,
        slot,
    )?;

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
    let force_reduce_only = spot_market.is_reduce_only()?;

    let spot_position_index = user
        .get_spot_position_index(market_index)
        .or_else(|_| user.add_spot_position(market_index, SpotBalanceType::Deposit))?;

    let oracle_price_data = *oracle_map.get_price_data(&spot_market.oracle)?;
    let (worst_case_token_amount_before, _) = user.spot_positions[spot_position_index]
        .get_worst_case_token_amounts(spot_market, &oracle_price_data, None)?;

    let signed_token_amount = user.spot_positions[spot_position_index]
        .get_signed_token_amount(spot_market)?
        .cast::<i64>()?;

    // Increment open orders for existing position
    let (existing_position_direction, order_base_asset_amount) = {
        let spot_position = &mut user.spot_positions[spot_position_index];
        spot_position.open_orders += 1;

        validate!(
            params.base_asset_amount >= spot_market.order_step_size,
            ErrorCode::InvalidOrder,
            "params.base_asset_amount={} cannot be below spot_market.order_step_size={}",
            params.base_asset_amount,
            spot_market.order_step_size
        )?;

        let standardized_base_asset_amount =
            standardize_base_asset_amount(params.base_asset_amount, spot_market.order_step_size)?;

        let base_asset_amount = if params.reduce_only || force_reduce_only {
            calculate_base_asset_amount_for_reduce_only_order(
                standardized_base_asset_amount,
                params.direction,
                signed_token_amount,
            )?
        } else {
            standardized_base_asset_amount
        };

        validate!(
            is_multiple_of_step_size(base_asset_amount, spot_market.order_step_size)?,
            ErrorCode::InvalidOrder,
            "Order base asset amount ({}), is not a multiple of step size ({})",
            base_asset_amount,
            spot_market.order_step_size
        )?;

        if !matches!(
            &params.order_type,
            OrderType::TriggerMarket | OrderType::TriggerLimit
        ) {
            increase_spot_open_bids_and_asks(spot_position, &params.direction, base_asset_amount)?;
        }

        let existing_position_direction = if signed_token_amount >= 0 {
            PositionDirection::Long
        } else {
            PositionDirection::Short
        };
        (existing_position_direction, cast_to_u64(base_asset_amount)?)
    };

    let (auction_start_price, auction_end_price) = if let OrderType::Market = params.order_type {
        let (auction_start_price, auction_end_price) =
            match (params.auction_start_price, params.auction_end_price) {
                (Some(auction_start_price), Some(auction_end_price)) => {
                    (auction_start_price, auction_end_price)
                }
                _ => calculate_auction_prices(&oracle_price_data, params.direction, params.price)?,
            };

        (
            standardize_price(
                auction_start_price,
                spot_market.order_tick_size,
                params.direction,
            )?,
            standardize_price(
                auction_end_price,
                spot_market.order_tick_size,
                params.direction,
            )?,
        )
    } else {
        (0_u64, 0_u64)
    };

    validate!(
        params.market_index != QUOTE_SPOT_MARKET_INDEX,
        ErrorCode::InvalidOrder,
        "can not place order for quote asset"
    )?;

    validate!(
        params.market_type == MarketType::Spot,
        ErrorCode::InvalidOrder,
        "must be spot order"
    )?;

    let auction_duration = params
        .auction_duration
        .unwrap_or(state.default_spot_auction_duration);

    let max_ts = params.max_ts.unwrap_or(0);
    validate!(
        max_ts == 0 || max_ts > now,
        ErrorCode::InvalidOrder,
        "max_ts ({}) <= now ({})",
        max_ts,
        now
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
        trigger_price: params.trigger_price.unwrap_or(0),
        trigger_condition: params.trigger_condition,
        triggered: false,
        post_only: params.post_only,
        oracle_price_offset: params.oracle_price_offset.unwrap_or(0),
        immediate_or_cancel: params.immediate_or_cancel,
        auction_start_price,
        auction_end_price,
        auction_duration,
        max_ts,
        padding: [0; 2],
    };

    let valid_oracle_price = Some(oracle_price_data.price);
    validate_spot_order(
        &new_order,
        valid_oracle_price,
        slot,
        spot_market.order_step_size,
        spot_market.order_tick_size,
        spot_market.get_margin_ratio(&MarginRequirementType::Initial)?,
        spot_market.get_margin_ratio(&MarginRequirementType::Maintenance)?,
        spot_market.min_order_size,
    )?;

    user.orders[new_order_index] = new_order;

    let (worst_case_token_amount_after, _) = user.spot_positions[spot_position_index]
        .get_worst_case_token_amounts(spot_market, &oracle_price_data, None)?;

    // Order fails if it's risk increasing and it brings the user collateral below the margin requirement
    let risk_decreasing = worst_case_token_amount_after.unsigned_abs()
        <= worst_case_token_amount_before.unsigned_abs();

    let meets_initial_margin_requirement = meets_place_order_margin_requirement(
        user,
        perp_market_map,
        spot_market_map,
        oracle_map,
        risk_decreasing,
    )?;

    if !meets_initial_margin_requirement || (force_reduce_only && !risk_decreasing) {
        return Err(ErrorCode::InvalidOrder);
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
    emit!(order_action_record);

    let order_record = OrderRecord {
        ts: now,
        user: user_key,
        order: user.orders[new_order_index],
    };
    emit!(order_record);

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
    serum_fulfillment_params: Option<SerumFulfillmentParams>,
) -> ClearingHouseResult<u64> {
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

    let (order_status, order_market_index, order_market_type) =
        get_struct_values!(user.orders[order_index], status, market_index, market_type);

    {
        let spot_market = spot_market_map.get_ref(&order_market_index)?;
        validate!(
            matches!(
                spot_market.status,
                MarketStatus::Active
                    | MarketStatus::FundingPaused
                    | MarketStatus::ReduceOnly
                    | MarketStatus::WithdrawPaused
            ),
            ErrorCode::MarketActionPaused,
            "Market unavailable for fills"
        )?;
    }

    validate!(
        order_market_type == MarketType::Spot,
        ErrorCode::InvalidOrder,
        "must be spot order"
    )?;

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

    if user.is_bankrupt {
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

    // TODO SPOT do we need before and after oracle guardrail checks?

    let is_filler_taker = user_key == filler_key;
    let is_filler_maker = maker.map_or(false, |maker| maker.key() == filler_key);
    let (mut filler, mut filler_stats) = if !is_filler_maker && !is_filler_taker {
        (Some(load_mut!(filler)?), Some(load_mut!(filler_stats)?))
    } else {
        (None, None)
    };

    let (mut maker, mut maker_stats, maker_key, maker_order_index) = sanitize_spot_maker_order(
        perp_market_map,
        spot_market_map,
        oracle_map,
        maker,
        maker_stats,
        maker_order_id,
        &user_key,
        &user.orders[order_index],
        &mut filler.as_deref_mut(),
        &filler_key,
        state.spot_fee_structure.flat_filler_fee,
        now,
        slot,
    )?;

    let should_expire_order = should_expire_order(user, order_index, now)?;
    if should_expire_order {
        let filler_reward = {
            let mut quote_market = spot_market_map.get_quote_spot_market_mut()?;
            pay_keeper_flat_reward_for_spot(
                user,
                filler.as_deref_mut(),
                &mut quote_market,
                state.spot_fee_structure.flat_filler_fee,
            )?
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
            OrderActionExplanation::OrderExpired,
            Some(&filler_key),
            filler_reward,
            false,
        )?;
        return Ok(0);
    }

    let (base_asset_amount, _updated_user_state) = fulfill_spot_order(
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
        serum_fulfillment_params,
    )?;

    if should_cancel_order_after_fulfill(user, order_index, slot)? {
        let filler_reward = {
            let mut quote_market = spot_market_map.get_quote_spot_market_mut()?;
            pay_keeper_flat_reward_for_spot(
                user,
                filler.as_deref_mut(),
                &mut quote_market,
                state.spot_fee_structure.flat_filler_fee,
            )?
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
            OrderActionExplanation::MarketOrderFilledToLimitPrice,
            Some(&filler_key),
            filler_reward,
            false,
        )?
    }

    // TODO SPOT check if we need to check oracle guardrails

    Ok(base_asset_amount)
}

#[allow(clippy::type_complexity)]
fn sanitize_spot_maker_order<'a>(
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    maker: Option<&'a AccountLoader<User>>,
    maker_stats: Option<&'a AccountLoader<UserStats>>,
    maker_order_id: Option<u32>,
    taker_key: &Pubkey,
    taker_order: &Order,
    filler: &mut Option<&mut User>,
    filler_key: &Pubkey,
    filler_reward: u64,
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

        if maker.is_being_liquidated || maker.is_bankrupt {
            return Ok((None, None, None, None));
        }

        validate!(
            !maker_order.must_be_triggered() || maker_order.triggered,
            ErrorCode::OrderMustBeTriggeredFirst,
            "Maker order not triggered"
        )?;

        validate!(
            maker_order.market_type == MarketType::Spot,
            ErrorCode::InvalidOrder,
            "Maker order not a spot order"
        )?
    }

    let breaches_oracle_price_limits = {
        let spot_market = spot_market_map.get_ref(&maker.orders[maker_order_index].market_index)?;
        let oracle_price = oracle_map.get_price_data(&spot_market.oracle)?;
        let initial_margin_ratio = spot_market.get_margin_ratio(&MarginRequirementType::Initial)?;
        let maintenance_margin_ratio =
            spot_market.get_margin_ratio(&MarginRequirementType::Maintenance)?;
        order_breaches_oracle_price_limits(
            &maker.orders[maker_order_index],
            oracle_price.price,
            slot,
            spot_market.order_tick_size,
            initial_margin_ratio,
            maintenance_margin_ratio,
        )?
    };

    let should_expire_order = should_expire_order(&maker, maker_order_index, now)?;

    if breaches_oracle_price_limits || should_expire_order {
        let filler_reward = {
            let mut quote_market = spot_market_map.get_quote_spot_market_mut()?;
            pay_keeper_flat_reward_for_spot(
                &mut maker,
                filler.as_deref_mut(),
                &mut quote_market,
                filler_reward,
            )?
        };

        let explanation = if breaches_oracle_price_limits {
            OrderActionExplanation::OraclePriceBreachedLimitPrice
        } else {
            OrderActionExplanation::OrderExpired
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
        Some(maker_stats),
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
    mut serum_fulfillment_params: Option<SerumFulfillmentParams>,
) -> ClearingHouseResult<(u64, bool)> {
    let free_collateral =
        calculate_free_collateral(user, perp_market_map, spot_market_map, oracle_map)?;

    let base_market = user.orders[user_order_index].market_index;
    let spot_position_index = user.get_spot_position_index(base_market)?;
    let token_amount = user.spot_positions[spot_position_index]
        .get_token_amount(spot_market_map.get_ref(&base_market)?.deref())?;
    let spot_balance_type: SpotBalanceType = user.spot_positions[spot_position_index].balance_type;

    let risk_decreasing = is_spot_order_risk_decreasing(
        &user.orders[user_order_index],
        &spot_balance_type,
        token_amount,
    )?;

    if free_collateral < 0 && !risk_decreasing {
        let filler_reward = {
            let mut quote_market = spot_market_map.get_quote_spot_market_mut()?;
            pay_keeper_flat_reward_for_spot(
                user,
                filler.as_deref_mut(),
                &mut quote_market,
                fee_structure.flat_filler_fee,
            )?
        };

        cancel_order(
            user_order_index,
            user,
            user_key,
            perp_market_map,
            spot_market_map,
            oracle_map,
            now,
            slot,
            OrderActionExplanation::InsufficientFreeCollateral,
            Some(filler_key),
            filler_reward,
            false,
        )?;

        return Ok((0, true));
    }

    let fulfillment_methods = determine_spot_fulfillment_methods(
        &user.orders[user_order_index],
        maker.is_some(),
        serum_fulfillment_params.is_some(),
    )?;

    let mut quote_market = spot_market_map.get_quote_spot_market_mut()?;
    let mut base_market = spot_market_map.get_ref_mut(&base_market)?;

    let mut order_records: Vec<OrderActionRecord> = vec![];
    let mut base_asset_amount = 0_u64;
    for fulfillment_method in fulfillment_methods.iter() {
        if user.orders[user_order_index].status != OrderStatus::Open {
            break;
        }

        let _base_asset_amount = match fulfillment_method {
            SpotFulfillmentMethod::Match => fulfill_spot_order_with_match(
                &mut base_market,
                &mut quote_market,
                user,
                user_stats,
                user_order_index,
                user_key,
                maker.as_deref_mut().unwrap(),
                maker_stats.as_deref_mut().unwrap(),
                maker_order_index.unwrap(),
                maker_key.unwrap(),
                filler.as_deref_mut(),
                filler_stats.as_deref_mut(),
                filler_key,
                now,
                slot,
                oracle_map,
                fee_structure,
                &mut order_records,
            )?,
            SpotFulfillmentMethod::SerumV3 => fulfill_spot_order_with_serum(
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
                &mut order_records,
                &mut serum_fulfillment_params,
            )?,
        };

        base_asset_amount = base_asset_amount.safe_add(_base_asset_amount)?;
    }

    drop(base_market);
    drop(quote_market);

    for order_record in order_records {
        emit!(order_record)
    }

    let (taker_margin_requirement, taker_total_collateral, _, _) =
        calculate_margin_requirement_and_total_collateral(
            user,
            perp_market_map,
            MarginRequirementType::Maintenance,
            spot_market_map,
            oracle_map,
            None,
        )?;

    if taker_total_collateral < taker_margin_requirement.cast()? {
        msg!(
            "taker breached maintenance requirements (margin requirement {}) (total_collateral {})",
            taker_margin_requirement,
            taker_total_collateral
        );
        return Err(ErrorCode::InsufficientCollateral);
    }

    if let Some(maker) = maker {
        let (maker_margin_requirement, maker_total_collateral, _, _) =
            calculate_margin_requirement_and_total_collateral(
                maker,
                perp_market_map,
                MarginRequirementType::Maintenance,
                spot_market_map,
                oracle_map,
                None,
            )?;

        if maker_total_collateral < maker_margin_requirement.cast()? {
            msg!(
            "maker breached maintenance requirements (margin requirement {}) (total_collateral {})",
            maker_margin_requirement,
            maker_total_collateral
        );
            return Err(ErrorCode::InsufficientCollateral);
        }
    }

    Ok((base_asset_amount, base_asset_amount != 0))
}

pub fn fulfill_spot_order_with_match(
    base_market: &mut SpotMarket,
    quote_market: &mut SpotMarket,
    taker: &mut User,
    taker_stats: &mut UserStats,
    taker_order_index: usize,
    taker_key: &Pubkey,
    maker: &mut User,
    maker_stats: &mut UserStats,
    maker_order_index: usize,
    maker_key: &Pubkey,
    filler: Option<&mut User>,
    filler_stats: Option<&mut UserStats>,
    filler_key: &Pubkey,
    now: i64,
    slot: u64,
    oracle_map: &mut OracleMap,
    fee_structure: &FeeStructure,
    order_records: &mut Vec<OrderActionRecord>,
) -> ClearingHouseResult<u64> {
    if !are_orders_same_market_but_different_sides(
        &maker.orders[maker_order_index],
        &taker.orders[taker_order_index],
    ) {
        return Ok(0_u64);
    }

    let market_index = taker.orders[taker_order_index].market_index;
    let oracle_price = oracle_map.get_price_data(&base_market.oracle)?.price;
    let taker_price = taker.orders[taker_order_index].get_limit_price(
        Some(oracle_price),
        slot,
        base_market.order_tick_size,
    )?;
    let taker_base_asset_amount =
        taker.orders[taker_order_index].get_base_asset_amount_unfilled()?;
    let taker_order_slot = taker.orders[taker_order_index].slot;
    let taker_spot_position_index = taker.get_spot_position_index(market_index)?;
    let taker_direction = taker.orders[taker_order_index].direction;

    let maker_price = maker.orders[maker_order_index].get_limit_price(
        Some(oracle_price),
        slot,
        base_market.order_tick_size,
    )?;
    let maker_direction = maker.orders[maker_order_index].direction;
    let maker_base_asset_amount =
        maker.orders[maker_order_index].get_base_asset_amount_unfilled()?;
    let maker_spot_position_index = maker.get_spot_position_index(market_index)?;

    let orders_cross = do_orders_cross(maker_direction, maker_price, taker_price);

    if !orders_cross {
        return Ok(0_u64);
    }

    let (base_asset_amount, quote_asset_amount) = calculate_fill_for_matched_orders(
        maker_base_asset_amount,
        maker_price,
        taker_base_asset_amount,
        base_market.decimals as u32,
        maker_direction,
    )?;

    if base_asset_amount == 0 {
        return Ok(0_u64);
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

    maker_stats.update_maker_volume_30d(quote_asset_amount, now)?;

    maker_stats.increment_total_rebate(maker_rebate)?;

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
    base_market.total_spot_fee = base_market.total_spot_fee.safe_add(cast(fee_to_market)?)?;

    update_spot_balances(
        cast(fee_to_market)?,
        &SpotBalanceType::Deposit,
        quote_market,
        &mut base_market.spot_fee_pool,
        false,
    )?;

    let fee_pool_amount = get_token_amount(
        base_market.spot_fee_pool.scaled_balance,
        quote_market,
        &SpotBalanceType::Deposit,
    )?;

    if fee_pool_amount > SPOT_FEE_POOL_TO_REVENUE_POOL_THRESHOLD * 2 {
        transfer_spot_balance_to_revenue_pool(
            fee_pool_amount - SPOT_FEE_POOL_TO_REVENUE_POOL_THRESHOLD,
            quote_market,
            &mut base_market.spot_fee_pool,
        )?;
    }

    let fill_record_id = get_then_update_id!(base_market, next_fill_record_id);
    let order_action_record = get_order_action_record(
        now,
        OrderAction::Fill,
        OrderActionExplanation::None,
        maker.orders[maker_order_index].market_index,
        Some(*filler_key),
        Some(fill_record_id),
        Some(filler_reward),
        Some(base_asset_amount),
        Some(cast(quote_asset_amount)?),
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
    order_records.push(order_action_record);

    // Clear taker/maker order if completely filled
    if taker.orders[taker_order_index].get_base_asset_amount_unfilled()? == 0 {
        taker.orders[taker_order_index] = Order::default();
        taker.spot_positions[taker_spot_position_index].open_orders -= 1;
    }

    if maker.orders[maker_order_index].get_base_asset_amount_unfilled()? == 0 {
        maker.orders[maker_order_index] = Order::default();
        maker.spot_positions[maker_spot_position_index].open_orders -= 1;
    }

    Ok(base_asset_amount)
}

pub fn fulfill_spot_order_with_serum(
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
    order_records: &mut Vec<OrderActionRecord>,
    serum_fulfillment_params: &mut Option<SerumFulfillmentParams>,
) -> ClearingHouseResult<u64> {
    let serum_new_order_accounts = match serum_fulfillment_params {
        Some(serum_new_order_accounts) => serum_new_order_accounts,
        None => return Ok(0),
    };

    let oracle_price = oracle_map.get_price_data(&base_market.oracle)?.price;
    let taker_price = taker.orders[taker_order_index].get_optional_limit_price(
        Some(oracle_price),
        slot,
        base_market.order_tick_size,
    )?;
    let taker_base_asset_amount =
        taker.orders[taker_order_index].get_base_asset_amount_unfilled()?;
    let order_direction = taker.orders[taker_order_index].direction;
    let taker_order_slot = taker.orders[taker_order_index].slot;

    let (best_bid, best_ask) = get_best_bid_and_ask(
        serum_new_order_accounts.serum_market,
        serum_new_order_accounts.serum_bids,
        serum_new_order_accounts.serum_asks,
        serum_new_order_accounts.serum_program_id.key,
        base_market.decimals as u32,
    )?;

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

    base_market.historical_index_data.last_index_price_twap = cast(calculate_new_twap(
        cast(mid_price)?,
        now,
        cast(base_market.historical_index_data.last_index_price_twap)?,
        base_market.historical_index_data.last_index_price_twap_ts,
        ONE_HOUR as i64,
    )?)?;

    base_market.historical_index_data.last_index_price_twap_5min = cast(calculate_new_twap(
        cast(mid_price)?,
        now,
        cast(base_market.historical_index_data.last_index_price_twap_5min)?,
        base_market.historical_index_data.last_index_price_twap_ts,
        FIVE_MINUTE as i64,
    )?)?;

    let taker_price = if let Some(price) = taker_price {
        price
    } else {
        match order_direction {
            PositionDirection::Long => {
                if let Some(ask) = best_ask {
                    ask.safe_add(ask / 100)?
                } else {
                    msg!("Serum has no ask");
                    return Ok(0);
                }
            }
            PositionDirection::Short => {
                if let Some(bid) = best_bid {
                    bid.safe_sub(bid / 100)?
                } else {
                    msg!("Serum has no bid");
                    return Ok(0);
                }
            }
        }
    };

    let market_state_before = load_serum_market(
        serum_new_order_accounts.serum_market,
        serum_new_order_accounts.serum_program_id.key,
    )?;

    let serum_order_side = match order_direction {
        PositionDirection::Long => Side::Bid,
        PositionDirection::Short => Side::Ask,
    };

    let serum_max_coin_qty =
        calculate_serum_max_coin_qty(taker_base_asset_amount, market_state_before.coin_lot_size)?;

    let serum_limit_price = calculate_serum_limit_price(
        taker_price,
        market_state_before.pc_lot_size,
        base_market.decimals as u32,
        market_state_before.coin_lot_size,
    )?;

    let serum_max_native_pc_qty = calculate_serum_max_native_pc_quantity(
        serum_limit_price,
        serum_max_coin_qty,
        market_state_before.pc_lot_size,
    )?;

    let serum_order = NewOrderInstructionV3 {
        side: serum_order_side,
        limit_price: NonZeroU64::new(serum_limit_price).unwrap(),
        max_coin_qty: NonZeroU64::new(serum_max_coin_qty).unwrap(), // max base to deposit into serum
        max_native_pc_qty_including_fees: NonZeroU64::new(serum_max_native_pc_qty).unwrap(), // max quote to deposit into serum
        self_trade_behavior: SelfTradeBehavior::AbortTransaction,
        order_type: serum_dex::matching::OrderType::ImmediateOrCancel,
        client_order_id: 0,
        limit: 10,
        max_ts: now,
    };

    let market_fees_accrued_before = market_state_before.pc_fees_accrued;
    let base_before = serum_new_order_accounts.base_market_vault.amount;
    let quote_before = serum_new_order_accounts.quote_market_vault.amount;
    let market_rebates_accrued_before = market_state_before.referrer_rebates_accrued;

    drop(market_state_before);

    invoke_new_order(
        serum_new_order_accounts.serum_program_id,
        serum_new_order_accounts.serum_market,
        serum_new_order_accounts.serum_open_orders,
        serum_new_order_accounts.serum_request_queue,
        serum_new_order_accounts.serum_event_queue,
        serum_new_order_accounts.serum_bids,
        serum_new_order_accounts.serum_asks,
        &match order_direction {
            PositionDirection::Long => serum_new_order_accounts
                .quote_market_vault
                .to_account_info(),
            PositionDirection::Short => {
                serum_new_order_accounts.base_market_vault.to_account_info()
            }
        },
        serum_new_order_accounts.clearing_house_signer,
        serum_new_order_accounts.serum_base_vault,
        serum_new_order_accounts.serum_quote_vault,
        serum_new_order_accounts.srm_vault,
        &serum_new_order_accounts.token_program.to_account_info(),
        serum_order,
        serum_new_order_accounts.signer_nonce,
    )?;

    let market_state_after = load_serum_market(
        serum_new_order_accounts.serum_market,
        serum_new_order_accounts.serum_program_id.key,
    )?;

    let market_fees_accrued_after = market_state_after.pc_fees_accrued;
    let market_rebates_accrued_after = market_state_after.referrer_rebates_accrued;

    drop(market_state_after);

    let open_orders_before = load_open_orders(serum_new_order_accounts.serum_open_orders)?;
    let unsettled_referrer_rebate_before = open_orders_before.referrer_rebates_accrued;

    drop(open_orders_before);

    invoke_settle_funds(
        serum_new_order_accounts.serum_program_id,
        serum_new_order_accounts.serum_market,
        serum_new_order_accounts.serum_open_orders,
        serum_new_order_accounts.clearing_house_signer,
        serum_new_order_accounts.serum_base_vault,
        serum_new_order_accounts.serum_quote_vault,
        &serum_new_order_accounts.base_market_vault.to_account_info(),
        &serum_new_order_accounts
            .quote_market_vault
            .to_account_info(),
        serum_new_order_accounts.serum_signer,
        &serum_new_order_accounts.token_program.to_account_info(),
        serum_new_order_accounts.signer_nonce,
    )?;

    serum_new_order_accounts
        .base_market_vault
        .reload()
        .map_err(|_e| {
            msg!("Failed to reload base_market_vault");
            ErrorCode::FailedSerumCPI
        })?;
    serum_new_order_accounts
        .quote_market_vault
        .reload()
        .map_err(|_e| {
            msg!("Failed to reload quote_market_vault");
            ErrorCode::FailedSerumCPI
        })?;

    let base_after = serum_new_order_accounts.base_market_vault.amount;
    let quote_after = serum_new_order_accounts.quote_market_vault.amount;

    let open_orders_after = load_open_orders(serum_new_order_accounts.serum_open_orders)?;
    let unsettled_referrer_rebate_after = open_orders_after.referrer_rebates_accrued;

    drop(open_orders_after);

    let settled_referred_rebate =
        unsettled_referrer_rebate_before.safe_sub(unsettled_referrer_rebate_after)?;

    update_spot_balances(
        settled_referred_rebate as u128,
        &SpotBalanceType::Deposit,
        quote_market,
        &mut base_market.spot_fee_pool,
        false,
    )?;

    let (base_update_direction, base_asset_amount_filled) = if base_after > base_before {
        (SpotBalanceType::Deposit, base_after.safe_sub(base_before)?)
    } else {
        (SpotBalanceType::Borrow, base_before.safe_sub(base_after)?)
    };

    if base_asset_amount_filled == 0 {
        msg!("No base filled on serum");
        return Ok(0);
    }

    let serum_fee = market_fees_accrued_after.safe_sub(market_fees_accrued_before)?;

    let serum_referrer_rebate =
        market_rebates_accrued_after.safe_sub(market_rebates_accrued_before)?;

    let (quote_update_direction, quote_asset_amount_filled) = if quote_after > quote_before {
        let quote_asset_amount_delta = quote_after
            .safe_sub(quote_before)?
            .safe_sub(settled_referred_rebate)?;

        (
            SpotBalanceType::Deposit,
            quote_asset_amount_delta
                .safe_add(serum_fee)?
                .safe_add(serum_referrer_rebate)?,
        )
    } else {
        let quote_asset_amount_delta = quote_before
            .safe_sub(quote_after)?
            .safe_add(settled_referred_rebate)?;

        (
            SpotBalanceType::Borrow,
            quote_asset_amount_delta
                .safe_sub(serum_fee)?
                .safe_sub(serum_referrer_rebate)?,
        )
    };

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

    if fee_pool_amount > SPOT_FEE_POOL_TO_REVENUE_POOL_THRESHOLD * 2 {
        transfer_spot_balance_to_revenue_pool(
            fee_pool_amount - SPOT_FEE_POOL_TO_REVENUE_POOL_THRESHOLD,
            quote_market,
            &mut base_market.spot_fee_pool,
        )?;
    }

    let SerumFillFees {
        user_fee: taker_fee,
        fee_to_market,
        fee_pool_delta,
        filler_reward,
    } = fees::calculate_fee_for_fulfillment_with_serum(
        taker_stats,
        quote_asset_amount_filled,
        fee_structure,
        taker_order_slot,
        slot,
        filler.is_some(),
        serum_fee,
        serum_referrer_rebate,
        fee_pool_amount.cast()?,
    )?;

    let quote_spot_position_delta = match quote_update_direction {
        SpotBalanceType::Deposit => quote_asset_amount_filled.safe_sub(taker_fee)?,
        SpotBalanceType::Borrow => quote_asset_amount_filled.safe_add(taker_fee)?,
    };

    validate!(
        base_update_direction
            == taker.orders[taker_order_index].get_spot_position_update_direction(AssetType::Base),
        ErrorCode::FailedToFillOnSerum,
        "Fill on serum lead to unexpected to update direction"
    )?;

    update_spot_balances_and_cumulative_deposits(
        base_asset_amount_filled.cast()?,
        &taker.orders[taker_order_index].get_spot_position_update_direction(AssetType::Base),
        base_market,
        taker.force_get_spot_position_mut(base_market.market_index)?,
        false,
        None,
    )?;

    validate!(
        quote_update_direction
            == taker.orders[taker_order_index].get_spot_position_update_direction(AssetType::Quote),
        ErrorCode::FailedToFillOnSerum,
        "Fill on serum lead to unexpected to update direction"
    )?;

    update_spot_balances_and_cumulative_deposits(
        quote_spot_position_delta.cast()?,
        &taker.orders[taker_order_index].get_spot_position_update_direction(AssetType::Quote),
        quote_market,
        taker.get_quote_spot_position_mut(),
        false,
        Some(quote_asset_amount_filled.cast()?),
    )?;

    taker.update_cumulative_spot_fees(-taker_fee.cast()?)?;

    taker_stats.update_taker_volume_30d(cast(quote_asset_amount_filled)?, now)?;

    taker_stats.increment_total_fees(cast(taker_fee)?)?;

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

        filler_stats.update_filler_volume(cast(quote_asset_amount_filled)?, now)?;
    }

    if fee_pool_delta != 0 {
        update_spot_balances(
            fee_pool_delta.unsigned_abs().cast()?,
            if fee_to_market > 0 {
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
        OrderActionExplanation::None,
        taker.orders[taker_order_index].market_index,
        Some(*filler_key),
        Some(fill_record_id),
        Some(filler_reward),
        Some(base_asset_amount_filled),
        Some(cast(quote_asset_amount_filled)?),
        Some(taker_fee),
        Some(0),
        None,
        Some(0),
        Some(serum_fee),
        Some(*taker_key),
        Some(taker.orders[taker_order_index]),
        None,
        None,
        oracle_price,
    )?;
    order_records.push(order_action_record);

    if taker.orders[taker_order_index].get_base_asset_amount_unfilled()? == 0 {
        taker.orders[taker_order_index] = Order::default();
        taker
            .force_get_spot_position_mut(base_market.market_index)?
            .open_orders -= 1;
    }

    Ok(base_asset_amount_filled)
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
        market_type == MarketType::Spot,
        ErrorCode::InvalidOrder,
        "Order must be a spot order"
    )?;

    validate_user_not_being_liquidated(
        user,
        perp_market_map,
        spot_market_map,
        oracle_map,
        state.liquidation_margin_buffer_ratio,
    )?;

    validate!(!user.is_bankrupt, ErrorCode::UserBankrupt)?;

    let spot_market = spot_market_map.get_ref(&market_index)?;
    let (oracle_price_data, oracle_validity) = oracle_map.get_price_data_and_validity(
        &spot_market.oracle,
        spot_market.historical_oracle_data.last_oracle_price_twap,
    )?;

    validate!(
        is_oracle_valid_for_action(oracle_validity, Some(DriftAction::TriggerOrder))?,
        ErrorCode::InvalidOracle,
        "OracleValidity for spot marketIndex={} invalid for TriggerOrder",
        spot_market.market_index
    )?;

    let oracle_price = oracle_price_data.price;

    let order_slot = user.orders[order_index].slot;
    let auction_duration = user.orders[order_index].auction_duration;
    validate!(
        is_auction_complete(order_slot, auction_duration, slot)?,
        ErrorCode::OrderDidNotSatisfyTriggerCondition,
        "Auction duration must elapse before triggering"
    )?;

    let can_trigger = order_satisfies_trigger_condition(
        &user.orders[order_index],
        cast(oracle_price.unsigned_abs())?,
    );
    validate!(can_trigger, ErrorCode::OrderDidNotSatisfyTriggerCondition)?;

    {
        let direction = user.orders[order_index].direction;
        let base_asset_amount = user.orders[order_index].base_asset_amount;

        user.orders[order_index].triggered = true;
        user.orders[order_index].slot = slot;
        let order_type = user.orders[order_index].order_type;
        if let OrderType::TriggerMarket = order_type {
            let (auction_start_price, auction_end_price) =
                calculate_auction_prices(oracle_price_data, direction, 0)?;
            user.orders[order_index].auction_start_price = auction_start_price;
            user.orders[order_index].auction_end_price = auction_end_price;
        }

        let user_position = user.force_get_spot_position_mut(market_index)?;
        increase_spot_open_bids_and_asks(user_position, &direction, cast(base_asset_amount)?)?;
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

    let position_index = user.get_spot_position_index(market_index)?;
    let token_amount = user.spot_positions[position_index].get_token_amount(&spot_market)?;

    drop(spot_market);
    drop(quote_market);

    // If order is risk increasing and user is below initial margin, cancel it
    let balance_type = user.spot_positions[position_index].balance_type;
    let is_risk_increasing =
        is_spot_order_risk_increasing(&user.orders[order_index], &balance_type, token_amount)?;

    let meets_initial_margin_requirement =
        meets_initial_margin_requirement(user, perp_market_map, spot_market_map, oracle_map)?;

    if is_risk_increasing && !meets_initial_margin_requirement {
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
) -> ClearingHouseResult {
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
