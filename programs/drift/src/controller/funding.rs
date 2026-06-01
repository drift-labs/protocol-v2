use std::cmp::max;

use anchor_lang::prelude::*;
use solana_program::clock::UnixTimestamp;

use crate::controller::position::{
    get_position_index, update_quote_asset_and_break_even_amount, PositionDirection,
};
use crate::error::DriftResult;
use crate::get_then_update_id;
use crate::math::casting::Cast;
use crate::math::constants::{
    FUNDING_RATE_BUFFER, FUNDING_RATE_CLAMP_DENOMINATOR, FUNDING_RATE_OFFSET_DENOMINATOR,
    ONE_HOUR_I128, TWENTY_FOUR_HOUR,
};
use crate::math::funding::{calculate_funding_payment, calculate_funding_rate_long_short};
use crate::math::helpers::on_the_hour_update;
use crate::math::safe_math::SafeMath;
use crate::math::stats::calculate_new_twap;

use crate::math::oracle;

use crate::state::events::{CurveRecord, FundingPaymentRecord, FundingRateRecord};
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::PerpMarket;
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

    let amm_cumulative_funding_rate = if user.perp_positions[position_index].base_asset_amount > 0 {
        market.cumulative_funding_rate_long
    } else {
        market.cumulative_funding_rate_short
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
            amm_cumulative_funding_long: market.cumulative_funding_rate_long, //10e14
            amm_cumulative_funding_short: market.cumulative_funding_rate_short, //10e14
            base_asset_amount: market_position.base_asset_amount, //10e13
        });

        market_position.last_cumulative_funding_rate = amm_cumulative_funding_rate.cast()?;
        update_quote_asset_and_break_even_amount(market_position, market, market_funding_payment)?;
        market.net_unsettled_funding_pnl = market
            .net_unsettled_funding_pnl
            .safe_sub(market_funding_payment)?;
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

        let amm_cumulative_funding_rate =
            if user.perp_positions[position_index].base_asset_amount > 0 {
                market.cumulative_funding_rate_long
            } else {
                market.cumulative_funding_rate_short
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
                amm_cumulative_funding_long: market.cumulative_funding_rate_long, //1e9
                amm_cumulative_funding_short: market.cumulative_funding_rate_short, //1e9
                base_asset_amount: market_position.base_asset_amount, //1e9
            });

            market_position.last_cumulative_funding_rate = amm_cumulative_funding_rate.cast()?;
            update_quote_asset_and_break_even_amount(
                market_position,
                market,
                market_funding_payment,
            )?;
            market.net_unsettled_funding_pnl = market
                .net_unsettled_funding_pnl
                .safe_sub(market_funding_payment)?;
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
        oracle_map.get_price_data(&market.oracle_id())?,
        guard_rails,
        reserve_price,
        slot,
    )?;

    let time_until_next_update = on_the_hour_update(
        now,
        market.last_funding_rate_ts,
        market.market_stats.funding_period,
    )?;

    let valid_funding_update =
        !funding_paused && !block_funding_rate_update && (time_until_next_update == 0);

    if valid_funding_update {
        let oracle_price_data = oracle_map.get_price_data(&market.oracle_id())?;
        let sanitize_clamp_denominator = market.get_sanitize_clamp_denominator()?;
        let mm_oracle_price_data =
            market.get_mm_oracle_price_data(*oracle_price_data, slot, &guard_rails.validity)?;

        let funding_period = market.market_stats.funding_period;
        let oracle_price_twap = {
            let crate::state::perp_market::PerpMarket {
                amm, market_stats, ..
            } = &mut *market;
            market_stats.update_oracle_twap(
                amm,
                now,
                &mm_oracle_price_data,
                Some(reserve_price),
                sanitize_clamp_denominator,
                funding_period,
            )?
        };

        // Materialise the AMM's current spread / spread-reserves state on
        // demand (no longer cached on AMM). Threaded into `AmmQuoter` for the
        // funding event handler below.
        let amm_quote_state = crate::amm::math::spread::compute_amm_quote_state(
            &market.amm,
            &market.market_stats,
            &mm_oracle_price_data,
            reserve_price,
            slot,
        )?;

        // price relates to execution premium / direction
        let (execution_premium_price, execution_premium_direction) =
            if amm_quote_state.long_spread > amm_quote_state.short_spread {
                (
                    market.amm.ask_price(
                        reserve_price,
                        amm_quote_state.long_spread,
                        amm_quote_state.reference_price_offset,
                    )?,
                    Some(PositionDirection::Long),
                )
            } else if amm_quote_state.long_spread < amm_quote_state.short_spread {
                (
                    market.amm.bid_price(
                        reserve_price,
                        amm_quote_state.short_spread,
                        amm_quote_state.reference_price_offset,
                    )?,
                    Some(PositionDirection::Short),
                )
            } else {
                (reserve_price, None)
            };

        let sanitize_clamp_denominator = market.get_sanitize_clamp_denominator()?;
        let order_tick_size = market.order_tick_size;
        let (amm_bid_price, amm_ask_price) = market.amm.bid_ask_price(
            reserve_price,
            amm_quote_state.long_spread,
            amm_quote_state.short_spread,
            amm_quote_state.reference_price_offset,
        )?;
        let amm_base_spread = market.amm.base_spread;
        let mid_price_twap = market.market_stats.update_mark_twap_with_amm_bid_ask(
            amm_bid_price,
            amm_ask_price,
            amm_base_spread,
            &amm_quote_state,
            now,
            Some(execution_premium_price),
            execution_premium_direction,
            sanitize_clamp_denominator,
            funding_period,
            order_tick_size,
        )?;

        let period_adjustment = (24_i128).safe_mul(ONE_HOUR_I128)?.safe_div(max(
            ONE_HOUR_I128,
            market.market_stats.funding_period as i128,
        ))?;
        // funding period = 1 hour, window = 1 day
        // low periodicity => quickly updating/settled funding rates => lower funding rate payment per interval
        let price_spread = mid_price_twap.cast::<i64>()?.safe_sub(oracle_price_twap)?;

        // add offset 1/FUNDING_RATE_OFFSET_DENOMINATOR*365. if FUNDING_RATE_OFFSET_DENOMINATOR = 3333 => 10.95% annualized rate
        // clamp when |price_spread| <= 0.05% to floor 10.95% annualized rate
        let funding_rate_offset = oracle_price_twap
            .abs()
            .safe_div(FUNDING_RATE_OFFSET_DENOMINATOR)?;

        let price_spread_with_offset = if price_spread.abs()
            <= oracle_price_twap
                .abs()
                .safe_div(FUNDING_RATE_CLAMP_DENOMINATOR)?
        {
            funding_rate_offset
        } else {
            price_spread.safe_add(funding_rate_offset)?
        };

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

        // Fire `FundingApplied` to the AMM. This is the only path that lets
        // the AMM update its books (k-update + window reset) — controller
        // code never reaches into AMM fields here.
        let total_fee_floor = market
            .amm
            .protocol_floor(market.total_exchange_fee, market.total_liquidation_fee)?;
        let funding_imbalance_cost = -funding_imbalance_revenue;
        let k_update_eligible = market.amm.is_curve_update_enabled()
            && !market.has_market_config_flag(
                crate::state::perp_market::MarketConfigFlag::DisableFormulaicKUpdate,
            );
        let market_status = market.status;
        let event = crate::state::quoter::MarketEvent::FundingApplied {
            funding_imbalance_cost,
            oracle_price_data,
            now,
            total_fee_floor,
            k_update_eligible,
            market_status,
        };
        let ctx = crate::state::quoter::QuoteContext {
            stats: &market.market_stats,
            oracle: oracle_price_data,
            fee_budget: 0,
            tick: market.order_tick_size,
            slot,
            base_precision: crate::math::constants::BASE_PRECISION_U64,
        };
        let effects = {
            let mut amm_maker = crate::amm::AmmQuoter::new(
                &mut market.amm,
                amm_quote_state,
                market.order_step_size,
            );
            <crate::amm::AmmQuoter as crate::state::quoter::QuoterCommit>::on_market_event(
                &mut amm_maker,
                &ctx,
                &event,
            )?
        };
        let period_revenue_snapshot = effects.period_revenue_snapshot;
        let amm_metrics = market.amm.curve_record_metrics();
        if let Some(curve) = effects.curve_record {
            emit!(CurveRecord {
                ts: now,
                record_id: get_then_update_id!(market, next_curve_record_id),
                market_index: market.market_index,
                peg_multiplier_before: curve.peg_multiplier_before,
                base_asset_reserve_before: curve.base_asset_reserve_before,
                quote_asset_reserve_before: curve.quote_asset_reserve_before,
                sqrt_k_before: curve.sqrt_k_before,
                peg_multiplier_after: curve.peg_multiplier_after,
                base_asset_reserve_after: curve.base_asset_reserve_after,
                quote_asset_reserve_after: curve.quote_asset_reserve_after,
                sqrt_k_after: curve.sqrt_k_after,
                base_asset_amount_long: market.base_asset_amount_long.unsigned_abs(),
                base_asset_amount_short: market.base_asset_amount_short.unsigned_abs(),
                base_asset_amount_with_amm: amm_metrics.base_asset_amount_with_amm,
                number_of_users: market.number_of_users,
                adjustment_cost: curve.adjustment_cost,
                total_fee: amm_metrics.total_fee,
                total_fee_minus_distributions: amm_metrics.total_fee_minus_distributions,
                oracle_price: market.market_stats.historical_oracle_data.last_oracle_price,
                fill_record: market.next_fill_record_id as u128,
            });
        }

        market.cumulative_funding_rate_long = market
            .cumulative_funding_rate_long
            .safe_add(funding_rate_long)?;

        market.cumulative_funding_rate_short = market
            .cumulative_funding_rate_short
            .safe_add(funding_rate_short)?;

        market.last_funding_rate = funding_rate;
        market.last_funding_oracle_twap = oracle_price_twap;
        market.last_funding_rate_long = funding_rate_long.cast()?;
        market.last_funding_rate_short = funding_rate_short.cast()?;
        market.market_stats.last_24h_avg_funding_rate = calculate_new_twap(
            funding_rate,
            now,
            market.market_stats.last_24h_avg_funding_rate,
            market.last_funding_rate_ts,
            TWENTY_FOUR_HOUR,
        )?;

        market.net_unsettled_funding_pnl = market
            .net_unsettled_funding_pnl
            .safe_sub(funding_imbalance_revenue.cast()?)?;

        market.last_funding_rate_ts = now;

        emit!(FundingRateRecord {
            ts: now,
            record_id: get_then_update_id!(market, next_funding_rate_record_id),
            market_index,
            funding_rate,
            funding_rate_long,
            funding_rate_short,
            cumulative_funding_rate_long: market.cumulative_funding_rate_long,
            cumulative_funding_rate_short: market.cumulative_funding_rate_short,
            mark_price_twap: mid_price_twap,
            oracle_price_twap,
            period_revenue: period_revenue_snapshot,
            base_asset_amount_with_amm: amm_metrics.base_asset_amount_with_amm,
        });
    } else {
        return Ok(false);
    }

    Ok(true)
}
