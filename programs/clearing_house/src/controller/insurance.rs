use solana_program::msg;

use crate::error::{ClearingHouseResult};
use crate::math_error;
use crate::state::bank::{Bank};
use crate::state::insurance_fund_stake::{InsuranceFundStake};
use crate::state::user::UserStats;


pub fn update_insurance_stake_balances(
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

    if bank.bank_index == 0 
    {
        user_stats.bank_0_insurance_lp_shares = user_stats
            .bank_0_insurance_lp_shares
            .checked_add(n_shares)
            .ok_or_else(math_error!())?;
    }

    Ok(())
}