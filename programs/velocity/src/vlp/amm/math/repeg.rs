use std::cmp::{max, min};

use crate::msg;
use crate::state::oracle::MMOraclePriceData;
use crate::state::perp_market::MarketConfigFlag;
use anchor_lang::prelude::AccountInfo;

use crate::error::*;
use crate::math::bn;
use crate::math::casting::Cast;
use crate::math::constants::{
    AMM_RESERVE_PRECISION_I128, BID_ASK_SPREAD_PRECISION_U128, PEG_PRECISION_I128,
    PRICE_TO_PEG_PRECISION_RATIO,
};
use crate::math::oracle;
use crate::math::oracle::OracleValidity;
use crate::math::safe_math::SafeMath;
use crate::vlp::amm::math::amm;
use crate::vlp::amm::math::cp_curve;

use crate::state::oracle::get_oracle_price;
use crate::state::oracle::OraclePriceData;
use crate::state::perp_market::{PerpMarket, AMM};
use crate::state::state::OracleGuardRails;
use crate::state::user::MarketType;

#[cfg(test)]
mod tests;

pub fn calculate_repeg_validity_from_oracle_account(
    market: &PerpMarket,
    oracle_account_info: &AccountInfo,
    terminal_price_before: u64,
    clock_slot: u64,
    oracle_guard_rails: &OracleGuardRails,
) -> VelocityResult<(bool, bool, bool, bool)> {
    let oracle_price_data =
        get_oracle_price(&market.oracle_source, oracle_account_info, clock_slot)?;
    let oracle_is_valid = oracle::oracle_validity(
        MarketType::Perp,
        market.market_index,
        market
            .market_stats
            .historical_oracle_data
            .last_oracle_price_twap,
        &oracle_price_data,
        &oracle_guard_rails.validity,
        market.get_max_confidence_interval_multiplier()?,
        &market.oracle_source,
        oracle::LogMode::ExchangeOracle,
        market.oracle_slot_delay_override,
        market.oracle_low_risk_slot_delay_override,
    )? == OracleValidity::Valid;

    let (oracle_is_valid, direction_valid, profitability_valid, price_impact_valid) =
        calculate_repeg_validity(
            market,
            &oracle_price_data,
            oracle_is_valid,
            terminal_price_before,
        )?;

    Ok((
        oracle_is_valid,
        direction_valid,
        profitability_valid,
        price_impact_valid,
    ))
}

pub fn calculate_repeg_validity(
    market: &PerpMarket,
    oracle_price_data: &OraclePriceData,
    oracle_is_valid: bool,
    terminal_price_before: u64,
) -> VelocityResult<(bool, bool, bool, bool)> {
    let OraclePriceData {
        price: oracle_price,
        confidence: oracle_conf,
        delay: _,
        has_sufficient_number_of_data_points: _,
        sequence_id: _,
    } = *oracle_price_data;

    let oracle_price_u128 = oracle_price.cast::<u64>()?;

    let (terminal_price_after, _terminal_quote_reserves, _terminal_base_reserves) =
        amm::calculate_terminal_price_and_reserves(&market.amm)?;

    let mut direction_valid = true;
    let mut price_impact_valid = true;
    let mut profitability_valid = true;

    // if oracle is valid: check on size/direction of repeg
    if oracle_is_valid {
        let reserve_price_after = amm::calculate_price(
            market.amm.quote_asset_reserve,
            market.amm.base_asset_reserve,
            market.amm.peg_multiplier,
        )?;

        let oracle_conf_band_top = oracle_price_u128.safe_add(oracle_conf)?;

        let oracle_conf_band_bottom = oracle_price_u128.safe_sub(oracle_conf)?;

        #[allow(clippy::comparison_chain)]
        if oracle_price_u128 > terminal_price_after {
            // only allow terminal up when oracle is higher
            if terminal_price_after < terminal_price_before {
                msg!(
                    "oracle: {:?}, termb: {:?}, terma: {:?},",
                    oracle_price_u128,
                    terminal_price_before,
                    terminal_price_after
                );
                direction_valid = false;
            }

            // only push terminal up to bottom of oracle confidence band
            if oracle_conf_band_bottom < terminal_price_after {
                profitability_valid = false;
            }

            // only push mark up to top of oracle confidence band
            if reserve_price_after > oracle_conf_band_top {
                price_impact_valid = false;
            }
        } else if oracle_price_u128 < terminal_price_after {
            // only allow terminal down when oracle is lower
            if terminal_price_after > terminal_price_before {
                msg!(
                    "oracle: {:?}, termb: {:?}, terma: {:?},",
                    oracle_price_u128,
                    terminal_price_before,
                    terminal_price_after
                );
                direction_valid = false;
            }

            // only push terminal down to top of oracle confidence band
            if oracle_conf_band_top > terminal_price_after {
                profitability_valid = false;
            }

            // only push mark down to bottom of oracle confidence band
            if reserve_price_after < oracle_conf_band_bottom {
                price_impact_valid = false;
            }
        }
    } else {
        direction_valid = false;
        price_impact_valid = false;
        profitability_valid = false;
    }

    Ok((
        oracle_is_valid,
        direction_valid,
        profitability_valid,
        price_impact_valid,
    ))
}

pub fn calculate_peg_from_target_price(
    quote_asset_reserve: u128,
    base_asset_reserve: u128,
    target_price: u64,
) -> VelocityResult<u128> {
    let new_peg = bn::U192::from(target_price)
        .safe_mul(bn::U192::from(base_asset_reserve))?
        .safe_div(bn::U192::from(quote_asset_reserve))?
        .safe_add(bn::U192::from(PRICE_TO_PEG_PRECISION_RATIO / 2))?
        .safe_div(bn::U192::from(PRICE_TO_PEG_PRECISION_RATIO))?
        .try_to_u128()?;
    Ok(new_peg.max(1))
}

pub fn adjust_peg_cost(
    market: &PerpMarket,
    new_peg_candidate: u128,
) -> VelocityResult<(PerpMarket, i128)> {
    let mut market_clone = *market;

    let cost = if new_peg_candidate != market_clone.amm.peg_multiplier {
        // Find the net market value before adjusting peg
        let (current_net_market_value, _) = market_clone.amm.inventory_value_and_pnl(0)?;

        market_clone.amm.peg_multiplier = new_peg_candidate;

        let (_new_net_market_value, cost) = market_clone
            .amm
            .inventory_value_and_pnl(current_net_market_value)?;
        cost
    } else {
        0_i128
    };

    Ok((market_clone, cost))
}

pub fn calculate_repeg_cost(amm: &AMM, new_peg: u128) -> VelocityResult<i128> {
    amm.quote_asset_reserve
        .cast::<i128>()?
        .safe_sub(amm.terminal_quote_asset_reserve.cast()?)?
        .safe_mul(
            new_peg
                .cast::<i128>()?
                .safe_sub(amm.peg_multiplier.cast()?)?,
        )?
        .safe_div(AMM_RESERVE_PRECISION_I128)
}

pub fn calculate_per_peg_cost(
    quote_asset_reserve: u128,
    terminal_quote_asset_reserve: u128,
) -> VelocityResult<i128> {
    // returns a signed per_peg_cost relative to delta peg
    // signed means that "cost" to amm is influenced whether delta_peg is the same sign

    let per_peg_cost = if quote_asset_reserve != terminal_quote_asset_reserve {
        quote_asset_reserve
            .cast::<i128>()?
            .safe_sub(terminal_quote_asset_reserve.cast::<i128>()?)?
            .safe_div_ceil(AMM_RESERVE_PRECISION_I128 / PEG_PRECISION_I128)?
    } else {
        0
    };

    // round to make magnitude higher
    Ok(if per_peg_cost > 0 {
        per_peg_cost.safe_add(1)?
    } else if per_peg_cost < 0 {
        per_peg_cost.safe_sub(1)?
    } else {
        per_peg_cost
    })
}

pub fn adjust_amm(
    market: &PerpMarket,
    optimal_peg: u128,
    budget: u128,
    adjust_k: bool,
) -> VelocityResult<(Box<PerpMarket>, i128)> {
    let curve_update_intensity = min(market.amm.curve_update_intensity, 100_u8).cast::<i128>()?;

    // return early
    if optimal_peg == market.amm.peg_multiplier || curve_update_intensity == 0 {
        return Ok((Box::new(*market), 0));
    }

    let delta_peg = optimal_peg
        .cast::<i128>()?
        .safe_sub(market.amm.peg_multiplier.cast()?)?; // PEG_PRECISION

    let mut per_peg_cost = calculate_per_peg_cost(
        market.amm.quote_asset_reserve,
        market.amm.terminal_quote_asset_reserve,
    )?; // PEG_PRECISION

    let budget_i128 = budget.cast::<i128>()?;

    let mut market_clone = Box::new(*market);
    let mut budget_delta_peg: i128;
    let mut budget_delta_peg_magnitude: u128 = 0;
    let cost: i128;
    let new_peg: u128;

    if per_peg_cost != 0 {
        budget_delta_peg = budget_i128
            .safe_mul(PEG_PRECISION_I128)?
            .safe_div(per_peg_cost)?; // PEG_PRECISION
        budget_delta_peg_magnitude = budget_delta_peg.unsigned_abs();
    }

    let use_optimal_peg = (per_peg_cost == 0 // if per peg cost is 0 => free
        || per_peg_cost > 0 && delta_peg < 0 // or if per peg positive and the direction is down => revenue
        || per_peg_cost < 0 && delta_peg > 0) // or if per peg negative and the direction is up => revenue
        || (budget_delta_peg_magnitude > delta_peg.unsigned_abs()); // the peg movement from full budget usage exceeds delta to optimal

    if use_optimal_peg {
        // use optimal peg
        new_peg = optimal_peg;
        cost = calculate_repeg_cost(&market_clone.amm, new_peg)?;
    } else {
        // use full budget peg
        let can_lower_k = market.amm.can_lower_k(market.market_stats.min_order_size)?;

        // equivalent to (but cheaper than) scaling down by .1%
        let adjustment_cost: i128 = if adjust_k
            && can_lower_k
            && !market.has_market_config_flag(MarketConfigFlag::DisableFormulaicKUpdate)
        {
            // TODO can be off by 1?

            // always let protocol-owned sqrt_k be either least .1% of lps or the base amount / min order
            let new_sqrt_k_lower_bound = market
                .amm
                .get_lower_bound_sqrt_k(market.market_stats.min_order_size)?;

            let new_sqrt_k = market
                .amm
                .sqrt_k
                .safe_sub(market.amm.sqrt_k.safe_div(1000)?)?
                .max(new_sqrt_k_lower_bound);

            let update_k_result = cp_curve::get_update_k_result(
                &market.amm,
                market.status,
                bn::U192::from(new_sqrt_k),
                true,
            )?;

            let adjustment_cost = market_clone
                .amm
                .adjust_k_cost_and_update(&update_k_result)?;
            per_peg_cost = calculate_per_peg_cost(
                market_clone.amm.quote_asset_reserve,
                market_clone.amm.terminal_quote_asset_reserve,
            )?;

            adjustment_cost
        } else {
            0
        };

        budget_delta_peg = budget_i128
            .safe_add(adjustment_cost.abs())?
            .safe_mul(PEG_PRECISION_I128)?
            .safe_div(per_peg_cost)?;

        budget_delta_peg_magnitude = budget_delta_peg.unsigned_abs();
        new_peg = if budget_delta_peg > 0 {
            market
                .amm
                .peg_multiplier
                .safe_add(budget_delta_peg_magnitude)
                .unwrap_or(u128::MAX)
        } else if market.amm.peg_multiplier > budget_delta_peg_magnitude {
            market
                .amm
                .peg_multiplier
                .safe_sub(budget_delta_peg_magnitude)?
        } else {
            1
        };

        cost = calculate_repeg_cost(&market_clone.amm, new_peg)?;
    }
    market_clone.amm.peg_multiplier = new_peg;

    Ok((market_clone, cost))
}

pub fn calculate_optimal_peg_and_budget(
    market: &PerpMarket,
    mm_oracle_price_data: &MMOraclePriceData,
) -> VelocityResult<(u128, u128, bool)> {
    let reserve_price_before = market.amm.reserve_price()?;

    let mut fee_budget = calculate_fee_pool(&market.amm)?;

    let target_price_i64 = mm_oracle_price_data.get_price();
    let target_price = target_price_i64.cast()?;
    let mut optimal_peg = calculate_peg_from_target_price(
        market.amm.quote_asset_reserve,
        market.amm.base_asset_reserve,
        target_price,
    )?;

    let optimal_peg_cost = calculate_repeg_cost(&market.amm, optimal_peg)?;

    let mut check_lower_bound = true;

    if fee_budget < max(0, optimal_peg_cost).cast()? {
        let half_max_price_spread = target_price
            .cast::<u128>()?
            .safe_mul(market.amm.max_spread.safe_div(2)?.cast()?)?
            .safe_div(BID_ASK_SPREAD_PRECISION_U128)?
            .cast::<i64>()?;

        let target_price_gap = reserve_price_before
            .cast::<i64>()?
            .safe_sub(target_price_i64)?;

        if target_price_gap.abs() > half_max_price_spread {
            let mark_adj = target_price_gap
                .abs()
                .safe_sub(half_max_price_spread)?
                .cast()?;

            let target_price = if target_price_gap < 0 {
                reserve_price_before.safe_add(mark_adj)?
            } else {
                reserve_price_before.safe_sub(mark_adj)?
            };
            optimal_peg = calculate_peg_from_target_price(
                market.amm.quote_asset_reserve,
                market.amm.base_asset_reserve,
                target_price.cast()?,
            )?;

            fee_budget = calculate_repeg_cost(&market.amm, optimal_peg)?.cast::<u128>()?;

            check_lower_bound = false;
        } else if fee_budget == 0 {
            check_lower_bound = false;
        }
    }

    Ok((optimal_peg, fee_budget, check_lower_bound))
}

/// Surplus the AMM can spend on curve adjustments: its own retained equity.
/// tfmd contains only the AMM's money post-isolation, so there is no
/// protocol floor to reserve — the drawdown breaker and `is_underwater`
/// remain the spending guards.
pub fn calculate_fee_pool(amm: &AMM) -> VelocityResult<u128> {
    Ok(amm.total_fee_minus_distributions.max(0).cast()?)
}

/// PerpMarket-level scalars `project_post_refresh` needs but the AMM
/// itself doesn't own. Copied out of `PerpMarket` once at the setup phase,
/// then handed to the AMM-side computation so the projection runs without
/// holding a `&PerpMarket` borrow. In the future CPI architecture these
/// scalars are what Velocity sends as inputs to each AMM-program call.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProjectionInputs {
    pub market_status: crate::state::market_status::MarketStatus,
    /// Raw `market_config` byte — checked against `MarketConfigFlag` bits
    /// inside `adjust_amm` (e.g. `DisableFormulaicKUpdate`).
    pub market_config: u8,
}

impl ProjectionInputs {
    pub fn from_market(market: &PerpMarket) -> Self {
        Self {
            market_status: market.status,
            market_config: market.market_config,
        }
    }
}

/// Scalar-input variant of `project_post_refresh`. Internally constructs a
/// synthetic `PerpMarket` (since `calculate_optimal_peg_and_budget` /
/// `adjust_amm` take `&PerpMarket` today). Keeps the math primitives
/// unchanged while letting callers project from a `&AMM` + the few
/// PerpMarket-level scalars they actually need.
pub fn project_post_refresh_scalar(
    amm: &AMM,
    inputs: &ProjectionInputs,
    mm_oracle_price_data: &MMOraclePriceData,
    oracle_validity: Option<OracleValidity>,
) -> VelocityResult<ProjectedAmmState> {
    let synthetic = PerpMarket {
        amm: *amm,
        status: inputs.market_status,
        market_config: inputs.market_config,
        ..PerpMarket::default()
    };
    project_post_refresh(&synthetic, mm_oracle_price_data, oracle_validity)
}

/// Pure snapshot of the AMM state that `project_post_refresh` would write if
/// it were a mutating refresh. `applied = false` means the projection is a
/// passthrough of current state (oracle not valid for curve update,
/// curve_update_intensity == 0, or the affordability check rejected the
/// debit) — in that case `cost == 0` and the four state fields equal the
/// AMM's current values.
#[derive(Debug, Clone, Copy)]
pub struct ProjectedAmmState {
    pub peg_multiplier: u128,
    pub base_asset_reserve: u128,
    pub quote_asset_reserve: u128,
    pub sqrt_k: u128,
    pub cost: i128,
    pub applied: bool,
}

impl ProjectedAmmState {
    /// Passthrough projection mirroring an AMM's current state. Used by
    /// callers that need an `AmmQuoter` without forcing a refresh
    /// computation (tests, JIT-auction quoters that work against a
    /// pre-frozen AMM snapshot, etc.).
    pub fn noop(amm: &AMM) -> Self {
        Self {
            peg_multiplier: amm.peg_multiplier,
            base_asset_reserve: amm.base_asset_reserve,
            quote_asset_reserve: amm.quote_asset_reserve,
            sqrt_k: amm.sqrt_k,
            cost: 0,
            applied: false,
        }
    }

    /// Build an AMM clone with the projection's curve fields written. Used
    /// by quote-side functions to materialise post-refresh reserves without
    /// touching the real AMM. The clone has `terminal_quote_asset_reserve`,
    /// `min_base_asset_reserve`, and `max_base_asset_reserve` recomputed via
    /// `apply_k_update`, so it's a complete projected snapshot suitable for
    /// `update_amm_quote_state` etc.
    pub fn projected_amm(&self, amm: &AMM) -> VelocityResult<AMM> {
        let mut clone = *amm;
        if !self.applied {
            return Ok(clone);
        }
        clone.apply_k_update(&cp_curve::UpdateKResult {
            sqrt_k: self.sqrt_k,
            base_asset_reserve: self.base_asset_reserve,
            quote_asset_reserve: self.quote_asset_reserve,
        })?;
        clone.peg_multiplier = self.peg_multiplier;
        Ok(clone)
    }

    /// Write the projection to a mutable AMM, debiting `cost` from
    /// `total_fee_minus_distributions` / `net_revenue_since_last_funding`.
    /// No-op when `applied == false`. Used by `commit_fill` (atomically
    /// with a swap) and `snap_to_oracle` (explicit keeper crank).
    pub fn apply_to(&self, amm: &mut AMM) -> VelocityResult<()> {
        if !self.applied {
            return Ok(());
        }
        amm.apply_k_update(&cp_curve::UpdateKResult {
            sqrt_k: self.sqrt_k,
            base_asset_reserve: self.base_asset_reserve,
            quote_asset_reserve: self.quote_asset_reserve,
        })?;
        amm.peg_multiplier = self.peg_multiplier;
        amm.total_fee_minus_distributions =
            amm.total_fee_minus_distributions.safe_sub(self.cost)?;
        amm.net_revenue_since_last_funding = amm
            .net_revenue_since_last_funding
            .safe_sub(self.cost.cast::<i64>()?)?;
        Ok(())
    }
}

/// Pure projection of "what (peg, reserves, sqrt_k) would the AMM be at if it
/// refreshed right now?" — no mutation. Composes the existing
/// `calculate_optimal_peg_and_budget` + `adjust_amm` pipeline and resolves
/// the affordability check (`check_lower_bound` against zero) so
/// callers receive the final values that would be written. Used by quote
/// functions (read-only) and by `commit_fill` / `snap_to_oracle` (apply).
pub fn project_post_refresh(
    market: &PerpMarket,
    mm_oracle_price_data: &MMOraclePriceData,
    oracle_validity: Option<OracleValidity>,
) -> VelocityResult<ProjectedAmmState> {
    let noop = ProjectedAmmState {
        peg_multiplier: market.amm.peg_multiplier,
        base_asset_reserve: market.amm.base_asset_reserve,
        quote_asset_reserve: market.amm.quote_asset_reserve,
        sqrt_k: market.amm.sqrt_k,
        cost: 0,
        applied: false,
    };

    let Some(validity) = oracle_validity else {
        return Ok(noop);
    };
    if !oracle::is_oracle_valid_for_action(validity, Some(oracle::VelocityAction::UpdateAMMCurve))?
    {
        return Ok(noop);
    }

    let curve_update_intensity = min(market.amm.curve_update_intensity, 100_u8);
    if curve_update_intensity == 0 {
        return Ok(noop);
    }

    let (optimal_peg, fee_budget, check_lower_bound) =
        calculate_optimal_peg_and_budget(market, mm_oracle_price_data)?;
    let (repegged, cost) = adjust_amm(
        market,
        optimal_peg,
        fee_budget,
        curve_update_intensity >= 100,
    )?;
    // Affordability: positive cost debits `total_fee_minus_distributions`;
    // if `check_lower_bound` is set and the debit would push tfmd negative,
    // the refresh is rejected. Matches `handle_refresh` / legacy
    // `apply_cost_to_market` semantics.
    let applied = if cost > 0 {
        let new_tfmd = market.amm.total_fee_minus_distributions.safe_sub(cost)?;
        !(check_lower_bound && new_tfmd < 0)
    } else {
        true
    };

    if applied {
        Ok(ProjectedAmmState {
            peg_multiplier: repegged.amm.peg_multiplier,
            base_asset_reserve: repegged.amm.base_asset_reserve,
            quote_asset_reserve: repegged.amm.quote_asset_reserve,
            sqrt_k: repegged.amm.sqrt_k,
            cost,
            applied: true,
        })
    } else {
        Ok(noop)
    }
}
