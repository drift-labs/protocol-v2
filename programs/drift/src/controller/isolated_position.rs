use std::cell::RefMut;

use anchor_lang::prelude::*;
use crate::controller::spot_balance::update_spot_balances;
use crate::controller::spot_position::update_spot_balances_and_cumulative_deposits;
use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::liquidation::is_isolated_margin_being_liquidated;
use crate::math::margin::{validate_spot_margin_trading, MarginRequirementType};
use crate::state::events::{
    DepositDirection, DepositExplanation, DepositRecord,
};
use crate::state::perp_market::MarketStatus;
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::oracle_map::OracleMap;
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::spot_market::SpotBalanceType;
use crate::state::state::State;
use crate::state::user::{
    User,UserStats,
};
use crate::validate;
use crate::controller;
use crate::get_then_update_id;

#[cfg(test)]
mod tests;

pub fn deposit_into_isolated_perp_position<'c: 'info, 'info>(
    user_key: Pubkey,
    user: &mut User,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    slot: u64,
    now: i64,
    state: &State,
    spot_market_index: u16,
    perp_market_index: u16,
    amount: u64,
) -> DriftResult<()> {
    validate!(
        amount != 0,
        ErrorCode::InsufficientDeposit,
        "deposit amount cant be 0",
    )?;

    validate!(!user.is_bankrupt(), ErrorCode::UserBankrupt)?;

    let perp_market = perp_market_map.get_ref(&perp_market_index)?;

    validate!(
        perp_market.quote_spot_market_index == spot_market_index,
        ErrorCode::InvalidIsolatedPerpMarket,
        "perp market quote spot market index ({}) != spot market index ({})",
        perp_market.quote_spot_market_index,
        spot_market_index
    )?;

    let mut spot_market = spot_market_map.get_ref_mut(&spot_market_index)?;
    let oracle_price_data = *oracle_map.get_price_data(&spot_market.oracle_id())?;

    validate!(
        user.pool_id == spot_market.pool_id,
        ErrorCode::InvalidPoolId,
        "user pool id ({}) != market pool id ({})",
        user.pool_id,
        spot_market.pool_id
    )?;

    validate!(
        !matches!(spot_market.status, MarketStatus::Initialized),
        ErrorCode::MarketBeingInitialized,
        "Market is being initialized"
    )?;

    controller::spot_balance::update_spot_market_cumulative_interest(
        &mut spot_market,
        Some(&oracle_price_data),
        now,
    )?;

    user.increment_total_deposits(
        amount,
        oracle_price_data.price,
        spot_market.get_precision().cast()?,
    )?;

    let total_deposits_after = user.total_deposits;
    let total_withdraws_after = user.total_withdraws;

    {
        let perp_position = user.force_get_isolated_perp_position_mut(perp_market_index)?;

        update_spot_balances(
            amount.cast::<u128>()?,
            &SpotBalanceType::Deposit,
            &mut spot_market,
            perp_position,
            false,
        )?;
    }

    validate!(
        matches!(spot_market.status, MarketStatus::Active),
        ErrorCode::MarketActionPaused,
        "spot_market not active",
    )?;

    drop(spot_market);

    if user.is_isolated_margin_being_liquidated(perp_market_index)? {
        // try to update liquidation status if user is was already being liq'd
        let is_being_liquidated = is_isolated_margin_being_liquidated(
            user,
            perp_market_map,
            spot_market_map,
            oracle_map,
            perp_market_index,
            state.liquidation_margin_buffer_ratio,
        )?;

        if !is_being_liquidated {
            user.exit_isolated_margin_liquidation(perp_market_index)?;
        }
    }

    user.update_last_active_slot(slot);

    let spot_market = &mut spot_market_map.get_ref_mut(&spot_market_index)?;

    let deposit_record_id = get_then_update_id!(spot_market, next_deposit_record_id);
    let oracle_price = oracle_price_data.price;

    let deposit_record = DepositRecord {
        ts: now,
        deposit_record_id,
        user_authority: user.authority,
        user: user_key,
        direction: DepositDirection::Deposit,
        amount,
        oracle_price,
        market_deposit_balance: spot_market.deposit_balance,
        market_withdraw_balance: spot_market.borrow_balance,
        market_cumulative_deposit_interest: spot_market.cumulative_deposit_interest,
        market_cumulative_borrow_interest: spot_market.cumulative_borrow_interest,
        total_deposits_after,
        total_withdraws_after,
        market_index: spot_market_index,
        explanation: DepositExplanation::None,
        transfer_user: None,
    };

    emit!(deposit_record);

    Ok(())
}

pub fn transfer_isolated_perp_position_deposit<'c: 'info, 'info>(
    user: &mut User,
    user_stats: &mut UserStats,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    slot: u64,
    now: i64,
    spot_market_index: u16,
    perp_market_index: u16,
    amount: i64,
) -> DriftResult<()> {
    validate!(
        amount != 0,
        ErrorCode::DefaultError,
        "transfer amount cant be 0",
    )?;

    validate!(!user.is_bankrupt(), ErrorCode::UserBankrupt)?;

    {
        let perp_market = &perp_market_map.get_ref(&perp_market_index)?;
        let spot_market = &mut spot_market_map.get_ref_mut(&spot_market_index)?;

        validate!(
            perp_market.quote_spot_market_index == spot_market_index,
            ErrorCode::InvalidIsolatedPerpMarket,
            "perp market quote spot market index ({}) != spot market index ({})",
            perp_market.quote_spot_market_index,
            spot_market_index
        )?;

        validate!(
            user.pool_id == spot_market.pool_id && user.pool_id == perp_market.pool_id,
            ErrorCode::InvalidPoolId,
            "user pool id ({}) != market pool id ({})",
            user.pool_id,
            spot_market.pool_id
        )?;

        let oracle_price_data = oracle_map.get_price_data(&spot_market.oracle_id())?;
        controller::spot_balance::update_spot_market_cumulative_interest(
            spot_market,
            Some(oracle_price_data),
            now,
        )?;
    }

    if amount > 0 {
        let mut spot_market = spot_market_map.get_ref_mut(&spot_market_index)?;

        let spot_position_index = user.force_get_spot_position_index(spot_market.market_index)?;
        update_spot_balances_and_cumulative_deposits(
            amount as u128,
            &SpotBalanceType::Borrow,
            &mut spot_market,
            &mut user.spot_positions[spot_position_index],
            false,
            None,
        )?;

        update_spot_balances(
            amount as u128,
            &SpotBalanceType::Deposit,
            &mut spot_market,
            user.force_get_isolated_perp_position_mut(perp_market_index)?,
            false,
        )?;

        drop(spot_market);

        user.meets_withdraw_margin_requirement_and_increment_fuel_bonus(
            &perp_market_map,
            &spot_market_map,
            oracle_map,
            MarginRequirementType::Initial,
            spot_market_index,
            amount as u128,
            user_stats,
            now,
        )?;

        validate_spot_margin_trading(user, &perp_market_map, &spot_market_map, oracle_map)?;

        if user.is_cross_margin_being_liquidated() {
            user.exit_cross_margin_liquidation();
        }

        if user.is_isolated_margin_being_liquidated(perp_market_index)? {
            user.exit_isolated_margin_liquidation(perp_market_index)?;
        }
    } else {
        let mut spot_market = spot_market_map.get_ref_mut(&spot_market_index)?;

        let isolated_perp_position_token_amount = user
            .force_get_isolated_perp_position_mut(perp_market_index)?
            .get_isolated_token_amount(&spot_market)?;

        validate!(
            amount.unsigned_abs() as u128 <= isolated_perp_position_token_amount,
            ErrorCode::InsufficientCollateral,
            "user has insufficient deposit for market {}",
            spot_market_index
        )?;

        let spot_position_index = user.force_get_spot_position_index(spot_market.market_index)?;
        update_spot_balances_and_cumulative_deposits(
            amount.abs() as u128,
            &SpotBalanceType::Deposit,
            &mut spot_market,
            &mut user.spot_positions[spot_position_index],
            false,
            None,
        )?;

        update_spot_balances(
            amount.abs() as u128,
            &SpotBalanceType::Borrow,
            &mut spot_market,
            user.force_get_isolated_perp_position_mut(perp_market_index)?,
            false,
        )?;

        drop(spot_market);

        user.meets_withdraw_margin_requirement_and_increment_fuel_bonus(
            &perp_market_map,
            &spot_market_map,
            oracle_map,
            MarginRequirementType::Initial,
            0,
            0,
            user_stats,
            now,
        )?;

        if user.is_isolated_margin_being_liquidated(perp_market_index)? {
            user.exit_isolated_margin_liquidation(perp_market_index)?;
        }

        if user.is_cross_margin_being_liquidated() {
            user.exit_cross_margin_liquidation();
        }
    }

    user.update_last_active_slot(slot);

    Ok(())
}

pub fn withdraw_from_isolated_perp_position<'c: 'info, 'info>(
    user_key: Pubkey,
    user: &mut User,
    user_stats: &mut UserStats,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    slot: u64,
    now: i64,
    spot_market_index: u16,
    perp_market_index: u16,
    amount: u64,
) -> DriftResult<()> {
    validate!(
        amount != 0,
        ErrorCode::DefaultError,
        "withdraw amount cant be 0",
    )?;

    validate!(!user.is_bankrupt(), ErrorCode::UserBankrupt)?;

    {
        let perp_market = &perp_market_map.get_ref(&perp_market_index)?;

        validate!(
            perp_market.quote_spot_market_index == spot_market_index,
            ErrorCode::InvalidIsolatedPerpMarket,
            "perp market quote spot market index ({}) != spot market index ({})",
            perp_market.quote_spot_market_index,
            spot_market_index
        )?;

        let spot_market = &mut spot_market_map.get_ref_mut(&spot_market_index)?;
        let oracle_price_data = oracle_map.get_price_data(&spot_market.oracle_id())?;

        controller::spot_balance::update_spot_market_cumulative_interest(
            spot_market,
            Some(oracle_price_data),
            now,
        )?;

        user.increment_total_withdraws(
            amount,
            oracle_price_data.price,
            spot_market.get_precision().cast()?,
        )?;

        let isolated_perp_position =
            user.force_get_isolated_perp_position_mut(perp_market_index)?;

        let isolated_position_token_amount =
            isolated_perp_position.get_isolated_token_amount(spot_market)?;

        validate!(
            amount as u128 <= isolated_position_token_amount,
            ErrorCode::InsufficientCollateral,
            "user has insufficient deposit for market {}",
            spot_market_index
        )?;

        update_spot_balances(
            amount as u128,
            &SpotBalanceType::Borrow,
            spot_market,
            isolated_perp_position,
            true,
        )?;
    }

    user.meets_withdraw_margin_requirement_and_increment_fuel_bonus(
        &perp_market_map,
        &spot_market_map,
        oracle_map,
        MarginRequirementType::Initial,
        0,
        0,
        user_stats,
        now,
    )?;

    if user.is_isolated_margin_being_liquidated(perp_market_index)? {
        user.exit_isolated_margin_liquidation(perp_market_index)?;
    }

    user.update_last_active_slot(slot);

    let mut spot_market = spot_market_map.get_ref_mut(&spot_market_index)?;
    let oracle_price = oracle_map.get_price_data(&spot_market.oracle_id())?.price;

    let deposit_record_id = get_then_update_id!(spot_market, next_deposit_record_id);
    let deposit_record = DepositRecord {
        ts: now,
        deposit_record_id,
        user_authority: user.authority,
        user: user_key,
        direction: DepositDirection::Withdraw,
        oracle_price,
        amount,
        market_index: spot_market_index,
        market_deposit_balance: spot_market.deposit_balance,
        market_withdraw_balance: spot_market.borrow_balance,
        market_cumulative_deposit_interest: spot_market.cumulative_deposit_interest,
        market_cumulative_borrow_interest: spot_market.cumulative_borrow_interest,
        total_deposits_after: user.total_deposits,
        total_withdraws_after: user.total_withdraws,
        explanation: DepositExplanation::None,
        transfer_user: None,
    };
    emit!(deposit_record);

    Ok(())
}