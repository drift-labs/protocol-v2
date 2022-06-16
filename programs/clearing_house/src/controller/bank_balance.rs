use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::bank_balance::{
    calculate_accumulated_interest, get_bank_balance, get_token_amount, InterestAccumulated,
};
use crate::math::casting::cast_to_u64;
use crate::math_error;
use crate::state::bank::Bank;
use crate::state::user::{BankBalanceType, UserBankBalance};
use crate::validate;
use solana_program::msg;

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

// TODO get rid of weird update_against_market once we handle unrealized pnl
pub fn update_bank_balances(
    mut token_amount: u128,
    update_direction: &BankBalanceType,
    bank: &mut Bank,
    user_bank_balance: &mut UserBankBalance,
    update_against_market: bool,
) -> ClearingHouseResult {
    let increase_user_existing_balance = update_direction == &user_bank_balance.balance_type;
    if increase_user_existing_balance {
        let balance_delta = get_bank_balance(token_amount, bank, update_direction)?;
        increase_user_bank_balance(balance_delta, user_bank_balance)?;

        // Dont modify bank balance if user is updating against market and it's a deposit balance
        if !(update_against_market && update_direction == &BankBalanceType::Deposit) {
            increase_bank_balance(balance_delta, bank, update_direction)?;
        }
    } else {
        let current_token_amount = get_token_amount(
            user_bank_balance.balance,
            bank,
            &user_bank_balance.balance_type,
        )?;

        let reduce_user_existing_balance = current_token_amount != 0;
        if reduce_user_existing_balance {
            // determine how much to reduce balance based on size of current token amount
            let (token_delta, balance_delta) = if current_token_amount > token_amount {
                let balance_delta =
                    get_bank_balance(token_amount, bank, &user_bank_balance.balance_type)?;
                (token_amount, balance_delta)
            } else {
                (current_token_amount, user_bank_balance.balance)
            };

            // Dont modify bank balance if user is updating against market and it's a deposit balance
            if !(update_against_market
                && user_bank_balance.balance_type == BankBalanceType::Deposit)
            {
                decrease_bank_balance(balance_delta, bank, &user_bank_balance.balance_type)?;
            }
            decrease_user_bank_balance(balance_delta, user_bank_balance)?;
            token_amount = token_amount
                .checked_sub(token_delta)
                .ok_or_else(math_error!())?;
        }

        if token_amount > 0 {
            user_bank_balance.balance_type = *update_direction;
            let balance_delta = get_bank_balance(token_amount, bank, update_direction)?;
            increase_user_bank_balance(balance_delta, user_bank_balance)?;
            if !(update_against_market && update_direction == &BankBalanceType::Deposit) {
                increase_bank_balance(balance_delta, bank, update_direction)?;
            }
        }
    }

    // reset state if balance reaches zero
    if user_bank_balance.balance == 0 {
        *user_bank_balance = UserBankBalance::default();
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

fn increase_user_bank_balance(
    delta: u128,
    user_bank_balance: &mut UserBankBalance,
) -> ClearingHouseResult {
    user_bank_balance.balance = user_bank_balance
        .balance
        .checked_add(delta)
        .ok_or_else(math_error!())?;

    Ok(())
}

fn decrease_user_bank_balance(
    delta: u128,
    user_bank_balance: &mut UserBankBalance,
) -> ClearingHouseResult {
    user_bank_balance.balance = user_bank_balance
        .balance
        .checked_sub(delta)
        .ok_or_else(math_error!())?;

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
