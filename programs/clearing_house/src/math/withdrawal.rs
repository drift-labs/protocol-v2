use anchor_spl::token::TokenAccount;

pub fn calculate_withdrawal_amounts(
    amount: u64,
    collateral_token_account: &TokenAccount,
    insurance_token_account: &TokenAccount,
) -> (u64, u64) {
    return if collateral_token_account.amount >= amount {
        (amount, 0)
    } else if insurance_token_account.amount
        > amount.checked_sub(collateral_token_account.amount).unwrap()
    {
        (
            collateral_token_account.amount,
            amount.checked_sub(collateral_token_account.amount).unwrap(),
        )
    } else {
        (
            collateral_token_account.amount,
            insurance_token_account.amount,
        )
    };
}
