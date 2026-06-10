//! # Quoter trait — the future shared-orderbook architecture
//!
//! Velocity already matches across multiple liquidity sources today. A fill can
//! land against a DLOB maker order, against a JIT auction participant,
//! against the vAMM, or against the vAMM front-running ahead of a DLOB
//! cross. The current matching is hard-coded for these specific paths in
//! `controller/orders.rs` and `controller/amm_jit.rs` — a degenerate
//! two-participant matcher with bespoke pairwise rules.
//!
//! The shape this code uses going forward: every liquidity source implements
//! [`Quoter`], exposing its single quoted price ([`Quoter::best_price`]) and
//! its closed-form fill ([`Quoter::try_fill_solo`]). The fill engine
//! (`controller/match.rs`) has two explicit paths: the sole continuous vAMM
//! curve (`fill_amm_only`), and a discrete level walk over single-price makers
//! (`match_take`) that sorts by price, fills best-first, and pro-ratas the
//! clearing level. Priority makers (`is_prio = true` — the JIT vAMM) take
//! their full marginal size before non-priority makers pro-rata the residual.
//! Fee-exempt makers (`is_fee_exempt = true` — the vAMM) skip the protocol
//! maker-fee schedule; standard makers (DLOB / JIT) pay/receive maker fees
//! per protocol rules.
//!
//! Settlement happens via per-maker [`QuoterCommit::commit_fill`]. The maker
//! is the sole authority on how its bytes mutate; the engine just hands it
//! the fill it won. Refresh cost (e.g. AMM repeg) flows out via
//! [`QuoterFill::refresh_cost`] and is summed into the result for the fill
//! controller to apply to PerpMarket.
//!
//! The vAMM is one `Quoter` impl (continuous, via `fill_amm_only`). DLOB
//! resting orders are another (each a single discrete price level). JIT
//! participants are a third. When off-chain market makers push Phoenix-style
//! spline regions, the program materialises them into discrete levels that
//! feed the same `match_take` walk — and the continuous-curve path is deleted
//! with the vAMM.
//!
//! See `docs/amm-decoupling-and-maker-interface.md` for the full design,
//! including matching pseudocode, pro-rata policy, snapshot consistency
//! rules, and out-of-scope items (cross-program makers via CPI;
//! tolerance-band pro-rata).

use crate::controller::position::PositionDirection;
use crate::error::{ErrorCode, VelocityResult};
use crate::math::safe_math::SafeMath;
use crate::state::oracle::{MMOraclePriceData, OraclePriceData};
use crate::state::perp_market::MarketStats;

/// Inputs the matcher shares with every maker during a single match.
///
/// Quote methods read from this; `commit_fill` reads from it again to
/// re-derive any conditional state updates (e.g. AMM repeg) so the maker
/// reaches the same conclusion at commit time as it did at quote time.
#[derive(Copy, Clone)]
pub struct QuoteContext<'a> {
    /// Historic market data — TWAPs, volatility, volume, mm-oracle. Written
    /// by `controller/market_stats.rs` from every fill path; read by makers
    /// when computing their quotes.
    pub stats: &'a MarketStats,
    /// Current oracle reading for the market.
    pub oracle: &'a OraclePriceData,
    /// MM-wrapped oracle reading. Required for makers whose `setup` derives
    /// post-refresh state from the same MM oracle the orchestrator's keeper
    /// crank uses (the AMM); `None` for callers that only need the plain
    /// `OraclePriceData` (DLOB, JIT) or that aren't invoking setup.
    pub mm_oracle: Option<&'a MMOraclePriceData>,
    /// Oracle validity classification, computed by the orchestrator. Threaded
    /// here so `setup` can decide whether to apply a curve update (AMM) or
    /// skip it. `None` mirrors the Settlement/Delisted passthrough.
    pub oracle_validity: Option<crate::math::oracle::OracleValidity>,
    /// Available protocol fee budget the AMM can consume for repeg / k-update.
    /// The fill controller reads this off the AMM's bookkeeping and passes
    /// it in as a scalar — the AMM itself does not reach into PerpMarket
    /// state.
    pub fee_budget: u64,
    /// The market's price tick — minimum **price** increment. Sourced from
    /// `PerpMarket::order_tick_size`.
    pub tick: u64,
    /// The market's base step — minimum **base-amount** increment a fill
    /// can take. Used by the AMM's `cumulative_size` (the `fill_amm_only`
    /// limit cap) to standardise its analytic-inverse output into valid lot
    /// sizes. Sourced from `PerpMarket::order_step_size`.
    pub step_size: u64,
    /// Current slot. Used by DLOB-order makers to determine auction state
    /// (an order in active auction prices differently than the same order
    /// resting post-auction).
    pub slot: u64,
    /// Base-asset precision divisor: when computing `quote_amount` from a
    /// base amount filled at a price, the formula is
    /// `quote = base * price / base_precision` to convert from raw base
    /// units to QUOTE_PRECISION-scaled quote. For perps this is `1e9`
    /// (BASE_PRECISION). Step makers (DLOB orders) and the matcher's
    /// credit/marginal accumulation steps use this to keep precision
    /// consistent. AMM-style makers using try_fill_solo bypass this since
    /// they compute quote via the AMM's own swap math, which is already
    /// precision-correct.
    pub base_precision: u64,
    /// PerpMarket status — threaded to the AMM's projection so the curve
    /// update can relax its k-down precondition when the market is
    /// `ReduceOnly` (matching legacy behaviour). AMM-only.
    pub market_status: crate::state::market_status::MarketStatus,
    /// Raw `PerpMarket::market_config` byte — the AMM tests
    /// `MarketConfigFlag::DisableFormulaicKUpdate` against it during k
    /// adjustment. AMM-only.
    pub market_config: u8,
}

/// The result of a single maker's portion of a match. Constructed either by
/// the matcher (during segment-walk + pro-rata) or returned directly by a
/// maker's [`Quoter::try_fill_solo`].
///
/// The fields are protocol-level — meaningful to the fill controller without
/// any maker-specific interpretation. The maker is the sole interpreter of
/// any maker-specific state changes implied by the fill; those happen inside
/// [`QuoterCommit::commit_fill`].
#[derive(Debug, Clone, Copy)]
pub struct QuoterFill {
    /// Which side of the book this fill is on (from the taker's perspective).
    pub side: PositionDirection,
    /// Base asset amount this maker filled.
    pub base_filled: u64,
    /// Quote asset amount this maker filled.
    pub quote_filled: u64,
    /// The clearing price for this maker's portion (the marginal tick the
    /// matcher decided on, or the analytical inverse for sole-maker fills).
    pub clearing_price: u64,
    /// Any cost the maker incurred to produce this fill — for the AMM, this
    /// is the cost of a conditional repeg / k-update that fired as part of
    /// the quote. Summed across the match by the fill controller and
    /// deducted from the appropriate place. Zero for makers without such
    /// costs (DLOB orders, JIT participants).
    pub refresh_cost: u64,
    /// Maker's fee-exempt flag at fill time, copied from `Quoter::is_fee_exempt`.
    /// The fill controller reads this to decide whether to apply the
    /// protocol's maker-fee schedule. AMM = true; DLOB/JIT = false.
    pub is_fee_exempt: bool,
    /// Per-fill fee schedule selector, copied from `Quoter::fee_policy()`.
    /// The unified fulfill orchestrator switches on this to apply the right
    /// fee-calculation path (`calculate_fee_for_fulfillment_with_amm` for
    /// AMM-side fills; `calculate_fee_for_fulfillment_with_match` for
    /// DLOB-side fills) without inspecting the quoter's concrete type.
    pub fee_policy: FillFeePolicy,
    /// Maker-specific quote surplus (or deficit, if negative). For the AMM,
    /// this is the gap between the spread-adjusted swap result and the
    /// no-spread swap result — the bid/ask spread profit the AMM captured
    /// (or lost) on this fill. Zero for makers without such a concept
    /// (DLOB orders quote a single price; there is no spread to capture).
    pub quote_asset_amount_surplus: i64,
}

impl QuoterFill {
    pub const ZERO: QuoterFill = QuoterFill {
        side: PositionDirection::Long,
        base_filled: 0,
        quote_filled: 0,
        clearing_price: 0,
        refresh_cost: 0,
        is_fee_exempt: false,
        fee_policy: FillFeePolicy::DlobMatch,
        quote_asset_amount_surplus: 0,
    };
}

/// Per-fill fee schedule. Returned by `Quoter::fee_policy()` and copied into
/// each `QuoterFill` so the unified fulfill orchestrator can switch on it
/// without knowing the concrete quoter type.
///
/// - `AmmHouse` — the AMM is the counterparty. Taker pays the AMM-house fee
///   schedule (`calculate_fee_for_fulfillment_with_amm`); no maker rebate.
///   The AMM's `total_fee` / `total_fee_minus_distributions` /
///   `net_revenue_since_last_funding` get credited via
///   `AmmContract::apply_fill_fees`.
/// - `DlobMatch` — a DLOB resting order is the counterparty. Taker pays the
///   match fee schedule (`calculate_fee_for_fulfillment_with_match`); the
///   maker receives a rebate. AMM-side counters are NOT touched (the AMM
///   was not party to this fill).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FillFeePolicy {
    AmmHouse,
    DlobMatch,
}

/// A liquidity source on the shared orderbook.
///
/// # Fill algorithm (the contract this trait must satisfy)
///
/// The fill engine (`controller/match.rs`) has two explicit paths:
///
/// - **Sole continuous vAMM** (`fill_amm_only`): ask the AMM for its
///   closed-form `try_fill_solo`, capped at the taker limit by the AMM's
///   `cumulative_size` (an inherent `AmmQuoter` method, not on this trait).
/// - **Discrete makers** (`match_take`): each maker is a single price level —
///   its `best_price` and its full fillable size (unbounded `try_fill_solo`).
///   Sort levels best-first, fill fully-crossed levels, and at the level that
///   crosses demand distribute the residual priority-first (`is_prio`) then
///   pro-rata by capacity. No price search.
///
/// Quote methods must be pure functions of `(self, ctx)` so the engine gets
/// consistent answers across the (few) calls in a single fill. Settlement
/// happens after the fill resolves, via `commit_fill`.
pub trait Quoter {
    /// Setup phase — called once per matching session before any quote
    /// query. Implementations that derive transient state from `ctx` (e.g.
    /// the AMM materialising a post-refresh projection + spread snapshot)
    /// compute it here and store it on `self`. Quote methods (`best_price`,
    /// `try_fill_solo`) then read that prepared state.
    ///
    /// Setup writes only to the quoter's own session-scoped fields. It
    /// does NOT mutate any backing account state — peg/reserves on the
    /// AMM only change inside `QuoterCommit::commit_fill`.
    ///
    /// Default is no-op: makers that quote from their constant-at-
    /// construction inputs (DLOB orders, JIT participants) don't need
    /// setup.
    fn setup(&mut self, _ctx: &QuoteContext) -> VelocityResult<()> {
        Ok(())
    }

    /// First nonzero offer on this side — the maker's single quoted price for
    /// the discrete level walk. Pure function of `(self, ctx)`. Returns the
    /// no-quote sentinel (`u64::MAX` for Long, `0` for Short) when the maker
    /// doesn't quote this side.
    fn best_price(&self, ctx: &QuoteContext, side: PositionDirection) -> VelocityResult<u64>;

    /// Full fillable base at this maker's level (`best_price`). The discrete
    /// walk in `controller::matching::match_take` reads this to size the
    /// level, so it must be *cheap and non-mutating* — compute it analytically
    /// (DLOB: remaining size; JIT vAMM: `min(throttle, reserve-bounded max)`),
    /// NOT by running the actual fill. `0` means "no liquidity on this side".
    /// Pure function of `(self, ctx)`.
    fn level_capacity(&self, ctx: &QuoteContext, side: PositionDirection) -> VelocityResult<u64>;

    /// Priority flag. At the clearing marginal tick, priority makers take
    /// their full marginal size *before* pro-rata distributes the remainder
    /// to non-priority makers. Doesn't override price priority — a better
    /// `best_price` still wins regardless of `is_prio`. The vAMM is prio;
    /// DLOB and JIT participants default to non-prio.
    fn is_prio(&self) -> bool {
        false
    }

    /// Whether this maker is exempt from the protocol's maker fee schedule.
    /// The vAMM returns `true` — it makes its revenue from the spread it
    /// quotes, not from a maker rebate. DLOB orders and JIT participants
    /// default to `false` and pay/receive maker fees per the protocol
    /// schedule. The fill controller checks this when applying fees from a
    /// match.
    fn is_fee_exempt(&self) -> bool {
        false
    }

    /// Which fee schedule the unified fulfill orchestrator uses when a fill
    /// lands against this quoter. The default is `DlobMatch` (DLOB resting
    /// orders pay/receive the match fee schedule); the AMM quoters override
    /// to `AmmHouse`.
    fn fee_policy(&self) -> FillFeePolicy {
        FillFeePolicy::DlobMatch
    }

    /// Closed-form fill of `target_size` base at this maker's price.
    ///
    /// Used two ways:
    /// 1. The sole-AMM path (`fill_amm_only`) calls it to fill the whole take.
    /// 2. The discrete walk (`match_take`) calls it with `u64::MAX` to read a
    ///    maker's full level capacity, and again with the maker's allocated
    ///    base to produce the committed fill.
    ///
    /// Every `Quoter` in this crate implements it (the AMM via swap math;
    /// discrete makers as `min(target, remaining)` at their price). Returning
    /// `None` means "no fill on this side / zero capacity".
    fn try_fill_solo(
        &self,
        _ctx: &QuoteContext,
        _side: PositionDirection,
        _target_size: u64,
    ) -> VelocityResult<Option<QuoterFill>> {
        Ok(None)
    }
}

// `CurveSnapshot`, `MarketEventEffects`, and `SnapOutcome` were deleted.
// `on_market_event` returns `()`; AMM-side Anchor records
// (`AmmCurveChanged`) are emitted by the AMM directly. `snap_to_oracle`
// returns just the cost (`i128`).

/// A market-level signal a maker may want to react to.
///
/// The variants carry every input a maker needs to handle the event in
/// isolation — the maker should never need to reach back into PerpMarket
/// state from within its handler. PerpMarket-level fields the AMM's k-update
/// formerly read (the protocol fee floor) are pre-computed by the
/// orchestrator and threaded through the event.
#[derive(Debug, Clone, Copy)]
pub enum MarketEvent<'a> {
    /// Funding has just been applied to the market — cumulative rates have
    /// been bumped on `PerpMarket`. Carries everything a position-holding
    /// participant needs to settle its own funding payment from cum-rate
    /// deltas (`(market_cum_rate − own_last_cum_rate) × position`) and,
    /// for the AMM, to run its eager k-update.
    FundingUpdated {
        /// PerpMarket index — threaded through so the AMM can emit
        /// `AmmCurveChanged` (which carries market_index) from inside the
        /// handler.
        market_index: u16,
        /// Post-update cumulative funding rates from `PerpMarket`. The AMM
        /// settles against `(new − own_last) × counterparty_position` —
        /// same math shape user positions use via `settle_funding_payment`.
        cumulative_funding_rate_long: i128,
        cumulative_funding_rate_short: i128,
        /// User-position aggregates so the AMM can decompose its
        /// counterparty exposure (long-side vs short-side). Lets the AMM
        /// match master's asymmetric-cap behaviour without reaching back
        /// into PerpMarket. Snapshot copied at dispatch time.
        base_asset_amount_long: i128,
        base_asset_amount_short: i128,
        /// This period's funding_rate scalar — used by the k-update
        /// affordability / direction logic. Cum-rate deltas alone don't
        /// recover it (capping splits long vs short asymmetrically).
        funding_rate: i128,
        oracle_price_data: &'a OraclePriceData,
        now: i64,
        /// Protocol's lower-bound on AMM `total_fee_minus_distributions`
        /// (computed from PerpMarket-level fees). Threaded so the AMM's
        /// k-update can gate its cost debit without reading PerpMarket.
        total_fee_floor: i128,
        /// AMM bid/ask spread snapshot at the moment funding was computed.
        /// The k-update branch compares these against the AMM's base spread.
        long_spread: u32,
        short_spread: u32,
        /// Formulaic k-update enabled (curve_update_intensity + the
        /// `DisableFormulaicKUpdate` config flag). If false, AMM still
        /// settles funding + resets the rolling window but skips k-update.
        k_update_eligible: bool,
        /// `market.status` — threaded so `get_update_k_result` can relax
        /// its k-down precondition when the market is `ReduceOnly`.
        market_status: crate::state::market_status::MarketStatus,
        /// `market_stats.min_order_size` — used by the AMM's `can_lower_k`
        /// check during k-update.
        min_order_size: u64,
    },
}

// `AmmContract` trait moved to `crate::vlp::amm::quoter` so the AMM-side contract
// definition co-locates with the only impl (`impl AmmContract for AMM`).
// Callers import it from there directly.

/// Settle a fill onto a maker's internal state, or react to a market event.
///
/// Split from `Quoter` so quote queries can take `&self` (required for the
/// matcher's many bisection calls) while commits take `&mut self`.
///
/// The maker is the sole authority on how its bytes change. Only constraint
/// is that the `QuoterFill` amounts must be honored — the protocol-level
/// accounting (position counters, fees on PerpMarket) depends on those
/// amounts being accurate. The maker may also consume protocol budget
/// (e.g. AMM applying a repeg) and report the cost via `QuoterFill::refresh_cost`.
///
/// [`on_market_event`] is the second mutation channel: market-level signals
/// (funding application today; oracle ticks, external fills tomorrow) that a
/// maker may want to react to. The default implementation ignores the event.
/// The AMM uses it to fold its formulaic k-update inside the maker boundary,
/// replacing the old "controller/funding reaches into market.amm" pattern.
pub trait QuoterCommit: Quoter {
    fn commit_fill(&mut self, ctx: &QuoteContext, fill: &QuoterFill) -> VelocityResult<()>;

    fn on_market_event(&mut self, _ctx: &QuoteContext, _event: &MarketEvent) -> VelocityResult<()> {
        Ok(())
    }
}

// ============================================================================
// DLOB resting-order Quoter impl
// ============================================================================

use crate::state::user::Order;

/// A `Quoter` view over a single resting DLOB order.
///
/// The order's direction (Long = bid, Short = ask) determines which side of
/// the book it offers liquidity on; a maker offers liquidity to the *opposite*
/// taker side. `best_price` returns the order's effective limit price (from
/// `Order::get_limit_price`, accounting for oracle-offset orders). The order
/// presents as a single discrete level: its `best_price` and its remaining
/// size (the `try_fill_solo` capacity).
///
/// DLOB makers do not implement `is_prio` or `is_fee_exempt` (defaults of
/// `false`). The matcher sorts them with the vAMM by price; at tied prices
/// the vAMM (prio) wins, otherwise non-prio makers pro-rata.
///
/// `try_fill_solo` is implemented because a single resting order has a
/// trivial closed-form fill: take `min(target, remaining)` at the limit
/// price.
pub struct DlobOrderQuoter<'a> {
    pub order: &'a mut Order,
}

impl<'a> DlobOrderQuoter<'a> {
    pub fn new(order: &'a mut Order) -> Self {
        DlobOrderQuoter { order }
    }

    /// Sentinel "doesn't quote on this side" price.
    fn no_quote(side: PositionDirection) -> u64 {
        match side {
            PositionDirection::Long => u64::MAX,
            PositionDirection::Short => 0,
        }
    }

    /// Whether this order is on the maker side opposite the given taker side.
    fn quotes_on(&self, taker_side: PositionDirection) -> bool {
        self.order.direction != taker_side
    }

    /// Effective limit price for this order at the current matcher context.
    /// Returns `None` if the order has no usable price (e.g. an unanchored
    /// market order with no fallback).
    fn effective_price(&self, ctx: &QuoteContext) -> VelocityResult<Option<u64>> {
        // Slot 0 + valid_oracle_price = ctx.oracle.price; this drives
        // get_limit_price's auction / oracle-offset handling.
        self.order
            .get_limit_price(Some(ctx.oracle.price), None, ctx.slot, ctx.tick.max(1))
    }

    fn remaining(&self) -> u64 {
        self.order
            .base_asset_amount
            .saturating_sub(self.order.base_asset_amount_filled)
    }
}

impl<'a> Quoter for DlobOrderQuoter<'a> {
    fn best_price(&self, ctx: &QuoteContext, side: PositionDirection) -> VelocityResult<u64> {
        if !self.quotes_on(side) {
            return Ok(Self::no_quote(side));
        }
        Ok(self.effective_price(ctx)?.unwrap_or(Self::no_quote(side)))
    }

    fn level_capacity(&self, ctx: &QuoteContext, side: PositionDirection) -> VelocityResult<u64> {
        if !self.quotes_on(side) || self.effective_price(ctx)?.is_none() {
            return Ok(0);
        }
        Ok(self.remaining())
    }

    fn try_fill_solo(
        &self,
        ctx: &QuoteContext,
        side: PositionDirection,
        target_size: u64,
    ) -> VelocityResult<Option<QuoterFill>> {
        if !self.quotes_on(side) {
            return Ok(None);
        }
        let limit_price = match self.effective_price(ctx)? {
            Some(p) => p,
            None => return Ok(None),
        };
        let base = target_size.min(self.remaining());
        // Precision-correct quote = base * price / base_precision, rounded in
        // the maker's favor (ceiling for Short maker, floor for Long maker).
        // Matches `calculate_quote_asset_amount_for_maker_order`, which the
        // legacy match path used. Plain floor division understates the price
        // on the Short side and fails `validate_fill_price` against the
        // maker's limit.
        let bp = ctx.base_precision.max(1);
        let base_u128 = base as u128;
        let price_u128 = limit_price as u128;
        let bp_u128 = bp as u128;
        let quote_u128 = match self.order.direction {
            PositionDirection::Long => base_u128.safe_mul(price_u128)?.safe_div(bp_u128)?,
            PositionDirection::Short => base_u128.safe_mul(price_u128)?.safe_div_ceil(bp_u128)?,
        };
        if quote_u128 > u64::MAX as u128 {
            return Err(ErrorCode::MathError);
        }
        let quote = quote_u128 as u64;
        Ok(Some(QuoterFill {
            side,
            base_filled: base,
            quote_filled: quote,
            clearing_price: limit_price,
            refresh_cost: 0,
            is_fee_exempt: self.is_fee_exempt(),
            fee_policy: self.fee_policy(),
            // DLOB orders quote a single price; no spread surplus.
            quote_asset_amount_surplus: 0,
        }))
    }
}

impl<'a> QuoterCommit for DlobOrderQuoter<'a> {
    fn commit_fill(&mut self, _ctx: &QuoteContext, fill: &QuoterFill) -> VelocityResult<()> {
        // Update only the order's bytes. Per-user position / fee accounting
        // is the fill controller's responsibility, applied after the match
        // resolves using the public `QuoterFill` fields.
        self.order.base_asset_amount_filled = self
            .order
            .base_asset_amount_filled
            .safe_add(fill.base_filled)?;
        self.order.quote_asset_amount_filled = self
            .order
            .quote_asset_amount_filled
            .safe_add(fill.quote_filled)?;
        Ok(())
    }
}

// ============================================================================
// AMM Quoter impl (v1)
// ============================================================================
//
// `AmmQuoter` exposes the existing `AMM` struct through the `Quoter` trait so
// the matcher can drive it. `is_prio = true`, `is_fee_exempt = true` per
// design — the AMM front-runs DLOB at tied prices and doesn't pay maker fees.
//
// **Design choice: repeg / k-update happens via `_update_amm`, not inside
// `try_fill_solo`.** The AmmQuoter quote reflects the AMM's CURRENT reserves
// + peg. Production callers (controller/repeg.rs::_update_amm, called from
// every fill path that reaches the matcher) apply repeg / k-update BEFORE
// matching runs, so by the time AmmQuoter is queried, the AMM is already at
// its "fresh" state.
//
// Folding the conditional triggers INTO `try_fill_solo` was considered and
// rejected for v1 because it would require:
//   1. Threading `State + MMOraclePriceData + slot` into QuoteContext (the
//      matcher would need access to oracle guard rails, hot/cold authority
//      flags, etc. that don't belong in a maker abstraction).
//   2. A shadow-mutate-then-rollback pattern in try_fill_solo (simulate the
//      repeg, quote against the simulated state) plus a re-commit in
//      commit_fill — the two must reach identical conclusions for the
//      matcher's bisection convergence to hold.
//   3. Threading `refresh_cost` back through `apply_clearing` (currently
//      surfaced only by the sole-maker fast path).
//
// The current pattern works correctly because every production matcher
// invocation runs through a code path that has already called `_update_amm`.
// If a future caller needs the matcher to fire without that precondition,
// re-open this design choice.
#[cfg(test)]
mod dlob_order_maker_tests {
    use super::*;
    use crate::state::user::MarketType;
    use crate::state::user::{Order, OrderStatus, OrderType};

    fn make_ctx<'a>(stats: &'a MarketStats, oracle: &'a OraclePriceData) -> QuoteContext<'a> {
        QuoteContext {
            stats,
            oracle,
            mm_oracle: None,
            oracle_validity: None,
            fee_budget: 0,
            tick: 1,
            step_size: 1,
            slot: 100,
            base_precision: crate::math::constants::BASE_PRECISION as u64,
            market_status: crate::state::market_status::MarketStatus::default(),
            market_config: 0,
        }
    }

    fn make_ask_order(price: u64, size: u64) -> Order {
        Order {
            slot: 0,
            price,
            base_asset_amount: size,
            base_asset_amount_filled: 0,
            quote_asset_amount_filled: 0,
            trigger_price: 0,
            auction_start_price: 0,
            auction_end_price: 0,
            max_ts: 0,
            oracle_price_offset: 0,
            order_id: 0,
            market_index: 0,
            status: OrderStatus::Open,
            order_type: OrderType::Limit,
            market_type: MarketType::Perp,
            user_order_id: 0,
            existing_position_direction: PositionDirection::Long,
            direction: PositionDirection::Short, // ask = sell
            reduce_only: false,
            post_only: true,
            immediate_or_cancel: false,
            trigger_condition: crate::state::user::OrderTriggerCondition::Above,
            auction_duration: 0,
            posted_slot_tail: 0,
            bit_flags: 0,
            padding: [0; 5],
        }
    }

    fn make_bid_order(price: u64, size: u64) -> Order {
        let mut o = make_ask_order(price, size);
        o.direction = PositionDirection::Long;
        o
    }

    #[test]
    fn ask_order_quotes_to_buying_taker() {
        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle);

        let mut order = make_ask_order(100, 50);
        let maker = DlobOrderQuoter::new(&mut order);

        // Buying taker should see the ask price.
        let bp = maker.best_price(&ctx, PositionDirection::Long).unwrap();
        assert_eq!(bp, 100);

        // Selling taker should see no quote.
        let bp_no = maker.best_price(&ctx, PositionDirection::Short).unwrap();
        assert_eq!(bp_no, 0);
    }

    #[test]
    fn bid_order_quotes_to_selling_taker() {
        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle);

        let mut order = make_bid_order(95, 30);
        let maker = DlobOrderQuoter::new(&mut order);

        let bp = maker.best_price(&ctx, PositionDirection::Short).unwrap();
        assert_eq!(bp, 95);

        let bp_no = maker.best_price(&ctx, PositionDirection::Long).unwrap();
        assert_eq!(bp_no, u64::MAX);
    }

    #[test]
    fn discrete_level_is_price_and_remaining() {
        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle);

        let mut order = make_ask_order(100, 50);
        let maker = DlobOrderQuoter::new(&mut order);

        // The order presents as a single discrete level: price = the ask, and
        // level_capacity = full remaining size.
        assert_eq!(
            maker.best_price(&ctx, PositionDirection::Long).unwrap(),
            100
        );
        assert_eq!(
            maker.level_capacity(&ctx, PositionDirection::Long).unwrap(),
            50
        );
        // Doesn't quote the bid side.
        assert_eq!(maker.best_price(&ctx, PositionDirection::Short).unwrap(), 0);
        assert_eq!(
            maker
                .level_capacity(&ctx, PositionDirection::Short)
                .unwrap(),
            0
        );
    }

    #[test]
    fn commit_fill_increments_filled_counters() {
        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle);

        let mut order = make_ask_order(100, 50);
        {
            let mut maker = DlobOrderQuoter::new(&mut order);
            let fill = QuoterFill {
                side: PositionDirection::Long,
                base_filled: 20,
                quote_filled: 2000,
                clearing_price: 100,
                refresh_cost: 0,
                is_fee_exempt: false,
                fee_policy: FillFeePolicy::DlobMatch,
                quote_asset_amount_surplus: 0,
            };
            maker.commit_fill(&ctx, &fill).unwrap();
        }
        assert_eq!(order.base_asset_amount_filled, 20);
        assert_eq!(order.quote_asset_amount_filled, 2000);

        // try_fill_solo after partial fill reflects reduced remaining.
        let maker = DlobOrderQuoter::new(&mut order);
        let fill = maker
            .try_fill_solo(&ctx, PositionDirection::Long, 100)
            .unwrap()
            .unwrap();
        assert_eq!(fill.base_filled, 30); // 50 - 20 = 30 remaining
        assert_eq!(fill.clearing_price, 100);
    }
}
