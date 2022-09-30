use solana_program::msg;

use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::casting::{cast, cast_to_i128, cast_to_u64};
use crate::math::constants::{ONE_YEAR, SPOT_RATE_PRECISION, SPOT_UTILIZATION_PRECISION};
use crate::math_error;
use crate::state::oracle::OraclePriceData;
use crate::state::spot_market::{SpotBalanceType, SpotMarket};
use crate::state::user::SpotPosition;
use crate::validate;

pub fn get_spot_balance(
    token_amount: u128,
    spot_market: &SpotMarket,
    balance_type: &SpotBalanceType,
    round_up: bool,
) -> ClearingHouseResult<u128> {
    let precision_increase = 10_u128.pow(
        19_u8
            .checked_sub(spot_market.decimals)
            .ok_or_else(math_error!())?
            .into(),
    );

    let cumulative_interest = match balance_type {
        SpotBalanceType::Deposit => spot_market.cumulative_deposit_interest,
        SpotBalanceType::Borrow => spot_market.cumulative_borrow_interest,
    };

    let mut balance = token_amount
        .checked_mul(precision_increase)
        .ok_or_else(math_error!())?
        .checked_div(cumulative_interest)
        .ok_or_else(math_error!())?;

    if round_up && balance != 0 {
        balance = balance.checked_add(1).ok_or_else(math_error!())?;
    }

    Ok(balance)
}

pub fn get_token_amount(
    balance: u128,
    spot_market: &SpotMarket,
    balance_type: &SpotBalanceType,
) -> ClearingHouseResult<u128> {
    let precision_decrease = 10_u128.pow(
        19_u8
            .checked_sub(spot_market.decimals)
            .ok_or_else(math_error!())?
            .into(),
    );

    let cumulative_interest = match balance_type {
        SpotBalanceType::Deposit => spot_market.cumulative_deposit_interest,
        SpotBalanceType::Borrow => spot_market.cumulative_borrow_interest,
    };

    let token_amount = balance
        .checked_mul(cumulative_interest)
        .ok_or_else(math_error!())?
        .checked_div(precision_decrease)
        .ok_or_else(math_error!())?;

    Ok(token_amount)
}

pub fn get_signed_token_amount(
    token_amount: u128,
    balance_type: &SpotBalanceType,
) -> ClearingHouseResult<i128> {
    match balance_type {
        SpotBalanceType::Deposit => cast_to_i128(token_amount),
        SpotBalanceType::Borrow => cast_to_i128(token_amount).map(|token_amount| -token_amount),
    }
}

pub fn get_interest_token_amount(
    balance: u128,
    spot_market: &SpotMarket,
    interest: u128,
) -> ClearingHouseResult<u128> {
    let precision_decrease = 10_u128.pow(
        19_u8
            .checked_sub(spot_market.decimals)
            .ok_or_else(math_error!())?
            .into(),
    );

    let token_amount = balance
        .checked_mul(interest)
        .ok_or_else(math_error!())?
        .checked_div(precision_decrease)
        .ok_or_else(math_error!())?;

    Ok(token_amount)
}

pub struct InterestAccumulated {
    pub borrow_interest: u128,
    pub deposit_interest: u128,
}

pub fn calculate_utilization(
    deposit_token_amount: u128,
    borrow_token_amount: u128,
) -> ClearingHouseResult<u128> {
    let utilization = borrow_token_amount
        .checked_mul(SPOT_UTILIZATION_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(deposit_token_amount)
        .or({
            if deposit_token_amount == 0 && borrow_token_amount == 0 {
                Some(0_u128)
            } else {
                // if there are borrows without deposits, default to maximum utilization rate
                Some(SPOT_UTILIZATION_PRECISION)
            }
        })
        .unwrap();

    Ok(utilization)
}

pub fn calculate_accumulated_interest(
    spot_market: &SpotMarket,
    now: i64,
) -> ClearingHouseResult<InterestAccumulated> {
    let deposit_token_amount = get_token_amount(
        spot_market.deposit_balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?;
    let borrow_token_amount = get_token_amount(
        spot_market.borrow_balance,
        spot_market,
        &SpotBalanceType::Borrow,
    )?;

    let utilization = calculate_utilization(deposit_token_amount, borrow_token_amount)?;

    if utilization == 0 {
        return Ok(InterestAccumulated {
            borrow_interest: 0,
            deposit_interest: 0,
        });
    }

    let borrow_rate = if utilization > spot_market.optimal_utilization {
        let surplus_utilization = utilization
            .checked_sub(spot_market.optimal_utilization)
            .ok_or_else(math_error!())?;

        let borrow_rate_slope = spot_market
            .max_borrow_rate
            .checked_sub(spot_market.optimal_borrow_rate)
            .ok_or_else(math_error!())?
            .checked_mul(SPOT_UTILIZATION_PRECISION)
            .ok_or_else(math_error!())?
            .checked_div(
                SPOT_UTILIZATION_PRECISION
                    .checked_sub(spot_market.optimal_utilization)
                    .ok_or_else(math_error!())?,
            )
            .ok_or_else(math_error!())?;

        spot_market
            .optimal_borrow_rate
            .checked_add(
                surplus_utilization
                    .checked_mul(borrow_rate_slope)
                    .ok_or_else(math_error!())?
                    .checked_div(SPOT_UTILIZATION_PRECISION)
                    .ok_or_else(math_error!())?,
            )
            .ok_or_else(math_error!())?
    } else {
        let borrow_rate_slope = spot_market
            .optimal_borrow_rate
            .checked_mul(SPOT_UTILIZATION_PRECISION)
            .ok_or_else(math_error!())?
            .checked_div(spot_market.optimal_utilization)
            .ok_or_else(math_error!())?;

        utilization
            .checked_mul(borrow_rate_slope)
            .ok_or_else(math_error!())?
            .checked_div(SPOT_UTILIZATION_PRECISION)
            .ok_or_else(math_error!())?
    };

    let time_since_last_update = cast_to_u64(now)
        .or(Err(ErrorCode::UnableToCastUnixTime))?
        .checked_sub(spot_market.last_interest_ts)
        .ok_or_else(math_error!())?;

    // To save some compute units, have to multiply the rate by the `time_since_last_update` here
    // and then divide out by ONE_YEAR when calculating interest accumulated below
    let modified_borrow_rate = borrow_rate
        .checked_mul(time_since_last_update as u128)
        .ok_or_else(math_error!())?;

    let modified_deposit_rate = modified_borrow_rate
        .checked_mul(utilization)
        .ok_or_else(math_error!())?
        .checked_div(SPOT_UTILIZATION_PRECISION)
        .ok_or_else(math_error!())?;

    let borrow_interest = spot_market
        .cumulative_borrow_interest
        .checked_mul(modified_borrow_rate)
        .ok_or_else(math_error!())?
        .checked_div(ONE_YEAR)
        .ok_or_else(math_error!())?
        .checked_div(SPOT_RATE_PRECISION)
        .ok_or_else(math_error!())?
        .checked_add(1)
        .ok_or_else(math_error!())?;

    let deposit_interest = spot_market
        .cumulative_deposit_interest
        .checked_mul(modified_deposit_rate)
        .ok_or_else(math_error!())?
        .checked_div(ONE_YEAR)
        .ok_or_else(math_error!())?
        .checked_div(SPOT_RATE_PRECISION)
        .ok_or_else(math_error!())?;

    Ok(InterestAccumulated {
        borrow_interest,
        deposit_interest,
    })
}

pub fn get_balance_value_and_token_amount(
    spot_position: &SpotPosition,
    spot_market: &SpotMarket,
    oracle_price_data: &OraclePriceData,
) -> ClearingHouseResult<(u128, u128)> {
    let token_amount = spot_position.get_token_amount(spot_market)?;

    let precision_decrease = 10_u128.pow(spot_market.decimals as u32);

    let value = token_amount
        .checked_mul(cast(oracle_price_data.price)?)
        .ok_or_else(math_error!())?
        .checked_div(precision_decrease)
        .ok_or_else(math_error!())?;

    Ok((value, token_amount))
}

pub fn get_token_value(
    token_amount: i128,
    spot_decimals: u8,
    oracle_price_data: &OraclePriceData,
) -> ClearingHouseResult<i128> {
    if token_amount == 0 {
        return Ok(0);
    }

    let precision_decrease = 10_i128.pow(spot_decimals as u32);

    token_amount
        .checked_mul(oracle_price_data.price)
        .ok_or_else(math_error!())?
        .checked_div(precision_decrease)
        .ok_or_else(math_error!())
}

pub fn get_balance_value(
    spot_position: &SpotPosition,
    spot_market: &SpotMarket,
    oracle_price_data: &OraclePriceData,
) -> ClearingHouseResult<u128> {
    let (value, _) =
        get_balance_value_and_token_amount(spot_position, spot_market, oracle_price_data)?;
    Ok(value)
}

pub fn check_withdraw_limits(spot_market: &SpotMarket) -> ClearingHouseResult<bool> {
    let deposit_token_amount = get_token_amount(
        spot_market.deposit_balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?;
    let borrow_token_amount = get_token_amount(
        spot_market.borrow_balance,
        spot_market,
        &SpotBalanceType::Borrow,
    )?;

    let max_borrow_token = spot_market.withdraw_guard_threshold.max(
        (deposit_token_amount / 6)
            .max(
                spot_market
                    .borrow_token_twap
                    .checked_add(spot_market.borrow_token_twap / 5)
                    .ok_or_else(math_error!())?,
            )
            .min(
                deposit_token_amount
                    .checked_sub(deposit_token_amount / 10)
                    .ok_or_else(math_error!())?,
            ),
    ); // between ~15-90% utilization with friction on twap

    let min_deposit_token = spot_market
        .deposit_token_twap
        .checked_sub(
            (spot_market.deposit_token_twap / 5).max(
                spot_market
                    .withdraw_guard_threshold
                    .min(spot_market.deposit_token_twap),
            ),
        )
        .ok_or_else(math_error!())?;
    // friction to decrease utilization (if above withdraw guard threshold)

    let valid_withdrawal =
        deposit_token_amount >= min_deposit_token && borrow_token_amount <= max_borrow_token;

    if !valid_withdrawal {
        msg!(
            "withdraw_guard_threshold={:?}",
            spot_market.withdraw_guard_threshold
        );
        msg!("min_deposit_token={:?}", min_deposit_token);
        msg!("deposit_token_amount={:?}", deposit_token_amount);
        msg!("max_borrow_token={:?}", max_borrow_token);
        msg!("borrow_token_amount={:?}", borrow_token_amount);
    }

    Ok(valid_withdrawal)
}

pub fn validate_spot_balances(spot_market: &SpotMarket) -> ClearingHouseResult<u64> {
    let depositors_amount: u64 = cast(get_token_amount(
        spot_market.deposit_balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?)?;
    let borrowers_amount: u64 = cast(get_token_amount(
        spot_market.borrow_balance,
        spot_market,
        &SpotBalanceType::Borrow,
    )?)?;

    validate!(
        depositors_amount >= borrowers_amount,
        ErrorCode::DefaultError,
        "depositors_amount={} less than borrowers_amount={}",
        depositors_amount,
        borrowers_amount
    )?;

    let revenue_amount: u64 = cast(get_token_amount(
        spot_market.revenue_pool.balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?)?;

    let depositors_claim = depositors_amount - borrowers_amount;

    validate!(
        revenue_amount <= depositors_amount,
        ErrorCode::DefaultError,
        "revenue_amount={} greater or equal to the depositors_amount={} (depositors_claim={}, spot_market.deposit_balance={})",
        revenue_amount,
        depositors_amount,
        depositors_claim,
        spot_market.deposit_balance
    )?;

    Ok(depositors_claim)
}

pub fn validate_spot_market_amounts(
    spot_market: &SpotMarket,
    vault_amount: u64,
) -> ClearingHouseResult<u64> {
    let depositors_claim = validate_spot_balances(spot_market)?;

    validate!(
        vault_amount >= depositors_claim,
        ErrorCode::DefaultError,
        "spot market vault ={} holds less than remaining depositor claims = {}",
        vault_amount,
        depositors_claim
    )?;

    Ok(depositors_claim)
}
