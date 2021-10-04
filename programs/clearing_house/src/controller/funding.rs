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
use crate::math_error;
use crate::state::history::{FundingPaymentHistory, FundingPaymentRecord};
use crate::state::market::AMM;
use crate::state::market::{Market, Markets};
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
    market: &mut Market,
    price_oracle: &AccountInfo,
    now: UnixTimestamp,
) -> ClearingHouseResult {
    let time_since_last_update = now - market.amm.last_funding_rate_ts;

    market.amm.last_mark_price_twap = amm::calculate_new_mark_twap(&market.amm, now)?;
    market.amm.last_mark_price_twap_ts = now;

    if time_since_last_update >= market.amm.funding_period {
        let one_hour: u32 = 3600;
        let period_adjustment = (24_i64)
            .checked_mul(one_hour as i64)
            .ok_or_else(math_error!())?
            .checked_div(max(1, market.amm.funding_period))
            .ok_or_else(math_error!())?;
        // funding period = 1 hour, window = 1 day
        // low periodicity => quickly updating/settled funding rates => lower funding rate payment per interval
        let price_spread = amm::calculate_oracle_mark_spread(&market.amm, price_oracle, one_hour)?;
        let funding_rate = price_spread
            .checked_mul(FUNDING_PAYMENT_MANTISSA as i128)
            .ok_or_else(math_error!())?
            .checked_div(period_adjustment as i128)
            .ok_or_else(math_error!())?;

        let mut haircut_numerator = 0;

        if market.base_asset_amount == 0 {
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

            market.amm.cumulative_funding_rate_short = market
                .amm
                .cumulative_funding_rate_short
                .checked_add(funding_rate)
                .ok_or_else(math_error!())?;
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

            market.amm.cumulative_funding_rate_long = market
                .amm
                .cumulative_funding_rate_long
                .checked_add(funding_rate)
                .ok_or_else(math_error!())?;
        }

        let cum_funding_rate = market
            .amm
            .cumulative_funding_rate
            .checked_add(funding_rate)
            .ok_or_else(math_error!())?;

        market.amm.cumulative_funding_rate = cum_funding_rate;
        market.amm.last_funding_rate = funding_rate;
        market.amm.last_funding_rate_ts = now;
        market.amm.last_mark_price_twap = market.amm.base_asset_price_with_mantissa()?;
        market.amm.last_mark_price_twap_ts = now;
    }

    Ok(())
}
