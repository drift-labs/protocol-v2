use crate::controller::position::{add_new_position, get_position_index};
use crate::error::ClearingHouseResult;
use crate::error::*;
use crate::math::casting::cast;
use crate::math_error;
use crate::print_error;
use crate::state::user_orders::Order;
use anchor_lang::prelude::*;
use solana_program::msg;
use std::cmp::min;

use crate::context::*;
use crate::math::{amm, fees, margin::*, orders::*};
use crate::state::{
    history::order_history::{OrderHistory, OrderRecord},
    history::trade::{TradeHistory, TradeRecord},
    market::Markets,
    order_state::*,
    state::*,
    user::{User, UserPositions},
    user_orders::*,
};

use crate::controller;
use crate::math::amm::normalise_oracle_price;
use crate::math::fees::calculate_order_fee_tier;
use crate::order_validation::validate_order;
use crate::state::history::funding_payment::FundingPaymentHistory;
use crate::state::history::funding_rate::FundingRateHistory;
use crate::state::history::order_history::OrderAction;
use spl_token::state::Account as TokenAccount;
use std::cell::RefMut;

pub fn place_order(
    state: &State,
    order_state: &OrderState,
    user: &mut Box<Account<User>>,
    user_positions: &AccountLoader<UserPositions>,
    markets: &AccountLoader<Markets>,
    user_orders: &AccountLoader<UserOrders>,
    funding_payment_history: &AccountLoader<FundingPaymentHistory>,
    order_history: &AccountLoader<OrderHistory>,
    discount_token: Option<TokenAccount>,
    referrer: &Option<Account<User>>,
    clock: &Clock,
    params: OrderParams,
) -> ClearingHouseResult {
    let now = clock.unix_timestamp;

    let user_positions = &mut user_positions
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
    let funding_payment_history = &mut funding_payment_history
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
    let markets = &markets
        .load()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
    controller::funding::settle_funding_payment(
        user,
        user_positions,
        markets,
        funding_payment_history,
        now,
    )?;

    let user_orders = &mut user_orders
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
    let new_order_idx = user_orders
        .orders
        .iter()
        .position(|order| order.status.eq(&OrderStatus::Init))
        .ok_or(ErrorCode::MaxNumberOfOrders)?;
    let discount_tier = calculate_order_fee_tier(&state.fee_structure, discount_token)?;
    let order_history_account = &mut order_history
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))?;

    if params.user_order_id > 0 {
        let user_order_id_already_used = user_orders
            .orders
            .iter()
            .position(|order| order.user_order_id == params.user_order_id);

        if user_order_id_already_used.is_some() {
            msg!("user_order_id is already in use {}", params.user_order_id);
            return Err(ErrorCode::UserOrderIdAlreadyInUse);
        }
    }

    let market_index = params.market_index;
    let market = markets.get_market(market_index);

    // Increment open orders for existing position
    let position_index = get_position_index(user_positions, market_index)
        .or_else(|_| add_new_position(user_positions, market_index))?;
    let market_position = &mut user_positions.positions[position_index];
    market_position.open_orders += 1;

    let order_id = order_history_account.next_order_id();
    let new_order = Order {
        status: OrderStatus::Open,
        order_type: params.order_type,
        ts: now,
        order_id,
        user_order_id: params.user_order_id,
        market_index: params.market_index,
        price: params.price,
        user_base_asset_amount: market_position.base_asset_amount,
        base_asset_amount: params.base_asset_amount,
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

        // always false until we add support
        post_only: false,
        immediate_or_cancel: false,
        oracle_price_offset: 0,
        padding: [0; 3],
    };

    validate_order(&new_order, market, order_state)?;

    user_orders.orders[new_order_idx] = new_order;

    // Add to the order history account
    let record_id = order_history_account.next_record_id();
    order_history_account.append(OrderRecord {
        ts: now,
        record_id,
        order: new_order,
        user: user.key(),
        authority: user.authority,
        action: OrderAction::Place,
        filler: Pubkey::default(),
        trade_record_id: 0,
        base_asset_amount_filled: 0,
        quote_asset_amount_filled: 0,
        filler_reward: 0,
        fee: 0,
        padding: [0; 10],
    });

    Ok(())
}

pub fn cancel_order_by_order_id(
    order_id: u128,
    user: &mut Box<Account<User>>,
    user_positions: &AccountLoader<UserPositions>,
    markets: &AccountLoader<Markets>,
    user_orders: &AccountLoader<UserOrders>,
    funding_payment_history: &AccountLoader<FundingPaymentHistory>,
    order_history: &AccountLoader<OrderHistory>,
    clock: &Clock,
) -> ClearingHouseResult {
    let user_orders = &mut user_orders
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))?;

    let order_index = user_orders
        .orders
        .iter()
        .position(|order| order.order_id == order_id)
        .ok_or_else(print_error!(ErrorCode::OrderDoesNotExist))?;
    let order = &mut user_orders.orders[order_index];

    cancel_order(
        order,
        user,
        user_positions,
        markets,
        funding_payment_history,
        order_history,
        clock,
    )
}

pub fn cancel_order_by_user_order_id(
    user_order_id: u8,
    user: &mut Box<Account<User>>,
    user_positions: &AccountLoader<UserPositions>,
    markets: &AccountLoader<Markets>,
    user_orders: &AccountLoader<UserOrders>,
    funding_payment_history: &AccountLoader<FundingPaymentHistory>,
    order_history: &AccountLoader<OrderHistory>,
    clock: &Clock,
) -> ClearingHouseResult {
    let user_orders = &mut user_orders
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))?;

    let order_index = user_orders
        .orders
        .iter()
        .position(|order| order.user_order_id == user_order_id)
        .ok_or_else(print_error!(ErrorCode::OrderDoesNotExist))?;
    let order = &mut user_orders.orders[order_index];

    cancel_order(
        order,
        user,
        user_positions,
        markets,
        funding_payment_history,
        order_history,
        clock,
    )
}

pub fn cancel_order(
    order: &mut Order,
    user: &mut Box<Account<User>>,
    user_positions: &AccountLoader<UserPositions>,
    markets: &AccountLoader<Markets>,
    funding_payment_history: &AccountLoader<FundingPaymentHistory>,
    order_history: &AccountLoader<OrderHistory>,
    clock: &Clock,
) -> ClearingHouseResult {
    let now = clock.unix_timestamp;

    let user_positions = &mut user_positions
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
    let funding_payment_history = &mut funding_payment_history
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
    let markets = &markets
        .load()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
    controller::funding::settle_funding_payment(
        user,
        user_positions,
        markets,
        funding_payment_history,
        now,
    )?;

    if order.status != OrderStatus::Open {
        return Err(ErrorCode::OrderNotOpen);
    }

    // Add to the order history account
    let order_history_account = &mut order_history
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
    let record_id = order_history_account.next_record_id();
    order_history_account.append(OrderRecord {
        ts: now,
        record_id,
        order: *order,
        user: user.key(),
        authority: user.authority,
        action: OrderAction::Cancel,
        filler: Pubkey::default(),
        trade_record_id: 0,
        base_asset_amount_filled: 0,
        quote_asset_amount_filled: 0,
        filler_reward: 0,
        fee: 0,
        padding: [0; 10],
    });

    // Decrement open orders for existing position
    let position_index = get_position_index(user_positions, order.market_index)?;
    let market_position = &mut user_positions.positions[position_index];
    market_position.open_orders -= 1;
    *order = Order::default();

    Ok(())
}

pub fn fill_order(
    order_id: u128,
    state: &State,
    order_state: &OrderState,
    user: &mut Box<Account<User>>,
    user_positions: &AccountLoader<UserPositions>,
    markets: &AccountLoader<Markets>,
    oracle: &AccountInfo,
    user_orders: &AccountLoader<UserOrders>,
    filler: &mut Box<Account<User>>,
    funding_payment_history: &AccountLoader<FundingPaymentHistory>,
    trade_history: &AccountLoader<TradeHistory>,
    order_history: &AccountLoader<OrderHistory>,
    funding_rate_history: &AccountLoader<FundingRateHistory>,
    referrer: Option<Account<User>>,
    clock: &Clock,
) -> ClearingHouseResult<u128> {
    let now = clock.unix_timestamp;
    let clock_slot = clock.slot;

    let user_positions = &mut user_positions
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
    let funding_payment_history = &mut funding_payment_history
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
    {
        let markets = &markets
            .load()
            .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
        controller::funding::settle_funding_payment(
            user,
            user_positions,
            markets,
            funding_payment_history,
            now,
        )?;
    }

    let user_orders = &mut user_orders
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
    let order_index = user_orders
        .orders
        .iter()
        .position(|order| order.order_id == order_id)
        .ok_or_else(print_error!(ErrorCode::OrderDoesNotExist))?;
    let order = &mut user_orders.orders[order_index];

    if order.status != OrderStatus::Open {
        return Err(ErrorCode::OrderNotOpen);
    }

    let market_index = order.market_index;
    {
        let markets = &markets
            .load()
            .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
        let market = markets.get_market(market_index);

        if !market.initialized {
            return Err(ErrorCode::MarketIndexNotInitialized);
        }

        if !market.amm.oracle.eq(oracle.key) {
            return Err(ErrorCode::InvalidOracle);
        }
    }

    let mark_price_before: u128;
    let oracle_mark_spread_pct_before: i128;
    let is_oracle_valid: bool;
    let oracle_price: i128;
    {
        let markets = &mut markets
            .load_mut()
            .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
        let market = markets.get_market_mut(market_index);
        mark_price_before = market.amm.mark_price()?;
        let oracle_price_data = &market.amm.get_oracle_price(oracle, clock_slot)?;
        oracle_mark_spread_pct_before = amm::calculate_oracle_mark_spread_pct(
            &market.amm,
            oracle_price_data,
            0,
            Some(mark_price_before),
        )?;
        oracle_price = oracle_price_data.price;
        let normalised_price =
            normalise_oracle_price(&market.amm, oracle_price_data, Some(mark_price_before))?;
        is_oracle_valid =
            amm::is_oracle_valid(oracle_price_data, &state.oracle_guard_rails.validity)?;
        if is_oracle_valid {
            amm::update_oracle_price_twap(&mut market.amm, now, normalised_price)?;
        }
    }

    let valid_oracle_price = if is_oracle_valid {
        Some(oracle_price)
    } else {
        None
    };

    let (base_asset_amount, quote_asset_amount, potentially_risk_increasing) = execute_order(
        user,
        user_positions,
        order,
        &mut markets
            .load_mut()
            .or(Err(ErrorCode::UnableToLoadAccountLoader))?,
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
        let markets = &mut markets
            .load_mut()
            .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
        let market = markets.get_market_mut(market_index);
        mark_price_after = market.amm.mark_price()?;
        let oracle_price_data = &market.amm.get_oracle_price(oracle, clock_slot)?;
        oracle_mark_spread_pct_after = amm::calculate_oracle_mark_spread_pct(
            &market.amm,
            oracle_price_data,
            0,
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

    // Order fails if it's risk increasing and it brings the user collateral below the initial margin requirement
    let meets_initial_maintenance_requirement = meets_initial_margin_requirement(
        user,
        user_positions,
        &markets
            .load()
            .or(Err(ErrorCode::UnableToLoadAccountLoader))?,
    )?;
    if !meets_initial_maintenance_requirement && potentially_risk_increasing {
        return Err(ErrorCode::InsufficientCollateral);
    }

    let discount_tier = order.discount_tier;
    let (user_fee, fee_to_market, token_discount, filler_reward, referrer_reward, referee_discount) =
        fees::calculate_fee_for_limit_order(
            quote_asset_amount,
            &state.fee_structure,
            &order_state.order_filler_reward_structure,
            &discount_tier,
            order.ts,
            now,
            &referrer,
            filler.key() == user.key(),
        )?;

    // Increment the clearing house's total fee variables
    {
        let markets = &mut markets
            .load_mut()
            .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
        let market = markets.get_market_mut(market_index);
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

    // Subtract the fee from user's collateral
    user.collateral = user.collateral.checked_sub(user_fee).or(Some(0)).unwrap();

    // Increment the user's total fee variables
    user.total_fee_paid = user
        .total_fee_paid
        .checked_add(user_fee)
        .ok_or_else(math_error!())?;
    user.total_token_discount = user
        .total_token_discount
        .checked_add(token_discount)
        .ok_or_else(math_error!())?;
    user.total_referee_discount = user
        .total_referee_discount
        .checked_add(referee_discount)
        .ok_or_else(math_error!())?;

    filler.collateral = filler
        .collateral
        .checked_add(cast(filler_reward)?)
        .ok_or_else(math_error!())?;

    // Update the referrer's collateral with their reward
    if let Some(mut referrer) = referrer {
        referrer.total_referral_reward = referrer
            .total_referral_reward
            .checked_add(referrer_reward)
            .ok_or_else(math_error!())?;
        referrer
            .exit(&crate::ID)
            .or(Err(ErrorCode::UnableToWriteToRemainingAccount))?;
    }

    {
        let markets = &mut markets
            .load()
            .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
        let market = markets.get_market(market_index);
        update_order_after_trade(
            order,
            market.amm.minimum_base_asset_trade_size,
            base_asset_amount,
            quote_asset_amount,
            user_fee,
        )?;
    }

    let trade_history_account = &mut trade_history
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
    let trade_record_id = trade_history_account.next_record_id();
    trade_history_account.append(TradeRecord {
        ts: now,
        record_id: trade_record_id,
        user_authority: user.authority,
        user: *user.to_account_info().key,
        direction: order.direction,
        base_asset_amount,
        quote_asset_amount,
        mark_price_before,
        mark_price_after,
        fee: user_fee,
        token_discount,
        referrer_reward,
        referee_discount,
        liquidation: false,
        market_index,
        oracle_price: oracle_price_after,
    });

    let order_history_account = &mut order_history
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
    let record_id = order_history_account.next_record_id();
    order_history_account.append(OrderRecord {
        ts: now,
        record_id,
        order: *order,
        user: user.key(),
        authority: user.authority,
        action: OrderAction::Fill,
        filler: filler.key(),
        trade_record_id,
        base_asset_amount_filled: base_asset_amount,
        quote_asset_amount_filled: quote_asset_amount,
        filler_reward,
        fee: user_fee,
        padding: [0; 10],
    });

    // Cant reset order until after its been logged in order history
    if order.base_asset_amount == order.base_asset_amount_filled
        || order.order_type == OrderType::Market
    {
        *order = Order::default();
        let position_index = get_position_index(user_positions, market_index)?;
        let market_position = &mut user_positions.positions[position_index];
        market_position.open_orders -= 1;
    }

    // Try to update the funding rate at the end of every trade
    {
        let markets = &mut markets
            .load_mut()
            .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
        let market = markets.get_market_mut(market_index);
        let funding_rate_history = &mut funding_rate_history
            .load_mut()
            .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
        controller::funding::update_funding_rate(
            market_index,
            market,
            oracle,
            now,
            clock_slot,
            funding_rate_history,
            &state.oracle_guard_rails,
            state.funding_paused,
            Some(mark_price_before),
        )?;
    }

    Ok(base_asset_amount)
}

pub fn execute_order(
    user: &mut User,
    user_positions: &mut RefMut<UserPositions>,
    order: &mut Order,
    markets: &mut RefMut<Markets>,
    market_index: u64,
    mark_price_before: u128,
    now: i64,
    value_oracle_price: Option<i128>,
) -> ClearingHouseResult<(u128, u128, bool)> {
    match order.order_type {
        OrderType::Market => execute_market_order(
            user,
            user_positions,
            order,
            markets,
            market_index,
            mark_price_before,
            now,
        ),
        _ => execute_non_market_order(
            user,
            user_positions,
            order,
            markets,
            market_index,
            mark_price_before,
            now,
            value_oracle_price,
        ),
    }
}

pub fn execute_market_order(
    user: &mut User,
    user_positions: &mut RefMut<UserPositions>,
    order: &mut Order,
    markets: &mut RefMut<Markets>,
    market_index: u64,
    mark_price_before: u128,
    now: i64,
) -> ClearingHouseResult<(u128, u128, bool)> {
    let position_index = get_position_index(user_positions, market_index)?;
    let market_position = &mut user_positions.positions[position_index];
    let market = markets.get_market_mut(market_index);

    let (potentially_risk_increasing, reduce_only, base_asset_amount, quote_asset_amount) =
        if order.base_asset_amount > 0 {
            controller::position::update_position_with_base_asset_amount(
                order.base_asset_amount,
                order.direction,
                market,
                user,
                market_position,
                now,
            )?
        } else {
            controller::position::update_position_with_quote_asset_amount(
                order.quote_asset_amount,
                order.direction,
                market,
                user,
                market_position,
                mark_price_before,
                now,
            )?
        };

    if base_asset_amount < market.amm.minimum_base_asset_trade_size {
        msg!("base asset amount {}", base_asset_amount);
        return Err(print_error!(ErrorCode::TradeSizeTooSmall)());
    }

    if !reduce_only && order.reduce_only {
        return Err(ErrorCode::ReduceOnlyOrderIncreasedRisk);
    }

    if order.price > 0
        && !limit_price_satisfied(
            order.price,
            quote_asset_amount,
            base_asset_amount,
            order.direction,
        )?
    {
        return Err(ErrorCode::SlippageOutsideLimit);
    }

    Ok((
        base_asset_amount,
        quote_asset_amount,
        potentially_risk_increasing,
    ))
}

pub fn execute_non_market_order(
    user: &mut User,
    user_positions: &mut RefMut<UserPositions>,
    order: &mut Order,
    markets: &mut RefMut<Markets>,
    market_index: u64,
    mark_price_before: u128,
    now: i64,
    valid_oracle_price: Option<i128>,
) -> ClearingHouseResult<(u128, u128, bool)> {
    // Determine the base asset amount the user can fill
    let base_asset_amount_user_can_execute = calculate_base_asset_amount_user_can_execute(
        user,
        user_positions,
        order,
        markets,
        market_index,
    )?;

    if base_asset_amount_user_can_execute == 0 {
        msg!("User cant execute order");
        return Ok((0, 0, false));
    }

    // Determine the base asset amount the market can fill
    let market = markets.get_market_mut(market_index);
    let base_asset_amount_market_can_execute = calculate_base_asset_amount_market_can_execute(
        order,
        market,
        Some(mark_price_before),
        valid_oracle_price,
    )?;

    if base_asset_amount_market_can_execute == 0 {
        msg!("Market cant execute order");
        return Ok((0, 0, false));
    }

    let mut base_asset_amount = min(
        base_asset_amount_market_can_execute,
        base_asset_amount_user_can_execute,
    );

    if base_asset_amount < market.amm.minimum_base_asset_trade_size {
        msg!("base asset amount too small {}", base_asset_amount);
        return Ok((0, 0, false));
    }

    let minimum_base_asset_trade_size = market.amm.minimum_base_asset_trade_size;
    let base_asset_amount_left_to_fill = order
        .base_asset_amount
        .checked_sub(
            order
                .base_asset_amount_filled
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
        return Ok((0, 0, false));
    }

    let position_index = get_position_index(user_positions, market_index)?;
    let market_position = &mut user_positions.positions[position_index];

    let (potentially_risk_increasing, reduce_only, _, quote_asset_amount) =
        controller::position::update_position_with_base_asset_amount(
            base_asset_amount,
            order.direction,
            market,
            user,
            market_position,
            now,
        )?;

    if !reduce_only && order.reduce_only {
        return Err(ErrorCode::ReduceOnlyOrderIncreasedRisk);
    }

    Ok((
        base_asset_amount,
        quote_asset_amount,
        potentially_risk_increasing,
    ))
}

pub fn update_order_after_trade(
    order: &mut Order,
    minimum_base_asset_trade_size: u128,
    base_asset_amount: u128,
    quote_asset_amount: u128,
    fee: u128,
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
