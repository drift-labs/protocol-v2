use solana_program::msg;

use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::constants::QUOTE_SPOT_MARKET_INDEX;
use crate::math::safe_math::SafeMath;

use crate::math::spot_balance::get_token_amount;
use crate::state::spot_market::{SpotBalanceType, SpotMarket};
use crate::state::user::SpotPosition;
use crate::validate;

pub fn calculate_min_deposit_token(
    deposit_token_twap: u128,
    withdraw_guard_threshold: u128,
) -> ClearingHouseResult<u128> {
    let min_deposit_token = deposit_token_twap
        .safe_sub((deposit_token_twap / 5).max(withdraw_guard_threshold.min(deposit_token_twap)))?;

    Ok(min_deposit_token)
}

pub fn calculate_max_borrow_token(
    deposit_token_amount: u128,
    borrow_token_twap: u128,
    withdraw_guard_threshold: u128,
) -> ClearingHouseResult<u128> {
    let max_borrow_token = withdraw_guard_threshold.max(
        (deposit_token_amount / 6)
            .max(borrow_token_twap.safe_add(borrow_token_twap / 5)?)
            .min(deposit_token_amount.safe_sub(deposit_token_amount / 5)?),
    ); // between ~15-80% utilization with friction on twap

    Ok(max_borrow_token)
}

pub fn check_user_exception_to_withdraw_limits(
    spot_market: &SpotMarket,
    spot_position: Option<&SpotPosition>,
    token_amount_withdrawn: Option<u128>,
) -> ClearingHouseResult<bool> {
    // allow a smaller user in QUOTE_SPOT_MARKET_INDEX to bypass and withdraw their principal
    let mut valid_user_withdraw = false;
    if let Some(spot_position) = spot_position {
        if spot_position.market_index == QUOTE_SPOT_MARKET_INDEX
            && spot_position.cumulative_deposits >= 0
            && spot_position.balance_type == SpotBalanceType::Deposit
        {
            if let Some(token_amount_withdrawn) = token_amount_withdrawn {
                let user_deposit_token_amount = get_token_amount(
                    spot_position.scaled_balance.cast::<u128>()?,
                    spot_market,
                    &spot_position.balance_type,
                )?;

                if user_deposit_token_amount.safe_add(token_amount_withdrawn)?
                    < spot_market
                        .withdraw_guard_threshold
                        .cast::<u128>()?
                        .safe_div(10)?
                {
                    valid_user_withdraw = true;
                }
            }
        }
    }

    Ok(valid_user_withdraw)
}

pub fn check_withdraw_limits(
    spot_market: &SpotMarket,
    spot_position: Option<&SpotPosition>,
    token_amount_withdrawn: Option<u128>,
) -> ClearingHouseResult<bool> {
    let deposit_token_amount = get_token_amount(
        spot_market.deposit_balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?;
    let borrow_token_amount = get_token_amount(
        spot_market.borrow_balance,
        spot_market,
        &SpotBalanceType::Borrow,
    )?;

    let max_borrow_token = calculate_max_borrow_token(
        deposit_token_amount,
        spot_market.borrow_token_twap.cast()?,
        spot_market.withdraw_guard_threshold.cast()?,
    )?;

    let min_deposit_token = calculate_min_deposit_token(
        spot_market.deposit_token_twap.cast()?,
        spot_market.withdraw_guard_threshold.cast()?,
    )?;

    let valid_global_withdrawal =
        deposit_token_amount >= min_deposit_token && borrow_token_amount <= max_borrow_token;

    let valid_withdrawal = if !valid_global_withdrawal {
        msg!(
            "withdraw_guard_threshold={:?}",
            spot_market.withdraw_guard_threshold
        );
        msg!("min_deposit_token={:?}", min_deposit_token);
        msg!("deposit_token_amount={:?}", deposit_token_amount);
        msg!("max_borrow_token={:?}", max_borrow_token);
        msg!("borrow_token_amount={:?}", borrow_token_amount);

        check_user_exception_to_withdraw_limits(spot_market, spot_position, token_amount_withdrawn)?
    } else {
        true
    };

    Ok(valid_withdrawal)
}

pub fn validate_spot_balances(spot_market: &SpotMarket) -> ClearingHouseResult<u64> {
    let depositors_amount: u64 = get_token_amount(
        spot_market.deposit_balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?
    .cast()?;
    let borrowers_amount: u64 = get_token_amount(
        spot_market.borrow_balance,
        spot_market,
        &SpotBalanceType::Borrow,
    )?
    .cast()?;

    validate!(
        depositors_amount >= borrowers_amount,
        ErrorCode::SpotMarketBalanceInvariantViolated,
        "depositors_amount={} less than borrowers_amount={}",
        depositors_amount,
        borrowers_amount
    )?;

    let revenue_amount: u64 = get_token_amount(
        spot_market.revenue_pool.scaled_balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?
    .cast()?;

    let depositors_claim = depositors_amount - borrowers_amount;

    validate!(
        revenue_amount <= depositors_amount,
        ErrorCode::SpotMarketVaultInvariantViolated,
        "revenue_amount={} greater or equal to the depositors_amount={} (depositors_claim={}, spot_market.deposit_balance={})",
        revenue_amount,
        depositors_amount,
        depositors_claim,
        spot_market.deposit_balance
    )?;

    Ok(depositors_claim)
}

pub fn validate_spot_market_vault_amount(
    spot_market: &SpotMarket,
    vault_amount: u64,
) -> ClearingHouseResult<u64> {
    let depositors_claim = validate_spot_balances(spot_market)?;

    validate!(
        vault_amount >= depositors_claim,
        ErrorCode::SpotMarketVaultInvariantViolated,
        "spot market vault ={} holds less than remaining depositor claims = {}",
        vault_amount,
        depositors_claim
    )?;

    Ok(depositors_claim)
}
