use crate::controller::bank_balance::{
    update_bank_cumulative_interest, update_revenue_pool_balances,
};
use crate::error::ClearingHouseResult;
use crate::error::ErrorCode;
use crate::math::bank_balance::get_token_amount;
use crate::math::bank_balance::validate_bank_amounts;
use crate::math::casting::{cast_to_i128, cast_to_i64, cast_to_u128, cast_to_u32, cast_to_u64};
use crate::math::constants::{
    SHARE_OF_REVENUE_ALLOCATED_TO_INSURANCE_FUND_VAULT_DENOMINATOR,
    SHARE_OF_REVENUE_ALLOCATED_TO_INSURANCE_FUND_VAULT_NUMERATOR,
};
use crate::math::helpers::get_proportion_u128;
use crate::math::insurance::{
    calculate_if_shares_lost, calculate_rebase_info, staked_amount_to_shares,
    unstaked_shares_to_amount,
};
use crate::math_error;
use crate::state::bank::{Bank, BankBalanceType};
use crate::state::events::{InsuranceFundRecord, InsuranceFundStakeRecord, StakeAction};
use crate::state::insurance_fund_stake::InsuranceFundStake;
use crate::state::user::UserStats;
use crate::{emit, validate};
use solana_program::msg;

pub fn add_insurance_fund_stake(
    amount: u64,
    insurance_vault_amount: u64,
    insurance_fund_stake: &mut InsuranceFundStake,
    user_stats: &mut UserStats,
    bank: &mut Bank,
    now: i64,
) -> ClearingHouseResult {
    validate!(
        !(insurance_vault_amount == 0 && bank.total_if_shares != 0),
        ErrorCode::DefaultError,
        "Insurance Fund balance should be non-zero for new LPs to enter"
    )?;

    let if_shares_before = insurance_fund_stake.if_shares;
    let total_if_shares_before = bank.total_if_shares;
    let user_if_shares_before = bank.user_if_shares;

    apply_rebase_to_insurance_fund(insurance_vault_amount, bank)?;
    apply_rebase_to_insurance_fund_stake(insurance_fund_stake, user_stats, bank)?;

    let n_shares = staked_amount_to_shares(amount, bank.total_if_shares, insurance_vault_amount)?;

    // reset cost basis if no shares
    insurance_fund_stake.cost_basis = if insurance_fund_stake.if_shares == 0 {
        cast_to_i64(amount)?
    } else {
        insurance_fund_stake
            .cost_basis
            .checked_add(cast_to_i64(amount)?)
            .ok_or_else(math_error!())?
    };

    insurance_fund_stake.if_shares = insurance_fund_stake
        .if_shares
        .checked_add(n_shares)
        .ok_or_else(math_error!())?;

    bank.total_if_shares = bank
        .total_if_shares
        .checked_add(n_shares)
        .ok_or_else(math_error!())?;

    bank.user_if_shares = bank
        .user_if_shares
        .checked_add(n_shares)
        .ok_or_else(math_error!())?;

    if bank.bank_index == 0 {
        user_stats.quote_asset_insurance_fund_stake = user_stats
            .quote_asset_insurance_fund_stake
            .checked_add(n_shares)
            .ok_or_else(math_error!())?;
    }

    emit!(InsuranceFundStakeRecord {
        ts: now,
        user_authority: user_stats.authority,
        action: StakeAction::Stake,
        amount,
        bank_index: bank.bank_index,
        insurance_vault_amount_before: insurance_vault_amount,
        if_shares_before,
        user_if_shares_before,
        total_if_shares_before,
        if_shares_after: insurance_fund_stake.if_shares,
        total_if_shares_after: bank.total_if_shares,
        user_if_shares_after: bank.user_if_shares,
    });

    Ok(())
}

pub fn apply_rebase_to_insurance_fund(
    insurance_fund_vault_balance: u64,
    bank: &mut Bank,
) -> ClearingHouseResult {
    if insurance_fund_vault_balance != 0
        && cast_to_u128(insurance_fund_vault_balance)? < bank.total_if_shares
    {
        let (expo_diff, rebase_divisor) =
            calculate_rebase_info(bank.total_if_shares, insurance_fund_vault_balance)?;

        bank.total_if_shares = bank
            .total_if_shares
            .checked_div(rebase_divisor)
            .ok_or_else(math_error!())?;
        bank.user_if_shares = bank
            .user_if_shares
            .checked_div(rebase_divisor)
            .ok_or_else(math_error!())?;
        bank.if_shares_base = bank
            .if_shares_base
            .checked_add(cast_to_u128(expo_diff)?)
            .ok_or_else(math_error!())?;

        msg!("rebasing insurance fund: expo_diff={}", expo_diff);
    }

    if insurance_fund_vault_balance != 0 && bank.total_if_shares == 0 {
        bank.total_if_shares = cast_to_u128(insurance_fund_vault_balance)?;
    }

    Ok(())
}

pub fn apply_rebase_to_insurance_fund_stake(
    insurance_fund_stake: &mut InsuranceFundStake,
    user_stats: &mut UserStats,
    bank: &mut Bank,
) -> ClearingHouseResult {
    if bank.if_shares_base != insurance_fund_stake.if_base {
        validate!(
            bank.if_shares_base > insurance_fund_stake.if_base,
            ErrorCode::DefaultError,
            "Rebase expo out of bounds"
        )?;

        let expo_diff = cast_to_u32(bank.if_shares_base - insurance_fund_stake.if_base)?;

        let rebase_divisor = 10_u128.pow(expo_diff);

        insurance_fund_stake.if_shares = insurance_fund_stake
            .if_shares
            .checked_div(rebase_divisor)
            .ok_or_else(math_error!())?;

        insurance_fund_stake.last_withdraw_request_shares = insurance_fund_stake
            .last_withdraw_request_shares
            .checked_div(rebase_divisor)
            .ok_or_else(math_error!())?;

        if bank.bank_index == 0 {
            user_stats.quote_asset_insurance_fund_stake = user_stats
                .quote_asset_insurance_fund_stake
                .checked_div(rebase_divisor)
                .ok_or_else(math_error!())?;
        }

        msg!(
            "rebasing insurance fund stake: base: {} -> {} ",
            insurance_fund_stake.if_base,
            bank.if_shares_base,
        );

        msg!(
            "rebasing insurance fund stake: shares -> {} ",
            insurance_fund_stake.if_shares
        );

        insurance_fund_stake.if_base = bank.if_shares_base;
    }

    Ok(())
}

pub fn request_remove_insurance_fund_stake(
    n_shares: u128,
    insurance_vault_amount: u64,
    insurance_fund_stake: &mut InsuranceFundStake,
    user_stats: &mut UserStats,
    bank: &mut Bank,
    now: i64,
) -> ClearingHouseResult {
    insurance_fund_stake.last_withdraw_request_shares = n_shares;
    insurance_fund_stake.last_withdraw_request_value =
        unstaked_shares_to_amount(n_shares, bank.total_if_shares, insurance_vault_amount)?;

    let if_shares_before = insurance_fund_stake.if_shares;
    let total_if_shares_before = bank.total_if_shares;
    let user_if_shares_before = bank.user_if_shares;

    apply_rebase_to_insurance_fund(insurance_vault_amount, bank)?;
    apply_rebase_to_insurance_fund_stake(insurance_fund_stake, user_stats, bank)?;

    validate!(
        insurance_fund_stake.last_withdraw_request_value == 0
            || insurance_fund_stake.last_withdraw_request_value < insurance_vault_amount,
        ErrorCode::DefaultError,
        "Requested withdraw value is not below Insurance Fund balance"
    )?;

    emit!(InsuranceFundStakeRecord {
        ts: now,
        user_authority: user_stats.authority,
        action: StakeAction::UnstakeRequest,
        amount: insurance_fund_stake.last_withdraw_request_value,
        bank_index: bank.bank_index,
        insurance_vault_amount_before: insurance_vault_amount,
        if_shares_before,
        user_if_shares_before,
        total_if_shares_before,
        if_shares_after: insurance_fund_stake.if_shares,
        total_if_shares_after: bank.total_if_shares,
        user_if_shares_after: bank.user_if_shares,
    });

    insurance_fund_stake.last_withdraw_request_ts = now;

    Ok(())
}

pub fn cancel_request_remove_insurance_fund_stake(
    insurance_vault_amount: u64,
    insurance_fund_stake: &mut InsuranceFundStake,
    user_stats: &mut UserStats,
    bank: &mut Bank,
    now: i64,
) -> ClearingHouseResult {
    let if_shares_before = insurance_fund_stake.if_shares;
    let total_if_shares_before = bank.total_if_shares;
    let user_if_shares_before = bank.user_if_shares;

    apply_rebase_to_insurance_fund(insurance_vault_amount, bank)?;
    apply_rebase_to_insurance_fund_stake(insurance_fund_stake, user_stats, bank)?;

    validate!(
        insurance_fund_stake.last_withdraw_request_shares != 0,
        ErrorCode::DefaultError,
        "No withdraw request in progress"
    )?;

    let if_shares_lost =
        calculate_if_shares_lost(insurance_fund_stake, bank, insurance_vault_amount)?;

    insurance_fund_stake.if_shares = insurance_fund_stake
        .if_shares
        .checked_sub(if_shares_lost)
        .ok_or_else(math_error!())?;

    bank.total_if_shares = bank
        .total_if_shares
        .checked_sub(if_shares_lost)
        .ok_or_else(math_error!())?;

    bank.user_if_shares = bank
        .user_if_shares
        .checked_sub(if_shares_lost)
        .ok_or_else(math_error!())?;

    if bank.bank_index == 0 {
        user_stats.quote_asset_insurance_fund_stake = insurance_fund_stake.if_shares;
    }

    emit!(InsuranceFundStakeRecord {
        ts: now,
        user_authority: user_stats.authority,
        action: StakeAction::UnstakeCancelRequest,
        amount: 0,
        bank_index: bank.bank_index,
        insurance_vault_amount_before: insurance_vault_amount,
        if_shares_before,
        user_if_shares_before,
        total_if_shares_before,
        if_shares_after: insurance_fund_stake.if_shares,
        total_if_shares_after: bank.total_if_shares,
        user_if_shares_after: bank.user_if_shares,
    });

    insurance_fund_stake.last_withdraw_request_shares = 0;
    insurance_fund_stake.last_withdraw_request_value = 0;
    insurance_fund_stake.last_withdraw_request_ts = now;

    Ok(())
}

pub fn remove_insurance_fund_stake(
    insurance_vault_amount: u64,
    insurance_fund_stake: &mut InsuranceFundStake,
    user_stats: &mut UserStats,
    bank: &mut Bank,
    now: i64,
) -> ClearingHouseResult<u64> {
    let time_since_withdraw_request = now
        .checked_sub(insurance_fund_stake.last_withdraw_request_ts)
        .ok_or_else(math_error!())?;

    validate!(
        time_since_withdraw_request >= bank.insurance_withdraw_escrow_period,
        ErrorCode::TryingToRemoveLiquidityTooFast
    )?;

    let if_shares_before = insurance_fund_stake.if_shares;
    let total_if_shares_before = bank.total_if_shares;
    let user_if_shares_before = bank.user_if_shares;

    apply_rebase_to_insurance_fund(insurance_vault_amount, bank)?;
    apply_rebase_to_insurance_fund_stake(insurance_fund_stake, user_stats, bank)?;

    let n_shares = insurance_fund_stake.last_withdraw_request_shares;

    validate!(
        n_shares > 0,
        ErrorCode::DefaultError,
        "Must submit withdraw request and wait the escrow period"
    )?;

    validate!(
        insurance_fund_stake.if_shares >= n_shares,
        ErrorCode::InsufficientLPTokens
    )?;

    let amount = unstaked_shares_to_amount(n_shares, bank.total_if_shares, insurance_vault_amount)?;

    let _if_shares_lost =
        calculate_if_shares_lost(insurance_fund_stake, bank, insurance_vault_amount)?;

    let withdraw_amount = amount.min(insurance_fund_stake.last_withdraw_request_value);

    insurance_fund_stake.if_shares = insurance_fund_stake
        .if_shares
        .checked_sub(n_shares)
        .ok_or_else(math_error!())?;

    insurance_fund_stake.cost_basis = insurance_fund_stake
        .cost_basis
        .checked_sub(cast_to_i64(withdraw_amount)?)
        .ok_or_else(math_error!())?;

    if bank.bank_index == 0 {
        user_stats.quote_asset_insurance_fund_stake = user_stats
            .quote_asset_insurance_fund_stake
            .checked_sub(n_shares)
            .ok_or_else(math_error!())?;
    }

    bank.total_if_shares = bank
        .total_if_shares
        .checked_sub(n_shares)
        .ok_or_else(math_error!())?;

    bank.user_if_shares = bank
        .user_if_shares
        .checked_sub(n_shares)
        .ok_or_else(math_error!())?;

    // reset insurance_fund_stake withdraw request info
    insurance_fund_stake.last_withdraw_request_shares = 0;
    insurance_fund_stake.last_withdraw_request_value = 0;
    insurance_fund_stake.last_withdraw_request_ts = now;

    emit!(InsuranceFundStakeRecord {
        ts: now,
        user_authority: user_stats.authority,
        action: StakeAction::Unstake,
        amount: withdraw_amount,
        bank_index: bank.bank_index,
        insurance_vault_amount_before: insurance_vault_amount,
        if_shares_before,
        user_if_shares_before,
        total_if_shares_before,
        if_shares_after: insurance_fund_stake.if_shares,
        total_if_shares_after: bank.total_if_shares,
        user_if_shares_after: bank.user_if_shares,
    });

    Ok(withdraw_amount)
}

pub fn settle_revenue_to_insurance_fund(
    bank_vault_amount: u64,
    insurance_vault_amount: u64,
    bank: &mut Bank,
    now: i64,
) -> ClearingHouseResult<u64> {
    update_bank_cumulative_interest(bank, now)?;

    validate!(
        bank.user_if_factor <= bank.total_if_factor,
        ErrorCode::DefaultError,
        "invalid if_factor settings on bank"
    )?;

    validate!(
        bank.user_if_factor > 0 || bank.total_if_factor > 0,
        ErrorCode::DefaultError,
        "if_factor = 0 for this bank"
    )?;

    let depositors_claim = cast_to_u128(validate_bank_amounts(bank, bank_vault_amount)?)?;

    let token_amount = get_token_amount(
        bank.revenue_pool.balance,
        bank,
        &BankBalanceType::Deposit,
        // bank.revenue_pool.balance_type(),
    )?
    .min(depositors_claim);

    let insurance_fund_token_amount = cast_to_u64(get_proportion_u128(
        token_amount,
        SHARE_OF_REVENUE_ALLOCATED_TO_INSURANCE_FUND_VAULT_NUMERATOR,
        SHARE_OF_REVENUE_ALLOCATED_TO_INSURANCE_FUND_VAULT_DENOMINATOR,
    )?)?;

    validate!(
        insurance_fund_token_amount != 0,
        ErrorCode::DefaultError,
        "no amount to settle to insurance fund"
    )?;

    bank.last_revenue_settle_ts = now;

    let protocol_if_factor = bank
        .total_if_factor
        .checked_sub(bank.user_if_factor)
        .ok_or_else(math_error!())?;

    // give protocol its cut
    let n_shares = staked_amount_to_shares(
        insurance_fund_token_amount
            .checked_mul(cast_to_u64(protocol_if_factor)?)
            .ok_or_else(math_error!())?
            .checked_div(cast_to_u64(bank.total_if_factor)?)
            .ok_or_else(math_error!())?,
        bank.total_if_shares,
        insurance_vault_amount,
    )?;

    let total_if_shares_before = bank.total_if_shares;

    bank.total_if_shares = bank
        .total_if_shares
        .checked_add(n_shares)
        .ok_or_else(math_error!())?;

    update_revenue_pool_balances(
        cast_to_u128(insurance_fund_token_amount)?,
        &BankBalanceType::Borrow,
        bank,
    )?;

    emit!(InsuranceFundRecord {
        ts: now,
        bank_index: bank.bank_index,
        amount: insurance_fund_token_amount,

        user_if_factor: bank.user_if_factor,
        total_if_factor: bank.total_if_factor,
        bank_vault_amount_before: bank_vault_amount,
        insurance_vault_amount_before: insurance_vault_amount,
        total_if_shares_before,
        total_if_shares_after: bank.total_if_shares,
    });

    cast_to_u64(insurance_fund_token_amount)
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::math::constants::{BANK_CUMULATIVE_INTEREST_PRECISION, QUOTE_PRECISION};
    use crate::state::user::UserStats;

    #[test]
    pub fn basic_stake_if_test() {
        let mut if_balance = 0;
        let mut if_stake = InsuranceFundStake {
            if_shares: 0,
            ..InsuranceFundStake::default()
        };
        let mut user_stats = UserStats {
            number_of_users: 0,
            ..UserStats::default()
        };
        let amount = QUOTE_PRECISION as u64; // $1
        let mut bank = Bank {
            deposit_balance: 0,
            cumulative_deposit_interest: 1111 * BANK_CUMULATIVE_INTEREST_PRECISION / 1000,
            insurance_withdraw_escrow_period: 0,
            ..Bank::default()
        };

        add_insurance_fund_stake(
            amount,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();
        assert_eq!(if_stake.if_shares, amount as u128);
        if_balance = if_balance + amount;

        // must request first
        assert!(remove_insurance_fund_stake(
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0
        )
        .is_err());
        assert_eq!(if_stake.if_shares, amount as u128);

        request_remove_insurance_fund_stake(
            if_stake.if_shares,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();
        assert_eq!(if_stake.last_withdraw_request_shares, if_stake.if_shares);
        assert_eq!(if_stake.last_withdraw_request_value, if_balance - 1); //rounding in favor

        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();
        assert_eq!(amount_returned, amount - 1);
        if_balance = if_balance - amount_returned;

        assert_eq!(if_stake.if_shares, 0);
        assert_eq!(if_stake.cost_basis, 1);
        assert_eq!(if_stake.last_withdraw_request_shares, 0);
        assert_eq!(if_stake.last_withdraw_request_value, 0);
        assert_eq!(if_balance, 1);

        add_insurance_fund_stake(
            1234,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();
        assert_eq!(if_stake.cost_basis, 1234);
    }

    #[test]
    pub fn basic_seeded_stake_if_test() {
        let mut if_balance = (1000 * QUOTE_PRECISION) as u64;
        let mut if_stake = InsuranceFundStake {
            if_shares: 0,
            ..InsuranceFundStake::default()
        };
        let mut user_stats = UserStats {
            number_of_users: 0,
            ..UserStats::default()
        };
        let amount = QUOTE_PRECISION as u64; // $1
        let mut bank = Bank {
            deposit_balance: 0,
            cumulative_deposit_interest: 1111 * BANK_CUMULATIVE_INTEREST_PRECISION / 1000,
            insurance_withdraw_escrow_period: 0,
            ..Bank::default()
        };

        assert_eq!(bank.total_if_shares, 0);
        assert_eq!(bank.user_if_shares, 0);

        add_insurance_fund_stake(
            amount,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();

        assert_eq!(bank.total_if_shares, (1001 * QUOTE_PRECISION)); // seeded works
        assert_eq!(bank.user_if_shares, (1 * QUOTE_PRECISION));
        assert_eq!(if_stake.if_shares, amount as u128);
        if_balance = if_balance + amount;

        // must request first
        assert!(remove_insurance_fund_stake(
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0
        )
        .is_err());
        assert_eq!(if_stake.if_shares, amount as u128);

        request_remove_insurance_fund_stake(
            if_stake.if_shares,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();
        assert_eq!(if_stake.last_withdraw_request_shares, if_stake.if_shares);
        assert_eq!(if_stake.last_withdraw_request_value, 999999); //rounding in favor

        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();
        assert_eq!(amount_returned, amount - 1);
        if_balance = if_balance - amount_returned;

        assert_eq!(if_stake.if_shares, 0);
        assert_eq!(if_stake.cost_basis, 1);
        assert_eq!(if_stake.last_withdraw_request_shares, 0);
        assert_eq!(if_stake.last_withdraw_request_value, 0);
        assert_eq!(if_balance, 1000000001);

        add_insurance_fund_stake(
            1234,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();
        assert_eq!(if_stake.cost_basis, 1234);
    }

    #[test]
    pub fn gains_stake_if_test() {
        let mut if_balance = 0;
        let mut if_stake = InsuranceFundStake {
            if_shares: 0,
            ..InsuranceFundStake::default()
        };
        let mut user_stats = UserStats {
            number_of_users: 0,
            ..UserStats::default()
        };
        let amount = QUOTE_PRECISION as u64; // $1
        let mut bank = Bank {
            deposit_balance: 0,
            cumulative_deposit_interest: 1111 * BANK_CUMULATIVE_INTEREST_PRECISION / 1000,
            insurance_withdraw_escrow_period: 0,
            ..Bank::default()
        };

        add_insurance_fund_stake(
            amount,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();
        assert_eq!(if_stake.if_shares, amount as u128);
        if_balance = if_balance + amount;

        // gains
        if_balance = if_balance + amount / 19;

        let n_shares = if_stake.if_shares;
        let expected_amount_returned = (amount + amount / 19) / 3 - 1;

        request_remove_insurance_fund_stake(
            n_shares / 3,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();
        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();
        assert_eq!(amount_returned, expected_amount_returned - 1);
        assert_eq!(if_stake.if_shares, n_shares * 2 / 3 + 1);
        if_balance = if_balance - amount_returned;

        request_remove_insurance_fund_stake(
            n_shares / 3,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();
        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();
        assert_eq!(if_stake.if_shares, n_shares / 3 + 1);
        assert_eq!(amount_returned, expected_amount_returned);
        if_balance = if_balance - amount_returned;

        request_remove_insurance_fund_stake(
            1,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();

        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();
        assert_eq!(amount_returned, 0);

        request_remove_insurance_fund_stake(
            n_shares / 3 - 1,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();

        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();
        assert_eq!(amount_returned, expected_amount_returned + 1);

        if_balance = if_balance - amount_returned;

        assert_eq!(if_balance, 3);
    }

    #[test]
    pub fn losses_stake_if_test() {
        let mut if_balance = 0;
        let mut if_stake = InsuranceFundStake {
            if_shares: 0,
            ..InsuranceFundStake::default()
        };
        let mut user_stats = UserStats {
            number_of_users: 0,
            ..UserStats::default()
        };
        let amount = QUOTE_PRECISION as u64; // $1
        let mut bank = Bank {
            deposit_balance: 0,
            cumulative_deposit_interest: 1111 * BANK_CUMULATIVE_INTEREST_PRECISION / 1000,
            insurance_withdraw_escrow_period: 0,
            ..Bank::default()
        };

        add_insurance_fund_stake(
            amount,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();
        assert_eq!(if_stake.if_shares, amount as u128);
        if_balance = if_balance + amount;

        // gains
        if_balance = if_balance - amount / 19;

        let n_shares = if_stake.if_shares;
        let expected_amount_returned = (amount - amount / 19) / 3;

        request_remove_insurance_fund_stake(
            n_shares / 3,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();

        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();
        assert_eq!(amount_returned, expected_amount_returned);
        assert_eq!(if_stake.if_shares, n_shares * 2 / 3 + 1);
        if_balance = if_balance - amount_returned;

        request_remove_insurance_fund_stake(
            n_shares / 3,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();
        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();
        assert_eq!(if_stake.if_shares, n_shares / 3 + 1);
        assert_eq!(amount_returned, expected_amount_returned);
        if_balance = if_balance - amount_returned;

        request_remove_insurance_fund_stake(
            1,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();

        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();
        assert_eq!(if_stake.if_shares, n_shares * 1 / 3);
        assert_eq!(amount_returned, 0);

        request_remove_insurance_fund_stake(
            n_shares / 3,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();
        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();
        assert_eq!(amount_returned, expected_amount_returned + 1);
        assert_eq!(if_stake.cost_basis, 52632);
        assert_eq!(if_stake.if_shares, 0);

        if_balance = if_balance - amount_returned;

        assert_eq!(if_balance, 1); // todo, should be stricer w/ rounding?
    }

    #[test]
    pub fn escrow_losses_stake_if_test() {
        let mut if_balance = 0;
        let mut if_stake = InsuranceFundStake {
            if_shares: 0,
            ..InsuranceFundStake::default()
        };
        let mut user_stats = UserStats {
            number_of_users: 0,
            ..UserStats::default()
        };
        let amount = (QUOTE_PRECISION * 100_000) as u64; // $100k
        let mut bank = Bank {
            deposit_balance: 0,
            cumulative_deposit_interest: 1111 * BANK_CUMULATIVE_INTEREST_PRECISION / 1000,
            insurance_withdraw_escrow_period: 60 * 60 * 24 * 7, // 7 weeks
            ..Bank::default()
        };

        let now = 7842193748;

        add_insurance_fund_stake(
            amount,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();
        assert_eq!(if_stake.if_shares, amount as u128);
        if_balance = if_balance + amount;

        // losses
        if_balance = if_balance - amount / 19;

        let n_shares = if_stake.if_shares;
        let expected_amount_returned = (amount - amount / 19) / 3;

        let o = unstaked_shares_to_amount(n_shares / 3, bank.total_if_shares, if_balance).unwrap();
        assert_eq!(if_stake.last_withdraw_request_shares, 0);

        request_remove_insurance_fund_stake(
            n_shares / 3,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            now,
        )
        .unwrap();
        assert_eq!(if_stake.last_withdraw_request_shares, 33333333333);
        assert_eq!(
            if_stake.last_withdraw_request_value,
            expected_amount_returned
        );
        assert_eq!(expected_amount_returned, o);
        assert_eq!(o, 31578947368);

        // not enough time for withdraw
        assert!(remove_insurance_fund_stake(
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            now + 60 * 60 * 24,
        )
        .is_err());

        // more losses
        if_balance = if_balance - if_balance / 2;

        // appropriate time for withdraw
        let amount_returned = (remove_insurance_fund_stake(
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            now + 60 * 60 * 24 * 7 + 3254,
        ))
        .unwrap();
        if_balance = if_balance - amount_returned;

        // since losses occured during withdraw, worse than expected at time of request
        assert_eq!(amount_returned < (expected_amount_returned - 1), true);
        assert_eq!(amount_returned, 15_789_473_683); //15k
        assert_eq!(if_stake.if_shares, n_shares * 2 / 3 + 1);
        assert_eq!(if_stake.cost_basis, 84_210_526_317); //84k
        assert_eq!(if_balance, 31_578_947_370); //31k
    }

    #[test]
    pub fn escrow_gains_stake_if_test() {
        let mut if_balance = 0;
        let mut if_stake = InsuranceFundStake {
            if_shares: 0,
            ..InsuranceFundStake::default()
        };
        let mut user_stats = UserStats {
            number_of_users: 0,
            ..UserStats::default()
        };
        let amount = 100_000_384_939 as u64; // $100k + change
        let mut bank = Bank {
            deposit_balance: 0,
            cumulative_deposit_interest: 1111 * BANK_CUMULATIVE_INTEREST_PRECISION / 1000,
            insurance_withdraw_escrow_period: 60 * 60 * 24 * 7, // 7 weeks
            total_if_shares: 1,
            user_if_shares: 0,
            ..Bank::default()
        };

        let now = 7842193748;
        assert_eq!(if_balance, 0);
        // right now other users have claim on a zero balance IF... should not give them your money here
        assert!(add_insurance_fund_stake(
            amount,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0
        )
        .is_err());

        if_balance = 1;
        add_insurance_fund_stake(
            amount,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();

        assert_eq!(if_stake.if_shares, amount as u128);
        if_balance = if_balance + amount;
        assert_eq!(if_balance, 100000384940);

        // gains
        if_balance = if_balance + (amount / 13 - 1);

        assert_eq!(if_balance, 107692722242);

        let n_shares = if_stake.if_shares;
        let expected_amount_returned =
            (if_balance as u128 * n_shares / bank.total_if_shares) as u64;

        let o = unstaked_shares_to_amount(n_shares, bank.total_if_shares, if_balance).unwrap();
        request_remove_insurance_fund_stake(
            n_shares,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            now,
        )
        .unwrap();
        let value_at_req = if_stake.last_withdraw_request_value;
        assert_eq!(value_at_req, 107692722239);
        assert_eq!(o, 107692722239);

        // not enough time for withdraw
        assert!(remove_insurance_fund_stake(
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            now + 60 * 60 * 24,
        )
        .is_err());

        // more gains
        if_balance = if_balance + if_balance / 412;

        let ideal_amount_returned = (if_balance as u128 * n_shares / bank.total_if_shares) as u64;

        // appropriate time for withdraw
        let amount_returned = (remove_insurance_fund_stake(
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            now + 60 * 60 * 24 * 7 + 3254,
        ))
        .unwrap();
        assert_eq!(if_stake.last_withdraw_request_shares, 0);
        assert_eq!(if_stake.last_withdraw_request_value, 0);

        if_balance = if_balance - amount_returned;

        assert_eq!(amount_returned < ideal_amount_returned, true);
        assert_eq!(ideal_amount_returned - amount_returned, 261390103);
        assert_eq!(amount_returned, value_at_req);

        // since gains occured, not passed on to user after request
        assert_eq!(amount_returned, (expected_amount_returned - 1));
        assert_eq!(if_stake.if_shares, 0);
        assert_eq!(if_balance, 261_390_105); //$261 for protocol/other stakers
    }

    #[test]
    pub fn drained_stake_if_test_rebase_on_new_add() {
        let mut if_balance = 0;
        let mut if_stake = InsuranceFundStake {
            if_shares: 0,
            ..InsuranceFundStake::default()
        };
        let mut user_stats = UserStats {
            number_of_users: 0,
            ..UserStats::default()
        };
        let amount = 100_000_384_939 as u64; // $100k + change

        let mut orig_if_stake = InsuranceFundStake {
            if_shares: 80_000 * QUOTE_PRECISION,
            ..InsuranceFundStake::default()
        };
        let mut orig_user_stats = UserStats {
            number_of_users: 0,
            quote_asset_insurance_fund_stake: 80_000 * QUOTE_PRECISION,
            ..UserStats::default()
        };

        let mut bank = Bank {
            deposit_balance: 0,
            cumulative_deposit_interest: 1111 * BANK_CUMULATIVE_INTEREST_PRECISION / 1000,
            insurance_withdraw_escrow_period: 60 * 60 * 24 * 7, // 7 weeks
            total_if_shares: 100_000 * QUOTE_PRECISION,
            user_if_shares: 80_000 * QUOTE_PRECISION,
            ..Bank::default()
        };

        assert_eq!(if_balance, 0);

        // right now other users have claim on a zero balance IF... should not give them your money here
        assert!(add_insurance_fund_stake(
            amount,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .is_err());

        assert_eq!(if_stake.if_shares, 0);
        assert_eq!(bank.total_if_shares, 100_000_000_000);
        assert_eq!(bank.user_if_shares, 80_000 * QUOTE_PRECISION);

        // make non-zero
        if_balance = 1;
        add_insurance_fund_stake(
            amount,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();
        if_balance = if_balance + amount;

        // check rebase math
        assert_eq!(bank.total_if_shares, 1000003849400);
        assert_eq!(bank.user_if_shares, 1000003849398);
        assert_eq!(if_stake.if_shares, 1000003849390);
        assert_eq!(if_stake.if_shares < bank.user_if_shares, true);
        assert_eq!(bank.user_if_shares - if_stake.if_shares, 8);

        assert_eq!(bank.if_shares_base, 10);
        assert_eq!(if_stake.if_base, 10);

        // check orig if stake is good (on add)
        assert_eq!(orig_if_stake.if_base, 0);
        assert_eq!(orig_if_stake.if_shares, 80000000000);

        let expected_shares_for_amount =
            staked_amount_to_shares(1, bank.total_if_shares, if_balance).unwrap();
        assert_eq!(expected_shares_for_amount, 10);

        add_insurance_fund_stake(
            1,
            if_balance,
            &mut orig_if_stake,
            &mut orig_user_stats,
            &mut bank,
            0,
        )
        .unwrap();

        assert_eq!(bank.if_shares_base, 10);
        assert_eq!(orig_if_stake.if_base, 10);
        assert_eq!(
            orig_if_stake.if_shares,
            80000000000 / 10000000000 + expected_shares_for_amount
        );
        assert_eq!(orig_if_stake.if_shares, 8 + expected_shares_for_amount);
    }

    #[test]
    pub fn drained_stake_if_test_rebase_on_old_remove_all() {
        let mut if_balance = 0;
        let mut if_stake = InsuranceFundStake {
            if_shares: 80_000 * QUOTE_PRECISION,
            ..InsuranceFundStake::default()
        };
        let mut user_stats = UserStats {
            number_of_users: 0,
            quote_asset_insurance_fund_stake: 80_000 * QUOTE_PRECISION,
            ..UserStats::default()
        };

        let mut bank = Bank {
            deposit_balance: 0,
            cumulative_deposit_interest: 1111 * BANK_CUMULATIVE_INTEREST_PRECISION / 1000,
            insurance_withdraw_escrow_period: 0,
            total_if_shares: 100_000 * QUOTE_PRECISION,
            user_if_shares: 80_000 * QUOTE_PRECISION,
            ..Bank::default()
        };

        assert_eq!(if_balance, 0);

        // right now other users have claim on a zero balance IF... should not give them your money here
        assert_eq!(bank.total_if_shares, 100_000_000_000);
        assert_eq!(bank.user_if_shares, 80_000 * QUOTE_PRECISION);

        request_remove_insurance_fund_stake(
            if_stake.if_shares,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();

        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();

        // check rebase math
        assert_eq!(amount_returned, 0);
        assert_eq!(bank.total_if_shares, 20000000000);
        assert_eq!(bank.user_if_shares, 0);

        // make non-zero
        if_balance = 1;
        //  add_insurance_fund_stake(
        //      1,
        //      if_balance,
        //      &mut if_stake,
        //      &mut user_stats,
        //      &mut bank,
        //      0
        //  )
        //  .unwrap();
        //  if_balance = if_balance + 1;

        //  assert_eq!(bank.if_shares_base, 9);
        //  assert_eq!(bank.total_if_shares, 40);
        //  assert_eq!(bank.user_if_shares, 20);

        add_insurance_fund_stake(
            10_000_000_000_000, // 10 mil
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();
        if_balance = if_balance + 10_000_000_000_000;

        assert_eq!(bank.if_shares_base, 9);
        assert_eq!(bank.total_if_shares, 200000000000020);
        assert_eq!(bank.user_if_shares, 200000000000000);
    }

    #[test]
    pub fn drained_stake_if_test_rebase_on_old_remove_all_2() {
        let mut if_balance = 0;
        let mut if_stake = InsuranceFundStake {
            if_shares: 80_000 * QUOTE_PRECISION,
            ..InsuranceFundStake::default()
        };
        let mut user_stats = UserStats {
            number_of_users: 0,
            quote_asset_insurance_fund_stake: 80_000 * QUOTE_PRECISION,
            ..UserStats::default()
        };

        let mut bank = Bank {
            deposit_balance: 0,
            cumulative_deposit_interest: 1111 * BANK_CUMULATIVE_INTEREST_PRECISION / 1000,
            insurance_withdraw_escrow_period: 0,
            total_if_shares: 100_930_021_053,
            user_if_shares: 83_021 * QUOTE_PRECISION + 135723,
            ..Bank::default()
        };

        assert_eq!(if_balance, 0);

        request_remove_insurance_fund_stake(
            if_stake.if_shares / 2,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();

        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();

        // check rebase math
        assert_eq!(amount_returned, 0);
        assert_eq!(bank.total_if_shares, 60930021053);
        assert_eq!(bank.user_if_shares, 43021135723);
        assert_eq!(bank.if_shares_base, 0);

        if_balance = QUOTE_PRECISION as u64;

        let unstake_amt = if_stake.if_shares / 2;
        assert_eq!(unstake_amt, 20000000000);
        assert_eq!(if_stake.last_withdraw_request_shares, 0);
        assert_eq!(if_stake.last_withdraw_request_value, 0);
        assert_eq!(if_stake.last_withdraw_request_ts, 0);

        request_remove_insurance_fund_stake(
            unstake_amt,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            10,
        )
        .unwrap();

        // rebase occurs in request
        assert_eq!(if_stake.last_withdraw_request_shares, unstake_amt / 1000);
        // (that rebase occurs when you pass in shares you wanna unstake) :/
        assert_eq!(if_stake.if_shares, 40000000);
        assert_eq!(if_stake.last_withdraw_request_value, 328244);
        assert_eq!(if_stake.last_withdraw_request_ts, 10);

        assert_eq!(bank.total_if_shares, 60930021);
        assert_eq!(bank.user_if_shares, 43021135);

        assert_eq!(bank.if_shares_base, 3);

        let expected_amount_for_shares =
            unstaked_shares_to_amount(if_stake.if_shares / 2, bank.total_if_shares, if_balance)
                .unwrap();
        assert_eq!(
            expected_amount_for_shares,
            if_stake.last_withdraw_request_value
        );

        let user_expected_amount_for_shares_before_double =
            unstaked_shares_to_amount(bank.user_if_shares, bank.total_if_shares, if_balance)
                .unwrap();

        let protocol_expected_amount_for_shares_before_double = unstaked_shares_to_amount(
            bank.total_if_shares - bank.user_if_shares,
            bank.total_if_shares,
            if_balance,
        )
        .unwrap();

        assert_eq!(user_expected_amount_for_shares_before_double, 706_073);
        assert_eq!(protocol_expected_amount_for_shares_before_double, 293_924);
        assert_eq!(
            user_expected_amount_for_shares_before_double
                + protocol_expected_amount_for_shares_before_double,
            if_balance - 3 // ok rounding
        );

        if_balance *= 2; // double the IF vault before withdraw

        let protocol_expected_amount_for_shares_after_double = unstaked_shares_to_amount(
            bank.total_if_shares - bank.user_if_shares,
            bank.total_if_shares,
            if_balance,
        )
        .unwrap();

        let user_expected_amount_for_shares_after_double =
            unstaked_shares_to_amount(bank.user_if_shares, bank.total_if_shares, if_balance)
                .unwrap();

        let amount_returned = (remove_insurance_fund_stake(
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            10,
        ))
        .unwrap();

        let protocol_expected_amount_for_shares_after_user_withdraw = unstaked_shares_to_amount(
            bank.total_if_shares - bank.user_if_shares,
            bank.total_if_shares,
            if_balance,
        )
        .unwrap();

        // check rebase math
        assert_eq!(if_stake.if_shares, 20000000);
        assert_eq!(if_stake.if_base, bank.if_shares_base);
        assert_eq!(if_stake.last_withdraw_request_shares, 0);
        assert_eq!(if_stake.last_withdraw_request_value, 0);

        assert_eq!(amount_returned, 328244);
        assert_eq!(bank.total_if_shares, 40930021);
        assert_eq!(bank.user_if_shares, 23021135);
        assert_eq!(bank.if_shares_base, 3);

        assert_eq!(
            protocol_expected_amount_for_shares_after_double - 1,
            protocol_expected_amount_for_shares_before_double * 2
        );
        assert_eq!(
            user_expected_amount_for_shares_after_double - 2,
            user_expected_amount_for_shares_before_double * 2
        );
        assert_eq!(
            user_expected_amount_for_shares_after_double
                + protocol_expected_amount_for_shares_after_double,
            if_balance - 3 // ok rounding
        );

        assert_eq!(
            protocol_expected_amount_for_shares_after_user_withdraw,
            875_096
        );
        assert_eq!(
            protocol_expected_amount_for_shares_after_user_withdraw
                > protocol_expected_amount_for_shares_after_double,
            true
        );

        add_insurance_fund_stake(
            10_000_000_000_000, // 10 mil
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
            0,
        )
        .unwrap();
        if_balance = if_balance + 10_000_000_000_000;

        assert_eq!(bank.total_if_shares, 204650145930021);
        assert_eq!(bank.user_if_shares, 204650128021135);
        assert_eq!(bank.if_shares_base, 3);
        assert_eq!(if_balance, 10000002000000);
    }
}
