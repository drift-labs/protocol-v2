use std::cmp::max;

use anchor_lang::prelude::*;
use solana_program::clock::UnixTimestamp;

use crate::amm::refresh::compute_amm_refresh_validity_with_guard_rails;
use crate::amm::AmmQuoter;
use crate::controller::position::{
    get_position_index, update_quote_asset_and_break_even_amount, PositionDirection,
};
use crate::error::DriftResult;
use crate::math::casting::Cast;
use crate::math::constants::{
    BASE_PRECISION_U64, FUNDING_RATE_BUFFER, FUNDING_RATE_CLAMP_DENOMINATOR,
    FUNDING_RATE_OFFSET_DENOMINATOR, ONE_HOUR_I128, TWENTY_FOUR_HOUR,
};
use crate::math::funding::{
    calculate_funding_payment, calculate_funding_rate_long_short,
    validate_funding_pnl_profitability, FundingMarketInputs,
};
use crate::math::helpers::on_the_hour_update;
use crate::math::oracle;
use crate::math::safe_math::SafeMath;
use crate::math::stats::calculate_new_twap;

use crate::state::events::{FundingPaymentRecord, FundingRateRecord};
use crate::state::market_status::MarketStatus;
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::{MarketConfigFlag, PerpMarket};
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::quoter::{MarketEvent, QuoteContext, Quoter, QuoterCommit};
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

/// Project the AMM's curve + cached spread state to `slot` *before* the
/// `block_operation` funding gate runs. The gate rejects funding when the AMM
/// hasn't been projected this slot (`slots_since_amm_update >
/// market_stats.funding_period`); with a tiny `funding_period` (e.g. the
/// bankrun `pyth.ts` tests use 0) a stale `last_update_slot` would lock funding
/// out for the rest of the slot. Mirrors the legacy `_update_amm` the keeper
/// ran before funding. The in-branch `AmmQuoter::setup` reuses this projection
/// via slot-idempotency, so the curve math only runs once per slot.
fn refresh_amm_for_funding_gate(
    market: &mut PerpMarket,
    oracle_map: &mut OracleMap,
    slot: u64,
    guard_rails: &OracleGuardRails,
) -> DriftResult<()> {
    let oracle_price_data = *oracle_map.get_price_data(&market.oracle_id())?;
    let mm_oracle_price_data =
        market.get_mm_oracle_price_data(oracle_price_data, slot, &guard_rails.validity)?;
    let oracle_validity = compute_amm_refresh_validity_with_guard_rails(
        market,
        &mm_oracle_price_data,
        &guard_rails.validity,
    )?;
    let market_stats_snap = market.market_stats;
    let safe_oracle = mm_oracle_price_data.get_safe_oracle_price_data();
    let ctx = QuoteContext {
        stats: &market_stats_snap,
        oracle: &safe_oracle,
        mm_oracle: Some(&mm_oracle_price_data),
        oracle_validity,
        fee_budget: 0,
        tick: market.order_tick_size,
        step_size: market.order_step_size,
        slot,
        base_precision: BASE_PRECISION_U64,
        market_status: market.status,
        market_config: market.market_config,
    };
    AmmQuoter::for_amm(&mut market.amm).setup(&ctx)
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

    refresh_amm_for_funding_gate(market, oracle_map, slot, guard_rails)?;

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
    if !valid_funding_update {
        return Ok(false);
    }

    let oracle_price_data = oracle_map.get_price_data(&market.oracle_id())?;
    let sanitize_clamp_denominator = market.get_sanitize_clamp_denominator()?;
    let mm_oracle_price_data =
        market.get_mm_oracle_price_data(*oracle_price_data, slot, &guard_rails.validity)?;
    let funding_period = market.market_stats.funding_period;

    let oracle_price_twap = {
        let PerpMarket {
            amm, market_stats, ..
        } = &mut *market;
        market_stats.update_oracle_twap(
            amm,
            now,
            &mm_oracle_price_data,
            Some(reserve_price),
            sanitize_clamp_denominator,
        )?
    };

    // PerpMarket-level reads captured before the AMM is borrowed mutably.
    let amm_refresh_validity = compute_amm_refresh_validity_with_guard_rails(
        market,
        &mm_oracle_price_data,
        &guard_rails.validity,
    )?;
    let max_price_spread = market.get_max_price_divergence_for_funding_rate(oracle_price_twap)?;
    let k_update_eligible = market.amm.is_curve_update_enabled()
        && !market.has_market_config_flag(MarketConfigFlag::DisableFormulaicKUpdate);
    let min_order_size = market.market_stats.min_order_size;
    let funding_inputs = FundingMarketInputs::from_market(market);
    let order_tick_size = market.order_tick_size;
    let order_step_size = market.order_step_size;
    let market_status = market.status;
    let market_stats_snap = market.market_stats;

    // ---- Refresh the AMM for this slot and snapshot the spread state the
    // funding event + mark-twap update need. The quoter's `&mut amm` borrow is
    // confined to this block; everything after it touches PerpMarket fields
    // directly, and the AMM is settled below via a fresh quoter. ----
    let safe_oracle = mm_oracle_price_data.get_safe_oracle_price_data();
    let setup_ctx = QuoteContext {
        stats: &market_stats_snap,
        oracle: &safe_oracle,
        mm_oracle: Some(&mm_oracle_price_data),
        oracle_validity: amm_refresh_validity,
        fee_budget: 0,
        tick: order_tick_size,
        step_size: order_step_size,
        slot,
        base_precision: BASE_PRECISION_U64,
        market_status,
        market_config: market.market_config,
    };
    let (
        amm_long_spread,
        amm_short_spread,
        amm_bid_price,
        amm_ask_price,
        amm_base_spread,
        execution_premium_price,
        execution_premium_direction,
    ) = {
        let mut amm_quoter = AmmQuoter::for_amm(&mut market.amm);
        amm_quoter.setup(&setup_ctx)?;
        let amm = &amm_quoter.amm;
        let reserve_price = amm.reserve_price()?;
        let long_spread = amm.long_spread;
        let short_spread = amm.short_spread;
        let reference_price_offset = amm.reference_price_offset;
        let (execution_premium_price, execution_premium_direction) = if long_spread > short_spread {
            (
                amm.ask_price(reserve_price, long_spread, reference_price_offset)?,
                Some(PositionDirection::Long),
            )
        } else if long_spread < short_spread {
            (
                amm.bid_price(reserve_price, short_spread, reference_price_offset)?,
                Some(PositionDirection::Short),
            )
        } else {
            (reserve_price, None)
        };
        let (bid_price, ask_price) = amm.bid_ask_price(
            reserve_price,
            long_spread,
            short_spread,
            reference_price_offset,
        )?;
        (
            long_spread,
            short_spread,
            bid_price,
            ask_price,
            amm.base_spread,
            execution_premium_price,
            execution_premium_direction,
        )
    };

    let mid_price_twap = market.market_stats.update_mark_twap_with_amm_bid_ask(
        amm_bid_price,
        amm_ask_price,
        amm_base_spread,
        amm_long_spread,
        amm_short_spread,
        now,
        Some(execution_premium_price),
        execution_premium_direction,
        sanitize_clamp_denominator,
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

    let clamped_price_spread = price_spread_with_offset.clamp(-max_price_spread, max_price_spread);
    let funding_rate = clamped_price_spread
        .cast::<i128>()?
        .safe_mul(FUNDING_RATE_BUFFER.cast()?)?
        .safe_div(period_adjustment.cast()?)?
        .cast::<i64>()?;

    let (funding_rate_long_value, funding_rate_short_value, funding_imbalance_revenue) =
        calculate_funding_rate_long_short(&funding_inputs, funding_rate.cast()?)?;

    // `calculate_funding_rate_long_short` is pure. Enforce the protocol-floor
    // profitability check before mutating; the AMM settles its own PnL from
    // cum-rate deltas inside the event handler below.
    validate_funding_pnl_profitability(&funding_inputs, funding_imbalance_revenue)?;

    // Apply cum-rate updates BEFORE dispatching FundingUpdated so the AMM
    // settles against post-update values (same as user positions settle
    // against current cum rates).
    market.cumulative_funding_rate_long = market
        .cumulative_funding_rate_long
        .safe_add(funding_rate_long_value)?;
    market.cumulative_funding_rate_short = market
        .cumulative_funding_rate_short
        .safe_add(funding_rate_short_value)?;

    // ---- AMM-side settlement: a fresh quoter settles the AMM's own funding
    // PnL from the post-update cum-rate deltas and runs its eager k-update,
    // emitting `AmmCurveChanged` itself when the curve moves. ----
    let event = MarketEvent::FundingUpdated {
        market_index,
        cumulative_funding_rate_long: market.cumulative_funding_rate_long,
        cumulative_funding_rate_short: market.cumulative_funding_rate_short,
        base_asset_amount_long: funding_inputs.base_asset_amount_long,
        base_asset_amount_short: funding_inputs.base_asset_amount_short,
        funding_rate: funding_rate.cast()?,
        oracle_price_data,
        now,
        total_fee_floor: market.amm.protocol_floor()?,
        long_spread: amm_long_spread,
        short_spread: amm_short_spread,
        k_update_eligible,
        market_status,
        min_order_size,
    };
    let event_ctx = QuoteContext {
        stats: &market_stats_snap,
        oracle: oracle_price_data,
        mm_oracle: None,
        oracle_validity: None,
        fee_budget: 0,
        tick: order_tick_size,
        step_size: order_step_size,
        slot,
        base_precision: BASE_PRECISION_U64,
        market_status: MarketStatus::default(),
        market_config: 0,
    };
    AmmQuoter::for_amm(&mut market.amm).on_market_event(&event_ctx, &event)?;

    // ---- Remaining PerpMarket-level updates. ----
    market.last_funding_rate = funding_rate;
    market.last_funding_oracle_twap = oracle_price_twap;
    market.last_funding_rate_long = funding_rate_long_value.cast()?;
    market.last_funding_rate_short = funding_rate_short_value.cast()?;
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

    let record_id = {
        let current = market.next_funding_rate_record_id;
        market.next_funding_rate_record_id = current.checked_add(1).unwrap_or(1);
        current
    };
    emit!(FundingRateRecord {
        ts: now,
        record_id,
        market_index,
        funding_rate,
        funding_rate_long: funding_rate_long_value,
        funding_rate_short: funding_rate_short_value,
        cumulative_funding_rate_long: market.cumulative_funding_rate_long,
        cumulative_funding_rate_short: market.cumulative_funding_rate_short,
        mark_price_twap: mid_price_twap,
        oracle_price_twap,
        base_asset_amount_with_amm: market.amm.base_asset_amount_with_amm,
    });

    Ok(true)
}
