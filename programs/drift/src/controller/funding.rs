use std::cmp::max;

use anchor_lang::prelude::*;
use solana_program::clock::UnixTimestamp;

use crate::controller::amm::formulaic_update_k;
use crate::controller::position::{
    get_position_index, update_quote_asset_and_break_even_amount, PositionDirection,
};
use crate::error::DriftResult;
use crate::get_then_update_id;
use crate::math::amm;
use crate::math::casting::Cast;
use crate::math::constants::{
    FUNDING_RATE_BUFFER, FUNDING_RATE_OFFSET_DENOMINATOR, ONE_HOUR_I128, TWENTY_FOUR_HOUR,
};
use crate::math::funding::{calculate_funding_payment, calculate_funding_rate_long_short};
use crate::math::helpers::on_the_hour_update;
use crate::math::safe_math::SafeMath;
use crate::math::stats::calculate_new_twap;

use crate::math::oracle;

use crate::state::events::{FundingPaymentRecord, FundingRateRecord};
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::{PerpMarket, AMM};
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::state::OracleGuardRails;
use crate::state::user::User;

pub fn settle_funding_payment(
    user: &mut User,
    user_key: &Pubkey,
    market: &mut PerpMarket,
    now: UnixTimestamp,
) -> DriftResult {
    let position_index = match get_position_index(&user.perp_positions, market.market_index) {
        Ok(position_index) => position_index,
        Err(_) => return Ok(()),
    };

    if user.perp_positions[position_index].base_asset_amount == 0 {
        return Ok(());
    }

    let amm: &AMM = &market.amm;

    let amm_cumulative_funding_rate = if user.perp_positions[position_index].base_asset_amount > 0 {
        amm.cumulative_funding_rate_long
    } else {
        amm.cumulative_funding_rate_short
    };

    if amm_cumulative_funding_rate
        != user.perp_positions[position_index]
            .last_cumulative_funding_rate
            .cast()?
    {
        let market_funding_payment = calculate_funding_payment(
            amm_cumulative_funding_rate,
            &user.perp_positions[position_index],
        )?;

        user.update_cumulative_perp_funding(market_funding_payment)?;

        let market_position = &mut user.perp_positions[position_index];

        emit!(FundingPaymentRecord {
            ts: now,
            user_authority: user.authority,
            user: *user_key,
            market_index: market_position.market_index,
            funding_payment: market_funding_payment, //10e13
            user_last_cumulative_funding: market_position.last_cumulative_funding_rate, //10e14
            amm_cumulative_funding_long: amm.cumulative_funding_rate_long, //10e14
            amm_cumulative_funding_short: amm.cumulative_funding_rate_short, //10e14
            base_asset_amount: market_position.base_asset_amount, //10e13
        });

        market_position.last_cumulative_funding_rate = amm_cumulative_funding_rate.cast()?;
        update_quote_asset_and_break_even_amount(market_position, market, market_funding_payment)?;
    }

    Ok(())
}

pub fn settle_funding_payments(
    user: &mut User,
    user_key: &Pubkey,
    perp_market_map: &PerpMarketMap,
    now: UnixTimestamp,
) -> DriftResult {
    for position_index in 0..user.perp_positions.len() {
        if user.perp_positions[position_index].base_asset_amount == 0 {
            continue;
        }

        let market =
            &mut perp_market_map.get_ref_mut(&user.perp_positions[position_index].market_index)?;
        let amm: &AMM = &market.amm;

        let amm_cumulative_funding_rate =
            if user.perp_positions[position_index].base_asset_amount > 0 {
                amm.cumulative_funding_rate_long
            } else {
                amm.cumulative_funding_rate_short
            };

        if amm_cumulative_funding_rate
            != user.perp_positions[position_index]
                .last_cumulative_funding_rate
                .cast()?
        {
            let market_funding_payment = calculate_funding_payment(
                amm_cumulative_funding_rate,
                &user.perp_positions[position_index],
            )?;

            user.update_cumulative_perp_funding(market_funding_payment)?;

            let market_position = &mut user.perp_positions[position_index];

            emit!(FundingPaymentRecord {
                ts: now,
                user_authority: user.authority,
                user: *user_key,
                market_index: market_position.market_index,
                funding_payment: market_funding_payment, //1e6
                user_last_cumulative_funding: market_position.last_cumulative_funding_rate, //1e9
                amm_cumulative_funding_long: amm.cumulative_funding_rate_long, //1e9
                amm_cumulative_funding_short: amm.cumulative_funding_rate_short, //1e9
                base_asset_amount: market_position.base_asset_amount, //1e9
            });

            market_position.last_cumulative_funding_rate = amm_cumulative_funding_rate.cast()?;
            update_quote_asset_and_break_even_amount(
                market_position,
                market,
                market_funding_payment,
            )?;
        }
    }

    Ok(())
}

#[allow(clippy::comparison_chain)]
pub fn update_funding_rate(
    market_index: u16,
    market: &mut PerpMarket,
    oracle_map: &mut OracleMap,
    now: UnixTimestamp,
    slot: u64,
    guard_rails: &OracleGuardRails,
    funding_paused: bool,
    precomputed_reserve_price: Option<u64>,
) -> DriftResult<bool> {
    let reserve_price = match precomputed_reserve_price {
        Some(reserve_price) => reserve_price,
        None => market.amm.reserve_price()?,
    };
    // Pause funding if oracle is invalid or if mark/oracle spread is too divergent
    let block_funding_rate_update = oracle::block_operation(
        market,
        oracle_map.get_price_data(&market.amm.oracle)?,
        guard_rails,
        Some(reserve_price),
        slot,
    )?;

    let time_until_next_update = on_the_hour_update(
        now,
        market.amm.last_funding_rate_ts,
        market.amm.funding_period,
    )?;

    let valid_funding_update =
        !funding_paused && !block_funding_rate_update && (time_until_next_update == 0);

    if valid_funding_update {
        let oracle_price_data = oracle_map.get_price_data(&market.amm.oracle)?;
        let sanitize_clamp_denominator = market.get_sanitize_clamp_denominator()?;

        let oracle_price_twap = amm::update_oracle_price_twap(
            &mut market.amm,
            now,
            oracle_price_data,
            Some(reserve_price),
            sanitize_clamp_denominator,
        )?;

        // price relates to execution premium / direction
        let (execution_premium_price, execution_premium_direction) =
            if market.amm.long_spread > market.amm.short_spread {
                (
                    market.amm.ask_price(reserve_price)?,
                    Some(PositionDirection::Long),
                )
            } else if market.amm.long_spread < market.amm.short_spread {
                (
                    market.amm.bid_price(reserve_price)?,
                    Some(PositionDirection::Short),
                )
            } else {
                (reserve_price, None)
            };

        let sanitize_clamp_denominator = market.get_sanitize_clamp_denominator()?;
        let mid_price_twap = amm::update_mark_twap_from_estimates(
            &mut market.amm,
            now,
            Some(execution_premium_price),
            execution_premium_direction,
            sanitize_clamp_denominator,
        )?;

        let period_adjustment = (24_i128)
            .safe_mul(ONE_HOUR_I128)?
            .safe_div(max(ONE_HOUR_I128, market.amm.funding_period as i128))?;
        // funding period = 1 hour, window = 1 day
        // low periodicity => quickly updating/settled funding rates => lower funding rate payment per interval
        let price_spread = mid_price_twap.cast::<i64>()?.safe_sub(oracle_price_twap)?;

        // add offset 1/FUNDING_RATE_OFFSET_DENOMINATOR*365. if FUNDING_RATE_OFFSET_DENOMINATOR = 5000 => 7.3% annualized rate
        let price_spread_with_offset = price_spread.safe_add(
            oracle_price_twap
                .abs()
                .safe_div(FUNDING_RATE_OFFSET_DENOMINATOR)?,
        )?;

        // clamp price divergence based on contract tier for funding rate calculation
        let max_price_spread =
            market.get_max_price_divergence_for_funding_rate(oracle_price_twap)?;
        let clamped_price_spread =
            price_spread_with_offset.clamp(-max_price_spread, max_price_spread);

        let funding_rate = clamped_price_spread
            .cast::<i128>()?
            .safe_mul(FUNDING_RATE_BUFFER.cast()?)?
            .safe_div(period_adjustment.cast()?)?
            .cast::<i64>()?;

        let (funding_rate_long, funding_rate_short, funding_imbalance_revenue) =
            calculate_funding_rate_long_short(market, funding_rate.cast()?)?;

        if market.amm.curve_update_intensity > 0 {
            // if funding_imbalance_revenue is positive, protocol receives.
            // if funding_imbalance_cost is positive, protocol spends.
            let funding_imbalance_cost = -funding_imbalance_revenue;
            formulaic_update_k(market, oracle_price_data, funding_imbalance_cost, now)?;

            if market.amm.amm_jit_intensity > 200 {
                // reset target base amount per lp
                market.amm.target_base_asset_amount_per_lp = market
                    .amm
                    .get_reset_target_base_asset_amount_per_lp()?
                    .cast()?;
            }
        }

        market.amm.cumulative_funding_rate_long = market
            .amm
            .cumulative_funding_rate_long
            .safe_add(funding_rate_long)?;

        market.amm.cumulative_funding_rate_short = market
            .amm
            .cumulative_funding_rate_short
            .safe_add(funding_rate_short)?;

        market.amm.last_funding_rate = funding_rate;
        market.amm.last_funding_rate_long = funding_rate_long.cast()?;
        market.amm.last_funding_rate_short = funding_rate_short.cast()?;
        market.amm.last_24h_avg_funding_rate = calculate_new_twap(
            funding_rate,
            now,
            market.amm.last_24h_avg_funding_rate,
            market.amm.last_funding_rate_ts,
            TWENTY_FOUR_HOUR,
        )?;
        market.amm.last_funding_rate_ts = now;

        emit!(FundingRateRecord {
            ts: now,
            record_id: get_then_update_id!(market, next_funding_rate_record_id),
            market_index,
            funding_rate,
            funding_rate_long,
            funding_rate_short,
            cumulative_funding_rate_long: market.amm.cumulative_funding_rate_long,
            cumulative_funding_rate_short: market.amm.cumulative_funding_rate_short,
            mark_price_twap: mid_price_twap,
            oracle_price_twap,
            period_revenue: market.amm.net_revenue_since_last_funding,
            base_asset_amount_with_amm: market.amm.base_asset_amount_with_amm,
            base_asset_amount_with_unsettled_lp: market.amm.base_asset_amount_with_unsettled_lp,
        });

        market.amm.net_revenue_since_last_funding = 0;
    } else {
        return Ok(false);
    }

    Ok(true)
}
