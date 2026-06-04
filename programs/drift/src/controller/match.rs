//! Fill engine.
//!
//! Two explicit, hardcoded fill paths — there is no general continuous-curve
//! clearing algorithm (no bisection, no price-domain search):
//!
//! - [`fill_amm_only`]: the sole continuous maker — the constant-product vAMM.
//!   Asks the AMM for its closed-form analytical fill via `try_fill_solo`,
//!   capped at the taker's limit by the AMM's `cumulative_size`. This is the
//!   only path that touches the continuous curve, and it's the dominant
//!   production case.
//! - [`match_take`]: a set of **discrete** single-price makers (DLOB orders,
//!   the JIT vAMM participant `AmmJitQuoter`, future spline levels). Each
//!   maker's full size materialises at its `best_price`; the engine walks
//!   levels best-first and distributes the clearing level priority-first then
//!   pro-rata. No bisection — discrete levels are walked, not searched.
//!
//! The split mirrors where the system is going: when the constant-product AMM
//! is excised in favour of off-chain market makers pushing discrete spline
//! levels, `fill_amm_only` and the continuous-curve math are deleted wholesale
//! and `match_take` (the discrete walk) becomes the whole engine. Per-maker
//! quote is recomputed ONCE against each maker's total filled base via
//! `try_fill_solo` (never summed per slice).

use crate::amm::AmmQuoter;
use crate::controller::position::PositionDirection;
use crate::error::{DriftResult, ErrorCode};
use crate::math::safe_math::SafeMath;
use crate::state::quoter::{QuoteContext, Quoter, QuoterCommit, QuoterFill};

/// Index into the `makers` slice passed to [`match_take`].
pub type QuoterId = u16;

/// One discrete maker's single price level, materialised by [`match_take`].
/// `capacity` is the maker's full fillable base at `price` (from
/// [`Quoter::level_capacity`]).
struct DiscreteLevel {
    maker_id: QuoterId,
    price: u64,
    is_prio: bool,
    capacity: u64,
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

/// Fill a take against the sole continuous maker — the constant-product vAMM.
///
/// Asks the AMM for its closed-form analytical fill (`try_fill_solo`), capped
/// at the taker's limit by the AMM's `cumulative_size` (the inverse of its
/// curve at `price_cap`). Byte-exact with the legacy `swap_base_asset`. This
/// is the only path that touches the continuous curve; everything else is a
/// discrete level walk. `taker_limit_price = None` means no taker-side cap.
pub fn fill_amm_only(
    amm: &mut AmmQuoter,
    ctx: &QuoteContext,
    side: PositionDirection,
    target_size: u64,
    taker_limit_price: Option<u64>,
) -> DriftResult<Match> {
    if target_size == 0 {
        return Ok(Match::empty());
    }
    let price_cap: u64 = taker_limit_price.unwrap_or(match side {
        PositionDirection::Long => u64::MAX,
        PositionDirection::Short => 0,
    });

    let best_price = amm.best_price(ctx, side)?;
    let quotes_on_side = match side {
        PositionDirection::Long => best_price < u64::MAX,
        PositionDirection::Short => best_price > 0,
    };
    let in_bounds = match side {
        PositionDirection::Long => best_price <= price_cap,
        PositionDirection::Short => best_price >= price_cap,
    };
    if !quotes_on_side || !in_bounds {
        return Ok(Match::empty());
    }

    // Cap the take by the AMM's supply at `price_cap` so the fill never clears
    // past the taker's limit. Unbounded callers (sentinel `price_cap`) collapse
    // to `target_size`.
    let supply_at_cap = amm.cumulative_size(ctx, side, price_cap)?;
    let effective_target = target_size.min(supply_at_cap);
    if effective_target == 0 {
        return Ok(Match::empty());
    }

    let Some(fill) = amm.try_fill_solo(ctx, side, effective_target)? else {
        return Ok(Match::empty());
    };
    if fill.base_filled == 0 {
        return Ok(Match::empty());
    }
    let result_fill = QuoterFill {
        is_fee_exempt: amm.is_fee_exempt(),
        ..fill
    };
    amm.commit_fill(ctx, &result_fill)?;

    let mut result = Match::empty();
    // Partial fills (base_filled < target) report clearing_price = None.
    result.clearing_price = if result_fill.base_filled >= target_size {
        Some(result_fill.clearing_price)
    } else {
        None
    };
    result.total_base_filled = result_fill.base_filled;
    result.total_quote_filled = result_fill.quote_filled;
    result.total_refresh_cost = result_fill.refresh_cost;
    result.fills.push((0, result_fill));
    Ok(result)
}

/// Fill a take against a set of **discrete** single-price makers (DLOB orders,
/// the JIT vAMM participant, future spline levels). Returns the per-maker
/// fills + clearing price.
///
/// Each maker exposes one level: its `best_price` and its full fillable base
/// (`level_capacity`). The engine sorts levels
/// best-first and walks them: fully-crossed levels fill entirely; the level
/// that crosses `target_size` is the clearing level, where the residual is
/// distributed priority-first (`is_prio`) then pro-rata by capacity across the
/// price-tied group. There is no bisection — levels are walked, not searched.
///
/// NOT for the continuous AMM curve (use [`fill_amm_only`]); a continuous
/// maker's "size at best_price" is ~0, so it would be treated as empty here.
///
/// `taker_limit_price` is the price the taker won't fill past (Long: won't
/// clear above; Short: won't clear below). `None` means no cap.
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
    // Materialise each maker as one discrete level (dropping non-quoting,
    // out-of-limit, or zero-capacity makers), best price first. `sort_by` is
    // stable, so price ties keep the makers' original order — deterministic
    // pro-rata. Priority makers sort ahead within a tie.
    let mut levels: Vec<DiscreteLevel> = makers
        .iter()
        .enumerate()
        .filter_map(|(idx, maker)| {
            discrete_level(idx as QuoterId, &**maker, ctx, side, price_cap).transpose()
        })
        .collect::<DriftResult<_>>()?;
    if levels.is_empty() {
        return Ok(Match::empty());
    }
    levels.sort_by(|a, b| {
        let by_price = match side {
            PositionDirection::Long => a.price.cmp(&b.price),
            PositionDirection::Short => b.price.cmp(&a.price),
        };
        by_price.then(b.is_prio.cmp(&a.is_prio))
    });

    // Walk price-tied groups best-first: fully-crossed groups take their whole
    // capacity; the group that crosses `target_size` is the clearing level —
    // split its residual priority-first then pro-rata. Falling off the end
    // without crossing is a partial fill (clearing_price stays None).
    let mut per_maker_base: Vec<u64> = vec![0; makers.len()];
    let mut cumulative: u64 = 0;
    let mut clearing_price: Option<u64> = None;

    for group in levels.chunk_by(|a, b| a.price == b.price) {
        let group_supply = group
            .iter()
            .try_fold(0u64, |acc, l| acc.safe_add(l.capacity))?;

        if cumulative.safe_add(group_supply)? <= target_size {
            for lvl in group {
                let slot = &mut per_maker_base[lvl.maker_id as usize];
                *slot = slot.safe_add(lvl.capacity)?;
            }
            cumulative = cumulative.safe_add(group_supply)?;
            if cumulative == target_size {
                clearing_price = Some(group[0].price);
                break;
            }
        } else {
            distribute_marginal(
                group,
                target_size.safe_sub(cumulative)?,
                &mut per_maker_base,
            )?;
            clearing_price = Some(group[0].price);
            break;
        }
    }

    commit_fills(makers, ctx, side, &per_maker_base, clearing_price)
}

/// Materialise a maker's single discrete level — its `best_price` and full
/// `level_capacity`. `None` if the maker doesn't quote this side, sits past
/// `price_cap`, or has zero capacity.
fn discrete_level(
    maker_id: QuoterId,
    maker: &dyn QuoterCommit,
    ctx: &QuoteContext,
    side: PositionDirection,
    price_cap: u64,
) -> DriftResult<Option<DiscreteLevel>> {
    let price = maker.best_price(ctx, side)?;
    let quotes_in_bounds = match side {
        PositionDirection::Long => price < u64::MAX && price <= price_cap,
        PositionDirection::Short => price > 0 && price >= price_cap,
    };
    if !quotes_in_bounds {
        return Ok(None);
    }
    let capacity = maker.level_capacity(ctx, side)?;
    Ok((capacity > 0).then_some(DiscreteLevel {
        maker_id,
        price,
        is_prio: maker.is_prio(),
        capacity,
    }))
}

/// Split the marginal `residual` across a price-tied `group`: priority makers
/// take their full capacity first, then the remainder is pro-rata by capacity
/// across non-priority makers (the last non-priority maker absorbs the
/// rounding remainder so no base is lost). Writes into `per_maker_base`.
fn distribute_marginal(
    group: &[DiscreteLevel],
    residual: u64,
    per_maker_base: &mut [u64],
) -> DriftResult<()> {
    let mut remaining = residual;

    // Phase 1: priority makers take their full capacity first.
    for lvl in group {
        if remaining == 0 {
            break;
        }
        if !lvl.is_prio {
            continue;
        }
        let take = lvl.capacity.min(remaining);
        if take > 0 {
            per_maker_base[lvl.maker_id as usize] =
                per_maker_base[lvl.maker_id as usize].safe_add(take)?;
            remaining = remaining.safe_sub(take)?;
        }
    }

    // Phase 2: pro-rata across non-priority makers by capacity.
    if remaining > 0 {
        let mut non_prio_total: u64 = 0;
        for lvl in group {
            if !lvl.is_prio {
                non_prio_total = non_prio_total.safe_add(lvl.capacity)?;
            }
        }
        if non_prio_total > 0 {
            let last_non_prio = group.iter().rposition(|lvl| !lvl.is_prio);
            let mut distributed: u64 = 0;
            for (gi, lvl) in group.iter().enumerate() {
                if lvl.is_prio {
                    continue;
                }
                let take = if Some(gi) == last_non_prio {
                    // Last non-priority maker absorbs the rounding remainder.
                    remaining.safe_sub(distributed)?
                } else {
                    (remaining as u128)
                        .safe_mul(lvl.capacity as u128)?
                        .safe_div(non_prio_total as u128)? as u64
                };
                if take > 0 {
                    per_maker_base[lvl.maker_id as usize] =
                        per_maker_base[lvl.maker_id as usize].safe_add(take)?;
                    distributed = distributed.safe_add(take)?;
                }
            }
        }
    }
    Ok(())
}

/// Build the [`Match`] from per-maker base allocations: recompute each winning
/// maker's quote ONCE against its total filled base via `try_fill_solo`, then
/// `commit_fill`. Computing quote once (not per slice) keeps the reported
/// `quote_filled` equal to what the maker's `commit_fill` actually moved — for
/// the JIT vAMM this matters because its underlying swap is non-linear, so a
/// sum of per-slice quotes would over-estimate.
fn commit_fills(
    makers: &mut [&mut dyn QuoterCommit],
    ctx: &QuoteContext,
    side: PositionDirection,
    per_maker_base: &[u64],
    clearing_price: Option<u64>,
) -> DriftResult<Match> {
    let mut result = Match::empty();
    result.clearing_price = clearing_price;

    for (idx, (maker, &base)) in makers.iter_mut().zip(per_maker_base).enumerate() {
        if base == 0 {
            continue;
        }
        let solo = maker
            .try_fill_solo(ctx, side, base)?
            .ok_or(ErrorCode::DefaultError)?;
        let fill = QuoterFill {
            side,
            base_filled: base,
            quote_filled: solo.quote_filled,
            clearing_price: clearing_price.unwrap_or(solo.clearing_price),
            refresh_cost: solo.refresh_cost,
            is_fee_exempt: maker.is_fee_exempt(),
            fee_policy: maker.fee_policy(),
            quote_asset_amount_surplus: solo.quote_asset_amount_surplus,
        };
        maker.commit_fill(ctx, &fill)?;
        result.total_refresh_cost = result.total_refresh_cost.safe_add(fill.refresh_cost)?;
        result.total_base_filled = result.total_base_filled.safe_add(base)?;
        result.total_quote_filled = result.total_quote_filled.safe_add(fill.quote_filled)?;
        result.fills.push((idx as QuoterId, fill));
    }

    Ok(result)
}

/// Drop-in fill helper for the "AMM is the sole counterparty" case: wraps the
/// market's AMM in an `AmmQuoter` and runs [`fill_amm_only`]. Returns the
/// `Match` so callers can read out `total_base_filled`, `total_quote_filled`,
/// and per-fill metadata (`QuoterFill::is_fee_exempt`, `refresh_cost`).
///
/// The AMM-side post-fill bookkeeping (curve reserves, net counterparty
/// position, and the cached ask/bid spread-reserve refresh) all happen inside
/// `AmmQuoter::commit_fill`. This helper doesn't touch the user's side — taker
/// position updates and fee accumulation depend on `&mut User`, which the
/// surrounding fill controller handles after this function returns.
pub fn fill_perp_market_against_amm(
    perp_market: &mut crate::state::perp_market::PerpMarket,
    ctx: &QuoteContext,
    side: PositionDirection,
    target_size: u64,
) -> DriftResult<Match> {
    let mut amm_quoter = AmmQuoter::for_amm(&mut perp_market.amm);
    fill_amm_only(&mut amm_quoter, ctx, side, target_size, None)
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

        fn level_capacity(&self, _ctx: &QuoteContext, side: PositionDirection) -> DriftResult<u64> {
            Ok(if side == self.side { self.remaining } else { 0 })
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
        // wrapper around match_take for the sole-AMM case. Verifies one call
        // mutates AMM curve reserves and re-derives the cached spread reserves
        // (via AmmQuoter::commit_fill) while leaving MarketStats untouched.
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
        // AMM curve reserves mutated.
        assert!(perp_market.amm.base_asset_reserve < starting_reserve);
        // Cached spread reserves re-derived post-fill by commit_fill: with the
        // seeded zero spread they track the (new) curve reserves.
        assert_eq!(
            perp_market.amm.ask_base_asset_reserve,
            perp_market.amm.base_asset_reserve
        );
        // MarketStats untouched by the fill.
        assert_eq!(perp_market.market_stats.volume_24h, 7777);
    }

    #[test]
    fn end_to_end_match_take_against_amm() {
        // Full architecture exercised: construct a PerpMarket, wrap its AMM
        // as a Quoter, run match_take. Verify the AMM curve mutated and the
        // MarketStats fields are left untouched by the fill.
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

        let result = {
            let mut amm_maker = AmmQuoter::new_no_spread(&mut perp_market.amm);
            fill_amm_only(
                &mut amm_maker,
                &ctx,
                PositionDirection::Long,
                AMM_RESERVE_PRECISION as u64,
                None,
            )
            .unwrap()
        };

        assert!(result.is_complete());
        // AMM curve reserves mutated by commit_fill...
        assert!(perp_market.amm.base_asset_reserve < starting_reserve);
        // ...and the cached spread reserves were re-derived to track them.
        assert_eq!(
            perp_market.amm.ask_base_asset_reserve,
            perp_market.amm.base_asset_reserve
        );

        // MarketStats fields are owned by the stats-update paths, not the
        // fill — the match leaves them as initialized.
        assert_eq!(perp_market.market_stats.last_mark_price_twap, 99_500_000);
        assert_eq!(perp_market.market_stats.volume_24h, 1_000_000);
    }

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
            let result = fill_amm_only(
                &mut amm_maker,
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
