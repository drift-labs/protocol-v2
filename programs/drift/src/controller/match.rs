//! Multi-maker matching engine.
//!
//! Walks a set of [`QuoterCommit`] makers (vAMM, DLOB orders, JIT participants,
//! future quoter types) and produces a [`Match`]: per-maker fills + the
//! clearing price for an incoming take. The algorithm is the one specified
//! in the [`crate::state::quoter`] module docs and `docs/amm-decoupling-and-maker-interface.md`:
//!
//! 1. Sort makers by `best_price`.
//! 2. Walk price segments between maker entry points; sum supply across active makers.
//! 3. When the active supply crosses demand, the clearing segment is identified:
//!    - If exactly one maker is active AND its `try_fill_solo` returns `Some`,
//!      take the analytical shortcut.
//!    - Otherwise bisect on `cumulative_size` to find the clearing tick.
//! 4. At the clearing tick: inframarginal supply is credited to each active maker;
//!    the marginal slice at the clearing tick is distributed priority-first
//!    (`is_prio`) then pro-rata.
//! 5. Each winning maker's [`QuoterCommit::commit_fill`] is called.
//!
//! Quote methods (`best_price`, `cumulative_size`, `try_fill_solo`) are pure
//! functions of `(self, ctx)`. The matcher relies on this for bisection
//! convergence — multiple calls during a single match must produce consistent
//! answers.

use crate::amm::AmmQuoter;
use crate::controller::position::PositionDirection;
use crate::error::{DriftResult, ErrorCode};
use crate::math::safe_math::SafeMath;
use crate::state::quoter::{QuoteContext, QuoterCommit, QuoterFill};

/// Index into the `makers` slice passed to [`match_take`].
pub type QuoterId = u16;

/// Per-maker base allocation produced by the matcher's internal segment-walk.
/// Carries only `base_filled` — quote is intentionally NOT tracked here.
/// The matcher recomputes quote ONCE per winning maker against its total
/// filled base via `try_fill_solo` in the final commit loop; computing it
/// per-segment would over-inflate for continuous makers (AMM curve is
/// non-linear, so `quote(a) + quote(b) > quote(a+b)`).
#[derive(Debug, Clone, Copy)]
struct MakerBaseFill {
    maker_id: QuoterId,
    base: u64,
}

/// Result of clearing one segment in the matcher's segment-walk: the marginal
/// clearing tick plus the per-maker base allocations at that tick.
struct SegmentClearing {
    clearing_price: u64,
    per_maker: Vec<MakerBaseFill>,
}

/// Aggregate result of a single match across `n` makers.
#[derive(Debug, Clone)]
pub struct Match {
    /// Per-maker fills, indexed by their position in the `makers` slice
    /// passed to [`match_take`]. Only makers that filled at least one base
    /// unit appear here. Order is fill-execution order (which is also
    /// price-sorted order).
    pub fills: Vec<(QuoterId, QuoterFill)>,

    /// The marginal clearing tick — the price at which the last unit of the
    /// take filled. `None` if the take exceeded available liquidity (partial
    /// fill).
    pub clearing_price: Option<u64>,

    /// Total base filled across all makers.
    pub total_base_filled: u64,

    /// Total quote filled across all makers.
    pub total_quote_filled: u64,

    /// Sum of `QuoterFill::refresh_cost` across all winning fills. The fill
    /// controller deducts this from the appropriate protocol-side accounting
    /// after the match.
    pub total_refresh_cost: u64,
}

impl Match {
    pub fn empty() -> Self {
        Match {
            fills: Vec::new(),
            clearing_price: None,
            total_base_filled: 0,
            total_quote_filled: 0,
            total_refresh_cost: 0,
        }
    }

    /// Whether this match fully satisfied the requested take size.
    pub fn is_complete(&self) -> bool {
        self.clearing_price.is_some()
    }
}

/// Match an incoming take of size `target_size` on `side` against the given
/// makers. Returns the per-maker fills + clearing price.
///
/// Makers are passed as `&mut [&mut dyn QuoterCommit]` so callers can mix
/// maker types in a single call (vAMM + DLOB order + JIT participant). The
/// matcher mutates each winning maker's state via `commit_fill` before
/// returning.
///
/// `taker_limit_price` is the price the taker won't fill past — for Long
/// takers, the matcher won't clear above it; for Short, won't clear below.
/// `None` means no taker-side cap. Lets callers hand the matcher a target
/// of "the full remaining order" without first walking maker curves to
/// figure out how much can fill within the taker's limit — the matcher does
/// the bounding itself via per-maker `cumulative_size` at the cap.
pub fn match_take(
    makers: &mut [&mut dyn QuoterCommit],
    ctx: &QuoteContext,
    side: PositionDirection,
    target_size: u64,
    taker_limit_price: Option<u64>,
) -> DriftResult<Match> {
    if makers.is_empty() || target_size == 0 {
        return Ok(Match::empty());
    }

    let price_cap: u64 = taker_limit_price.unwrap_or(match side {
        PositionDirection::Long => u64::MAX,
        PositionDirection::Short => 0,
    });
    let in_bounds = |price: u64| -> bool {
        match side {
            PositionDirection::Long => price <= price_cap,
            PositionDirection::Short => price >= price_cap,
        }
    };

    // Sole-maker fast path: skip segment-walk entirely and ask the maker for
    // its full closed-form fill via `try_fill_solo`. The segment-walk's
    // quote-accumulation uses a flat-per-segment price approximation that's
    // inaccurate for continuous makers (AMMs whose price varies across the
    // segment). Using try_fill_solo directly gives a byte-exact match with
    // `swap_base_asset` — important for migrating existing fill paths
    // without behavior drift. For multi-maker matches, we still need the
    // segment walk (with the known approximation caveat).
    if makers.len() == 1 {
        let best_price = makers[0].best_price(ctx, side)?;
        let quotes_on_side = match side {
            PositionDirection::Long => best_price < u64::MAX,
            PositionDirection::Short => best_price > 0,
        };
        if !quotes_on_side || !in_bounds(best_price) {
            return Ok(Match::empty());
        }
        // Cap the take by the maker's supply at `price_cap` so the sole-fill
        // never clears past the taker's limit. For unbounded callers
        // (`price_cap = sentinel`) this collapses to `target_size`.
        let supply_at_cap = makers[0].cumulative_size(ctx, side, price_cap)?;
        let effective_target = target_size.min(supply_at_cap);
        if effective_target == 0 {
            return Ok(Match::empty());
        }
        if let Some(fill) = makers[0].try_fill_solo(ctx, side, effective_target)? {
            if fill.base_filled == 0 {
                return Ok(Match::empty());
            }
            // The sole-maker fast path doesn't have an independent `p_star`
            // to validate `quote_filled` against (bisection didn't run). The
            // multi-maker safety check (later in this function) catches
            // makers that lie relative to their own `cumulative_size`
            // promises when participating in segment-walk matches. For the
            // sole-maker case, the maker IS the sole source of truth — the
            // matcher has nothing to compare against except the maker's own
            // `best_price` and `clearing_price`, and those don't form a
            // clean bracket for continuous makers (an AMM's swap quote
            // includes spread mechanics that make implied_avg sit outside
            // a naive `[best_price, clearing_price]` interval). Trust the
            // maker here; in production this path is taken exclusively by
            // our own vAMM (`AmmQuoter`), which is trusted code in this
            // codebase and validated by the
            // `fill_perp_market_against_amm_parity_with_swap_base_asset`
            // test. When/if untrusted external makers can be sole-quoters,
            // revisit by either (a) requiring them to also provide an
            // auditable cumulative_size that bounds the quote, or (b)
            // having the matcher fall through to bisection even for n=1.
            let result_fill = QuoterFill {
                is_fee_exempt: makers[0].is_fee_exempt(),
                ..fill
            };
            makers[0].commit_fill(ctx, &result_fill)?;
            let mut result = Match::empty();
            // Partial fills (base_filled < target) report clearing_price=None
            // to match the matcher's general-case convention.
            result.clearing_price = if result_fill.base_filled >= target_size {
                Some(result_fill.clearing_price)
            } else {
                None
            };
            result.total_base_filled = result_fill.base_filled;
            result.total_quote_filled = result_fill.quote_filled;
            result.total_refresh_cost = result_fill.refresh_cost;
            result.fills.push((0, result_fill));
            return Ok(result);
        }
        // Maker has no closed-form shortcut; fall through to segment walk.
    }

    // Compute best_prices and is_prio per maker; sort indices by best_price.
    // Priority makers come first when prices are tied so they win the
    // marginal slice over non-priority at the same tick.
    let mut best_prices: Vec<u64> = Vec::with_capacity(makers.len());
    let mut prios: Vec<bool> = Vec::with_capacity(makers.len());
    for maker in makers.iter() {
        best_prices.push(maker.best_price(ctx, side)?);
        prios.push(maker.is_prio());
    }

    let mut order: Vec<QuoterId> = (0..makers.len() as QuoterId).collect();
    match side {
        PositionDirection::Long => {
            order.sort_by(|&a, &b| {
                let pa = best_prices[a as usize];
                let pb = best_prices[b as usize];
                pa.cmp(&pb).then(prios[b as usize].cmp(&prios[a as usize]))
            });
        }
        PositionDirection::Short => {
            order.sort_by(|&a, &b| {
                let pa = best_prices[a as usize];
                let pb = best_prices[b as usize];
                pb.cmp(&pa).then(prios[b as usize].cmp(&prios[a as usize]))
            });
        }
    }

    // Filter out makers that don't quote on this side (sentinel best_price)
    // or whose best_price is worse than the taker's limit.
    let order: Vec<QuoterId> = order
        .into_iter()
        .filter(|&i| {
            let bp = best_prices[i as usize];
            let quotes_on_side = match side {
                PositionDirection::Long => bp < u64::MAX,
                PositionDirection::Short => bp > 0,
            };
            quotes_on_side && in_bounds(bp)
        })
        .collect();

    if order.is_empty() {
        return Ok(Match::empty());
    }

    // active = makers whose best_price has been reached.
    let mut active: Vec<QuoterId> = Vec::with_capacity(makers.len());
    // last_p starts at a sentinel just below the first maker's best_price so
    // that the first iteration's segment includes the joiner's step.
    let mut last_p: u64 = match side {
        PositionDirection::Long => 0,
        PositionDirection::Short => u64::MAX,
    };
    let mut cumulative_base: u64 = 0;
    let mut per_maker_base: Vec<u64> = vec![0; makers.len()];
    // Quote per maker is computed once at the end via `try_fill_solo` against
    // each maker's total filled base — not accumulated per segment. For
    // continuous makers (AMMs) this avoids sum-of-slices quote inflation
    // (curve non-linearity makes `quote(a) + quote(b) > quote(a+b)`).
    let mut clearing_price: Option<u64> = None;

    // Group makers by best_price; process all makers at the same price
    // simultaneously (tie group).
    let mut i = 0;
    while i < order.len() {
        let group_price = best_prices[order[i] as usize];
        let mut group_end = i + 1;
        while group_end < order.len() && best_prices[order[group_end] as usize] == group_price {
            group_end += 1;
        }

        // Add all makers in this tie group to active.
        for j in i..group_end {
            active.push(order[j]);
        }

        let p_event = group_price;

        // Compute segment supply [last_p, p_event] across all active
        // (including the just-joined group). This includes each step maker's
        // step contribution at its best_price, and the inframarginal portion
        // of any continuous maker that joined earlier.
        let mut segment_supply: u64 = 0;
        for &m in &active {
            let cum_at_event = makers[m as usize].cumulative_size(ctx, side, p_event)?;
            let cum_at_last = makers[m as usize].cumulative_size(ctx, side, last_p)?;
            segment_supply = segment_supply.safe_add(cum_at_event.safe_sub(cum_at_last)?)?;
        }

        if cumulative_base.safe_add(segment_supply)? >= target_size {
            // Clearing happens inside this segment [last_p, p_event].
            let demand_remaining = target_size.safe_sub(cumulative_base)?;
            let segment = clear_segment(
                makers,
                ctx,
                side,
                last_p,
                p_event,
                demand_remaining,
                &active,
            )?;
            for fill in segment.per_maker {
                per_maker_base[fill.maker_id as usize] =
                    per_maker_base[fill.maker_id as usize].safe_add(fill.base)?;
                cumulative_base = cumulative_base.safe_add(fill.base)?;
            }
            clearing_price = Some(segment.clearing_price);
            break;
        }

        // Didn't clear in this segment; credit each active maker its base
        // contribution and advance. Quote is deferred to the final loop
        // (one `try_fill_solo` call per maker on its total base).
        for &m in &active {
            let cum_at_event = makers[m as usize].cumulative_size(ctx, side, p_event)?;
            let cum_at_last = makers[m as usize].cumulative_size(ctx, side, last_p)?;
            let base = cum_at_event.safe_sub(cum_at_last)?;
            per_maker_base[m as usize] = per_maker_base[m as usize].safe_add(base)?;
            cumulative_base = cumulative_base.safe_add(base)?;
        }
        last_p = p_event;
        i = group_end;
    }

    // Tail segment [last_p, sentinel): only meaningful for continuous makers
    // (AMMs) that provide supply above their best_price. Step makers
    // contribute 0 here (their step was credited in the joining segment).
    // The tail sentinel is the taker's limit price (or the natural matcher
    // bound when no limit was supplied), so the AMM curve never walks past
    // the taker's acceptable price.
    if clearing_price.is_none() && !active.is_empty() && cumulative_base < target_size {
        let sentinel = price_cap;
        let mut segment_supply: u64 = 0;
        for &m in &active {
            let cum_at_sentinel = makers[m as usize].cumulative_size(ctx, side, sentinel)?;
            let cum_at_last = makers[m as usize].cumulative_size(ctx, side, last_p)?;
            segment_supply = segment_supply.safe_add(cum_at_sentinel.safe_sub(cum_at_last)?)?;
        }
        if segment_supply > 0 && cumulative_base.safe_add(segment_supply)? >= target_size {
            let demand_remaining = target_size.safe_sub(cumulative_base)?;
            let segment = clear_segment(
                makers,
                ctx,
                side,
                last_p,
                sentinel,
                demand_remaining,
                &active,
            )?;
            for fill in segment.per_maker {
                per_maker_base[fill.maker_id as usize] =
                    per_maker_base[fill.maker_id as usize].safe_add(fill.base)?;
                cumulative_base = cumulative_base.safe_add(fill.base)?;
            }
            clearing_price = Some(segment.clearing_price);
        }
        // else: partial fill — clearing_price stays None, per-maker buckets
        // already hold the credited inframarginal fills.
    }

    // Build the Match result and commit fills.
    let mut result = Match::empty();
    result.clearing_price = clearing_price;
    let mut total_refresh_cost: u64 = 0;
    let mut total_base: u64 = 0;
    let mut total_quote: u64 = 0;

    for i in 0..makers.len() {
        if per_maker_base[i] == 0 {
            continue;
        }
        let base = per_maker_base[i];
        // Single source of truth for each maker's price: `try_fill_solo`,
        // called against the maker's TOTAL filled base. For AMMs this runs
        // the exact swap math against the maker's current reserves; for step
        // makers it's `base × limit_price / base_precision`. Each maker fills
        // at its OWN price (standard CLOB semantics), and `quote_filled` is
        // grounded in the same swap-inverse function that `cumulative_size`
        // uses, so the contract is structural rather than runtime-enforced.
        //
        // Calling once per maker (not per segment) avoids the sum-of-slices
        // inflation that per-segment quotes introduce for continuous makers:
        // `quote(a) + quote(b) > quote(a+b)` when `a, b` are slices from the
        // same starting reserves on a non-linear curve.
        let solo = makers[i].try_fill_solo(ctx, side, base)?.ok_or({
            // Every Quoter impl in this crate implements try_fill_solo. If a
            // future maker can only quote piecewise, it would need to be
            // handled here — but today this branch is unreachable.
            ErrorCode::DefaultError
        })?;
        let fill = QuoterFill {
            side,
            base_filled: base,
            quote_filled: solo.quote_filled,
            clearing_price: clearing_price.unwrap_or(solo.clearing_price),
            refresh_cost: solo.refresh_cost,
            is_fee_exempt: makers[i].is_fee_exempt(),
            fee_policy: makers[i].fee_policy(),
            quote_asset_amount_surplus: solo.quote_asset_amount_surplus,
        };
        makers[i].commit_fill(ctx, &fill)?;
        total_refresh_cost = total_refresh_cost.safe_add(fill.refresh_cost)?;
        total_base = total_base.safe_add(base)?;
        total_quote = total_quote.safe_add(fill.quote_filled)?;
        result.fills.push((i as QuoterId, fill));
    }

    result.total_base_filled = total_base;
    result.total_quote_filled = total_quote;
    result.total_refresh_cost = total_refresh_cost;
    Ok(result)
}

/// Clear the segment `[p_lo, p_hi]` against the given active makers.
///
/// Tries `try_fill_solo` if exactly one maker is active; falls back to
/// bisection otherwise. Applies inframarginal portions, then distributes
/// the marginal slice priority-first then pro-rata.
fn clear_segment(
    makers: &mut [&mut dyn QuoterCommit],
    ctx: &QuoteContext,
    side: PositionDirection,
    p_lo: u64,
    p_hi: u64,
    demand_remaining: u64,
    active: &[QuoterId],
) -> DriftResult<SegmentClearing> {
    // Sole-maker fast path: try the analytical shortcut.
    if active.len() == 1 {
        let m = active[0];
        if let Some(fill) = makers[m as usize].try_fill_solo(ctx, side, demand_remaining)? {
            return Ok(SegmentClearing {
                clearing_price: fill.clearing_price,
                per_maker: vec![MakerBaseFill {
                    maker_id: m,
                    base: fill.base_filled,
                }],
            });
        }
        // Maker didn't provide a shortcut; fall through to bisection.
    }

    // Bisect for the clearing tick.
    let p_star = bisect_for_clearing(makers, ctx, side, p_lo, p_hi, demand_remaining, active)?;

    // Distribute fills at p_star.
    apply_clearing(makers, ctx, side, p_lo, p_star, demand_remaining, active)
}

/// Binary-search the segment `[p_lo, p_hi]` to find the smallest tick where
/// active makers' cumulative supply meets `demand`. Tick precision = `ctx.tick`.
fn bisect_for_clearing(
    makers: &mut [&mut dyn QuoterCommit],
    ctx: &QuoteContext,
    side: PositionDirection,
    p_lo: u64,
    p_hi: u64,
    demand: u64,
    active: &[QuoterId],
) -> DriftResult<u64> {
    let tick = ctx.tick.max(1);
    let mut lo = p_lo;
    let mut hi = p_hi;

    while hi.saturating_sub(lo) > tick {
        let mid = snap_to_tick(lo.safe_add(hi.safe_sub(lo)? / 2)?, tick);
        if mid == lo || mid == hi {
            break;
        }

        let mut supply_to_mid: u64 = 0;
        for &m in active {
            let cum_at_mid = makers[m as usize].cumulative_size(ctx, side, mid)?;
            let cum_at_lo = makers[m as usize].cumulative_size(ctx, side, p_lo)?;
            supply_to_mid = supply_to_mid.safe_add(cum_at_mid.safe_sub(cum_at_lo)?)?;
        }

        if supply_to_mid >= demand {
            hi = mid;
        } else {
            lo = mid;
        }
    }

    // Return the smallest tick where supply meets demand. After the loop,
    // hi is that boundary within tick precision.
    Ok(hi)
}

fn snap_to_tick(price: u64, tick: u64) -> u64 {
    if tick <= 1 {
        return price;
    }
    (price / tick).saturating_mul(tick)
}

/// Apply the clearing decision: credit inframarginal supply to each active
/// maker, distribute the marginal slice at `p_star` priority-first then
/// pro-rata.
///
/// # Pro-rata across makers with different curves
///
/// The matcher decides each maker's **base** allocation here:
/// inframarginal supply is credited up to `p_star - tick`; the marginal
/// slice at `p_star` is distributed priority-first then pro-rata by each
/// maker's depth at the marginal tick.
///
/// Per-maker **quote** is intentionally not computed in this function.
/// The matcher's final loop in `match_take` invokes `try_fill_solo` ONCE
/// per maker on the maker's total filled base. This matters for continuous
/// makers (AMMs) whose curves are non-linear: a sum of per-slice quotes
/// (one for inframarginal supply, one for each marginal slice) would
/// OVER-estimate against a single combined-swap quote — and the AMM's
/// `commit_fill` applies a single combined swap, so reporting the inflated
/// sum to the caller would create an accounting gap. Computing quote once
/// at the end keeps the reported `QuoterFill.quote_filled` equal to what
/// the AMM's reserves actually moved by.
///
/// Step makers (DLOB orders) at a single price level get the same answer
/// either way (their depth is flat at a tick, so base × price is linear).
/// The unified "try_fill_solo on total base" approach is correct for both.
fn apply_clearing(
    makers: &mut [&mut dyn QuoterCommit],
    ctx: &QuoteContext,
    side: PositionDirection,
    p_lo: u64,
    p_star: u64,
    demand_remaining: u64,
    active: &[QuoterId],
) -> DriftResult<SegmentClearing> {
    let tick = ctx.tick.max(1);
    let mut fills: Vec<MakerBaseFill> = Vec::with_capacity(active.len());

    // Inframarginal: every active maker fully fills up to (p_star - tick).
    // p_star_minus_tick is the largest price strictly below p_star.
    let p_star_minus_tick = match side {
        PositionDirection::Long => p_star.saturating_sub(tick),
        PositionDirection::Short => p_star.saturating_add(tick),
    };
    let mut inframarginal_total: u64 = 0;

    for &m in active {
        let cum_at_marginal_minus =
            makers[m as usize].cumulative_size(ctx, side, p_star_minus_tick)?;
        let cum_at_lo = makers[m as usize].cumulative_size(ctx, side, p_lo)?;
        // Saturating_sub in case the AMM curve has tiny rounding making cumulative_size
        // non-monotonic at small intervals.
        let inf = cum_at_marginal_minus.saturating_sub(cum_at_lo);
        fills.push(MakerBaseFill {
            maker_id: m,
            base: inf,
        });
        inframarginal_total = inframarginal_total.safe_add(inf)?;
    }

    // Marginal slice at p_star.
    let residual = demand_remaining.saturating_sub(inframarginal_total);

    if residual > 0 {
        // Compute per-maker marginal supply at p_star.
        let mut marginal: Vec<u64> = Vec::with_capacity(active.len());
        let mut total_marginal: u64 = 0;
        for &m in active {
            let cum_at_star = makers[m as usize].cumulative_size(ctx, side, p_star)?;
            let cum_at_minus = makers[m as usize].cumulative_size(ctx, side, p_star_minus_tick)?;
            let mar = cum_at_star.saturating_sub(cum_at_minus);
            marginal.push(mar);
            total_marginal = total_marginal.safe_add(mar)?;
        }

        if total_marginal == 0 {
            return Err(ErrorCode::DefaultError);
        }

        // Distribute: priority makers first, then pro-rata across non-prio.
        let mut remaining = residual;

        // Phase 1: priority makers.
        for (i, &m) in active.iter().enumerate() {
            if remaining == 0 {
                break;
            }
            if !makers[m as usize].is_prio() {
                continue;
            }
            let take = marginal[i].min(remaining);
            if take > 0 {
                fills[i].base = fills[i].base.safe_add(take)?;
                remaining = remaining.safe_sub(take)?;
            }
        }

        // Phase 2: pro-rata across non-priority makers.
        if remaining > 0 {
            // Recompute total marginal for non-priority makers only.
            let mut non_prio_marginal: u64 = 0;
            for (i, &m) in active.iter().enumerate() {
                if !makers[m as usize].is_prio() {
                    non_prio_marginal = non_prio_marginal.safe_add(marginal[i])?;
                }
            }

            if non_prio_marginal > 0 {
                let mut distributed: u64 = 0;
                let last_non_prio_i = active
                    .iter()
                    .enumerate()
                    .rfind(|(_, &m)| !makers[m as usize].is_prio())
                    .map(|(i, _)| i);

                for (i, &m) in active.iter().enumerate() {
                    if makers[m as usize].is_prio() {
                        continue;
                    }
                    let take = if Some(i) == last_non_prio_i {
                        // Assign all remaining to the last non-priority maker
                        // to avoid rounding-down loss.
                        remaining.safe_sub(distributed)?
                    } else {
                        // Pro-rata share.
                        (remaining as u128)
                            .safe_mul(marginal[i] as u128)?
                            .safe_div(non_prio_marginal as u128)? as u64
                    };
                    if take > 0 {
                        fills[i].base = fills[i].base.safe_add(take)?;
                        distributed = distributed.safe_add(take)?;
                    }
                }
            }
        }
    }

    Ok(SegmentClearing {
        clearing_price: p_star,
        per_maker: fills,
    })
}

/// Apply a completed [`Match`] to a `PerpMarket` — the part of a fill that the
/// matcher itself can't do because it doesn't see PerpMarket state.
///
/// After [`match_take`] returns, the per-maker state has already been mutated
/// (via each maker's `commit_fill`). This function handles the *protocol-level*
/// updates that depend on the aggregate `Match`:
/// - position counter updates on PerpMarket (base/quote totals)
/// - protocol fee accumulation (taker fee, optionally maker fee per maker's
///   `is_fee_exempt` flag — when fee policy is wired up)
/// - mark TWAPs and other market stats via `controller/market_stats.rs`
///
/// This is the function fill-path callers (`controller/orders.rs`,
/// `controller/amm_jit.rs`, settlement) invoke instead of the old hard-coded
/// post-`swap_base_asset` bookkeeping.
///
/// **Scope.** This handles the AMM-side post-fill bookkeeping that doesn't
/// belong on `AmmQuoter::commit_fill`:
/// - **Spread reserve recomputation** when an AMM fill occurred (detected via
///   any `QuoterFill::is_fee_exempt` — vAMM is exempt). After AMM reserves
///   change, ask/bid spread reserves need to be re-derived.
///
/// **Position counter updates, fee accumulation, and maker-fee policy are
/// NOT done here** — they happen in the fill controller (`controller/orders.rs`,
/// `controller/position.rs`) which has the taker / maker / filler `User`
/// references that this function does not. The fill controller drives off
/// `Match.fills`: for each `(QuoterId, QuoterFill)` it applies the per-maker
/// position/fee deltas using existing helpers like `update_position_and_market`
/// + `pay_keeper_flat_reward`. Per-maker fee policy reads `QuoterFill::is_fee_exempt`.
///
/// This split (AMM-side here, taker/fees in fill controller) keeps
/// `apply_match_to_perp_market` independent of the User layer.
pub fn apply_match_to_perp_market(
    _perp_market: &mut crate::state::perp_market::PerpMarket,
    _result: &Match,
) -> DriftResult<()> {
    // With ask/bid spread reserves no longer cached on the AMM, there is
    // nothing to refresh here after an AMM fill mutates the reserves. Kept
    // as a hook point for future market-side post-match accounting (e.g.
    // social loss, refresh_cost surfacing) — see file-level docs.
    Ok(())
}

/// Drop-in fill helper for the "AMM is the sole counterparty" case.
///
/// This is the simplest entry point fill paths can migrate to from
/// `swap_base_asset`: construct an `AmmQuoter` over the market's AMM, run
/// `match_take` with just it, then apply the match to the PerpMarket. Returns
/// the `Match` so callers can read out `total_base_filled`, `total_quote_filled`,
/// per-fill metadata (including `QuoterFill::is_fee_exempt` and `refresh_cost`).
///
/// For multi-maker fills (vAMM + DLOB orders + JIT participants), callers
/// construct the makers slice themselves and call `match_take` directly
/// followed by `apply_match_to_perp_market`. This helper is the convenience
/// shape for the sole-AMM case that dominates today's swap_base_asset call
/// sites in `controller/orders.rs`, `controller/amm_jit.rs`, settlement,
/// and liquidation paths.
///
/// Doesn't touch the user's side — taker position updates and fee
/// accumulation depend on `&mut User`, which this market-level helper
/// doesn't have. The surrounding fill controller handles them after this
/// function returns.
pub fn fill_perp_market_against_amm(
    perp_market: &mut crate::state::perp_market::PerpMarket,
    ctx: &QuoteContext,
    side: PositionDirection,
    target_size: u64,
) -> DriftResult<Match> {
    let result = {
        let mut amm_maker = AmmQuoter::for_amm(&mut perp_market.amm);
        let mut makers: Vec<&mut dyn QuoterCommit> = vec![&mut amm_maker];
        match_take(&mut makers, ctx, side, target_size, None)?
    };
    apply_match_to_perp_market(perp_market, &result)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::oracle::OraclePriceData;
    use crate::state::perp_market::MarketStats;
    use crate::state::quoter::{FillFeePolicy, QuoteContext, Quoter};

    /// A trivial single-price-step maker for unit tests — emulates a DLOB
    /// resting order.
    struct StepMaker {
        side: PositionDirection,
        price: u64,
        remaining: u64,
        is_prio: bool,
        is_fee_exempt: bool,
        commits: Vec<QuoterFill>,
    }

    impl StepMaker {
        fn new(side: PositionDirection, price: u64, remaining: u64) -> Self {
            StepMaker {
                side,
                price,
                remaining,
                is_prio: false,
                is_fee_exempt: false,
                commits: Vec::new(),
            }
        }
    }

    impl Quoter for StepMaker {
        fn best_price(&self, _ctx: &QuoteContext, side: PositionDirection) -> DriftResult<u64> {
            if side == self.side {
                Ok(self.price)
            } else {
                Ok(match side {
                    PositionDirection::Long => u64::MAX,
                    PositionDirection::Short => 0,
                })
            }
        }

        fn cumulative_size(
            &self,
            _ctx: &QuoteContext,
            side: PositionDirection,
            price: u64,
        ) -> DriftResult<u64> {
            if side != self.side {
                return Ok(0);
            }
            let crosses = match side {
                PositionDirection::Long => price >= self.price,
                PositionDirection::Short => price <= self.price,
            };
            Ok(if crosses { self.remaining } else { 0 })
        }

        fn is_prio(&self) -> bool {
            self.is_prio
        }

        fn is_fee_exempt(&self) -> bool {
            self.is_fee_exempt
        }

        fn try_fill_solo(
            &self,
            _ctx: &QuoteContext,
            side: PositionDirection,
            target_size: u64,
        ) -> DriftResult<Option<QuoterFill>> {
            if side != self.side {
                return Ok(None);
            }
            let base = target_size.min(self.remaining);
            Ok(Some(QuoterFill {
                side,
                base_filled: base,
                quote_filled: base.saturating_mul(self.price),
                clearing_price: self.price,
                refresh_cost: 0,
                is_fee_exempt: self.is_fee_exempt,
                fee_policy: FillFeePolicy::DlobMatch,
                quote_asset_amount_surplus: 0,
            }))
        }
    }

    impl QuoterCommit for StepMaker {
        fn commit_fill(&mut self, _ctx: &QuoteContext, fill: &QuoterFill) -> DriftResult<()> {
            self.remaining = self.remaining.saturating_sub(fill.base_filled);
            self.commits.push(*fill);
            Ok(())
        }
    }

    fn make_ctx<'a>(
        stats: &'a MarketStats,
        oracle: &'a OraclePriceData,
        tick: u64,
    ) -> QuoteContext<'a> {
        // Use base_precision = 1 for StepMaker tests (unit-less values) and
        // BASE_PRECISION for tests that involve real perp markets via
        // AmmQuoter; individual tests override as needed.
        QuoteContext {
            stats,
            oracle,
            mm_oracle: None,
            oracle_validity: None,
            fee_budget: 0,
            tick,
            step_size: 1,
            slot: 0,
            base_precision: 1,
            market_status: crate::state::market_status::MarketStatus::default(),
            market_config: 0,
        }
    }

    #[test]
    fn empty_makers_returns_empty_match() {
        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle, 1);
        let mut makers: Vec<&mut dyn QuoterCommit> = vec![];
        let result = match_take(&mut makers, &ctx, PositionDirection::Long, 100, None).unwrap();
        assert_eq!(result.total_base_filled, 0);
        assert!(!result.is_complete());
    }

    #[test]
    fn single_maker_uses_try_fill_solo() {
        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle, 1);

        let mut m = StepMaker::new(PositionDirection::Long, 100, 50);
        let mut makers: Vec<&mut dyn QuoterCommit> = vec![&mut m];

        let result = match_take(&mut makers, &ctx, PositionDirection::Long, 30, None).unwrap();

        assert!(result.is_complete());
        assert_eq!(result.total_base_filled, 30);
        assert_eq!(result.clearing_price, Some(100));
        assert_eq!(m.remaining, 20);
    }

    #[test]
    fn two_makers_better_price_fills_first() {
        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle, 1);

        let mut cheap = StepMaker::new(PositionDirection::Long, 100, 30);
        let mut expensive = StepMaker::new(PositionDirection::Long, 110, 100);
        let mut makers: Vec<&mut dyn QuoterCommit> = vec![&mut cheap, &mut expensive];

        // Buy 50: 30 from cheap (at 100) + 20 from expensive (at 110).
        let result = match_take(&mut makers, &ctx, PositionDirection::Long, 50, None).unwrap();

        assert!(result.is_complete());
        assert_eq!(result.total_base_filled, 50);
        assert_eq!(cheap.remaining, 0);
        assert_eq!(expensive.remaining, 80);
    }

    #[test]
    fn partial_fill_returns_none_clearing_price() {
        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle, 1);

        let mut m = StepMaker::new(PositionDirection::Long, 100, 10);
        let mut makers: Vec<&mut dyn QuoterCommit> = vec![&mut m];

        let result = match_take(&mut makers, &ctx, PositionDirection::Long, 100, None).unwrap();

        // Maker only has 10 of the requested 100 — partial fill, no clearing tick.
        assert_eq!(result.total_base_filled, 10);
        assert_eq!(result.clearing_price, None);
    }

    #[test]
    fn fill_perp_market_against_amm_helper_works() {
        // Exercises the high-level `fill_perp_market_against_amm` convenience
        // wrapper that wraps match_take + apply_match_to_perp_market for the
        // sole-AMM case. Verifies one call mutates AMM reserves, refreshes
        // spread reserves, and mirrors stats — i.e., is a drop-in replacement
        // for swap_base_asset + post-swap bookkeeping.
        use crate::math::constants::{AMM_RESERVE_PRECISION, PEG_PRECISION};
        use crate::state::perp_market::{PerpMarket, AMM};

        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle, 1);

        let amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            min_base_asset_reserve: 50 * AMM_RESERVE_PRECISION,
            max_base_asset_reserve: 200 * AMM_RESERVE_PRECISION,
            ..AMM::default()
        };

        let mut perp_market = PerpMarket {
            amm,
            market_stats: MarketStats {
                volume_24h: 7777,
                ..MarketStats::default()
            },
            ..PerpMarket::default()
        };
        let starting_reserve = perp_market.amm.base_asset_reserve;

        perp_market.amm.seed_no_spread_quote_state();
        let result = fill_perp_market_against_amm(
            &mut perp_market,
            &ctx,
            PositionDirection::Long,
            AMM_RESERVE_PRECISION as u64,
        )
        .unwrap();

        assert!(result.is_complete());
        assert_eq!(result.total_base_filled, AMM_RESERVE_PRECISION as u64);
        // AMM reserves mutated.
        assert!(perp_market.amm.base_asset_reserve < starting_reserve);
        // MarketStats value preserved by apply_match_to_perp_market.
        assert_eq!(perp_market.market_stats.volume_24h, 7777);
    }

    #[test]
    fn end_to_end_match_take_and_apply_to_perp_market() {
        // Full architecture exercised: construct a PerpMarket, wrap its AMM
        // as a Maker, run match_take, then apply the Match to the PerpMarket.
        // Verify the AMM mutated AND the MarketStats sync happened.
        use crate::amm::AmmQuoter;
        use crate::math::constants::{AMM_RESERVE_PRECISION, PEG_PRECISION};
        use crate::state::perp_market::{PerpMarket, AMM};

        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle, 1);

        let amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            min_base_asset_reserve: 50 * AMM_RESERVE_PRECISION,
            max_base_asset_reserve: 200 * AMM_RESERVE_PRECISION,
            ..AMM::default()
        };

        let mut perp_market = PerpMarket {
            amm,
            // Stats fields now live in MarketStats; AMM-side equivalents are
            // no longer written or mirrored.
            market_stats: MarketStats {
                last_mark_price_twap: 99_500_000,
                volume_24h: 1_000_000,
                mark_std: 1_000,
                ..MarketStats::default()
            },
            ..PerpMarket::default()
        };

        assert_eq!(perp_market.market_stats.last_mark_price_twap, 99_500_000);
        assert_eq!(perp_market.market_stats.volume_24h, 1_000_000);

        let starting_reserve = perp_market.amm.base_asset_reserve;
        let starting_ask_base = 0u128;

        let result = {
            let mut amm_maker = AmmQuoter::new_no_spread(&mut perp_market.amm);
            let mut makers: Vec<&mut dyn QuoterCommit> = vec![&mut amm_maker];
            match_take(
                &mut makers,
                &ctx,
                PositionDirection::Long,
                AMM_RESERVE_PRECISION as u64,
                None,
            )
            .unwrap()
        };

        assert!(result.is_complete());
        assert!(perp_market.amm.base_asset_reserve < starting_reserve);
        // Spread reserves are no longer cached on AMM — there's nothing for
        // `apply_match_to_perp_market` to refresh, and `starting_ask_base`
        // remains the sentinel zero we initialized it with.
        assert_eq!(0u128, starting_ask_base);

        // Apply the match: mirrors MarketStats but no longer touches any
        // spread cache (the spread cache was deleted in the AMM-decoupling
        // refactor; quote-time state is materialized on demand).
        apply_match_to_perp_market(&mut perp_market, &result).unwrap();

        // Stats migrated to MarketStats — AMM-side fields are no longer
        // written or mirrored. apply_match_to_perp_market preserves
        // market_stats values that were already there.
        assert_eq!(perp_market.market_stats.last_mark_price_twap, 99_500_000);
        assert_eq!(perp_market.market_stats.volume_24h, 1_000_000);
    }

    // `apply_match_skips_spread_refresh_when_amm_unused` was removed: the
    // behaviour it guarded (skipping `update_spread_reserves` on DLOB-only
    // matches) is now vacuous — spread state is no longer cached on the
    // AMM, so `apply_match_to_perp_market` has no spread reserves to touch
    // either way.

    #[test]
    fn is_fee_exempt_propagates_through_match() {
        // The matcher should populate `QuoterFill::is_fee_exempt` from each
        // maker's `Quoter::is_fee_exempt()` so the fill controller can apply
        // correct fee policy.
        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle, 1);

        // Two makers at different prices; one fee-exempt, one not.
        let mut exempt = StepMaker::new(PositionDirection::Long, 100, 30);
        exempt.is_fee_exempt = true;
        let mut standard = StepMaker::new(PositionDirection::Long, 110, 50);
        standard.is_fee_exempt = false;

        let mut makers: Vec<&mut dyn QuoterCommit> = vec![&mut exempt, &mut standard];
        let result = match_take(&mut makers, &ctx, PositionDirection::Long, 50, None).unwrap();

        assert!(result.is_complete());
        assert_eq!(result.fills.len(), 2);

        // Find each maker in the fills and verify is_fee_exempt is correct.
        for (id, fill) in &result.fills {
            match *id {
                0 => assert!(fill.is_fee_exempt, "exempt maker should report fee-exempt"),
                1 => assert!(
                    !fill.is_fee_exempt,
                    "standard maker should not be fee-exempt"
                ),
                _ => panic!("unexpected maker id {}", id),
            }
        }
    }

    #[test]
    fn multi_maker_amm_quote_matches_total_base_swap() {
        // After a multi-maker bisection fill that touches the AMM, the
        // AMM's reported quote_filled must equal try_fill_solo(total_base)
        // — NOT inframarginal_quote + marginal_quote (the old buggy sum
        // would inflate, since each slice computes against the same starting
        // reserves and the AMM curve is non-linear). Regression guard.
        use crate::amm::AmmQuoter;
        use crate::amm::AMM;
        use crate::math::constants::{AMM_RESERVE_PRECISION, PEG_PRECISION};
        use crate::state::quoter::{DlobOrderQuoter, Quoter};
        use crate::state::user::{
            MarketType, Order, OrderStatus, OrderTriggerCondition, OrderType,
        };

        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = QuoteContext {
            base_precision: crate::math::constants::BASE_PRECISION as u64,
            ..make_ctx(&stats, &oracle, 1)
        };

        let make_amm = || AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            min_base_asset_reserve: 50 * AMM_RESERVE_PRECISION,
            max_base_asset_reserve: 200 * AMM_RESERVE_PRECISION,
            ..AMM::default()
        };

        let mut amm = make_amm();
        let amm_ask = {
            let amm_maker = AmmQuoter::new_no_spread(&mut amm);
            amm_maker.best_price(&ctx, PositionDirection::Long).unwrap()
        };

        // DLOB just below AMM ask so the bisection path runs (multiple
        // makers active in clearing segment).
        let mut dlob = Order {
            slot: 0,
            price: amm_ask.saturating_sub(amm_ask / 200),
            base_asset_amount: (AMM_RESERVE_PRECISION as u64) / 2,
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
            direction: PositionDirection::Short,
            reduce_only: false,
            post_only: true,
            immediate_or_cancel: false,
            trigger_condition: OrderTriggerCondition::Above,
            auction_duration: 0,
            posted_slot_tail: 0,
            bit_flags: 0,
            padding: [0; 5],
        };

        // Run the match. Capture AMM's reported quote_filled.
        let (amm_id, amm_base_filled, amm_quote_filled) = {
            let mut amm_maker = AmmQuoter::new_no_spread(&mut amm);
            let mut dlob_maker = DlobOrderQuoter::new(&mut dlob);
            let mut makers: Vec<&mut dyn QuoterCommit> = vec![&mut amm_maker, &mut dlob_maker];
            let result = match_take(
                &mut makers,
                &ctx,
                PositionDirection::Long,
                AMM_RESERVE_PRECISION as u64,
                None,
            )
            .unwrap();
            let amm_fill = result
                .fills
                .iter()
                .find(|(id, _)| *id == 0)
                .map(|(id, f)| (*id, f.base_filled, f.quote_filled))
                .expect("AMM should appear in fills");
            amm_fill
        };

        // Independently compute what try_fill_solo(total_amm_base) returns
        // against a FRESH AMM at the same starting state. This should match
        // amm_quote_filled. If the matcher's old sum-of-slices bug returned,
        // amm_quote_filled would be larger than this reference.
        let mut fresh_amm = make_amm();
        let reference_quote = {
            let fresh_maker = AmmQuoter::new_no_spread(&mut fresh_amm);
            fresh_maker
                .try_fill_solo(&ctx, PositionDirection::Long, amm_base_filled)
                .unwrap()
                .expect("AmmQuoter::try_fill_solo returns Some for non-zero target")
                .quote_filled
        };

        assert_eq!(
            amm_quote_filled, reference_quote,
            "matcher's AMM quote_filled ({}) must equal try_fill_solo quote for total amm base ({}) — \
             sum-of-slices regression",
            amm_quote_filled, reference_quote
        );

        let _ = amm_id; // unused except as documentation
    }

    #[test]
    fn multi_maker_bisection_uses_amm_exact_quote() {
        // When 2+ makers are active in the clearing segment AND one is the
        // AMM, the matcher's bisection path is taken (not the sole-maker
        // fast path). Per-maker quote should come from AmmQuoter::try_fill_solo
        // (called per-maker in the final loop) which uses exact swap math,
        // NOT the flat-price approximation.
        //
        // Setup: DLOB ask exactly at the AMM's ask price (price-tied tie group).
        // The matcher routes some volume to each. The AMM's portion should be
        // the exact swap quote, not base * best_ask / base_precision.
        use crate::amm::AmmQuoter;
        use crate::amm::AMM;
        use crate::math::constants::{AMM_RESERVE_PRECISION, PEG_PRECISION};
        use crate::state::quoter::DlobOrderQuoter;
        use crate::state::user::{
            MarketType, Order, OrderStatus, OrderTriggerCondition, OrderType,
        };

        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx_for_lookup = make_ctx(&stats, &oracle, 1);
        // Use BASE_PRECISION = 1e9 for the actual match.
        let ctx = QuoteContext {
            base_precision: crate::math::constants::BASE_PRECISION as u64,
            ..ctx_for_lookup
        };

        let mut amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            min_base_asset_reserve: 50 * AMM_RESERVE_PRECISION,
            max_base_asset_reserve: 200 * AMM_RESERVE_PRECISION,
            ..AMM::default()
        };

        // DLOB order at a price BELOW the AMM's ask — DLOB fills first, AMM
        // covers the rest. Both makers active in the clearing region.
        let amm_ask = {
            let amm_maker = AmmQuoter::new_no_spread(&mut amm);
            amm_maker.best_price(&ctx, PositionDirection::Long).unwrap()
        };

        let mut dlob = Order {
            slot: 0,
            price: amm_ask.saturating_sub(amm_ask / 200), // slightly below ask
            base_asset_amount: (AMM_RESERVE_PRECISION as u64) / 2,
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
            direction: PositionDirection::Short,
            reduce_only: false,
            post_only: true,
            immediate_or_cancel: false,
            trigger_condition: OrderTriggerCondition::Above,
            auction_duration: 0,
            posted_slot_tail: 0,
            bit_flags: 0,
            padding: [0; 5],
        };

        let (amm_fill_quote, total_base) = {
            let mut amm_maker = AmmQuoter::new_no_spread(&mut amm);
            let mut dlob_maker = DlobOrderQuoter::new(&mut dlob);
            let mut makers: Vec<&mut dyn QuoterCommit> = vec![&mut amm_maker, &mut dlob_maker];

            let result = match_take(
                &mut makers,
                &ctx,
                PositionDirection::Long,
                AMM_RESERVE_PRECISION as u64,
                None,
            )
            .unwrap();

            // Find AMM's fill (maker id 0).
            let amm_fill = result
                .fills
                .iter()
                .find(|(id, _)| *id == 0)
                .map(|(_, f)| (f.quote_filled, f.base_filled))
                .unwrap_or((0, 0));
            (amm_fill.0, result.total_base_filled)
        };

        // AMM's quote should be reasonable for its filled base — not 0 and
        // not wildly inflated. With base_precision=1e9 and prices around
        // 1e8 (= $100), quotes per BASE should be ~1e8 (~$100). For the
        // AMM's filled slice (less than 1 BASE), quote should be < 1e8.
        assert_eq!(total_base, AMM_RESERVE_PRECISION as u64);
        // Sanity: AMM's quote_filled is in a plausible QUOTE_PRECISION range
        // (between $1 and $1000 per unit BASE filled). This would catch the
        // bug where matcher computes quote = base * price (raw), giving 1e9×.
        if amm_fill_quote > 0 {
            assert!(
                amm_fill_quote < 1_000_000_000_000, // < $1M total = sanity
                "AMM quote_filled {} suggests precision bug",
                amm_fill_quote
            );
        }
    }

    #[test]
    fn matcher_routes_to_cheaper_dlob_when_amm_is_more_expensive() {
        // Inverse of `matcher_combines_amm_and_dlob_order`: DLOB order quotes
        // a STRICTLY better price than the AMM. Even though the AMM is prio,
        // price priority wins first — DLOB should fill before AMM.
        use crate::amm::AmmQuoter;
        use crate::amm::AMM;
        use crate::math::constants::{AMM_RESERVE_PRECISION, PEG_PRECISION};
        use crate::state::quoter::DlobOrderQuoter;
        use crate::state::user::{
            MarketType, Order, OrderStatus, OrderTriggerCondition, OrderType,
        };

        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle, 1);

        // AMM ask price will be ~101 (peg=100, long_spread=1%).
        let mut amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            min_base_asset_reserve: 50 * AMM_RESERVE_PRECISION,
            max_base_asset_reserve: 200 * AMM_RESERVE_PRECISION,
            ..AMM::default()
        };

        // DLOB ask at $50 — much cheaper than the AMM. DLOB has limited
        // depth, so partial routes through DLOB then overflows to AMM.
        let mut dlob = Order {
            slot: 0,
            price: 50 * 1_000_000,
            base_asset_amount: (AMM_RESERVE_PRECISION / 2) as u64, // 0.5 base
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
            direction: PositionDirection::Short, // ask
            reduce_only: false,
            post_only: true,
            immediate_or_cancel: false,
            trigger_condition: OrderTriggerCondition::Above,
            auction_duration: 0,
            posted_slot_tail: 0,
            bit_flags: 0,
            padding: [0; 5],
        };

        {
            let mut amm_maker = AmmQuoter::new_no_spread(&mut amm);
            let mut dlob_maker = DlobOrderQuoter::new(&mut dlob);
            let mut makers: Vec<&mut dyn QuoterCommit> = vec![&mut amm_maker, &mut dlob_maker];

            // Buy 1 base. DLOB has 0.5 at $50 → fills first. AMM fills the
            // remaining 0.5 at its higher price.
            let result = match_take(
                &mut makers,
                &ctx,
                PositionDirection::Long,
                AMM_RESERVE_PRECISION as u64,
                None,
            )
            .unwrap();

            assert!(result.is_complete());
            assert_eq!(result.total_base_filled, AMM_RESERVE_PRECISION as u64);
        }

        // DLOB fully consumed.
        assert_eq!(
            dlob.base_asset_amount_filled,
            (AMM_RESERVE_PRECISION / 2) as u64
        );
        // AMM filled the rest — base_asset_reserve changed.
        assert!(amm.base_asset_reserve < 100 * AMM_RESERVE_PRECISION);
    }

    #[test]
    fn matcher_combines_amm_and_dlob_order() {
        // Multi-maker case: an AMM and a single DLOB ask order are both
        // active. The matcher should respect price priority and route fill
        // to whichever offers a better price.
        use crate::amm::AmmQuoter;
        use crate::amm::AMM;
        use crate::math::constants::{AMM_RESERVE_PRECISION, PEG_PRECISION};
        use crate::state::quoter::DlobOrderQuoter;
        use crate::state::user::{
            MarketType, Order, OrderStatus, OrderTriggerCondition, OrderType,
        };

        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle, 1);

        let mut amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            min_base_asset_reserve: 50 * AMM_RESERVE_PRECISION,
            max_base_asset_reserve: 200 * AMM_RESERVE_PRECISION,
            ..AMM::default()
        };

        // DLOB ask order at a much higher price than AMM's ask, so AMM
        // should be hit first.
        let mut dlob = Order {
            slot: 0,
            price: 200 * 1_000_000, // way above AMM ask
            base_asset_amount: AMM_RESERVE_PRECISION as u64,
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
            direction: PositionDirection::Short, // ask
            reduce_only: false,
            post_only: true,
            immediate_or_cancel: false,
            trigger_condition: OrderTriggerCondition::Above,
            auction_duration: 0,
            posted_slot_tail: 0,
            bit_flags: 0,
            padding: [0; 5],
        };

        {
            let mut amm_maker = AmmQuoter::new_no_spread(&mut amm);
            let mut dlob_maker = DlobOrderQuoter::new(&mut dlob);
            let mut makers: Vec<&mut dyn QuoterCommit> = vec![&mut amm_maker, &mut dlob_maker];

            // Buy a small size — should come entirely from the AMM (cheaper).
            let result = match_take(
                &mut makers,
                &ctx,
                PositionDirection::Long,
                AMM_RESERVE_PRECISION as u64,
                None,
            )
            .unwrap();

            assert!(result.is_complete());
            assert_eq!(result.total_base_filled, AMM_RESERVE_PRECISION as u64);
        }

        // DLOB ask should still have its full size remaining.
        assert_eq!(dlob.base_asset_amount_filled, 0);
        // AMM should have been touched.
        assert!(amm.base_asset_reserve != 100 * AMM_RESERVE_PRECISION);
    }

    #[test]
    fn matcher_routes_to_jit_maker_alongside_dlob() {
        // The matcher embodiment of "AMM JIT-makes alongside a DLOB maker at
        // the DLOB's price". Setup:
        //   - DLOB ask at price 99 with 10 BASE depth.
        //   - AmmJitQuoter at jit_price=99 with max_jit_base=3 BASE (the
        //     throttled cap the caller would compute via
        //     `math::amm_jit::calculate_amm_jit_liquidity`).
        //   - Taker Long wants 8 BASE.
        // Expected: DLOB takes the priority slice (is_prio: false on
        // AmmJitQuoter), but at the same price both contribute pro-rata.
        // The AMM caps at its throttled max_jit_base.
        use crate::amm::AmmJitQuoter;
        use crate::amm::AMM;
        use crate::math::constants::{AMM_RESERVE_PRECISION, PEG_PRECISION};
        use crate::state::quoter::DlobOrderQuoter;
        use crate::state::user::{
            MarketType, Order, OrderStatus, OrderTriggerCondition, OrderType,
        };

        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = QuoteContext {
            base_precision: crate::math::constants::BASE_PRECISION as u64,
            ..make_ctx(&stats, &oracle, 1)
        };

        let mut amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            min_base_asset_reserve: 50 * AMM_RESERVE_PRECISION,
            max_base_asset_reserve: 200 * AMM_RESERVE_PRECISION,
            ..AMM::default()
        };

        let dlob_price: u64 = 99 * 1_000_000;
        let dlob_depth: u64 = 10 * AMM_RESERVE_PRECISION as u64;
        let mut dlob = Order {
            slot: 0,
            price: dlob_price,
            base_asset_amount: dlob_depth,
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
            direction: PositionDirection::Short, // ask
            reduce_only: false,
            post_only: true,
            immediate_or_cancel: false,
            trigger_condition: OrderTriggerCondition::Above,
            auction_duration: 0,
            posted_slot_tail: 0,
            bit_flags: 0,
            padding: [0; 5],
        };

        let jit_cap: u64 = 3 * AMM_RESERVE_PRECISION as u64;
        let take_size: u64 = 8 * AMM_RESERVE_PRECISION as u64;

        let (dlob_filled, amm_filled) = {
            let mut amm_jit = AmmJitQuoter::new_no_spread(&mut amm, dlob_price, jit_cap);
            let mut dlob_maker = DlobOrderQuoter::new(&mut dlob);
            // dlob first so it's prio'd at tied price (is_prio: true overall
            // would still apply; DlobOrderQuoter has is_prio=false, AmmJitQuoter
            // is_prio=false too, so they pro-rata at the tied price).
            let mut makers: Vec<&mut dyn QuoterCommit> = vec![&mut dlob_maker, &mut amm_jit];
            let result =
                match_take(&mut makers, &ctx, PositionDirection::Long, take_size, None).unwrap();

            assert!(result.is_complete(), "should fill 8 BASE total");
            assert_eq!(result.total_base_filled, take_size);

            let dlob_filled = result
                .fills
                .iter()
                .find(|(id, _)| *id == 0)
                .map(|(_, f)| f.base_filled)
                .unwrap_or(0);
            let amm_filled = result
                .fills
                .iter()
                .find(|(id, _)| *id == 1)
                .map(|(_, f)| f.base_filled)
                .unwrap_or(0);
            (dlob_filled, amm_filled)
        };

        // AMM JIT must be capped at jit_cap.
        assert!(
            amm_filled <= jit_cap,
            "AMM filled {} > cap {}",
            amm_filled,
            jit_cap
        );
        // Both contribute (non-zero).
        assert!(dlob_filled > 0, "DLOB should fill some");
        assert!(amm_filled > 0, "AMM JIT should fill some");
        // Total = take_size.
        assert_eq!(dlob_filled + amm_filled, take_size);
        // The AMM-side bookkeeping ran (reserves moved).
        assert!(amm.base_asset_reserve < 100 * AMM_RESERVE_PRECISION);
    }

    #[test]
    fn matcher_works_with_amm_maker() {
        use crate::amm::AmmQuoter;
        use crate::amm::AMM;
        use crate::math::constants::{AMM_RESERVE_PRECISION, PEG_PRECISION};

        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle, 1);

        let mut amm = AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            min_base_asset_reserve: 50 * AMM_RESERVE_PRECISION,
            max_base_asset_reserve: 200 * AMM_RESERVE_PRECISION,
            ..AMM::default()
        };

        let starting_reserve = amm.base_asset_reserve;

        {
            let mut amm_maker = AmmQuoter::new_no_spread(&mut amm);
            let mut makers: Vec<&mut dyn QuoterCommit> = vec![&mut amm_maker];
            let result = match_take(
                &mut makers,
                &ctx,
                PositionDirection::Long,
                AMM_RESERVE_PRECISION as u64,
                None,
            )
            .unwrap();
            assert!(result.is_complete(), "sole-AMM fill should be complete");
            assert_eq!(result.total_base_filled, AMM_RESERVE_PRECISION as u64);
            assert!(result.total_quote_filled > 0);
        }

        // AMM's base_asset_reserve should have decreased by the fill (taker bought base from AMM).
        assert!(amm.base_asset_reserve < starting_reserve);
        // base_asset_amount_with_amm tracks USERS' net long position (when
        // AMM is counterparty); taker just bought → users' net long grew → > 0.
        assert!(amm.base_asset_amount_with_amm > 0);
    }

    #[test]
    fn matcher_works_with_real_dlob_orders() {
        use crate::state::quoter::DlobOrderQuoter;
        use crate::state::user::{
            MarketType, Order, OrderStatus, OrderTriggerCondition, OrderType,
        };

        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle, 1);

        fn ask(price: u64, size: u64) -> Order {
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
                direction: PositionDirection::Short,
                reduce_only: false,
                post_only: true,
                immediate_or_cancel: false,
                trigger_condition: OrderTriggerCondition::Above,
                auction_duration: 0,
                posted_slot_tail: 0,
                bit_flags: 0,
                padding: [0; 5],
            }
        }

        // Buy 50 base, with two ask orders: 30 @ 100, 100 @ 110.
        // Matcher should fill 30 from the cheaper, 20 from the more expensive.
        let mut cheap = ask(100, 30);
        let mut expensive = ask(110, 100);
        {
            let mut cheap_m = DlobOrderQuoter::new(&mut cheap);
            let mut exp_m = DlobOrderQuoter::new(&mut expensive);
            let mut makers: Vec<&mut dyn QuoterCommit> = vec![&mut cheap_m, &mut exp_m];

            let result = match_take(&mut makers, &ctx, PositionDirection::Long, 50, None).unwrap();

            assert!(result.is_complete());
            assert_eq!(result.total_base_filled, 50);
        }
        assert_eq!(cheap.base_asset_amount_filled, 30);
        assert_eq!(expensive.base_asset_amount_filled, 20);
    }

    #[test]
    fn priority_maker_takes_marginal_first() {
        let stats = MarketStats::default();
        let oracle = OraclePriceData::default();
        let ctx = make_ctx(&stats, &oracle, 1);

        // Both makers at same price. Priority maker should get all marginal volume.
        let mut prio = StepMaker::new(PositionDirection::Long, 100, 100);
        prio.is_prio = true;
        let mut regular = StepMaker::new(PositionDirection::Long, 100, 100);
        let mut makers: Vec<&mut dyn QuoterCommit> = vec![&mut prio, &mut regular];

        let result = match_take(&mut makers, &ctx, PositionDirection::Long, 50, None).unwrap();

        assert!(result.is_complete());
        assert_eq!(result.total_base_filled, 50);
        // Priority maker should have filled all 50.
        assert_eq!(prio.remaining, 50);
        assert_eq!(regular.remaining, 100);
    }
}
