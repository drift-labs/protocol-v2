# AMM Decoupling and Maker Interface

## Implementation status (resumption guide for in-flight work)

**Branch:** `feat/decouple-amm`. Single-PR refactor; not incremental.

**Current state — 832 unit tests pass, fmt + clippy clean.** `cargo test -p drift --lib` is green. The big architectural pieces are landed; remaining work is the fill-path refactor (Task 10), boundary tightening (Task 12), and SDK/IDL/TS catch-up (Task 13-15).

### Done

**Maker trait + matcher (state/maker.rs, controller/match.rs):**
- `Maker` + `MakerCommit` traits with full doc comments. `QuoteContext { stats: &MarketStats, oracle, fee_budget, tick, slot, base_precision }`. `MakerFill { side, base_filled, quote_filled, clearing_price, refresh_cost, is_fee_exempt, quote_asset_amount_surplus }`.
- Single quote method: `try_fill_solo`. The earlier `quote_for_size` was collapsed in — both AmmMaker variants called the same `calculate_base_swap_output_with_spread`, so the duplication was removed. Each maker fills at its OWN price (standard CLOB), not uniform-price-at-clearing.
- Three impls:
  - `DlobOrderMaker<'a>` — single resting `Order`; transparently handles both resting DLOB orders and in-auction JIT participants via `Order::get_limit_price`. No separate `JitParticipantMaker` needed.
  - `AmmMaker<'a>` — natural-curve quoting via `calculate_base_swap_output_with_spread`. `is_prio=true`, `is_fee_exempt=true`. `cumulative_size` uses the analytical inverse `math::amm_spread::calculate_base_asset_amount_to_trade_to_price`.
  - `AmmJitMaker<'a>` — AMM in JIT-making mode. Construction (`new(amm, jit_price, max_jit_base)`) makes the policy explicit. `best_price = jit_price`, `cumulative_size = min(max_jit_base, curve_max)` at the JIT price. `is_prio=false` — DLOB takes priority. `quote_asset_amount_surplus` captures the gap between `jit_price × base` and the AMM curve's natural quote (negative when AMM subsidises the fill).
- Full matcher (`controller/match.rs`): segment walk by `best_price`, tie groups, `try_fill_solo` shortcut for sole-maker clearing, bisection on `cumulative_size` otherwise, priority-first then pro-rata at the marginal tick. The matcher tracks only base in the segment walk (`SegmentClearing { clearing_price, per_maker: Vec<MakerBaseFill> }`) and computes quote ONCE per winning maker via `try_fill_solo` against its total filled base — avoids sum-of-slices inflation for AMMs. 17+ unit tests covering empty/sole/multi-maker/priority-ties/partial-fills/AMM+DLOB/JIT-with-DLOB scenarios.

**Stats migration (15+ fields fully moved from AMM to MarketStats):**
- mark TWAPs + std (`last_mark_price_twap`, `_5min`, `_ts`, `last_bid_price_twap`, `last_ask_price_twap`, `mark_std`).
- Oracle data (`historical_oracle_data` (48-byte nested struct), `last_oracle_normalised_price`, `last_oracle_valid`, `oracle_std`, `last_oracle_conf_pct`).
- Volume / intensity (`volume_24h`, `long_intensity_volume`, `short_intensity_volume`, `last_trade_ts`).
- MM oracle snapshot (`mm_oracle_price`, `mm_oracle_slot`, `mm_oracle_sequence_id`).
- Writer pattern: 4 methods on `MarketStats` (`update_mark_std`, `update_oracle_std`, `update_oracle_conf_pct`, `update_volume_24h`). `&mut MarketStats` threaded through `update_mark_twap*` / `update_oracle_price_twap`. `calculate_new_oracle_price_twap` takes `&MarketStats`; `estimate_best_bid_ask_price` + `calculate_oracle_twap_5min_price_spread_pct` take `&HistoricalOracleData`. Native handler `handle_update_mm_oracle_native` writes via byte offsets into MarketStats (offsets verified by `state/traits/tests.rs::amm_zero_copy_offsets`).
- Mirror function deleted entirely (was no-op once all writers moved). `controller/market_stats.rs` is now a doc-only module marking the future home for matcher-fed market-stat plumbing.
- Production readers all migrated; AMM-internal methods that read these fields (`get_fallback_price`, `last_ask_premium`, `last_bid_discount`) now take `&MarketStats`.

**AMM struct cleanup (Task 3 aggressive, landed):**
- 18 dead stats fields deleted from AMM.
- `PerpMarket::SIZE`: 1368 → **1192**. AMM size: 880 → **704**. `MARKET_INDEX_OFFSET`: 1112 → **936**.
- Native handler byte offsets recomputed: `mm_oracle_price` 1096, `mm_oracle_slot` 1104, `mm_oracle_sequence_id` 1112, `amm_spread_adjustment` 704. Regression test updated.
- 21 base64 PerpMarket snapshots regenerated via byte surgery (excise dead-field ranges, copy values into corresponding MarketStats positions, zero-extend to new SIZE).
- Sync helpers + auto-mirror test hook deleted; nothing left to mirror.

**Other infra:**
- `controller/perp_pools.rs`: hosts `update_pool_balances`, `update_pnl_pool_and_user_balance`, `calculate_revenue_pool_transfer` (moved out of `controller/amm.rs`).
- `math/perp_market.rs`: hosts `calculate_perp_market_amm_summary_stats` (moved out of `controller/amm.rs`).
- `controller::matching::apply_match_to_perp_market` — post-match wrapper. v1 scope: refreshes AMM spread reserves when AMM was a counterparty (detected via any `MakerFill::is_fee_exempt=true`). Future scope (Task 10's residual): position counters, fee accumulation per maker's `is_fee_exempt`, social loss.
- `controller::matching::fill_perp_market_against_amm` — sole-AMM fill helper. Drop-in replacement for legacy `swap_base_asset` + manual bookkeeping. Used by `controller/position.rs::update_position_with_base_asset_amount` — **no production `swap_base_asset` callers remain** (only the parity test).
- Tuple-return cleanup: `calculate_base_swap_output_with_spread` returns `AmmSwapOutput { new_base_asset_reserve, new_quote_asset_reserve, quote_asset_amount, quote_asset_amount_surplus }`; matcher helpers return `SegmentClearing` + `MakerBaseFill`. No `DriftResult<(_, _, _)>` in branch-authored code.

### Soft spots (deferred)

- **AmmMaker repeg / k-update folding.** Not folded into the quoting formula yet — v1 assumes no pending repeg. `try_fill_solo` reflects current reserves only. Folding the conditional branches in is its own piece of work.
- **`refresh_cost` plumbing.** `try_fill_solo` sets `MakerFill::refresh_cost`; the multi-maker path through `apply_clearing` doesn't surface it. Sole-maker is the only path used in production today, so this is dormant. Revisit when wiring multi-maker AMM scenarios.
- **Matcher uses `Vec` for per-match scratch.** For CU budget, `SmallVec<[T; 4]>` would be better for the common case. Optimise after profiling.

### What's next (in execution order)

1. **Task 10 fulfill_perp_order migration.** Replace `math::amm_jit::calculate_amm_jit_liquidity + controller::orders::fulfill_perp_order_with_amm(jit_amount)` with `match_take([DlobOrderMaker, AmmJitMaker::new(amm, maker_price, jit_amount)])`. The matcher owns AMM-side reserve mutation via `AmmJitMaker::commit_fill`. The outer `fulfill_perp_order_with_match` keeps taker-side updates (margin, fees, social loss, builder referrals) driven off `Match.fills`. **Multi-session work** — `fulfill_perp_order_with_amm` is 420 lines tangled with margin/fee accounting; needs careful unraveling.
2. **AMM struct split into `AmmQuoteState` + `AmmBookkeeping`.** Not yet started. `AMM { quote: AmmQuoteState, books: AmmBookkeeping }` shape per the design below. AMM-side fee field split (`total_fee`, `total_fee_minus_distributions`, `net_revenue_since_last_funding`) — protocol portion → PerpMarket fields, AMM portion stays in `AmmBookkeeping`. **Behavioural change**, not just a move. Defer the placeholder types — define `AmmQuoteState` / `AmmBookkeeping` when the split actually happens.
3. **Move AMM-stays fields per design.** Position counters, protocol fees (split half), funding state, oracle identity, order parameters move from AMM to PerpMarket. ~1,605 reach-through `market.amm.X` accesses to mass-substitute.
4. **Move AMM to the tail of PerpMarket.** Forces future excision to be a clean truncate.
5. **Task 12 — `pub(in crate::state::amm)` boundary.** Move AMM into its own `state::amm` module, tighten field visibility. Compile error wherever there's still a `market.amm.X` reach-through is the migration checklist.
6. **Task 13 — IDL regen + SDK migration** (`sdk/src/idl/drift.{json,ts}`, `sdk/src/user.ts`, `sdk/src/math/*`, `sdk/src/decode/user.ts`). Wait until layout stabilises.
7. **Task 14 — TypeScript integration tests** (`tests/*.ts`).
8. **Task 15 — Final verification:** `cargo fmt && cargo clippy -p drift && cargo test -p drift && bash test-scripts/run-anchor-tests.sh`, SDK lint/test, CU benchmarks within ~10% of baseline, litmus greps return zero.

**Post-merge (NOT part of PR):** devnet wipe-and-reinit per CLAUDE.md runbook.

**Pointers:**
- Plan file (more granular, includes execution strategy + sub-agent parallelization plan): `/Users/noahprince/.claude/plans/how-much-of-what-twinkly-pillow.md`.
- Task list IDs 1-15 via TaskCreate. Tasks 1, 2, 4, 6, 7, 8, 9, 11 completed. Tasks 3 and 10 in_progress. Tasks 5, 12, 13, 14, 15 pending.

## Why

`PerpMarket.amm: AMM` started as one struct holding the vAMM's state and over time absorbed everything adjacent to it: position counters, fee accounting, funding cumulatives, oracle metadata, order parameters. The result: ~80 fields, ~2,272 `.amm.` accesses across the program, ~1,605 of them outside AMM-dedicated modules. Insurance, liquidation, settlement, margin, funding, and admin code all reach into `perp_market.amm.X` for state that has nothing to do with AMM mechanics.

This blocks two things:

1. **Replacing the vAMM, or running it alongside other makers.** Today the vAMM is the only liquidity source `controller/orders.rs` and `controller/amm_jit.rs` know how to talk to. The matching logic is hard-coded for AMM-vs-DLOB-order pairs. Adding a Phoenix-style parametric quoter, or running multiple AMMs on the same market, requires an entirely new code path.

2. **Eventually extracting the AMM into its own on-chain program.** Every reader currently assumes `AMM` is inline in the perp market account. Moving it to a separate account / program means rewriting every one of those readers.

This refactor fixes both. After it lands:

- `PerpMarket` is self-sufficient: every consumer outside the AMM module reads and writes `PerpMarket` fields directly. No code outside `state/amm.rs` references AMM internals.
- The AMM is one `Maker` implementation. DLOB resting orders are another. JIT auction participants are a third. A real matcher in `controller/match.rs` walks them via the trait.
- The AMM struct is split into two explicit sub-structs (`AmmQuoteState` — the small fast-mutating part; `AmmBookkeeping` — the accounting layer) so the future excision is a clean cut along an existing line.
- The `amm` field is the last field of `PerpMarket`, so excising it later doesn't disturb any other field offset.

## Long-term architecture

The future system is a shared orderbook that takes liquidity from `n` interchangeable makers — the vAMM, DLOB resting orders, JIT auction participants, and whatever else we add later (parametric curve quoters, cross-program makers via CPI, etc.). Each maker is two things:

1. **Some bytes of internal state.** Opaque to everyone outside the maker. The vAMM's bytes are reserves, peg, sqrt_k, spreads, AMM-private oracle snapshots, inventory. A DLOB-order maker's bytes are the resting `Order`. A future maker decides for itself what to store.

2. **A quoting formula plus a fill-effect formula.** Both are pure functions of `(self.bytes, ctx)`. The quoting formula computes `best_price` and `cumulative_size`; the fill-effect formula (`commit_fill`) defines how the maker's bytes change when a fill lands. `ctx` carries the inputs the matcher shares across all makers — `MarketStats`, oracle data, available fee budget, tick size.

The matcher walks makers via this uniform interface and computes the optimal blended fill. Settlement happens via per-maker `commit_fill` after the matcher decides who won which slice.

Eventually the vAMM lives in its own program. The orderbook program holds `AmmQuoteState` (or equivalent) next to whatever other makers' quote-state structs it tracks. The AMM program holds `AmmBookkeeping`. The orderbook emits fill deltas the AMM program consumes to update its books. This refactor lays the groundwork by structuring AMM state along that line *today*, even though everything still lives in one program.

## Field partition

The bright line: **PerpMarket should not know whether a trade was filled by the AMM, a DLOB maker, or a JIT participant.** Anything tagged specifically to "this came from the AMM" is AMM-internal. Anything that aggregates across all fills is protocol-level.

### Moves from AMM → PerpMarket

**Position / open-interest counters** (aggregates across all positions, not specific to AMM as counterparty):

`base_asset_amount_long`, `base_asset_amount_short`, `quote_asset_amount`, `quote_entry_amount_long`, `quote_entry_amount_short`, `quote_break_even_amount_long`, `quote_break_even_amount_short`, `total_social_loss`, `max_open_interest`.

`base_asset_amount_with_amm` **does not move** — that's the AMM's own net counterparty position, used for inventory-aware quoting. Stays in `AmmQuoteState`. Today's code updates it from `update_position_with_base_asset_amount` on every position delta, which is correct only because every fill currently has the AMM as counterparty. Post-refactor, only AMM-side fills update it (via `AmmMakerMut::commit_fill`); DLOB-DLOB matches don't, and shouldn't.

**Protocol fees** (collected on every fill regardless of maker):

`total_exchange_fee` (taker fees), `total_liquidation_fee` (goes to insurance fund / protocol).

The AMM's own books — `total_fee`, `total_mm_fee`, `total_fee_minus_distributions`, `total_fee_withdrawn`, `net_revenue_since_last_funding`, `fee_pool` — stay in `AmmBookkeeping`. The AMM is essentially a self-contained market maker with its own P&L accounting and token vault. The protocol learns about AMM revenue through explicit, AMM-side instructions (admin withdrawal to revenue pool), never by reaching into AMM bytes.

**Behavioral change to be explicit about.** Today some of these "AMM" fee fields are written on *every* fill — including DLOB-DLOB matches where the AMM was not a counterparty. Specifically `total_fee` and `total_fee_minus_distributions` are touched from both `fulfill_perp_order_with_amm` (AMM-side) and `fulfill_perp_order_with_match` (DLOB-side) in `controller/orders.rs`. That's an artifact of the AMM-centric current architecture, where "AMM fields" doubled as "protocol fields" because the AMM was the only counterparty model.

Post-refactor, the rule is: **the AMM's books are touched only by `AmmMakerMut::commit_fill`** — that is, only when the AMM filled a slice of the take. Protocol-level fees (taker fees collected on every trade) go to `PerpMarket.total_exchange_fee`. The AMM-specific portion (its earned spread + the portion of the fee pool it manages) stays in `AmmBookkeeping`. Where today's code conflates the two under a single name like `total_fee`, the refactor splits it into a PerpMarket field for the protocol portion and an AMM field for the AMM portion.

Concretely, the split:

- `PerpMarket.total_exchange_fee` (u128) — already protocol-only today; just moves out of AMM.
- `PerpMarket.total_liquidation_fee` (u128) — already protocol-only; moves out of AMM.
- `PerpMarket.total_protocol_fee_minus_distributions` (i128) — new field, captures today's "fee minus distributions" accumulator written from non-AMM paths. The AMM-side equivalent (its own fee-minus-distributions for repeg budget) stays as `AmmBookkeeping.total_fee_minus_distributions`.
- `PerpMarket.net_revenue_since_last_funding` (i64) — protocol-level rolling revenue window. The AMM has its own `AmmBookkeeping.net_revenue_since_last_funding` for `has_too_much_drawdown` (AMM-internal drawdown check); the matcher / fill controller writes to PerpMarket's version on every fill.
- `AmmBookkeeping.total_fee` (i128) — only AMM-side fills increment this. Same for `total_mm_fee`, `total_fee_minus_distributions`, `total_fee_withdrawn`, `net_revenue_since_last_funding`, `fee_pool`.

The split is mechanical at the write sites: `fulfill_perp_order_with_amm`'s writes go to AMM via `commit_fill`; `fulfill_perp_order_with_match`'s writes go to PerpMarket fields directly (post-matcher, via the fill controller).

**Funding state** (protocol-wide; applies to all positions):

`cumulative_funding_rate_long`, `cumulative_funding_rate_short`, `last_funding_rate`, `last_funding_rate_long`, `last_funding_rate_short`, `last_24h_avg_funding_rate`, `last_funding_rate_ts`, `funding_period`, `net_unsettled_funding_pnl`, `last_funding_oracle_twap`.

**Oracle identity (config — set at market creation, not updated per-fill):**

`oracle: Pubkey`, `oracle_source: OracleSource`, `oracle_slot_delay_override`, `oracle_low_risk_slot_delay_override`.

Note: oracle *data* (`historical_oracle_data`, `last_oracle_normalised_price`, `last_oracle_valid`) is fresh market state and belongs in `MarketStats`, not here — see the MarketStats partition below. Only oracle identity/config lives on PerpMarket.

**Order parameters:**

`order_step_size`, `order_tick_size`, `min_order_size`.

### Moves from PerpMarket → AMM (`AmmBookkeeping`)

DLP fee-routing config: `lp_pool_id`, `lp_fee_transfer_scalar`, `lp_exchange_fee_excluscion_scalar`. These configure how AMM-side revenue routes to the DLP. Currently on PerpMarket; they're AMM-fee-allocation policy that belongs with the AMM's books. `lp_status` and `lp_paused_operations` stay on PerpMarket — those are market-level operational gates.

### Introduces `PerpMarket.market_stats: MarketStats`

A new sub-struct on PerpMarket holding historic market data that any quoter would want:

```rust
pub struct MarketStats {
    // Mark TWAPs and std
    pub last_mark_price_twap: u64,
    pub last_mark_price_twap_5min: u64,
    pub last_mark_price_twap_ts: i64,
    pub last_bid_price_twap: u64,
    pub last_ask_price_twap: u64,
    pub mark_std: u64,
    // Oracle data (moves from AMM)
    pub historical_oracle_data: HistoricalOracleData,
    pub last_oracle_normalised_price: i64,
    pub last_oracle_valid: bool,
    pub oracle_std: u64,
    pub last_oracle_conf_pct: u64,
    // Volume / intensity / activity
    pub volume_24h: u64,
    pub long_intensity_volume: u64,
    pub short_intensity_volume: u64,
    pub last_trade_ts: i64,
    // MM oracle snapshot (native handler target)
    pub mm_oracle_price: i64,
    pub mm_oracle_slot: u64,
    pub mm_oracle_sequence_id: u64,
    pub padding: [u8; N],
}
```

**Update-cadence rule.** A field belongs in `MarketStats` if it must update on every market fill — vAMM fill, DLOB fill, JIT fill, future maker fill. The matcher writes to `MarketStats` via `controller/market_stats.rs` from each fill path. The AMM reads `&MarketStats` as input but does not write to it. This is the architectural lever that makes the vAMM safe to call rarely in the future world: anything that needs updating on every market event is no longer the AMM's job.

The mm-oracle native handler (`handle_update_mm_oracle_native`) targets `mm_oracle_*` fields, which now live in `MarketStats`. Native-handler offsets get recomputed.

### Stays in AMM (`AmmQuoteState`)

Reserves and curve: `base_asset_reserve`, `quote_asset_reserve`, `sqrt_k`, `peg_multiplier`, `concentration_coef`, `min_base_asset_reserve`, `max_base_asset_reserve`, `terminal_quote_asset_reserve`, `ask_base_asset_reserve`, `ask_quote_asset_reserve`, `bid_base_asset_reserve`, `bid_quote_asset_reserve`.

Spread and behavior: `base_spread`, `max_spread`, `long_spread`, `short_spread`, `amm_spread_adjustment`, `amm_inventory_spread_adjustment`, `amm_jit_intensity`, `curve_update_intensity`, `reference_price_offset`, `reference_price_offset_deadband_pct`.

AMM's own counterparty position (for inventory-aware quoting): `base_asset_amount_with_amm`.

AMM-private oracle snapshots: `last_oracle_reserve_price_spread_pct`, `last_update_slot`. These are AMM-specific (depend on AMM-specific reserves) — stale-tolerant, updated when the AMM is touched. (`last_oracle_normalised_price` is NOT AMM-private despite its current location; it's the canonical sanitised oracle reading any quoter would want, so it moves to `MarketStats`.)

### Stays in AMM (`AmmBookkeeping`)

`fee_pool: PoolBalance`, `total_fee`, `total_mm_fee`, `total_fee_minus_distributions`, `total_fee_withdrawn`, `net_revenue_since_last_funding`, and the DLP routing config moved in from PerpMarket.

The AMM's bookkeeping is never read by the matcher to produce a quote. `total_fee_minus_distributions` feeds repeg budgets via `ctx.fee_budget` — but that's a scalar the *fill controller* reads off bookkeeping and passes in. The AMM does not read its own books to quote.

### Dead-LP padding — reclaimed

User-direct vAMM-LP was removed in earlier commits (`e1e22230bf`, `e1c92f5789`, `7435cddb38`). Seven AMM padding fields and three `PerpPosition` padding fields remain as dead bytes. Since devnet uses wipe-and-reinit, this padding is removed outright instead of preserved.

## The `Maker` interface

A new module `state/maker.rs` defines the trait every liquidity source implements. The module-level doc comment carries the future architectural narrative; the trait-level doc carries the matching-algorithm spec.

```rust
pub struct QuoteContext<'a> {
    pub stats: &'a MarketStats,
    pub oracle: &'a OraclePriceData,
    pub fee_budget: u64,
    pub tick: u64,
}

pub struct MakerFill {
    pub side: Side,
    pub base_filled: u64,
    pub quote_filled: u64,
    pub clearing_price: u64,
    pub refresh_cost: u64,
}

pub trait Maker {
    fn best_price(&self, ctx: &QuoteContext, side: Side) -> DriftResult<u64>;

    fn cumulative_size(
        &self,
        ctx: &QuoteContext,
        side: Side,
        price: u64,
    ) -> DriftResult<u64>;

    fn is_prio(&self) -> bool { false }
    fn is_fee_exempt(&self) -> bool { false }

    fn try_fill_solo(
        &self,
        ctx: &QuoteContext,
        side: Side,
        target_size: u64,
    ) -> DriftResult<Option<MakerFill>> {
        Ok(None)
    }
}

pub trait MakerCommit: Maker {
    fn commit_fill(&mut self, ctx: &QuoteContext, fill: &MakerFill) -> DriftResult<()>;
}
```

Quote methods are pure functions of `(self, ctx)`. `commit_fill` is the only mutation hook. The maker is the sole authority on how its bytes change; the matcher just hands it the fill it won.

**`is_prio` semantics.** Priority makers take their full marginal size at the clearing tick before pro-rata distributes the remainder to non-priority makers. Priority does *not* override price priority — a better `best_price` still wins regardless of `is_prio`. The vAMM is prio; DLOB orders and JIT participants are not. This preserves "vAMM front-runs DLOB at same price" without requiring matcher special cases.

**`is_fee_exempt` semantics.** Fee-exempt makers don't pay/receive maker fees. The vAMM is exempt — it earns from spread, not from rebates. DLOB-order and JIT-participant makers follow the standard maker-fee schedule. The fill controller checks this per maker when applying fees from a `Match`.

**`try_fill_solo`** is an optional shortcut for the sole-maker-in-clearing-segment case. The matcher uses it when exactly one maker is active in the clearing segment AND it returns `Some` — skipping bisection. Implementations with closed-form inverses of `cumulative_size` (AMMs) implement it; piecewise/discrete liquidity (DLOB orders) can implement it trivially too. `None` is always safe.

## Matching algorithm

The matcher in `controller/match.rs` runs this algorithm. Quoted from the design discussion:

```text
match_take(makers, ctx, side, T):
    sort makers by best_price(ctx, side) ascending
    active = []
    cumulative = 0
    last_p = -infinity
    fills = {m: 0 for m in makers}

    for mm in makers (sorted):
        p_event = mm.best_price(ctx, side)

        if active:
            seg_cap = Σ over j in active of
                      cumulative_size(ctx, side, p_event) -
                      cumulative_size(ctx, side, last_p)

            if cumulative + seg_cap >= T:
                # clearing inside [last_p, p_event]
                if |active| == 1 and active[0].try_fill_solo(...) returns Some(f):
                    fills[active[0]] += f
                else:
                    p_star = bisect_for_clearing(last_p, p_event,
                                                 T - cumulative, active)
                    apply_clearing(p_star, last_p, T - cumulative, active, fills)
                return fills, p_star

            cumulative += seg_cap
            for j in active:
                fills[j] += cumulative_size(ctx, side, p_event) -
                            cumulative_size(ctx, side, last_p)

        active.append(mm)
        last_p = p_event

    # Tail segment [last_p, +infinity)
    if cumulative < T:
        repeat segment logic with hi = +infinity
        else: partial fill, p_star = None

bisect_for_clearing(p_low, p_high, demand_remaining, active):
    lo, hi = p_low, p_high
    while hi - lo > ctx.tick:
        mid = midpoint on tick grid between lo and hi
        supply_to_mid = Σ over j in active of
                        cumulative_size(ctx, side, mid) -
                        cumulative_size(ctx, side, p_low)
        if supply_to_mid >= demand_remaining:
            hi = mid
        else:
            lo = mid
    return hi   # smallest tick where supply >= demand

apply_clearing(p_star, p_seg, demand_remaining, active, fills):
    # inframarginal: every active maker fully fills up to p_star - tick
    inframarginal_total = 0
    for j in active:
        inf = cumulative_size(ctx, side, p_star - ctx.tick) -
              cumulative_size(ctx, side, p_seg)
        fills[j] += inf
        inframarginal_total += inf

    # residual at the marginal tick
    residual = demand_remaining - inframarginal_total

    # marginal supply per maker at p_star
    marginal = {j: cumulative_size(ctx, side, p_star) -
                   cumulative_size(ctx, side, p_star - ctx.tick)
                for j in active}

    # priority makers fill first
    prio = [j for j in active if j.is_prio()]
    non_prio = [j for j in active if !j.is_prio()]

    for j in prio:
        take = min(marginal[j], residual)
        fills[j] += take
        residual -= take
        if residual == 0: break

    # then pro-rata across non-priority makers by their marginal supply
    if residual > 0 and non_prio:
        total_non_prio_marginal = sum(marginal[j] for j in non_prio)
        for j in non_prio:
            fills[j] += residual * marginal[j] / total_non_prio_marginal
```

Properties:
- Each maker that doesn't compete (its `best_price` is worse than the clearing price) costs exactly one `best_price` query.
- Each maker active in a fully-consumed segment costs two `cumulative_size` queries (segment endpoints).
- The clearing segment costs ~log queries per active maker for bisection plus two for marginal sizes — *unless* it's a single-maker clearing segment with `try_fill_solo`, in which case the matcher takes the analytical result.
- No tick-walking. Maker piecewise structure (DLOB level steps, AMM curves) stays inside the maker.

### AMM-side details

The AMM's `Maker` impl reads only from `AmmQuoteState` and `ctx`. Repeg and k-update are folded into the quoting formula as conditional branches: if the trigger fires against `(quote, ctx.stats, ctx.oracle, ctx.fee_budget)` AND budget covers it, prices reflect the post-update curve; otherwise the current curve. The decision is deterministic in inputs, so bisection sees a consistent answer across many `cumulative_size` calls.

`commit_fill` re-evaluates the same triggers (same inputs → same conclusions), applies repeg/k-update to `quote`, applies the fill amounts to `quote` (reserves change, `base_asset_amount_with_amm` changes), and applies bookkeeping deltas to `books` (fee accounting via a private `apply_fill_to_books` helper). It reports `refresh_cost` via `MakerFill` so the fill controller can deduct it from `AmmBookkeeping.total_fee_minus_distributions` (via the AMM module's own bookkeeping helper, not by the fill controller reaching into AMM bytes).

If no fill lands on the AMM in a given match, no bytes change. The "what would have repegged" is purely a quote-time computation; only realized fills cause state mutation.

### Snapshot consistency

Quote methods (`best_price`, `cumulative_size`, `try_fill_solo`) must be pure functions of `(self, ctx)`. The matcher calls `cumulative_size` many times per maker during bisection; if the answers diverge across calls (with the same `ctx`), bisection breaks. No mutation, no global side effects, no clock reads not already in `ctx`.

`commit_fill` is the only place state changes. The matcher does not mutate maker state during the segment walk — settlement happens after the match resolves.

## Fill paths after the refactor

Every existing AMM call site goes through `match_take`:

- **Pure AMM fill** — no DLOB / JIT liquidity. `match_take(&mut [&mut amm_maker], ctx, side, T)`. Sole-maker case; matcher uses AMM's `try_fill_solo`, no bisection.
- **AMM JIT (vAMM front-running a DLOB cross)** — `match_take(&mut [&mut amm_maker, &mut dlob_maker], ctx, side, T)`. AMM front-runs naturally when its `best_price` is better than the DLOB order. JIT intensity / inventory throttling moves into `AmmMaker::cumulative_size` (the AMM declares how much depth it's willing to offer).
- **JIT auction** — participants get wrapped as `JitParticipantMaker`s; `match_take(&mut [&mut amm_maker, &mut jit_1, &mut jit_2, ...], ctx, side, T)`. "Residual goes to AMM" disappears; it's the matcher walking past JIT prices into the AMM's segment.
- **Settlement / liquidation forced fills** — `match_take(&mut [&mut amm_maker], ctx, side, T)`. Sole-maker case.

After the match, the fill controller applies the aggregate `Match`: position counters on PerpMarket, protocol fees (per each maker's `is_fee_exempt` flag), pnl_pool, social loss, funding state if a funding update is due, `MarketStats` updates via `controller/market_stats.rs`, and `total_refresh_cost` deducted from AMM bookkeeping via the AMM module's helper.

The hard-coded pairwise matching rules in `controller/amm_jit.rs` and the DLOB-fill / JIT-auction logic in `controller/orders.rs` disappear.

## Boundary enforcement

AMM field visibility is `pub(crate)` scoped to `state/amm.rs` and submodules. Trait impls and `commit_fill` helpers live inside that module. External callers reach AMM state only through the `Maker` interface or through AMM-defined methods on `&PerpMarket` for AMM-specific operations that don't fit the trait (admin withdrawals from `fee_pool` to revenue pool, operator-forced repegs).

Post-refactor litmus tests:

- `rg 'perp_market\.amm\.|market\.amm\.' programs/drift/src/` outside `state/amm.rs`, `controller/amm*.rs`, `math/amm*.rs`, `math/cp_curve.rs` returns zero.
- `rg 'PerpMarket' programs/drift/src/state/amm.rs programs/drift/src/controller/amm*.rs programs/drift/src/math/amm*.rs programs/drift/src/math/cp_curve.rs` returns zero matches in function signatures (only `use` imports).
- An external module attempting `market.amm.total_fee` (or any AMM field) is a compile error.

## Out of scope

- **Cross-program `Maker`** (CPI to maker programs in other on-chain programs). For now the trait is in-program Rust polymorphism. The cross-program form would require serialized-curve returns + read-only CPI; design when needed.
- **Tolerance-band pro-rata** (distributing pro-rata across makers whose prices are within ε of each other rather than exactly tied). The matcher ships with strict price priority and pro-rata only at exactly-tied ticks. Tolerance-band is a future policy knob.
- **Cross-program AMM excision itself.** This refactor structures the code along the future split line but keeps everything in `programs/drift`. The actual move to a separate AMM program is a follow-up.
- **Parametric-curve quoters** (Phoenix-style spline liquidity). These will land as additional `Maker` impls without matcher changes.

## File layout after the refactor

```
docs/
  amm-decoupling-and-maker-interface.md      this file
  alignment-and-native-offsets.md            updated offsets

programs/drift/src/
  state/
    perp_market.rs       PerpMarket; market_stats: MarketStats; amm: AMM (tail)
    amm.rs               new: AMM { quote, books }, AmmMaker, AmmMakerMut impls
    market_stats.rs      new: MarketStats struct
    maker.rs             new: Maker trait, QuoteContext, MakerFill, MakerCommit
  controller/
    match.rs             new: matcher
    market_stats.rs      new: writers callable from every fill path
    perp_pools.rs        new: market-level pool accounting (former update_pool_balances)
    amm.rs               AMM-specific controller fns; signatures take only AMM + ctx
    amm_jit.rs           shrinks; hard-coded pairwise rules removed
    orders.rs            DLOB fill / JIT auction logic uses match_take
    funding.rs           reads/writes PerpMarket funding fields (moved)
    pnl.rs               reads PerpMarket position counters (moved)
  math/
    amm.rs               pure AMM math, takes &AMM + ctx
    perp_market.rs       new home for calculate_perp_market_amm_summary_stats
  instructions/
    admin.rs             native handler offsets recomputed
```

## Verification

Before merging:

- `cargo fmt && cargo clippy -p drift` clean.
- `cargo test -p drift` — full unit suite. Particular scrutiny: `size`, `market_index_offset`, `native_instruction_offsets`, matcher property tests, AMM-JIT differential tests.
- `bash test-scripts/run-anchor-tests.sh` — full integration suite.
- `cd sdk && bun run prettify && bun run lint && bun run test:ci && bun run test:dlob`.
- CU benchmarks on representative fills: pure-AMM, AMM-JIT, JIT-auction-with-residual. Each within ~10% of pre-refactor baseline.
- Litmus greps above return zero.

After merging:

- Devnet wipe-and-reinit per the CLAUDE.md runbook. `deploy-scripts/verify-devnet.ts` reports a clean post-init state.
