use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::helpers::get_proportion_u128;
use crate::state::insurance_fund_stake::InsuranceFundStake;
use crate::state::spot_market::SpotMarket;

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

#[allow(clippy::comparison_chain)]
pub fn log10(n: u128) -> u128 {
    if n < 10 {
        0
    } else if n == 10 {
        1
    } else {
        log10(n / 10) + 1
    }
}

pub fn log10_iter(n: u128) -> u128 {
    let mut result = 0;
    let mut n_copy = n;

    while n_copy >= 10 {
        result += 1;
        n_copy /= 10;
    }

    result
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

    let expo_diff = cast_to_u32(log10_iter(rebase_divisor_full))?;
    let rebase_divisor = 10_u128.pow(expo_diff);

    Ok((expo_diff, rebase_divisor))
}

pub fn calculate_if_shares_lost(
    insurance_fund_stake: &InsuranceFundStake,
    spot_market: &SpotMarket,
    insurance_fund_vault_balance: u64,
) -> ClearingHouseResult<u128> {
    let n_shares = insurance_fund_stake.last_withdraw_request_shares;

    let amount = unstaked_shares_to_amount(
        n_shares,
        spot_market.total_if_shares,
        insurance_fund_vault_balance,
    )?;

    let if_shares_lost = if amount > insurance_fund_stake.last_withdraw_request_value {
        let new_n_shares = staked_amount_to_shares(
            insurance_fund_stake.last_withdraw_request_value,
            spot_market.total_if_shares - n_shares,
            insurance_fund_vault_balance - insurance_fund_stake.last_withdraw_request_value,
        )?;

        validate!(
            new_n_shares < n_shares,
            ErrorCode::DefaultError,
            "Issue calculating delta if_shares after canceling request {} < {}",
            new_n_shares,
            n_shares
        )?;

        n_shares
            .checked_sub(new_n_shares)
            .ok_or_else(math_error!())?
    } else {
        0
    };

    Ok(if_shares_lost)
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::math::constants::{QUOTE_PRECISION, SPOT_CUMULATIVE_INTEREST_PRECISION};

    #[test]
    pub fn log_test() {
        assert_eq!(log10_iter(0), 0);
        assert_eq!(log10(0), 0);

        assert_eq!(log10_iter(9), 0);
        assert_eq!(log10(9), 0);

        assert_eq!(log10(19), 1);
        assert_eq!(log10_iter(19), 1);

        assert_eq!(log10_iter(13432429), 7);

        assert_eq!(log10(100), 2);
        assert_eq!(log10_iter(100), 2);

        // no modify check
        let n = 1005325523;
        assert_eq!(log10_iter(n), 9);
        assert_eq!(log10_iter(n), 9);
        assert_eq!(log10(n), 9);
        assert_eq!(log10_iter(n), 9);
    }

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

        let (expo_diff, rebase_div) = calculate_rebase_info(
            60_078 * QUOTE_PRECISION,
            ((600 * QUOTE_PRECISION) + 19234) as u64,
        )
        .unwrap();
        assert_eq!(rebase_div, 10);
        assert_eq!(expo_diff, 1);

        let (expo_diff, rebase_div) = calculate_rebase_info(
            60_078 * QUOTE_PRECISION,
            ((601 * QUOTE_PRECISION) + 19234) as u64,
        )
        .unwrap();
        assert_eq!(rebase_div, 1);
        assert_eq!(expo_diff, 0);

        // $800M goes to 1e-6 of dollar
        let (expo_diff, rebase_div) =
            calculate_rebase_info(800_000_078 * QUOTE_PRECISION, 1_u64).unwrap();

        assert_eq!(rebase_div, 10000000000000);
        assert_eq!(expo_diff, 13);

        let (expo_diff, rebase_div) = calculate_rebase_info(99_999, 100).unwrap();
        assert_eq!(log10(100), 2);
        assert_eq!(log10_iter(100), 2);
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

    #[test]
    pub fn if_shares_lost_test() {
        let mut if_stake = InsuranceFundStake {
            if_shares: 100 * QUOTE_PRECISION,
            last_withdraw_request_shares: 100 * QUOTE_PRECISION,
            last_withdraw_request_value: ((100 * QUOTE_PRECISION) - 1) as u64, // round in

            ..InsuranceFundStake::default()
        };
        let _amount = QUOTE_PRECISION as u64; // $1
        let mut spot_market = SpotMarket {
            deposit_balance: 0,
            cumulative_deposit_interest: 1111 * SPOT_CUMULATIVE_INTEREST_PRECISION / 1000,
            insurance_withdraw_escrow_period: 0,
            total_if_shares: 1000 * QUOTE_PRECISION,
            user_if_shares: 1000 * QUOTE_PRECISION,
            ..SpotMarket::default()
        };

        let if_balance = (1000 * QUOTE_PRECISION) as u64;

        // unchanged balance
        let lost_shares = calculate_if_shares_lost(&if_stake, &spot_market, if_balance).unwrap();
        assert_eq!(lost_shares, 0);

        let if_balance = if_balance + (100 * QUOTE_PRECISION) as u64;
        spot_market.total_if_shares += 100 * QUOTE_PRECISION;
        spot_market.user_if_shares += 100 * QUOTE_PRECISION;
        let lost_shares = calculate_if_shares_lost(&if_stake, &spot_market, if_balance).unwrap();
        assert_eq!(lost_shares, 0); // giving up $5 of gains

        let if_balance = if_balance - (100 * QUOTE_PRECISION) as u64;
        spot_market.total_if_shares -= 100 * QUOTE_PRECISION;
        spot_market.user_if_shares -= 100 * QUOTE_PRECISION;
        let lost_shares = calculate_if_shares_lost(&if_stake, &spot_market, if_balance).unwrap();
        assert_eq!(lost_shares, 0); // giving up $5 of gains

        // take back gain
        let if_balance = (1100 * QUOTE_PRECISION) as u64;
        let lost_shares = calculate_if_shares_lost(&if_stake, &spot_market, if_balance).unwrap();
        assert_eq!(lost_shares, 10_000_000); // giving up $10 of gains

        // doesnt matter if theres a loss
        if_stake.last_withdraw_request_value = (200 * QUOTE_PRECISION) as u64;
        let lost_shares = calculate_if_shares_lost(&if_stake, &spot_market, if_balance).unwrap();
        assert_eq!(lost_shares, 0);
        if_stake.last_withdraw_request_value = (100 * QUOTE_PRECISION - 1) as u64;

        // take back gain and total_if_shares alter w/o user alter
        let if_balance = (2100 * QUOTE_PRECISION) as u64;
        spot_market.total_if_shares *= 2;
        let lost_shares = calculate_if_shares_lost(&if_stake, &spot_market, if_balance).unwrap();
        assert_eq!(lost_shares, 5_000_000); // giving up $5 of gains

        let if_balance = (2100 * QUOTE_PRECISION * 10) as u64;

        let expected_gain_if_no_loss = if_balance * 100 / 2000;
        assert_eq!(expected_gain_if_no_loss, 1_050_000_000);
        let lost_shares = calculate_if_shares_lost(&if_stake, &spot_market, if_balance).unwrap();
        assert_eq!(lost_shares, 90_909_092); // giving up $5 of gains
        assert_eq!(
            (9090908 * if_balance / ((spot_market.total_if_shares - lost_shares) as u64))
                < if_stake.last_withdraw_request_value,
            true
        );
    }
}
