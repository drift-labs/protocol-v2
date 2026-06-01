use std::cmp::min;

use crate::math::oracle::LogMode;
use crate::msg;
use crate::state::oracle::MMOraclePriceData;
use anchor_lang::prelude::AccountInfo;
use anchor_lang::prelude::*;

// `update_spreads` removed in the AMM-decoupling refactor; spread state is
// computed on demand via `math::amm_spread::compute_amm_quote_state`.
use crate::amm::math::amm;
use crate::amm::math::cp_curve;
use crate::amm::math::cp_curve::get_update_k_result;
use crate::amm::math::repeg;
use crate::controller::spot_balance::update_spot_balances;
use crate::error::ErrorCode;
use crate::error::*;
use crate::load_mut;
use crate::math::bn;
use crate::math::casting::Cast;
use crate::math::constants::{
    K_BPS_UPDATE_SCALE, MAX_SQRT_K, QUOTE_PRECISION, QUOTE_SPOT_MARKET_INDEX,
};
use crate::math::oracle;
use crate::math::oracle::{
    is_oracle_valid_for_action, oracle_validity, DriftAction, OracleValidity,
};
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_amount;

use crate::state::market_status::MarketStatus;
use crate::state::oracle::OracleSource;
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::PerpMarket;
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_market::SpotBalance;
use crate::state::spot_market::SpotBalanceType;
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::state::{OracleGuardRails, State};
use crate::state::user::MarketType;
use crate::validate;

#[cfg(test)]
mod tests;

pub fn repeg(
    market: &mut PerpMarket,
    price_oracle: &AccountInfo,
    new_peg_candidate: u128,
    clock_slot: u64,
    oracle_guard_rails: &OracleGuardRails,
) -> DriftResult<i128> {
    // for adhoc admin only repeg

    if new_peg_candidate == market.amm.peg_multiplier {
        return Err(ErrorCode::InvalidRepegRedundant);
    }
    let (terminal_price_before, _terminal_quote_reserves, _terminal_base_reserves) =
        amm::calculate_terminal_price_and_reserves(&market.amm)?;

    let (repegged_market, adjustment_cost) = repeg::adjust_peg_cost(market, new_peg_candidate)?;

    let (oracle_is_valid, direction_valid, profitability_valid, price_impact_valid) =
        repeg::calculate_repeg_validity_from_oracle_account(
            &repegged_market,
            price_oracle,
            terminal_price_before,
            clock_slot,
            oracle_guard_rails,
        )?;

    // cannot repeg if oracle is invalid
    if !oracle_is_valid {
        return Err(ErrorCode::InvalidOracle);
    }

    // only push terminal in direction of oracle
    if !direction_valid {
        return Err(ErrorCode::InvalidRepegDirection);
    }

    // only push terminal up to closer edge of oracle confidence band
    if !profitability_valid {
        return Err(ErrorCode::InvalidRepegProfitability);
    }

    // only push mark up to further edge of oracle confidence band
    if !price_impact_valid {
        // todo
        // return Err(ErrorCode::InvalidRepegPriceImpact);
        return Err(ErrorCode::InvalidRepegProfitability);
    }

    // modify market's total fee change and peg change
    let cost_applied = apply_cost_to_market(market, adjustment_cost, true)?;
    if cost_applied {
        market.amm.set_peg(new_peg_candidate);
    } else {
        return Err(ErrorCode::InvalidRepegProfitability);
    }

    Ok(adjustment_cost)
}

pub fn update_amms(
    perp_market_map: &mut PerpMarketMap,
    oracle_map: &mut OracleMap,
    state: &State,
    clock: &Clock,
) -> DriftResult<bool> {
    // up to ~60k compute units (per amm) worst case
    let clock_slot = clock.slot;
    let now = clock.unix_timestamp;

    let updated = true; // todo
    for (_key, market_account_loader) in perp_market_map.0.iter_mut() {
        let market = &mut load_mut!(market_account_loader)?;
        let oracle_price_data = oracle_map.get_price_data(&market.oracle_id())?;
        let mm_oracle_price_data = market.get_mm_oracle_price_data(
            *oracle_price_data,
            clock_slot,
            &state.oracle_guard_rails.validity,
        )?;

        // Explicit two-step refresh, both via the public interface:
        //   1. dispatch_amm_refresh: fires `MarketEvent::Refresh` at the AMM
        //   2. refresh_perp_market_stats_from_oracle: updates PerpMarket-level
        //      oracle-derived state (TWAPs, last_reference_price_offset,
        //      last_oracle_valid). PerpMarket-level work is distinct from AMM
        //      work; both happen here because this keeper crank is the one
        //      place that touches both.
        let validity = compute_amm_refresh_validity(market, &mm_oracle_price_data, state)?;
        dispatch_amm_refresh(market, &mm_oracle_price_data, validity, clock_slot)?;
        refresh_perp_market_stats_from_oracle(
            market,
            &mm_oracle_price_data,
            validity,
            now,
            clock_slot,
        )?;
    }

    Ok(updated)
}

pub fn update_amm(
    market_index: u16,
    perp_market_map: &PerpMarketMap,
    oracle_map: &mut OracleMap,
    state: &State,
    clock: &Clock,
) -> DriftResult<i128> {
    let market = &mut perp_market_map.get_ref_mut(&market_index)?;
    let oracle_price_data = oracle_map.get_price_data(&market.oracle_id())?;
    let mm_oracle_price_data = market.get_mm_oracle_price_data(
        *oracle_price_data,
        clock.slot,
        &state.oracle_guard_rails.validity,
    )?;

    // Same explicit two-step refresh as `update_amms`. See doc there.
    let validity = compute_amm_refresh_validity(market, &mm_oracle_price_data, state)?;
    let cost_of_update = dispatch_amm_refresh(market, &mm_oracle_price_data, validity, clock.slot)?;
    refresh_perp_market_stats_from_oracle(
        market,
        &mm_oracle_price_data,
        validity,
        clock.unix_timestamp,
        clock.slot,
    )?;

    Ok(cost_of_update)
}

/// Test-only convenience: composes the explicit three-step refresh
/// (`compute_amm_refresh_validity` → `dispatch_amm_refresh` →
/// `refresh_perp_market_stats_from_oracle`) into a single call matching
/// the legacy `_update_amm` signature. Production code uses the three
/// helpers explicitly.
#[cfg(test)]
pub fn _update_amm(
    market: &mut PerpMarket,
    mm_oracle_price_data: &MMOraclePriceData,
    state: &State,
    now: i64,
    clock_slot: u64,
) -> DriftResult<i128> {
    let validity = compute_amm_refresh_validity(market, mm_oracle_price_data, state)?;
    let cost = dispatch_amm_refresh(market, mm_oracle_price_data, validity, clock_slot)?;
    refresh_perp_market_stats_from_oracle(market, mm_oracle_price_data, validity, now, clock_slot)?;
    Ok(cost)
}

/// Compute oracle validity for an AMM refresh, or return `None` if the
/// market is in Settlement/Delisted status (no refresh applicable).
pub fn compute_amm_refresh_validity(
    market: &PerpMarket,
    mm_oracle_price_data: &MMOraclePriceData,
    state: &State,
) -> DriftResult<Option<OracleValidity>> {
    if matches!(
        market.status,
        MarketStatus::Settlement | MarketStatus::Delisted
    ) {
        return Ok(None);
    }
    let oracle_data = &mm_oracle_price_data.get_safe_oracle_price_data();
    let validity = oracle::oracle_validity(
        MarketType::Perp,
        market.market_index,
        market
            .market_stats
            .historical_oracle_data
            .last_oracle_price_twap,
        oracle_data,
        &state.oracle_guard_rails.validity,
        market.get_max_confidence_interval_multiplier()?,
        &market.oracle_source,
        oracle::LogMode::SafeMMOracle,
        market.oracle_slot_delay_override,
        market.oracle_low_risk_slot_delay_override,
    )?;
    Ok(Some(validity))
}

/// Dispatch a `MarketEvent::Refresh` at the AMM. Pre-computes the optimal
/// peg + budget here (the optimization helpers read PerpMarket-level inputs
/// the AMM trait surface can't see), then fires the event so the AMM
/// applies the result via `on_market_event`. Returns the cost the AMM
/// applied (positive = AMM paid for the curve change).
///
/// Pure AMM-side: this function only mutates AMM fields, via the trait. It
/// does NOT touch PerpMarket-level state — that's
/// `refresh_perp_market_stats_from_oracle`'s job.
pub fn dispatch_amm_refresh(
    market: &mut PerpMarket,
    mm_oracle_price_data: &MMOraclePriceData,
    oracle_validity: Option<OracleValidity>,
    slot: u64,
) -> DriftResult<i128> {
    let Some(oracle_validity) = oracle_validity else {
        return Ok(0);
    };

    let mut repeg_result: Option<crate::state::quoter::RepegResult> = None;
    if is_oracle_valid_for_action(oracle_validity, Some(DriftAction::UpdateAMMCurve))? {
        let curve_update_intensity =
            min(market.amm.curve_update_intensity, 100_u8).cast::<i128>()?;

        if curve_update_intensity > 0 {
            let (optimal_peg, fee_budget, check_lower_bound) =
                repeg::calculate_optimal_peg_and_budget(market, mm_oracle_price_data)?;

            let (repegged_market, repegged_cost) = repeg::adjust_amm(
                market,
                optimal_peg,
                fee_budget,
                curve_update_intensity >= 100,
            )?;

            let total_fee_floor = market
                .amm
                .protocol_floor(market.total_exchange_fee, market.total_liquidation_fee)?;

            repeg_result = Some(crate::state::quoter::RepegResult {
                new_peg: repegged_market.amm.peg_multiplier,
                new_sqrt_k: repegged_market.amm.sqrt_k,
                new_base_asset_reserve: repegged_market.amm.base_asset_reserve,
                new_quote_asset_reserve: repegged_market.amm.quote_asset_reserve,
                cost: repegged_cost,
                check_lower_bound,
                total_fee_floor,
            });
        }
    }

    let bump_last_update_slot =
        is_oracle_valid_for_action(oracle_validity, Some(DriftAction::FillOrderAmmLowRisk))?;
    let event = crate::state::quoter::MarketEvent::Refresh {
        repeg_result,
        bump_last_update_slot,
        slot,
    };
    let amm_quote_state_pre = crate::amm::math::spread::compute_amm_quote_state(
        &market.amm,
        &market.market_stats,
        mm_oracle_price_data,
        market.amm.reserve_price()?,
        slot,
    )?;
    let oracle_data = &mm_oracle_price_data.get_safe_oracle_price_data();
    let ctx = crate::state::quoter::QuoteContext {
        stats: &market.market_stats,
        oracle: oracle_data,
        fee_budget: 0,
        tick: market.order_tick_size,
        slot,
        base_precision: crate::math::constants::BASE_PRECISION_U64,
    };
    let effects = {
        let mut amm_maker = crate::amm::AmmQuoter::new(
            &mut market.amm,
            amm_quote_state_pre,
            market.order_step_size,
        );
        <crate::amm::AmmQuoter as crate::state::quoter::QuoterCommit>::on_market_event(
            &mut amm_maker,
            &ctx,
            &event,
        )?
    };
    if repeg_result.is_some() && effects.curve_record.is_none() {
        msg!("amm_not_successfully_updated = true (repeg cost not applied for check_lower_bound)");
    }
    Ok(effects.refresh_cost)
}

/// Update PerpMarket-level oracle-derived state: oracle TWAPs (via
/// `update_oracle_price_twap`), `last_reference_price_offset` (cached for
/// the next quote's smoothing branch), and `last_oracle_valid`. Pure
/// PerpMarket-side: does not write any AMM fields.
pub fn refresh_perp_market_stats_from_oracle(
    market: &mut PerpMarket,
    mm_oracle_price_data: &MMOraclePriceData,
    oracle_validity: Option<OracleValidity>,
    now: i64,
    clock_slot: u64,
) -> DriftResult<()> {
    let Some(oracle_validity) = oracle_validity else {
        return Ok(());
    };

    let reserve_price_after = market.amm.reserve_price()?;

    if is_oracle_valid_for_action(oracle_validity, Some(DriftAction::UpdateTwap))? {
        let sanitize_clamp_denominator = market.get_sanitize_clamp_denominator()?;
        let funding_period = market.market_stats.funding_period;
        let crate::state::perp_market::PerpMarket {
            amm, market_stats, ..
        } = market;
        market_stats.update_oracle_twap(
            amm,
            now,
            mm_oracle_price_data,
            Some(reserve_price_after),
            sanitize_clamp_denominator,
            funding_period,
        )?;
    }

    // Cache the fresh reference_price_offset so the next quote can
    // smooth-transition off the previous value. Spread reserves themselves
    // are still computed on demand via `compute_amm_quote_state`; we only
    // persist the single integer needed by the smoothing branch.
    let amm_quote_state = crate::amm::math::spread::compute_amm_quote_state(
        &market.amm,
        &market.market_stats,
        mm_oracle_price_data,
        reserve_price_after,
        clock_slot,
    )?;
    market.market_stats.last_reference_price_offset = amm_quote_state.reference_price_offset;

    market.market_stats.last_oracle_valid =
        is_oracle_valid_for_action(oracle_validity, Some(DriftAction::FillOrderAmmLowRisk))?;

    Ok(())
}

pub fn update_amm_and_check_validity(
    market: &mut PerpMarket,
    mm_oracle_price_data: &MMOraclePriceData,
    state: &State,
    now: i64,
    clock_slot: u64,
    action: Option<DriftAction>,
) -> DriftResult {
    // Explicit two-step refresh — see `update_amms` for the rationale.
    let validity = compute_amm_refresh_validity(market, mm_oracle_price_data, state)?;
    dispatch_amm_refresh(market, mm_oracle_price_data, validity, clock_slot)?;
    refresh_perp_market_stats_from_oracle(market, mm_oracle_price_data, validity, now, clock_slot)?;

    // 1 hour EMA
    let risk_ema_price = market
        .market_stats
        .historical_oracle_data
        .last_oracle_price_twap;

    let oracle_validity = oracle_validity(
        MarketType::Perp,
        market.market_index,
        risk_ema_price,
        &mm_oracle_price_data.get_safe_oracle_price_data(),
        &state.oracle_guard_rails.validity,
        market.get_max_confidence_interval_multiplier()?,
        &market.oracle_source,
        LogMode::SafeMMOracle,
        market.oracle_slot_delay_override,
        market.oracle_low_risk_slot_delay_override,
    )?;

    validate!(
        is_oracle_valid_for_action(oracle_validity, action)?,
        ErrorCode::InvalidOracle,
        "Invalid Oracle ({:?} vs ema={:?}) for perp market index={} and action={:?}",
        mm_oracle_price_data.get_safe_oracle_price_data(),
        risk_ema_price,
        market.market_index,
        action
    )?;

    Ok(())
}

pub fn apply_cost_to_market(
    market: &mut PerpMarket,
    cost: i128,
    check_lower_bound: bool,
) -> DriftResult<bool> {
    // Compute the protocol's reserved floor from PerpMarket-level state
    // (fields the AMM trait surface can't see), then dispatch the actual
    // bookkeeping to the AMM's `apply_cost` method. No direct AMM field
    // writes happen at this layer.
    let total_fee_floor = repeg::get_total_fee_lower_bound(market)?
        .safe_add(market.total_liquidation_fee)?
        .safe_sub(market.amm.total_fee_withdrawn)?
        .cast::<i128>()?;
    market
        .amm
        .apply_cost(cost, check_lower_bound, total_fee_floor)
}

pub fn settle_expired_market(
    market_index: u16,
    market_map: &PerpMarketMap,
    _oracle_map: &mut OracleMap,
    spot_market_map: &SpotMarketMap,
    _state: &State,
    clock: &Clock,
) -> DriftResult {
    let now = clock.unix_timestamp;
    let market = &mut market_map.get_ref_mut(&market_index)?;

    validate!(
        market.expiry_ts != 0,
        ErrorCode::MarketSettlementAttemptOnActiveMarket,
        "Market isn't set to expire"
    )?;

    validate!(
        market.expiry_ts <= now,
        ErrorCode::MarketSettlementAttemptTooEarly,
        "Market hasn't expired yet (expiry={} > now{})",
        market.expiry_ts,
        now
    )?;

    let spot_market = &mut spot_market_map.get_ref_mut(&QUOTE_SPOT_MARKET_INDEX)?;
    let fee_reserved_for_protocol = repeg::get_total_fee_lower_bound(market)?
        .safe_add(market.total_liquidation_fee)?
        .safe_sub(market.amm.total_fee_withdrawn)?
        .cast::<i128>()?;
    let budget = market
        .amm
        .total_fee_minus_distributions
        .safe_sub(fee_reserved_for_protocol)?
        .max(0);

    let available_fee_pool = get_token_amount(
        market.amm.fee_pool.scaled_balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?
    .cast::<i128>()?
    .safe_sub(fee_reserved_for_protocol)?
    .max(0);

    let fee_pool_transfer = budget.min(available_fee_pool);

    update_spot_balances(
        fee_pool_transfer.unsigned_abs(),
        &SpotBalanceType::Borrow,
        spot_market,
        &mut market.amm.fee_pool,
        false,
    )?;

    update_spot_balances(
        fee_pool_transfer.unsigned_abs(),
        &SpotBalanceType::Deposit,
        spot_market,
        &mut market.pnl_pool,
        false,
    )?;

    if budget > 0 {
        let (k_scale_numerator, k_scale_denominator) = cp_curve::calculate_budgeted_k_scale(
            &market.amm,
            budget.cast()?,
            K_BPS_UPDATE_SCALE * 100,
            K_BPS_UPDATE_SCALE,
        )?;

        let new_sqrt_k = bn::U192::from(market.amm.sqrt_k)
            .safe_mul(bn::U192::from(k_scale_numerator))?
            .safe_div(bn::U192::from(k_scale_denominator))?
            .min(bn::U192::from(MAX_SQRT_K));

        let update_k_result = get_update_k_result(&market.amm, market.status, new_sqrt_k, true)?;

        let adjustment_cost = cp_curve::adjust_k_cost(&market.amm, &update_k_result)?;

        let cost_applied = apply_cost_to_market(market, adjustment_cost, true)?;

        validate!(
            cost_applied,
            ErrorCode::InvalidUpdateK,
            "Issue applying k increase on market"
        )?;

        if cost_applied {
            market.amm.apply_k_update(&update_k_result)?;
        }
    }

    validate!(
        10_u128.pow(spot_market.decimals) == QUOTE_PRECISION,
        ErrorCode::UnsupportedSpotMarket,
        "Only support bank.decimals == QUOTE_PRECISION"
    )?;

    let target_expiry_price = if market.oracle_source == OracleSource::Prelaunch {
        market.market_stats.historical_oracle_data.last_oracle_price
    } else {
        market
            .market_stats
            .historical_oracle_data
            .last_oracle_price_twap_5min
    };

    crate::dlog!(target_expiry_price);

    validate!(
        target_expiry_price > 0,
        ErrorCode::MarketSettlementTargetPriceInvalid,
        "target_expiry_price <= 0 {}",
        target_expiry_price
    )?;

    let pnl_pool_token_amount = get_token_amount(
        market.pnl_pool.scaled_balance,
        spot_market,
        market.pnl_pool.balance_type(),
    )?;

    let fee_pool_token_amount = get_token_amount(
        market.amm.fee_pool.scaled_balance,
        spot_market,
        market.amm.fee_pool.balance_type(),
    )?;

    let total_excess_balance: i128 = pnl_pool_token_amount
        .safe_add(fee_pool_token_amount)?
        .cast()?;

    crate::dlog!(market.market_index);
    crate::dlog!(total_excess_balance);

    let expiry_price = amm::calculate_expiry_price(
        &market.amm,
        target_expiry_price,
        total_excess_balance,
        market.quote_asset_amount,
        market.order_step_size,
    )?;

    market.expiry_price = expiry_price;
    market.status = MarketStatus::Settlement;

    crate::dlog!(market.expiry_price);

    Ok(())
}
