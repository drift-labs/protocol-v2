use solana_program::msg;

use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::safe_math::SafeMath;

use crate::math::spot_balance::get_token_amount;
use crate::state::spot_market::{SpotBalance, SpotBalanceType, SpotMarket};
use crate::state::user::User;
use crate::validate;

use super::constants::SPOT_UTILIZATION_PRECISION;

pub fn calculate_min_deposit_token_amount(
    deposit_token_twap: u128,
    withdraw_guard_threshold: u128,
) -> DriftResult<u128> {
    // minimum required deposit after withdrawal
    // minimum deposit amount lower of 75% of TWAP or withdrawal guard threshold below TWAP
    // these are two of the three scenarios, third is minimum deposit is 0 for high withdrawal guard threshold

    let min_deposit_token = deposit_token_twap
        .safe_sub((deposit_token_twap / 4).max(withdraw_guard_threshold.min(deposit_token_twap)))?;

    Ok(min_deposit_token)
}

pub fn calculate_max_borrow_token_amount(
    deposit_token_amount: u128,
    deposit_token_twap: u128,
    borrow_token_twap: u128,
    withdraw_guard_threshold: u128,
) -> DriftResult<u128> {
    // maximum permitted borrows after withdrawal
    // allows at least up to the withdraw_guard_threshold
    // and between ~15-80% utilization with friction on twap in 10% increments

    let lesser_deposit_amount = deposit_token_amount.min(deposit_token_twap);

    let max_borrow_token = withdraw_guard_threshold.max(
        (lesser_deposit_amount / 6)
            .max(borrow_token_twap.safe_add(lesser_deposit_amount / 10)?)
            .min(lesser_deposit_amount.safe_sub(lesser_deposit_amount / 5)?),
    );

    Ok(max_borrow_token)
}

pub fn check_user_exception_to_withdraw_limits(
    spot_market: &SpotMarket,
    user: Option<&User>,
    token_amount_withdrawn: Option<u128>,
) -> DriftResult<bool> {
    // allow a smaller user in a market to bypass and withdraw their principal
    let mut valid_user_withdraw = false;
    if let Some(user) = user {
        let spot_position = user.get_spot_position(spot_market.market_index)?;
        let net_deposits = user
            .total_deposits
            .cast::<i128>()?
            .safe_sub(user.total_withdraws.cast::<i128>()?)?;
        msg!(
            "net_deposits={}({}-{})",
            net_deposits,
            user.total_deposits,
            user.total_withdraws
        );
        if net_deposits >= 0
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

pub fn calculate_token_utilization_limits(
    deposit_token_amount: u128,
    borrow_token_amount: u128,
    spot_market: &SpotMarket,
) -> DriftResult<(u128, u128)> {
    // Calculates the allowable minimum deposit and maximum borrow amounts for immediate withdrawal based on market utilization.
    // First, it determines a maximum withdrawal utilization from the market's target and historic utilization.
    // Then, it deduces corresponding deposit/borrow amounts.
    // Note: For deposit sizes below the guard threshold, withdrawals aren't blocked.

    let max_withdraw_utilization: u128 = spot_market.optimal_utilization.cast::<u128>()?.max(
        spot_market.utilization_twap.cast::<u128>()?.safe_add(
            SPOT_UTILIZATION_PRECISION
                .safe_sub(spot_market.utilization_twap.cast()?)?
                .safe_div(2)?,
        )?,
    );

    let mut min_deposit_tokens_for_utilization = borrow_token_amount
        .safe_mul(SPOT_UTILIZATION_PRECISION)?
        .safe_div(max_withdraw_utilization)?;

    // dont block withdraws for deposit sizes below guard threshold
    min_deposit_tokens_for_utilization = min_deposit_tokens_for_utilization
        .min(deposit_token_amount.saturating_sub(spot_market.withdraw_guard_threshold.cast()?));

    let mut max_borrow_tokens_for_utilization = max_withdraw_utilization
        .safe_mul(deposit_token_amount)?
        .safe_div(SPOT_UTILIZATION_PRECISION)?;

    // dont block borrows for sizes below guard threshold
    max_borrow_tokens_for_utilization =
        max_borrow_tokens_for_utilization.max(spot_market.withdraw_guard_threshold.cast()?);

    Ok((
        min_deposit_tokens_for_utilization,
        max_borrow_tokens_for_utilization,
    ))
}

pub fn check_withdraw_limits(
    spot_market: &SpotMarket,
    user: Option<&User>,
    token_amount_withdrawn: Option<u128>,
) -> DriftResult<bool> {
    // calculates min/max deposit/borrow amounts permitted for immediate withdraw
    // takes the stricter of absolute caps on level changes and utilization changes vs 24hr moving averrages
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

    let max_borrow_token_for_twap = calculate_max_borrow_token_amount(
        deposit_token_amount,
        spot_market.deposit_token_twap.cast()?,
        spot_market.borrow_token_twap.cast()?,
        spot_market.withdraw_guard_threshold.cast()?,
    )?;

    let (min_deposit_token_for_utilization, max_borrow_token_for_utilization) =
        calculate_token_utilization_limits(deposit_token_amount, borrow_token_amount, spot_market)?;

    let max_borrow_token = max_borrow_token_for_twap.min(max_borrow_token_for_utilization);

    let min_deposit_token_for_twap = calculate_min_deposit_token_amount(
        spot_market.deposit_token_twap.cast()?,
        spot_market.withdraw_guard_threshold.cast()?,
    )?;

    let min_deposit_token = min_deposit_token_for_twap.max(min_deposit_token_for_utilization);

    // for resulting deposit or ZERO, check if deposits above minimum
    // for resulting borrow, check both deposit and borrow constraints
    let valid_global_withdrawal = if let Some(user) = user {
        let spot_position_index = user.get_spot_position_index(spot_market.market_index)?;
        if user.spot_positions[spot_position_index].balance_type() == &SpotBalanceType::Borrow {
            borrow_token_amount <= max_borrow_token && deposit_token_amount >= min_deposit_token
        } else {
            deposit_token_amount >= min_deposit_token
        }
    } else {
        deposit_token_amount >= min_deposit_token && borrow_token_amount <= max_borrow_token
    };

    let valid_withdrawal = if !valid_global_withdrawal {
        msg!(
            "withdraw_guard_threshold={:?}",
            spot_market.withdraw_guard_threshold
        );
        msg!("min_deposit_token={:?}", min_deposit_token);
        msg!("deposit_token_amount={:?}", deposit_token_amount);
        msg!("max_borrow_token={:?}", max_borrow_token);
        msg!("borrow_token_amount={:?}", borrow_token_amount);

        check_user_exception_to_withdraw_limits(spot_market, user, token_amount_withdrawn)?
    } else {
        true
    };

    Ok(valid_withdrawal)
}

pub fn get_max_withdraw_for_market_with_token_amount(
    spot_market: &SpotMarket,
    token_amount: i128,
    is_pool_transfer: bool,
) -> DriftResult<u128> {
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

    let (min_deposit_token_for_utilization, max_borrow_token_for_utilization) =
        calculate_token_utilization_limits(deposit_token_amount, borrow_token_amount, spot_market)?;

    let mut max_withdraw_amount = 0_u128;
    if token_amount > 0 {
        let min_deposit_token_for_twap = calculate_min_deposit_token_amount(
            spot_market.deposit_token_twap.cast()?,
            spot_market.withdraw_guard_threshold.cast()?,
        )?;
        let min_deposit_token = min_deposit_token_for_twap.max(min_deposit_token_for_utilization);
        let withdraw_limit = deposit_token_amount.saturating_sub(min_deposit_token);

        let token_amount = token_amount.unsigned_abs();
        if withdraw_limit <= token_amount && !is_pool_transfer {
            return Ok(withdraw_limit);
        }

        max_withdraw_amount = token_amount;
    }

    let max_borrow_token_for_twap = calculate_max_borrow_token_amount(
        deposit_token_amount,
        spot_market.deposit_token_twap.cast()?,
        spot_market.borrow_token_twap.cast()?,
        spot_market.withdraw_guard_threshold.cast()?,
    )?;

    let max_borrow_token = max_borrow_token_for_twap.min(max_borrow_token_for_utilization);

    let borrow_limit = max_borrow_token
        .saturating_sub(borrow_token_amount)
        .min(deposit_token_amount.saturating_sub(borrow_token_amount));

    max_withdraw_amount.safe_add(borrow_limit)
}

pub fn validate_spot_balances(spot_market: &SpotMarket) -> DriftResult<u64> {
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
) -> DriftResult<u64> {
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
