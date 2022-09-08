use solana_program::msg;

use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::amm::calculate_weighted_average;
use crate::math::bank_balance::{
    calculate_accumulated_interest, calculate_utilization, check_withdraw_limits, get_bank_balance,
    get_interest_token_amount, get_token_amount, InterestAccumulated,
};
use crate::math::casting::{cast, cast_to_i128, cast_to_u64};
use crate::math::constants::{BANK_INTEREST_PRECISION, TWENTY_FOUR_HOUR};
use crate::math_error;
use crate::state::bank::{Bank, BankBalance, BankBalanceType};
use crate::state::market::Market;
use crate::validate;
use std::cmp::max;

pub fn update_bank_twap_stats(bank: &mut Bank, now: i64) -> ClearingHouseResult {
    let since_last = cast_to_i128(max(
        1,
        now.checked_sub(bank.last_twap_ts as i64)
            .ok_or_else(math_error!())?,
    ))?;
    let from_start = max(
        1,
        cast_to_i128(TWENTY_FOUR_HOUR)?
            .checked_sub(since_last)
            .ok_or_else(math_error!())?,
    );

    let deposit_token_amount =
        get_token_amount(bank.deposit_balance, bank, &BankBalanceType::Deposit)?;
    let borrow_token_amount =
        get_token_amount(bank.borrow_balance, bank, &BankBalanceType::Borrow)?;

    bank.deposit_token_twap = cast(calculate_weighted_average(
        cast(deposit_token_amount)?,
        cast(bank.deposit_token_twap)?,
        since_last,
        from_start,
    )?)?;

    bank.borrow_token_twap = cast(calculate_weighted_average(
        cast(borrow_token_amount)?,
        cast(bank.borrow_token_twap)?,
        since_last,
        from_start,
    )?)?;

    let utilization = calculate_utilization(deposit_token_amount, borrow_token_amount)?;

    bank.utilization_twap = cast(calculate_weighted_average(
        cast(utilization)?,
        cast(bank.utilization_twap)?,
        since_last,
        from_start,
    )?)?;

    Ok(())
}

pub fn update_bank_cumulative_interest(bank: &mut Bank, now: i64) -> ClearingHouseResult {
    let InterestAccumulated {
        deposit_interest,
        borrow_interest,
    } = calculate_accumulated_interest(bank, now)?;

    if deposit_interest > 0 && borrow_interest > 1 {
        // borrowers -> lenders IF fee here
        let deposit_interest_for_stakers = deposit_interest
            .checked_mul(bank.total_if_factor as u128)
            .ok_or_else(math_error!())?
            .checked_div(BANK_INTEREST_PRECISION)
            .ok_or_else(math_error!())?;

        let deposit_interest_for_lenders = deposit_interest
            .checked_sub(deposit_interest_for_stakers)
            .ok_or_else(math_error!())?;

        if deposit_interest_for_lenders > 0 {
            bank.cumulative_deposit_interest = bank
                .cumulative_deposit_interest
                .checked_add(deposit_interest_for_lenders)
                .ok_or_else(math_error!())?;

            bank.cumulative_borrow_interest = bank
                .cumulative_borrow_interest
                .checked_add(borrow_interest)
                .ok_or_else(math_error!())?;
            bank.last_interest_ts = cast_to_u64(now)?;

            // add deposit_interest_for_stakers as balance for revenue_pool
            let token_amount = get_interest_token_amount(
                bank.deposit_balance,
                bank,
                deposit_interest_for_stakers,
            )?;

            update_revenue_pool_balances(token_amount, &BankBalanceType::Deposit, bank)?;
        }
    }

    update_bank_twap_stats(bank, now)?;
    bank.last_twap_ts = cast_to_u64(now)?;

    Ok(())
}

pub fn update_revenue_pool_balances(
    token_amount: u128,
    update_direction: &BankBalanceType,
    bank: &mut Bank,
) -> ClearingHouseResult {
    let mut bank_balance = bank.revenue_pool;
    update_bank_balances(
        token_amount,
        update_direction,
        bank,
        &mut bank_balance,
        false,
    )?;
    bank.revenue_pool = bank_balance;

    Ok(())
}

pub fn update_bank_balances(
    mut token_amount: u128,
    update_direction: &BankBalanceType,
    bank: &mut Bank,
    bank_balance: &mut dyn BankBalance,
    force_round_up: bool,
) -> ClearingHouseResult {
    let increase_user_existing_balance = update_direction == bank_balance.balance_type();
    if increase_user_existing_balance {
        let round_up = bank_balance.balance_type() == &BankBalanceType::Borrow;
        let balance_delta = get_bank_balance(token_amount, bank, update_direction, round_up)?;
        bank_balance.increase_balance(balance_delta)?;
        increase_bank_balance(balance_delta, bank, update_direction)?;
    } else {
        let current_token_amount =
            get_token_amount(bank_balance.balance(), bank, bank_balance.balance_type())?;

        let reduce_user_existing_balance = current_token_amount != 0;
        if reduce_user_existing_balance {
            // determine how much to reduce balance based on size of current token amount
            let (token_delta, balance_delta) = if current_token_amount > token_amount {
                let round_up =
                    force_round_up || bank_balance.balance_type() == &BankBalanceType::Borrow;
                let balance_delta =
                    get_bank_balance(token_amount, bank, bank_balance.balance_type(), round_up)?;
                (token_amount, balance_delta)
            } else {
                (current_token_amount, bank_balance.balance())
            };

            decrease_bank_balance(balance_delta, bank, bank_balance.balance_type())?;
            bank_balance.decrease_balance(balance_delta)?;
            token_amount = token_amount
                .checked_sub(token_delta)
                .ok_or_else(math_error!())?;
        }

        if token_amount > 0 {
            bank_balance.update_balance_type(*update_direction)?;
            let round_up = update_direction == &BankBalanceType::Borrow;
            let balance_delta = get_bank_balance(token_amount, bank, update_direction, round_up)?;
            bank_balance.increase_balance(balance_delta)?;
            increase_bank_balance(balance_delta, bank, update_direction)?;
        }
    }

    if let BankBalanceType::Borrow = update_direction {
        let deposit_token_amount =
            get_token_amount(bank.deposit_balance, bank, &BankBalanceType::Deposit)?;

        let borrow_token_amount =
            get_token_amount(bank.borrow_balance, bank, &BankBalanceType::Borrow)?;

        validate!(
            deposit_token_amount >= borrow_token_amount,
            ErrorCode::BankInsufficientDeposits,
            "Bank has insufficent deposits to complete withdraw: deposits ({}) borrows ({})",
            deposit_token_amount,
            borrow_token_amount
        )?;
    }

    Ok(())
}

pub fn update_bank_balances_with_limits(
    token_amount: u128,
    update_direction: &BankBalanceType,
    bank: &mut Bank,
    bank_balance: &mut dyn BankBalance,
) -> ClearingHouseResult {
    update_bank_balances(token_amount, update_direction, bank, bank_balance, true)?;

    let valid_withdraw = check_withdraw_limits(bank)?;

    validate!(
        valid_withdraw,
        ErrorCode::BankDailyWithdrawLimit,
        "Bank has hit daily withdraw limit"
    )?;

    Ok(())
}

pub fn check_bank_market_valid(
    market: &Market,
    bank: &Bank,
    bank_balance: &mut dyn BankBalance,
    current_slot: u64,
) -> ClearingHouseResult {
    // todo

    if market.amm.oracle == bank.oracle
        && bank_balance.balance_type() == &BankBalanceType::Borrow
        && (market.amm.last_update_slot != current_slot || !market.amm.last_oracle_valid)
    {
        return Err(ErrorCode::InvalidOracle);
    }

    Ok(())
}

fn increase_bank_balance(
    delta: u128,
    bank: &mut Bank,
    balance_type: &BankBalanceType,
) -> ClearingHouseResult {
    match balance_type {
        BankBalanceType::Deposit => {
            bank.deposit_balance = bank
                .deposit_balance
                .checked_add(delta)
                .ok_or_else(math_error!())?
        }
        BankBalanceType::Borrow => {
            bank.borrow_balance = bank
                .borrow_balance
                .checked_add(delta)
                .ok_or_else(math_error!())?
        }
    }

    Ok(())
}

fn decrease_bank_balance(
    delta: u128,
    bank: &mut Bank,
    balance_type: &BankBalanceType,
) -> ClearingHouseResult {
    match balance_type {
        BankBalanceType::Deposit => {
            bank.deposit_balance = bank
                .deposit_balance
                .checked_sub(delta)
                .ok_or_else(math_error!())?
        }
        BankBalanceType::Borrow => {
            bank.borrow_balance = bank
                .borrow_balance
                .checked_sub(delta)
                .ok_or_else(math_error!())?
        }
    }

    Ok(())
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::controller::insurance::settle_revenue_to_insurance_fund;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BANK_CUMULATIVE_INTEREST_PRECISION, BANK_INTEREST_PRECISION,
        BANK_UTILIZATION_PRECISION, BANK_WEIGHT_PRECISION, BASE_PRECISION_I128,
        LIQUIDATION_FEE_PRECISION, PEG_PRECISION, QUOTE_PRECISION, QUOTE_PRECISION_I128,
    };
    use crate::state::bank::{Bank, BankBalanceType};
    use crate::state::bank_map::BankMap;
    use crate::state::market::{Market, AMM};
    use crate::state::market_map::MarketMap;
    use crate::state::oracle::OracleSource;
    use crate::state::oracle_map::OracleMap;
    use crate::state::user::{MarketPosition, Order, User, UserBankBalance};
    use crate::tests::utils::get_pyth_price;
    use crate::tests::utils::*;
    use anchor_lang::Owner;
    use solana_program::pubkey::Pubkey;
    use std::str::FromStr;

    #[test]
    fn check_withdraw_limits() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut oracle_price = get_pyth_price(100, 10);
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            oracle_price,
            &oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let _oracle_map = OracleMap::load_one(&oracle_account_info, slot).unwrap();

        let mut market = Market {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                quote_asset_amount_short: 50 * QUOTE_PRECISION_I128,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            open_interest: 1,
            initialized: true,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..Market::default()
        };
        create_anchor_account_info!(market, Market, market_account_info);
        let _market_map = MarketMap::load_one(&market_account_info, true).unwrap();

        let mut bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,

            decimals: 6,
            initial_asset_weight: BANK_WEIGHT_PRECISION,
            maintenance_asset_weight: BANK_WEIGHT_PRECISION,
            deposit_balance: QUOTE_PRECISION,
            borrow_balance: 0,
            deposit_token_twap: QUOTE_PRECISION / 2,
            ..Bank::default()
        };
        create_anchor_account_info!(bank, Bank, bank_account_info);
        let mut sol_bank = Bank {
            bank_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: oracle_price_key,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 10,
            initial_asset_weight: 8 * BANK_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * BANK_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * BANK_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * BANK_WEIGHT_PRECISION / 10,
            deposit_balance: BANK_INTEREST_PRECISION,
            borrow_balance: BANK_INTEREST_PRECISION,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 1000,
            ..Bank::default()
        };
        create_anchor_account_info!(sol_bank, Bank, sol_bank_account_info);
        let bank_account_infos = Vec::from([&bank_account_info, &sol_bank_account_info]);
        let _bank_map = BankMap::load_multiple(bank_account_infos, true).unwrap();

        let mut user_bank_balances = [UserBankBalance::default(); 8];
        user_bank_balances[0] = UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Deposit,
            balance: BANK_INTEREST_PRECISION,
        };
        let mut user = User {
            orders: [Order::default(); 32],
            positions: [MarketPosition::default(); 5],
            bank_balances: user_bank_balances,
            ..User::default()
        };

        let amount: u64 = QUOTE_PRECISION as u64;

        assert_eq!(
            bank.cumulative_deposit_interest,
            BANK_CUMULATIVE_INTEREST_PRECISION
        );
        assert_eq!(
            bank.cumulative_borrow_interest,
            BANK_CUMULATIVE_INTEREST_PRECISION
        );

        // TEST USER WITHDRAW

        // fails
        let bank_backup = bank;
        let user_backup = user;
        assert!(update_bank_balances_with_limits(
            amount as u128,
            &BankBalanceType::Borrow,
            &mut bank,
            &mut user.bank_balances[0],
        )
        .is_err());
        bank = bank_backup;
        user = user_backup;
        assert_eq!(bank.deposit_balance, QUOTE_PRECISION);

        // .50 * .2 = .1
        assert_eq!(bank.deposit_token_twap, 500000);
        assert_eq!(user.bank_balances[0].balance, 1000000);
        assert_eq!(bank.deposit_balance, 1000000);
        assert_eq!(bank.borrow_balance, 0);
        assert_eq!((amount / 2), 500000);
        update_bank_balances_with_limits(
            (amount / 2) as u128,
            &BankBalanceType::Borrow,
            &mut bank,
            &mut user.bank_balances[0],
        )
        .unwrap();
        assert_eq!(user.bank_balances[0].balance, 499999);
        assert_eq!(bank.deposit_token_twap, 500000);
        assert_eq!(bank.deposit_balance, 499999);
        assert_eq!(bank.borrow_balance, 0);

        // .50 * .2 = .1
        update_bank_balances_with_limits(
            ((amount / 10) - 2) as u128,
            &BankBalanceType::Borrow,
            &mut bank,
            &mut user.bank_balances[0],
        )
        .unwrap();

        //fail
        let bank_backup = bank;
        let user_backup = user;
        assert!(update_bank_balances_with_limits(
            1_u128,
            &BankBalanceType::Borrow,
            &mut bank,
            &mut user.bank_balances[0],
        )
        .is_err());
        bank = bank_backup;
        user = user_backup;
        assert_eq!(bank.deposit_balance, 400000);
        assert_eq!(user.bank_balances[0].balance, 400000);
        assert_eq!(user.bank_balances[0].bank_index, 0);

        let old_twap = bank.deposit_token_twap;
        update_bank_cumulative_interest(&mut bank, now + 3600).unwrap();
        assert_eq!(bank.deposit_token_twap, 495833);
        update_bank_cumulative_interest(&mut bank, now + 3600 * 24).unwrap();
        assert_eq!(bank.deposit_token_twap, 403993); // little bit slower than 1 day
        update_bank_cumulative_interest(&mut bank, now + 3600 * 48 + 100).unwrap();
        let new_twap = bank.deposit_token_twap;
        assert!(old_twap >= new_twap);
        assert_eq!(new_twap, 400000);

        // Borrowing blocks

        update_bank_balances_with_limits(
            QUOTE_PRECISION * 100000,
            &BankBalanceType::Deposit,
            &mut bank,
            &mut user.bank_balances[0],
        )
        .unwrap();
        assert_eq!(bank.deposit_balance, 100000400000);
        assert_eq!(user.bank_balances[0].balance, 100000400000);
        assert_eq!(user.bank_balances[1].balance, 0);

        bank.last_interest_ts = now as u64;
        bank.last_twap_ts = now as u64;
        update_bank_cumulative_interest(&mut bank, now + 3600).unwrap();
        assert_eq!(bank.deposit_token_twap, 4167066666); //$4167.06
        update_bank_cumulative_interest(&mut bank, now + 3600 * 44).unwrap();
        assert_eq!(bank.deposit_token_twap, 99999780925); //$4167.06

        // tiny whale who will grow
        let mut whale = User {
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 1,
                balance_type: BankBalanceType::Deposit,
                balance: 50 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };
        sol_bank.deposit_balance = 50 * BANK_INTEREST_PRECISION;

        sol_bank.optimal_borrow_rate = BANK_INTEREST_PRECISION / 5; //20% APR
        sol_bank.max_borrow_rate = BANK_INTEREST_PRECISION; //100% APR

        update_bank_balances_with_limits(
            QUOTE_PRECISION * 50,
            &BankBalanceType::Borrow,
            &mut bank,
            &mut whale.bank_balances[1],
        )
        .unwrap();

        assert_eq!(whale.bank_balances[0].bank_index, 1);
        assert_eq!(whale.bank_balances[1].bank_index, 0);
        assert_eq!(whale.bank_balances[1].balance, 50000001);
        assert_eq!(whale.bank_balances[1].balance_type, BankBalanceType::Borrow);
        assert_eq!(user.bank_balances[1].balance, 0);

        user.bank_balances[1].bank_index = 1; // usually done elsewhere in instruction

        update_bank_balances_with_limits(
            100000 * 100000,
            &BankBalanceType::Borrow,
            &mut sol_bank,
            &mut user.bank_balances[1],
        )
        .unwrap();
        assert_eq!(user.bank_balances[0].bank_index, 0);

        assert_eq!(user.bank_balances[1].balance_type, BankBalanceType::Borrow);
        assert_eq!(user.bank_balances[1].balance, 1000001);

        assert_eq!(user.bank_balances[1].bank_index, 1);

        assert_eq!(
            get_token_amount(
                user.bank_balances[1].balance,
                &sol_bank,
                &BankBalanceType::Borrow
            )
            .unwrap(),
            10000010000 //10 decimals
        );

        // 80% from 2% bad
        let bank_backup = sol_bank;
        let user_backup = user;
        assert!(update_bank_balances_with_limits(
            100000 * 100000 * 40,
            &BankBalanceType::Borrow,
            &mut sol_bank,
            &mut user.bank_balances[1],
        )
        .is_err());
        sol_bank = bank_backup;
        user = user_backup;

        update_bank_balances_with_limits(
            100000 * 100000 * 6,
            &BankBalanceType::Borrow,
            &mut sol_bank,
            &mut user.bank_balances[1],
        )
        .unwrap();

        assert_eq!(sol_bank.deposit_balance, 50000000);
        assert_eq!(sol_bank.borrow_balance, 8000002);
        assert_eq!(sol_bank.borrow_token_twap, 0);
        update_bank_cumulative_interest(&mut sol_bank, now + 3655 * 24).unwrap();
        assert_eq!(sol_bank.deposit_token_twap, 500067287978);
        assert_eq!(sol_bank.borrow_token_twap, 80072095947);

        update_bank_balances_with_limits(
            100000 * 100000,
            &BankBalanceType::Borrow,
            &mut sol_bank,
            &mut user.bank_balances[1],
        )
        .unwrap();

        // cant withdraw when market is invalid => delayed update
        market.amm.last_update_slot = 8008;
        assert!(
            check_bank_market_valid(&market, &sol_bank, &mut user.bank_balances[1], 8009_u64)
                .is_err()
        );

        // ok to withdraw when market is valid
        market.amm.last_update_slot = 8009;
        market.amm.last_oracle_valid = true;
        check_bank_market_valid(&market, &sol_bank, &mut user.bank_balances[1], 8009_u64).unwrap();

        // ok to deposit when market is invalid
        update_bank_balances_with_limits(
            100000 * 100000 * 100,
            &BankBalanceType::Deposit,
            &mut sol_bank,
            &mut user.bank_balances[1],
        )
        .unwrap();

        check_bank_market_valid(&market, &sol_bank, &mut user.bank_balances[1], 100000_u64)
            .unwrap();
    }
    #[test]
    fn check_fee_collection() {
        let mut now = 0_i64;
        let slot = 0_u64;

        let mut oracle_price = get_pyth_price(100, 10);
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            oracle_price,
            &oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let _oracle_map = OracleMap::load_one(&oracle_account_info, slot).unwrap();

        let mut market = Market {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                quote_asset_amount_short: 50 * QUOTE_PRECISION_I128,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            open_interest: 1,
            initialized: true,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..Market::default()
        };
        create_anchor_account_info!(market, Market, market_account_info);
        let _market_map = MarketMap::load_one(&market_account_info, true).unwrap();

        let mut bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: BANK_WEIGHT_PRECISION,
            maintenance_asset_weight: BANK_WEIGHT_PRECISION,
            deposit_balance: QUOTE_PRECISION,
            borrow_balance: 0,
            deposit_token_twap: QUOTE_PRECISION / 2,

            // const optimalUtilization = BANK_RATE_PRECISION.div(new BN(2)); // 50% utilization
            // const optimalRate = BANK_RATE_PRECISION.mul(new BN(20)); // 2000% APR
            // const maxRate = BANK_RATE_PRECISION.mul(new BN(50)); // 5000% APR
            optimal_utilization: BANK_INTEREST_PRECISION / 2,
            optimal_borrow_rate: BANK_INTEREST_PRECISION * 20,
            max_borrow_rate: BANK_INTEREST_PRECISION * 50,
            ..Bank::default()
        };

        create_anchor_account_info!(bank, Bank, bank_account_info);
        let mut sol_bank = Bank {
            bank_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: oracle_price_key,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 10,
            initial_asset_weight: 8 * BANK_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * BANK_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * BANK_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * BANK_WEIGHT_PRECISION / 10,
            deposit_balance: BANK_INTEREST_PRECISION,
            borrow_balance: BANK_INTEREST_PRECISION,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 1000,
            ..Bank::default()
        };
        create_anchor_account_info!(sol_bank, Bank, sol_bank_account_info);
        let bank_account_infos = Vec::from([&bank_account_info, &sol_bank_account_info]);
        let _bank_map = BankMap::load_multiple(bank_account_infos, true).unwrap();

        let mut user_bank_balances = [UserBankBalance::default(); 8];
        user_bank_balances[0] = UserBankBalance {
            bank_index: 1,
            balance_type: BankBalanceType::Deposit,
            balance: BANK_INTEREST_PRECISION,
        };
        let mut user = User {
            orders: [Order::default(); 32],
            positions: [MarketPosition::default(); 5],
            bank_balances: user_bank_balances,
            ..User::default()
        };

        bank.user_if_factor = 900;
        bank.total_if_factor = 1000; //1_000_000

        assert_eq!(bank.utilization_twap, 0);
        assert_eq!(bank.deposit_balance, 1000000);
        assert_eq!(bank.borrow_balance, 0);

        let amount = QUOTE_PRECISION / 4;
        update_bank_balances_with_limits(
            (amount / 2) as u128,
            &BankBalanceType::Borrow,
            &mut bank,
            &mut user.bank_balances[1],
        )
        .unwrap();

        assert_eq!(bank.deposit_balance, 1000000);
        assert_eq!(bank.borrow_balance, 125001);
        assert_eq!(bank.utilization_twap, 0);

        update_bank_cumulative_interest(&mut bank, now + 100).unwrap();

        assert_eq!(bank.revenue_pool.balance, 0);
        assert_eq!(bank.cumulative_deposit_interest, 10000019799);
        assert_eq!(bank.cumulative_borrow_interest, 10000158551);
        assert_eq!(bank.last_interest_ts, 100);
        assert_eq!(bank.last_twap_ts, 100);
        assert_eq!(bank.utilization_twap, 144);

        let deposit_tokens_1 =
            get_token_amount(bank.deposit_balance, &bank, &BankBalanceType::Deposit).unwrap();
        let borrow_tokens_1 =
            get_token_amount(bank.borrow_balance, &bank, &BankBalanceType::Borrow).unwrap();
        let if_tokens_1 =
            get_token_amount(bank.revenue_pool.balance, &bank, &BankBalanceType::Borrow).unwrap();

        assert_eq!(deposit_tokens_1, 1000001);
        assert_eq!(borrow_tokens_1, 125002);
        assert_eq!(if_tokens_1, 0);

        update_bank_cumulative_interest(&mut bank, now + 7500).unwrap();

        assert_eq!(bank.last_interest_ts, 7500);
        assert_eq!(bank.last_twap_ts, 7500);
        assert_eq!(bank.utilization_twap, 10848);

        assert_eq!(bank.cumulative_deposit_interest, 10001484937);
        assert_eq!(bank.cumulative_borrow_interest, 10011891454);
        assert_eq!(bank.revenue_pool.balance, 0);

        let deposit_tokens_2 =
            get_token_amount(bank.deposit_balance, &bank, &BankBalanceType::Deposit).unwrap();
        let borrow_tokens_2 =
            get_token_amount(bank.borrow_balance, &bank, &BankBalanceType::Borrow).unwrap();
        let if_tokens_2 =
            get_token_amount(bank.revenue_pool.balance, &bank, &BankBalanceType::Borrow).unwrap();

        assert_eq!(deposit_tokens_2, 1_000_148);
        assert_eq!(borrow_tokens_2, 125_149);
        assert_eq!(if_tokens_2, 0);

        //assert >=0
        assert_eq!(
            (borrow_tokens_2 - borrow_tokens_1) - (deposit_tokens_2 - deposit_tokens_1),
            0
        );

        update_bank_cumulative_interest(&mut bank, now + 750 + (60 * 60 * 24 * 365)).unwrap();

        now = now + 750 + (60 * 60 * 24 * 365);

        assert_eq!(bank.cumulative_deposit_interest, 16257818378);
        assert_eq!(bank.cumulative_borrow_interest, 60112684636);
        assert_eq!(bank.revenue_pool.balance, 385);

        let deposit_tokens_3 =
            get_token_amount(bank.deposit_balance, &bank, &BankBalanceType::Deposit).unwrap();
        let borrow_tokens_3 =
            get_token_amount(bank.borrow_balance, &bank, &BankBalanceType::Borrow).unwrap();
        let if_tokens_3 =
            get_token_amount(bank.revenue_pool.balance, &bank, &BankBalanceType::Borrow).unwrap();

        assert_eq!(deposit_tokens_3, 1_626_407);
        assert_eq!(borrow_tokens_3, 751_414);
        assert_eq!(if_tokens_3, 2_314);

        assert_eq!((borrow_tokens_3 - borrow_tokens_2), 626265);
        assert_eq!((deposit_tokens_3 - deposit_tokens_2), 626259);

        // assert >= 0
        assert_eq!(
            (borrow_tokens_3 - borrow_tokens_2) - (deposit_tokens_3 - deposit_tokens_2),
            6
        );

        // settle IF pool to 100% utilization boundary
        assert_eq!(bank.revenue_pool.balance, 385);
        assert_eq!(bank.utilization_twap, 462007);

        let settle_amount = settle_revenue_to_insurance_fund(
            deposit_tokens_3 as u64,
            if_tokens_3 as u64,
            &mut bank,
            now + 60,
        )
        .unwrap();

        assert_eq!(if_tokens_3 - (settle_amount as u128), 1689);
        assert_eq!(settle_amount, 625);
        assert_eq!(bank.revenue_pool.balance, 0);
        assert_eq!(bank.utilization_twap, 462007);

        let deposit_tokens_4 =
            get_token_amount(bank.deposit_balance, &bank, &BankBalanceType::Deposit).unwrap();
        let borrow_tokens_4 =
            get_token_amount(bank.borrow_balance, &bank, &BankBalanceType::Borrow).unwrap();
        let if_tokens_4 =
            get_token_amount(bank.revenue_pool.balance, &bank, &BankBalanceType::Deposit).unwrap();

        assert_eq!(bank.borrow_token_twap, 751413);
        assert_eq!(bank.deposit_token_twap, 1626406);
        assert_eq!(
            bank.borrow_token_twap * BANK_UTILIZATION_PRECISION / bank.deposit_token_twap,
            462008
        ); // 47.4%

        assert_eq!(bank.utilization_twap, 462007); // 46.2%
        assert_eq!(
            borrow_tokens_4 * BANK_UTILIZATION_PRECISION / deposit_tokens_4,
            462194
        ); // 46.2%
        assert_eq!(BANK_UTILIZATION_PRECISION, 1000000); // 100%

        assert_eq!(deposit_tokens_4 - borrow_tokens_4, 874368);
        assert_eq!(if_tokens_4, 0);

        // one more day later, twap update
        update_bank_cumulative_interest(&mut bank, now + 60 + (60 * 60 * 24)).unwrap();

        let deposit_tokens_5 =
            get_token_amount(bank.deposit_balance, &bank, &BankBalanceType::Deposit).unwrap();
        let borrow_tokens_5 =
            get_token_amount(bank.borrow_balance, &bank, &BankBalanceType::Borrow).unwrap();
        let _if_tokens_5 =
            get_token_amount(bank.revenue_pool.balance, &bank, &BankBalanceType::Deposit).unwrap();

        assert_eq!(bank.borrow_token_twap, 789501);
        assert_eq!(bank.deposit_token_twap, 1663867);

        assert_eq!(
            bank.borrow_token_twap * BANK_UTILIZATION_PRECISION / bank.deposit_token_twap,
            474497
        ); // 47.4%
        assert_eq!(bank.utilization_twap, 474496); // 47.4%
        assert_eq!(
            borrow_tokens_5 * BANK_UTILIZATION_PRECISION / deposit_tokens_5,
            474497
        ); // 47.4%
        assert_eq!(BANK_UTILIZATION_PRECISION, 1000000); // 100%
    }

    #[test]
    fn check_fee_collection_larger_nums() {
        let mut now = 0_i64;
        let slot = 0_u64;

        let mut oracle_price = get_pyth_price(100, 10);
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            oracle_price,
            &oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let _oracle_map = OracleMap::load_one(&oracle_account_info, slot).unwrap();

        let mut market = Market {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                quote_asset_amount_short: 50 * QUOTE_PRECISION_I128,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            open_interest: 1,
            initialized: true,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..Market::default()
        };
        create_anchor_account_info!(market, Market, market_account_info);
        let _market_map = MarketMap::load_one(&market_account_info, true).unwrap();

        let mut bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: BANK_WEIGHT_PRECISION,
            maintenance_asset_weight: BANK_WEIGHT_PRECISION,
            deposit_balance: 1000000 * QUOTE_PRECISION,
            borrow_balance: 0,
            deposit_token_twap: QUOTE_PRECISION / 2,

            // const optimalUtilization = BANK_RATE_PRECISION.div(new BN(2)); // 50% utilization
            // const optimalRate = BANK_RATE_PRECISION.mul(new BN(20)); // 2000% APR
            // const maxRate = BANK_RATE_PRECISION.mul(new BN(50)); // 5000% APR
            optimal_utilization: BANK_INTEREST_PRECISION / 2,
            optimal_borrow_rate: BANK_INTEREST_PRECISION * 20,
            max_borrow_rate: BANK_INTEREST_PRECISION * 50,
            ..Bank::default()
        };

        create_anchor_account_info!(bank, Bank, bank_account_info);
        let mut sol_bank = Bank {
            bank_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: oracle_price_key,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 10,
            initial_asset_weight: 8 * BANK_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * BANK_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * BANK_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * BANK_WEIGHT_PRECISION / 10,
            deposit_balance: BANK_INTEREST_PRECISION,
            borrow_balance: BANK_INTEREST_PRECISION,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 1000,
            ..Bank::default()
        };
        create_anchor_account_info!(sol_bank, Bank, sol_bank_account_info);
        let bank_account_infos = Vec::from([&bank_account_info, &sol_bank_account_info]);
        let _bank_map = BankMap::load_multiple(bank_account_infos, true).unwrap();

        let mut user_bank_balances = [UserBankBalance::default(); 8];
        user_bank_balances[0] = UserBankBalance {
            bank_index: 1,
            balance_type: BankBalanceType::Deposit,
            balance: BANK_INTEREST_PRECISION,
        };
        let mut user = User {
            orders: [Order::default(); 32],
            positions: [MarketPosition::default(); 5],
            bank_balances: user_bank_balances,
            ..User::default()
        };

        bank.user_if_factor = 90_000;
        bank.total_if_factor = 100_000;

        assert_eq!(bank.utilization_twap, 0);
        assert_eq!(bank.deposit_balance, 1000000 * QUOTE_PRECISION);
        assert_eq!(bank.borrow_balance, 0);

        let amount = 540510 * QUOTE_PRECISION;
        update_bank_balances(
            amount as u128,
            &BankBalanceType::Borrow,
            &mut bank,
            &mut user.bank_balances[1],
            false,
        )
        .unwrap();

        assert_eq!(bank.deposit_balance, 1000000 * QUOTE_PRECISION);
        assert_eq!(bank.borrow_balance, 540510000001);
        assert_eq!(bank.utilization_twap, 0);

        update_bank_cumulative_interest(&mut bank, now + 100).unwrap();

        assert_eq!(bank.revenue_pool.balance, 3844266);
        assert_eq!(bank.cumulative_deposit_interest, 10000346004);
        assert_eq!(bank.cumulative_borrow_interest, 10000711270);
        assert_eq!(bank.last_interest_ts, 100);
        assert_eq!(bank.last_twap_ts, 100);
        assert_eq!(bank.utilization_twap, 625);

        let deposit_tokens_1 =
            get_token_amount(bank.deposit_balance, &bank, &BankBalanceType::Deposit).unwrap();
        let borrow_tokens_1 =
            get_token_amount(bank.borrow_balance, &bank, &BankBalanceType::Borrow).unwrap();
        let if_tokens_1 =
            get_token_amount(bank.revenue_pool.balance, &bank, &BankBalanceType::Deposit).unwrap();

        assert_eq!(deposit_tokens_1, 1000038444799);
        assert_eq!(borrow_tokens_1, 540548444855);
        assert_eq!(if_tokens_1, 3844399);

        update_bank_cumulative_interest(&mut bank, now + 7500).unwrap();

        assert_eq!(bank.last_interest_ts, 7500);
        assert_eq!(bank.last_twap_ts, 7500);
        assert_eq!(bank.utilization_twap, 46978);

        assert_eq!(bank.cumulative_deposit_interest, 10025953120);
        assert_eq!(bank.cumulative_borrow_interest, 10053351363);
        assert_eq!(bank.revenue_pool.balance, 287632340);

        let deposit_tokens_2 =
            get_token_amount(bank.deposit_balance, &bank, &BankBalanceType::Deposit).unwrap();
        let borrow_tokens_2 =
            get_token_amount(bank.borrow_balance, &bank, &BankBalanceType::Borrow).unwrap();
        let if_tokens_2 =
            get_token_amount(bank.revenue_pool.balance, &bank, &BankBalanceType::Deposit).unwrap();

        assert_eq!(deposit_tokens_2, 1002883690835);
        assert_eq!(borrow_tokens_2, 543393694522);
        assert_eq!(if_tokens_2, 288378835);

        //assert >=0
        assert_eq!(
            (borrow_tokens_2 - borrow_tokens_1) - (deposit_tokens_2 - deposit_tokens_1),
            3631
        );

        update_bank_cumulative_interest(&mut bank, now + 750 + (60 * 60 * 24 * 365)).unwrap();

        now = now + 750 + (60 * 60 * 24 * 365);

        assert_eq!(bank.cumulative_deposit_interest, 120056141117);
        assert_eq!(bank.cumulative_borrow_interest, 236304445676);
        assert_eq!(bank.revenue_pool.balance, 102149084835);

        let deposit_tokens_3 =
            get_token_amount(bank.deposit_balance, &bank, &BankBalanceType::Deposit).unwrap();
        let borrow_tokens_3 =
            get_token_amount(bank.borrow_balance, &bank, &BankBalanceType::Borrow).unwrap();
        let if_tokens_3 =
            get_token_amount(bank.revenue_pool.balance, &bank, &BankBalanceType::Deposit).unwrap();

        assert_eq!(deposit_tokens_3, 13231976606092);
        assert_eq!(borrow_tokens_3, 12772491593257);
        assert_eq!(if_tokens_3, 1226362494392);

        assert_eq!((borrow_tokens_3 - borrow_tokens_2), 12229097898735);
        assert_eq!((deposit_tokens_3 - deposit_tokens_2), 12229092915257);

        // assert >= 0
        assert_eq!(
            (borrow_tokens_3 - borrow_tokens_2) - (deposit_tokens_3 - deposit_tokens_2),
            4_983_478 //$4.98 missing
        );

        let mut if_balance_2 = 0;

        // settle IF pool to 100% utilization boundary
        // only half of depositors available claim was settled (to protect vault)
        assert_eq!(bank.revenue_pool.balance, 102149084835);
        let settle_amount = settle_revenue_to_insurance_fund(
            deposit_tokens_3 as u64,
            if_tokens_3 as u64,
            &mut bank,
            now + 60,
        )
        .unwrap();
        assert_eq!(settle_amount, 229742505997);

        if_balance_2 += settle_amount;
        assert_eq!(if_balance_2, 229742505997);
        assert_eq!(if_tokens_3 - (settle_amount as u128), 996619988395); // w/ update interest for settle_bank_to_if

        assert_eq!(bank.revenue_pool.balance, 83024042299);
        assert_eq!(bank.utilization_twap, 965273);

        let deposit_tokens_4 =
            get_token_amount(bank.deposit_balance, &bank, &BankBalanceType::Deposit).unwrap();
        let borrow_tokens_4 =
            get_token_amount(bank.borrow_balance, &bank, &BankBalanceType::Borrow).unwrap();
        let if_tokens_4 =
            get_token_amount(bank.revenue_pool.balance, &bank, &BankBalanceType::Deposit).unwrap();

        assert_eq!(deposit_tokens_4 - borrow_tokens_4, 229742505999);
        assert_eq!(if_tokens_4, 996833556274);
    }
}
