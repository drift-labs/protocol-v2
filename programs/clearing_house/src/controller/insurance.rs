use crate::error::ErrorCode;
use crate::math::casting::{cast_to_i128, cast_to_u128, cast_to_u32};
use crate::validate;
use solana_program::msg;

use crate::error::ClearingHouseResult;
use crate::math::insurance::{
    calculate_rebase_info, staked_amount_to_shares, unstaked_shares_to_amount,
};
use crate::math_error;
use crate::state::bank::Bank;
use crate::state::insurance_fund_stake::InsuranceFundStake;
use crate::state::user::UserStats;

pub fn add_insurance_fund_stake(
    amount: u64,
    insurance_fund_vault_balance: u64,
    insurance_fund_stake: &mut InsuranceFundStake,
    user_stats: &mut UserStats,
    bank: &mut Bank,
) -> ClearingHouseResult {
    validate!(
        !(insurance_fund_vault_balance == 0 && bank.total_lp_shares != 0),
        ErrorCode::DefaultError,
        "Insurance Fund balance should be non-zero for new LPs to enter"
    )?;

    apply_rebase_to_insurance_fund(insurance_fund_vault_balance, bank)?;
    apply_rebase_to_insurance_fund_stake(insurance_fund_stake, user_stats, bank)?;

    let n_shares =
        staked_amount_to_shares(amount, bank.total_lp_shares, insurance_fund_vault_balance)?;

    // reset cost basis if no shares
    insurance_fund_stake.cost_basis = if insurance_fund_stake.lp_shares == 0 {
        cast_to_i128(amount)?
    } else {
        insurance_fund_stake
            .cost_basis
            .checked_add(cast_to_i128(amount)?)
            .ok_or_else(math_error!())?
    };

    insurance_fund_stake.lp_shares = insurance_fund_stake
        .lp_shares
        .checked_add(n_shares)
        .ok_or_else(math_error!())?;

    bank.total_lp_shares = bank
        .total_lp_shares
        .checked_add(n_shares)
        .ok_or_else(math_error!())?;

    bank.user_lp_shares = bank
        .user_lp_shares
        .checked_add(n_shares)
        .ok_or_else(math_error!())?;

    if bank.bank_index == 0 {
        user_stats.quote_asset_insurance_fund_stake = user_stats
            .quote_asset_insurance_fund_stake
            .checked_add(n_shares)
            .ok_or_else(math_error!())?;
    }

    Ok(())
}

pub fn apply_rebase_to_insurance_fund(
    insurance_fund_vault_balance: u64,
    bank: &mut Bank,
) -> ClearingHouseResult {
    if insurance_fund_vault_balance != 0
        && cast_to_u128(insurance_fund_vault_balance)? < bank.total_lp_shares
    {
        let (expo_diff, rebase_divisor) =
            calculate_rebase_info(bank.total_lp_shares, insurance_fund_vault_balance)?;

        bank.total_lp_shares = bank.total_lp_shares / rebase_divisor;
        bank.user_lp_shares = bank.user_lp_shares / rebase_divisor;

        bank.lp_shares_expo = bank.lp_shares_expo + expo_diff as u128;
    }

    Ok(())
}

pub fn apply_rebase_to_insurance_fund_stake(
    insurance_fund_stake: &mut InsuranceFundStake,
    user_stats: &mut UserStats,
    bank: &mut Bank,
) -> ClearingHouseResult {
    if bank.lp_shares_expo != insurance_fund_stake.expo {
        validate!(
            bank.lp_shares_expo > insurance_fund_stake.expo,
            ErrorCode::DefaultError,
            "Rebase expo out of bounds"
        )?;

        let expo_diff = cast_to_u32(bank.lp_shares_expo - insurance_fund_stake.expo)?;

        let rebase_divisor = 10_u128.pow(expo_diff);

        insurance_fund_stake.lp_shares = insurance_fund_stake.lp_shares / rebase_divisor;
        insurance_fund_stake.last_withdraw_request_shares =
            insurance_fund_stake.last_withdraw_request_shares / rebase_divisor;

        if bank.bank_index == 0 {
            user_stats.quote_asset_insurance_fund_stake =
                user_stats.quote_asset_insurance_fund_stake / rebase_divisor;
        }

        insurance_fund_stake.expo = bank.lp_shares_expo;
    }

    Ok(())
}

pub fn request_remove_insurance_fund_stake(
    n_shares: u128,
    insurance_fund_vault_balance: u64,
    insurance_fund_stake: &mut InsuranceFundStake,
    bank: &Bank,
    now: i64,
) -> ClearingHouseResult {
    insurance_fund_stake.last_withdraw_request_shares = n_shares;
    insurance_fund_stake.last_withdraw_request_value =
        unstaked_shares_to_amount(n_shares, bank.total_lp_shares, insurance_fund_vault_balance)?;

    validate!(
        insurance_fund_stake.last_withdraw_request_value == 0
            || insurance_fund_stake.last_withdraw_request_value < insurance_fund_vault_balance,
        ErrorCode::DefaultError,
        "Requested withdraw value is not below Insurance Fund balance"
    )?;

    insurance_fund_stake.last_withdraw_request_ts = now;

    Ok(())
}

pub fn remove_insurance_fund_stake(
    insurance_fund_vault_balance: u64,
    insurance_fund_stake: &mut InsuranceFundStake,
    user_stats: &mut UserStats,
    bank: &mut Bank,
    now: i64,
) -> ClearingHouseResult<u64> {
    let time_since_withdraw_request = now
        .checked_sub(insurance_fund_stake.last_withdraw_request_ts)
        .ok_or_else(math_error!())?;

    apply_rebase_to_insurance_fund(insurance_fund_vault_balance, bank)?;
    apply_rebase_to_insurance_fund_stake(insurance_fund_stake, user_stats, bank)?;

    let n_shares = insurance_fund_stake.last_withdraw_request_shares;

    validate!(
        n_shares > 0,
        ErrorCode::DefaultError,
        "Must submit withdraw request and wait the escrow period"
    )?;

    validate!(
        insurance_fund_stake.lp_shares >= n_shares,
        ErrorCode::InsufficientLPTokens
    )?;

    validate!(
        time_since_withdraw_request >= bank.insurance_withdraw_escrow_period,
        ErrorCode::TryingToRemoveLiquidityTooFast
    )?;

    let amount =
        unstaked_shares_to_amount(n_shares, bank.total_lp_shares, insurance_fund_vault_balance)?;
    let withdraw_amount = amount.min(insurance_fund_stake.last_withdraw_request_value);

    insurance_fund_stake.lp_shares = insurance_fund_stake
        .lp_shares
        .checked_sub(n_shares)
        .ok_or_else(math_error!())?;

    insurance_fund_stake.cost_basis = insurance_fund_stake
        .cost_basis
        .checked_sub(withdraw_amount as i128)
        .ok_or_else(math_error!())?;

    if bank.bank_index == 0 {
        user_stats.quote_asset_insurance_fund_stake = user_stats
            .quote_asset_insurance_fund_stake
            .checked_sub(n_shares)
            .ok_or_else(math_error!())?;
    }

    bank.total_lp_shares = bank
        .total_lp_shares
        .checked_sub(n_shares)
        .ok_or_else(math_error!())?;

    bank.user_lp_shares = bank
        .user_lp_shares
        .checked_sub(n_shares)
        .ok_or_else(math_error!())?;

    // reset insurance_fund_stake withdraw request info
    insurance_fund_stake.last_withdraw_request_shares = 0;
    insurance_fund_stake.last_withdraw_request_value = 0;
    insurance_fund_stake.last_withdraw_request_ts = now;

    Ok(withdraw_amount)
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
            lp_shares: 0,
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
        )
        .unwrap();
        assert_eq!(if_stake.lp_shares, amount as u128);
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
        assert_eq!(if_stake.lp_shares, amount as u128);

        request_remove_insurance_fund_stake(
            if_stake.lp_shares,
            if_balance,
            &mut if_stake,
            &bank,
            0,
        )
        .unwrap();
        assert_eq!(if_stake.last_withdraw_request_shares, if_stake.lp_shares);
        assert_eq!(if_stake.last_withdraw_request_value, if_balance - 1); //rounding in favor

        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();
        assert_eq!(amount_returned, amount - 1);
        if_balance = if_balance - amount_returned;

        assert_eq!(if_stake.lp_shares, 0);
        assert_eq!(if_stake.cost_basis, 1);
        assert_eq!(if_stake.last_withdraw_request_shares, 0);
        assert_eq!(if_stake.last_withdraw_request_value, 0);
        assert_eq!(if_balance, 1);

        add_insurance_fund_stake(1234, if_balance, &mut if_stake, &mut user_stats, &mut bank)
            .unwrap();
        assert_eq!(if_stake.cost_basis, 1234);
    }

    #[test]
    pub fn gains_stake_if_test() {
        let mut if_balance = 0;
        let mut if_stake = InsuranceFundStake {
            lp_shares: 0,
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
        )
        .unwrap();
        assert_eq!(if_stake.lp_shares, amount as u128);
        if_balance = if_balance + amount;

        // gains
        if_balance = if_balance + amount / 19;

        let n_shares = if_stake.lp_shares;
        let expected_amount_returned = (amount + amount / 19) / 3 - 1;

        request_remove_insurance_fund_stake(n_shares / 3, if_balance, &mut if_stake, &bank, 0)
            .unwrap();
        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();
        assert_eq!(amount_returned, expected_amount_returned - 1);
        assert_eq!(if_stake.lp_shares, n_shares * 2 / 3 + 1);
        if_balance = if_balance - amount_returned;

        request_remove_insurance_fund_stake(n_shares / 3, if_balance, &mut if_stake, &bank, 0)
            .unwrap();
        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();
        assert_eq!(if_stake.lp_shares, n_shares / 3 + 1);
        assert_eq!(amount_returned, expected_amount_returned);
        if_balance = if_balance - amount_returned;

        request_remove_insurance_fund_stake(1, if_balance, &mut if_stake, &bank, 0).unwrap();

        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();
        assert_eq!(amount_returned, 0);

        request_remove_insurance_fund_stake(n_shares / 3 - 1, if_balance, &mut if_stake, &bank, 0)
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
            lp_shares: 0,
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
        )
        .unwrap();
        assert_eq!(if_stake.lp_shares, amount as u128);
        if_balance = if_balance + amount;

        // gains
        if_balance = if_balance - amount / 19;

        let n_shares = if_stake.lp_shares;
        let expected_amount_returned = (amount - amount / 19) / 3;

        request_remove_insurance_fund_stake(n_shares / 3, if_balance, &mut if_stake, &bank, 0)
            .unwrap();

        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();
        assert_eq!(amount_returned, expected_amount_returned - 1);
        assert_eq!(if_stake.lp_shares, n_shares * 2 / 3 + 1);
        if_balance = if_balance - amount_returned;

        request_remove_insurance_fund_stake(n_shares / 3, if_balance, &mut if_stake, &bank, 0)
            .unwrap();
        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();
        assert_eq!(if_stake.lp_shares, n_shares / 3 + 1);
        assert_eq!(amount_returned, expected_amount_returned);
        if_balance = if_balance - amount_returned;

        request_remove_insurance_fund_stake(1, if_balance, &mut if_stake, &bank, 0).unwrap();

        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();
        assert_eq!(if_stake.lp_shares, n_shares * 1 / 3);
        assert_eq!(amount_returned, 0);

        request_remove_insurance_fund_stake(n_shares / 3, if_balance, &mut if_stake, &bank, 0)
            .unwrap();
        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();
        assert_eq!(amount_returned, expected_amount_returned + 2);
        assert_eq!(if_stake.cost_basis, 52632);
        assert_eq!(if_stake.lp_shares, 0);

        if_balance = if_balance - amount_returned;

        assert_eq!(if_balance, 1); // todo, should be stricer w/ rounding?
    }

    #[test]
    pub fn escrow_losses_stake_if_test() {
        let mut if_balance = 0;
        let mut if_stake = InsuranceFundStake {
            lp_shares: 0,
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
        )
        .unwrap();
        assert_eq!(if_stake.lp_shares, amount as u128);
        if_balance = if_balance + amount;

        // losses
        if_balance = if_balance - amount / 19;

        let n_shares = if_stake.lp_shares;
        let expected_amount_returned = (amount - amount / 19) / 3;

        request_remove_insurance_fund_stake(n_shares / 3, if_balance, &mut if_stake, &bank, now)
            .unwrap();

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
        assert_eq!(if_stake.lp_shares, n_shares * 2 / 3 + 1);
        assert_eq!(if_stake.cost_basis, 84_210_526_317); //84k
        assert_eq!(if_balance, 31_578_947_370); //31k
    }

    #[test]
    pub fn escrow_gains_stake_if_test() {
        let mut if_balance = 0;
        let mut if_stake = InsuranceFundStake {
            lp_shares: 0,
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
            total_lp_shares: 1,
            user_lp_shares: 0,
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
        )
        .is_err());

        if_balance = 1;
        add_insurance_fund_stake(
            amount,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
        )
        .unwrap();

        assert_eq!(if_stake.lp_shares, amount as u128);
        if_balance = if_balance + amount;
        assert_eq!(if_balance, 100000384940);

        // gains
        if_balance = if_balance + (amount / 13 - 1);

        assert_eq!(if_balance, 107692722242);

        let n_shares = if_stake.lp_shares;
        let expected_amount_returned =
            (if_balance as u128 * n_shares / bank.total_lp_shares) as u64;

        request_remove_insurance_fund_stake(n_shares, if_balance, &mut if_stake, &bank, now)
            .unwrap();
        let value_at_req = if_stake.last_withdraw_request_value;
        assert_eq!(value_at_req, 107692722239);

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

        let ideal_amount_returned = (if_balance as u128 * n_shares / bank.total_lp_shares) as u64;

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
        assert_eq!(if_stake.lp_shares, 0);
        assert_eq!(if_balance, 261_390_105); //$261 for protocol/other stakers
    }

    #[test]
    pub fn drained_stake_if_test_rebase_on_new_add() {
        let mut if_balance = 0;
        let mut if_stake = InsuranceFundStake {
            lp_shares: 0,
            ..InsuranceFundStake::default()
        };
        let mut user_stats = UserStats {
            number_of_users: 0,
            ..UserStats::default()
        };
        let amount = 100_000_384_939 as u64; // $100k + change

        let mut orig_if_stake = InsuranceFundStake {
            lp_shares: 80_000 * QUOTE_PRECISION,
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
            total_lp_shares: 100_000 * QUOTE_PRECISION,
            user_lp_shares: 80_000 * QUOTE_PRECISION,
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
        )
        .is_err());

        assert_eq!(if_stake.lp_shares, 0);
        assert_eq!(bank.total_lp_shares, 100_000_000_000);
        assert_eq!(bank.user_lp_shares, 80_000 * QUOTE_PRECISION);

        // make non-zero
        if_balance = 1;
        add_insurance_fund_stake(
            amount,
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
        )
        .unwrap();
        if_balance = if_balance + amount;

        // check rebase math
        assert_eq!(bank.total_lp_shares, 1000003849400);
        assert_eq!(bank.user_lp_shares, 1000003849398);
        assert_eq!(if_stake.lp_shares, 1000003849390);
        assert_eq!(if_stake.lp_shares < bank.user_lp_shares, true);
        assert_eq!(bank.user_lp_shares - if_stake.lp_shares, 8);

        assert_eq!(bank.lp_shares_expo, 10);
        assert_eq!(if_stake.expo, 10);

        // check orig if stake is good (on add)
        assert_eq!(orig_if_stake.expo, 0);
        assert_eq!(orig_if_stake.lp_shares, 80000000000);

        let expected_shares_for_amount =
            staked_amount_to_shares(1, bank.total_lp_shares, if_balance).unwrap();
        assert_eq!(expected_shares_for_amount, 10);

        add_insurance_fund_stake(
            1,
            if_balance,
            &mut orig_if_stake,
            &mut orig_user_stats,
            &mut bank,
        )
        .unwrap();

        assert_eq!(bank.lp_shares_expo, 10);
        assert_eq!(orig_if_stake.expo, 10);
        assert_eq!(
            orig_if_stake.lp_shares,
            80000000000 / 10000000000 + expected_shares_for_amount
        );
        assert_eq!(orig_if_stake.lp_shares, 8 + expected_shares_for_amount);
    }

    #[test]
    pub fn drained_stake_if_test_rebase_on_old_remove_all() {
        let mut if_balance = 0;
        let mut if_stake = InsuranceFundStake {
            lp_shares: 80_000 * QUOTE_PRECISION,
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
            total_lp_shares: 100_000 * QUOTE_PRECISION,
            user_lp_shares: 80_000 * QUOTE_PRECISION,
            ..Bank::default()
        };

        assert_eq!(if_balance, 0);

        // right now other users have claim on a zero balance IF... should not give them your money here
        assert_eq!(bank.total_lp_shares, 100_000_000_000);
        assert_eq!(bank.user_lp_shares, 80_000 * QUOTE_PRECISION);

        request_remove_insurance_fund_stake(
            if_stake.lp_shares,
            if_balance,
            &mut if_stake,
            &bank,
            0,
        )
        .unwrap();

        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();

        // check rebase math
        assert_eq!(amount_returned, 0);
        assert_eq!(bank.total_lp_shares, 20000000000);
        assert_eq!(bank.user_lp_shares, 0);

        // make non-zero
        if_balance = 1;
        //  add_insurance_fund_stake(
        //      1,
        //      if_balance,
        //      &mut if_stake,
        //      &mut user_stats,
        //      &mut bank,
        //  )
        //  .unwrap();
        //  if_balance = if_balance + 1;

        //  assert_eq!(bank.lp_shares_expo, 9);
        //  assert_eq!(bank.total_lp_shares, 40);
        //  assert_eq!(bank.user_lp_shares, 20);

        add_insurance_fund_stake(
            10_000_000_000_000, // 10 mil
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
        )
        .unwrap();
        if_balance = if_balance + 10_000_000_000_000;

        assert_eq!(bank.lp_shares_expo, 9);
        assert_eq!(bank.total_lp_shares, 200000000000020);
        assert_eq!(bank.user_lp_shares, 200000000000000);
    }

    #[test]
    pub fn drained_stake_if_test_rebase_on_old_remove_all_2() {
        let mut if_balance = 0;
        let mut if_stake = InsuranceFundStake {
            lp_shares: 80_000 * QUOTE_PRECISION,
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
            total_lp_shares: 100_930_021_053,
            user_lp_shares: 83_021 * QUOTE_PRECISION + 135723,
            ..Bank::default()
        };

        assert_eq!(if_balance, 0);

        request_remove_insurance_fund_stake(
            if_stake.lp_shares / 2,
            if_balance,
            &mut if_stake,
            &bank,
            0,
        )
        .unwrap();

        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();

        // check rebase math
        assert_eq!(amount_returned, 0);
        assert_eq!(bank.total_lp_shares, 60930021053);
        assert_eq!(bank.user_lp_shares, 43021135723);
        assert_eq!(bank.lp_shares_expo, 0);

        if_balance = QUOTE_PRECISION as u64;
        request_remove_insurance_fund_stake(
            if_stake.lp_shares / 2,
            if_balance,
            &mut if_stake,
            &bank,
            0,
        )
        .unwrap();

        let expected_amount_for_shares =
            unstaked_shares_to_amount(if_stake.lp_shares / 2, bank.total_lp_shares, if_balance)
                .unwrap();
        assert_eq!(expected_amount_for_shares, 328244);

        let amount_returned =
            (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0))
                .unwrap();

        // check rebase math
        assert_eq!(amount_returned, 328244);
        assert_eq!(bank.total_lp_shares, 40930021);
        assert_eq!(bank.user_lp_shares, 23021135);
        assert_eq!(bank.lp_shares_expo, 3);

        add_insurance_fund_stake(
            10_000_000_000_000, // 10 mil
            if_balance,
            &mut if_stake,
            &mut user_stats,
            &mut bank,
        )
        .unwrap();
        if_balance = if_balance + 10_000_000_000_000;

        assert_eq!(bank.total_lp_shares, 409300250930021);
        assert_eq!(bank.user_lp_shares, 409300233021135);
        assert_eq!(bank.lp_shares_expo, 3);
        assert_eq!(if_balance, 10000001000000);
    }
}
