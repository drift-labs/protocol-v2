use std::cell::{Ref, RefMut};
use std::cmp::max;

use anchor_lang::prelude::*;

use crate::error::*;
use crate::math::amm;
use crate::math::collateral::calculate_updated_collateral;
use crate::math::constants::{
    AMM_ASSET_AMOUNT_PRECISION, FUNDING_PAYMENT_MANTISSA, MARK_PRICE_MANTISSA, USDC_PRECISION,
};
use crate::math::funding::calculate_funding_payment;
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

        if amm.cumulative_funding_rate != market_position.last_cumulative_funding_rate {
            let market_funding_rate_payment = calculate_funding_payment(amm, market_position)?;

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
                amm_cumulative_funding: amm.cumulative_funding_rate, //10e14
                base_asset_amount: market_position.base_asset_amount, //10e13
            });

            funding_payment = funding_payment
                .checked_add(market_funding_rate_payment)
                .ok_or_else(math_error!())?;

            market_position.last_cumulative_funding_rate = amm.cumulative_funding_rate;
            market_position.last_funding_rate_ts = amm.last_funding_rate_ts;
        }
    }

    // longs pay shorts the `funding_payment`
    let funding_payment_collateral = funding_payment
        .checked_div(
            AMM_ASSET_AMOUNT_PRECISION
                .checked_div(USDC_PRECISION)
                .ok_or_else(math_error!())? as i128,
        )
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
) -> ClearingHouseResult {
    let time_since_last_update = now.checked_sub(market.amm.last_funding_rate_ts).unwrap();

    let mark_price_twap = amm::update_mark_twap(&mut market.amm, now)?;

    let block_funding_rate_update =
        oracle::block_funding_rate_update(&market.amm, price_oracle, clock_slot, guard_rails)?;

    // round next update time to be available on the hour
    let mut next_update_wait = market.amm.funding_period;
    if market.amm.funding_period > 1 {
        let last_update_delay = market
            .amm
            .funding_period
            .rem_euclid(market.amm.funding_period);
        if last_update_delay != 0 {
            if last_update_delay > market.amm.funding_period.checked_div(4).unwrap(){
                // too late for on the hour next period, delay to following period
                next_update_wait = market
                .amm
                .funding_period
                .checked_mul(2)
                .unwrap()
                .checked_sub(last_update_delay)
                .unwrap();
            } else{
                // allow update on the hour
                next_update_wait = market
                .amm
                .funding_period
                .checked_sub(last_update_delay)
                .unwrap();
            }
        }
    }

    if !funding_paused
        && !block_funding_rate_update
        && time_since_last_update >= next_update_wait 
    {
        let one_hour: u32 = 3600;
        let period_adjustment = (24_i64)
            .checked_mul(one_hour as i64)
            .ok_or_else(math_error!())?
            .checked_div(max(1, market.amm.funding_period))
            .ok_or_else(math_error!())?;
        // funding period = 1 hour, window = 1 day
        // low periodicity => quickly updating/settled funding rates => lower funding rate payment per interval
        let (oracle_price_twap, price_spread) =
            amm::calculate_oracle_mark_spread(&market.amm, price_oracle, one_hour, clock_slot)?;
        let funding_rate = price_spread
            .checked_mul(FUNDING_PAYMENT_MANTISSA as i128)
            .ok_or_else(math_error!())?
            .checked_div(period_adjustment as i128)
            .ok_or_else(math_error!())?;

        let mut haircut_numerator = 0;
        if market.base_asset_amount_long == 0 && market.base_asset_amount_short == 0 {
            // no positions, no funding
            // pass
        } else if market.base_asset_amount == 0 {
            market.amm.cumulative_funding_rate_long = market
                .amm
                .cumulative_funding_rate_long
                .checked_add(funding_rate)
                .ok_or_else(math_error!())?;

            market.amm.cumulative_funding_rate_short = market
                .amm
                .cumulative_funding_rate_short
                .checked_add(funding_rate)
                .ok_or_else(math_error!())?;
        } else if market.base_asset_amount > 0 {
            // assert(market.base_asset_amount_long > market.base_asset_amount);
            // more longs that shorts

            if market.base_asset_amount_short.unsigned_abs() > 0 {
                haircut_numerator = market.base_asset_amount_short.unsigned_abs();
            }

            let funding_rate_long_haircut = haircut_numerator
                .checked_mul(MARK_PRICE_MANTISSA)
                .ok_or_else(math_error!())?
                .checked_div(market.base_asset_amount_long as u128)
                .ok_or_else(math_error!())?;

            let funding_rate_long = funding_rate
                .checked_mul(funding_rate_long_haircut as i128)
                .ok_or_else(math_error!())?
                .checked_div(MARK_PRICE_MANTISSA as i128)
                .ok_or_else(math_error!())?;

            market.amm.cumulative_funding_rate_long = market
                .amm
                .cumulative_funding_rate_long
                .checked_add(funding_rate_long)
                .ok_or_else(math_error!())?;

            if funding_rate_long != 0 {
                market.amm.cumulative_funding_rate_short = market
                .amm
                .cumulative_funding_rate_short
                .checked_add(funding_rate)
                .ok_or_else(math_error!())?;
            }
            
        } else {
            // more shorts than longs
            if market.base_asset_amount_long.unsigned_abs() > 0 {
                haircut_numerator = market.base_asset_amount_long.unsigned_abs();
            }

            let funding_rate_short_haircut = haircut_numerator
                .checked_mul(MARK_PRICE_MANTISSA)
                .ok_or_else(math_error!())?
                .checked_div(market.base_asset_amount_short.unsigned_abs())
                .ok_or_else(math_error!())?;

            let funding_rate_short = funding_rate
                .checked_mul(funding_rate_short_haircut as i128)
                .ok_or_else(math_error!())?
                .checked_div(MARK_PRICE_MANTISSA as i128)
                .ok_or_else(math_error!())?;

            market.amm.cumulative_funding_rate_short = market
                .amm
                .cumulative_funding_rate_short
                .checked_add(funding_rate_short)
                .ok_or_else(math_error!())?;

            if funding_rate_short != 0 {
                market.amm.cumulative_funding_rate_long = market
                .amm
                .cumulative_funding_rate_long
                .checked_add(funding_rate)
                .ok_or_else(math_error!())?;
            }
           
        }

        let cumulative_funding_rate = market
            .amm
            .cumulative_funding_rate
            .checked_add(funding_rate)
            .ok_or_else(math_error!())?;

        market.amm.cumulative_funding_rate = cumulative_funding_rate;
        market.amm.last_funding_rate = funding_rate;
        market.amm.last_funding_rate_ts = now;

        let record_id = funding_rate_history.next_record_id();
        funding_rate_history.append(FundingRateRecord {
            ts: now,
            record_id,
            market_index,
            funding_rate,
            cumulative_funding_rate,
            mark_price_twap,
            oracle_price_twap,
        });
    }

    Ok(())
}
