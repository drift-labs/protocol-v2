use crate::error::ClearingHouseResult;
use crate::math::lp::get_proportion_u128;
use solana_program::msg;

use crate::math::casting::{cast_to_u128, cast_to_u32, cast_to_u64};
use crate::math_error;

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

pub fn log10(n: u128) -> u128 {
    if n < 10 {
        return 0;
    } else if n == 10 {
        return 1;
    } else {
        return log10(n / 10) + 1;
    }
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
    let expo_diff = cast_to_u32(log10(rebase_divisor_full))?;
    let rebase_divisor = 10_u128.pow(expo_diff);

    Ok((expo_diff, rebase_divisor))
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::math::constants::{BANK_CUMULATIVE_INTEREST_PRECISION, QUOTE_PRECISION};
    use crate::state::user::UserStats;

    #[test]
    pub fn basic_stake_if_test() {
        let (expo_diff, rebase_div) = calculate_rebase_info(10000, 10000).unwrap();
        assert_eq!(rebase_div, 1);
        assert_eq!(expo_diff, 0);

        let (expo_diff, rebase_div) = calculate_rebase_info(100_000, 100).unwrap();
        assert_eq!(log10(100), 2);
        assert_eq!(100_000 / 10 / 100, 100);
        assert_eq!(rebase_div, 100);
        assert_eq!(expo_diff, 2);

        let (expo_diff, rebase_div) = calculate_rebase_info(1_242_418_900_000, 1).unwrap();

        assert_eq!(rebase_div, 100000000000);
        assert_eq!(expo_diff, 11);

        // todo?
        let (expo_diff, rebase_div) = calculate_rebase_info(12412, 83295723895729080).unwrap();

        assert_eq!(rebase_div, 1);
        assert_eq!(expo_diff, 0);
    }
}
