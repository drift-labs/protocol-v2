use std::cell::{Ref, RefMut};

use anchor_lang::prelude::*;

use crate::math::collateral::calculate_updated_collateral;
use crate::math::constants::{BASE_ASSET_AMOUNT_PRECISION, USDC_PRECISION};
use crate::math::funding::calculate_funding_payment;
use crate::state::history::{FundingPaymentHistory, FundingPaymentRecord};
use crate::state::market::Markets;
use crate::state::market::AMM;
use crate::state::user::{User, UserPositions};

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
