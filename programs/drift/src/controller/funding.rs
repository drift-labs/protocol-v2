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

use crate::state::events::{FundingPaymentRecord, FundingRateRecord};
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

    // ---- Pre-refresh: bring the AMM up to date for `slot` BEFORE the
    // `block_operation` gate runs. `block_operation` rejects funding when
    // `slots_since_amm_update > market_stats.funding_period`; with a tiny
    // funding_period (e.g. the bankrun `pyth.ts` tests use 0) a stale
    // `last_update_slot` would otherwise lock funding out for the rest of
    // the slot. Matches the legacy `handle_update_funding_rate` flow
    // (master called `_update_amm` here). The consolidated `AmmQuoter`
    // further down inside this function reuses the post-refresh AMM via
    // slot-idempotency, so the projection only runs once. ----
    {
        let oracle_price_data = *oracle_map.get_price_data(&market.oracle_id())?;
        let mm_oracle_price_data =
            market.get_mm_oracle_price_data(oracle_price_data, slot, &guard_rails.validity)?;
        let amm_refresh_validity =
            crate::amm::refresh::compute_amm_refresh_validity_with_guard_rails(
                market,
                &mm_oracle_price_data,
                &guard_rails.validity,
            )?;
        let market_stats_snap = market.market_stats;
        let safe_oracle = mm_oracle_price_data.get_safe_oracle_price_data();
        let setup_ctx = crate::state::quoter::QuoteContext {
            stats: &market_stats_snap,
            oracle: &safe_oracle,
            mm_oracle: Some(&mm_oracle_price_data),
            oracle_validity: amm_refresh_validity,
            fee_budget: 0,
            tick: market.order_tick_size,
            step_size: market.order_step_size,
            slot,
            base_precision: crate::math::constants::BASE_PRECISION_U64,
            total_exchange_fee: market.total_exchange_fee,
            total_liquidation_fee: market.total_liquidation_fee,
            market_status: market.status,
            market_config: market.market_config,
        };
        let mut amm_quoter = crate::amm::AmmQuoter::for_amm(&mut market.amm);
        <crate::amm::AmmQuoter as crate::state::quoter::Quoter>::setup(
            &mut amm_quoter,
            &setup_ctx,
        )?;
    }

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

        // ---- Snapshot every PerpMarket-level scalar / sub-struct the
        // rest of this branch needs, while we still hold `&PerpMarket`.
        // Once we destructure for the disjoint &mut borrows that let one
        // AmmQuoter span setup → math → on_market_event, we can't call
        // `&self` methods on `market` again. ----
        let amm_refresh_validity =
            crate::amm::refresh::compute_amm_refresh_validity_with_guard_rails(
                market,
                &mm_oracle_price_data,
                &guard_rails.validity,
            )?;
        let max_price_spread =
            market.get_max_price_divergence_for_funding_rate(oracle_price_twap)?;
        let k_update_eligible = market.amm.is_curve_update_enabled()
            && !market.has_market_config_flag(
                crate::state::perp_market::MarketConfigFlag::DisableFormulaicKUpdate,
            );
        let market_stats_snap = market.market_stats;
        let market_index = market.market_index;
        let market_status = market.status;
        let market_config = market.market_config;
        let order_tick_size = market.order_tick_size;
        let order_step_size = market.order_step_size;
        let total_exchange_fee = market.total_exchange_fee;
        let total_liquidation_fee = market.total_liquidation_fee;
        let min_order_size = market.market_stats.min_order_size;
        let funding_inputs = crate::math::funding::FundingMarketInputs::from_market(market);
        let safe_oracle = mm_oracle_price_data.get_safe_oracle_price_data();

        let setup_ctx = crate::state::quoter::QuoteContext {
            stats: &market_stats_snap,
            oracle: &safe_oracle,
            mm_oracle: Some(&mm_oracle_price_data),
            oracle_validity: amm_refresh_validity,
            fee_budget: 0,
            tick: order_tick_size,
            step_size: order_step_size,
            slot,
            base_precision: crate::math::constants::BASE_PRECISION_U64,
            total_exchange_fee,
            total_liquidation_fee,
            market_status,
            market_config,
        };

        // ---- Disjoint-field destructure so a single AmmQuoter can hold
        // `&mut amm` across setup → AMM reads → cum-rate writes →
        // on_market_event, while we still mutate `market_stats` and the
        // various `last_funding_*` fields through their own &mut refs. ----
        let crate::state::perp_market::PerpMarket {
            amm,
            market_stats,
            cumulative_funding_rate_long,
            cumulative_funding_rate_short,
            last_funding_rate,
            last_funding_oracle_twap,
            last_funding_rate_long,
            last_funding_rate_short,
            last_funding_rate_ts,
            net_unsettled_funding_pnl,
            next_funding_rate_record_id,
            ..
        } = &mut *market;

        let mut amm_quoter = crate::amm::AmmQuoter::for_amm(amm);
        <crate::amm::AmmQuoter as crate::state::quoter::Quoter>::setup(
            &mut amm_quoter,
            &setup_ctx,
        )?;
        let amm_quote_state = amm_quoter.quote_state;

        // ---- Post-refresh AMM reads via the live quoter. ----
        let reserve_price = amm_quoter.amm.reserve_price()?;
        let (execution_premium_price, execution_premium_direction) =
            if amm_quote_state.long_spread > amm_quote_state.short_spread {
                (
                    amm_quoter.amm.ask_price(
                        reserve_price,
                        amm_quote_state.long_spread,
                        amm_quote_state.reference_price_offset,
                    )?,
                    Some(PositionDirection::Long),
                )
            } else if amm_quote_state.long_spread < amm_quote_state.short_spread {
                (
                    amm_quoter.amm.bid_price(
                        reserve_price,
                        amm_quote_state.short_spread,
                        amm_quote_state.reference_price_offset,
                    )?,
                    Some(PositionDirection::Short),
                )
            } else {
                (reserve_price, None)
            };
        let (amm_bid_price, amm_ask_price) = amm_quoter.amm.bid_ask_price(
            reserve_price,
            amm_quote_state.long_spread,
            amm_quote_state.short_spread,
            amm_quote_state.reference_price_offset,
        )?;
        let amm_base_spread = amm_quoter.amm.base_spread;

        // ---- Mark TWAP (disjoint market_stats borrow). ----
        let mid_price_twap = market_stats.update_mark_twap_with_amm_bid_ask(
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

        // ---- Pure funding-rate math. ----
        let period_adjustment = (24_i128)
            .safe_mul(ONE_HOUR_I128)?
            .safe_div(max(ONE_HOUR_I128, funding_period as i128))?;
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

        let clamped_price_spread =
            price_spread_with_offset.clamp(-max_price_spread, max_price_spread);
        let funding_rate = clamped_price_spread
            .cast::<i128>()?
            .safe_mul(FUNDING_RATE_BUFFER.cast()?)?
            .safe_div(period_adjustment.cast()?)?
            .cast::<i64>()?;

        let (funding_rate_long_value, funding_rate_short_value, funding_imbalance_revenue) =
            calculate_funding_rate_long_short(&funding_inputs, funding_rate.cast()?)?;

        // `calculate_funding_rate_long_short` is pure. Enforce the
        // protocol-floor profitability check before mutating; the AMM
        // settles its own PnL from cum-rate deltas inside the event
        // handler below.
        crate::math::funding::validate_funding_pnl_profitability(
            &funding_inputs,
            funding_imbalance_revenue,
        )?;

        // ---- Apply cum-rate updates BEFORE dispatching FundingUpdated
        // so the AMM settles against post-update values (same as user
        // positions settle against current cum rates). ----
        *cumulative_funding_rate_long =
            cumulative_funding_rate_long.safe_add(funding_rate_long_value)?;
        *cumulative_funding_rate_short =
            cumulative_funding_rate_short.safe_add(funding_rate_short_value)?;

        let total_fee_floor = amm_quoter
            .amm
            .protocol_floor(total_exchange_fee, total_liquidation_fee)?;
        let event = crate::state::quoter::MarketEvent::FundingUpdated {
            market_index,
            cumulative_funding_rate_long: *cumulative_funding_rate_long,
            cumulative_funding_rate_short: *cumulative_funding_rate_short,
            base_asset_amount_long: funding_inputs.base_asset_amount_long,
            base_asset_amount_short: funding_inputs.base_asset_amount_short,
            funding_rate: funding_rate.cast()?,
            oracle_price_data,
            now,
            total_fee_floor,
            long_spread: amm_quote_state.long_spread,
            short_spread: amm_quote_state.short_spread,
            k_update_eligible,
            market_status,
            min_order_size,
        };
        let event_ctx = crate::state::quoter::QuoteContext {
            stats: market_stats,
            oracle: oracle_price_data,
            mm_oracle: None,
            oracle_validity: None,
            fee_budget: 0,
            tick: order_tick_size,
            step_size: order_step_size,
            slot,
            base_precision: crate::math::constants::BASE_PRECISION_U64,
            total_exchange_fee: 0,
            total_liquidation_fee: 0,
            market_status: crate::state::market_status::MarketStatus::default(),
            market_config: 0,
        };
        <crate::amm::AmmQuoter as crate::state::quoter::QuoterCommit>::on_market_event(
            &mut amm_quoter,
            &event_ctx,
            &event,
        )?;
        // `AmmCurveChanged` (AMM-side) is emitted by the AMM directly from
        // inside the FundingUpdated handler when the k-update fires. No
        // joint `CurveRecord` emission here.

        // ---- Remaining PerpMarket-level updates via the disjoint refs. ----
        *last_funding_rate = funding_rate;
        *last_funding_oracle_twap = oracle_price_twap;
        *last_funding_rate_long = funding_rate_long_value.cast()?;
        *last_funding_rate_short = funding_rate_short_value.cast()?;
        market_stats.last_24h_avg_funding_rate = calculate_new_twap(
            funding_rate,
            now,
            market_stats.last_24h_avg_funding_rate,
            *last_funding_rate_ts,
            TWENTY_FOUR_HOUR,
        )?;
        *net_unsettled_funding_pnl =
            net_unsettled_funding_pnl.safe_sub(funding_imbalance_revenue.cast()?)?;
        *last_funding_rate_ts = now;

        let record_id = {
            let current = *next_funding_rate_record_id;
            *next_funding_rate_record_id = current.checked_add(1).unwrap_or(1);
            current
        };
        let base_asset_amount_with_amm = amm_quoter.amm.base_asset_amount_with_amm;
        let cum_long_after = *cumulative_funding_rate_long;
        let cum_short_after = *cumulative_funding_rate_short;
        emit!(FundingRateRecord {
            ts: now,
            record_id,
            market_index,
            funding_rate,
            funding_rate_long: funding_rate_long_value,
            funding_rate_short: funding_rate_short_value,
            cumulative_funding_rate_long: cum_long_after,
            cumulative_funding_rate_short: cum_short_after,
            mark_price_twap: mid_price_twap,
            oracle_price_twap,
            base_asset_amount_with_amm,
        });
    } else {
        return Ok(false);
    }

    Ok(true)
}
