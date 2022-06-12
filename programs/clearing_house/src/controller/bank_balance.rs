use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::bank_balance::{
    get_bank_balance, get_cumulative_interest_delta, get_token_amount, CumulativeInterestDelta,
};
use crate::math::casting::{cast, cast_to_u64};
use crate::math_error;
use crate::state::bank::Bank;
use crate::state::user::{BankBalanceType, UserBankBalance};
use solana_program::msg;

pub fn update_bank_cumulative_interest(bank: &mut Bank, now: i64) -> ClearingHouseResult {
    let CumulativeInterestDelta {
        deposit_delta,
        borrow_delta,
    } = get_cumulative_interest_delta(bank, now)?;

    bank.cumulative_deposit_interest = bank
        .cumulative_deposit_interest
        .checked_add(deposit_delta)
        .ok_or_else(math_error!())?;

    bank.cumulative_borrow_interest = bank
        .cumulative_borrow_interest
        .checked_add(borrow_delta)
        .ok_or_else(math_error!())?;

    Ok(())
}

pub fn update_bank_balances(
    mut token_amount: u128,
    update_type: &BankBalanceType,
    bank: &mut Bank,
    user_bank_balance: &mut UserBankBalance,
) -> ClearingHouseResult {
    if update_type == &user_bank_balance.balance_type {
        let balance_delta = get_bank_balance(token_amount, bank, update_type)?;
        increase_user_bank_balance(balance_delta, user_bank_balance)?;
        increase_bank_balance(balance_delta, bank, update_type)?;
    } else {
        let current_token_amount = get_token_amount(
            user_bank_balance.balance,
            bank,
            &user_bank_balance.balance_type,
        )?;

        if token_amount > current_token_amount && current_token_amount != 0 {
            // must update the bank balance first as next line modifies the user bank balance
            decrease_bank_balance(
                user_bank_balance.balance,
                bank,
                &user_bank_balance.balance_type,
            )?;
            decrease_user_bank_balance(user_bank_balance.balance, user_bank_balance)?;
            token_amount = token_amount
                .checked_sub(current_token_amount)
                .ok_or_else(math_error!())?;
        }

        user_bank_balance.balance_type = update_type.clone();
        let balance_delta = get_bank_balance(token_amount, bank, update_type)?;
        increase_user_bank_balance(balance_delta, user_bank_balance)?;
        increase_bank_balance(balance_delta, bank, update_type)?;
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
