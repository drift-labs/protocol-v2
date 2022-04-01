use std::cell::{Ref, RefMut};
use std::cmp::{max, min};

use anchor_lang::prelude::*;

use crate::error::*;
use crate::math::amm;
use crate::math::amm::normalise_oracle_price;
use crate::math::casting::{cast, cast_to_i128};
use crate::math::collateral::calculate_updated_collateral;
use crate::math::constants::{
    AMM_TO_QUOTE_PRECISION_RATIO_I128, FUNDING_PAYMENT_PRECISION, ONE_HOUR, TWENTYFOUR_HOUR,
};
use crate::math::funding::{calculate_funding_payment, calculate_funding_rate_long_short};
use crate::math::oracle;
use crate::math_error;
use crate::state::history::funding_payment::{FundingPaymentHistory, FundingPaymentRecord};
use crate::state::history::funding_rate::{FundingRateHistory, FundingRateRecord};
use crate::state::market::AMM;
use crate::state::market::{Market, Markets};
use crate::state::state::OracleGuardRails;
use crate::state::user::{User, UserPositions};
use solana_program::clock::UnixTimestamp;
use solana_program::msg;

/// Funding payments are settled lazily. The amm tracks its cumulative funding rate (for longs and shorts)
/// and the user's market position tracks how much funding the user been cumulatively paid for that market.
/// If the two values are not equal, the user owes/is owed funding.
pub fn settle_funding_payment(
    user: &mut User,
    user_positions: &mut RefMut<UserPositions>,
    markets: &Ref<Markets>,
    funding_payment_history: &mut RefMut<FundingPaymentHistory>,
    now: UnixTimestamp,
) -> ClearingHouseResult {
    let user_key = user_positions.user;
    let mut funding_payment: i128 = 0;
    for market_position in user_positions.positions.iter_mut() {
        if market_position.base_asset_amount == 0 {
            continue;
        }

        let market = &markets.markets[Markets::index_from_u64(market_position.market_index)];
        let amm: &AMM = &market.amm;

        let amm_cumulative_funding_rate = if market_position.base_asset_amount > 0 {
            amm.cumulative_funding_rate_long
        } else {
            amm.cumulative_funding_rate_short
        };

        if amm_cumulative_funding_rate != market_position.last_cumulative_funding_rate {
            let market_funding_rate_payment =
                calculate_funding_payment(amm_cumulative_funding_rate, market_position)?;

            let record_id = funding_payment_history.next_record_id();
            funding_payment_history.append(FundingPaymentRecord {
                ts: now,
                record_id,
                user_authority: user.authority,
                user: user_key,
                market_index: market_position.market_index,
                funding_payment: market_funding_rate_payment, //10e13
                user_last_cumulative_funding: market_position.last_cumulative_funding_rate, //10e14
                user_last_funding_rate_ts: market_position.last_funding_rate_ts,
                amm_cumulative_funding_long: amm.cumulative_funding_rate_long, //10e14
                amm_cumulative_funding_short: amm.cumulative_funding_rate_short, //10e14
                base_asset_amount: market_position.base_asset_amount,          //10e13
            });

            funding_payment = funding_payment
                .checked_add(market_funding_rate_payment)
                .ok_or_else(math_error!())?;

            market_position.last_cumulative_funding_rate = amm_cumulative_funding_rate;
            market_position.last_funding_rate_ts = amm.last_funding_rate_ts;
        }
    }

    let funding_payment_collateral = funding_payment
        .checked_div(AMM_TO_QUOTE_PRECISION_RATIO_I128)
        .ok_or_else(math_error!())?;

    user.collateral = calculate_updated_collateral(user.collateral, funding_payment_collateral)?;

    Ok(())
}

pub fn update_funding_rate(
    market_index: u64,
    market: &mut Market,
    price_oracle: &AccountInfo,
    now: UnixTimestamp,
    clock_slot: u64,
    funding_rate_history: &mut RefMut<FundingRateHistory>,
    guard_rails: &OracleGuardRails,
    funding_paused: bool,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult {
    let time_since_last_update = now
        .checked_sub(market.amm.last_funding_rate_ts)
        .ok_or_else(math_error!())?;

    // Pause funding if oracle is invalid or if mark/oracle spread is too divergent
    let (block_funding_rate_update, oracle_price_data) = oracle::block_operation(
        &market.amm,
        price_oracle,
        clock_slot,
        guard_rails,
        precomputed_mark_price,
    )?;
    let normalised_oracle_price =
        normalise_oracle_price(&market.amm, &oracle_price_data, precomputed_mark_price)?;

    // round next update time to be available on the hour
    let mut next_update_wait = market.amm.funding_period;
    if market.amm.funding_period > 1 {
        let last_update_delay = market
            .amm
            .last_funding_rate_ts
            .rem_euclid(market.amm.funding_period);
        if last_update_delay != 0 {
            let max_delay_for_next_period = market
                .amm
                .funding_period
                .checked_div(3)
                .ok_or_else(math_error!())?;
            if last_update_delay > max_delay_for_next_period {
                // too late for on the hour next period, delay to following period
                next_update_wait = market
                    .amm
                    .funding_period
                    .checked_mul(2)
                    .ok_or_else(math_error!())?
                    .checked_sub(last_update_delay)
                    .ok_or_else(math_error!())?;
            } else {
                // allow update on the hour
                next_update_wait = market
                    .amm
                    .funding_period
                    .checked_sub(last_update_delay)
                    .ok_or_else(math_error!())?;
            }
        }
    }

    if !funding_paused && !block_funding_rate_update && time_since_last_update >= next_update_wait {
        let oracle_price_twap =
            amm::update_oracle_price_twap(&mut market.amm, now, normalised_oracle_price)?;
        let mark_price_twap = amm::update_mark_twap(&mut market.amm, now, None)?;

        let period_adjustment = TWENTYFOUR_HOUR
            .checked_div(max(ONE_HOUR, market.amm.funding_period))
            .ok_or_else(math_error!())?;
        // funding period = 1 hour, window = 1 day
        // low periodicity => quickly updating/settled funding rates => lower funding rate payment per interval
        let price_spread = cast_to_i128(mark_price_twap)?
            .checked_sub(oracle_price_twap)
            .ok_or_else(math_error!())?;

        // clamp price divergence to 3% for funding rate calculation
        let max_price_spread = oracle_price_twap
            .checked_div(33)
            .ok_or_else(math_error!())?; // 3%
        let clamped_price_spread = max(-max_price_spread, min(price_spread, max_price_spread));

        let funding_rate = clamped_price_spread
            .checked_mul(cast(FUNDING_PAYMENT_PRECISION)?)
            .ok_or_else(math_error!())?
            .checked_div(cast(period_adjustment)?)
            .ok_or_else(math_error!())?;

        let (funding_rate_long, funding_rate_short) =
            calculate_funding_rate_long_short(market, funding_rate)?;

        market.amm.cumulative_funding_rate_long = market
            .amm
            .cumulative_funding_rate_long
            .checked_add(funding_rate_long)
            .ok_or_else(math_error!())?;

        market.amm.cumulative_funding_rate_short = market
            .amm
            .cumulative_funding_rate_short
            .checked_add(funding_rate_short)
            .ok_or_else(math_error!())?;

        market.amm.last_funding_rate = funding_rate;
        market.amm.last_funding_rate_ts = now;
        market.amm.net_revenue_since_last_funding = 0;

        let record_id = funding_rate_history.next_record_id();
        funding_rate_history.append(FundingRateRecord {
            ts: now,
            record_id,
            market_index,
            funding_rate,
            cumulative_funding_rate_long: market.amm.cumulative_funding_rate_long,
            cumulative_funding_rate_short: market.amm.cumulative_funding_rate_short,
            mark_price_twap,
            oracle_price_twap,
        });
    }

    Ok(())
}
