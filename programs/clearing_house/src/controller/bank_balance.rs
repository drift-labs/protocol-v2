use solana_program::msg;

use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::bank_balance::{
    calculate_accumulated_interest, get_bank_balance, get_token_amount, InterestAccumulated,
};
use crate::math::casting::cast_to_u64;
use crate::math_error;
use crate::state::bank::{Bank, BankBalance, BankBalanceType};
use crate::validate;

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

    if let BankBalanceType::Borrow = update_direction {
        let deposit_token_amount =
            get_token_amount(bank.deposit_balance, bank, &BankBalanceType::Deposit)?;
        let borrow_token_amount =
            get_token_amount(bank.borrow_balance, bank, &BankBalanceType::Borrow)?;

        validate!(
            deposit_token_amount >= borrow_token_amount,
            ErrorCode::BankInsufficientDeposits,
            "Bank has insufficent deposits to complete withdraw"
        )?
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
