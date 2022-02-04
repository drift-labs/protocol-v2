use crate::error::*;
use crate::math_error;
use anchor_spl::token::TokenAccount;
use solana_program::msg;

/// Calculates how much of withdrawal must come from collateral vault and how much comes from insurance vault
pub fn calculate_withdrawal_amounts(
    amount: u64,
    collateral_token_account: &TokenAccount,
    insurance_token_account: &TokenAccount,
) -> ClearingHouseResult<(u64, u64)> {
    Ok(if collateral_token_account.amount >= amount {
        (amount, 0)
    } else if insurance_token_account.amount
        > amount
            .checked_sub(collateral_token_account.amount)
            .ok_or_else(math_error!())?
    {
        (
            collateral_token_account.amount,
            amount
                .checked_sub(collateral_token_account.amount)
                .ok_or_else(math_error!())?,
        )
    } else {
        (
            collateral_token_account.amount,
            insurance_token_account.amount,
        )
    })
}
