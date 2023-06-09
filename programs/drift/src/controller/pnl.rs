use crate::controller::amm::{update_pnl_pool_and_user_balance, update_pool_balances};
use crate::controller::funding::settle_funding_payment;
use crate::controller::orders::{cancel_orders, validate_market_within_price_band};
use crate::controller::position::{
    get_position_index, update_position_and_market, update_quote_asset_amount,
    update_quote_asset_and_break_even_amount, update_settled_pnl, PositionDelta,
};
use crate::controller::spot_balance::{
    update_spot_balances, update_spot_market_cumulative_interest,
};
use crate::error::{DriftResult, ErrorCode};
use crate::math::amm::calculate_net_user_pnl;

use crate::math::casting::Cast;
use crate::math::margin::{
    calculate_user_safest_position_tiers, meets_maintenance_margin_requirement,
};
use crate::math::position::calculate_base_asset_value_with_expiry_price;
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_amount;

use crate::state::events::{OrderActionExplanation, SettlePnlExplanation, SettlePnlRecord};
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::MarketStatus;
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_market::{SpotBalance, SpotBalanceType};
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::state::State;
use crate::state::user::{MarketType, User};
use crate::validate;
use anchor_lang::prelude::Pubkey;
use anchor_lang::prelude::*;
use solana_program::msg;
use std::ops::DerefMut;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod delisting;

pub fn settle_pnl(
    market_index: u16,
    user: &mut User,
    authority: &Pubkey,
    user_key: &Pubkey,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    now: i64,
    state: &State,
) -> DriftResult {
    validate!(!user.is_bankrupt(), ErrorCode::UserBankrupt)?;

    {
        let spot_market = &mut spot_market_map.get_quote_spot_market_mut()?;
        update_spot_market_cumulative_interest(spot_market, None, now)?;
    }

    let mut market = perp_market_map.get_ref_mut(&market_index)?;
    let contract_tier = market.contract_tier;
    let oracle_price = oracle_map.get_price_data(&market.amm.oracle)?.price;

    validate_market_within_price_band(&market, state, true, None, Some(oracle_price.cast()?))?;

    crate::controller::lp::settle_funding_payment_then_lp(user, user_key, &mut market, now)?;

    drop(market);

    let position_index = get_position_index(&user.perp_positions, market_index)?;
    let unrealized_pnl = user.perp_positions[position_index].get_unrealized_pnl(oracle_price)?;

    // cannot settle negative pnl this way on a user who is in liquidation territory
    if unrealized_pnl < 0
        && !meets_maintenance_margin_requirement(
            user,
            perp_market_map,
            spot_market_map,
            oracle_map,
        )?
    {
        return Err(ErrorCode::InsufficientCollateralForSettlingPNL);
    }

    {
        let (_, safest_tier_perp_liability) = calculate_user_safest_position_tiers(
            user,
            perp_market_map,
            spot_market_map,
            oracle_map,
            true,
        )?;

        validate!(
            contract_tier.is_as_safe_as_contract(&safest_tier_perp_liability),
            ErrorCode::TierViolationLiquidatingPerpPnl
        )?;
    }

    let spot_market = &mut spot_market_map.get_quote_spot_market_mut()?;
    let perp_market = &mut perp_market_map.get_ref_mut(&market_index)?;

    if perp_market.amm.curve_update_intensity > 0 {
        validate!(
            perp_market.amm.last_oracle_valid,
            ErrorCode::InvalidOracle,
            "Oracle Price detected as invalid"
        )?;

        validate!(
            oracle_map.slot == perp_market.amm.last_update_slot,
            ErrorCode::AMMNotUpdatedInSameSlot,
            "AMM must be updated in a prior instruction within same slot (current={} != amm={}, last_oracle_valid={})",
            oracle_map.slot,
            perp_market.amm.last_update_slot,
            perp_market.amm.last_oracle_valid
        )?;
    }

    validate!(
        perp_market.status == MarketStatus::Active,
        ErrorCode::InvalidMarketStatusToSettlePnl,
        "Cannot settle pnl under current market status"
    )?;

    let pnl_pool_token_amount = get_token_amount(
        perp_market.pnl_pool.scaled_balance,
        spot_market,
        perp_market.pnl_pool.balance_type(),
    )?
    .cast()?;
    let net_user_pnl = calculate_net_user_pnl(&perp_market.amm, oracle_price)?;
    let max_pnl_pool_excess = if net_user_pnl < pnl_pool_token_amount {
        pnl_pool_token_amount.safe_sub(net_user_pnl.max(0))?
    } else {
        0
    };

    let user_unsettled_pnl: i128 =
        user.perp_positions[position_index].get_claimable_pnl(oracle_price, max_pnl_pool_excess)?;

    let pnl_to_settle_with_user = update_pool_balances(
        perp_market,
        spot_market,
        user.get_quote_spot_position(),
        user_unsettled_pnl,
        now,
    )?;

    if user_unsettled_pnl == 0 {
        msg!("User has no unsettled pnl for market {}", market_index);
        return Ok(());
    } else if pnl_to_settle_with_user == 0 {
        msg!(
            "Pnl Pool cannot currently settle with user for market {}",
            market_index
        );
        return Ok(());
    }

    validate!(
        pnl_to_settle_with_user < 0
            || max_pnl_pool_excess > 0
            || (user.authority.eq(authority) || user.delegate.eq(authority)),
        ErrorCode::UserMustSettleTheirOwnPositiveUnsettledPNL,
        "User must settle their own unsettled pnl when its positive and pnl pool not in excess"
    )?;

    update_spot_balances(
        pnl_to_settle_with_user.unsigned_abs(),
        if pnl_to_settle_with_user > 0 {
            &SpotBalanceType::Deposit
        } else {
            &SpotBalanceType::Borrow
        },
        spot_market,
        user.get_quote_spot_position_mut(),
        false,
    )?;

    update_quote_asset_amount(
        &mut user.perp_positions[position_index],
        perp_market,
        -pnl_to_settle_with_user.cast()?,
    )?;

    update_settled_pnl(user, position_index, pnl_to_settle_with_user.cast()?)?;

    let base_asset_amount = user.perp_positions[position_index].base_asset_amount;
    let quote_asset_amount_after = user.perp_positions[position_index].quote_asset_amount;
    let quote_entry_amount = user.perp_positions[position_index].quote_entry_amount;

    crate::validation::perp_market::validate_perp_market(perp_market)?;
    crate::validation::position::validate_perp_position_with_perp_market(
        &user.perp_positions[position_index],
        perp_market,
    )?;

    emit!(SettlePnlRecord {
        ts: now,
        user: *user_key,
        market_index,
        pnl: pnl_to_settle_with_user,
        base_asset_amount,
        quote_asset_amount_after,
        quote_entry_amount,
        settle_price: oracle_price,
        explanation: SettlePnlExplanation::None,
    });

    Ok(())
}

pub fn settle_expired_position(
    perp_market_index: u16,
    user: &mut User,
    user_key: &Pubkey,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    now: i64,
    slot: u64,
    state: &State,
) -> DriftResult {
    validate!(!user.is_bankrupt(), ErrorCode::UserBankrupt)?;

    // cannot settle pnl this way on a user who is in liquidation territory
    if !(meets_maintenance_margin_requirement(user, perp_market_map, spot_market_map, oracle_map)?)
    {
        return Err(ErrorCode::InsufficientCollateralForSettlingPNL);
    }

    let fee_structure = &state.perp_fee_structure;

    {
        let quote_spot_market = &mut spot_market_map.get_quote_spot_market_mut()?;
        update_spot_market_cumulative_interest(quote_spot_market, None, now)?;
    }

    settle_funding_payment(
        user,
        user_key,
        perp_market_map.get_ref_mut(&perp_market_index)?.deref_mut(),
        now,
    )?;

    cancel_orders(
        user,
        user_key,
        None,
        perp_market_map,
        spot_market_map,
        oracle_map,
        now,
        slot,
        OrderActionExplanation::MarketExpired,
        Some(MarketType::Perp),
        Some(perp_market_index),
        None,
    )?;

    let position_index = match get_position_index(&user.perp_positions, perp_market_index) {
        Ok(index) => index,
        Err(_) => {
            msg!("User has no position for market {}", perp_market_index);
            return Ok(());
        }
    };

    let quote_spot_market = &mut spot_market_map.get_quote_spot_market_mut()?;
    let perp_market = &mut perp_market_map.get_ref_mut(&perp_market_index)?;
    validate!(
        perp_market.status == MarketStatus::Settlement,
        ErrorCode::PerpMarketNotInSettlement,
        "Perp Market isn't in settlement, expiry_ts={}",
        perp_market.expiry_ts
    )?;

    let position_settlement_ts = perp_market
        .expiry_ts
        .safe_add(state.settlement_duration.cast()?)?;

    validate!(
        now > position_settlement_ts,
        ErrorCode::PerpMarketSettlementBufferNotReached,
        "Market requires {} seconds buffer to settle after expiry_ts",
        state.settlement_duration
    )?;

    validate!(
        user.perp_positions[position_index].open_orders == 0,
        ErrorCode::PerpMarketSettlementUserHasOpenOrders,
        "User must first cancel open orders for expired market"
    )?;

    validate!(
        user.perp_positions[position_index].lp_shares == 0,
        ErrorCode::PerpMarketSettlementUserHasActiveLP,
        "User must first burn lp shares for expired market"
    )?;

    let base_asset_value = calculate_base_asset_value_with_expiry_price(
        &user.perp_positions[position_index],
        perp_market.expiry_price,
    )?;

    let base_asset_amount = user.perp_positions[position_index].base_asset_amount;
    let quote_entry_amount = user.perp_positions[position_index].quote_entry_amount;

    let position_delta = PositionDelta {
        quote_asset_amount: base_asset_value,
        base_asset_amount: -user.perp_positions[position_index].base_asset_amount,
    };

    update_position_and_market(
        &mut user.perp_positions[position_index],
        perp_market,
        &position_delta,
    )?;

    let fee = base_asset_value
        .safe_mul(fee_structure.fee_tiers[0].fee_numerator as i64)?
        .safe_div(fee_structure.fee_tiers[0].fee_denominator as i64)?;

    update_quote_asset_and_break_even_amount(
        &mut user.perp_positions[position_index],
        perp_market,
        -fee.abs(),
    )?;

    let pnl = user.perp_positions[position_index].quote_asset_amount;

    let pnl_to_settle_with_user =
        update_pnl_pool_and_user_balance(perp_market, quote_spot_market, user, pnl.cast()?)?;

    update_quote_asset_amount(
        &mut user.perp_positions[position_index],
        perp_market,
        -pnl_to_settle_with_user.cast()?,
    )?;

    update_settled_pnl(user, position_index, pnl_to_settle_with_user.cast()?)?;

    perp_market.amm.base_asset_amount_with_amm = perp_market
        .amm
        .base_asset_amount_with_amm
        .safe_add(position_delta.base_asset_amount.cast()?)?;

    let quote_asset_amount_after = user.perp_positions[position_index].quote_asset_amount;

    emit!(SettlePnlRecord {
        ts: now,
        user: *user_key,
        market_index: perp_market_index,
        pnl: pnl_to_settle_with_user,
        base_asset_amount,
        quote_asset_amount_after,
        quote_entry_amount,
        settle_price: perp_market.expiry_price,
        explanation: SettlePnlExplanation::ExpiredPosition,
    });

    validate!(
        user.perp_positions[position_index].is_available(),
        ErrorCode::UnableToSettleExpiredUserPosition,
        "Issue occurred in expired settlement"
    )?;

    Ok(())
}
