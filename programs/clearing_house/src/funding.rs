use crate::math::bn;
use crate::math::collateral::calculate_updated_collateral;
use crate::math::constants::{
    BASE_ASSET_AMOUNT_PRECISION, FUNDING_PAYMENT_MANTISSA, MARK_PRICE_MANTISSA, USDC_PRECISION,
};
use crate::state::history::{FundingPaymentHistory, FundingPaymentRecord};
use crate::state::market::{Markets, AMM};
use crate::state::user::{MarketPosition, User, UserPositions};
use anchor_lang::prelude::*;
use std::cell::{Ref, RefMut};

pub fn settle_funding_payment(
    user: &mut User,
    user_positions: &mut RefMut<UserPositions>,
    markets: &Ref<Markets>,
    funding_payment_history: &mut RefMut<FundingPaymentHistory>,
) {
    let clock = Clock::get().unwrap();
    let now = clock.unix_timestamp;

    let user_key = user_positions.user;
    let mut funding_payment: i128 = 0;
    for market_position in user_positions.positions.iter_mut() {
        if market_position.base_asset_amount == 0 {
            continue;
        }

        let market = &markets.markets[Markets::index_from_u64(market_position.market_index)];
        let amm: &AMM = &market.amm;

        if amm.cumulative_funding_rate != market_position.last_cumulative_funding_rate {
            let market_funding_rate_payment = calculate_funding_payment(amm, market_position);

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
                .unwrap();

            market_position.last_cumulative_funding_rate = amm.cumulative_funding_rate;
            market_position.last_funding_rate_ts = amm.last_funding_rate_ts;
        }
    }

    // longs pay shorts the `funding_payment`
    let funding_payment_collateral = funding_payment
        .checked_div(
            BASE_ASSET_AMOUNT_PRECISION
                .checked_div(USDC_PRECISION)
                .unwrap() as i128,
        )
        .unwrap();

    user.collateral = calculate_updated_collateral(user.collateral, funding_payment_collateral);
}

fn calculate_funding_payment(amm: &AMM, market_position: &MarketPosition) -> i128 {
    let funding_rate_delta = amm
        .cumulative_funding_rate
        .checked_sub(market_position.last_cumulative_funding_rate)
        .unwrap();
    let funding_rate_delta_sign: i128 = if funding_rate_delta > 0 { 1 } else { -1 } as i128;

    let funding_rate_payment_mag = bn::U256::from(funding_rate_delta.unsigned_abs())
        .checked_mul(bn::U256::from(
            market_position.base_asset_amount.unsigned_abs(),
        ))
        .unwrap()
        .checked_div(bn::U256::from(MARK_PRICE_MANTISSA))
        .unwrap()
        .checked_div(bn::U256::from(FUNDING_PAYMENT_MANTISSA))
        .unwrap()
        .try_to_u128()
        .unwrap() as i128;

    // funding_rate is: longs pay shorts
    let funding_rate_payment_sign: i128 = if market_position.base_asset_amount > 0 {
        -1
    } else {
        1
    } as i128;

    let funding_rate_payment = (funding_rate_payment_mag)
        .checked_mul(funding_rate_payment_sign)
        .unwrap()
        .checked_mul(funding_rate_delta_sign)
        .unwrap();

    return funding_rate_payment;
}
