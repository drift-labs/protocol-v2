use crate::math::oracle::oracle_validity;
use crate::state::state::ValidityGuardRails;
use std::cmp::max; //, OracleValidity};

use anchor_lang::prelude::*;
use solana_program::msg;

use crate::controller::spot_position::update_spot_balances_and_cumulative_deposits;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::amm::sanitize_new_price;
use crate::math::casting::{cast, cast_to_i128, cast_to_u128, cast_to_u64};
use crate::math::constants::{
    FIVE_MINUTE, IF_FACTOR_PRECISION, ONE_HOUR, QUOTE_SPOT_MARKET_INDEX, TWENTY_FOUR_HOUR,
};
use crate::math::spot_balance::{
    calculate_accumulated_interest, calculate_utilization, check_withdraw_limits,
    get_interest_token_amount, get_spot_balance, get_token_amount, InterestAccumulated,
};
use crate::math::stats::{calculate_new_twap, calculate_weighted_average};

use crate::state::events::SpotInterestRecord;
use crate::state::oracle::OraclePriceData;
use crate::state::perp_market::{MarketStatus, PerpMarket};
use crate::state::spot_market::{AssetTier, SpotBalance, SpotBalanceType, SpotMarket};
use crate::state::user::SpotPosition;
use crate::validate;

use crate::math::oracle::{is_oracle_valid_for_action, DriftAction};
use crate::math::safe_math::SafeMath;

#[cfg(test)]
mod tests;

pub fn update_spot_market_twap_stats(
    spot_market: &mut SpotMarket,
    oracle_price_data: Option<&OraclePriceData>,
    now: i64,
) -> ClearingHouseResult {
    let since_last = cast_to_i128(max(1, now.safe_sub(spot_market.last_twap_ts as i64)?))?;
    let from_start = max(1, cast_to_i128(TWENTY_FOUR_HOUR)?.safe_sub(since_last)?);

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

    spot_market.deposit_token_twap = cast(calculate_weighted_average(
        cast(deposit_token_amount)?,
        cast(spot_market.deposit_token_twap)?,
        since_last,
        from_start,
    )?)?;

    spot_market.borrow_token_twap = cast(calculate_weighted_average(
        cast(borrow_token_amount)?,
        cast(spot_market.borrow_token_twap)?,
        since_last,
        from_start,
    )?)?;

    let utilization = calculate_utilization(deposit_token_amount, borrow_token_amount)?;

    spot_market.utilization_twap = cast_to_u128(calculate_weighted_average(
        cast_to_i128(utilization)?,
        cast_to_i128(spot_market.utilization_twap)?,
        since_last,
        from_start,
    )?)?;

    if let Some(oracle_price_data) = oracle_price_data {
        let sanitize_clamp_denominator = spot_market.get_sanitize_clamp_denominator()?;

        let capped_oracle_update_price: i128 = sanitize_new_price(
            oracle_price_data.price,
            spot_market.historical_oracle_data.last_oracle_price_twap,
            sanitize_clamp_denominator,
        )?;

        let oracle_price_twap = calculate_new_twap(
            capped_oracle_update_price,
            now,
            spot_market.historical_oracle_data.last_oracle_price_twap,
            spot_market.historical_oracle_data.last_oracle_price_twap_ts,
            ONE_HOUR as i64,
        )?;

        let oracle_price_twap_5min = calculate_new_twap(
            capped_oracle_update_price,
            now,
            spot_market
                .historical_oracle_data
                .last_oracle_price_twap_5min,
            spot_market.historical_oracle_data.last_oracle_price_twap_ts,
            FIVE_MINUTE as i64,
        )?;

        spot_market.historical_oracle_data.last_oracle_price_twap = oracle_price_twap;
        spot_market
            .historical_oracle_data
            .last_oracle_price_twap_5min = oracle_price_twap_5min;

        spot_market.historical_oracle_data.last_oracle_price = oracle_price_data.price;
        spot_market.historical_oracle_data.last_oracle_conf = oracle_price_data.confidence;
        spot_market.historical_oracle_data.last_oracle_delay = oracle_price_data.delay;
        spot_market.historical_oracle_data.last_oracle_price_twap_ts = now;
    }

    spot_market.last_twap_ts = cast_to_u64(now)?;

    Ok(())
}

pub fn update_spot_market_cumulative_interest(
    spot_market: &mut SpotMarket,
    oracle_price_data: Option<&OraclePriceData>,
    now: i64,
) -> ClearingHouseResult {
    if spot_market.status == MarketStatus::FundingPaused {
        update_spot_market_twap_stats(spot_market, oracle_price_data, now)?;
        return Ok(());
    }

    let InterestAccumulated {
        deposit_interest,
        borrow_interest,
    } = calculate_accumulated_interest(spot_market, now)?;

    if deposit_interest > 0 && borrow_interest > 1 {
        // borrowers -> lenders IF fee here
        let deposit_interest_for_stakers = deposit_interest
            .safe_mul(spot_market.insurance_fund.total_factor as u128)?
            .safe_div(IF_FACTOR_PRECISION)?;

        let deposit_interest_for_lenders =
            deposit_interest.safe_sub(deposit_interest_for_stakers)?;

        if deposit_interest_for_lenders > 0 {
            spot_market.cumulative_deposit_interest = spot_market
                .cumulative_deposit_interest
                .safe_add(deposit_interest_for_lenders)?;

            spot_market.cumulative_borrow_interest = spot_market
                .cumulative_borrow_interest
                .safe_add(borrow_interest)?;
            spot_market.last_interest_ts = cast_to_u64(now)?;

            // add deposit_interest_for_stakers as balance for revenue_pool
            let token_amount = get_interest_token_amount(
                spot_market.deposit_balance,
                spot_market,
                deposit_interest_for_stakers,
            )?;

            update_revenue_pool_balances(token_amount, &SpotBalanceType::Deposit, spot_market)?;

            emit!(SpotInterestRecord {
                ts: now,
                market_index: spot_market.market_index,
                deposit_balance: spot_market.deposit_balance,
                cumulative_deposit_interest: spot_market.cumulative_deposit_interest,
                borrow_balance: spot_market.borrow_balance,
                cumulative_borrow_interest: spot_market.cumulative_borrow_interest,
                optimal_utilization: spot_market.optimal_utilization,
                optimal_borrow_rate: spot_market.optimal_borrow_rate,
                max_borrow_rate: spot_market.max_borrow_rate,
            });
        }
    }

    update_spot_market_twap_stats(spot_market, oracle_price_data, now)?;

    Ok(())
}

pub fn update_revenue_pool_balances(
    token_amount: u128,
    update_direction: &SpotBalanceType,
    spot_market: &mut SpotMarket,
) -> ClearingHouseResult {
    let mut spot_balance = spot_market.revenue_pool;
    update_spot_balances(
        token_amount,
        update_direction,
        spot_market,
        &mut spot_balance,
        false,
    )?;
    spot_market.revenue_pool = spot_balance;

    Ok(())
}

pub fn update_spot_balances(
    mut token_amount: u128,
    update_direction: &SpotBalanceType,
    spot_market: &mut SpotMarket,
    spot_balance: &mut dyn SpotBalance,
    force_round_up: bool,
) -> ClearingHouseResult {
    let increase_user_existing_balance = update_direction == spot_balance.balance_type();
    if increase_user_existing_balance {
        let round_up = spot_balance.balance_type() == &SpotBalanceType::Borrow;
        let balance_delta =
            get_spot_balance(token_amount, spot_market, update_direction, round_up)?;
        spot_balance.increase_balance(balance_delta)?;
        increase_spot_balance(balance_delta, spot_market, update_direction)?;
    } else {
        let current_token_amount = get_token_amount(
            spot_balance.balance(),
            spot_market,
            spot_balance.balance_type(),
        )?;

        let reduce_user_existing_balance = current_token_amount != 0;
        if reduce_user_existing_balance {
            // determine how much to reduce balance based on size of current token amount
            let (token_delta, balance_delta) = if current_token_amount > token_amount {
                let round_up =
                    force_round_up || spot_balance.balance_type() == &SpotBalanceType::Borrow;
                let balance_delta = get_spot_balance(
                    token_amount,
                    spot_market,
                    spot_balance.balance_type(),
                    round_up,
                )?;
                (token_amount, balance_delta)
            } else {
                (current_token_amount, spot_balance.balance())
            };

            decrease_spot_balance(balance_delta, spot_market, spot_balance.balance_type())?;
            spot_balance.decrease_balance(balance_delta)?;
            token_amount = token_amount.safe_sub(token_delta)?;
        }

        if token_amount > 0 {
            spot_balance.update_balance_type(*update_direction)?;
            let round_up = update_direction == &SpotBalanceType::Borrow;
            let balance_delta =
                get_spot_balance(token_amount, spot_market, update_direction, round_up)?;
            spot_balance.increase_balance(balance_delta)?;
            increase_spot_balance(balance_delta, spot_market, update_direction)?;
        }
    }

    if let SpotBalanceType::Borrow = update_direction {
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

        validate!(
            deposit_token_amount >= borrow_token_amount,
            ErrorCode::SpotMarketInsufficientDeposits,
            "Spot Market has insufficent deposits to complete withdraw: deposits ({}) borrows ({})",
            deposit_token_amount,
            borrow_token_amount
        )?;
    }

    Ok(())
}

pub fn transfer_spot_balances(
    token_amount: i128,
    spot_market: &mut SpotMarket,
    from_spot_balance: &mut dyn SpotBalance,
    to_spot_balance: &mut dyn SpotBalance,
) -> ClearingHouseResult {
    validate!(
        from_spot_balance.market_index() == to_spot_balance.market_index(),
        ErrorCode::DefaultError,
        "transfer market indexes arent equal",
    )?;

    if token_amount == 0 {
        return Ok(());
    }

    update_spot_balances(
        token_amount.unsigned_abs(),
        if token_amount < 0 {
            &SpotBalanceType::Deposit
        } else {
            &SpotBalanceType::Borrow
        },
        spot_market,
        from_spot_balance,
        false,
    )?;

    update_spot_balances(
        token_amount.unsigned_abs(),
        if token_amount < 0 {
            &SpotBalanceType::Borrow
        } else {
            &SpotBalanceType::Deposit
        },
        spot_market,
        to_spot_balance,
        false,
    )?;

    Ok(())
}

pub fn transfer_revenue_pool_to_spot_balance(
    token_amount: u128,
    spot_market: &mut SpotMarket,
    to_spot_balance: &mut dyn SpotBalance,
) -> ClearingHouseResult {
    validate!(
        to_spot_balance.market_index() == spot_market.market_index,
        ErrorCode::DefaultError,
        "transfer market indexes arent equal",
    )?;

    update_revenue_pool_balances(token_amount, &SpotBalanceType::Borrow, spot_market)?;

    update_spot_balances(
        token_amount,
        &SpotBalanceType::Deposit,
        spot_market,
        to_spot_balance,
        false,
    )?;

    Ok(())
}

pub fn transfer_spot_balance_to_revenue_pool(
    token_amount: u128,
    spot_market: &mut SpotMarket,
    from_spot_balance: &mut dyn SpotBalance,
) -> ClearingHouseResult {
    validate!(
        from_spot_balance.market_index() == spot_market.market_index,
        ErrorCode::DefaultError,
        "transfer market indexes arent equal",
    )?;

    update_spot_balances(
        token_amount,
        &SpotBalanceType::Borrow,
        spot_market,
        from_spot_balance,
        false,
    )?;

    update_revenue_pool_balances(token_amount, &SpotBalanceType::Deposit, spot_market)?;

    Ok(())
}

pub fn update_spot_balances_and_cumulative_deposits_with_limits(
    token_amount: u128,
    update_direction: &SpotBalanceType,
    spot_market: &mut SpotMarket,
    spot_position: &mut SpotPosition,
) -> ClearingHouseResult {
    update_spot_balances_and_cumulative_deposits(
        token_amount,
        update_direction,
        spot_market,
        spot_position,
        true,
        None,
    )?;

    let valid_withdraw = check_withdraw_limits(spot_market)?;

    validate!(
        valid_withdraw,
        ErrorCode::DailyWithdrawLimit,
        "Spot Market {} has hit daily withdraw limit",
        spot_market.market_index
    )?;

    validate!(
        matches!(
            spot_market.status,
            MarketStatus::Active
                | MarketStatus::AmmPaused
                | MarketStatus::FundingPaused
                | MarketStatus::FillPaused
                | MarketStatus::ReduceOnly
                | MarketStatus::Settlement
        ),
        ErrorCode::MarketActionPaused,
        "Spot Market {} withdraws are currently paused",
        spot_market.market_index
    )?;

    validate!(
        !(spot_market.asset_tier == AssetTier::Protected
            && spot_position.balance_type() == &SpotBalanceType::Borrow),
        ErrorCode::AssetTierViolation,
        "Spot Market {} has Protected status and cannot be borrowed",
        spot_market.market_index
    )?;

    Ok(())
}

pub fn check_perp_market_valid(
    perp_market: &PerpMarket,
    spot_market: &SpotMarket,
    spot_balance: &mut dyn SpotBalance,
    current_slot: u64,
) -> ClearingHouseResult {
    // todo

    if perp_market.amm.oracle == spot_market.oracle
        && spot_balance.balance_type() == &SpotBalanceType::Borrow
        && (perp_market.amm.last_update_slot != current_slot || !perp_market.amm.last_oracle_valid)
    {
        return Err(ErrorCode::InvalidOracle);
    }

    Ok(())
}
pub fn update_spot_market_and_check_validity(
    spot_market: &mut SpotMarket,
    oracle_price_data: &OraclePriceData,
    validity_guard_rails: &ValidityGuardRails,
    now: i64,
    action: Option<DriftAction>,
) -> ClearingHouseResult {
    // update spot market EMAs with new/current data
    update_spot_market_cumulative_interest(spot_market, Some(oracle_price_data), now)?;

    if spot_market.market_index == QUOTE_SPOT_MARKET_INDEX {
        return Ok(());
    }

    // 1 hour EMA
    let risk_ema_price = spot_market.historical_oracle_data.last_oracle_price_twap;

    let oracle_validity = oracle_validity(risk_ema_price, oracle_price_data, validity_guard_rails)?;

    validate!(
        is_oracle_valid_for_action(oracle_validity, action)?,
        ErrorCode::InvalidOracle,
        "Invalid Oracle ({:?} vs ema={:?}) for spot market index={} and action={:?}",
        oracle_price_data,
        risk_ema_price,
        spot_market.market_index,
        action
    )?;

    Ok(())
}

fn increase_spot_balance(
    delta: u128,
    spot_market: &mut SpotMarket,
    balance_type: &SpotBalanceType,
) -> ClearingHouseResult {
    match balance_type {
        SpotBalanceType::Deposit => {
            spot_market.deposit_balance = spot_market.deposit_balance.safe_add(delta)?
        }
        SpotBalanceType::Borrow => {
            spot_market.borrow_balance = spot_market.borrow_balance.safe_add(delta)?
        }
    }

    Ok(())
}

fn decrease_spot_balance(
    delta: u128,
    spot_market: &mut SpotMarket,
    balance_type: &SpotBalanceType,
) -> ClearingHouseResult {
    match balance_type {
        SpotBalanceType::Deposit => {
            spot_market.deposit_balance = spot_market.deposit_balance.safe_sub(delta)?
        }
        SpotBalanceType::Borrow => {
            spot_market.borrow_balance = spot_market.borrow_balance.safe_sub(delta)?
        }
    }

    Ok(())
}
