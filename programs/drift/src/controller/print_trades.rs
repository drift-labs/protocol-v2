use crate::controller::orders::expire_orders;
use crate::controller::position::{
    add_new_position, get_position_index, increase_open_bids_and_asks, PositionDirection,
};
use crate::error::DriftResult;
use crate::error::ErrorCode;
use crate::load_mut;
use crate::math::casting::Cast;
use crate::math::liquidation::validate_user_not_being_liquidated;
use crate::math::oracle;
use crate::math::oracle::{is_oracle_valid_for_action, DriftAction};
use crate::math::safe_math::SafeMath;
use crate::math::{margin::*, orders::*};
use crate::print_error;
use crate::state::oracle::OraclePriceData;
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::{MarketStatus, PerpMarket};
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::print_trade::PrintTrade;
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::state::*;
use crate::state::user::{MarketType, OrderTriggerCondition, User};
use crate::state::user::{Order, OrderStatus, OrderType};
use crate::validate;
use crate::validation::order::validate_order;
use crate::PrintTradeParams;
use anchor_lang::prelude::*;
use solana_program::msg;

fn get_valid_oracle_price(
    oracle_price_data: &OraclePriceData,
    market: &PerpMarket,
    order: &Order,
    validity_guardrails: &ValidityGuardRails,
) -> DriftResult<Option<i64>> {
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

pub fn place_perp_orders_for_print_trade(
    state: &State,
    print_trade: &mut PrintTrade,
    creator: &AccountLoader<User>,
    counterparty: &AccountLoader<User>,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    clock: &Clock,
    params: PrintTradeParams,
) -> DriftResult {
    let now = clock.unix_timestamp;
    let slot = clock.slot;
    let creator_key = creator.key();
    let counterparty_key = counterparty.key();
    let creator = &mut load_mut!(creator)?;
    let counterparty = &mut load_mut!(counterparty)?;

    validate_user_not_being_liquidated(
        creator,
        perp_market_map,
        spot_market_map,
        oracle_map,
        state.liquidation_margin_buffer_ratio,
    )?;
    validate_user_not_being_liquidated(
        counterparty,
        perp_market_map,
        spot_market_map,
        oracle_map,
        state.liquidation_margin_buffer_ratio,
    )?;

    validate!(!creator.is_bankrupt(), ErrorCode::UserBankrupt)?;
    validate!(!counterparty.is_bankrupt(), ErrorCode::UserBankrupt)?;

    expire_orders(
        creator,
        &creator_key,
        perp_market_map,
        spot_market_map,
        oracle_map,
        now,
        slot,
    )?;

    expire_orders(
        counterparty,
        &counterparty_key,
        perp_market_map,
        spot_market_map,
        oracle_map,
        now,
        slot,
    )?;

    let market_index = params.market_index;
    let market = &perp_market_map.get_ref(&market_index)?;
    let force_reduce_only = market.is_reduce_only()?;

    validate!(
        !matches!(market.status, MarketStatus::Initialized),
        ErrorCode::MarketBeingInitialized,
        "Market is being initialized"
    )?;

    validate!(
        market.is_active(now)?,
        ErrorCode::MarketPlaceOrderPaused,
        "Market is in settlement mode",
    )?;

    let creator_position_index = get_position_index(&creator.perp_positions, market_index)
        .or_else(|_| add_new_position(&mut creator.perp_positions, market_index))?;
    let counterparty_position_index =
        get_position_index(&counterparty.perp_positions, market_index)
            .or_else(|_| add_new_position(&mut counterparty.perp_positions, market_index))?;

    let creator_worst_case_base_asset_amount_before =
        creator.perp_positions[creator_position_index].worst_case_base_asset_amount()?;
    let counterparty_worst_case_base_asset_amount_before =
        counterparty.perp_positions[counterparty_position_index].worst_case_base_asset_amount()?;

    validate!(
        params.base_asset_amount >= market.amm.order_step_size,
        ErrorCode::OrderAmountTooSmall,
        "params.base_asset_amount={} cannot be below market.amm.order_step_size={}",
        params.base_asset_amount,
        market.amm.order_step_size
    )?;

    // Increment open orders for existing position
    let (creator_existing_position_direction, creator_order_base_asset_amount) = {
        let base_asset_amount = if params.base_asset_amount == u64::MAX {
            calculate_max_perp_order_size(
                creator,
                creator_position_index,
                params.market_index,
                params.creator_direction,
                perp_market_map,
                spot_market_map,
                oracle_map,
            )?
        } else {
            standardize_base_asset_amount(params.base_asset_amount, market.amm.order_step_size)?
        };

        let market_position = &mut creator.perp_positions[creator_position_index];
        market_position.open_orders += 1;

        increase_open_bids_and_asks(
            market_position,
            &params.creator_direction,
            base_asset_amount,
        )?;

        let existing_position_direction = if market_position.base_asset_amount >= 0 {
            PositionDirection::Long
        } else {
            PositionDirection::Short
        };
        (existing_position_direction, base_asset_amount)
    };

    // Increment open orders for existing position
    let (counterparty_existing_position_direction, counterparty_order_base_asset_amount) = {
        let base_asset_amount = if params.base_asset_amount == u64::MAX {
            calculate_max_perp_order_size(
                counterparty,
                counterparty_position_index,
                params.market_index,
                params.counterparty_direction,
                perp_market_map,
                spot_market_map,
                oracle_map,
            )?
        } else {
            standardize_base_asset_amount(params.base_asset_amount, market.amm.order_step_size)?
        };

        let market_position = &mut counterparty.perp_positions[counterparty_position_index];
        market_position.open_orders += 1;

        increase_open_bids_and_asks(
            market_position,
            &params.counterparty_direction,
            base_asset_amount,
        )?;

        let existing_position_direction = if market_position.base_asset_amount >= 0 {
            PositionDirection::Long
        } else {
            PositionDirection::Short
        };
        (existing_position_direction, base_asset_amount)
    };

    validate!(
        params.market_type == MarketType::Perp,
        ErrorCode::InvalidOrderMarketType,
        "must be perp order"
    )?;

    let creator_order = Order {
        status: OrderStatus::Open,
        order_type: OrderType::Market,
        market_type: params.market_type,
        slot,
        order_id: 0,
        user_order_id: 0,
        market_index: params.market_index,
        price: standardize_price(
            params.price,
            market.amm.order_tick_size,
            params.creator_direction,
        )?,
        existing_position_direction: creator_existing_position_direction,
        base_asset_amount: creator_order_base_asset_amount,
        base_asset_amount_filled: 0,
        quote_asset_amount_filled: 0,
        direction: params.creator_direction,
        reduce_only: params.reduce_only || force_reduce_only,
        trigger_price: 0,
        trigger_condition: OrderTriggerCondition::TriggeredAbove,
        post_only: false,
        oracle_price_offset: 0,
        immediate_or_cancel: false,
        auction_start_price: 0,
        auction_end_price: 0,
        auction_duration: 0,
        max_ts: 0,
        padding: [0; 3],
    };

    let counterparty_order = Order {
        status: OrderStatus::Open,
        order_type: OrderType::Market,
        market_type: params.market_type,
        slot,
        order_id: 0,
        user_order_id: 0,
        market_index: params.market_index,
        price: standardize_price(
            params.price,
            market.amm.order_tick_size,
            params.counterparty_direction,
        )?,
        existing_position_direction: counterparty_existing_position_direction,
        base_asset_amount: counterparty_order_base_asset_amount,
        base_asset_amount_filled: 0,
        quote_asset_amount_filled: 0,
        direction: params.creator_direction,
        reduce_only: params.reduce_only || force_reduce_only,
        trigger_price: 0,
        trigger_condition: OrderTriggerCondition::TriggeredAbove,
        post_only: false,
        oracle_price_offset: 0,
        immediate_or_cancel: false,
        auction_start_price: 0,
        auction_end_price: 0,
        auction_duration: 0,
        max_ts: 0,
        padding: [0; 3],
    };

    print_trade.orders = [
        creator_order,
        counterparty_order
    ];
    print_trade.creator = creator_key;
    print_trade.counterparty = counterparty_key;

    let valid_oracle_price = get_valid_oracle_price(
        oracle_map.get_price_data(&market.amm.oracle)?,
        market,
        &creator_order,
        &state.oracle_guard_rails.validity,
    )?;

    validate_order(&creator_order, market, valid_oracle_price, slot)?;

    let creator_worst_case_base_asset_amount_after =
        creator.perp_positions[creator_position_index].worst_case_base_asset_amount()?;
    let counterparty_worst_case_base_asset_amount_after =
        creator.perp_positions[creator_position_index].worst_case_base_asset_amount()?;

    let creator_position_base_asset_amount =
        creator.perp_positions[creator_position_index].base_asset_amount;
    let order_risk_reducing = is_order_risk_decreasing(
        &params.creator_direction,
        creator_order_base_asset_amount,
        creator_position_base_asset_amount,
    )?;

    let risk_decreasing = creator_worst_case_base_asset_amount_after.unsigned_abs()
        <= creator_worst_case_base_asset_amount_before.unsigned_abs()
        && counterparty_worst_case_base_asset_amount_after.unsigned_abs()
        <= counterparty_worst_case_base_asset_amount_before.unsigned_abs()
        && order_risk_reducing;

    // Order fails if it's risk increasing and it brings the user collateral below the margin requirement
    let meets_initial_margin_requirement = meets_place_order_margin_requirement(
        creator,
        perp_market_map,
        spot_market_map,
        oracle_map,
        risk_decreasing,
    )?;

    if !meets_initial_margin_requirement {
        return Err(ErrorCode::InvalidOrderForInitialMarginReq);
    }

    if force_reduce_only && !risk_decreasing {
        return Err(ErrorCode::InvalidOrderNotRiskReducing);
    }

    let max_oi = market.amm.max_open_interest;
    if max_oi != 0 && !risk_decreasing {
        let (order_short_base_asset_amount, order_long_base_asset_amount) =
            match params.creator_direction {
                PositionDirection::Short => (
                    creator_order_base_asset_amount,
                    counterparty_order_base_asset_amount,
                ),
                PositionDirection::Long => (
                    counterparty_order_base_asset_amount,
                    creator_order_base_asset_amount,
                ),
            };
        let long_oi_plus_order = market
            .amm
            .base_asset_amount_long
            .safe_add(order_long_base_asset_amount.cast()?)?
            .unsigned_abs();

        let short_oi_plus_order = market
            .amm
            .base_asset_amount_short
            .safe_sub(order_short_base_asset_amount.cast()?)?
            .unsigned_abs();

        validate!(
            short_oi_plus_order <= max_oi,
            ErrorCode::MaxOpenInterest,
            "Order Base Amount={} could breach Max Open Interest for Perp Market={}",
            order_short_base_asset_amount,
            params.market_index
        )?;
        validate!(
            long_oi_plus_order <= max_oi,
            ErrorCode::MaxOpenInterest,
            "Order Base Amount={} could breach Max Open Interest for Perp Market={}",
            order_long_base_asset_amount,
            params.market_index
        )?;
    };

    Ok(())
}
