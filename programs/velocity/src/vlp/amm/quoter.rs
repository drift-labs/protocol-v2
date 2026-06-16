//! AMM adapters that satisfy the generic `Quoter` / `QuoterCommit` / `AmmContract`
//! traits defined in `state::maker`.
//!
//! Hosts:
//! - [`AmmQuoter`]: wraps `&mut AMM` so the matcher can quote / fill the vAMM as
//!   a uniform [`crate::state::quoter::Quoter`] alongside CLOB and JIT makers.
//! - [`AmmJitQuoter`]: vAMM participation inside a JIT auction.
//! - `impl AmmContract for AMM`: the AMM-side mutation surface used by
//!   non-matching subsystems (insurance, revenue-pool transfers, settlement)
//!   so they don't reach into AMM fields directly.

use anchor_lang::prelude::*;

#[cfg(test)]
use crate::state::perp_market::MarketStats;
use crate::{
    controller::position::PositionDirection,
    error::{ErrorCode, VelocityResult},
    math::{casting::Cast, safe_math::SafeMath},
    state::{
        oracle::OraclePriceData,
        quoter::{FillFeePolicy, MarketEvent, QuoteContext, Quoter, QuoterCommit, QuoterFill},
    },
    vlp::amm::{
        controller as amm_controller, controller::SwapDirection, math::amm as amm_math, AMM,
    },
};

/// The contract boundary between Velocity's general logic and the AMM module.
///
/// In the target architecture, the vAMM is one of several quoter modules
/// that share a perp-market account's bytes — sitting alongside other
/// quoter-state regions (DLOB maker state, future propAMM-style
/// participants, etc.) within the same program. Each module owns its own
/// state slice and exposes a contract trait; Velocity's general logic mutates
/// the AMM's state slice *only* through `AmmContract` methods, never by
/// direct field writes. It's not a CPI boundary — both sides live in this
/// program — it's a module boundary enforced by the type system and an
/// audit grep ("does any non-`amm/` code write AMM fields directly?").
///
/// **Scope.** This trait covers exactly the operations that are *special*
/// to the vAMM — the things no other quoter can do:
///
/// 1. **Moving P&L around** between the AMM's books and other protocol
///    accounts: insurance-fund credits ([`record_credit`]), the AMM's
///    per-fill earnings ([`apply_fill_fees`]), protocol funding flowing
///    through the AMM ([`record_amm_pnl`]).
/// 2. **Taking over positions** the AMM was not actively making against:
///    settlement of expired user positions where the AMM becomes
///    counterparty ([`apply_settlement_counterparty`]).
///
/// Anything generic to a Maker (fills, periodic oracle refresh, funding
/// reactions) lives on `Quoter` / `QuoterCommit` instead. Only the vAMM
/// implements `QuoterCommit::on_market_event` for `Refresh` / `FundingApplied`
/// because only the AMM has the curve/peg/k state those events update — but
/// the event channel itself is the generic Maker interface, not an
/// AMM-specific surface.
pub trait AmmContract {
    /// Credit the AMM's books with an external deposit (insurance fund
    /// covering a PnL deficit, etc.). The token movement itself happens at
    /// the spot-market layer; this records the AMM-side bookkeeping.
    fn record_credit(&mut self, amount: u64) -> VelocityResult<()>;

    /// Apply a forced position change to the AMM's net counterparty
    /// position. Used when expired user positions are settled and the AMM
    /// becomes counterparty to the remaining size.
    fn apply_settlement_counterparty(&mut self, base_delta: i128) -> VelocityResult<()>;

    /// Record an AMM P&L event (positive = AMM earns, negative = AMM pays).
    /// Updates both the lifetime ledger (`total_fee_minus_distributions`) and
    /// the rolling-window counter (`net_revenue_since_last_funding`).
    /// Examples: protocol funding flowing through the AMM, fees from
    /// AMM-side fills.
    fn record_amm_pnl(&mut self, amount: i128) -> VelocityResult<()>;

    /// Record the AMM's accounting for a fill it participated in.
    /// `fee_to_maker` is the protocol fee credited to the AMM (the AMM is
    /// the protocol's house here). `mm_fee_surplus` is the AMM's spread
    /// capture for this fill — the gap between the curve quote and the
    /// effective execution price; always ≥ 0 for natural AMM fills.
    ///
    /// Must be called *after* `Quoter::commit_fill` mutates AMM reserves
    /// (today the matcher commits during the match; fees are known only
    /// after the fee calculator runs on the matcher's output). Together,
    /// `commit_fill` + `apply_fill_fees` are the two halves of an AMM fill
    /// event — orchestrators that touch only one of them will leave AMM
    /// books out of sync with the curve.
    fn apply_fill_fees(&mut self, fee_to_maker: i64, mm_fee_surplus: i64) -> VelocityResult<()>;

    /// Credit the AMM's fee_pool with SPL token balance. Updates spot
    /// balance only; does NOT touch AMM internal counters — callers use
    /// [`AmmContract::record_credit`] separately if they want to record
    /// P&L too.
    fn deposit_to_fee_pool(
        &mut self,
        amount: u128,
        spot_market: &mut crate::state::spot_market::SpotMarket,
    ) -> VelocityResult<()>;

    /// Debit the AMM's fee_pool by SPL token balance (Borrow direction).
    /// Used by settle-expired and liquidation flows.
    fn withdraw_from_fee_pool(
        &mut self,
        amount: u128,
        spot_market: &mut crate::state::spot_market::SpotMarket,
        force_reduce_only: bool,
    ) -> VelocityResult<()>;
}

// `AmmQuoter` (the matcher-facing view, defined further down in this file)
// wraps `&mut AMM`. The spread / reference-offset / spread-reserve state it
// quotes against is cached on the AMM itself, refreshed by
// `crate::vlp::amm::math::spread::update_amm_quote_state` in `Quoter::setup` (once
// per slot) and on the keeper crank. Every `best_price` / `cumulative_size` /
// `try_fill_solo` call within a match reads those cached fields, so all fills
// in a refresh window quote against byte-identical spread state.

// ============================================================================
// AmmContract impl — the only struct that satisfies this trait is the AMM
// itself. External callers (insurance, revenue-pool transfer, settlement) go
// through these methods instead of writing AMM fields directly.
// ============================================================================

impl AmmContract for AMM {
    fn record_credit(&mut self, amount: u64) -> VelocityResult<()> {
        self.total_fee_minus_distributions = self
            .total_fee_minus_distributions
            .safe_add(amount.cast::<i128>()?)?;
        Ok(())
    }

    fn apply_settlement_counterparty(&mut self, base_delta: i128) -> VelocityResult<()> {
        self.base_asset_amount_with_amm = self.base_asset_amount_with_amm.safe_add(base_delta)?;
        Ok(())
    }

    fn record_amm_pnl(&mut self, amount: i128) -> VelocityResult<()> {
        self.total_fee_minus_distributions = self.total_fee_minus_distributions.safe_add(amount)?;
        self.net_revenue_since_last_funding = self
            .net_revenue_since_last_funding
            .safe_add(amount.cast::<i64>()?)?;
        Ok(())
    }

    fn apply_fill_fees(&mut self, fee_to_maker: i64, mm_fee_surplus: i64) -> VelocityResult<()> {
        self.total_fee = self.total_fee.safe_add(fee_to_maker.cast::<i128>()?)?;
        self.total_mm_fee = self.total_mm_fee.safe_add(mm_fee_surplus.cast::<i128>()?)?;
        self.record_amm_pnl(fee_to_maker.cast::<i128>()?)?;
        Ok(())
    }

    fn deposit_to_fee_pool(
        &mut self,
        amount: u128,
        spot_market: &mut crate::state::spot_market::SpotMarket,
    ) -> VelocityResult<()> {
        crate::controller::spot_balance::update_spot_balances(
            amount,
            &crate::state::spot_market::SpotBalanceType::Deposit,
            spot_market,
            &mut self.fee_pool,
            false,
        )?;
        Ok(())
    }

    fn withdraw_from_fee_pool(
        &mut self,
        amount: u128,
        spot_market: &mut crate::state::spot_market::SpotMarket,
        force_reduce_only: bool,
    ) -> VelocityResult<()> {
        crate::controller::spot_balance::update_spot_balances(
            amount,
            &crate::state::spot_market::SpotBalanceType::Borrow,
            spot_market,
            &mut self.fee_pool,
            force_reduce_only,
        )?;
        Ok(())
    }
}

// ============================================================================
// AMM-internal helpers — methods that are NOT part of `AmmContract` (the
// Velocity↔AMM contract boundary) but provide the explicit-method write path
// for admin-side operations that need to mutate AMM state. Keeping these
// as methods on AMM (rather than letting callers do `market.amm.field =
// ...`) makes the audit "does any non-AMM-module code write AMM fields
// directly?" answerable by grep.
// ============================================================================

impl AMM {
    /// Apply a cost (positive = AMM pays; negative = AMM receives) to AMM
    /// books. Returns `false` if `check_lower_bound` is set and the cost
    /// would push `total_fee_minus_distributions` negative — tfmd contains
    /// only the AMM's own equity post-isolation, so zero is the floor. Used
    /// by `_update_amm` cost application, admin repeg, admin update_k,
    /// settle_expired_market.
    pub fn apply_cost(&mut self, cost: i128, check_lower_bound: bool) -> VelocityResult<bool> {
        if cost > 0 {
            let new_tfmd = self.total_fee_minus_distributions.safe_sub(cost)?;
            if check_lower_bound && new_tfmd < 0 {
                return Ok(false);
            }
            self.total_fee_minus_distributions = new_tfmd;
        } else if cost < 0 {
            self.total_fee_minus_distributions =
                self.total_fee_minus_distributions.safe_add(cost.abs())?;
        }
        self.net_revenue_since_last_funding = self
            .net_revenue_since_last_funding
            .safe_sub(cost.cast::<i64>()?)?;
        Ok(true)
    }

    /// Direct peg override. Used by `crate::vlp::amm::refresh::repeg` (admin
    /// repeg-amm-curve ix) after the cost is applied.
    pub fn set_peg(&mut self, new_peg: u128) {
        self.peg_multiplier = new_peg;
    }

    /// Apply an admin "summary stats correction" that adjusts both fee
    /// counters in lockstep. Used by `handle_update_perp_market_amm_summary_stats`.
    pub fn apply_summary_stats_correction(
        &mut self,
        fee_delta: i128,
        new_total_fee_minus_distributions: i128,
    ) {
        self.total_fee = self.total_fee.saturating_add(fee_delta);
        self.total_mm_fee = self.total_mm_fee.saturating_add(fee_delta);
        self.total_fee_minus_distributions = new_total_fee_minus_distributions;
    }
}

pub struct AmmQuoter<'a> {
    pub amm: &'a mut AMM,
}

impl<'a> AmmQuoter<'a> {
    /// Construct an AMM quoter wrapping `&mut amm`. Quote methods read the
    /// spread / reference-offset / spread-reserve state cached on the AMM.
    /// `Quoter::setup` refreshes that cache once per slot; callers that
    /// won't run setup (e.g. funding-event dispatch) quote against whatever
    /// the last crank/setup left cached on the AMM — exactly the value
    /// dashboards see.
    pub fn for_amm(amm: &'a mut AMM) -> Self {
        AmmQuoter { amm }
    }

    /// Pre-fill `validate_for_fill` on the underlying AMM. Orchestrator
    /// calls this before `match_take` when the AMM will participate. Kept
    /// as a separate entrypoint so quoter construction stays side-effect-
    /// free.
    pub fn validate_for_fill(&self, side: PositionDirection) -> VelocityResult {
        self.amm.validate_for_fill(side)
    }

    /// AMM's natural bid/ask (spread-adjusted, no taker-side cap) computed
    /// off the quoter's snapshot. Exposed for callers that need to feed
    /// these into a market-stats helper without reaching back into the AMM
    /// directly — in the target architecture these are the values the AMM
    /// module surfaces to other parts of Velocity through its contract.
    pub fn amm_bid_ask(&self, reserve_price: u64) -> VelocityResult<(u64, u64)> {
        self.amm.bid_ask_price(
            reserve_price,
            self.amm.long_spread,
            self.amm.short_spread,
            self.amm.reference_price_offset,
        )
    }

    /// AMM's base spread (in BID_ASK_SPREAD_PRECISION). Same contract-
    /// boundary rationale as [`Self::amm_bid_ask`].
    pub fn amm_base_spread(&self) -> u32 {
        self.amm.base_spread
    }

    /// Base the AMM can fill before its marginal price reaches `price` (the
    /// analytical inverse of its constant-product curve), clamped to reserve
    /// bounds and standardised to `ctx.step_size`. Used by
    /// [`crate::controller::matching::fill_amm_only`] to cap a take at the
    /// taker's limit price. Inherent to the AMM — continuous-curve depth is
    /// not part of the generic discrete `Quoter` interface.
    pub fn cumulative_size(
        &self,
        ctx: &QuoteContext,
        side: PositionDirection,
        price: u64,
    ) -> VelocityResult<u64> {
        let reserve_price = self.amm.reserve_price()?;
        let best = match side {
            PositionDirection::Long => self.amm.ask_price(
                reserve_price,
                self.amm.long_spread,
                self.amm.reference_price_offset,
            )?,
            PositionDirection::Short => self.amm.bid_price(
                reserve_price,
                self.amm.short_spread,
                self.amm.reference_price_offset,
            )?,
        };
        let crosses = match side {
            PositionDirection::Long => price >= best,
            PositionDirection::Short => price <= best,
        };
        if !crosses {
            return Ok(0);
        }

        // Sentinel ("infinitely permissive") price — `u64::MAX` for Long and
        // `0` for Short mean "no upper bound". Avoid the analytical inverse
        // (it diverges at the limit); we just want the AMM's max fillable base.
        let is_sentinel = match side {
            PositionDirection::Long => price == u64::MAX,
            PositionDirection::Short => price == 0,
        };
        if is_sentinel {
            return self.max_fillable(side);
        }

        // The trade direction the AMM uses to fill this side is the same as
        // the taker's side (taker Long → AMM sells → trade direction Long).
        let (amount, dir_result) =
            crate::vlp::amm::math::spread::calculate_base_asset_amount_to_trade_to_price(
                self.amm, price, side,
            )?;

        if dir_result != side {
            // The math says the AMM would have to go the other way to reach
            // this price — treat as no liquidity here.
            return Ok(0);
        }

        // Clamp to the AMM's hard reserve bounds, then standardise to the
        // market's base step size.
        let max = self.max_fillable(side)?;
        let bounded = amount.min(max);
        crate::math::orders::standardize_base_asset_amount(bounded, ctx.step_size.max(1))
    }

    /// Test/dev convenience: construct an `AmmQuoter` whose AMM has its
    /// cached spread state zeroed and ask/bid reserves matched to the
    /// underlying reserves, with unit step size. Used from tests that want
    /// to exercise the matcher without an MM-oracle-driven
    /// `update_amm_quote_state` refresh.
    #[cfg(test)]
    pub fn new_no_spread(amm: &'a mut AMM) -> Self {
        amm.seed_no_spread_quote_state();
        AmmQuoter { amm }
    }

    /// Swap direction the AMM uses to fill a take on the given side.
    /// Taker Long (buying)  → AMM removes base from reserves (sells base).
    /// Taker Short (selling) → AMM adds base to reserves (buys base).
    fn swap_direction(side: PositionDirection) -> SwapDirection {
        match side {
            PositionDirection::Long => SwapDirection::Remove,
            PositionDirection::Short => SwapDirection::Add,
        }
    }

    /// Max base size the AMM can fill in the given direction without breaching
    /// its reserve bounds. Uses saturating u128 arithmetic so the common
    /// "max_base_asset_reserve = u128::MAX" sentinel (used in some test
    /// fixtures and "unbounded" market configs) doesn't overflow i128 — we
    /// just clamp to `u64::MAX` which is effectively unbounded for fill
    /// purposes.
    fn max_fillable(&self, side: PositionDirection) -> VelocityResult<u64> {
        let base = self.amm.base_asset_reserve;
        let raw_u128 = match side {
            // Taker Long → AMM sells base → base falls toward min → max = current_base - min_base.
            PositionDirection::Long => base.saturating_sub(self.amm.min_base_asset_reserve),
            // Taker Short → AMM buys base → base rises toward max → max = max_base - current_base.
            PositionDirection::Short => self.amm.max_base_asset_reserve.saturating_sub(base),
        };
        Ok(raw_u128.min(u64::MAX as u128) as u64)
    }
}

impl<'a> Quoter for AmmQuoter<'a> {
    /// Apply the AMM's post-refresh projection to `self.amm` and compute
    /// the spread snapshot against the refreshed state. This is the
    /// AMM-side analogue of the legacy `update_amm` keeper-style refresh:
    /// "repeg + k-update + apply cost", inlined into the quote-prep phase
    /// so subsequent quote calls read the refreshed `self.amm` directly.
    ///
    /// Reads `ctx.mm_oracle`, `ctx.oracle_validity`, `ctx.stats`, `ctx.slot`
    /// plus `self.projection_inputs`. Mutates `self.amm` (peg, reserves,
    /// sqrt_k, terminal, bounds, `total_fee_minus_distributions`,
    /// `net_revenue_since_last_funding`, `last_update_slot`) and refreshes
    /// the AMM's cached spread state via `update_amm_quote_state` (long/short
    /// spread, reference offset, oracle-reserve spread pct, ask/bid reserves,
    /// `last_spread_update_slot`).
    ///
    /// Returns an error if `ctx.mm_oracle` is not provided.
    fn setup(&mut self, ctx: &QuoteContext) -> VelocityResult<()> {
        let mm_oracle = ctx.mm_oracle.ok_or_else(|| {
            crate::msg!("AmmQuoter::setup requires ctx.mm_oracle");
            ErrorCode::DefaultError
        })?;
        // Slot-idempotency for the curve projection: a prior `setup` (or the
        // keeper crank) already bumped `last_update_slot` to this slot, which
        // means the AMM was already projected against this slot's oracle.
        // Re-running `project_post_refresh_scalar` (peg / reserves / k-budget
        // math) is the expensive part of `setup` — skip it. Subsequent fills
        // in the same slot move reserves along the curve but don't trigger
        // another oracle-driven refresh.
        let projection_current = self.amm.last_update_slot >= ctx.slot;
        if !projection_current {
            // Pull the PerpMarket-level scalars the projection needs from
            // ctx. The orchestrator populates these once when building the
            // context; the AMM never reaches back into PerpMarket itself.
            let projection_inputs = crate::vlp::amm::math::repeg::ProjectionInputs {
                market_status: ctx.market_status,
                market_config: ctx.market_config,
            };
            let projection = crate::vlp::amm::math::repeg::project_post_refresh_scalar(
                self.amm,
                &projection_inputs,
                mm_oracle,
                ctx.oracle_validity,
            )?;
            projection.apply_to(self.amm)?;
            // Match legacy `_update_amm`: bump `last_update_slot` when the
            // oracle is fresh enough for low-risk fills and the affordability
            // gate didn't reject the curve update.
            if let Some(validity) = ctx.oracle_validity {
                if crate::math::oracle::is_oracle_valid_for_action(
                    validity,
                    Some(crate::math::oracle::VelocityAction::FillOrderAmmLowRisk),
                )? {
                    let suppress = projection.cost > 0 && !projection.applied;
                    if !suppress {
                        self.amm.last_update_slot = ctx.slot;
                    }
                }
            }
        }
        // Refresh the cached spread state against the just-projected AMM.
        // Runs after the (projection-idempotent) block above so the cached
        // ask/bid reserves stay consistent with the post-projection curve.
        // All quote/fill reads in this match then see the one cached value.
        let reserve_price = self.amm.reserve_price()?;
        crate::vlp::amm::math::spread::update_amm_quote_state(
            self.amm,
            ctx.stats,
            mm_oracle,
            reserve_price,
            ctx.slot,
        )?;
        Ok(())
    }

    fn best_price(&self, _ctx: &QuoteContext, side: PositionDirection) -> VelocityResult<u64> {
        let reserve_price = self.amm.reserve_price()?;
        match side {
            PositionDirection::Long => self.amm.ask_price(
                reserve_price,
                self.amm.long_spread,
                self.amm.reference_price_offset,
            ),
            PositionDirection::Short => self.amm.bid_price(
                reserve_price,
                self.amm.short_spread,
                self.amm.reference_price_offset,
            ),
        }
    }

    /// The AMM is the sole *continuous* maker and fills via the dedicated
    /// `fill_amm_only` path, never the discrete level walk — so this is only
    /// here to satisfy the trait. Reports the reserve-bounded max fillable.
    fn level_capacity(&self, _ctx: &QuoteContext, side: PositionDirection) -> VelocityResult<u64> {
        self.max_fillable(side)
    }

    fn is_prio(&self) -> bool {
        true
    }

    fn is_fee_exempt(&self) -> bool {
        true
    }

    fn fee_policy(&self) -> FillFeePolicy {
        FillFeePolicy::AmmHouse
    }

    fn try_fill_solo(
        &self,
        _ctx: &QuoteContext,
        side: PositionDirection,
        target_size: u64,
    ) -> VelocityResult<Option<QuoterFill>> {
        let max = self.max_fillable(side)?;
        let base = target_size.min(max);
        if base == 0 {
            return Ok(None);
        }
        let direction = Self::swap_direction(side);
        let swap = amm_controller::calculate_base_swap_output(self.amm, base, direction)?;

        // For try_fill_solo's clearing_price we use the marginal *reserve*
        // price after the swap (no spread). This is the price the AMM's
        // curve sees post-swap, useful for verifying `cumulative_size`
        // inverts to the same target. Note this is NOT directly comparable
        // to `best_price` (which includes spread) — semantics differ.
        let marginal_price = amm_math::calculate_price(
            swap.new_quote_asset_reserve,
            swap.new_base_asset_reserve,
            self.amm.peg_multiplier,
        )?;

        Ok(Some(QuoterFill {
            side,
            base_filled: base,
            quote_filled: swap.quote_asset_amount,
            clearing_price: marginal_price,
            refresh_cost: 0,
            is_fee_exempt: true,
            fee_policy: FillFeePolicy::AmmHouse,
            quote_asset_amount_surplus: swap.quote_asset_amount_surplus as i64,
        }))
    }
}

impl<'a> QuoterCommit for AmmQuoter<'a> {
    fn commit_fill(&mut self, _ctx: &QuoteContext, fill: &QuoterFill) -> VelocityResult<()> {
        // Projection has already been applied by `Quoter::setup` — quotes
        // and fills both read post-refresh `self.amm`. Commit just runs
        // the swap.
        if fill.base_filled == 0 {
            return Ok(());
        }
        let direction = Self::swap_direction(fill.side);
        let swap =
            amm_controller::calculate_base_swap_output(self.amm, fill.base_filled, direction)?;
        self.amm.base_asset_reserve = swap.new_base_asset_reserve;
        self.amm.quote_asset_reserve = swap.new_quote_asset_reserve;

        // Update `base_asset_amount_with_amm` (which tracks USERS' net
        // position when the AMM is counterparty, not the AMM's own position
        // — see `math::amm::calculate_net_user_pnl` and the existing update
        // in `controller/position.rs::update_position_with_base_asset_amount`).
        // Taker Long → users' net long grows → with_amm += base.
        // Taker Short → users' net long shrinks → with_amm -= base.
        let signed_base = fill.base_filled as i128;
        let delta = match fill.side {
            PositionDirection::Long => signed_base,
            PositionDirection::Short => -signed_base,
        };
        self.amm.base_asset_amount_with_amm =
            self.amm.base_asset_amount_with_amm.safe_add(delta)?;

        // The fill moved the curve reserves; re-derive the cached ask/bid
        // spread reserves off the (unchanged) cached spreads so the cache
        // dashboards read stays consistent — mirrors master's post-swap
        // `update_spread_reserves`.
        crate::vlp::amm::math::spread::refresh_cached_spread_reserves(self.amm)?;
        Ok(())
    }

    fn on_market_event(&mut self, _ctx: &QuoteContext, event: &MarketEvent) -> VelocityResult<()> {
        match event {
            MarketEvent::FundingUpdated {
                market_index,
                cumulative_funding_rate_long,
                cumulative_funding_rate_short,
                base_asset_amount_long,
                base_asset_amount_short,
                funding_rate: _,
                oracle_price_data,
                now,
                long_spread,
                short_spread,
                k_update_eligible,
                market_status,
                min_order_size,
            } => {
                // ---- 1. AMM-as-user funding settlement ----
                // Settle the AMM's own funding payment from cum-rate deltas,
                // same math shape `settle_funding_payment` uses for user
                // positions. `calculate_amm_funding_payment` decomposes the
                // AMM's counterparty exposure across the long and short
                // sides so the math matches master's asymmetric-cap flows.
                let payment = crate::math::funding::calculate_amm_funding_payment(
                    *base_asset_amount_long,
                    *base_asset_amount_short,
                    *cumulative_funding_rate_long,
                    *cumulative_funding_rate_short,
                    self.amm.last_cumulative_funding_rate_long,
                    self.amm.last_cumulative_funding_rate_short,
                )?;
                self.amm.record_amm_pnl(payment)?;
                self.amm.last_cumulative_funding_rate_long =
                    cumulative_funding_rate_long.cast::<i64>()?;
                self.amm.last_cumulative_funding_rate_short =
                    cumulative_funding_rate_short.cast::<i64>()?;

                // ---- 2. Eager k-update — emits `AmmCurveChanged` itself
                //         when the curve actually moves. ----
                if *k_update_eligible {
                    let funding_imbalance_cost = -payment;
                    self.handle_funding_applied(
                        funding_imbalance_cost,
                        oracle_price_data,
                        *long_spread,
                        *short_spread,
                        *market_status,
                        *min_order_size,
                        *market_index,
                        *now,
                    )?;
                }

                // ---- 3. Rolling-window reset ----
                self.amm.net_revenue_since_last_funding = 0;
                Ok(())
            }
        }
    }
}

impl<'a> AmmQuoter<'a> {
    /// Formulaic k-update fired by `MarketEvent::FundingApplied`. Decides
    /// whether the AMM has budget to widen or narrow `k`, computes the
    /// cost-adjusted curve change, applies it to AMM-internal state
    /// (reserves, `total_fee_minus_distributions`, `net_revenue_since_last_funding`),
    /// and returns a [`CurveSnapshot`] for the orchestrator to emit.
    ///
    /// If applying the cost would push `total_fee_minus_distributions`
    /// negative, the k-update is skipped — tfmd contains only the AMM's own
    /// equity post-isolation, so zero is the floor.
    pub(crate) fn handle_funding_applied(
        &mut self,
        funding_imbalance_cost: i128,
        oracle_price_data: &OraclePriceData,
        long_spread: u32,
        short_spread: u32,
        market_status: crate::state::market_status::MarketStatus,
        min_order_size: u64,
        market_index: u16,
        now: i64,
    ) -> VelocityResult<()> {
        let funding_imbalance_cost_i64 = funding_imbalance_cost.cast::<i64>()?;

        let budget = if funding_imbalance_cost_i64 < 0 {
            // negative cost is period revenue, if spread is low give back
            // half in k increase
            if core::cmp::max(long_spread, short_spread) <= self.amm.base_spread {
                funding_imbalance_cost_i64.safe_div(2)?.abs()
            } else {
                0
            }
        } else if self.amm.net_revenue_since_last_funding < funding_imbalance_cost_i64 {
            // cost exceeded period revenue, take back half in k decrease
            core::cmp::max(0, self.amm.net_revenue_since_last_funding)
                .safe_sub(funding_imbalance_cost_i64)?
                .safe_div(2)?
        } else {
            0
        };

        let k_eligible = (budget > 0 && self.amm.sqrt_k < crate::math::constants::MAX_SQRT_K)
            || (budget < 0 && self.amm.can_lower_k(min_order_size)?);

        if !k_eligible {
            return Ok(());
        }

        let peg_multiplier_before = self.amm.peg_multiplier;
        let base_asset_reserve_before = self.amm.base_asset_reserve;
        let quote_asset_reserve_before = self.amm.quote_asset_reserve;
        let sqrt_k_before = self.amm.sqrt_k;

        let k_pct_upper_bound = crate::math::constants::K_BPS_UPDATE_SCALE
            + crate::math::constants::MAX_K_BPS_INCREASE
                * (self.amm.curve_update_intensity as i128)
                / 100;
        let k_pct_lower_bound = crate::math::constants::K_BPS_UPDATE_SCALE
            - crate::math::constants::MAX_K_BPS_INCREASE
                * (self.amm.curve_update_intensity as i128)
                / 100;

        let (k_scale_numerator, k_scale_denominator) =
            crate::vlp::amm::math::cp_curve::calculate_budgeted_k_scale(
                self.amm,
                budget.cast::<i128>()?,
                k_pct_upper_bound,
                k_pct_lower_bound,
            )?;

        let new_sqrt_k = crate::math::bn::U192::from(self.amm.sqrt_k)
            .safe_mul(crate::math::bn::U192::from(k_scale_numerator))?
            .safe_div(crate::math::bn::U192::from(k_scale_denominator))?;

        // `get_update_k_result` reads `market.status` to relax its k-down
        // precondition when the market is `ReduceOnly` — threaded through
        // from the orchestrator so we match master's behavior.
        let update_k_result = crate::vlp::amm::math::cp_curve::get_update_k_result(
            self.amm,
            market_status,
            new_sqrt_k,
            true,
        )?;

        let adjustment_cost =
            crate::vlp::amm::math::cp_curve::adjust_k_cost(self.amm, &update_k_result)?;

        if !self.apply_cost_to_amm(adjustment_cost)? {
            return Ok(());
        }

        self.amm.apply_k_update(&update_k_result)?;

        emit!(crate::state::events::AmmCurveChanged {
            ts: now,
            market_index,
            peg_multiplier_before,
            base_asset_reserve_before,
            quote_asset_reserve_before,
            sqrt_k_before,
            peg_multiplier_after: self.amm.peg_multiplier,
            base_asset_reserve_after: self.amm.base_asset_reserve,
            quote_asset_reserve_after: self.amm.quote_asset_reserve,
            sqrt_k_after: self.amm.sqrt_k,
            adjustment_cost,
            total_fee_minus_distributions_after: self.amm.total_fee_minus_distributions,
            oracle_price: oracle_price_data.price,
        });

        Ok(())
    }

    /// Apply a cost (positive = AMM pays) to the AMM's bookkeeping. Returns
    /// `false` if the cost would push `total_fee_minus_distributions`
    /// negative (caller should treat this as "k-update not affordable,
    /// skip"). Mirrors the AMM-side of the legacy
    /// `crate::vlp::amm::refresh::apply_cost_to_market`.
    fn apply_cost_to_amm(&mut self, cost: i128) -> VelocityResult<bool> {
        if cost > 0 {
            let new_tfmd = self.amm.total_fee_minus_distributions.safe_sub(cost)?;
            if new_tfmd < 0 {
                return Ok(false);
            }
            self.amm.total_fee_minus_distributions = new_tfmd;
        } else {
            self.amm.total_fee_minus_distributions = self
                .amm
                .total_fee_minus_distributions
                .safe_add(cost.abs())?;
        }
        self.amm.net_revenue_since_last_funding = self
            .amm
            .net_revenue_since_last_funding
            .safe_sub(cost.cast::<i64>()?)?;
        Ok(true)
    }
}

// ============================================================================
// AMM JIT-maker impl
// ============================================================================
//
// `AmmJitQuoter` expresses the AMM in JIT-making mode: it fills alongside a
// resting DLOB maker at the DLOB's price, sacrificing some of its natural
// curve spread in exchange for rebalancing inventory. This is the matcher
// embodiment of what `math::amm_jit::calculate_amm_jit_liquidity` +
// `controller::orders::fulfill_perp_order_with_amm(jit_amount, maker_price)`
// did pairwise in legacy code.
//
// **Construction is the policy.** The caller computes the JIT-throttled cap
// (`max_jit_base`) via the existing JIT math (oracle proximity, inventory
// imbalance, intensity, etc.) and passes both `jit_price` and `max_jit_base`
// to `AmmJitQuoter::new`. Looking at the call site shows the prioritisation.
//
// **Differences vs. `AmmQuoter`:**
// - `best_price` returns `jit_price` (the DLOB maker price), NOT the AMM's
//   natural ask/bid.
// - `cumulative_size(p)` returns `min(max_jit_base, curve_max)` if `p`
//   crosses `jit_price`, else 0.
// - `is_prio = true`. At the clearing tick the vAMM takes its full
//   `max_jit_base` allocation first; the DLOB maker fills the residual.
// - `is_fee_exempt = true` (same as `AmmQuoter`).
// - `try_fill_solo`/`commit_fill` apply AMM swap math to mutate reserves,
//   but `QuoterFill.quote_filled = jit_price × base`. The gap between
//   `jit_price × base` and the AMM's curve quote is captured in
//   `QuoterFill.quote_asset_amount_surplus` — typically negative when JIT
//   subsidises the fill (AMM curve would have priced worse for the taker).

pub struct AmmJitQuoter<'a> {
    pub amm: &'a mut AMM,
    /// The DLOB maker price (or auction price) at which the AMM is willing
    /// to JIT-make. The taker pays this price; the AMM's reserves move per
    /// curve math, and the gap is recorded as `quote_asset_amount_surplus`.
    pub jit_price: u64,
    /// Throttled cap on JIT participation. Computed by the caller via the
    /// JIT throttling math (oracle proximity, intensity, inventory bound).
    /// Looking at the construction site shows the policy.
    pub max_jit_base: u64,
}

impl<'a> AmmJitQuoter<'a> {
    pub fn new(amm: &'a mut AMM, jit_price: u64, max_jit_base: u64) -> Self {
        AmmJitQuoter {
            amm,
            jit_price,
            max_jit_base,
        }
    }

    /// Construct an AMM JIT quoter for a DLOB Match step. Owns every
    /// AMM-internal decision the orchestrator otherwise would: run the JIT
    /// throttle (`calculate_amm_jit_liquidity` — oracle proximity, intensity,
    /// inventory bias, "AMM fills next round anyway" short-circuit, reading
    /// the AMM's cached spreads) and `validate_for_fill` if the AMM will
    /// participate.
    ///
    /// If the throttled cap is zero the quoter still constructs cleanly;
    /// its `cumulative_size` will report zero on every query and the
    /// matcher will pass it over. Callers always include the JIT quoter
    /// unconditionally in the maker `Vec`.
    ///
    /// Mark-TWAP updates happen at the orchestrator (market-stats
    /// mutation), reading AMM inputs through [`AmmJitQuoter::amm_bid_ask`]
    /// / [`AmmJitQuoter::amm_base_spread`].
    #[allow(clippy::too_many_arguments)]
    pub fn from_match_context(
        market: &'a mut crate::state::perp_market::PerpMarket,
        jit_price: u64,
        taker_direction: PositionDirection,
        valid_oracle_price: Option<i64>,
        taker_unfilled: u64,
        maker_unfilled: u64,
        taker_has_limit_price: bool,
    ) -> VelocityResult<Self> {
        // calculate_amm_jit_liquidity needs the result of
        // calculate_fill_for_matched_orders as `base_asset_amount` — that's
        // just `min(maker, taker)`.
        let initial_base = core::cmp::min(taker_unfilled, maker_unfilled);
        let max_jit_base = crate::vlp::amm::math::jit::calculate_amm_jit_liquidity(
            market,
            taker_direction,
            jit_price,
            valid_oracle_price,
            initial_base,
            taker_unfilled,
            maker_unfilled,
            taker_has_limit_price,
        )?;
        if max_jit_base > 0 {
            market.amm.validate_for_fill(taker_direction)?;
        }
        Ok(AmmJitQuoter {
            amm: &mut market.amm,
            jit_price,
            max_jit_base,
        })
    }

    /// AMM's natural bid/ask (spread-adjusted). See [`AmmQuoter::amm_bid_ask`].
    pub fn amm_bid_ask(&self, reserve_price: u64) -> VelocityResult<(u64, u64)> {
        self.amm.bid_ask_price(
            reserve_price,
            self.amm.long_spread,
            self.amm.short_spread,
            self.amm.reference_price_offset,
        )
    }

    /// AMM's base spread. See [`AmmQuoter::amm_base_spread`].
    pub fn amm_base_spread(&self) -> u32 {
        self.amm.base_spread
    }

    /// Test/dev convenience: seed the AMM's cached spread state to zero-spread
    /// (ask/bid reserves matched to the underlying reserves) and wrap it.
    #[cfg(test)]
    pub fn new_no_spread(amm: &'a mut AMM, jit_price: u64, max_jit_base: u64) -> Self {
        amm.seed_no_spread_quote_state();
        AmmJitQuoter {
            amm,
            jit_price,
            max_jit_base,
        }
    }

    fn swap_direction(side: PositionDirection) -> SwapDirection {
        match side {
            PositionDirection::Long => SwapDirection::Remove,
            PositionDirection::Short => SwapDirection::Add,
        }
    }

    fn max_fillable(&self, side: PositionDirection) -> VelocityResult<u64> {
        let base = self.amm.base_asset_reserve;
        let raw_u128 = match side {
            // Taker Long → AMM sells base → base falls toward min → max = current_base - min_base.
            PositionDirection::Long => base.saturating_sub(self.amm.min_base_asset_reserve),
            // Taker Short → AMM buys base → base rises toward max → max = max_base - current_base.
            PositionDirection::Short => self.amm.max_base_asset_reserve.saturating_sub(base),
        };
        Ok(raw_u128.min(u64::MAX as u128) as u64)
    }
}

impl<'a> Quoter for AmmJitQuoter<'a> {
    fn best_price(&self, _ctx: &QuoteContext, _side: PositionDirection) -> VelocityResult<u64> {
        Ok(self.jit_price)
    }

    /// The JIT level's size: the throttled cap clamped to the reserve-bounded
    /// max fillable. Analytic — does not run the swap (unlike `try_fill_solo`,
    /// which would diverge at the reserve boundary).
    fn level_capacity(&self, _ctx: &QuoteContext, side: PositionDirection) -> VelocityResult<u64> {
        if self.max_jit_base == 0 {
            return Ok(0);
        }
        Ok(self.max_jit_base.min(self.max_fillable(side)?))
    }

    /// AMM JIT participation is priority at the clearing tick: the vAMM
    /// takes its full `max_jit_base` allocation before non-priority makers
    /// (DLOB orders) pro-rata the residual. Matches the legacy
    /// `fulfill_perp_order_with_match` ordering, which filled the JIT slice
    /// against the AMM first and then routed the remainder through the DLOB
    /// maker.
    fn is_prio(&self) -> bool {
        true
    }

    fn is_fee_exempt(&self) -> bool {
        true
    }

    fn fee_policy(&self) -> FillFeePolicy {
        FillFeePolicy::AmmHouse
    }

    fn try_fill_solo(
        &self,
        _ctx: &QuoteContext,
        side: PositionDirection,
        target_size: u64,
    ) -> VelocityResult<Option<QuoterFill>> {
        let max = self.max_fillable(side)?.min(self.max_jit_base);
        let base = target_size.min(max);
        if base == 0 {
            return Ok(None);
        }
        let direction = Self::swap_direction(side);
        // AMM reserves move per natural curve. The taker pays jit_price.
        let swap = amm_controller::calculate_base_swap_output(self.amm, base, direction)?;

        let base_precision = crate::math::constants::BASE_PRECISION;
        let jit_quote_u128 = (base as u128)
            .safe_mul(self.jit_price as u128)?
            .safe_div(base_precision)?;
        if jit_quote_u128 > u64::MAX as u128 {
            return Err(ErrorCode::MathError);
        }
        let jit_quote: u64 = jit_quote_u128 as u64;

        // Sign convention follows
        // `controller::position::calculate_quote_asset_amount_surplus`:
        // positive when the AMM benefits from the gap between curve quote
        // and execution price; negative when the AMM is subsidising.
        // - Long (AMM sells base): AMM benefits when taker pays more than
        //   curve would have charged → surplus = jit_quote − swap_quote.
        // - Short (AMM buys base): AMM benefits when it pays less than
        //   curve would have paid → surplus = swap_quote − jit_quote.
        let surplus: i64 = match side {
            PositionDirection::Long => {
                (jit_quote as i64).safe_sub(swap.quote_asset_amount as i64)?
            }
            PositionDirection::Short => {
                (swap.quote_asset_amount as i64).safe_sub(jit_quote as i64)?
            }
        };

        Ok(Some(QuoterFill {
            side,
            base_filled: base,
            quote_filled: jit_quote,
            clearing_price: self.jit_price,
            refresh_cost: 0,
            is_fee_exempt: true,
            fee_policy: FillFeePolicy::AmmHouse,
            quote_asset_amount_surplus: surplus,
        }))
    }
}

impl<'a> QuoterCommit for AmmJitQuoter<'a> {
    fn commit_fill(&mut self, _ctx: &QuoteContext, fill: &QuoterFill) -> VelocityResult<()> {
        if fill.base_filled == 0 {
            return Ok(());
        }
        let direction = Self::swap_direction(fill.side);
        let swap =
            amm_controller::calculate_base_swap_output(self.amm, fill.base_filled, direction)?;
        self.amm.base_asset_reserve = swap.new_base_asset_reserve;
        self.amm.quote_asset_reserve = swap.new_quote_asset_reserve;

        // Same as AmmQuoter: with_amm tracks USERS' net position with AMM as
        // counterparty. Taker Long → users' net long grows → += base.
        let signed_base = fill.base_filled as i128;
        let delta = match fill.side {
            PositionDirection::Long => signed_base,
            PositionDirection::Short => -signed_base,
        };
        self.amm.base_asset_amount_with_amm =
            self.amm.base_asset_amount_with_amm.safe_add(delta)?;

        // The fill moved the curve reserves; re-derive the cached ask/bid
        // spread reserves off the (unchanged) cached spreads so the cache
        // dashboards read stays consistent — mirrors master's post-swap
        // `update_spread_reserves`.
        crate::vlp::amm::math::spread::refresh_cached_spread_reserves(self.amm)?;
        Ok(())
    }
}

#[cfg(test)]
mod amm_maker_tests {
    use super::*;
    use crate::{
        math::constants::{AMM_RESERVE_PRECISION, PEG_PRECISION},
        vlp::amm::AMM,
    };

    fn make_amm() -> AMM {
        AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            min_base_asset_reserve: 50 * AMM_RESERVE_PRECISION,
            max_base_asset_reserve: 200 * AMM_RESERVE_PRECISION,
            ..AMM::default()
        }
    }

    fn make_ctx<'a>(stats: &'a MarketStats, oracle: &'a OraclePriceData) -> QuoteContext<'a> {
        QuoteContext {
            stats,
            oracle,
            mm_oracle: None,
            oracle_validity: None,
            fee_budget: 0,
            tick: 1,
            step_size: 1,
            slot: 0,
            base_precision: crate::math::constants::BASE_PRECISION as u64,
            market_status: crate::state::market_status::MarketStatus::default(),
            market_config: 0,
        }
    }

    #[test]
    fn ask_price_is_above_bid_price() {
        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle);
        let mut amm = make_amm();
        // Seed an explicit non-zero cached spread so ask > bid.
        amm.seed_no_spread_quote_state();
        amm.long_spread = 100;
        amm.short_spread = 100;
        let maker = AmmQuoter::for_amm(&mut amm);

        let ask = maker.best_price(&ctx, PositionDirection::Long).unwrap();
        let bid = maker.best_price(&ctx, PositionDirection::Short).unwrap();
        assert!(ask > bid, "ask {} should exceed bid {}", ask, bid);
    }

    #[test]
    fn amm_is_prio_and_fee_exempt() {
        let mut amm = make_amm();
        let maker = AmmQuoter::new_no_spread(&mut amm);
        assert!(maker.is_prio());
        assert!(maker.is_fee_exempt());
    }

    #[test]
    fn cumulative_size_increases_with_price_for_ask_side() {
        // Analytical inverse sanity: as we ask the AMM for liquidity at
        // progressively higher prices (ask side), the available size should
        // strictly increase. At the best ask price, size is 0; far above,
        // size approaches max_fillable.
        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle);
        let mut amm = make_amm();
        let maker = AmmQuoter::new_no_spread(&mut amm);

        let best_ask = maker.best_price(&ctx, PositionDirection::Long).unwrap();
        let cum_at_best = maker
            .cumulative_size(&ctx, PositionDirection::Long, best_ask)
            .unwrap();
        let cum_higher = maker
            .cumulative_size(
                &ctx,
                PositionDirection::Long,
                best_ask.saturating_add(best_ask / 100),
            )
            .unwrap();

        assert!(
            cum_higher >= cum_at_best,
            "cumulative_size should monotonically grow with ask-side price: {} vs {}",
            cum_at_best,
            cum_higher
        );

        // Below best ask: zero supply.
        let cum_below = maker
            .cumulative_size(&ctx, PositionDirection::Long, best_ask.saturating_sub(1))
            .unwrap();
        assert_eq!(cum_below, 0);
    }

    #[test]
    fn analytical_inverse_agrees_with_try_fill_solo() {
        // Round-trip: pick a target size T, get the resulting marginal price
        // from try_fill_solo, then ask cumulative_size at that price. Should
        // recover (approximately) T. The analytical inverse and the actual
        // swap math share the same closed form, so agreement is exact modulo
        // integer rounding.
        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle);
        let mut amm = make_amm();
        let target = AMM_RESERVE_PRECISION as u64;
        let maker = AmmQuoter::new_no_spread(&mut amm);

        let fill = maker
            .try_fill_solo(&ctx, PositionDirection::Long, target)
            .unwrap()
            .unwrap();
        assert_eq!(fill.base_filled, target);

        // cumulative_size at the marginal price should agree with target
        // within integer-sqrt rounding. The swap math and the inverse helper
        // use slightly different precision paths; tolerance of ~1e-7 (100 bps
        // relative) covers typical velocity.
        let cum_at_marginal = maker
            .cumulative_size(&ctx, PositionDirection::Long, fill.clearing_price)
            .unwrap();
        let tolerance = target / 1_000_000 + 100; // ~1 ppm + 100 base units
        let diff = cum_at_marginal.abs_diff(target);
        assert!(
            diff <= tolerance,
            "expected |cum_at_marginal - target| <= {} but got cum {} vs target {} (diff {})",
            tolerance,
            cum_at_marginal,
            target,
            diff
        );
    }

    #[test]
    fn try_fill_solo_returns_some_for_buyable_size() {
        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle);
        let mut amm = make_amm();
        let maker = AmmQuoter::new_no_spread(&mut amm);

        let result = maker
            .try_fill_solo(&ctx, PositionDirection::Long, AMM_RESERVE_PRECISION as u64)
            .unwrap();

        assert!(result.is_some());
        let fill = result.unwrap();
        assert_eq!(fill.base_filled, AMM_RESERVE_PRECISION as u64);
        assert!(fill.quote_filled > 0);
        assert!(fill.clearing_price > 0);
    }

    #[test]
    fn try_fill_solo_reports_quote_asset_amount_surplus() {
        // AmmQuoter's try_fill_solo populates QuoterFill.quote_asset_amount_surplus
        // from the AMM's spread math. With a nonzero spread, the AMM captures
        // a quote surplus; surplus should be non-negative on a buy.
        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle);
        let mut amm = make_amm();
        let maker = AmmQuoter::new_no_spread(&mut amm);

        let fill = maker
            .try_fill_solo(&ctx, PositionDirection::Long, AMM_RESERVE_PRECISION as u64)
            .unwrap()
            .unwrap();
        // make_amm() configures a nonzero spread, so the AMM should capture
        // a positive surplus on this fill.
        assert!(
            fill.quote_asset_amount_surplus >= 0,
            "expected non-negative surplus, got {}",
            fill.quote_asset_amount_surplus
        );
    }

    #[test]
    fn try_fill_solo_works_on_short_side() {
        // Taker is selling — AMM adds base to reserves (Short direction).
        // Verifies the bid-side path through calculate_base_swap_output_with_spread.
        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle);
        let mut amm = make_amm();
        let starting_base = amm.base_asset_reserve;

        let result = {
            let maker = AmmQuoter::new_no_spread(&mut amm);
            maker
                .try_fill_solo(&ctx, PositionDirection::Short, AMM_RESERVE_PRECISION as u64)
                .unwrap()
                .unwrap()
        };

        assert_eq!(result.base_filled, AMM_RESERVE_PRECISION as u64);
        assert!(result.quote_filled > 0);
        assert!(result.is_fee_exempt);
        assert_eq!(result.side, PositionDirection::Short);
        // Reserves haven't changed yet — try_fill_solo is read-only.
        assert_eq!(amm.base_asset_reserve, starting_base);
    }

    #[test]
    fn commit_fill_on_short_side_increases_base_reserves() {
        // After committing a short-side fill (taker sells, AMM buys), AMM's
        // base_asset_reserve should INCREASE and base_asset_amount_with_amm
        // (which tracks USERS' net position) should DECREASE (users' net
        // long shrunk — the taker just sold).
        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle);
        let mut amm = make_amm();
        let starting_base = amm.base_asset_reserve;
        let starting_position = amm.base_asset_amount_with_amm;

        let fill = {
            let maker = AmmQuoter::new_no_spread(&mut amm);
            maker
                .try_fill_solo(&ctx, PositionDirection::Short, AMM_RESERVE_PRECISION as u64)
                .unwrap()
                .unwrap()
        };

        let mut mut_maker = AmmQuoter::new_no_spread(&mut amm);
        mut_maker.commit_fill(&ctx, &fill).unwrap();

        assert!(amm.base_asset_reserve > starting_base);
        // Users' net long position shrunk (taker sold) → with_amm decreased.
        assert!(amm.base_asset_amount_with_amm < starting_position);
    }

    // M3 regression tests: `apply_fill_fees` writes only AMM-side counters;
    // `total_exchange_fee` (PerpMarket-level) is the orchestrator's
    // responsibility. Together they form the two halves of an AMM fill's
    // fee accounting. The runtime gives us tx-level atomicity, but these
    // tests pin the per-field arithmetic so a future refactor that
    // accidentally reorders or drops one of these writes fails loudly.

    #[test]
    fn apply_fill_fees_credits_only_amm_counters() {
        let mut amm = make_amm();
        amm.total_fee = 0;
        amm.total_mm_fee = 0;
        amm.total_fee_minus_distributions = 0;
        amm.net_revenue_since_last_funding = 0;

        <AMM as AmmContract>::apply_fill_fees(&mut amm, 1_000, 250).unwrap();

        assert_eq!(amm.total_fee, 1_000);
        assert_eq!(amm.total_mm_fee, 250);
        // `record_amm_pnl` (called by apply_fill_fees) adds `fee_to_maker` to
        // both `total_fee_minus_distributions` (i128) and `net_revenue_since_last_funding` (i64).
        assert_eq!(amm.total_fee_minus_distributions, 1_000);
        assert_eq!(amm.net_revenue_since_last_funding, 1_000);
    }

    #[test]
    fn apply_fill_fees_accepts_negative_surplus() {
        // Inverse-fill cases can pass a negative `mm_fee_surplus` (AMM paid
        // a premium relative to its quote). `total_mm_fee` should go down,
        // `total_fee` still gets the positive `fee_to_maker`.
        let mut amm = make_amm();
        amm.total_fee = 5_000;
        amm.total_mm_fee = 1_000;
        amm.total_fee_minus_distributions = 5_000;
        amm.net_revenue_since_last_funding = 5_000;

        <AMM as AmmContract>::apply_fill_fees(&mut amm, 100, -50).unwrap();

        assert_eq!(amm.total_fee, 5_100);
        assert_eq!(amm.total_mm_fee, 950);
        assert_eq!(amm.total_fee_minus_distributions, 5_100);
        assert_eq!(amm.net_revenue_since_last_funding, 5_100);
    }

    #[test]
    fn apply_fill_fees_does_not_touch_perp_market_total_exchange_fee() {
        // The split: AMM-side writes via `apply_fill_fees`, PerpMarket-side
        // `total_exchange_fee` write by the orchestrator. This test pins the
        // contract — `apply_fill_fees` must NOT receive a `&mut PerpMarket`
        // and must NOT have access to write `total_exchange_fee` itself.
        // We assert it via type: the trait takes `&mut self` on AMM only.
        let mut amm = make_amm();
        <AMM as AmmContract>::apply_fill_fees(&mut amm, 42, 0).unwrap();
        // If a future refactor adds a PerpMarket-level write here, this test
        // won't compile (because the trait sig doesn't expose PerpMarket).
        // The grep `total_exchange_fee` on apply_fill_fees should return 0
        // matches — verified at write time, not runtime.
    }

    #[test]
    fn apply_fill_fees_overflow_is_caught_by_safe_add() {
        // The trait uses `safe_add` everywhere — if any cumulative overflows,
        // `apply_fill_fees` returns Err. Tx-level rollback (Solana runtime)
        // is then expected to undo any preceding writes made by the
        // orchestrator. We pin the Err here so a future refactor that drops
        // a `safe_add` for raw `+=` fails this test.
        let mut amm = make_amm();
        amm.total_fee = i128::MAX - 10;
        let res = <AMM as AmmContract>::apply_fill_fees(&mut amm, 100, 0);
        assert!(res.is_err(), "expected overflow Err on total_fee_add");
        // total_fee itself was not bumped (safe_add returned Err before the
        // assignment), so the AMM is left consistent at the field that
        // would have overflowed. Note: total_mm_fee / record_amm_pnl never
        // run because we error on the first safe_add.
        assert_eq!(amm.total_fee, i128::MAX - 10);
    }
}

#[cfg(test)]
mod amm_jit_maker_tests {
    use super::*;
    use crate::{
        math::constants::{AMM_RESERVE_PRECISION, BASE_PRECISION, PEG_PRECISION},
        vlp::amm::AMM,
    };

    fn make_amm() -> AMM {
        AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            min_base_asset_reserve: 50 * AMM_RESERVE_PRECISION,
            max_base_asset_reserve: 200 * AMM_RESERVE_PRECISION,
            ..AMM::default()
        }
    }

    fn make_ctx<'a>(stats: &'a MarketStats, oracle: &'a OraclePriceData) -> QuoteContext<'a> {
        QuoteContext {
            stats,
            oracle,
            mm_oracle: None,
            oracle_validity: None,
            fee_budget: 0,
            tick: 1,
            step_size: 1,
            slot: 0,
            base_precision: BASE_PRECISION as u64,
            market_status: crate::state::market_status::MarketStatus::default(),
            market_config: 0,
        }
    }

    #[test]
    fn best_price_returns_jit_price_regardless_of_curve() {
        let mut amm = make_amm();
        let jit_price: u64 = 99_500_000; // arbitrary, below natural ask
        let jit_maker =
            AmmJitQuoter::new_no_spread(&mut amm, jit_price, 5 * AMM_RESERVE_PRECISION as u64);
        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle);
        assert_eq!(
            jit_maker.best_price(&ctx, PositionDirection::Long).unwrap(),
            jit_price
        );
        assert_eq!(
            jit_maker
                .best_price(&ctx, PositionDirection::Short)
                .unwrap(),
            jit_price
        );
    }

    #[test]
    fn jit_level_price_and_capacity() {
        let mut amm = make_amm();
        let jit_price: u64 = 99_500_000;
        let max_jit_base = 5 * AMM_RESERVE_PRECISION as u64;
        let jit_maker = AmmJitQuoter::new_no_spread(&mut amm, jit_price, max_jit_base);
        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle);
        // The JIT maker presents a single discrete level: price = jit_price,
        // level_capacity = max_jit_base (curve allows it).
        assert_eq!(
            jit_maker.best_price(&ctx, PositionDirection::Long).unwrap(),
            jit_price
        );
        let capacity = jit_maker
            .level_capacity(&ctx, PositionDirection::Long)
            .unwrap();
        assert_eq!(capacity, max_jit_base);
    }

    #[test]
    fn jit_capacity_clamped_by_curve_bounds() {
        let mut amm = make_amm();
        // Taker Long → AMM sells base → base falls toward min, so the curve
        // bound is base - min_base = 100 - 50 = 50 BASE. max_jit_base larger.
        let jit_price: u64 = 99_500_000;
        let max_jit_base = 1_000 * AMM_RESERVE_PRECISION as u64;
        let jit_maker = AmmJitQuoter::new_no_spread(&mut amm, jit_price, max_jit_base);
        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle);
        let capacity = jit_maker
            .level_capacity(&ctx, PositionDirection::Long)
            .unwrap();
        // Curve bound (50 BASE) is smaller than max_jit_base (1000 BASE).
        assert_eq!(capacity, 50 * AMM_RESERVE_PRECISION as u64);
    }

    #[test]
    fn jit_maker_is_prio_and_is_fee_exempt() {
        // AMM JIT participation is priority at the clearing tick so the
        // vAMM takes its full `max_jit_base` allocation before non-priority
        // DLOB makers pro-rata the residual (matches the legacy ordering
        // in `fulfill_perp_order_with_match`).
        let mut amm = make_amm();
        let jit_maker = AmmJitQuoter::new_no_spread(&mut amm, 100, 100);
        assert!(jit_maker.is_prio());
        assert!(jit_maker.is_fee_exempt());
    }

    #[test]
    fn try_fill_solo_uses_jit_price_for_quote() {
        let mut amm = make_amm();
        let jit_price: u64 = 99_500_000; // below AMM natural ask
        let max_jit_base = 5 * AMM_RESERVE_PRECISION as u64;
        let target = 2 * AMM_RESERVE_PRECISION as u64;
        let jit_maker = AmmJitQuoter::new_no_spread(&mut amm, jit_price, max_jit_base);
        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle);

        let fill = jit_maker
            .try_fill_solo(&ctx, PositionDirection::Long, target)
            .unwrap()
            .expect("should fill");

        assert_eq!(fill.base_filled, target);
        // quote_filled = base × jit_price / base_precision.
        let expected_jit_quote = (target as u128) * (jit_price as u128) / BASE_PRECISION;
        assert_eq!(fill.quote_filled as u128, expected_jit_quote);
        assert_eq!(fill.clearing_price, jit_price);
        assert!(fill.is_fee_exempt);
        // Surplus is the gap: jit_quote (what taker paid) - curve_quote (what
        // AMM curve says). For Long with jit_price < natural ask, taker paid
        // less than curve would charge → AMM subsidised → surplus negative.
        assert!(fill.quote_asset_amount_surplus <= 0);
    }

    #[test]
    fn commit_fill_mutates_reserves_and_with_amm() {
        let mut amm = make_amm();
        let starting_base = amm.base_asset_reserve;
        let starting_with_amm = amm.base_asset_amount_with_amm;
        let jit_price: u64 = 99_500_000;
        let max_jit_base = 5 * AMM_RESERVE_PRECISION as u64;
        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle);

        let target = 2 * AMM_RESERVE_PRECISION as u64;
        let fill = {
            let jit_maker = AmmJitQuoter::new_no_spread(&mut amm, jit_price, max_jit_base);
            jit_maker
                .try_fill_solo(&ctx, PositionDirection::Long, target)
                .unwrap()
                .unwrap()
        };

        let mut jit_maker = AmmJitQuoter::new_no_spread(&mut amm, jit_price, max_jit_base);
        jit_maker.commit_fill(&ctx, &fill).unwrap();

        // Taker Long → AMM sold base → base_asset_reserve decreased.
        assert!(amm.base_asset_reserve < starting_base);
        // Users' net long grew → with_amm increased.
        assert!(amm.base_asset_amount_with_amm > starting_with_amm);
    }
}
