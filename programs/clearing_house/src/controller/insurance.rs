use crate::error::ErrorCode;
use crate::validate;
use solana_program::msg;

use crate::error::ClearingHouseResult;
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
    // mint = relative to the entire pool + total amount minted
    // u128 so we can do multiply first without overflow
    // then div and recast back
    let amount_to_mint = if insurance_fund_vault_balance > 0 {
        ((amount as u128)
            .checked_mul(bank.total_lp_shares as u128)
            .ok_or_else(math_error!())?
            .checked_div(insurance_fund_vault_balance as u128)
            .ok_or_else(math_error!())?) as u64
    } else {
        amount as u64
    };

    let n_shares = amount_to_mint as u128;

    bank.total_lp_shares = bank
        .total_lp_shares
        .checked_add(n_shares)
        .ok_or_else(math_error!())?;

    bank.user_lp_shares = bank
        .user_lp_shares
        .checked_add(n_shares)
        .ok_or_else(math_error!())?;

    insurance_fund_stake.lp_shares = insurance_fund_stake
        .lp_shares
        .checked_add(n_shares)
        .ok_or_else(math_error!())?;

    if bank.bank_index == 0 {
        user_stats.bank_0_insurance_lp_shares = user_stats
            .bank_0_insurance_lp_shares
            .checked_add(n_shares)
            .ok_or_else(math_error!())?;
    }

    Ok(())
}

pub fn remove_insurance_fund_stake(
    insurance_fund_vault_balance: u64,
    insurance_fund_stake: &mut InsuranceFundStake,
    user_stats: &mut UserStats,
    bank: &mut Bank,
    now: i64,
) -> ClearingHouseResult<(u64, u8)> {
    let time_since_withdraw_request = now
        .checked_sub(insurance_fund_stake.last_withdraw_request_ts)
        .ok_or_else(math_error!())?;

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


    let insurance_fund_vault_authority_nonce;
    let amount: u64;

    amount = n_shares
        .checked_mul(insurance_fund_vault_balance as u128)
        .unwrap()
        .checked_div(bank.total_lp_shares as u128)
        .unwrap() as u64;

    insurance_fund_stake.lp_shares = insurance_fund_stake
        .lp_shares
        .checked_sub(n_shares)
        .ok_or_else(math_error!())?;

    if bank.bank_index == 0 {
        user_stats.bank_0_insurance_lp_shares = user_stats
            .bank_0_insurance_lp_shares
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

    insurance_fund_vault_authority_nonce = bank.insurance_fund_vault_authority_nonce;

    // reset insurance_fund_stake withdraw request info
    insurance_fund_stake.last_withdraw_request_shares = 0;
    insurance_fund_stake.last_withdraw_request_value = 0;
    insurance_fund_stake.last_withdraw_request_ts = now;

    Ok((amount, insurance_fund_vault_authority_nonce))
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::state::user::{UserStats};
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BANK_CUMULATIVE_INTEREST_PRECISION, MARK_PRICE_PRECISION,
        QUOTE_PRECISION,
    };

    #[test]
    pub fn stake_if_test() {

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


        add_insurance_fund_stake(amount, if_balance, &mut if_stake, &mut user_stats, &mut bank).unwrap();
        assert_eq!(if_stake.lp_shares, amount as u128);
        if_balance = if_balance + amount;

        // must request first
        assert!(remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0).is_err());
        assert_eq!(if_stake.lp_shares, amount as u128);

        if_stake.last_withdraw_request_shares = if_stake.lp_shares;
        let (amount_returned, _) = (remove_insurance_fund_stake(if_balance, &mut if_stake, &mut user_stats, &mut bank, 0)).unwrap();
        assert_eq!(amount_returned, amount);
        if_balance = if_balance - amount_returned;
    }
}
