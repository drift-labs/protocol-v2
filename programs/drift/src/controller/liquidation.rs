use std::ops::{Deref, DerefMut};

use anchor_lang::prelude::*;
use solana_program::msg;

use crate::controller::funding::settle_funding_payment;
use crate::controller::lp::burn_lp_shares;
use crate::controller::orders;
use crate::controller::position::{
    get_position_index, update_position_and_market, update_quote_asset_amount,
    update_quote_asset_and_break_even_amount, PositionDirection,
};
use crate::controller::repeg::update_amm_and_check_validity;
use crate::controller::spot_balance::{
    update_revenue_pool_balances, update_spot_market_and_check_validity,
};
use crate::controller::spot_position::{
    transfer_spot_position_deposit, update_spot_balances_and_cumulative_deposits,
};
use crate::error::{DriftResult, ErrorCode};
use crate::get_then_update_id;
use crate::math::bankruptcy::is_user_bankrupt;
use crate::math::casting::Cast;
use crate::math::constants::{LIQUIDATION_FEE_PRECISION_U128, SPOT_WEIGHT_PRECISION};
use crate::math::liquidation::{
    calculate_asset_transfer_for_liability_transfer,
    calculate_base_asset_amount_to_cover_margin_shortage,
    calculate_cumulative_deposit_interest_delta_to_resolve_bankruptcy,
    calculate_funding_rate_deltas_to_resolve_bankruptcy,
    calculate_liability_transfer_implied_by_asset_amount,
    calculate_liability_transfer_to_cover_margin_shortage, calculate_liquidation_multiplier,
    LiquidationMultiplierType,
};
use crate::math::margin::{
    calculate_margin_requirement_and_total_collateral, meets_initial_margin_requirement,
    MarginRequirementType,
};
use crate::math::oracle::DriftAction;
use crate::math::orders::{get_position_delta_for_fill, standardize_base_asset_amount};
use crate::math::position::calculate_base_asset_value_with_oracle_price;
use crate::math::safe_math::SafeMath;
use crate::state::events::{
    LiquidateBorrowForPerpPnlRecord, LiquidatePerpPnlForDepositRecord, LiquidatePerpRecord,
    LiquidateSpotRecord, LiquidationRecord, LiquidationType, OrderActionExplanation,
    PerpBankruptcyRecord, SpotBankruptcyRecord,
};
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::MarketStatus;
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_market::SpotBalanceType;
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::state::State;
use crate::state::user::{User, UserStats};
use crate::validate;

#[cfg(test)]
mod tests;

pub fn liquidate_perp(
    market_index: u16,
    liquidator_max_base_asset_amount: u64,
    limit_price: Option<u64>,
    user: &mut User,
    user_key: &Pubkey,
    user_stats: &mut UserStats,
    liquidator: &mut User,
    liquidator_key: &Pubkey,
    liquidator_stats: &mut UserStats,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    slot: u64,
    now: i64,
    state: &State,
) -> DriftResult {
    let liquidation_margin_buffer_ratio = state.liquidation_margin_buffer_ratio;

    validate!(!user.is_bankrupt, ErrorCode::UserBankrupt, "user bankrupt",)?;

    validate!(
        !liquidator.is_bankrupt,
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
        perp_market_map.get_ref_mut(&market_index)?.deref_mut(),
        now,
    )?;

    // Settle user's funding payments so that collateral is up to date
    settle_funding_payment(
        liquidator,
        liquidator_key,
        perp_market_map.get_ref_mut(&market_index)?.deref_mut(),
        now,
    )?;

    let (margin_requirement, total_collateral, margin_requirement_plus_buffer, _) =
        calculate_margin_requirement_and_total_collateral(
            user,
            perp_market_map,
            MarginRequirementType::Maintenance,
            spot_market_map,
            oracle_map,
            Some(liquidation_margin_buffer_ratio as u128),
        )?;

    if !user.is_being_liquidated && total_collateral >= margin_requirement.cast()? {
        return Err(ErrorCode::SufficientCollateral);
    } else if user.is_being_liquidated
        && total_collateral >= margin_requirement_plus_buffer.cast()?
    {
        user.is_being_liquidated = false;
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

    let canceled_order_ids = orders::cancel_orders(
        user,
        user_key,
        Some(liquidator_key),
        perp_market_map,
        spot_market_map,
        oracle_map,
        now,
        slot,
        OrderActionExplanation::CanceledForLiquidation,
        None,
        None,
        None,
    )?;

    let mut market = perp_market_map.get_ref_mut(&market_index)?;
    let oracle_price_data = oracle_map.get_price_data(&market.amm.oracle)?;

    update_amm_and_check_validity(
        &mut market,
        oracle_price_data,
        state,
        now,
        slot,
        Some(DriftAction::Liquidate),
    )?;

    let oracle_price = if market.status == MarketStatus::Settlement {
        market.expiry_price
    } else {
        oracle_price_data.price
    };

    drop(market);

    // burning lp shares = removing open bids/asks
    let lp_shares = user.perp_positions[position_index].lp_shares;
    if lp_shares > 0 {
        burn_lp_shares(
            &mut user.perp_positions[position_index],
            perp_market_map.get_ref_mut(&market_index)?.deref_mut(),
            lp_shares,
            oracle_price,
        )?;
    }

    // check if user exited liquidation territory
    let (intermediate_total_collateral, intermediate_margin_requirement_with_buffer) =
        if !canceled_order_ids.is_empty() || lp_shares > 0 {
            let (_, intermediate_total_collateral, intermediate_margin_requirement_plus_buffer, _) =
                calculate_margin_requirement_and_total_collateral(
                    user,
                    perp_market_map,
                    MarginRequirementType::Maintenance,
                    spot_market_map,
                    oracle_map,
                    Some(liquidation_margin_buffer_ratio as u128),
                )?;

            if intermediate_total_collateral
                >= intermediate_margin_requirement_plus_buffer.cast()?
            {
                emit!(LiquidationRecord {
                    ts: now,
                    liquidation_id,
                    liquidation_type: LiquidationType::LiquidatePerp,
                    user: *user_key,
                    liquidator: *liquidator_key,
                    margin_requirement,
                    total_collateral,
                    bankrupt: user.is_bankrupt,
                    canceled_order_ids,
                    liquidate_perp: LiquidatePerpRecord {
                        market_index,
                        oracle_price,
                        lp_shares,
                        ..LiquidatePerpRecord::default()
                    },
                    ..LiquidationRecord::default()
                });

                user.is_being_liquidated = false;
                return Ok(());
            }

            (
                intermediate_total_collateral,
                intermediate_margin_requirement_plus_buffer,
            )
        } else {
            (total_collateral, margin_requirement_plus_buffer)
        };

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

    let worst_case_base_asset_amount =
        user.perp_positions[position_index].worst_case_base_asset_amount()?;

    let margin_ratio = perp_market_map.get_ref(&market_index)?.get_margin_ratio(
        worst_case_base_asset_amount.unsigned_abs(),
        MarginRequirementType::Maintenance,
    )?;

    let margin_ratio_with_buffer = margin_ratio.safe_add(liquidation_margin_buffer_ratio)?;

    let margin_shortage = intermediate_margin_requirement_with_buffer
        .cast::<i128>()?
        .safe_sub(intermediate_total_collateral)?
        .unsigned_abs();

    let market = perp_market_map.get_ref(&market_index)?;
    let liquidation_fee = market.liquidator_fee;
    let if_liquidation_fee = market.if_liquidation_fee;
    let base_asset_amount_to_cover_margin_shortage = standardize_base_asset_amount(
        calculate_base_asset_amount_to_cover_margin_shortage(
            margin_shortage,
            margin_ratio_with_buffer,
            liquidation_fee,
            if_liquidation_fee,
            oracle_price,
        )?,
        market.amm.order_step_size,
    )?;
    drop(market);

    let base_asset_amount = user_base_asset_amount
        .min(liquidator_max_base_asset_amount)
        .min(base_asset_amount_to_cover_margin_shortage);
    let base_asset_amount = standardize_base_asset_amount(
        base_asset_amount,
        perp_market_map.get_ref(&market_index)?.amm.order_step_size,
    )?;

    let liquidation_multiplier = calculate_liquidation_multiplier(
        liquidation_fee,
        if user.perp_positions[position_index].base_asset_amount > 0 {
            LiquidationMultiplierType::Discount // Sell at discount if user is long
        } else {
            LiquidationMultiplierType::Premium // premium if user is short
        },
    )?;

    // Make sure liquidator enters at better than limit price
    if let Some(limit_price) = limit_price {
        let liquidation_price = oracle_price
            .cast::<u128>()?
            .safe_mul(liquidation_multiplier.cast()?)?
            .safe_div(LIQUIDATION_FEE_PRECISION_U128)?
            .cast::<u64>()?;

        match user.perp_positions[position_index].get_direction() {
            PositionDirection::Long => validate!(
                liquidation_price <= limit_price.cast()?,
                ErrorCode::LiquidationDoesntSatisfyLimitPrice,
                "limit price ({}) > liquidation price ({})",
                limit_price,
                liquidation_price
            )?,
            PositionDirection::Short => validate!(
                liquidation_price >= limit_price.cast()?,
                ErrorCode::LiquidationDoesntSatisfyLimitPrice,
                "limit price ({}) < liquidation price ({})",
                limit_price,
                liquidation_price
            )?,
        }
    }

    let base_asset_value =
        calculate_base_asset_value_with_oracle_price(base_asset_amount.cast()?, oracle_price)?;
    let quote_asset_amount = base_asset_value
        .safe_mul(liquidation_multiplier.cast()?)?
        .safe_div(LIQUIDATION_FEE_PRECISION_U128)?
        .cast::<u64>()?;

    let if_fee = -base_asset_value
        .safe_mul(if_liquidation_fee.cast()?)?
        .safe_div(LIQUIDATION_FEE_PRECISION_U128)?
        .cast::<i64>()?;

    user_stats.update_taker_volume_30d(quote_asset_amount, now)?;
    liquidator_stats.update_maker_volume_30d(quote_asset_amount, now)?;

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

    {
        let mut market = perp_market_map.get_ref_mut(&market_index)?;

        let user_position = user.get_perp_position_mut(market_index).unwrap();
        update_position_and_market(user_position, &mut market, &user_position_delta)?;
        update_quote_asset_and_break_even_amount(user_position, &mut market, if_fee)?;

        let liquidator_position = liquidator
            .force_get_perp_position_mut(market_index)
            .unwrap();
        update_position_and_market(liquidator_position, &mut market, &liquidator_position_delta)?;

        market.amm.total_liquidation_fee = market
            .amm
            .total_liquidation_fee
            .safe_add(if_fee.unsigned_abs().cast()?)?;
    };

    if base_asset_amount >= base_asset_amount_to_cover_margin_shortage {
        user.is_being_liquidated = false;
    } else {
        user.is_bankrupt = is_user_bankrupt(user);
    }

    let liquidator_meets_initial_margin_requirement =
        meets_initial_margin_requirement(liquidator, perp_market_map, spot_market_map, oracle_map)?;

    validate!(
        liquidator_meets_initial_margin_requirement,
        ErrorCode::InsufficientCollateral,
        "Liquidator doesnt have enough collateral to take over perp position"
    )?;

    // Increment ids so users can make order records off chain
    let user_order_id = get_then_update_id!(user, next_order_id);
    let liquidator_order_id = get_then_update_id!(liquidator, next_order_id);
    let fill_record_id = {
        let mut market = perp_market_map.get_ref_mut(&market_index)?;
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
        bankrupt: user.is_bankrupt,
        canceled_order_ids,
        liquidate_perp: LiquidatePerpRecord {
            market_index,
            oracle_price,
            base_asset_amount: user_position_delta.base_asset_amount,
            quote_asset_amount: user_position_delta.quote_asset_amount,
            lp_shares,
            user_order_id,
            liquidator_order_id,
            fill_record_id,
            if_fee: if_fee.abs().cast()?,
        },
        ..LiquidationRecord::default()
    });

    Ok(())
}

pub fn liquidate_spot(
    asset_market_index: u16,
    liability_market_index: u16,
    liquidator_max_liability_transfer: u128,
    user: &mut User,
    user_key: &Pubkey,
    liquidator: &mut User,
    liquidator_key: &Pubkey,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    now: i64,
    slot: u64,
    liquidation_margin_buffer_ratio: u32,
) -> DriftResult {
    validate!(!user.is_bankrupt, ErrorCode::UserBankrupt, "user bankrupt",)?;

    validate!(
        !liquidator.is_bankrupt,
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
        let (asset_price_data, validity_guard_rails) =
            oracle_map.get_price_data_and_guard_rails(&asset_market.oracle)?;

        update_spot_market_and_check_validity(
            &mut asset_market,
            asset_price_data,
            validity_guard_rails,
            now,
            Some(DriftAction::Liquidate),
        )?;

        let spot_deposit_position = user.get_spot_position(asset_market_index).unwrap();

        validate!(
            spot_deposit_position.balance_type == SpotBalanceType::Deposit,
            ErrorCode::WrongSpotBalanceType,
            "User did not have a deposit for the asset market index"
        )?;

        let token_amount = spot_deposit_position.get_token_amount(&asset_market)?;

        let asset_price = asset_price_data.price;
        (
            token_amount,
            asset_price,
            asset_market.decimals,
            asset_market.maintenance_asset_weight,
            calculate_liquidation_multiplier(
                asset_market.liquidator_fee,
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
        liquidation_if_fee,
    ) = {
        let mut liability_market = spot_market_map.get_ref_mut(&liability_market_index)?;
        let (liability_price_data, validity_guard_rails) =
            oracle_map.get_price_data_and_guard_rails(&liability_market.oracle)?;

        update_spot_market_and_check_validity(
            &mut liability_market,
            liability_price_data,
            validity_guard_rails,
            now,
            Some(DriftAction::Liquidate),
        )?;

        let spot_position = user.get_spot_position(liability_market_index).unwrap();

        validate!(
            spot_position.balance_type == SpotBalanceType::Borrow,
            ErrorCode::WrongSpotBalanceType,
            "User did not have a borrow for the liability market index"
        )?;

        let token_amount = spot_position.get_token_amount(&liability_market)?;

        let liability_price = liability_price_data.price;

        (
            token_amount,
            liability_price,
            liability_market.decimals,
            liability_market.maintenance_liability_weight,
            calculate_liquidation_multiplier(
                liability_market.liquidator_fee,
                LiquidationMultiplierType::Discount,
            )?,
            liability_market.if_liquidation_fee,
        )
    };

    let (margin_requirement, total_collateral, margin_requirement_plus_buffer, _) =
        calculate_margin_requirement_and_total_collateral(
            user,
            perp_market_map,
            MarginRequirementType::Maintenance,
            spot_market_map,
            oracle_map,
            Some(liquidation_margin_buffer_ratio as u128),
        )?;

    if !user.is_being_liquidated && total_collateral >= margin_requirement.cast()? {
        return Err(ErrorCode::SufficientCollateral);
    } else if user.is_being_liquidated
        && total_collateral >= margin_requirement_plus_buffer.cast()?
    {
        user.is_being_liquidated = false;
        return Ok(());
    }

    let liquidation_id = set_being_liquidated_and_get_liquidation_id(user)?;

    let canceled_order_ids = orders::cancel_orders(
        user,
        user_key,
        Some(liquidator_key),
        perp_market_map,
        spot_market_map,
        oracle_map,
        now,
        slot,
        OrderActionExplanation::CanceledForLiquidation,
        None,
        None,
        None,
    )?;

    // check if user exited liquidation territory
    let (intermediate_total_collateral, intermediate_margin_requirement_with_buffer) =
        if !canceled_order_ids.is_empty() {
            let (_, intermediate_total_collateral, intermediate_margin_requirement_plus_buffer, _) =
                calculate_margin_requirement_and_total_collateral(
                    user,
                    perp_market_map,
                    MarginRequirementType::Maintenance,
                    spot_market_map,
                    oracle_map,
                    Some(liquidation_margin_buffer_ratio as u128),
                )?;

            if intermediate_total_collateral
                >= intermediate_margin_requirement_plus_buffer.cast()?
            {
                emit!(LiquidationRecord {
                    ts: now,
                    liquidation_id,
                    liquidation_type: LiquidationType::LiquidateSpot,
                    user: *user_key,
                    liquidator: *liquidator_key,
                    margin_requirement,
                    total_collateral,
                    bankrupt: user.is_bankrupt,
                    canceled_order_ids,
                    liquidate_spot: LiquidateSpotRecord {
                        asset_market_index,
                        asset_price,
                        asset_transfer: 0,
                        liability_market_index,
                        liability_price,
                        liability_transfer: 0,
                        if_fee: 0,
                    },
                    ..LiquidationRecord::default()
                });

                user.is_being_liquidated = false;
                return Ok(());
            }

            (
                intermediate_total_collateral,
                intermediate_margin_requirement_plus_buffer,
            )
        } else {
            (total_collateral, margin_requirement_plus_buffer)
        };

    let margin_shortage = intermediate_margin_requirement_with_buffer
        .cast::<i128>()?
        .safe_sub(intermediate_total_collateral)?
        .unsigned_abs();

    let liability_weight_with_buffer =
        liability_weight.safe_add(liquidation_margin_buffer_ratio)?;

    // Determine what amount of borrow to transfer to reduce margin shortage to 0
    let liability_transfer_to_cover_margin_shortage =
        calculate_liability_transfer_to_cover_margin_shortage(
            margin_shortage,
            asset_weight,
            asset_liquidation_multiplier,
            liability_weight_with_buffer,
            liability_liquidation_multiplier,
            liability_decimals,
            liability_price,
            liquidation_if_fee,
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

    let if_fee = liability_transfer
        .safe_mul(liquidation_if_fee.cast()?)?
        .safe_div(LIQUIDATION_FEE_PRECISION_U128)?;
    {
        let mut liability_market = spot_market_map.get_ref_mut(&liability_market_index)?;

        update_spot_balances_and_cumulative_deposits(
            liability_transfer.safe_sub(if_fee)?,
            &SpotBalanceType::Deposit,
            &mut liability_market,
            user.get_spot_position_mut(liability_market_index).unwrap(),
            false,
            None,
        )?;

        update_revenue_pool_balances(if_fee, &SpotBalanceType::Deposit, &mut liability_market)?;

        update_spot_balances_and_cumulative_deposits(
            liability_transfer,
            &SpotBalanceType::Borrow,
            &mut liability_market,
            liquidator
                .get_spot_position_mut(liability_market_index)
                .unwrap(),
            false,
            None,
        )?;
    }

    {
        let mut asset_market = spot_market_map.get_ref_mut(&asset_market_index)?;
        transfer_spot_position_deposit(
            asset_transfer.cast::<i128>()?,
            &mut asset_market,
            user.get_spot_position_mut(asset_market_index).unwrap(),
            liquidator
                .get_spot_position_mut(asset_market_index)
                .unwrap(),
        )?;
    }

    if liability_transfer >= liability_transfer_to_cover_margin_shortage {
        user.is_being_liquidated = false;
    } else {
        user.is_bankrupt = is_user_bankrupt(user);
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
        liquidation_type: LiquidationType::LiquidateSpot,
        user: *user_key,
        liquidator: *liquidator_key,
        margin_requirement,
        total_collateral,
        bankrupt: user.is_bankrupt,
        liquidate_spot: LiquidateSpotRecord {
            asset_market_index,
            asset_price,
            asset_transfer,
            liability_market_index,
            liability_price,
            liability_transfer,
            if_fee: if_fee.cast()?,
        },
        ..LiquidationRecord::default()
    });

    Ok(())
}

pub fn liquidate_borrow_for_perp_pnl(
    perp_market_index: u16,
    liability_market_index: u16,
    liquidator_max_liability_transfer: u128,
    user: &mut User,
    user_key: &Pubkey,
    liquidator: &mut User,
    liquidator_key: &Pubkey,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    now: i64,
    slot: u64,
    liquidation_margin_buffer_ratio: u32,
) -> DriftResult {
    // liquidator takes over a user borrow in exchange for that user's positive perpetual pnl
    // can only be done once a user's perpetual position size is 0
    // blocks borrows where oracle is deemed invalid

    validate!(!user.is_bankrupt, ErrorCode::UserBankrupt, "user bankrupt",)?;

    validate!(
        !liquidator.is_bankrupt,
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

        let pnl = user_position.quote_asset_amount.cast::<i128>()?;

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
            6_u32,
            pnl_asset_weight,
            calculate_liquidation_multiplier(
                market.liquidator_fee,
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
        let (liability_price_data, validity_guard_rails) =
            oracle_map.get_price_data_and_guard_rails(&liability_market.oracle)?;

        update_spot_market_and_check_validity(
            &mut liability_market,
            liability_price_data,
            validity_guard_rails,
            now,
            Some(DriftAction::Liquidate),
        )?;

        let spot_position = user.get_spot_position(liability_market_index).unwrap();

        validate!(
            spot_position.balance_type == SpotBalanceType::Borrow,
            ErrorCode::WrongSpotBalanceType,
            "User did not have a borrow for the borrow market index"
        )?;

        let token_amount = spot_position.get_token_amount(&liability_market)?;

        (
            token_amount,
            liability_price_data.price,
            liability_market.decimals,
            liability_market.maintenance_liability_weight,
            calculate_liquidation_multiplier(
                liability_market.liquidator_fee,
                LiquidationMultiplierType::Discount,
            )?,
        )
    };

    let (margin_requirement, total_collateral, margin_requirement_plus_buffer, _) =
        calculate_margin_requirement_and_total_collateral(
            user,
            perp_market_map,
            MarginRequirementType::Maintenance,
            spot_market_map,
            oracle_map,
            Some(liquidation_margin_buffer_ratio as u128),
        )?;

    if !user.is_being_liquidated && total_collateral >= margin_requirement.cast()? {
        return Err(ErrorCode::SufficientCollateral);
    } else if user.is_being_liquidated
        && total_collateral >= margin_requirement_plus_buffer.cast()?
    {
        user.is_being_liquidated = false;
        return Ok(());
    }

    let liquidation_id = set_being_liquidated_and_get_liquidation_id(user)?;

    let canceled_order_ids = orders::cancel_orders(
        user,
        user_key,
        Some(liquidator_key),
        perp_market_map,
        spot_market_map,
        oracle_map,
        now,
        slot,
        OrderActionExplanation::CanceledForLiquidation,
        None,
        None,
        None,
    )?;

    // check if user exited liquidation territory
    let (intermediate_total_collateral, intermediate_margin_requirement_with_buffer) =
        if !canceled_order_ids.is_empty() {
            let (_, intermediate_total_collateral, intermediate_margin_requirement_plus_buffer, _) =
                calculate_margin_requirement_and_total_collateral(
                    user,
                    perp_market_map,
                    MarginRequirementType::Maintenance,
                    spot_market_map,
                    oracle_map,
                    Some(liquidation_margin_buffer_ratio as u128),
                )?;

            if intermediate_total_collateral
                >= intermediate_margin_requirement_plus_buffer.cast()?
            {
                let market = perp_market_map.get_ref(&perp_market_index)?;
                let market_oracle_price = oracle_map.get_price_data(&market.amm.oracle)?.price;

                emit!(LiquidationRecord {
                    ts: now,
                    liquidation_id,
                    liquidation_type: LiquidationType::LiquidateBorrowForPerpPnl,
                    user: *user_key,
                    liquidator: *liquidator_key,
                    margin_requirement,
                    total_collateral,
                    bankrupt: user.is_bankrupt,
                    canceled_order_ids,
                    liquidate_borrow_for_perp_pnl: LiquidateBorrowForPerpPnlRecord {
                        perp_market_index,
                        market_oracle_price,
                        pnl_transfer: 0,
                        liability_market_index,
                        liability_price,
                        liability_transfer: 0,
                    },
                    ..LiquidationRecord::default()
                });

                user.is_being_liquidated = false;
                return Ok(());
            }

            (
                intermediate_total_collateral,
                intermediate_margin_requirement_plus_buffer,
            )
        } else {
            (total_collateral, margin_requirement_plus_buffer)
        };

    let margin_shortage = intermediate_margin_requirement_with_buffer
        .cast::<i128>()?
        .safe_sub(intermediate_total_collateral)?
        .unsigned_abs();

    let liability_weight_with_buffer =
        liability_weight.safe_add(liquidation_margin_buffer_ratio)?;

    // Determine what amount of borrow to transfer to reduce margin shortage to 0
    let liability_transfer_to_cover_margin_shortage =
        calculate_liability_transfer_to_cover_margin_shortage(
            margin_shortage,
            pnl_asset_weight,
            pnl_liquidation_multiplier,
            liability_weight_with_buffer,
            liability_liquidation_multiplier,
            liability_decimals,
            liability_price,
            0,
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
        transfer_spot_position_deposit(
            -liability_transfer.cast::<i128>()?,
            &mut liability_market,
            user.get_spot_position_mut(liability_market_index).unwrap(),
            liquidator
                .get_spot_position_mut(liability_market_index)
                .unwrap(),
        )?;
    }

    {
        let mut market = perp_market_map.get_ref_mut(&perp_market_index)?;
        let liquidator_position = liquidator.force_get_perp_position_mut(perp_market_index)?;
        update_quote_asset_amount(liquidator_position, &mut market, pnl_transfer.cast()?)?;

        let user_position = user.get_perp_position_mut(perp_market_index)?;
        update_quote_asset_amount(user_position, &mut market, -pnl_transfer.cast()?)?;
    }

    if liability_transfer >= liability_transfer_to_cover_margin_shortage {
        user.is_being_liquidated = false;
    } else {
        user.is_bankrupt = is_user_bankrupt(user);
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
        bankrupt: user.is_bankrupt,
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
    perp_market_index: u16,
    asset_market_index: u16,
    liquidator_max_pnl_transfer: u128,
    user: &mut User,
    user_key: &Pubkey,
    liquidator: &mut User,
    liquidator_key: &Pubkey,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    now: i64,
    slot: u64,
    liquidation_margin_buffer_ratio: u32,
) -> DriftResult {
    // liquidator takes over remaining negative perpetual pnl in exchange for a user deposit
    // can only be done once the perpetual position's size is 0
    // blocked when the user deposit oracle is deemed invalid

    validate!(!user.is_bankrupt, ErrorCode::UserBankrupt, "user bankrupt",)?;

    validate!(
        !liquidator.is_bankrupt,
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
        let (asset_price_data, validity_guard_rails) =
            oracle_map.get_price_data_and_guard_rails(&asset_market.oracle)?;

        update_spot_market_and_check_validity(
            &mut asset_market,
            asset_price_data,
            validity_guard_rails,
            now,
            Some(DriftAction::Liquidate),
        )?;

        let token_price = asset_price_data.price;
        let spot_position = user.get_spot_position(asset_market_index).unwrap();

        validate!(
            spot_position.balance_type == SpotBalanceType::Deposit,
            ErrorCode::WrongSpotBalanceType,
            "User did not have a deposit for the asset market"
        )?;

        let token_amount = spot_position.get_token_amount(&asset_market)?;

        (
            token_amount,
            token_price,
            asset_market.decimals,
            asset_market.maintenance_asset_weight,
            calculate_liquidation_multiplier(
                asset_market.liquidator_fee,
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

        let unsettled_pnl = user_position.quote_asset_amount.cast::<i128>()?;

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
            6_u32,
            SPOT_WEIGHT_PRECISION,
            calculate_liquidation_multiplier(
                market.liquidator_fee,
                LiquidationMultiplierType::Discount,
            )?,
        )
    };

    let (margin_requirement, total_collateral, margin_requirement_plus_buffer, _) =
        calculate_margin_requirement_and_total_collateral(
            user,
            perp_market_map,
            MarginRequirementType::Maintenance,
            spot_market_map,
            oracle_map,
            Some(liquidation_margin_buffer_ratio as u128),
        )?;

    if !user.is_being_liquidated && total_collateral >= margin_requirement.cast()? {
        return Err(ErrorCode::SufficientCollateral);
    } else if user.is_being_liquidated
        && total_collateral >= margin_requirement_plus_buffer.cast()?
    {
        user.is_being_liquidated = false;
        return Ok(());
    }

    let liquidation_id = set_being_liquidated_and_get_liquidation_id(user)?;

    let canceled_order_ids = orders::cancel_orders(
        user,
        user_key,
        Some(liquidator_key),
        perp_market_map,
        spot_market_map,
        oracle_map,
        now,
        slot,
        OrderActionExplanation::CanceledForLiquidation,
        None,
        None,
        None,
    )?;

    // check if user exited liquidation territory
    let (intermediate_total_collateral, intermediate_margin_requirement_with_buffer) =
        if !canceled_order_ids.is_empty() {
            let (_, intermediate_total_collateral, intermediate_margin_requirement_plus_buffer, _) =
                calculate_margin_requirement_and_total_collateral(
                    user,
                    perp_market_map,
                    MarginRequirementType::Maintenance,
                    spot_market_map,
                    oracle_map,
                    Some(liquidation_margin_buffer_ratio as u128),
                )?;

            if intermediate_total_collateral
                >= intermediate_margin_requirement_plus_buffer.cast()?
            {
                let market = perp_market_map.get_ref(&perp_market_index)?;
                let market_oracle_price = oracle_map.get_price_data(&market.amm.oracle)?.price;

                emit!(LiquidationRecord {
                    ts: now,
                    liquidation_id,
                    liquidation_type: LiquidationType::LiquidatePerpPnlForDeposit,
                    user: *user_key,
                    liquidator: *liquidator_key,
                    margin_requirement,
                    total_collateral,
                    bankrupt: user.is_bankrupt,
                    canceled_order_ids,
                    liquidate_perp_pnl_for_deposit: LiquidatePerpPnlForDepositRecord {
                        perp_market_index,
                        market_oracle_price,
                        pnl_transfer: 0,
                        asset_market_index,
                        asset_price,
                        asset_transfer: 0,
                    },
                    ..LiquidationRecord::default()
                });

                user.is_being_liquidated = false;
                return Ok(());
            }

            (
                intermediate_total_collateral,
                intermediate_margin_requirement_plus_buffer,
            )
        } else {
            (total_collateral, margin_requirement_plus_buffer)
        };

    let margin_shortage = intermediate_margin_requirement_with_buffer
        .cast::<i128>()?
        .safe_sub(intermediate_total_collateral)?
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
            0, // no if fee
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

        update_spot_balances_and_cumulative_deposits(
            asset_transfer,
            &SpotBalanceType::Borrow,
            &mut asset_market,
            user.get_spot_position_mut(asset_market_index).unwrap(),
            false,
            None,
        )?;

        update_spot_balances_and_cumulative_deposits(
            asset_transfer,
            &SpotBalanceType::Deposit,
            &mut asset_market,
            liquidator
                .get_spot_position_mut(asset_market_index)
                .unwrap(),
            false,
            None,
        )?;
    }

    {
        let mut perp_market = perp_market_map.get_ref_mut(&perp_market_index)?;
        let liquidator_position = liquidator.force_get_perp_position_mut(perp_market_index)?;
        update_quote_asset_amount(liquidator_position, &mut perp_market, -pnl_transfer.cast()?)?;

        let user_position = user.get_perp_position_mut(perp_market_index)?;
        update_quote_asset_amount(user_position, &mut perp_market, pnl_transfer.cast()?)?;
    }

    if pnl_transfer >= pnl_transfer_to_cover_margin_shortage {
        user.is_being_liquidated = false;
    } else {
        user.is_bankrupt = is_user_bankrupt(user);
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
        bankrupt: user.is_bankrupt,
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

pub fn set_being_liquidated_and_get_liquidation_id(user: &mut User) -> DriftResult<u16> {
    let liquidation_id = if user.is_being_liquidated {
        user.next_liquidation_id.safe_sub(1)?
    } else {
        get_then_update_id!(user, next_liquidation_id)
    };
    user.is_being_liquidated = true;

    Ok(liquidation_id)
}

pub fn resolve_perp_bankruptcy(
    market_index: u16,
    user: &mut User,
    user_key: &Pubkey,
    liquidator: &mut User,
    liquidator_key: &Pubkey,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    now: i64,
    insurance_fund_vault_balance: u64,
) -> DriftResult<u64> {
    validate!(
        user.is_bankrupt,
        ErrorCode::UserNotBankrupt,
        "user not bankrupt",
    )?;

    validate!(
        !liquidator.is_being_liquidated,
        ErrorCode::UserIsBeingLiquidated,
        "liquidator being liquidated",
    )?;

    validate!(
        !liquidator.is_bankrupt,
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
        .quote_asset_amount
        .cast::<i128>()?;

    validate!(
        loss < 0,
        ErrorCode::InvalidPerpPositionToLiquidate,
        "user must have negative pnl"
    )?;

    let (margin_requirement, total_collateral, _, _) =
        calculate_margin_requirement_and_total_collateral(
            user,
            perp_market_map,
            MarginRequirementType::Maintenance,
            spot_market_map,
            oracle_map,
            None,
        )?;

    // spot market's insurance fund draw attempt here (before social loss)
    // subtract 1 from available insurance_fund_vault_balance so deposits in insurance vault always remains >= 1

    let if_payment = {
        let mut market = perp_market_map.get_ref_mut(&market_index)?;
        let max_insurance_withdraw = market
            .insurance_claim
            .quote_max_insurance
            .safe_sub(market.insurance_claim.quote_settled_insurance)?
            .cast::<u128>()?;

        let if_payment = loss
            .unsigned_abs()
            .min(insurance_fund_vault_balance.saturating_sub(1).cast()?)
            .min(max_insurance_withdraw);

        market.insurance_claim.quote_settled_insurance = market
            .insurance_claim
            .quote_settled_insurance
            .safe_add(if_payment.cast()?)?;

        if_payment
    };

    let loss_to_socialize = loss.safe_add(if_payment.cast::<i128>()?)?;

    let cumulative_funding_rate_delta = calculate_funding_rate_deltas_to_resolve_bankruptcy(
        loss_to_socialize,
        perp_market_map.get_ref(&market_index)?.deref(),
    )?;

    // socialize loss
    if loss_to_socialize < 0 {
        let mut market = perp_market_map.get_ref_mut(&market_index)?;

        market.amm.cumulative_social_loss = market
            .amm
            .cumulative_social_loss
            .safe_add(loss_to_socialize)?;

        market.amm.cumulative_funding_rate_long = market
            .amm
            .cumulative_funding_rate_long
            .safe_add(cumulative_funding_rate_delta)?;

        market.amm.cumulative_funding_rate_short = market
            .amm
            .cumulative_funding_rate_short
            .safe_sub(cumulative_funding_rate_delta)?;
    }

    // clear bad debt
    {
        let mut market = perp_market_map.get_ref_mut(&market_index)?;
        let perp_position = user.get_perp_position_mut(market_index).unwrap();
        update_quote_asset_amount(
            perp_position,
            &mut market,
            -perp_position.quote_asset_amount,
        )?;
    }

    // exit bankruptcy
    if !is_user_bankrupt(user) {
        user.is_bankrupt = false;
        user.is_being_liquidated = false;
    }

    let liquidation_id = user.next_liquidation_id.safe_sub(1)?;

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
            clawback_user: None,
            clawback_user_payment: None,
            cumulative_funding_rate_delta,
        },
        ..LiquidationRecord::default()
    });

    if_payment.cast()
}

pub fn resolve_spot_bankruptcy(
    market_index: u16,
    user: &mut User,
    user_key: &Pubkey,
    liquidator: &mut User,
    liquidator_key: &Pubkey,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    now: i64,
    insurance_fund_vault_balance: u64,
) -> DriftResult<u64> {
    validate!(
        user.is_bankrupt,
        ErrorCode::UserNotBankrupt,
        "user not bankrupt",
    )?;

    validate!(
        !liquidator.is_being_liquidated,
        ErrorCode::UserIsBeingLiquidated,
        "liquidator being liquidated",
    )?;

    validate!(
        !liquidator.is_bankrupt,
        ErrorCode::UserBankrupt,
        "liquidator bankrupt",
    )?;

    // validate user and liquidator have spot position balances
    user.get_spot_position(market_index).ok_or_else(|| {
        msg!(
            "User does not have a spot balance for market {}",
            market_index
        );
        ErrorCode::CouldNotFindSpotPosition
    })?;

    let (margin_requirement, total_collateral, _, _) =
        calculate_margin_requirement_and_total_collateral(
            user,
            perp_market_map,
            MarginRequirementType::Maintenance,
            spot_market_map,
            oracle_map,
            None,
        )?;

    let borrow_amount = {
        let spot_position = user.get_spot_position(market_index).unwrap();
        validate!(
            spot_position.balance_type == SpotBalanceType::Borrow,
            ErrorCode::UserHasInvalidBorrow
        )?;

        validate!(
            spot_position.scaled_balance > 0,
            ErrorCode::UserHasInvalidBorrow
        )?;

        spot_position.get_token_amount(spot_market_map.get_ref(&market_index)?.deref())?
    };

    // todo: add market's insurance fund draw attempt here (before social loss)
    // subtract 1 so insurance_fund_vault_balance always stays >= 1
    let if_payment = borrow_amount.min(insurance_fund_vault_balance.saturating_sub(1).cast()?);

    let loss_to_socialize = borrow_amount.safe_sub(if_payment)?;

    let cumulative_deposit_interest_delta =
        calculate_cumulative_deposit_interest_delta_to_resolve_bankruptcy(
            loss_to_socialize,
            spot_market_map.get_ref(&market_index)?.deref(),
        )?;

    {
        let mut spot_market = spot_market_map.get_ref_mut(&market_index)?;
        let spot_position = user.get_spot_position_mut(market_index).unwrap();
        update_spot_balances_and_cumulative_deposits(
            borrow_amount,
            &SpotBalanceType::Deposit,
            &mut spot_market,
            spot_position,
            false,
            None,
        )?;

        spot_market.cumulative_deposit_interest = spot_market
            .cumulative_deposit_interest
            .safe_sub(cumulative_deposit_interest_delta)?;
    }

    // exit bankruptcy
    if !is_user_bankrupt(user) {
        user.is_bankrupt = false;
        user.is_being_liquidated = false;
    }

    let liquidation_id = user.next_liquidation_id.safe_sub(1)?;

    emit!(LiquidationRecord {
        ts: now,
        liquidation_id,
        liquidation_type: LiquidationType::SpotBankruptcy,
        user: *user_key,
        liquidator: *liquidator_key,
        margin_requirement,
        total_collateral,
        bankrupt: true,
        spot_bankruptcy: SpotBankruptcyRecord {
            market_index,
            borrow_amount,
            if_payment,
            cumulative_deposit_interest_delta,
        },
        ..LiquidationRecord::default()
    });

    if_payment.cast()
}
