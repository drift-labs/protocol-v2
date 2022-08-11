use crate::controller::amm::update_pool_balances;
use crate::controller::bank_balance::{update_bank_balances, update_bank_cumulative_interest};
use crate::controller::funding::settle_funding_payment;
use crate::controller::position::{get_position_index, update_quote_asset_amount};
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::margin::meets_maintenance_margin_requirement;
use crate::state::bank::BankBalanceType;
use crate::state::bank_map::BankMap;
use crate::state::market_map::MarketMap;
use crate::state::oracle_map::OracleMap;
use crate::state::user::User;
use crate::validate;
use anchor_lang::prelude::Pubkey;
use solana_program::msg;
use std::ops::DerefMut;

#[cfg(test)]
mod tests;

pub fn settle_pnl(
    market_index: u64,
    user: &mut User,
    authority: &Pubkey,
    user_key: &Pubkey,
    market_map: &MarketMap,
    bank_map: &BankMap,
    oracle_map: &mut OracleMap,
    now: i64,
) -> ClearingHouseResult {
    {
        let bank = &mut bank_map.get_quote_asset_bank_mut()?;
        update_bank_cumulative_interest(bank, now)?;
    }

    settle_funding_payment(
        user,
        user_key,
        market_map.get_ref_mut(&market_index)?.deref_mut(),
        now,
    )?;

    // cannot settle pnl this way on a user who is in liquidation territory
    if !(meets_maintenance_margin_requirement(user, market_map, bank_map, oracle_map)?) {
        return Err(ErrorCode::InsufficientCollateralForSettlingPNL);
    }

    let position_index = get_position_index(&user.positions, market_index)?;

    let bank = &mut bank_map.get_quote_asset_bank_mut()?;
    let market = &mut market_map.get_ref_mut(&market_index)?;

    let oracle_price = oracle_map.get_price_data(&market.amm.oracle)?.price;
    let user_unsettled_pnl: i128 =
        user.positions[position_index].get_unsettled_pnl(oracle_price)?;

    let pnl_to_settle_with_user = update_pool_balances(market, bank, user_unsettled_pnl)?;

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

    update_bank_balances(
        pnl_to_settle_with_user.unsigned_abs(),
        if pnl_to_settle_with_user > 0 {
            &BankBalanceType::Deposit
        } else {
            &BankBalanceType::Borrow
        },
        bank,
        user.get_quote_asset_bank_balance_mut(),
    )?;

    update_quote_asset_amount(
        &mut user.positions[position_index],
        -pnl_to_settle_with_user,
    )?;

    Ok(())
}
