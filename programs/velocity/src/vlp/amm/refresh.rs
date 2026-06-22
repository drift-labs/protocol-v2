use crate::math::oracle::LogMode;
use crate::msg;
use crate::state::oracle::MMOraclePriceData;
use anchor_lang::prelude::AccountInfo;
use anchor_lang::prelude::*;

// `update_spreads`/`update_spread_reserves` folded into
// `math::spread::update_amm_quote_state`, which refreshes the AMM's cached
// spread state in place on each crank.
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
    is_oracle_valid_for_action, oracle_validity, OracleValidity, VelocityAction,
};
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_amount;
use crate::vlp::amm::math::amm;
use crate::vlp::amm::math::cp_curve;
use crate::vlp::amm::math::cp_curve::get_update_k_result;
use crate::vlp::amm::math::repeg;

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
) -> VelocityResult<i128> {
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
) -> VelocityResult<bool> {
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

        // Explicit two-step refresh:
        //   1. snap_to_oracle: AMM-side projection + apply + last_update_slot.
        //   2. PerpMarket::update_oracle_derived_stats: PerpMarket-level
        //      oracle bookkeeping (TWAPs, last_reference_price_offset,
        //      last_oracle_valid). Distinct concerns; both happen here
        //      because this keeper crank is the one place that touches both.
        let validity = compute_amm_refresh_validity(market, &mm_oracle_price_data, state)?;
        snap_to_oracle(market, &mm_oracle_price_data, validity, clock_slot)?;
        market.update_oracle_derived_stats(&mm_oracle_price_data, validity, now, clock_slot)?;
    }

    Ok(updated)
}

pub fn update_amm(
    market_index: u16,
    perp_market_map: &PerpMarketMap,
    oracle_map: &mut OracleMap,
    state: &State,
    clock: &Clock,
) -> VelocityResult<i128> {
    let market = &mut perp_market_map.get_ref_mut(&market_index)?;
    let oracle_price_data = oracle_map.get_price_data(&market.oracle_id())?;
    let mm_oracle_price_data = market.get_mm_oracle_price_data(
        *oracle_price_data,
        clock.slot,
        &state.oracle_guard_rails.validity,
    )?;

    // Same explicit two-step refresh as `update_amms`. See doc there.
    let validity = compute_amm_refresh_validity(market, &mm_oracle_price_data, state)?;
    let outcome: i128 = snap_to_oracle(market, &mm_oracle_price_data, validity, clock.slot)?;
    market.update_oracle_derived_stats(
        &mm_oracle_price_data,
        validity,
        clock.unix_timestamp,
        clock.slot,
    )?;

    Ok(outcome)
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
) -> VelocityResult<i128> {
    let validity = compute_amm_refresh_validity(market, mm_oracle_price_data, state)?;
    let outcome: i128 = snap_to_oracle(market, mm_oracle_price_data, validity, clock_slot)?;
    market.update_oracle_derived_stats(mm_oracle_price_data, validity, now, clock_slot)?;
    Ok(outcome)
}

/// Compute oracle validity for an AMM refresh, or return `None` if the
/// market is in Settlement/Delisted status (no refresh applicable).
pub fn compute_amm_refresh_validity(
    market: &PerpMarket,
    mm_oracle_price_data: &MMOraclePriceData,
    state: &State,
) -> VelocityResult<Option<OracleValidity>> {
    compute_amm_refresh_validity_with_guard_rails(
        market,
        mm_oracle_price_data,
        &state.oracle_guard_rails.validity,
    )
}

/// Same as `compute_amm_refresh_validity` but takes the guard-rail config
/// directly. Use this when you only have a `&ValidityGuardRails` available
/// (e.g. inside `fulfill_perp_order_step`, which doesn't carry `&State`).
pub fn compute_amm_refresh_validity_with_guard_rails(
    market: &PerpMarket,
    mm_oracle_price_data: &MMOraclePriceData,
    validity_guard_rails: &crate::state::state::ValidityGuardRails,
) -> VelocityResult<Option<OracleValidity>> {
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
        validity_guard_rails,
        market.get_max_confidence_interval_multiplier()?,
        &market.oracle_source,
        oracle::LogMode::SafeMMOracle,
        market.oracle_slot_delay_override,
        market.oracle_low_risk_slot_delay_override,
    )?;
    Ok(Some(validity))
}

/// Apply a projection to the AMM and bump `last_update_slot`. The single
/// explicit AMM-refresh entrypoint surviving in the target architecture —
/// invoked by the `update_amms` keeper crank to align stored peg with
/// oracle on quiet markets. Quote/fill paths refresh the AMM atomically
/// inside `QuoterCommit::commit_fill` instead.
///
/// Pure AMM-side: writes only AMM fields (peg, reserves, sqrt_k,
/// total_fee_minus_distributions, net_revenue_since_last_funding,
/// last_update_slot). PerpMarket-level oracle bookkeeping (oracle TWAPs,
/// last_reference_price_offset) is the orchestrator's job — call
/// `refresh_perp_market_stats_from_oracle` separately when needed.
pub fn snap_to_oracle(
    market: &mut PerpMarket,
    mm_oracle_price_data: &MMOraclePriceData,
    oracle_validity: Option<OracleValidity>,
    slot: u64,
) -> VelocityResult<i128> {
    let projection = repeg::project_post_refresh(market, mm_oracle_price_data, oracle_validity)?;

    let peg_before = market.amm.peg_multiplier;
    let base_before = market.amm.base_asset_reserve;
    let quote_before = market.amm.quote_asset_reserve;
    let sqrt_k_before = market.amm.sqrt_k;
    let market_index = market.market_index;
    let now = mm_oracle_price_data.get_exchange_oracle_price_data().delay;

    projection.apply_to(&mut market.amm)?;

    if projection.applied {
        emit!(crate::state::events::AmmCurveChanged {
            ts: now,
            market_index,
            peg_multiplier_before: peg_before,
            base_asset_reserve_before: base_before,
            quote_asset_reserve_before: quote_before,
            sqrt_k_before,
            peg_multiplier_after: market.amm.peg_multiplier,
            base_asset_reserve_after: market.amm.base_asset_reserve,
            quote_asset_reserve_after: market.amm.quote_asset_reserve,
            sqrt_k_after: market.amm.sqrt_k,
            adjustment_cost: projection.cost,
            total_fee_minus_distributions_after: market.amm.total_fee_minus_distributions,
            oracle_price: mm_oracle_price_data.get_safe_oracle_price_data().price,
        });
    }

    // Match `_update_amm`: only bump `last_update_slot` when the oracle is
    // fresh enough for low-risk fills AND the curve update wasn't rejected
    // by the affordability floor (mirrors the
    // `!amm_not_successfully_updated` gate). `last_oracle_valid` is a
    // PerpMarket-stats field — the orchestrator updates it via
    // `refresh_perp_market_stats_from_oracle` alongside this call.
    if let Some(validity) = oracle_validity {
        if is_oracle_valid_for_action(validity, Some(VelocityAction::FillOrderAmmLowRisk))? {
            if !projection.rejected_due_to_affordability {
                market.amm.last_update_slot = slot;
            }
        }
    }

    Ok(projection.cost)
}

pub fn update_amm_and_check_validity(
    market: &mut PerpMarket,
    mm_oracle_price_data: &MMOraclePriceData,
    state: &State,
    now: i64,
    clock_slot: u64,
    action: Option<VelocityAction>,
) -> VelocityResult {
    // PerpMarket-stats refresh + one-hour-EMA validity gate against the
    // requested action. AMM mutation happens later in the liquidation
    // fill flow via `Quoter::setup` — not here.
    let validity = compute_amm_refresh_validity(market, mm_oracle_price_data, state)?;
    market.update_oracle_derived_stats(mm_oracle_price_data, validity, now, clock_slot)?;

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
) -> VelocityResult<bool> {
    // Dispatch the bookkeeping to the AMM's `apply_cost` method (floor is
    // zero: tfmd contains only the AMM's own equity post-isolation). No
    // direct AMM field writes happen at this layer.
    market.amm.apply_cost(cost, check_lower_bound)
}

pub fn settle_expired_market(
    market_index: u16,
    market_map: &PerpMarketMap,
    _oracle_map: &mut OracleMap,
    spot_market_map: &SpotMarketMap,
    _state: &State,
    clock: &Clock,
) -> VelocityResult {
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
    // tfmd contains only the AMM's own equity post-isolation: the whole
    // surplus is spendable on the expiry settlement (no protocol floor)
    let budget = market.amm.total_fee_minus_distributions.max(0);

    let available_fee_pool = get_token_amount(
        market.amm.fee_pool.scaled_balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?
    .cast::<i128>()?
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
