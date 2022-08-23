use crate::error::ClearingHouseResult;
use crate::math::casting::{cast_to_u128, cast_to_u64};
use crate::math::lp::get_proportion_u128;

pub fn staked_amount_to_shares(
    amount: u64,
    total_lp_shares: u128,
    insurance_fund_vault_balance: u64,
) -> ClearingHouseResult<u128> {
    // relative to the entire pool + total amount minted
    let n_shares = if insurance_fund_vault_balance > 0 {
        get_proportion_u128(
            cast_to_u128(amount)?,
            total_lp_shares,
            cast_to_u128(insurance_fund_vault_balance)?,
        )?
    } else {
        // assumes total_lp_shares == 0 for nice result for user
        cast_to_u128(amount)?
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
        cast_to_u64(
            get_proportion_u128(
                n_shares,
                insurance_fund_vault_balance as u128,
                total_lp_shares as u128,
            )?
            .saturating_sub(1),
        )?
    } else {
        0
    };

    Ok(amount)
}
