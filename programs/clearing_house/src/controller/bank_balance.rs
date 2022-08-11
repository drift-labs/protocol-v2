use solana_program::msg;

use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::amm::calculate_weighted_average;
use crate::math::bank_balance::{
    calculate_accumulated_interest, get_bank_balance, get_token_amount, InterestAccumulated,
};
use crate::math::casting::{cast, cast_to_i128, cast_to_u64};
use crate::math_error;
use crate::state::bank::{Bank, BankBalance, BankBalanceType};
use crate::validate;
use std::cmp::{max, min};

pub fn update_bank_cumulative_interest(bank: &mut Bank, now: i64) -> ClearingHouseResult {
    let InterestAccumulated {
        deposit_interest,
        borrow_interest,
    } = calculate_accumulated_interest(bank, now)?;

    if deposit_interest > 0 && borrow_interest > 1 {
        bank.cumulative_deposit_interest = bank
            .cumulative_deposit_interest
            .checked_add(deposit_interest)
            .ok_or_else(math_error!())?;

        bank.cumulative_borrow_interest = bank
            .cumulative_borrow_interest
            .checked_add(borrow_interest)
            .ok_or_else(math_error!())?;

        let since_last = cast_to_i128(max(
            1,
            now.checked_sub(bank.last_updated as i64)
                .ok_or_else(math_error!())?,
        ))?;
        let from_start = max(
            1,
            cast_to_i128(60 * 60 * 24)?
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

        bank.last_updated = cast_to_u64(now)?;
    }

    Ok(())
}

pub fn update_bank_balances(
    mut token_amount: u128,
    update_direction: &BankBalanceType,
    bank: &mut Bank,
    bank_balance: &mut dyn BankBalance,
) -> ClearingHouseResult {
    let increase_user_existing_balance = update_direction == bank_balance.balance_type();
    if increase_user_existing_balance {
        let balance_delta = get_bank_balance(token_amount, bank, update_direction)?;
        bank_balance.increase_balance(balance_delta)?;
        increase_bank_balance(balance_delta, bank, update_direction)?;
    } else {
        let current_token_amount =
            get_token_amount(bank_balance.balance(), bank, bank_balance.balance_type())?;

        let reduce_user_existing_balance = current_token_amount != 0;
        if reduce_user_existing_balance {
            // determine how much to reduce balance based on size of current token amount
            let (token_delta, balance_delta) = if current_token_amount > token_amount {
                let balance_delta =
                    get_bank_balance(token_amount, bank, bank_balance.balance_type())?;
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
            let balance_delta = get_bank_balance(token_amount, bank, update_direction)?;
            bank_balance.increase_balance(balance_delta)?;
            increase_bank_balance(balance_delta, bank, update_direction)?;
        }
    }

    let deposit_token_amount =
        get_token_amount(bank.deposit_balance, bank, &BankBalanceType::Deposit)?;
    let borrow_token_amount =
        get_token_amount(bank.borrow_balance, bank, &BankBalanceType::Borrow)?;
    if let BankBalanceType::Borrow = update_direction {
        validate!(
            deposit_token_amount >= borrow_token_amount,
            ErrorCode::BankInsufficientDeposits,
            "Bank has insufficent deposits to complete withdraw"
        )?;

        let max_borrow_token = max(
            bank.deposit_token_twap / 20,
            bank.borrow_token_twap
                .checked_add(bank.borrow_token_twap / 5)
                .ok_or_else(math_error!())?,
        );

        validate!(
            borrow_token_amount > max_borrow_token,
            ErrorCode::BankInsufficientDeposits,
            "Bank has hit max daily borrow limit"
        )?;
    } else {
        let min_deposit_token = bank
            .deposit_token_twap
            .checked_sub(bank.deposit_token_twap / 5)
            .ok_or_else(math_error!())?;

        validate!(
            deposit_token_amount < min_deposit_token,
            ErrorCode::BankInsufficientDeposits,
            "Bank has hit max daily withdrawal limit"
        )?;
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
