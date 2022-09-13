use crate::controller::funding::settle_funding_payment;
use crate::controller::lp::burn_lp_shares;
use crate::controller::orders::{cancel_order, pay_keeper_flat_reward_for_perps};
use crate::controller::position::{
    get_position_index, update_position_and_market, update_quote_asset_amount,
};
use crate::controller::spot_balance::{
    update_revenue_pool_balances, update_spot_balances, update_spot_market_cumulative_interest,
};
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::get_then_update_id;
use crate::math::bankruptcy::is_user_bankrupt;
use crate::math::casting::{cast, cast_to_i128, cast_to_u128, cast_to_u64};
use crate::math::constants::{LIQUIDATION_FEE_PRECISION, MARGIN_PRECISION, SPOT_WEIGHT_PRECISION};
use crate::math::liquidation::{
    calculate_asset_transfer_for_liability_transfer,
    calculate_base_asset_amount_to_cover_margin_shortage,
    calculate_cumulative_deposit_interest_delta_to_resolve_bankruptcy,
    calculate_funding_rate_deltas_to_resolve_bankruptcy,
    calculate_liability_transfer_implied_by_asset_amount,
    calculate_liability_transfer_to_cover_margin_shortage, calculate_liquidation_multiplier,
    get_margin_requirement_plus_buffer, LiquidationMultiplierType,
};
use crate::math::margin::{
    calculate_margin_requirement_and_total_collateral, meets_initial_margin_requirement,
    MarginRequirementType,
};
use crate::math::orders::{get_position_delta_for_fill, standardize_base_asset_amount};
use crate::math::position::calculate_base_asset_value_with_oracle_price;
use crate::math::spot_balance::get_token_amount;
use crate::math_error;
use crate::state::events::{
    BorrowBankruptcyRecord, LiquidateBorrowForPerpPnlRecord, LiquidateBorrowRecord,
    LiquidatePerpPnlForDepositRecord, LiquidatePerpRecord, LiquidationRecord, LiquidationType,
    OrderActionExplanation, PerpBankruptcyRecord,
};
use crate::state::market::MarketStatus;
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_market::SpotBalanceType;
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::user::{MarketType, User, UserStats};
use crate::validate;
use anchor_lang::prelude::*;
use solana_program::msg;
use std::ops::{Deref, DerefMut};

#[cfg(test)]
mod tests;

pub fn liquidate_perp(
    market_index: u64,
    liquidator_max_base_asset_amount: u128,
    user: &mut User,
    user_key: &Pubkey,
    user_stats: &mut UserStats,
    liquidator: &mut User,
    liquidator_key: &Pubkey,
    liquidator_stats: &mut UserStats,
    market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    slot: u64,
    now: i64,
    liquidation_margin_buffer_ratio: u8,
    cancel_order_fee: u128,
) -> ClearingHouseResult {
    validate!(!user.bankrupt, ErrorCode::UserBankrupt, "user bankrupt",)?;

    validate!(
        !liquidator.being_liquidated,
        ErrorCode::UserIsBeingLiquidated,
        "liquidator bankrupt",
    )?;

    validate!(
        !liquidator.bankrupt,
        ErrorCode::UserBankrupt,
        "liquidator bankrupt",
    )?;

    user.get_perp_position(market_index).map_err(|e| {
        msg!(
            "User does not have a position for perp market {}",
            market_index
        );
        e
    })?;

    liquidator
        .force_get_perp_position_mut(market_index)
        .map_err(|e| {
            msg!(
                "Liquidator has no available positions to take on perp position in market {}",
                market_index
            );
            e
        })?;

    // Settle user's funding payments so that collateral is up to date
    settle_funding_payment(
        user,
        user_key,
        market_map.get_ref_mut(&market_index)?.deref_mut(),
        now,
    )?;

    // Settle user's funding payments so that collateral is up to date
    settle_funding_payment(
        liquidator,
        liquidator_key,
        market_map.get_ref_mut(&market_index)?.deref_mut(),
        now,
    )?;

    let (margin_requirement, mut total_collateral) =
        calculate_margin_requirement_and_total_collateral(
            user,
            market_map,
            MarginRequirementType::Maintenance,
            spot_market_map,
            oracle_map,
        )?;

    let mut margin_requirement_plus_buffer =
        get_margin_requirement_plus_buffer(margin_requirement, liquidation_margin_buffer_ratio)?;

    if !user.being_liquidated && total_collateral >= cast(margin_requirement)? {
        return Err(ErrorCode::SufficientCollateral);
    } else if user.being_liquidated && total_collateral >= cast(margin_requirement_plus_buffer)? {
        user.being_liquidated = false;
        return Ok(());
    }

    let liquidation_id = set_being_liquidated_and_get_liquidation_id(user)?;

    let position_index = get_position_index(&user.perp_positions, market_index)?;
    validate!(
        user.perp_positions[position_index].is_open_position()
            || user.perp_positions[position_index].has_open_order()
            || user.perp_positions[position_index].is_lp(),
        ErrorCode::PositionDoesntHaveOpenPositionOrOrders
    )?;

    let worst_case_base_asset_amount_before =
        user.perp_positions[position_index].worst_case_base_asset_amount()?;
    let mut canceled_order_ids: Vec<u64> = vec![];
    let mut canceled_orders_fee = 0_u128;
    for order_index in 0..user.orders.len() {
        if !user.orders[order_index].is_open_order_for_market(market_index, &MarketType::Perp) {
            continue;
        }

        canceled_orders_fee = canceled_orders_fee
            .checked_add(cancel_order_fee)
            .ok_or_else(math_error!())?;
        total_collateral = total_collateral
            .checked_sub(cast(cancel_order_fee)?)
            .ok_or_else(math_error!())?;
        pay_keeper_flat_reward_for_perps(
            user,
            Some(liquidator),
            market_map.get_ref_mut(&market_index)?.deref_mut(),
            cancel_order_fee,
        )?;

        canceled_order_ids.push(user.orders[order_index].order_id);
        cancel_order(
            order_index,
            user,
            user_key,
            market_map,
            spot_market_map,
            oracle_map,
            now,
            slot,
            OrderActionExplanation::CanceledForLiquidation,
            Some(liquidator_key),
            cancel_order_fee,
            true,
        )?;
    }

    let market = market_map.get_ref(&market_index)?;

    let oracle_price = if market.status == MarketStatus::Settlement {
        market.settlement_price
    } else {
        oracle_map.get_price_data(&market.amm.oracle)?.price
    };

    drop(market);

    // burning lp shares = removing open bids/asks
    let lp_shares = user.perp_positions[position_index].lp_shares;
    if lp_shares > 0 {
        burn_lp_shares(
            &mut user.perp_positions[position_index],
            market_map.get_ref_mut(&market_index)?.deref_mut(),
            lp_shares,
            oracle_price,
        )?;
    }

    let worst_case_base_asset_amount_after =
        user.perp_positions[position_index].worst_case_base_asset_amount()?;
    let worse_case_base_asset_amount_delta = worst_case_base_asset_amount_before
        .checked_sub(worst_case_base_asset_amount_after)
        .ok_or_else(math_error!())?;

    let margin_ratio = market_map.get_ref(&market_index)?.get_margin_ratio(
        worst_case_base_asset_amount_before.unsigned_abs(),
        MarginRequirementType::Maintenance,
    )?;

    if worse_case_base_asset_amount_delta != 0 {
        let base_asset_value = calculate_base_asset_value_with_oracle_price(
            worse_case_base_asset_amount_delta,
            oracle_price,
        )?;

        let margin_requirement_delta = base_asset_value
            .checked_mul(margin_ratio as u128)
            .ok_or_else(math_error!())?
            .checked_div(MARGIN_PRECISION)
            .ok_or_else(math_error!())?;

        margin_requirement_plus_buffer = margin_requirement_plus_buffer
            .checked_sub(margin_requirement_delta)
            .ok_or_else(math_error!())?;
    }

    if total_collateral >= cast(margin_requirement_plus_buffer)? {
        emit!(LiquidationRecord {
            ts: now,
            liquidation_id,
            liquidation_type: LiquidationType::LiquidatePerp,
            user: *user_key,
            liquidator: *liquidator_key,
            margin_requirement,
            total_collateral,
            bankrupt: user.bankrupt,
            liquidate_perp: LiquidatePerpRecord {
                market_index,
                order_ids: canceled_order_ids,
                oracle_price,
                canceled_orders_fee,
                lp_shares,
                ..LiquidatePerpRecord::default()
            },
            ..LiquidationRecord::default()
        });

        user.being_liquidated = false;
        return Ok(());
    }

    if user.perp_positions[position_index].base_asset_amount == 0 {
        msg!("User has no base asset amount");
        return Ok(());
    }

    validate!(
        liquidator_max_base_asset_amount != 0,
        ErrorCode::InvalidBaseAssetAmountForLiquidatePerp,
        "liquidator_max_base_asset_amount cant be 0"
    )?;

    let user_base_asset_amount = user.perp_positions[position_index]
        .base_asset_amount
        .unsigned_abs();

    let margin_shortage = cast_to_i128(margin_requirement_plus_buffer)?
        .checked_sub(total_collateral)
        .ok_or_else(math_error!())?
        .unsigned_abs();

    let liquidation_fee = market_map.get_ref(&market_index)?.liquidation_fee;
    let base_asset_amount_to_cover_margin_shortage =
        calculate_base_asset_amount_to_cover_margin_shortage(
            margin_shortage,
            margin_ratio,
            liquidation_fee,
            oracle_price,
        )?;

    let base_asset_amount = user_base_asset_amount
        .min(liquidator_max_base_asset_amount)
        .min(base_asset_amount_to_cover_margin_shortage);

    let base_asset_amount = standardize_base_asset_amount(
        base_asset_amount,
        market_map
            .get_ref(&market_index)?
            .amm
            .base_asset_amount_step_size,
    )?;

    let liquidation_multiplier = calculate_liquidation_multiplier(
        liquidation_fee,
        if user.perp_positions[position_index].base_asset_amount > 0 {
            LiquidationMultiplierType::Discount // Sell at discount if user is long
        } else {
            LiquidationMultiplierType::Premium // premium if user is short
        },
    )?;
    let base_asset_value =
        calculate_base_asset_value_with_oracle_price(cast(base_asset_amount)?, oracle_price)?;
    let quote_asset_amount = base_asset_value
        .checked_mul(liquidation_multiplier)
        .ok_or_else(math_error!())?
        .checked_div(LIQUIDATION_FEE_PRECISION)
        .ok_or_else(math_error!())?;

    user_stats.update_taker_volume_30d(cast(quote_asset_amount)?, now)?;
    liquidator_stats.update_maker_volume_30d(cast(quote_asset_amount)?, now)?;

    let user_position_delta = get_position_delta_for_fill(
        base_asset_amount,
        quote_asset_amount,
        user.perp_positions[position_index].get_direction_to_close(),
    )?;

    let liquidator_position_delta = get_position_delta_for_fill(
        base_asset_amount,
        quote_asset_amount,
        user.perp_positions[position_index].get_direction(),
    )?;

    let (user_pnl, liquidator_pnl) = {
        let mut market = market_map.get_ref_mut(&market_index)?;

        let user_position = user.get_perp_position_mut(market_index).unwrap();
        let user_pnl =
            update_position_and_market(user_position, &mut market, &user_position_delta)?;

        let liquidator_position = liquidator
            .force_get_perp_position_mut(market_index)
            .unwrap();
        let liquidator_pnl = update_position_and_market(
            liquidator_position,
            &mut market,
            &liquidator_position_delta,
        )?;
        (user_pnl, liquidator_pnl)
    };

    if base_asset_amount >= base_asset_amount_to_cover_margin_shortage {
        user.being_liquidated = false;
    } else {
        user.bankrupt = is_user_bankrupt(user);
    }

    let liquidator_meets_initial_margin_requirement =
        meets_initial_margin_requirement(liquidator, market_map, spot_market_map, oracle_map)?;

    validate!(
        liquidator_meets_initial_margin_requirement,
        ErrorCode::InsufficientCollateral,
        "Liquidator doesnt have enough collateral to take over perp position"
    )?;

    // Increment ids so users can make order records off chain
    let user_order_id = get_then_update_id!(user, next_order_id);
    let liquidator_order_id = get_then_update_id!(liquidator, next_order_id);
    let fill_record_id = {
        let mut market = market_map.get_ref_mut(&market_index)?;
        get_then_update_id!(market, next_fill_record_id)
    };

    emit!(LiquidationRecord {
        ts: now,
        liquidation_id,
        liquidation_type: LiquidationType::LiquidatePerp,
        user: *user_key,
        liquidator: *liquidator_key,
        margin_requirement,
        total_collateral,
        bankrupt: user.bankrupt,
        liquidate_perp: LiquidatePerpRecord {
            market_index,
            order_ids: canceled_order_ids,
            oracle_price,
            base_asset_amount: user_position_delta.base_asset_amount,
            quote_asset_amount: user_position_delta.quote_asset_amount,
            lp_shares,
            user_pnl,
            liquidator_pnl,
            canceled_orders_fee,
            user_order_id,
            liquidator_order_id,
            fill_record_id,
        },
        ..LiquidationRecord::default()
    });

    Ok(())
}

pub fn liquidate_borrow(
    asset_market_index: u64,
    liability_market_index: u64,
    liquidator_max_liability_transfer: u128,
    user: &mut User,
    user_key: &Pubkey,
    liquidator: &mut User,
    liquidator_key: &Pubkey,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    now: i64,
    liquidation_margin_buffer_ratio: u8,
) -> ClearingHouseResult {
    validate!(!user.bankrupt, ErrorCode::UserBankrupt, "user bankrupt",)?;

    validate!(
        !liquidator.being_liquidated,
        ErrorCode::UserIsBeingLiquidated,
        "liquidator bankrupt",
    )?;

    validate!(
        !liquidator.bankrupt,
        ErrorCode::UserBankrupt,
        "liquidator bankrupt",
    )?;

    // validate user and liquidator have spot balances
    user.get_spot_position(asset_market_index).ok_or_else(|| {
        msg!(
            "User does not have a spot balance for asset market {}",
            asset_market_index
        );
        ErrorCode::CouldNotFindSpotPosition
    })?;

    user.get_spot_position(liability_market_index)
        .ok_or_else(|| {
            msg!(
                "User does not have a spot balance for liability market {}",
                liability_market_index
            );
            ErrorCode::CouldNotFindSpotPosition
        })?;

    liquidator
        .force_get_spot_position_mut(asset_market_index)
        .map_err(|e| {
            msg!("Liquidator has no available spot balances to take on deposit");
            e
        })?;

    liquidator
        .force_get_spot_position_mut(liability_market_index)
        .map_err(|e| {
            msg!("Liquidator has no available spot balances to take on borrow");
            e
        })?;

    let (asset_amount, asset_price, asset_decimals, asset_weight, asset_liquidation_multiplier) = {
        let mut asset_market = spot_market_map.get_ref_mut(&asset_market_index)?;
        update_spot_market_cumulative_interest(&mut asset_market, now)?;

        let spot_deposit_position = user.get_spot_position(asset_market_index).unwrap();

        validate!(
            spot_deposit_position.balance_type == SpotBalanceType::Deposit,
            ErrorCode::WrongSpotBalanceType,
            "User did not have a deposit for the asset market index"
        )?;

        let token_amount = get_token_amount(
            spot_deposit_position.balance,
            &asset_market,
            &spot_deposit_position.balance_type,
        )?;

        // TODO add oracle checks
        let asset_price = oracle_map.get_price_data(&asset_market.oracle)?.price;

        (
            token_amount,
            asset_price,
            asset_market.decimals,
            asset_market.maintenance_asset_weight,
            calculate_liquidation_multiplier(
                asset_market.liquidation_fee,
                LiquidationMultiplierType::Premium,
            )?,
        )
    };

    let (
        liability_amount,
        liability_price,
        liability_decimals,
        liability_weight,
        liability_liquidation_multiplier,
    ) = {
        let mut liability_market = spot_market_map.get_ref_mut(&liability_market_index)?;
        update_spot_market_cumulative_interest(&mut liability_market, now)?;

        let spot_position = user.get_spot_position(liability_market_index).unwrap();

        validate!(
            spot_position.balance_type == SpotBalanceType::Borrow,
            ErrorCode::WrongSpotBalanceType,
            "User did not have a borrow for the liability market index"
        )?;

        let token_amount = get_token_amount(
            spot_position.balance,
            &liability_market,
            &spot_position.balance_type,
        )?;

        // TODO add oracle checks
        let liability_price = oracle_map.get_price_data(&liability_market.oracle)?.price;

        (
            token_amount,
            liability_price,
            liability_market.decimals,
            liability_market.maintenance_liability_weight,
            calculate_liquidation_multiplier(
                liability_market.liquidation_fee,
                LiquidationMultiplierType::Discount,
            )?,
        )
    };

    let (margin_requirement, total_collateral) = calculate_margin_requirement_and_total_collateral(
        user,
        perp_market_map,
        MarginRequirementType::Maintenance,
        spot_market_map,
        oracle_map,
    )?;

    let margin_requirement_plus_buffer =
        get_margin_requirement_plus_buffer(margin_requirement, liquidation_margin_buffer_ratio)?;

    if !user.being_liquidated && total_collateral >= cast(margin_requirement)? {
        return Err(ErrorCode::SufficientCollateral);
    } else if user.being_liquidated && total_collateral >= cast(margin_requirement_plus_buffer)? {
        user.being_liquidated = false;
        return Ok(());
    }

    let liquidation_id = set_being_liquidated_and_get_liquidation_id(user)?;

    let margin_shortage = cast_to_i128(margin_requirement_plus_buffer)?
        .checked_sub(total_collateral)
        .ok_or_else(math_error!())?
        .unsigned_abs();

    // Determine what amount of borrow to transfer to reduce margin shortage to 0
    let liability_transfer_to_cover_margin_shortage =
        calculate_liability_transfer_to_cover_margin_shortage(
            margin_shortage,
            asset_weight,
            asset_liquidation_multiplier,
            liability_weight,
            liability_liquidation_multiplier,
            liability_decimals,
            liability_price,
        )?;

    // Given the user's deposit amount, how much borrow can be transferred?
    let liability_transfer_implied_by_asset_amount =
        calculate_liability_transfer_implied_by_asset_amount(
            asset_amount,
            asset_liquidation_multiplier,
            asset_decimals,
            asset_price,
            liability_liquidation_multiplier,
            liability_decimals,
            liability_price,
        )?;

    let liability_transfer = liquidator_max_liability_transfer
        .min(liability_amount)
        .min(liability_transfer_to_cover_margin_shortage)
        .min(liability_transfer_implied_by_asset_amount);

    // Given the borrow amount to transfer, determine how much deposit amount to transfer
    let asset_transfer = calculate_asset_transfer_for_liability_transfer(
        asset_amount,
        asset_liquidation_multiplier,
        asset_decimals,
        asset_price,
        liability_transfer,
        liability_liquidation_multiplier,
        liability_decimals,
        liability_price,
    )?;

    let liability_transfer_for_user: u128;
    {
        let mut liability_market = spot_market_map.get_ref_mut(&liability_market_index)?;

        // part liquidator liability transfer pays to insurance fund
        // size will be eventually be 0 for sufficiently small liability size
        let liability_transfer_for_insurance = liability_transfer
            .checked_mul(liability_market.liquidation_if_factor as u128)
            .ok_or_else(math_error!())?
            .checked_div(LIQUIDATION_FEE_PRECISION)
            .ok_or_else(math_error!())?;

        liability_transfer_for_user = liability_transfer
            .checked_sub(liability_transfer_for_insurance)
            .ok_or_else(math_error!())?;

        update_revenue_pool_balances(
            liability_transfer_for_insurance,
            &SpotBalanceType::Deposit,
            &mut liability_market,
        )?;

        update_spot_balances(
            liability_transfer_for_user,
            &SpotBalanceType::Deposit,
            &mut liability_market,
            user.get_spot_position_mut(liability_market_index).unwrap(),
            false,
        )?;

        update_spot_balances(
            liability_transfer,
            &SpotBalanceType::Borrow,
            &mut liability_market,
            liquidator
                .get_spot_position_mut(liability_market_index)
                .unwrap(),
            false,
        )?;
    }

    {
        let mut asset_market = spot_market_map.get_ref_mut(&asset_market_index)?;

        update_spot_balances(
            asset_transfer,
            &SpotBalanceType::Borrow,
            &mut asset_market,
            user.get_spot_position_mut(asset_market_index).unwrap(),
            false,
        )?;

        update_spot_balances(
            asset_transfer,
            &SpotBalanceType::Deposit,
            &mut asset_market,
            liquidator
                .get_spot_position_mut(asset_market_index)
                .unwrap(),
            false,
        )?;
    }

    if liability_transfer_for_user >= liability_transfer_to_cover_margin_shortage {
        user.being_liquidated = false;
    } else {
        user.bankrupt = is_user_bankrupt(user);
    }

    let liquidator_meets_initial_margin_requirement =
        meets_initial_margin_requirement(liquidator, perp_market_map, spot_market_map, oracle_map)?;

    validate!(
        liquidator_meets_initial_margin_requirement,
        ErrorCode::InsufficientCollateral,
        "Liquidator doesnt have enough collateral to take over borrow"
    )?;

    emit!(LiquidationRecord {
        ts: now,
        liquidation_id,
        liquidation_type: LiquidationType::LiquidateBorrow,
        user: *user_key,
        liquidator: *liquidator_key,
        margin_requirement,
        total_collateral,
        bankrupt: user.bankrupt,
        liquidate_borrow: LiquidateBorrowRecord {
            asset_market_index,
            asset_price,
            asset_transfer,
            liability_market_index,
            liability_price,
            liability_transfer,
        },
        ..LiquidationRecord::default()
    });

    Ok(())
}

pub fn liquidate_borrow_for_perp_pnl(
    perp_market_index: u64,
    liability_market_index: u64,
    liquidator_max_liability_transfer: u128,
    user: &mut User,
    user_key: &Pubkey,
    liquidator: &mut User,
    liquidator_key: &Pubkey,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    now: i64,
    liquidation_margin_buffer_ratio: u8,
) -> ClearingHouseResult {
    validate!(!user.bankrupt, ErrorCode::UserBankrupt, "user bankrupt",)?;

    validate!(
        !liquidator.being_liquidated,
        ErrorCode::UserIsBeingLiquidated,
        "liquidator bankrupt",
    )?;

    validate!(
        !liquidator.bankrupt,
        ErrorCode::UserBankrupt,
        "liquidator bankrupt",
    )?;

    user.get_perp_position(perp_market_index).map_err(|e| {
        msg!(
            "User does not have a position for perp market {}",
            perp_market_index
        );
        e
    })?;

    user.get_spot_position(liability_market_index)
        .ok_or_else(|| {
            msg!(
                "User does not have a spot balance for liability market {}",
                liability_market_index
            );
            ErrorCode::CouldNotFindSpotPosition
        })?;

    liquidator
        .force_get_perp_position_mut(perp_market_index)
        .map_err(|e| {
            msg!("Liquidator has no available positions to take on pnl");
            e
        })?;

    liquidator
        .force_get_spot_position_mut(liability_market_index)
        .map_err(|e| {
            msg!("Liquidator has no available spot balances to take on borrow");
            e
        })?;

    settle_funding_payment(
        user,
        user_key,
        perp_market_map.get_ref_mut(&perp_market_index)?.deref_mut(),
        now,
    )?;

    settle_funding_payment(
        liquidator,
        liquidator_key,
        perp_market_map.get_ref_mut(&perp_market_index)?.deref_mut(),
        now,
    )?;

    let (pnl, quote_price, quote_decimals, pnl_asset_weight, pnl_liquidation_multiplier) = {
        let user_position = user.get_perp_position(perp_market_index).unwrap();

        let base_asset_amount = user_position.base_asset_amount;

        validate!(
            base_asset_amount == 0,
            ErrorCode::InvalidPerpPositionToLiquidate,
            "Cant have open perp position (base_asset_amount: {})",
            base_asset_amount
        )?;

        validate!(
            user_position.open_orders == 0,
            ErrorCode::InvalidPerpPositionToLiquidate,
            "Cant have open orders for perp position"
        )?;

        let pnl = user_position.quote_asset_amount;

        validate!(
            pnl > 0,
            ErrorCode::InvalidPerpPositionToLiquidate,
            "Perp position must have position pnl"
        )?;

        let quote_price = oracle_map.quote_asset_price_data.price;

        let market = perp_market_map.get_ref(&perp_market_index)?;

        let pnl_asset_weight =
            market.get_unrealized_asset_weight(pnl, MarginRequirementType::Maintenance)?;

        (
            pnl.unsigned_abs(),
            quote_price,
            6_u8,
            pnl_asset_weight,
            calculate_liquidation_multiplier(
                market.liquidation_fee,
                LiquidationMultiplierType::Premium,
            )?,
        )
    };

    let (
        liability_amount,
        liability_price,
        liability_decimals,
        liability_weight,
        liability_liquidation_multiplier,
    ) = {
        let mut liability_market = spot_market_map.get_ref_mut(&liability_market_index)?;
        update_spot_market_cumulative_interest(&mut liability_market, now)?;

        let spot_position = user.get_spot_position(liability_market_index).unwrap();

        validate!(
            spot_position.balance_type == SpotBalanceType::Borrow,
            ErrorCode::WrongSpotBalanceType,
            "User did not have a borrow for the borrow market index"
        )?;

        let token_amount = get_token_amount(
            spot_position.balance,
            &liability_market,
            &spot_position.balance_type,
        )?;

        // TODO add oracle checks
        let liability_price = oracle_map.get_price_data(&liability_market.oracle)?.price;

        (
            token_amount,
            liability_price,
            liability_market.decimals,
            liability_market.maintenance_liability_weight,
            calculate_liquidation_multiplier(
                liability_market.liquidation_fee,
                LiquidationMultiplierType::Discount,
            )?,
        )
    };

    let (margin_requirement, total_collateral) = calculate_margin_requirement_and_total_collateral(
        user,
        perp_market_map,
        MarginRequirementType::Maintenance,
        spot_market_map,
        oracle_map,
    )?;

    let margin_requirement_plus_buffer =
        get_margin_requirement_plus_buffer(margin_requirement, liquidation_margin_buffer_ratio)?;

    if !user.being_liquidated && total_collateral >= cast(margin_requirement)? {
        return Err(ErrorCode::SufficientCollateral);
    } else if user.being_liquidated && total_collateral >= cast(margin_requirement_plus_buffer)? {
        user.being_liquidated = false;
        return Ok(());
    }

    let liquidation_id = set_being_liquidated_and_get_liquidation_id(user)?;

    let margin_shortage = cast_to_i128(margin_requirement_plus_buffer)?
        .checked_sub(total_collateral)
        .ok_or_else(math_error!())?
        .unsigned_abs();

    // Determine what amount of borrow to transfer to reduce margin shortage to 0
    let liability_transfer_to_cover_margin_shortage =
        calculate_liability_transfer_to_cover_margin_shortage(
            margin_shortage,
            pnl_asset_weight as u128,
            pnl_liquidation_multiplier,
            liability_weight,
            liability_liquidation_multiplier,
            liability_decimals,
            liability_price,
        )?;

    // Given the user's deposit amount, how much borrow can be transferred?
    let liability_transfer_implied_by_pnl = calculate_liability_transfer_implied_by_asset_amount(
        pnl,
        pnl_liquidation_multiplier,
        quote_decimals,
        quote_price,
        liability_liquidation_multiplier,
        liability_decimals,
        liability_price,
    )?;

    let liability_transfer = liquidator_max_liability_transfer
        .min(liability_amount)
        .min(liability_transfer_to_cover_margin_shortage)
        .min(liability_transfer_implied_by_pnl);

    // Given the borrow amount to transfer, determine how much deposit amount to transfer
    let pnl_transfer = calculate_asset_transfer_for_liability_transfer(
        pnl,
        pnl_liquidation_multiplier,
        quote_decimals,
        quote_price,
        liability_transfer,
        liability_liquidation_multiplier,
        liability_decimals,
        liability_price,
    )?;

    {
        let mut liability_market = spot_market_map.get_ref_mut(&liability_market_index)?;

        update_spot_balances(
            liability_transfer,
            &SpotBalanceType::Deposit,
            &mut liability_market,
            user.get_spot_position_mut(liability_market_index).unwrap(),
            false,
        )?;

        update_spot_balances(
            liability_transfer,
            &SpotBalanceType::Borrow,
            &mut liability_market,
            liquidator
                .get_spot_position_mut(liability_market_index)
                .unwrap(),
            false,
        )?;
    }

    {
        let mut market = perp_market_map.get_ref_mut(&perp_market_index)?;
        let liquidator_position = liquidator.force_get_perp_position_mut(perp_market_index)?;
        update_quote_asset_amount(
            liquidator_position,
            &mut market,
            cast_to_i128(pnl_transfer)?,
        )?;

        let user_position = user.get_perp_position_mut(perp_market_index)?;
        update_quote_asset_amount(user_position, &mut market, -cast_to_i128(pnl_transfer)?)?;
    }

    if liability_transfer >= liability_transfer_to_cover_margin_shortage {
        user.being_liquidated = false;
    } else {
        user.bankrupt = is_user_bankrupt(user);
    }

    let liquidator_meets_initial_margin_requirement =
        meets_initial_margin_requirement(liquidator, perp_market_map, spot_market_map, oracle_map)?;

    validate!(
        liquidator_meets_initial_margin_requirement,
        ErrorCode::InsufficientCollateral,
        "Liquidator doesnt have enough collateral to take over borrow"
    )?;

    let market_oracle_price = {
        let market = perp_market_map.get_ref_mut(&perp_market_index)?;
        oracle_map.get_price_data(&market.amm.oracle)?.price
    };

    emit!(LiquidationRecord {
        ts: now,
        liquidation_id,
        liquidation_type: LiquidationType::LiquidateBorrowForPerpPnl,
        user: *user_key,
        liquidator: *liquidator_key,
        margin_requirement,
        total_collateral,
        bankrupt: user.bankrupt,
        liquidate_borrow_for_perp_pnl: LiquidateBorrowForPerpPnlRecord {
            perp_market_index,
            market_oracle_price,
            pnl_transfer,
            liability_market_index,
            liability_price,
            liability_transfer,
        },
        ..LiquidationRecord::default()
    });

    Ok(())
}

pub fn liquidate_perp_pnl_for_deposit(
    perp_market_index: u64,
    asset_market_index: u64,
    liquidator_max_pnl_transfer: u128,
    user: &mut User,
    user_key: &Pubkey,
    liquidator: &mut User,
    liquidator_key: &Pubkey,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    now: i64,
    liquidation_margin_buffer_ratio: u8,
) -> ClearingHouseResult {
    validate!(!user.bankrupt, ErrorCode::UserBankrupt, "user bankrupt",)?;

    validate!(
        !liquidator.being_liquidated,
        ErrorCode::UserIsBeingLiquidated,
        "liquidator bankrupt",
    )?;

    validate!(
        !liquidator.bankrupt,
        ErrorCode::UserBankrupt,
        "liquidator bankrupt",
    )?;

    user.get_perp_position(perp_market_index).map_err(|e| {
        msg!(
            "User does not have a position for perp market {}",
            perp_market_index
        );
        e
    })?;

    user.get_spot_position(asset_market_index).ok_or_else(|| {
        msg!(
            "User does not have a spot balance for asset market {}",
            asset_market_index
        );
        ErrorCode::CouldNotFindSpotPosition
    })?;

    liquidator
        .force_get_perp_position_mut(perp_market_index)
        .map_err(|e| {
            msg!("Liquidator has no available positions to take on pnl");
            e
        })?;

    liquidator
        .force_get_spot_position_mut(asset_market_index)
        .map_err(|e| {
            msg!("Liquidator has no available spot balances to take on deposit");
            e
        })?;

    settle_funding_payment(
        user,
        user_key,
        perp_market_map.get_ref_mut(&perp_market_index)?.deref_mut(),
        now,
    )?;

    settle_funding_payment(
        liquidator,
        liquidator_key,
        perp_market_map.get_ref_mut(&perp_market_index)?.deref_mut(),
        now,
    )?;

    let (asset_amount, asset_price, asset_decimals, asset_weight, asset_liquidation_multiplier) = {
        let mut asset_market = spot_market_map.get_ref_mut(&asset_market_index)?;
        update_spot_market_cumulative_interest(&mut asset_market, now)?;

        let spot_position = user.get_spot_position(asset_market_index).unwrap();

        validate!(
            spot_position.balance_type == SpotBalanceType::Deposit,
            ErrorCode::WrongSpotBalanceType,
            "User did not have a deposit for the asset market"
        )?;

        let token_amount = get_token_amount(
            spot_position.balance,
            &asset_market,
            &spot_position.balance_type,
        )?;

        // TODO add oracle checks
        let token_price = oracle_map.get_price_data(&asset_market.oracle)?.price;

        (
            token_amount,
            token_price,
            asset_market.decimals,
            asset_market.maintenance_asset_weight,
            calculate_liquidation_multiplier(
                asset_market.liquidation_fee,
                LiquidationMultiplierType::Premium,
            )?,
        )
    };

    let (
        unsettled_pnl,
        quote_price,
        quote_decimals,
        pnl_liability_weight,
        pnl_liquidation_multiplier,
    ) = {
        let user_position = user.get_perp_position(perp_market_index).unwrap();

        let base_asset_amount = user_position.base_asset_amount;

        validate!(
            base_asset_amount == 0,
            ErrorCode::InvalidPerpPositionToLiquidate,
            "Cant have open perp position (base_asset_amount: {})",
            base_asset_amount
        )?;

        validate!(
            user_position.open_orders == 0,
            ErrorCode::InvalidPerpPositionToLiquidate,
            "Cant have open orders on perp position"
        )?;

        let unsettled_pnl = user_position.quote_asset_amount;

        validate!(
            unsettled_pnl < 0,
            ErrorCode::InvalidPerpPositionToLiquidate,
            "Perp position must have negative pnl"
        )?;

        let quote_price = oracle_map.quote_asset_price_data.price;

        let market = perp_market_map.get_ref(&perp_market_index)?;

        (
            unsettled_pnl.unsigned_abs(),
            quote_price,
            6_u8,
            SPOT_WEIGHT_PRECISION,
            calculate_liquidation_multiplier(
                market.liquidation_fee,
                LiquidationMultiplierType::Discount,
            )?,
        )
    };

    let (margin_requirement, total_collateral) = calculate_margin_requirement_and_total_collateral(
        user,
        perp_market_map,
        MarginRequirementType::Maintenance,
        spot_market_map,
        oracle_map,
    )?;

    let margin_requirement_plus_buffer =
        get_margin_requirement_plus_buffer(margin_requirement, liquidation_margin_buffer_ratio)?;

    if !user.being_liquidated && total_collateral >= cast(margin_requirement)? {
        return Err(ErrorCode::SufficientCollateral);
    } else if user.being_liquidated && total_collateral >= cast(margin_requirement_plus_buffer)? {
        user.being_liquidated = false;
        return Ok(());
    }

    let liquidation_id = set_being_liquidated_and_get_liquidation_id(user)?;

    let margin_shortage = cast_to_i128(margin_requirement_plus_buffer)?
        .checked_sub(total_collateral)
        .ok_or_else(math_error!())?
        .unsigned_abs();

    // Determine what amount of borrow to transfer to reduce margin shortage to 0
    let pnl_transfer_to_cover_margin_shortage =
        calculate_liability_transfer_to_cover_margin_shortage(
            margin_shortage,
            asset_weight,
            asset_liquidation_multiplier,
            pnl_liability_weight,
            pnl_liquidation_multiplier,
            quote_decimals,
            quote_price,
        )?;

    // Given the user's deposit amount, how much borrow can be transferred?
    let pnl_transfer_implied_by_asset_amount =
        calculate_liability_transfer_implied_by_asset_amount(
            asset_amount,
            asset_liquidation_multiplier,
            asset_decimals,
            asset_price,
            pnl_liquidation_multiplier,
            quote_decimals,
            quote_price,
        )?;

    let pnl_transfer = liquidator_max_pnl_transfer
        .min(unsettled_pnl)
        .min(pnl_transfer_to_cover_margin_shortage)
        .min(pnl_transfer_implied_by_asset_amount);

    // Given the borrow amount to transfer, determine how much deposit amount to transfer
    let asset_transfer = calculate_asset_transfer_for_liability_transfer(
        asset_amount,
        asset_liquidation_multiplier,
        asset_decimals,
        asset_price,
        pnl_transfer,
        pnl_liquidation_multiplier,
        quote_decimals,
        quote_price,
    )?;

    {
        let mut asset_market = spot_market_map.get_ref_mut(&asset_market_index)?;

        update_spot_balances(
            asset_transfer,
            &SpotBalanceType::Borrow,
            &mut asset_market,
            user.get_spot_position_mut(asset_market_index).unwrap(),
            false,
        )?;

        update_spot_balances(
            asset_transfer,
            &SpotBalanceType::Deposit,
            &mut asset_market,
            liquidator
                .get_spot_position_mut(asset_market_index)
                .unwrap(),
            false,
        )?;
    }

    {
        let mut perp_market = perp_market_map.get_ref_mut(&perp_market_index)?;
        let liquidator_position = liquidator.force_get_perp_position_mut(perp_market_index)?;
        update_quote_asset_amount(
            liquidator_position,
            &mut perp_market,
            -cast_to_i128(pnl_transfer)?,
        )?;

        let user_position = user.get_perp_position_mut(perp_market_index)?;
        update_quote_asset_amount(user_position, &mut perp_market, cast_to_i128(pnl_transfer)?)?;
    }

    if pnl_transfer >= pnl_transfer_to_cover_margin_shortage {
        user.being_liquidated = false;
    } else {
        user.bankrupt = is_user_bankrupt(user);
    }

    let liquidator_meets_initial_margin_requirement =
        meets_initial_margin_requirement(liquidator, perp_market_map, spot_market_map, oracle_map)?;

    validate!(
        liquidator_meets_initial_margin_requirement,
        ErrorCode::InsufficientCollateral,
        "Liquidator doesnt have enough collateral to take over borrow"
    )?;

    let market_oracle_price = {
        let market = perp_market_map.get_ref_mut(&perp_market_index)?;
        oracle_map.get_price_data(&market.amm.oracle)?.price
    };

    emit!(LiquidationRecord {
        ts: now,
        liquidation_id,
        liquidation_type: LiquidationType::LiquidatePerpPnlForDeposit,
        user: *user_key,
        liquidator: *liquidator_key,
        margin_requirement,
        total_collateral,
        bankrupt: user.bankrupt,
        liquidate_perp_pnl_for_deposit: LiquidatePerpPnlForDepositRecord {
            perp_market_index,
            market_oracle_price,
            pnl_transfer,
            asset_market_index,
            asset_price,
            asset_transfer,
        },
        ..LiquidationRecord::default()
    });

    Ok(())
}

pub fn set_being_liquidated_and_get_liquidation_id(user: &mut User) -> ClearingHouseResult<u16> {
    let liquidation_id = if user.being_liquidated {
        user.next_liquidation_id
            .checked_sub(1)
            .ok_or_else(math_error!())?
    } else {
        get_then_update_id!(user, next_liquidation_id)
    };
    user.being_liquidated = true;

    Ok(liquidation_id)
}

pub fn resolve_perp_bankruptcy(
    market_index: u64,
    user: &mut User,
    user_key: &Pubkey,
    liquidator: &mut User,
    liquidator_key: &Pubkey,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    now: i64,
    insurance_fund_vault_balance: u64,
) -> ClearingHouseResult<u64> {
    validate!(
        user.bankrupt,
        ErrorCode::UserNotBankrupt,
        "user not bankrupt",
    )?;

    validate!(
        !liquidator.being_liquidated,
        ErrorCode::UserIsBeingLiquidated,
        "liquidator being liquidated",
    )?;

    validate!(
        !liquidator.bankrupt,
        ErrorCode::UserBankrupt,
        "liquidator bankrupt",
    )?;

    user.get_perp_position(market_index).map_err(|e| {
        msg!(
            "User does not have a position for perp market {}",
            market_index
        );
        e
    })?;

    let loss = user
        .get_perp_position(market_index)
        .unwrap()
        .quote_asset_amount;

    validate!(
        loss < 0,
        ErrorCode::InvalidPerpPositionToLiquidate,
        "user must have negative pnl"
    )?;

    let (margin_requirement, total_collateral) = calculate_margin_requirement_and_total_collateral(
        user,
        perp_market_map,
        MarginRequirementType::Maintenance,
        spot_market_map,
        oracle_map,
    )?;

    // spot market's insurance fund draw attempt here (before social loss)
    // subtract 1 so insurance_fund_vault_balance always stays >= 1

    let if_payment = {
        let mut market = perp_market_map.get_ref_mut(&market_index)?;
        let max_insurance_withdraw = market
            .quote_max_insurance
            .checked_sub(market.quote_settled_insurance)
            .ok_or_else(math_error!())?;

        let _if_payment = loss
            .unsigned_abs()
            .min(cast_to_u128(
                insurance_fund_vault_balance.saturating_sub(1),
            )?)
            .min(max_insurance_withdraw);

        market.quote_settled_insurance = market
            .quote_settled_insurance
            .checked_add(_if_payment)
            .ok_or_else(math_error!())?;
        _if_payment
    };

    let loss_to_socialize = loss
        .checked_add(cast_to_i128(if_payment)?)
        .ok_or_else(math_error!())?;

    let cumulative_funding_rate_delta = calculate_funding_rate_deltas_to_resolve_bankruptcy(
        loss_to_socialize,
        perp_market_map.get_ref(&market_index)?.deref(),
    )?;

    // socialize loss
    if loss_to_socialize < 0 {
        {
            let user = user.get_perp_position_mut(market_index).unwrap();
            user.quote_asset_amount = 0;

            let mut market = perp_market_map.get_ref_mut(&market_index)?;

            market.amm.cumulative_social_loss = market
                .amm
                .cumulative_social_loss
                .checked_add(loss_to_socialize)
                .ok_or_else(math_error!())?;

            market.amm.cumulative_funding_rate_long = market
                .amm
                .cumulative_funding_rate_long
                .checked_add(cumulative_funding_rate_delta)
                .ok_or_else(math_error!())?;

            market.amm.cumulative_funding_rate_short = market
                .amm
                .cumulative_funding_rate_short
                .checked_sub(cumulative_funding_rate_delta)
                .ok_or_else(math_error!())?;
        }
    }

    // exit bankruptcy
    if !is_user_bankrupt(user) {
        user.bankrupt = false;
        user.being_liquidated = false;
    }

    let liquidation_id = user
        .next_liquidation_id
        .checked_sub(1)
        .ok_or_else(math_error!())?;

    emit!(LiquidationRecord {
        ts: now,
        liquidation_id,
        liquidation_type: LiquidationType::PerpBankruptcy,
        user: *user_key,
        liquidator: *liquidator_key,
        margin_requirement,
        total_collateral,
        bankrupt: true,
        perp_bankruptcy: PerpBankruptcyRecord {
            market_index,
            if_payment,
            pnl: loss,
            cumulative_funding_rate_delta,
        },
        ..LiquidationRecord::default()
    });

    cast_to_u64(if_payment)
}

pub fn resolve_borrow_bankruptcy(
    market_index: u64,
    user: &mut User,
    user_key: &Pubkey,
    liquidator: &mut User,
    liquidator_key: &Pubkey,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    now: i64,
    insurance_fund_vault_balance: u64,
) -> ClearingHouseResult<u64> {
    validate!(
        user.bankrupt,
        ErrorCode::UserNotBankrupt,
        "user not bankrupt",
    )?;

    validate!(
        !liquidator.being_liquidated,
        ErrorCode::UserIsBeingLiquidated,
        "liquidator being liquidated",
    )?;

    validate!(
        !liquidator.bankrupt,
        ErrorCode::UserBankrupt,
        "liquidator bankrupt",
    )?;

    // validate user and liquidator have bank balances
    user.get_spot_position(market_index).ok_or_else(|| {
        msg!(
            "User does not have a spot balance for market {}",
            market_index
        );
        ErrorCode::CouldNotFindSpotPosition
    })?;

    let (margin_requirement, total_collateral) = calculate_margin_requirement_and_total_collateral(
        user,
        perp_market_map,
        MarginRequirementType::Maintenance,
        spot_market_map,
        oracle_map,
    )?;

    let borrow_amount = {
        let spot_position = user.get_spot_position(market_index).unwrap();
        validate!(
            spot_position.balance_type == SpotBalanceType::Borrow,
            ErrorCode::UserHasInvalidBorrow
        )?;

        validate!(spot_position.balance > 0, ErrorCode::UserHasInvalidBorrow)?;

        get_token_amount(
            spot_position.balance,
            spot_market_map.get_ref(&market_index)?.deref(),
            &SpotBalanceType::Borrow,
        )?
    };

    // todo: add market's insurance fund draw attempt here (before social loss)
    // subtract 1 so insurance_fund_vault_balance always stays >= 1
    let if_payment = borrow_amount.min(cast_to_u128(
        insurance_fund_vault_balance.saturating_sub(1),
    )?);

    let loss_to_socialize = borrow_amount
        .checked_sub(if_payment)
        .ok_or_else(math_error!())?;

    let cumulative_deposit_interest_delta =
        calculate_cumulative_deposit_interest_delta_to_resolve_bankruptcy(
            loss_to_socialize,
            spot_market_map.get_ref(&market_index)?.deref(),
        )?;

    {
        let mut spot_market = spot_market_map.get_ref_mut(&market_index)?;
        let spot_position = user.get_spot_position_mut(market_index).unwrap();
        update_spot_balances(
            borrow_amount,
            &SpotBalanceType::Deposit,
            &mut spot_market,
            spot_position,
            false,
        )?;

        spot_market.cumulative_deposit_interest = spot_market
            .cumulative_deposit_interest
            .checked_sub(cumulative_deposit_interest_delta)
            .ok_or_else(math_error!())?;
    }

    // exit bankruptcy
    if !is_user_bankrupt(user) {
        user.bankrupt = false;
        user.being_liquidated = false;
    }

    let liquidation_id = user
        .next_liquidation_id
        .checked_sub(1)
        .ok_or_else(math_error!())?;

    emit!(LiquidationRecord {
        ts: now,
        liquidation_id,
        liquidation_type: LiquidationType::BorrowBankruptcy,
        user: *user_key,
        liquidator: *liquidator_key,
        margin_requirement,
        total_collateral,
        bankrupt: true,
        borrow_bankruptcy: BorrowBankruptcyRecord {
            market_index,
            borrow_amount,
            if_payment,
            cumulative_deposit_interest_delta,
        },
        ..LiquidationRecord::default()
    });

    cast_to_u64(if_payment)
}
