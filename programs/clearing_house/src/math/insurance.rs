use crate::error::ClearingHouseResult;
use crate::math::lp::get_proportion_u128;
use crate::validate;
use solana_program::msg;

use crate::math_error;
use crate::state::bank::Bank;
use crate::math::casting::{cast_to_i128, cast_to_u128, cast_to_u32, cast_to_u64};
use crate::state::insurance_fund_stake::InsuranceFundStake;
use crate::state::user::UserStats;
use num_integer::Roots;

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

// #[feature(int_log)]
pub fn calculate_rebase_info(
    total_lp_shares: u128,
    insurance_fund_vault_balance: u64,
) -> ClearingHouseResult<(u32, u128)> {
    let rebase_divisor_full = total_lp_shares
        .checked_div(10)
        .ok_or_else(math_error!())?
        .checked_div(cast_to_u128(insurance_fund_vault_balance)?)
        .ok_or_else(math_error!())?;

    //todo
    // let expo_diff = cast_to_i128(rebase_divisor_full)?.checked_log10().ok_or_else(math_error!())?;
    let expo_diff = 0;
    let rebase_divisor = 10_u128.pow(cast_to_u32(expo_diff)?);

    Ok((expo_diff, rebase_divisor_full))
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::math::constants::{BANK_CUMULATIVE_INTEREST_PRECISION, QUOTE_PRECISION};
    use crate::state::user::UserStats;

    #[test]
    pub fn basic_stake_if_test() {

        let (expo_diff, rebase_div) = calculate_rebase_info(100_000, 100).unwrap();

        assert_eq!(100_000/10/100, 100);
        assert_eq!(rebase_div, 100);
        // assert_eq!(expo_diff, 2);




    }
}