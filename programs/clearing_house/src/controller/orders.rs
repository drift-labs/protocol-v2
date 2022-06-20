use std::cmp::min;

use anchor_lang::prelude::*;
use solana_program::msg;
use spl_token::state::Account as TokenAccount;

use crate::account_loader::load_mut;
use crate::context::*;
use crate::controller;
use crate::controller::position::{add_new_position, get_position_index};
use crate::error::ClearingHouseResult;
use crate::error::ErrorCode;
use crate::get_struct_values;
use crate::get_then_update_id;
use crate::math::amm::is_oracle_valid;
use crate::math::casting::cast;
use crate::math::fees::calculate_order_fee_tier;
use crate::math::{amm, fees, margin::*, orders::*, repeg};
use crate::math_error;
use crate::order_validation::{
    check_if_order_can_be_canceled, get_base_asset_amount_for_order, validate_order,
    validate_order_can_be_canceled,
};
use crate::print_error;
use crate::state::bank_map::BankMap;
use crate::state::events::OrderAction;
use crate::state::events::{OrderRecord, TradeRecord};
use crate::state::market::Market;
use crate::state::market_map::MarketMap;
use crate::state::oracle_map::OracleMap;
use crate::state::user::User;
use crate::state::user::{Order, OrderStatus, OrderType};
use crate::state::{order_state::*, state::*};

pub fn place_order(
    state: &State,
    order_state: &OrderState,
    user: &AccountLoader<User>,
    market_map: &MarketMap,
    discount_token: Option<TokenAccount>,
    referrer: &Option<AccountLoader<User>>,
    clock: &Clock,
    params: OrderParams,
    oracle: Option<&AccountInfo>,
) -> ClearingHouseResult {
    let now = clock.unix_timestamp;

    let user_key = user.key();
    let user = &mut load_mut(user)?;
    controller::funding::settle_funding_payment(user, &user_key, market_map, now)?;

    let new_order_index = user
        .orders
        .iter()
        .position(|order| order.status.eq(&OrderStatus::Init))
        .ok_or(ErrorCode::MaxNumberOfOrders)?;
    let discount_tier = calculate_order_fee_tier(&state.fee_structure, discount_token)?;

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

    // Increment open orders for existing position
    let (user_base_asset_amount, order_base_asset_amount) = {
        let position_index = get_position_index(&user.positions, market_index)
            .or_else(|_| add_new_position(&mut user.positions, market_index))?;
        let market_position = &mut user.positions[position_index];
        market_position.open_orders += 1;
        let base_asset_amount = get_base_asset_amount_for_order(&params, market, market_position);
        (market_position.base_asset_amount, base_asset_amount)
    };

    let new_order = Order {
        status: OrderStatus::Open,
        order_type: params.order_type,
        ts: now,
        order_id: get_then_update_id!(user, next_order_id),
        user_order_id: params.user_order_id,
        market_index: params.market_index,
        price: params.price,
        user_base_asset_amount,
        base_asset_amount: order_base_asset_amount,
        quote_asset_amount: params.quote_asset_amount,
        base_asset_amount_filled: 0,
        quote_asset_amount_filled: 0,
        fee: 0,
        direction: params.direction,
        reduce_only: params.reduce_only,
        discount_tier,
        trigger_price: params.trigger_price,
        trigger_condition: params.trigger_condition,
        referrer: match referrer {
            Some(referrer) => referrer.key(),
            None => Pubkey::default(),
        },
        post_only: params.post_only,
        oracle_price_offset: params.oracle_price_offset,
        immediate_or_cancel: params.immediate_or_cancel,
        padding: [0; 3],
    };

    let valid_oracle_price = get_valid_oracle_price(
        oracle,
        market,
        &new_order,
        &state.oracle_guard_rails.validity,
        clock.slot,
    )?;

    validate_order(&new_order, market, order_state, valid_oracle_price)?;

    user.orders[new_order_index] = new_order;

    // emit order record
    emit!(OrderRecord {
        ts: now,
        order: new_order,
        user: user_key,
        authority: user.authority,
        action: OrderAction::Place,
        filler: Pubkey::default(),
        trade_record_id: 0,
        base_asset_amount_filled: 0,
        quote_asset_amount_filled: 0,
        filler_reward: 0,
        fee: 0,
        quote_asset_amount_surplus: 0,
    });

    Ok(())
}

pub fn cancel_order_by_order_id(
    state: &State,
    order_id: u64,
    user: &AccountLoader<User>,
    market_map: &MarketMap,
    bank_map: &BankMap,
    oracle_map: &mut OracleMap,
    clock: &Clock,
    oracle: Option<&AccountInfo>,
) -> ClearingHouseResult {
    let user_key = user.key();
    let user = &mut load_mut(user)?;
    let order_index = user
        .orders
        .iter()
        .position(|order| order.order_id == order_id)
        .ok_or_else(print_error!(ErrorCode::OrderDoesNotExist))?;

    cancel_order(
        state,
        order_index,
        user,
        &user_key,
        market_map,
        bank_map,
        oracle_map,
        clock,
        oracle,
        false,
    )
}

pub fn cancel_order_by_user_order_id(
    state: &State,
    user_order_id: u8,
    user: &AccountLoader<User>,
    market_map: &MarketMap,
    bank_map: &BankMap,
    oracle_map: &mut OracleMap,
    clock: &Clock,
    oracle: Option<&AccountInfo>,
) -> ClearingHouseResult {
    let user_key = user.key();
    let user = &mut load_mut(user)?;
    let order_index = user
        .orders
        .iter()
        .position(|order| order.user_order_id == user_order_id)
        .ok_or_else(print_error!(ErrorCode::OrderDoesNotExist))?;

    cancel_order(
        state,
        order_index,
        user,
        &user_key,
        market_map,
        bank_map,
        oracle_map,
        clock,
        oracle,
        false,
    )
}

pub fn cancel_order(
    state: &State,
    order_index: usize,
    user: &mut User,
    user_key: &Pubkey,
    market_map: &MarketMap,
    bank_map: &BankMap,
    oracle_map: &mut OracleMap,
    clock: &Clock,
    oracle: Option<&AccountInfo>,
    best_effort: bool,
) -> ClearingHouseResult {
    let now = clock.unix_timestamp;
    controller::funding::settle_funding_payment(user, user_key, market_map, now)?;

    let (order_status, order_market_index) =
        get_struct_values!(user.orders[order_index], status, market_index);

    if order_status != OrderStatus::Open {
        return Err(ErrorCode::OrderNotOpen);
    }

    let market = &market_map.get_ref(&order_market_index)?;
    let valid_oracle_price = get_valid_oracle_price(
        oracle,
        market,
        &user.orders[order_index],
        &state.oracle_guard_rails.validity,
        clock.slot,
    )?;

    if best_effort {
        let is_cancelable = check_if_order_can_be_canceled(
            user,
            order_index,
            market_map,
            bank_map,
            oracle_map,
            valid_oracle_price,
        )?;

        if !is_cancelable {
            return Ok(());
        }
    } else {
        validate_order_can_be_canceled(
            user,
            order_index,
            market_map,
            bank_map,
            oracle_map,
            valid_oracle_price,
        )?;
    }

    emit!(OrderRecord {
        ts: now,
        order: user.orders[order_index],
        user: *user_key,
        authority: user.authority,
        action: OrderAction::Cancel,
        filler: Pubkey::default(),
        trade_record_id: 0,
        base_asset_amount_filled: 0,
        quote_asset_amount_filled: 0,
        filler_reward: 0,
        fee: 0,
        quote_asset_amount_surplus: 0,
    });

    // Decrement open orders for existing position
    let position_index = get_position_index(&user.positions, order_market_index)?;
    user.positions[position_index].open_orders -= 1;
    user.orders[order_index] = Order::default();

    Ok(())
}

pub fn fill_order(
    order_id: u64,
    state: &State,
    order_state: &OrderState,
    user: &AccountLoader<User>,
    market_map: &MarketMap,
    bank_map: &mut BankMap,
    oracle_map: &mut OracleMap,
    oracle: &AccountInfo,
    filler: &AccountLoader<User>,
    referrer: Option<AccountLoader<User>>,
    clock: &Clock,
) -> ClearingHouseResult<u128> {
    let now = clock.unix_timestamp;
    let clock_slot = clock.slot;

    let filler_key = filler.key();
    let user_key = user.key();
    let user = &mut load_mut(user)?;
    controller::funding::settle_funding_payment(user, &user_key, market_map, now)?;

    let order_index = user
        .orders
        .iter()
        .position(|order| order.order_id == order_id)
        .ok_or_else(print_error!(ErrorCode::OrderDoesNotExist))?;

    let (
        order_status,
        market_index,
        order_post_only,
        order_ts,
        order_discount_tier,
        order_direction,
    ) = get_struct_values!(
        user.orders[order_index],
        status,
        market_index,
        post_only,
        ts,
        discount_tier,
        direction
    );

    if order_status != OrderStatus::Open {
        return Err(ErrorCode::OrderNotOpen);
    }

    let mark_price_before: u128;
    let oracle_mark_spread_pct_before: i128;
    let is_oracle_valid: bool;
    let oracle_price: i128;
    {
        let market = &mut market_map.get_ref_mut(&market_index)?;
        let oracle_price_data = &market.amm.get_oracle_price(oracle, clock_slot)?;

        let prepeg_budget = repeg::calculate_fee_pool(market)?;

        let mark_price_prefore = market.amm.mark_price()?;

        is_oracle_valid = amm::is_oracle_valid(
            &market.amm,
            oracle_price_data,
            &state.oracle_guard_rails.validity,
        )?;

        controller::repeg::prepeg(
            market,
            mark_price_prefore,
            oracle_price_data,
            prepeg_budget,
            // now,
        )?;
        let mark_price_before = market.amm.mark_price()?;

        oracle_mark_spread_pct_before = amm::calculate_oracle_mark_spread_pct(
            &market.amm,
            oracle_price_data,
            Some(mark_price_before),
        )?;
        oracle_price = oracle_price_data.price;

        if is_oracle_valid {
            amm::update_oracle_price_twap(
                &mut market.amm,
                now,
                oracle_price_data,
                Some(mark_price_before),
            )?;
        }

        amm::calculate_spreads(&mut market.amm)?;
    }

    let valid_oracle_price = if is_oracle_valid {
        Some(oracle_price)
    } else {
        None
    };

    let (
        base_asset_amount,
        quote_asset_amount,
        potentially_risk_increasing,
        quote_asset_amount_surplus,
    ) = execute_order(
        user,
        order_index,
        market_map,
        bank_map,
        oracle_map,
        market_index,
        mark_price_before,
        now,
        valid_oracle_price,
    )?;

    if base_asset_amount == 0 {
        return Ok(0);
    }

    let mark_price_after: u128;
    let oracle_price_after: i128;
    let oracle_mark_spread_pct_after: i128;
    {
        let market = market_map.get_ref_mut(&market_index)?;
        mark_price_after = market.amm.mark_price()?;
        let oracle_price_data = &market.amm.get_oracle_price(oracle, clock_slot)?;
        oracle_mark_spread_pct_after = amm::calculate_oracle_mark_spread_pct(
            &market.amm,
            oracle_price_data,
            Some(mark_price_after),
        )?;
        oracle_price_after = oracle_price_data.price;
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

    // Order fails if it's risk increasing and it brings the user collateral below the margin requirement
    let meets_maintenance_requirement = if order_post_only {
        // for post only orders allow user to fill up to partial margin requirement
        meets_partial_margin_requirement(user, market_map, bank_map, oracle_map)?
    } else {
        meets_initial_margin_requirement(user, market_map, bank_map, oracle_map)?
    };
    if !meets_maintenance_requirement && potentially_risk_increasing {
        return Err(ErrorCode::InsufficientCollateral);
    }

    let (user_fee, fee_to_market, token_discount, filler_reward, referrer_reward, referee_discount) =
        fees::calculate_fee_for_order(
            quote_asset_amount,
            &state.fee_structure,
            &order_state.order_filler_reward_structure,
            &order_discount_tier,
            order_ts,
            now,
            &referrer,
            filler_key == user_key,
            quote_asset_amount_surplus,
            order_post_only,
        )?;

    // Increment the clearing house's total fee variables
    {
        let market = &mut market_map.get_ref_mut(&market_index)?;
        market.amm.total_fee = market
            .amm
            .total_fee
            .checked_add(fee_to_market)
            .ok_or_else(math_error!())?;
        market.amm.total_fee_minus_distributions = market
            .amm
            .total_fee_minus_distributions
            .checked_add(fee_to_market)
            .ok_or_else(math_error!())?;
    }

    {
        let position_index = get_position_index(&user.positions, market_index)?;
        user.positions[position_index].unsettled_pnl = user.positions[position_index]
            .unsettled_pnl
            .checked_sub(user_fee) // negative fee is rebate, so subtract to increase pnl
            .ok_or_else(math_error!())?;
    }

    // Increment the user's total fee variables
    if user_fee > 0 {
        user.total_fee_paid = user
            .total_fee_paid
            .checked_add(cast(user_fee.unsigned_abs())?)
            .ok_or_else(math_error!())?;
    } else {
        user.total_fee_rebate = user
            .total_fee_rebate
            .checked_add(cast(user_fee.unsigned_abs())?)
            .ok_or_else(math_error!())?;
    }

    user.total_token_discount = user
        .total_token_discount
        .checked_add(token_discount)
        .ok_or_else(math_error!())?;
    user.total_referee_discount = user
        .total_referee_discount
        .checked_add(referee_discount)
        .ok_or_else(math_error!())?;

    if filler_key != user_key {
        let filler = &mut load_mut(filler)?;
        let position_index = get_position_index(&filler.positions, market_index)
            .or_else(|_| add_new_position(&mut filler.positions, market_index))?;

        filler.positions[position_index].unsettled_pnl = filler.positions[position_index]
            .unsettled_pnl
            .checked_add(cast(filler_reward)?)
            .ok_or_else(math_error!())?;
    }

    // Update the referrer's collateral with their reward
    if let Some(referrer) = referrer {
        let referrer = &mut load_mut(&referrer)?;
        referrer.total_referral_reward = referrer
            .total_referral_reward
            .checked_add(referrer_reward)
            .ok_or_else(math_error!())?;
    }

    {
        let market = &market_map.get_ref(&market_index)?;
        update_order_after_trade(
            &mut user.orders[order_index],
            market.amm.minimum_base_asset_trade_size,
            base_asset_amount,
            quote_asset_amount,
            user_fee,
        )?;
    }

    let trade_record_id = {
        let market = &mut market_map.get_ref_mut(&market_index)?;
        let record_id = get_then_update_id!(market, next_trade_record_id);
        let trade_record = TradeRecord {
            ts: now,
            record_id,
            user_authority: user.authority,
            user: user_key,
            direction: order_direction,
            base_asset_amount,
            quote_asset_amount,
            mark_price_before,
            mark_price_after,
            fee: user_fee,
            token_discount,
            quote_asset_amount_surplus,
            referee_discount,
            liquidation: false,
            market_index,
            oracle_price: oracle_price_after,
        };
        emit!(trade_record);
        record_id
    };

    emit!(OrderRecord {
        ts: now,
        order: user.orders[order_index],
        user: user_key,
        authority: user.authority,
        action: OrderAction::Fill,
        filler: filler_key,
        trade_record_id,
        base_asset_amount_filled: base_asset_amount,
        quote_asset_amount_filled: quote_asset_amount,
        filler_reward,
        fee: user_fee,
        quote_asset_amount_surplus,
    });

    let (order_base_asset_amount, order_base_asset_amount_filled, order_type) = get_struct_values!(
        user.orders[order_index],
        base_asset_amount,
        base_asset_amount_filled,
        order_type
    );

    // Cant reset order until after its logged
    if order_base_asset_amount == order_base_asset_amount_filled || order_type == OrderType::Market
    {
        user.orders[order_index] = Order::default();
        let position_index = get_position_index(&user.positions, market_index)?;
        let market_position = &mut user.positions[position_index];
        market_position.open_orders -= 1;
    }

    // Try to update the funding rate at the end of every trade
    {
        let market = &mut market_map.get_ref_mut(&market_index)?;
        controller::funding::update_funding_rate(
            market_index,
            market,
            oracle,
            now,
            clock_slot,
            &state.oracle_guard_rails,
            state.funding_paused,
            Some(mark_price_before),
        )?;
    }

    Ok(base_asset_amount)
}

pub fn execute_order(
    user: &mut User,
    order_index: usize,
    market_map: &MarketMap,
    bank_map: &mut BankMap,
    oracle_map: &mut OracleMap,
    market_index: u64,
    mark_price_before: u128,
    now: i64,
    value_oracle_price: Option<i128>,
) -> ClearingHouseResult<(u128, u128, bool, u128)> {
    let order_type = user.orders[order_index].order_type;
    match order_type {
        OrderType::Market => execute_market_order(
            user,
            order_index,
            market_map,
            market_index,
            mark_price_before,
            now,
        ),
        _ => execute_non_market_order(
            user,
            order_index,
            market_map,
            bank_map,
            oracle_map,
            market_index,
            mark_price_before,
            now,
            value_oracle_price,
        ),
    }
}

pub fn execute_market_order(
    user: &mut User,
    order_index: usize,
    market_map: &MarketMap,
    market_index: u64,
    mark_price_before: u128,
    now: i64,
) -> ClearingHouseResult<(u128, u128, bool, u128)> {
    let position_index = get_position_index(&user.positions, market_index)?;
    let market = &mut market_map.get_ref_mut(&market_index)?;

    let (
        order_direction,
        order_price,
        order_reduce_only,
        order_base_asset_amount,
        order_quote_asset_amount,
    ) = get_struct_values!(
        user.orders[order_index],
        direction,
        price,
        reduce_only,
        base_asset_amount,
        quote_asset_amount
    );

    let base_asset_amount = if order_reduce_only {
        calculate_base_asset_amount_for_reduce_only_order(
            order_base_asset_amount,
            order_direction,
            user.positions[position_index].base_asset_amount,
        )
    } else {
        order_base_asset_amount
    };

    let (
        potentially_risk_increasing,
        reduce_only,
        base_asset_amount,
        quote_asset_amount,
        quote_asset_amount_surplus,
        pnl,
    ) = if order_base_asset_amount > 0 {
        let direction = user.orders[order_index].direction;
        controller::position::update_position_with_base_asset_amount(
            base_asset_amount,
            direction,
            market,
            user,
            position_index,
            mark_price_before,
            now,
            None,
        )?
    } else {
        controller::position::update_position_with_quote_asset_amount(
            order_quote_asset_amount,
            order_direction,
            market,
            user,
            position_index,
            mark_price_before,
            now,
        )?
    };

    user.positions[position_index].unsettled_pnl = user.positions[position_index]
        .unsettled_pnl
        .checked_add(pnl)
        .ok_or_else(math_error!())?;

    if base_asset_amount < market.amm.minimum_base_asset_trade_size {
        msg!("base asset amount {}", base_asset_amount);
        return Err(print_error!(ErrorCode::TradeSizeTooSmall)());
    }

    if !reduce_only && order_reduce_only {
        return Err(ErrorCode::ReduceOnlyOrderIncreasedRisk);
    }

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
    ))
}

pub fn execute_non_market_order(
    user: &mut User,
    order_index: usize,
    market_map: &MarketMap,
    bank_map: &mut BankMap,
    oracle_map: &mut OracleMap,
    market_index: u64,
    mark_price_before: u128,
    now: i64,
    valid_oracle_price: Option<i128>,
) -> ClearingHouseResult<(u128, u128, bool, u128)> {
    // Determine the base asset amount the user can fill
    let base_asset_amount_user_can_execute = calculate_base_asset_amount_user_can_execute(
        user,
        order_index,
        market_map,
        bank_map,
        oracle_map,
        market_index,
    )?;

    if base_asset_amount_user_can_execute == 0 {
        msg!("User cant execute order");
        return Ok((0, 0, false, 0));
    }

    // Determine the base asset amount the market can fill
    let market = &mut market_map.get_ref_mut(&market_index)?;
    let base_asset_amount_market_can_execute = calculate_base_asset_amount_market_can_execute(
        &user.orders[order_index],
        market,
        Some(mark_price_before),
        valid_oracle_price,
    )?;

    if base_asset_amount_market_can_execute == 0 {
        msg!("Market cant execute order");
        return Ok((0, 0, false, 0));
    }

    let mut base_asset_amount = min(
        base_asset_amount_market_can_execute,
        base_asset_amount_user_can_execute,
    );

    if base_asset_amount < market.amm.minimum_base_asset_trade_size {
        msg!("base asset amount too small {}", base_asset_amount);
        return Ok((0, 0, false, 0));
    }

    let (
        order_direction,
        order_reduce_only,
        order_post_only,
        order_base_asset_amount,
        order_base_asset_amount_filled,
    ) = get_struct_values!(
        user.orders[order_index],
        direction,
        reduce_only,
        post_only,
        base_asset_amount,
        base_asset_amount_filled
    );

    let minimum_base_asset_trade_size = market.amm.minimum_base_asset_trade_size;
    let base_asset_amount_left_to_fill = order_base_asset_amount
        .checked_sub(
            order_base_asset_amount_filled
                .checked_add(base_asset_amount)
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?;

    if base_asset_amount_left_to_fill > 0
        && base_asset_amount_left_to_fill < minimum_base_asset_trade_size
    {
        base_asset_amount = base_asset_amount
            .checked_add(base_asset_amount_left_to_fill)
            .ok_or_else(math_error!())?;
    }

    if base_asset_amount == 0 {
        return Ok((0, 0, false, 0));
    }

    let position_index = get_position_index(&user.positions, market_index)?;

    let maker_limit_price = if order_post_only {
        Some(user.orders[order_index].get_limit_price(valid_oracle_price)?)
    } else {
        None
    };
    let (
        potentially_risk_increasing,
        reduce_only,
        _,
        quote_asset_amount,
        quote_asset_amount_surplus,
        pnl,
    ) = controller::position::update_position_with_base_asset_amount(
        base_asset_amount,
        order_direction,
        market,
        user,
        position_index,
        mark_price_before,
        now,
        maker_limit_price,
    )?;

    user.positions[position_index].unsettled_pnl = user.positions[position_index]
        .unsettled_pnl
        .checked_add(pnl)
        .ok_or_else(math_error!())?;

    if !reduce_only && order_reduce_only {
        return Err(ErrorCode::ReduceOnlyOrderIncreasedRisk);
    }

    Ok((
        base_asset_amount,
        quote_asset_amount,
        potentially_risk_increasing,
        quote_asset_amount_surplus,
    ))
}

pub fn update_order_after_trade(
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

    if order.order_type != OrderType::Market {
        // redundant test to make sure no min trade size remaining
        let base_asset_amount_to_fill = order
            .base_asset_amount
            .checked_sub(order.base_asset_amount_filled)
            .ok_or_else(math_error!())?;

        if base_asset_amount_to_fill > 0
            && base_asset_amount_to_fill < minimum_base_asset_trade_size
        {
            return Err(ErrorCode::OrderAmountTooSmall);
        }
    }

    order.fee = order.fee.checked_add(fee).ok_or_else(math_error!())?;

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
