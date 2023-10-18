use anchor_lang::prelude::Pubkey;

use crate::controller::insurance::*;
use crate::math::constants::{
    QUOTE_PRECISION, SPOT_BALANCE_PRECISION, SPOT_CUMULATIVE_INTEREST_PRECISION,
};
use crate::state::perp_market::PoolBalance;
use crate::state::spot_market::InsuranceFund;
use crate::state::user::UserStats;
#[test]
pub fn basic_stake_if_test() {
    assert_eq!(0_i32.signum(), 0);
    assert_eq!(1_i32.signum(), 1);
    assert_eq!(-1_i32.signum(), -1);

    assert_eq!(0_i128.signum(), 0);
    assert_eq!(1_i128.signum(), 1);

    let mut if_balance = 0;

    let mut if_stake = InsuranceFundStake::new(Pubkey::default(), 0, 0);
    let mut user_stats = UserStats {
        number_of_sub_accounts: 0,
        ..UserStats::default()
    };
    let amount = QUOTE_PRECISION as u64; // $1
    let mut spot_market = SpotMarket {
        deposit_balance: 0,
        cumulative_deposit_interest: 1111 * SPOT_CUMULATIVE_INTEREST_PRECISION / 1000,
        insurance_fund: InsuranceFund {
            unstaking_period: 0,
            ..InsuranceFund::default()
        },
        ..SpotMarket::default()
    };

    add_insurance_fund_stake(
        amount,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();
    assert_eq!(if_stake.unchecked_if_shares(), amount as u128);
    if_balance += amount;

    // must request first
    assert!(remove_insurance_fund_stake(
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0
    )
    .is_err());

    assert_eq!(if_stake.unchecked_if_shares(), amount as u128);
    assert_eq!(spot_market.insurance_fund.total_shares, amount as u128);
    assert_eq!(spot_market.insurance_fund.shares_base, 0);

    request_remove_insurance_fund_stake(
        if_stake.unchecked_if_shares(),
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();
    assert_eq!(
        if_stake.last_withdraw_request_shares,
        if_stake.unchecked_if_shares()
    );
    assert_eq!(if_stake.last_withdraw_request_value, if_balance - 1); //rounding in favor
    assert_eq!(if_stake.unchecked_if_shares(), amount as u128);
    assert_eq!(spot_market.insurance_fund.total_shares, amount as u128);
    assert_eq!(spot_market.insurance_fund.shares_base, 0);

    let amount_returned = (remove_insurance_fund_stake(
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    ))
    .unwrap();
    assert_eq!(amount_returned, amount - 1);
    if_balance -= amount_returned;

    assert_eq!(if_stake.unchecked_if_shares(), 0);
    assert_eq!(if_stake.cost_basis, 1);
    assert_eq!(if_stake.last_withdraw_request_shares, 0);
    assert_eq!(if_stake.last_withdraw_request_value, 0);
    assert_eq!(spot_market.insurance_fund.total_shares, 0);
    assert_eq!(spot_market.insurance_fund.shares_base, 0);
    assert_eq!(if_balance, 1);

    add_insurance_fund_stake(
        1234,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();
    assert_eq!(if_stake.cost_basis, 1234);
    assert_eq!(spot_market.insurance_fund.user_shares, 1234);
    assert_eq!(spot_market.insurance_fund.total_shares, 1235); // protocol claims the 1 balance
    assert_eq!(spot_market.insurance_fund.shares_base, 0);
}

#[test]
pub fn basic_seeded_stake_if_test() {
    let mut if_balance = (1000 * QUOTE_PRECISION) as u64;
    let mut if_stake = InsuranceFundStake::new(Pubkey::default(), 0, 0);
    let mut user_stats = UserStats {
        number_of_sub_accounts: 0,
        ..UserStats::default()
    };
    let amount = QUOTE_PRECISION as u64; // $1
    let mut spot_market = SpotMarket {
        deposit_balance: 0,
        cumulative_deposit_interest: 1111 * SPOT_CUMULATIVE_INTEREST_PRECISION / 1000,
        insurance_fund: InsuranceFund {
            unstaking_period: 0,
            ..InsuranceFund::default()
        },
        ..SpotMarket::default()
    };

    assert_eq!(spot_market.insurance_fund.total_shares, 0);
    assert_eq!(spot_market.insurance_fund.user_shares, 0);

    add_insurance_fund_stake(
        amount,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();

    assert_eq!(
        spot_market.insurance_fund.total_shares,
        (1001 * QUOTE_PRECISION)
    ); // seeded works
    assert_eq!(spot_market.insurance_fund.user_shares, QUOTE_PRECISION);
    assert_eq!(if_stake.unchecked_if_shares(), amount as u128);
    if_balance += amount;

    // must request first
    assert!(remove_insurance_fund_stake(
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0
    )
    .is_err());
    assert_eq!(if_stake.unchecked_if_shares(), amount as u128);

    request_remove_insurance_fund_stake(
        if_stake.unchecked_if_shares(),
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();
    assert_eq!(
        if_stake.last_withdraw_request_shares,
        if_stake.unchecked_if_shares()
    );
    assert_eq!(if_stake.last_withdraw_request_value, 1000000);

    let amount_returned = (remove_insurance_fund_stake(
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    ))
    .unwrap();
    assert_eq!(amount_returned, amount);
    if_balance -= amount_returned;

    assert_eq!(if_stake.unchecked_if_shares(), 0);
    assert_eq!(if_stake.cost_basis, 0);
    assert_eq!(if_stake.last_withdraw_request_shares, 0);
    assert_eq!(if_stake.last_withdraw_request_value, 0);
    assert_eq!(if_balance, 1000000000);

    add_insurance_fund_stake(
        1234,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();
    assert_eq!(if_stake.cost_basis, 1234);
}

#[test]
pub fn large_num_seeded_stake_if_test() {
    let mut if_balance = (199_000_000 * QUOTE_PRECISION) as u64; // ~200M
    let mut if_stake = InsuranceFundStake::new(Pubkey::default(), 0, 0);
    let mut user_stats = UserStats {
        number_of_sub_accounts: 0,
        ..UserStats::default()
    };

    let amount = 199_000_001; // ~200M + 1

    // all funds in revenue pool
    let mut spot_market = SpotMarket {
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        cumulative_deposit_interest: 1111 * SPOT_CUMULATIVE_INTEREST_PRECISION / 1000,
        insurance_fund: InsuranceFund {
            unstaking_period: 0,
            revenue_settle_period: 1,
            ..InsuranceFund::default()
        },
        revenue_pool: PoolBalance {
            market_index: 0,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION,
            ..PoolBalance::default()
        },
        ..SpotMarket::default()
    };

    assert_eq!(spot_market.insurance_fund.total_shares, 0);
    assert_eq!(spot_market.insurance_fund.user_shares, 0);

    add_insurance_fund_stake(
        amount,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();

    assert_eq!(spot_market.insurance_fund.total_shares, 199000199000001); // seeded works
    assert_eq!(spot_market.insurance_fund.user_shares, 199000001);
    assert_eq!(if_stake.unchecked_if_shares(), amount as u128);
    if_balance += amount;

    // must request first
    assert!(remove_insurance_fund_stake(
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0
    )
    .is_err());
    assert_eq!(if_stake.unchecked_if_shares(), amount as u128);
    let spot_market_vault_amount = get_token_amount(
        spot_market.deposit_balance,
        &spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap() as u64;
    assert_eq!(spot_market_vault_amount, 111);

    let flow =
        settle_revenue_to_insurance_fund(spot_market_vault_amount, if_balance, &mut spot_market, 1)
            .unwrap();
    assert_eq!(flow, 11);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 90099009901);
    let spot_market_vault_amount = get_token_amount(
        spot_market.deposit_balance,
        &spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap() as u64;
    assert_eq!(spot_market_vault_amount, 100);

    if_balance += flow;

    request_remove_insurance_fund_stake(
        if_stake.unchecked_if_shares(),
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();
    assert_eq!(
        if_stake.last_withdraw_request_shares,
        if_stake.unchecked_if_shares()
    );
    assert_eq!(if_stake.last_withdraw_request_value, 199000001);

    let amount_returned = (remove_insurance_fund_stake(
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        1,
    ))
    .unwrap();
    assert_eq!(amount_returned, amount);
    if_balance -= amount_returned;

    assert_eq!(if_stake.unchecked_if_shares(), 0);
    assert_eq!(if_stake.cost_basis, 0);
    assert_eq!(if_stake.last_withdraw_request_shares, 0);
    assert_eq!(if_stake.last_withdraw_request_value, 0);
    assert_eq!(if_balance, 199000000000011);
    assert_eq!(spot_market.insurance_fund.user_shares, 0);
    assert_eq!(spot_market.insurance_fund.total_shares, 199000000000000);

    spot_market.revenue_pool.scaled_balance = 100 * SPOT_BALANCE_PRECISION;

    add_insurance_fund_stake(
        199033744205760,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        20,
    )
    .unwrap();
    assert_eq!(if_stake.cost_basis, 199033744205760);
    assert_eq!(spot_market.insurance_fund.user_shares, 199033744205748);

    add_insurance_fund_stake(
        199033744205760,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        30,
    )
    .unwrap();
    assert_eq!(if_stake.cost_basis, 398067488411520);
    assert_eq!(spot_market.insurance_fund.user_shares, 597134982544960);
}

#[test]
pub fn gains_stake_if_test() {
    let mut if_balance = 0;
    let mut if_stake = InsuranceFundStake::new(Pubkey::default(), 0, 0);
    let mut user_stats = UserStats {
        number_of_sub_accounts: 0,
        ..UserStats::default()
    };
    let amount = QUOTE_PRECISION as u64; // $1
    let mut spot_market = SpotMarket {
        deposit_balance: 0,
        cumulative_deposit_interest: 1111 * SPOT_CUMULATIVE_INTEREST_PRECISION / 1000,
        insurance_fund: InsuranceFund {
            unstaking_period: 0,
            ..InsuranceFund::default()
        },
        ..SpotMarket::default()
    };

    add_insurance_fund_stake(
        amount,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();
    assert_eq!(if_stake.unchecked_if_shares(), amount as u128);
    if_balance += amount;

    // gains
    if_balance += amount / 19;

    let n_shares = if_stake.unchecked_if_shares();
    let expected_amount_returned = (amount + amount / 19) / 3 - 1;

    request_remove_insurance_fund_stake(
        n_shares / 3,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();
    let amount_returned = (remove_insurance_fund_stake(
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    ))
    .unwrap();
    assert_eq!(amount_returned, expected_amount_returned);
    assert_eq!(if_stake.unchecked_if_shares(), n_shares * 2 / 3 + 1);
    if_balance -= amount_returned;

    request_remove_insurance_fund_stake(
        n_shares / 3,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();
    let amount_returned = (remove_insurance_fund_stake(
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    ))
    .unwrap();
    assert_eq!(if_stake.unchecked_if_shares(), n_shares / 3 + 1);
    assert_eq!(amount_returned, expected_amount_returned);
    if_balance -= amount_returned;

    request_remove_insurance_fund_stake(
        1,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();

    let amount_returned = (remove_insurance_fund_stake(
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    ))
    .unwrap();
    assert_eq!(amount_returned, 1);

    request_remove_insurance_fund_stake(
        n_shares / 3 - 1,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();

    let amount_returned = (remove_insurance_fund_stake(
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    ))
    .unwrap();
    assert_eq!(amount_returned, expected_amount_returned + 1);

    if_balance -= amount_returned;

    assert_eq!(if_balance, 2);
}

#[test]
pub fn losses_stake_if_test() {
    let mut if_balance = 0;
    let mut if_stake = InsuranceFundStake::new(Pubkey::default(), 0, 0);
    let mut user_stats = UserStats {
        number_of_sub_accounts: 0,
        ..UserStats::default()
    };
    let amount = QUOTE_PRECISION as u64; // $1
    let mut spot_market = SpotMarket {
        deposit_balance: 0,
        cumulative_deposit_interest: 1111 * SPOT_CUMULATIVE_INTEREST_PRECISION / 1000,
        insurance_fund: InsuranceFund {
            unstaking_period: 0,
            ..InsuranceFund::default()
        },
        ..SpotMarket::default()
    };

    add_insurance_fund_stake(
        amount,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();
    assert_eq!(if_stake.unchecked_if_shares(), amount as u128);
    if_balance += amount;

    // gains
    if_balance -= amount / 19;

    let n_shares = if_stake.unchecked_if_shares();
    let expected_amount_returned = (amount - amount / 19) / 3;

    request_remove_insurance_fund_stake(
        n_shares / 3,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();

    let amount_returned = (remove_insurance_fund_stake(
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    ))
    .unwrap();
    assert_eq!(amount_returned, expected_amount_returned);
    assert_eq!(if_stake.unchecked_if_shares(), n_shares * 2 / 3 + 1);
    if_balance -= amount_returned;

    request_remove_insurance_fund_stake(
        n_shares / 3,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();
    let amount_returned = (remove_insurance_fund_stake(
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    ))
    .unwrap();
    assert_eq!(if_stake.unchecked_if_shares(), n_shares / 3 + 1);
    assert_eq!(amount_returned, expected_amount_returned);
    if_balance -= amount_returned;

    request_remove_insurance_fund_stake(
        1,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();

    let amount_returned = (remove_insurance_fund_stake(
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    ))
    .unwrap();
    assert_eq!(if_stake.unchecked_if_shares(), n_shares / 3);
    assert_eq!(amount_returned, 0);

    request_remove_insurance_fund_stake(
        n_shares / 3,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();
    let amount_returned = (remove_insurance_fund_stake(
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    ))
    .unwrap();
    assert_eq!(amount_returned, expected_amount_returned + 1);
    assert_eq!(if_stake.cost_basis, 52632);
    assert_eq!(if_stake.unchecked_if_shares(), 0);

    if_balance -= amount_returned;

    assert_eq!(if_balance, 1); // todo, should be stricer w/ rounding?
}

#[test]
pub fn escrow_losses_stake_if_test() {
    let mut if_balance = 0;
    let mut if_stake = InsuranceFundStake::new(Pubkey::default(), 0, 0);
    let mut user_stats = UserStats {
        number_of_sub_accounts: 0,
        ..UserStats::default()
    };
    let amount = (QUOTE_PRECISION * 100_000) as u64; // $100k
    let mut spot_market = SpotMarket {
        deposit_balance: 0,
        cumulative_deposit_interest: 1111 * SPOT_CUMULATIVE_INTEREST_PRECISION / 1000,
        insurance_fund: InsuranceFund {
            unstaking_period: 60 * 60 * 24 * 7, // 7 weeks
            ..InsuranceFund::default()
        },
        ..SpotMarket::default()
    };

    let now = 7842193748;

    add_insurance_fund_stake(
        amount,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();
    assert_eq!(if_stake.unchecked_if_shares(), amount as u128);
    if_balance += amount;

    // losses
    if_balance -= amount / 19;

    let n_shares = if_stake.unchecked_if_shares();
    let expected_amount_returned = (amount - amount / 19) / 3;

    let o = if_shares_to_vault_amount(
        n_shares / 3,
        spot_market.insurance_fund.total_shares,
        if_balance,
    )
    .unwrap();
    assert_eq!(if_stake.last_withdraw_request_shares, 0);

    request_remove_insurance_fund_stake(
        n_shares / 3,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        now,
    )
    .unwrap();
    assert_eq!(if_stake.last_withdraw_request_shares, 33333333333);
    assert_eq!(
        if_stake.last_withdraw_request_value,
        expected_amount_returned
    );
    assert_eq!(expected_amount_returned, o);
    assert_eq!(o, 31578947368);

    // not enough time for withdraw
    assert!(remove_insurance_fund_stake(
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        now + 60 * 60 * 24,
    )
    .is_err());

    // more losses
    if_balance = if_balance - if_balance / 2;

    // appropriate time for withdraw
    let amount_returned = (remove_insurance_fund_stake(
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        now + 60 * 60 * 24 * 7 + 3254,
    ))
    .unwrap();
    if_balance -= amount_returned;

    // since losses occured during withdraw, worse than expected at time of request
    assert_eq!(amount_returned < (expected_amount_returned - 1), true);
    assert_eq!(amount_returned, 15_789_473_684); //15k
    assert_eq!(if_stake.unchecked_if_shares(), n_shares * 2 / 3 + 1);
    assert_eq!(if_stake.cost_basis, 84_210_526_316); //84k
    assert_eq!(if_balance, 31_578_947_369); //31k
}

#[test]
pub fn escrow_gains_stake_if_test() {
    let mut if_balance = 0;
    let mut if_stake = InsuranceFundStake::new(Pubkey::default(), 0, 0);
    let mut user_stats = UserStats {
        number_of_sub_accounts: 0,
        ..UserStats::default()
    };
    let amount = 100_000_384_939_u64; // $100k + change
    let mut spot_market = SpotMarket {
        deposit_balance: 0,
        cumulative_deposit_interest: 1111 * SPOT_CUMULATIVE_INTEREST_PRECISION / 1000,
        insurance_fund: InsuranceFund {
            unstaking_period: 60 * 60 * 24 * 7, // 7 weeks
            total_shares: 1,
            user_shares: 0,
            ..InsuranceFund::default()
        },
        ..SpotMarket::default()
    };

    let now = 7842193748;
    assert_eq!(if_balance, 0);
    // right now other users have claim on a zero balance IF... should not give them your money here
    assert!(add_insurance_fund_stake(
        amount,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0
    )
    .is_err());

    if_balance = 1;
    add_insurance_fund_stake(
        amount,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();

    assert_eq!(if_stake.unchecked_if_shares(), amount as u128);
    if_balance += amount;
    assert_eq!(if_balance, 100000384940);

    // gains
    if_balance += amount / 13 - 1;

    assert_eq!(if_balance, 107692722242);

    let n_shares = if_stake.unchecked_if_shares();
    let expected_amount_returned =
        (if_balance as u128 * n_shares / spot_market.insurance_fund.total_shares) as u64;

    let o = if_shares_to_vault_amount(
        n_shares,
        spot_market.insurance_fund.total_shares,
        if_balance,
    )
    .unwrap();
    request_remove_insurance_fund_stake(
        n_shares,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        now,
    )
    .unwrap();
    let value_at_req = if_stake.last_withdraw_request_value;
    assert_eq!(value_at_req, 107692722240);
    assert_eq!(o, 107692722240);

    // not enough time for withdraw
    assert!(remove_insurance_fund_stake(
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        now + 60 * 60 * 24,
    )
    .is_err());

    // more gains
    if_balance = if_balance + if_balance / 412;

    let ideal_amount_returned =
        (if_balance as u128 * n_shares / spot_market.insurance_fund.total_shares) as u64;

    // appropriate time for withdraw
    let amount_returned = (remove_insurance_fund_stake(
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        now + 60 * 60 * 24 * 7 + 3254,
    ))
    .unwrap();
    assert_eq!(if_stake.last_withdraw_request_shares, 0);
    assert_eq!(if_stake.last_withdraw_request_value, 0);

    if_balance -= amount_returned;

    assert_eq!(amount_returned < ideal_amount_returned, true);
    assert_eq!(ideal_amount_returned - amount_returned, 261390102);
    assert_eq!(amount_returned, value_at_req);

    // since gains occured, not passed on to user after request
    assert_eq!(amount_returned, (expected_amount_returned));
    assert_eq!(if_stake.unchecked_if_shares(), 0);
    assert_eq!(if_balance, 261_390_104); //$261 for protocol/other stakers
}

#[test]
pub fn drained_stake_if_test_rebase_on_new_add() {
    let mut if_balance = 0;
    let mut if_stake = InsuranceFundStake::new(Pubkey::default(), 0, 0);
    let mut user_stats = UserStats {
        number_of_sub_accounts: 0,
        ..UserStats::default()
    };
    let amount = 100_000_384_939_u64; // $100k + change

    let mut spot_market = SpotMarket {
        deposit_balance: 0,
        cumulative_deposit_interest: 1111 * SPOT_CUMULATIVE_INTEREST_PRECISION / 1000,
        insurance_fund: InsuranceFund {
            unstaking_period: 60 * 60 * 24 * 7, // 7 weeks
            total_shares: 100_000 * QUOTE_PRECISION,
            user_shares: 80_000 * QUOTE_PRECISION,
            ..InsuranceFund::default()
        },
        ..SpotMarket::default()
    };

    assert_eq!(if_balance, 0);

    let mut orig_if_stake = InsuranceFundStake::new(Pubkey::default(), 0, 0);
    orig_if_stake
        .update_if_shares(80_000 * QUOTE_PRECISION, &spot_market)
        .unwrap();
    let mut orig_user_stats = UserStats {
        number_of_sub_accounts: 0,
        if_staked_quote_asset_amount: 80_000 * QUOTE_PRECISION as u64,
        ..UserStats::default()
    };

    // right now other users have claim on a zero balance IF... should not give them your money here
    assert!(add_insurance_fund_stake(
        amount,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .is_err());

    assert_eq!(if_stake.unchecked_if_shares(), 0);
    assert_eq!(spot_market.insurance_fund.total_shares, 100_000_000_000);
    assert_eq!(
        spot_market.insurance_fund.user_shares,
        80_000 * QUOTE_PRECISION
    );

    // make non-zero
    if_balance = 1;
    add_insurance_fund_stake(
        amount,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();
    if_balance += amount;

    // check rebase math
    assert_eq!(spot_market.insurance_fund.total_shares, 1000003849400);
    assert_eq!(spot_market.insurance_fund.user_shares, 1000003849398);
    assert_eq!(if_stake.unchecked_if_shares(), 1000003849390);
    assert_eq!(
        if_stake.unchecked_if_shares() < spot_market.insurance_fund.user_shares,
        true
    );
    assert_eq!(
        spot_market.insurance_fund.user_shares - if_stake.unchecked_if_shares(),
        8
    );

    assert_eq!(spot_market.insurance_fund.shares_base, 10);
    assert_eq!(if_stake.if_base, 10);

    // check orig if stake is good (on add)
    assert_eq!(orig_if_stake.if_base, 0);
    assert_eq!(orig_if_stake.unchecked_if_shares(), 80000000000);

    let expected_shares_for_amount =
        vault_amount_to_if_shares(1, spot_market.insurance_fund.total_shares, if_balance).unwrap();
    assert_eq!(expected_shares_for_amount, 10);

    add_insurance_fund_stake(
        1,
        if_balance,
        &mut orig_if_stake,
        &mut orig_user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();

    assert_eq!(spot_market.insurance_fund.shares_base, 10);
    assert_eq!(orig_if_stake.if_base, 10);
    assert_eq!(
        orig_if_stake.unchecked_if_shares(),
        80000000000 / 10000000000 + expected_shares_for_amount
    );
    assert_eq!(
        orig_if_stake.unchecked_if_shares(),
        8 + expected_shares_for_amount
    );
}

#[test]
pub fn drained_stake_if_test_rebase_on_old_remove_all() {
    let mut if_balance = 0;

    let mut spot_market = SpotMarket {
        deposit_balance: 0,
        cumulative_deposit_interest: 1111 * SPOT_CUMULATIVE_INTEREST_PRECISION / 1000,
        insurance_fund: InsuranceFund {
            unstaking_period: 0,
            total_shares: 100_000 * QUOTE_PRECISION,
            user_shares: 80_000 * QUOTE_PRECISION,
            ..InsuranceFund::default()
        },
        ..SpotMarket::default()
    };

    let mut if_stake = InsuranceFundStake::new(Pubkey::default(), 0, 0);
    if_stake
        .update_if_shares(80_000 * QUOTE_PRECISION, &spot_market)
        .unwrap();
    let mut user_stats = UserStats {
        number_of_sub_accounts: 0,
        if_staked_quote_asset_amount: 80_000 * QUOTE_PRECISION as u64,
        ..UserStats::default()
    };

    assert_eq!(if_balance, 0);

    // right now other users have claim on a zero balance IF... should not give them your money here
    assert_eq!(spot_market.insurance_fund.total_shares, 100_000_000_000);
    assert_eq!(
        spot_market.insurance_fund.user_shares,
        80_000 * QUOTE_PRECISION
    );

    request_remove_insurance_fund_stake(
        if_stake.unchecked_if_shares(),
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();

    let amount_returned = (remove_insurance_fund_stake(
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    ))
    .unwrap();

    // check rebase math
    assert_eq!(amount_returned, 0);
    assert_eq!(spot_market.insurance_fund.total_shares, 20000000000);
    assert_eq!(spot_market.insurance_fund.user_shares, 0);

    // make non-zero
    if_balance = 1;
    //  add_insurance_fund_stake(
    //      1,
    //      if_balance,
    //      &mut if_stake,
    //      &mut user_stats,
    //      &mut spot_market,
    //      0
    //  )
    //  .unwrap();
    //  if_balance = if_balance + 1;

    //  assert_eq!(spot_market.insurance_fund.if_shares_base, 9);
    //  assert_eq!(spot_market.insurance_fund.total_shares, 40);
    //  assert_eq!(spot_market.insurance_fund.user_shares, 20);

    add_insurance_fund_stake(
        10_000_000_000_000, // 10 mil
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();

    assert_eq!(spot_market.insurance_fund.shares_base, 9);
    assert_eq!(spot_market.insurance_fund.total_shares, 200000000000020);
    assert_eq!(spot_market.insurance_fund.user_shares, 200000000000000);
    if_balance += 10_000_000_000_000;
    assert_eq!(if_balance, 10000000000001);
}

#[test]
pub fn drained_stake_if_test_rebase_on_old_remove_all_2() {
    let mut if_balance = 0;

    let mut spot_market = SpotMarket {
        deposit_balance: 0,
        cumulative_deposit_interest: 1111 * SPOT_CUMULATIVE_INTEREST_PRECISION / 1000,
        insurance_fund: InsuranceFund {
            unstaking_period: 0,
            total_shares: 100_930_021_053,
            user_shares: 83_021 * QUOTE_PRECISION + 135723,
            ..InsuranceFund::default()
        },
        ..SpotMarket::default()
    };

    let mut if_stake = InsuranceFundStake::new(Pubkey::default(), 0, 0);
    if_stake
        .update_if_shares(80_000 * QUOTE_PRECISION, &spot_market)
        .unwrap();
    let mut user_stats = UserStats {
        number_of_sub_accounts: 0,
        if_staked_quote_asset_amount: 80_000 * QUOTE_PRECISION as u64,
        ..UserStats::default()
    };

    assert_eq!(if_balance, 0);

    request_remove_insurance_fund_stake(
        if_stake.unchecked_if_shares() / 2,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();

    let amount_returned = (remove_insurance_fund_stake(
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    ))
    .unwrap();

    // check rebase math
    assert_eq!(amount_returned, 0);
    assert_eq!(spot_market.insurance_fund.total_shares, 60930021053);
    assert_eq!(spot_market.insurance_fund.user_shares, 43021135723);
    assert_eq!(spot_market.insurance_fund.shares_base, 0);

    if_balance = QUOTE_PRECISION as u64;

    let unstake_amt = if_stake.unchecked_if_shares() / 2;
    assert_eq!(unstake_amt, 20000000000);
    assert_eq!(if_stake.last_withdraw_request_shares, 0);
    assert_eq!(if_stake.last_withdraw_request_value, 0);
    assert_eq!(if_stake.last_withdraw_request_ts, 0);

    request_remove_insurance_fund_stake(
        unstake_amt,
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        10,
    )
    .unwrap();

    // rebase occurs in request
    assert_eq!(if_stake.last_withdraw_request_shares, unstake_amt / 1000);
    // (that rebase occurs when you pass in shares you wanna unstake) :/
    assert_eq!(if_stake.unchecked_if_shares(), 40000000);
    assert_eq!(if_stake.last_withdraw_request_value, 328245);
    assert_eq!(if_stake.last_withdraw_request_ts, 10);

    assert_eq!(spot_market.insurance_fund.total_shares, 60930021);
    assert_eq!(spot_market.insurance_fund.user_shares, 43021135);

    assert_eq!(spot_market.insurance_fund.shares_base, 3);

    let expected_amount_for_shares = if_shares_to_vault_amount(
        if_stake.unchecked_if_shares() / 2,
        spot_market.insurance_fund.total_shares,
        if_balance,
    )
    .unwrap();
    assert_eq!(
        expected_amount_for_shares,
        if_stake.last_withdraw_request_value
    );

    let user_expected_amount_for_shares_before_double = if_shares_to_vault_amount(
        spot_market.insurance_fund.user_shares,
        spot_market.insurance_fund.total_shares,
        if_balance,
    )
    .unwrap();

    let protocol_expected_amount_for_shares_before_double = if_shares_to_vault_amount(
        spot_market.insurance_fund.total_shares - spot_market.insurance_fund.user_shares,
        spot_market.insurance_fund.total_shares,
        if_balance,
    )
    .unwrap();

    assert_eq!(user_expected_amount_for_shares_before_double, 706_074);
    assert_eq!(protocol_expected_amount_for_shares_before_double, 293_925);
    assert_eq!(
        user_expected_amount_for_shares_before_double
            + protocol_expected_amount_for_shares_before_double,
        if_balance - 1 // ok rounding
    );

    if_balance *= 2; // double the IF vault before withdraw

    let protocol_expected_amount_for_shares_after_double = if_shares_to_vault_amount(
        spot_market.insurance_fund.total_shares - spot_market.insurance_fund.user_shares,
        spot_market.insurance_fund.total_shares,
        if_balance,
    )
    .unwrap();

    let user_expected_amount_for_shares_after_double = if_shares_to_vault_amount(
        spot_market.insurance_fund.user_shares,
        spot_market.insurance_fund.total_shares,
        if_balance,
    )
    .unwrap();

    let amount_returned = (remove_insurance_fund_stake(
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        10,
    ))
    .unwrap();

    let protocol_expected_amount_for_shares_after_user_withdraw = if_shares_to_vault_amount(
        spot_market.insurance_fund.total_shares - spot_market.insurance_fund.user_shares,
        spot_market.insurance_fund.total_shares,
        if_balance,
    )
    .unwrap();

    // check rebase math
    assert_eq!(if_stake.unchecked_if_shares(), 20000000);
    assert_eq!(if_stake.if_base, spot_market.insurance_fund.shares_base);
    assert_eq!(if_stake.last_withdraw_request_shares, 0);
    assert_eq!(if_stake.last_withdraw_request_value, 0);

    assert_eq!(amount_returned, 328245);
    assert_eq!(spot_market.insurance_fund.total_shares, 40930021);
    assert_eq!(spot_market.insurance_fund.user_shares, 23021135);
    assert_eq!(spot_market.insurance_fund.shares_base, 3);

    assert_eq!(
        protocol_expected_amount_for_shares_after_double,
        protocol_expected_amount_for_shares_before_double * 2
    );
    assert_eq!(
        user_expected_amount_for_shares_after_double - 1,
        user_expected_amount_for_shares_before_double * 2
    );
    assert_eq!(
        user_expected_amount_for_shares_after_double
            + protocol_expected_amount_for_shares_after_double,
        if_balance - 1 // ok rounding
    );

    assert_eq!(
        protocol_expected_amount_for_shares_after_user_withdraw,
        875_097
    );
    assert_eq!(
        protocol_expected_amount_for_shares_after_user_withdraw
            > protocol_expected_amount_for_shares_after_double,
        true
    );

    add_insurance_fund_stake(
        10_000_000_000_000, // 10 mil
        if_balance,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        0,
    )
    .unwrap();
    if_balance += 10_000_000_000_000;

    assert_eq!(spot_market.insurance_fund.total_shares, 204650145930021);
    assert_eq!(spot_market.insurance_fund.user_shares, 204650128021135);
    assert_eq!(spot_market.insurance_fund.shares_base, 3);
    assert_eq!(if_balance, 10000002000000);
}

#[test]
pub fn multiple_if_stakes_and_rebase() {
    let mut if_balance = 0;

    let mut if_stake_1 = InsuranceFundStake::new(Pubkey::default(), 0, 0);
    let mut user_stats_1 = UserStats {
        number_of_sub_accounts: 0,
        ..UserStats::default()
    };

    let mut if_stake_2 = InsuranceFundStake::new(Pubkey::default(), 0, 0);
    let mut user_stats_2 = UserStats {
        number_of_sub_accounts: 0,
        ..UserStats::default()
    };

    let amount = (QUOTE_PRECISION * 100_000) as u64; // $100k
    let mut spot_market = SpotMarket {
        deposit_balance: 0,
        cumulative_deposit_interest: 1111 * SPOT_CUMULATIVE_INTEREST_PRECISION / 1000,
        insurance_fund: InsuranceFund {
            unstaking_period: 0,
            ..InsuranceFund::default()
        },
        ..SpotMarket::default()
    };

    add_insurance_fund_stake(
        amount,
        if_balance,
        &mut if_stake_1,
        &mut user_stats_1,
        &mut spot_market,
        0,
    )
    .unwrap();

    if_balance = amount;

    add_insurance_fund_stake(
        amount,
        if_balance,
        &mut if_stake_2,
        &mut user_stats_2,
        &mut spot_market,
        0,
    )
    .unwrap();

    // if gets drained
    if_balance = QUOTE_PRECISION as u64;
    assert_eq!(if_stake_1.if_base, 0);
    assert_eq!(spot_market.insurance_fund.shares_base, 0);

    request_remove_insurance_fund_stake(
        if_stake_1.unchecked_if_shares(),
        if_balance,
        &mut if_stake_1,
        &mut user_stats_1,
        &mut spot_market,
        0,
    )
    .unwrap();
    assert_eq!(if_stake_1.if_base, 4);
    assert_eq!(spot_market.insurance_fund.shares_base, 4);

    let amount_returned = (remove_insurance_fund_stake(
        if_balance,
        &mut if_stake_1,
        &mut user_stats_1,
        &mut spot_market,
        0,
    ))
    .unwrap();
    assert_eq!(amount_returned, 500000);
    if_balance -= amount_returned;

    assert_eq!(if_stake_2.if_base, 0);
    assert_eq!(spot_market.insurance_fund.shares_base, 4);
    request_remove_insurance_fund_stake(
        if_stake_2.unchecked_if_shares(),
        if_balance,
        &mut if_stake_2,
        &mut user_stats_2,
        &mut spot_market,
        0,
    )
    .unwrap();
    assert_eq!(if_stake_2.if_base, 4);
    assert_eq!(spot_market.insurance_fund.shares_base, 4);
    assert_eq!(
        if_stake_2.if_base < spot_market.insurance_fund.total_shares,
        true
    );
    assert_eq!(
        if_stake_2.unchecked_if_shares(),
        spot_market.insurance_fund.user_shares
    );
    assert_eq!(if_balance, 500000);

    let amount_returned = (remove_insurance_fund_stake(
        if_balance,
        &mut if_stake_2,
        &mut user_stats_2,
        &mut spot_market,
        0,
    ))
    .unwrap();

    assert_eq!(amount_returned, if_balance - 1);
    if_balance -= amount_returned;

    assert_eq!(if_balance, 1);
    assert_eq!(spot_market.insurance_fund.user_shares, 0);
    assert_eq!(spot_market.insurance_fund.total_shares, 0);
}

#[test]
pub fn multiple_if_stakes_and_rebase_and_admin_remove() {
    let mut if_balance = (100 * QUOTE_PRECISION) as u64;

    let mut if_stake_1 = InsuranceFundStake::new(Pubkey::default(), 0, 0);
    let mut user_stats_1 = UserStats {
        number_of_sub_accounts: 0,
        ..UserStats::default()
    };

    let mut if_stake_2 = InsuranceFundStake::new(Pubkey::default(), 0, 0);
    let mut user_stats_2 = UserStats {
        number_of_sub_accounts: 0,
        ..UserStats::default()
    };

    let amount = (QUOTE_PRECISION * 100_000) as u64; // $100k
    let mut spot_market = SpotMarket {
        deposit_balance: 0,
        cumulative_deposit_interest: 1111 * SPOT_CUMULATIVE_INTEREST_PRECISION / 1000,
        insurance_fund: InsuranceFund {
            unstaking_period: 0,
            ..InsuranceFund::default()
        },
        ..SpotMarket::default()
    };

    // withdraw half
    let amount_returned = admin_remove_insurance_fund_stake(
        if_balance,
        (if_balance / 2) as u128,
        &mut spot_market,
        1,
        Pubkey::default(),
    )
    .unwrap();
    if_balance -= amount_returned;

    assert_eq!(amount_returned, (50 * QUOTE_PRECISION) as u64);
    assert_eq!(spot_market.insurance_fund.user_shares, 0);
    assert_eq!(
        spot_market.insurance_fund.total_shares,
        50 * QUOTE_PRECISION
    );

    // add it back
    if_balance += amount_returned;

    add_insurance_fund_stake(
        amount,
        if_balance,
        &mut if_stake_1,
        &mut user_stats_1,
        &mut spot_market,
        0,
    )
    .unwrap();

    if_balance += amount;

    add_insurance_fund_stake(
        amount,
        if_balance,
        &mut if_stake_2,
        &mut user_stats_2,
        &mut spot_market,
        0,
    )
    .unwrap();

    // if gets drained
    if_balance = QUOTE_PRECISION as u64;
    assert_eq!(if_stake_1.if_base, 0);
    assert_eq!(spot_market.insurance_fund.shares_base, 0);

    request_remove_insurance_fund_stake(
        if_stake_1.unchecked_if_shares(),
        if_balance,
        &mut if_stake_1,
        &mut user_stats_1,
        &mut spot_market,
        0,
    )
    .unwrap();
    assert_eq!(if_stake_1.if_base, 4);
    assert_eq!(spot_market.insurance_fund.shares_base, 4);

    let amount_returned = (remove_insurance_fund_stake(
        if_balance,
        &mut if_stake_1,
        &mut user_stats_1,
        &mut spot_market,
        0,
    ))
    .unwrap();
    assert_eq!(amount_returned, 499750);
    if_balance -= amount_returned;

    assert_eq!(if_stake_2.if_base, 0);
    assert_eq!(spot_market.insurance_fund.shares_base, 4);
    request_remove_insurance_fund_stake(
        if_stake_2.unchecked_if_shares(),
        if_balance,
        &mut if_stake_2,
        &mut user_stats_2,
        &mut spot_market,
        0,
    )
    .unwrap();
    assert_eq!(if_stake_2.if_base, 4);
    assert_eq!(spot_market.insurance_fund.shares_base, 4);
    assert_eq!(
        if_stake_2.if_base < spot_market.insurance_fund.total_shares,
        true
    );
    assert_eq!(
        if_stake_2.unchecked_if_shares(),
        spot_market.insurance_fund.user_shares
    );
    assert_eq!(if_balance, 500250);

    // withdraw all
    let amount_returned = admin_remove_insurance_fund_stake(
        if_balance,
        spot_market.insurance_fund.total_shares - spot_market.insurance_fund.user_shares,
        &mut spot_market,
        1,
        Pubkey::default(),
    )
    .unwrap();
    if_balance -= amount_returned;

    assert_eq!(amount_returned, 499);
    assert_eq!(
        spot_market.insurance_fund.user_shares,
        spot_market.insurance_fund.total_shares
    );

    // half of it back
    if_balance += 249;

    let amount_returned = (remove_insurance_fund_stake(
        if_balance,
        &mut if_stake_2,
        &mut user_stats_2,
        &mut spot_market,
        0,
    ))
    .unwrap();

    assert_eq!(amount_returned, 499750);
    if_balance -= amount_returned;

    assert_eq!(if_balance, 250);
    assert_eq!(spot_market.insurance_fund.user_shares, 0);
    assert_eq!(spot_market.insurance_fund.total_shares, 0);

    let amount_returned =
        admin_remove_insurance_fund_stake(if_balance, 250, &mut spot_market, 1, Pubkey::default())
            .unwrap();
    // if_balance -= amount_returned;

    assert_eq!(amount_returned, 250);
    assert_eq!(spot_market.insurance_fund.user_shares, 0);
    assert_eq!(spot_market.insurance_fund.total_shares, 0);
}

#[test]
fn test_transfer_protocol_owned_stake() {
    let mut if_balance = (199000 * QUOTE_PRECISION) as u64;

    let mut if_stake_2 = InsuranceFundStake::new(Pubkey::default(), 0, 0);
    let mut user_stats_2 = UserStats {
        number_of_sub_accounts: 0,
        ..UserStats::default()
    };

    let mut spot_market = SpotMarket {
        deposit_balance: 0,
        cumulative_deposit_interest: 1111 * SPOT_CUMULATIVE_INTEREST_PRECISION / 1000,
        insurance_fund: InsuranceFund {
            unstaking_period: 0,
            ..InsuranceFund::default()
        },
        ..SpotMarket::default()
    };
    assert_eq!(spot_market.insurance_fund.user_shares, 0);
    assert_eq!(spot_market.insurance_fund.total_shares, 0);

    spot_market.insurance_fund.total_shares = 42210407198; // make price != 1

    // withdraw half
    let amount_returned = admin_remove_insurance_fund_stake(
        if_balance,
        (spot_market.insurance_fund.total_shares / 2) as u128,
        &mut spot_market,
        1,
        Pubkey::default(),
    )
    .unwrap();
    if_balance -= amount_returned;

    assert_eq!(amount_returned, (99500000000) as u64);
    assert_eq!(spot_market.insurance_fund.user_shares, 0);
    assert_eq!(spot_market.insurance_fund.total_shares, 21105203599);

    let now = 6969696969;

    let transfer_num_0 = transfer_protocol_insurance_fund_stake(
        if_balance,
        0,
        &mut if_stake_2,
        &mut user_stats_2,
        &mut spot_market,
        now,
        Pubkey::default(),
    )
    .unwrap();
    assert_eq!(0, spot_market.insurance_fund.user_shares);
    assert_eq!(transfer_num_0, 0);

    let transfer_num_1 = transfer_protocol_insurance_fund_stake(
        if_balance,
        1,
        &mut if_stake_2,
        &mut user_stats_2,
        &mut spot_market,
        now,
        Pubkey::default(),
    )
    .unwrap();
    assert_eq!(1, spot_market.insurance_fund.user_shares);
    assert_eq!(21105203599, spot_market.insurance_fund.total_shares);
    assert_eq!(transfer_num_1, 4);

    assert!(transfer_protocol_insurance_fund_stake(
        if_balance,
        spot_market.insurance_fund.total_shares,
        &mut if_stake_2,
        &mut user_stats_2,
        &mut spot_market,
        now,
        Pubkey::default(),
    )
    .is_err());

    let transfer_num_2 = transfer_protocol_insurance_fund_stake(
        if_balance,
        spot_market.insurance_fund.total_shares - spot_market.insurance_fund.user_shares,
        &mut if_stake_2,
        &mut user_stats_2,
        &mut spot_market,
        now,
        Pubkey::default(),
    )
    .unwrap();

    assert_eq!(
        spot_market.insurance_fund.total_shares,
        spot_market.insurance_fund.user_shares
    );
    assert_eq!(transfer_num_2, 99499999995);

    let mut expected_if_stake_2 = InsuranceFundStake::new(Pubkey::default(), 0, 0);
    expected_if_stake_2
        .increase_if_shares(21105203599 as u128, &spot_market)
        .unwrap();

    assert_eq!(user_stats_2.if_staked_quote_asset_amount, 99500000000);
    assert_eq!(if_stake_2, expected_if_stake_2);

    assert!(transfer_protocol_insurance_fund_stake(
        if_balance,
        spot_market.insurance_fund.total_shares,
        &mut if_stake_2,
        &mut user_stats_2,
        &mut spot_market,
        now,
        Pubkey::default(),
    )
    .is_err());
}
