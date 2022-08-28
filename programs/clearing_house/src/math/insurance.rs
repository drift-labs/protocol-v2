use crate::error::{ErrorCode, ClearingHouseResult};
use crate::math::helpers::get_proportion_u128;
use crate::validate;
use solana_program::msg;

use crate::math::casting::{cast_to_u128, cast_to_u32, cast_to_u64};
use crate::math_error;

pub fn staked_amount_to_shares(
    amount: u64,
    total_if_shares: u128,
    insurance_fund_vault_balance: u64,
) -> ClearingHouseResult<u128> {
    // relative to the entire pool + total amount minted
    let n_shares = if insurance_fund_vault_balance > 0 {
        // assumes total_if_shares != 0 for nice result for user
        get_proportion_u128(
            cast_to_u128(amount)?,
            total_if_shares,
            cast_to_u128(insurance_fund_vault_balance)?,
        )?
    } else {
        // assumes total_if_shares == 0 for nice result for user
        cast_to_u128(amount)?
    };

    Ok(n_shares)
}

pub fn unstaked_shares_to_amount(
    n_shares: u128,
    total_if_shares: u128,
    insurance_fund_vault_balance: u64,
) -> ClearingHouseResult<u64> {
    validate!(
        n_shares <= total_if_shares,
        ErrorCode::DefaultError,
        "n_shares({}) > total_if_shares({})",
        n_shares,
        total_if_shares
    )?;

    let amount = if total_if_shares > 0 {
        // subtract one on withdraws to avoid rounding in favor for user
        // either takes off one OR makes user proportional withdraw exact
        cast_to_u64(
            get_proportion_u128(
                n_shares,
                insurance_fund_vault_balance as u128,
                total_if_shares as u128,
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
        0
    } else if n == 10 {
        1
    } else {
        log10(n / 10) + 1
    }
}

pub fn calculate_rebase_info(
    total_if_shares: u128,
    insurance_fund_vault_balance: u64,
) -> ClearingHouseResult<(u32, u128)> {
    let rebase_divisor_full = total_if_shares
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
    use crate::math::constants::QUOTE_PRECISION;

    #[test]
    pub fn basic_stake_if_test() {
        let (expo_diff, rebase_div) = calculate_rebase_info(10000, 10000).unwrap();
        assert_eq!(rebase_div, 1);
        assert_eq!(expo_diff, 0);

        let (expo_diff, rebase_div) = calculate_rebase_info(20_000, 10000).unwrap();
        assert_eq!(rebase_div, 1);
        assert_eq!(expo_diff, 0);

        let (expo_diff, rebase_div) = calculate_rebase_info(60_078, 10000).unwrap();
        assert_eq!(rebase_div, 1);
        assert_eq!(expo_diff, 0);

        let (expo_diff, rebase_div) = calculate_rebase_info(60_078, 9999).unwrap();
        assert_eq!(rebase_div, 1);
        assert_eq!(expo_diff, 0);

        let (expo_diff, rebase_div) = calculate_rebase_info(60_078, 6008).unwrap();
        assert_eq!(rebase_div, 1);
        assert_eq!(expo_diff, 0);

        let (expo_diff, rebase_div) = calculate_rebase_info(60_078, 6007).unwrap();
        assert_eq!(rebase_div, 1);
        assert_eq!(expo_diff, 0);

        let (expo_diff, rebase_div) = calculate_rebase_info(60_078, 6006).unwrap();
        assert_eq!(rebase_div, 1);
        assert_eq!(expo_diff, 0);

        let (expo_diff, rebase_div) = calculate_rebase_info(60_078, 606).unwrap();
        assert_eq!(rebase_div, 1);
        assert_eq!(expo_diff, 0);

        let (expo_diff, rebase_div) = calculate_rebase_info(60_078, 600).unwrap();
        assert_eq!(rebase_div, 10);
        assert_eq!(expo_diff, 1);

        let (expo_diff, rebase_div) = calculate_rebase_info(60_078*QUOTE_PRECISION, ((600*QUOTE_PRECISION)+19234) as u64).unwrap();
        assert_eq!(rebase_div, 10);
        assert_eq!(expo_diff, 1);

        let (expo_diff, rebase_div) = calculate_rebase_info(60_078*QUOTE_PRECISION, ((601*QUOTE_PRECISION)+19234) as u64).unwrap();
        assert_eq!(rebase_div, 1);
        assert_eq!(expo_diff, 0);

        // $800M goes to 1e-6 of dollar
        let (expo_diff, rebase_div) = calculate_rebase_info(800_000_078*QUOTE_PRECISION, 
            (1) as u64
        ).unwrap();

        assert_eq!(rebase_div, 10000000000000);
        assert_eq!(expo_diff, 13);

        let (expo_diff, rebase_div) = calculate_rebase_info(99_999, 100).unwrap();
        assert_eq!(log10(100), 2);
        assert_eq!(99_999 / 10 / 100, 99);
        assert_eq!(rebase_div, 10);
        assert_eq!(expo_diff, 1);

        let (expo_diff, rebase_div) = calculate_rebase_info(100_000, 100).unwrap();
        assert_eq!(log10(100), 2);
        assert_eq!(100_000 / 10 / 100, 100);
        assert_eq!(rebase_div, 100);
        assert_eq!(expo_diff, 2);

        let (expo_diff, rebase_div) = calculate_rebase_info(100_001, 100).unwrap();
        assert_eq!(log10(100), 2);
        assert_eq!(100_001 / 10 / 100, 100);
        assert_eq!(rebase_div, 100);
        assert_eq!(expo_diff, 2);



        let (expo_diff, rebase_div) = calculate_rebase_info(1_242_418_900_000, 1).unwrap();

        assert_eq!(rebase_div, 100000000000);
        assert_eq!(expo_diff, 11);

        // todo?: does not rebase the other direction (perhaps unnecessary)
        let (expo_diff, rebase_div) = calculate_rebase_info(12412, 83295723895729080).unwrap();

        assert_eq!(rebase_div, 1);
        assert_eq!(expo_diff, 0);
    }
}
