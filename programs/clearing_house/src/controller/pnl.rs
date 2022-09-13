use crate::controller::amm::{update_pnl_pool_and_user_balance, update_pool_balances};
use crate::controller::funding::settle_funding_payment;
use crate::controller::position::{
    get_position_index, update_position_and_market, update_quote_asset_amount, update_realized_pnl,
    PositionDelta,
};
use crate::controller::spot_balance::update_spot_balances;
use crate::controller::spot_balance::update_spot_market_cumulative_interest;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::casting::cast;
use crate::math::casting::cast_to_i128;
use crate::math::casting::cast_to_i64;
use crate::math::margin::meets_maintenance_margin_requirement;
use crate::math::position::calculate_base_asset_value_and_pnl_with_settlement_price;
use crate::math_error;
use crate::state::events::SettlePnlRecord;
use crate::state::market::MarketStatus;
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_market::SpotBalanceType;
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::state::State;
use crate::state::user::User;
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
    market_index: u64,
    user: &mut User,
    authority: &Pubkey,
    user_key: &Pubkey,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    now: i64,
) -> ClearingHouseResult {
    validate!(!user.bankrupt, ErrorCode::UserBankrupt)?;

    {
        let spot_market = &mut spot_market_map.get_quote_spot_market_mut()?;
        update_spot_market_cumulative_interest(spot_market, now)?;
    }

    let mut market = perp_market_map.get_ref_mut(&market_index)?;

    crate::controller::lp::settle_lp(user, user_key, &mut market, now)?;

    settle_funding_payment(user, user_key, &mut market, now)?;

    drop(market);

    // cannot settle pnl this way on a user who is in liquidation territory
    if !(meets_maintenance_margin_requirement(user, perp_market_map, spot_market_map, oracle_map)?)
    {
        return Err(ErrorCode::InsufficientCollateralForSettlingPNL);
    }

    let position_index = get_position_index(&user.perp_positions, market_index)?;

    let spot_market = &mut spot_market_map.get_quote_spot_market_mut()?;
    let perp_market = &mut perp_market_map.get_ref_mut(&market_index)?;

    // todo, check amm updated
    validate!(
        ((oracle_map.slot == perp_market.amm.last_update_slot
            && perp_market.amm.last_oracle_valid)
            || perp_market.amm.curve_update_intensity == 0),
        ErrorCode::AMMNotUpdatedInSameSlot,
        "AMM must be updated in a prior instruction within same slot"
    )?;

    validate!(
        perp_market.status == MarketStatus::Initialized,
        ErrorCode::DefaultError,
        "Cannot settle pnl under current market status"
    )?;

    let oracle_price = oracle_map.get_price_data(&perp_market.amm.oracle)?.price;
    let user_unsettled_pnl: i128 =
        user.perp_positions[position_index].get_unsettled_pnl(oracle_price)?;

    let pnl_to_settle_with_user =
        update_pool_balances(perp_market, spot_market, user_unsettled_pnl, now)?;
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
        pnl_to_settle_with_user < 0 || user.authority.eq(authority),
        ErrorCode::UserMustSettleTheirOwnPositiveUnsettledPNL,
        "User must settle their own unsettled pnl when its positive",
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
        -pnl_to_settle_with_user,
    )?;

    update_realized_pnl(
        &mut user.perp_positions[position_index],
        cast(pnl_to_settle_with_user)?,
    )?;

    let base_asset_amount = user.perp_positions[position_index].base_asset_amount;
    let quote_asset_amount_after = user.perp_positions[position_index].quote_asset_amount;
    let quote_entry_amount = user.perp_positions[position_index].quote_entry_amount;

    emit!(SettlePnlRecord {
        ts: now,
        user: *user_key,
        market_index,
        pnl: pnl_to_settle_with_user,
        base_asset_amount,
        quote_asset_amount_after,
        quote_entry_amount,
        settle_price: oracle_price,
    });

    Ok(())
}

pub fn settle_expired_position(
    market_index: u64,
    user: &mut User,
    user_key: &Pubkey,
    market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    now: i64,
    state: &State,
) -> ClearingHouseResult {
    // cannot settle pnl this way on a user who is in liquidation territory
    if !(meets_maintenance_margin_requirement(user, market_map, spot_market_map, oracle_map)?) {
        return Err(ErrorCode::InsufficientCollateralForSettlingPNL);
    }

    let fee_structure = &state.perp_fee_structure;

    {
        let quote_spot_market = &mut spot_market_map.get_quote_spot_market_mut()?;
        update_spot_market_cumulative_interest(quote_spot_market, now)?;
    }

    settle_funding_payment(
        user,
        user_key,
        market_map.get_ref_mut(&market_index)?.deref_mut(),
        now,
    )?;

    let position_index = get_position_index(&user.perp_positions, market_index)?;
    let bank = &mut spot_market_map.get_quote_spot_market_mut()?;
    let market = &mut market_map.get_ref_mut(&market_index)?;
    validate!(
        market.status == MarketStatus::Settlement,
        ErrorCode::DefaultError,
        "Market isn't in settlement, expiry_ts={}",
        market.expiry_ts
    )?;

    let position_settlement_ts = market
        .expiry_ts
        .checked_add(cast_to_i64(state.settlement_duration)?)
        .ok_or_else(math_error!())?;

    validate!(
        now > position_settlement_ts,
        ErrorCode::DefaultError,
        "Market requires {} seconds buffer to settle after expiry_ts",
        state.settlement_duration
    )?;

    validate!(
        user.perp_positions[position_index].open_orders == 0,
        ErrorCode::DefaultError,
        "User must first cancel open orders for expired market"
    )?;

    validate!(
        user.perp_positions[position_index].lp_shares == 0,
        ErrorCode::DefaultError,
        "User must first burn lp shares for expired market"
    )?;

    let (base_asset_value, unrealized_pnl) =
        calculate_base_asset_value_and_pnl_with_settlement_price(
            &user.perp_positions[position_index],
            market.settlement_price,
        )?;

    let fee = base_asset_value
        .checked_mul(fee_structure.fee_numerator)
        .ok_or_else(math_error!())?
        .checked_div(fee_structure.fee_denominator)
        .ok_or_else(math_error!())?;

    let unrealized_pnl_with_fee = unrealized_pnl
        .checked_sub(cast_to_i128(fee)?)
        .ok_or_else(math_error!())?;

    let pnl_to_settle_with_user =
        update_pnl_pool_and_user_balance(market, bank, user, unrealized_pnl_with_fee)?;

    let user_position = &mut user.perp_positions[position_index];

    let base_asset_amount = user_position.base_asset_amount;
    let quote_entry_amount = user_position.quote_entry_amount;

    let position_delta = PositionDelta {
        quote_asset_amount: -user_position.quote_asset_amount,
        base_asset_amount: -user_position.base_asset_amount,
    };

    let _user_pnl = update_position_and_market(user_position, market, &position_delta)?;

    market.amm.net_base_asset_amount = market
        .amm
        .net_base_asset_amount
        .checked_add(position_delta.base_asset_amount)
        .ok_or_else(math_error!())?;

    let quote_asset_amount_after = user_position.quote_asset_amount;

    emit!(SettlePnlRecord {
        ts: now,
        user: *user_key,
        market_index,
        pnl: pnl_to_settle_with_user,
        base_asset_amount,
        quote_asset_amount_after,
        quote_entry_amount,
        settle_price: market.settlement_price,
    });

    validate!(
        user.perp_positions[position_index].is_available(),
        ErrorCode::DefaultError,
        "Issue occurred in expired settlement"
    )?;

    Ok(())
}
