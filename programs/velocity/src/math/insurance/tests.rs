use anchor_lang::prelude::Pubkey;

use crate::math::constants::{QUOTE_PRECISION, SPOT_CUMULATIVE_INTEREST_PRECISION};
use crate::math::helpers::log10;
use crate::math::insurance::*;
use crate::state::spot_market::InsuranceFund;

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
    let _amount = QUOTE_PRECISION as u64; // $1
    let mut spot_market = SpotMarket {
        deposit_balance: 0,
        cumulative_deposit_interest: 1111 * SPOT_CUMULATIVE_INTEREST_PRECISION / 1000,
        insurance_fund: InsuranceFund {
            unstaking_period: 0,
            total_shares: 1000 * QUOTE_PRECISION,
            user_shares: 1000 * QUOTE_PRECISION,
            ..InsuranceFund::default()
        },
        ..SpotMarket::default()
    };

    let mut if_stake = InsuranceFundStake::new(Pubkey::default(), 0, 0);
    if_stake
        .update_if_shares(100 * QUOTE_PRECISION, &spot_market)
        .unwrap();
    if_stake.last_withdraw_request_shares = 100 * QUOTE_PRECISION;
    if_stake.last_withdraw_request_value = ((100 * QUOTE_PRECISION) - 1) as u64;

    let if_balance = (1000 * QUOTE_PRECISION) as u64;

    // unchanged balance
    let lost_shares = calculate_if_shares_lost(&if_stake, &spot_market, if_balance).unwrap();
    assert_eq!(lost_shares, 2);

    let if_balance = if_balance + (100 * QUOTE_PRECISION) as u64;
    spot_market.insurance_fund.total_shares += 100 * QUOTE_PRECISION;
    spot_market.insurance_fund.user_shares += 100 * QUOTE_PRECISION;
    let lost_shares = calculate_if_shares_lost(&if_stake, &spot_market, if_balance).unwrap();
    assert_eq!(lost_shares, 2); // giving up $5 of gains

    let if_balance = if_balance - (100 * QUOTE_PRECISION) as u64;
    spot_market.insurance_fund.total_shares -= 100 * QUOTE_PRECISION;
    spot_market.insurance_fund.user_shares -= 100 * QUOTE_PRECISION;
    let lost_shares = calculate_if_shares_lost(&if_stake, &spot_market, if_balance).unwrap();
    assert_eq!(lost_shares, 2); // giving up $5 of gains

    // take back gain
    let if_balance = (1100 * QUOTE_PRECISION) as u64;
    let lost_shares = calculate_if_shares_lost(&if_stake, &spot_market, if_balance).unwrap();
    assert_eq!(lost_shares, 10_000_001); // giving up $10 of gains

    // doesnt matter if theres a loss
    if_stake.last_withdraw_request_value = (200 * QUOTE_PRECISION) as u64;
    let lost_shares = calculate_if_shares_lost(&if_stake, &spot_market, if_balance).unwrap();
    assert_eq!(lost_shares, 0);
    if_stake.last_withdraw_request_value = (100 * QUOTE_PRECISION - 1) as u64;

    // take back gain and total_if_shares alter w/o user alter
    let if_balance = (2100 * QUOTE_PRECISION) as u64;
    spot_market.insurance_fund.total_shares *= 2;
    let lost_shares = calculate_if_shares_lost(&if_stake, &spot_market, if_balance).unwrap();
    assert_eq!(lost_shares, 5_000_001); // giving up $5 of gains

    let if_balance = (2100 * QUOTE_PRECISION * 10) as u64;

    let expected_gain_if_no_loss = if_balance * 100 / 2000;
    assert_eq!(expected_gain_if_no_loss, 1_050_000_000);
    let lost_shares = calculate_if_shares_lost(&if_stake, &spot_market, if_balance).unwrap();
    assert_eq!(lost_shares, 90_909_092); // giving up $5 of gains
    assert_eq!(
        (9090908 * if_balance / ((spot_market.insurance_fund.total_shares - lost_shares) as u64))
            < if_stake.last_withdraw_request_value,
        true
    );
}
