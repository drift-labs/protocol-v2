use solana_program::msg;

use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::casting::{cast, cast_to_u64};
use crate::math::constants::{BANK_INTEREST_PRECISION, BANK_UTILIZATION_PRECISION, ONE_YEAR};
use crate::math_error;
use crate::state::bank::{Bank, BankBalanceType};
use crate::state::oracle::OraclePriceData;
use crate::state::user::UserBankBalance;

pub fn get_bank_balance(
    token_amount: u128,
    bank: &Bank,
    balance_type: &BankBalanceType,
) -> ClearingHouseResult<u128> {
    let precision_increase = 10_u128.pow(
        16_u8
            .checked_sub(bank.decimals)
            .ok_or_else(math_error!())?
            .into(),
    );

    let cumulative_interest = match balance_type {
        BankBalanceType::Deposit => bank.cumulative_deposit_interest,
        BankBalanceType::Borrow => bank.cumulative_borrow_interest,
    };

    let mut balance = token_amount
        .checked_mul(precision_increase)
        .ok_or_else(math_error!())?
        .checked_div(cumulative_interest)
        .ok_or_else(math_error!())?;

    if balance != 0 && balance_type == &BankBalanceType::Borrow {
        balance = balance.checked_add(1).ok_or_else(math_error!())?;
    }

    Ok(balance)
}

pub fn get_token_amount(
    balance: u128,
    bank: &Bank,
    balance_type: &BankBalanceType,
) -> ClearingHouseResult<u128> {
    let precision_decrease = 10_u128.pow(
        16_u8
            .checked_sub(bank.decimals)
            .ok_or_else(math_error!())?
            .into(),
    );

    let cumulative_interest = match balance_type {
        BankBalanceType::Deposit => bank.cumulative_deposit_interest,
        BankBalanceType::Borrow => bank.cumulative_borrow_interest,
    };

    let token_amount = balance
        .checked_mul(cumulative_interest)
        .ok_or_else(math_error!())?
        .checked_div(precision_decrease)
        .ok_or_else(math_error!())?;

    Ok(token_amount)
}

pub struct InterestAccumulated {
    pub borrow_interest: u128,
    pub deposit_interest: u128,
}

pub fn calculate_accumulated_interest(
    bank: &Bank,
    now: i64,
) -> ClearingHouseResult<InterestAccumulated> {
    let deposit_token_amount =
        get_token_amount(bank.deposit_balance, bank, &BankBalanceType::Deposit)?;
    let borrow_token_amount =
        get_token_amount(bank.borrow_balance, bank, &BankBalanceType::Borrow)?;

    let utilization = borrow_token_amount
        .checked_mul(BANK_UTILIZATION_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(deposit_token_amount)
        .or({
            if deposit_token_amount == 0 && borrow_token_amount == 0 {
                Some(0_u128)
            } else {
                // if there are borrows without deposits, default to maximum utilization rate
                Some(BANK_UTILIZATION_PRECISION)
            }
        })
        .unwrap();

    if utilization == 0 {
        return Ok(InterestAccumulated {
            borrow_interest: 0,
            deposit_interest: 0,
        });
    }

    let borrow_rate = if utilization > bank.optimal_utilization {
        let surplus_utilization = utilization
            .checked_sub(bank.optimal_utilization)
            .ok_or_else(math_error!())?;

        let borrow_rate_slope = bank
            .max_borrow_rate
            .checked_sub(bank.optimal_borrow_rate)
            .ok_or_else(math_error!())?
            .checked_mul(BANK_UTILIZATION_PRECISION)
            .ok_or_else(math_error!())?
            .checked_div(
                BANK_UTILIZATION_PRECISION
                    .checked_sub(bank.optimal_utilization)
                    .ok_or_else(math_error!())?,
            )
            .ok_or_else(math_error!())?;

        bank.optimal_borrow_rate
            .checked_add(
                surplus_utilization
                    .checked_mul(borrow_rate_slope)
                    .ok_or_else(math_error!())?
                    .checked_div(BANK_UTILIZATION_PRECISION)
                    .ok_or_else(math_error!())?,
            )
            .ok_or_else(math_error!())?
    } else {
        let borrow_rate_slope = bank
            .optimal_borrow_rate
            .checked_mul(BANK_UTILIZATION_PRECISION)
            .ok_or_else(math_error!())?
            .checked_div(bank.optimal_utilization)
            .ok_or_else(math_error!())?;

        utilization
            .checked_mul(borrow_rate_slope)
            .ok_or_else(math_error!())?
            .checked_div(BANK_UTILIZATION_PRECISION)
            .ok_or_else(math_error!())?
    };

    let time_since_last_update = cast_to_u64(now)
        .or(Err(ErrorCode::UnableToCastUnixTime))?
        .checked_sub(bank.last_updated)
        .ok_or_else(math_error!())?;

    // To save some compute units, have to multiply the rate by the `time_since_last_update` here
    // and then divide out by ONE_YEAR when calculating interest accumulated below
    let modified_borrow_rate = borrow_rate
        .checked_mul(time_since_last_update as u128)
        .ok_or_else(math_error!())?;

    let modified_deposit_rate = modified_borrow_rate
        .checked_mul(utilization)
        .ok_or_else(math_error!())?
        .checked_div(BANK_UTILIZATION_PRECISION)
        .ok_or_else(math_error!())?;

    let borrow_interest = bank
        .cumulative_borrow_interest
        .checked_mul(modified_borrow_rate)
        .ok_or_else(math_error!())?
        .checked_div(ONE_YEAR)
        .ok_or_else(math_error!())?
        .checked_div(BANK_INTEREST_PRECISION)
        .ok_or_else(math_error!())?
        .checked_add(1)
        .ok_or_else(math_error!())?;

    let deposit_interest = bank
        .cumulative_deposit_interest
        .checked_mul(modified_deposit_rate)
        .ok_or_else(math_error!())?
        .checked_div(ONE_YEAR)
        .ok_or_else(math_error!())?
        .checked_div(BANK_INTEREST_PRECISION)
        .ok_or_else(math_error!())?;

    Ok(InterestAccumulated {
        borrow_interest,
        deposit_interest,
    })
}

pub fn get_balance_value(
    bank_balance: &UserBankBalance,
    bank: &Bank,
    oracle_price_data: &OraclePriceData,
) -> ClearingHouseResult<u128> {
    let token_amount = get_token_amount(bank_balance.balance, bank, &bank_balance.balance_type)?;

    let precision_decrease = 10_u128.pow(10_u32 + (bank.decimals - 6) as u32);

    let value = token_amount
        .checked_mul(cast(oracle_price_data.price)?)
        .ok_or_else(math_error!())?
        .checked_div(precision_decrease)
        .ok_or_else(math_error!())?;

    Ok(value)
}
