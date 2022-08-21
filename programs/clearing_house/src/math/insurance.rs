// use crate::error::ErrorCode;
// use crate::validate;
use solana_program::msg;

use crate::error::ClearingHouseResult;
use crate::math_error;

pub fn staked_amount_to_shares(
    amount: u64,
    total_lp_shares: u128,
    insurance_fund_vault_balance: u64,
) -> ClearingHouseResult<u64> {
    let n_shares = if insurance_fund_vault_balance > 0 {
        ((amount as u128)
            .checked_mul(total_lp_shares as u128)
            .ok_or_else(math_error!())?
            .checked_div(insurance_fund_vault_balance as u128)
            .ok_or_else(math_error!())?) as u64
    } else {
        amount as u64
    };

    Ok(n_shares)
}

pub fn unstaked_shares_to_amount(
    n_shares: u128,
    total_lp_shares: u128,
    insurance_fund_vault_balance: u64,
) -> ClearingHouseResult<u64> {
    assert!(n_shares <= total_lp_shares);

    let amount = if total_lp_shares > 0 {
        n_shares
            .checked_mul(insurance_fund_vault_balance as u128)
            .unwrap()
            .checked_div(total_lp_shares as u128)
            .unwrap()
            .saturating_sub(1) as u64
    } else {
        0
    };

    Ok(amount)
}
