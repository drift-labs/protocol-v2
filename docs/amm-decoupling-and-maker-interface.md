# AMM Decoupling and Quoter Interface

## Implementation status (resumption guide for in-flight work)

**Branch:** `feat/decouple-amm`. Single-PR refactor; not incremental.

**Current state — 832 unit tests pass, fmt + clippy clean.** `cargo test -p velocity --lib` is green. The big architectural pieces are landed; remaining work is the fill-path refactor (Task 10), boundary tightening (Task 12), and SDK/IDL/TS catch-up (Task 13-15).

### Done

**Quoter trait + fill engine (state/quoter.rs, controller/match.rs):**
- `Quoter` + `QuoterCommit` traits with full doc comments. `QuoteContext` carries `stats`, `oracle`, `mm_oracle`/`oracle_validity` (AMM setup), `fee_budget`, `tick`, `step_size`, `slot`, `base_precision`, `market_status`/`market_config` (AMM). `QuoterFill { side, base_filled, quote_filled, clearing_price, refresh_cost, is_fee_exempt, fee_policy, quote_asset_amount_surplus }`.
- Quote surface: `best_price` (the maker's single price), `level_capacity` (cheap, non-mutating full size at that price), `try_fill_solo` (closed-form fill). Each maker fills at its OWN price (standard CLOB), not uniform-price-at-clearing.
- Three impls:
  - `DlobOrderQuoter<'a>` — single resting `Order`; transparently handles both resting DLOB orders and in-auction JIT participants via `Order::get_limit_price`. Discrete single level.
  - `AmmQuoter<'a>` — the continuous constant-product curve. Matched **solo** via `fill_amm_only`. `is_prio=true`, `is_fee_exempt=true`, `fee_policy=AmmHouse`. Keeps an inherent `cumulative_size` (analytical inverse, `math::spread::calculate_base_asset_amount_to_trade_to_price`) used only to cap a take at the taker's limit — not on the `Quoter` trait.
  - `AmmJitQuoter<'a>` — AMM in JIT-making mode; a **discrete** single-price level. `best_price = jit_price`, `level_capacity = min(max_jit_base, reserve-bounded max)`. `is_prio=true`. `quote_asset_amount_surplus` captures the gap between `jit_price × base` and the AMM curve's natural quote (negative when the AMM subsidises the fill).
- Two-path fill engine (`controller/match.rs`): `fill_amm_only` (sole continuous AMM — analytical `try_fill_solo` capped by `cumulative_size`) and `match_take` (discrete level walk over single-price makers: sort best-first, fill fully-crossed levels, distribute the clearing level priority-first then pro-rata). No bisection, no continuous-curve search. Quote is computed ONCE per winning maker via `try_fill_solo` on its total filled base (avoids sum-of-slices inflation for the JIT AMM). Unit tests cover empty/sole-AMM/discrete-walk/priority-ties/partial-fills/JIT-with-DLOB scenarios.

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
- `PerpMarket::SIZE` is **1208 bytes** (1200 struct + 8 discriminator). AMM retains the cached spread state (long/short spread, reference offset, oracle-reserve spread pct, ask/bid spread reserves, `last_spread_update_slot`), refreshed in place by `math::spread::update_amm_quote_state`.
- Native handler byte offsets pinned by the regression test: `mm_oracle_price` 720, `mm_oracle_slot` 728, `mm_oracle_sequence_id` 736 (MarketStats), `amm_spread_adjustment` 1202 (AMM).
- 21 base64 PerpMarket snapshots regenerated via byte surgery (excise dead-field ranges, copy values into corresponding MarketStats positions, zero-extend to new SIZE).
- Sync helpers + auto-mirror test hook deleted; nothing left to mirror.

**Other infra:**
- `controller/perp_pools.rs`: hosts `update_pool_balances`, `update_pnl_pool_and_user_balance`, `calculate_revenue_pool_transfer` (moved out of `controller/amm.rs`).
- `math/perp_market.rs`: hosts `calculate_perp_market_amm_summary_stats` (moved out of `controller/amm.rs`).
- `controller::matching::fill_perp_market_against_amm` — sole-AMM fill helper wrapping `fill_amm_only`. Drop-in replacement for legacy `swap_base_asset` + manual bookkeeping. The post-fill AMM bookkeeping (reserves, net counterparty position, cached spread-reserve refresh) lives in `AmmQuoter::commit_fill`; no separate post-match wrapper is needed. (The old `apply_match_to_perp_market` was a no-op once the spread cache moved into `commit_fill`, and was deleted.)
- Tuple-return cleanup: `calculate_base_swap_output` returns `AmmSwapOutput { new_base_asset_reserve, new_quote_asset_reserve, quote_asset_amount, quote_asset_amount_surplus }`. No `VelocityResult<(_, _, _)>` in branch-authored code.

### Soft spots (deferred)

- **`refresh_cost` plumbing.** `fill_amm_only` and `match_take`'s commit loop both surface `QuoterFill::refresh_cost` into `Match.total_refresh_cost`. Only the AMM produces a non-zero refresh cost today (repeg / k-update during `setup`); discrete makers report zero.
- **`match_take` uses `Vec` for per-fill scratch (the level list).** For CU budget, `SmallVec<[T; 4]>` would be better for the common (≤2-maker) case. Optimise after profiling.

### What's next (in execution order)

1. **Task 10 fulfill_perp_order migration.** Replace `math::amm_jit::calculate_amm_jit_liquidity + controller::orders::fulfill_perp_order_with_amm(jit_amount)` with `match_take([DlobOrderQuoter, AmmJitQuoter::new(amm, maker_price, jit_amount)])`. The matcher owns AMM-side reserve mutation via `AmmJitQuoter::commit_fill`. The outer `fulfill_perp_order_with_match` keeps taker-side updates (margin, fees, social loss, builder referrals) driven off `Match.fills`. **Multi-session work** — `fulfill_perp_order_with_amm` is 420 lines tangled with margin/fee accounting; needs careful unraveling.
2. **AMM struct split into `AmmQuoteState` + `AmmBookkeeping`.** Not yet started. `AMM { quote: AmmQuoteState, books: AmmBookkeeping }` shape per the design below. AMM-side fee field split (`total_fee`, `total_fee_minus_distributions`, `net_revenue_since_last_funding`) — protocol portion → PerpMarket fields, AMM portion stays in `AmmBookkeeping`. **Behavioural change**, not just a move. Defer the placeholder types — define `AmmQuoteState` / `AmmBookkeeping` when the split actually happens.
3. **Move AMM-stays fields per design.** Position counters, protocol fees (split half), funding state, oracle identity, order parameters move from AMM to PerpMarket. ~1,605 reach-through `market.amm.X` accesses to mass-substitute.
4. **Move AMM to the tail of PerpMarket.** Forces future excision to be a clean truncate.
5. **Task 12 — `pub(in crate::state::amm)` boundary.** Move AMM into its own `state::amm` module, tighten field visibility. Compile error wherever there's still a `market.amm.X` reach-through is the migration checklist.
6. **Task 13 — IDL regen + SDK migration** (`sdk/src/idl/velocity.{json,ts}`, `sdk/src/user.ts`, `sdk/src/math/*`, `sdk/src/decode/user.ts`). Wait until layout stabilises.
7. **Task 14 — TypeScript integration tests** (`tests/*.ts`).
8. **Task 15 — Final verification:** `cargo fmt && cargo clippy -p velocity && cargo test -p velocity && bash test-scripts/run-anchor-tests.sh`, SDK lint/test, CU benchmarks within ~10% of baseline, litmus greps return zero.

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
- The AMM is one `Quoter` implementation. DLOB resting orders are another. JIT auction participants are a third. A real matcher in `controller/match.rs` walks them via the trait.
- The AMM struct is split into two explicit sub-structs (`AmmQuoteState` — the small fast-mutating part; `AmmBookkeeping` — the accounting layer) so the future excision is a clean cut along an existing line.
- The `amm` field is the last field of `PerpMarket`, so excising it later doesn't disturb any other field offset.

## Long-term architecture

The future system is a shared orderbook that takes liquidity from `n` interchangeable makers — the vAMM, DLOB resting orders, JIT auction participants, and whatever else we add later (parametric curve quoters, cross-program makers via CPI, etc.). Each maker is two things:

1. **Some bytes of internal state.** Opaque to everyone outside the maker. The vAMM's bytes are reserves, peg, sqrt_k, spreads, AMM-private oracle snapshots, inventory. A DLOB-order maker's bytes are the resting `Order`. A future maker decides for itself what to store.

2. **A quoting formula plus a fill-effect formula.** Both are pure functions of `(self.bytes, ctx)`. The quoting formula computes `best_price`, `level_capacity`, and the closed-form `try_fill_solo`; the fill-effect formula (`commit_fill`) defines how the maker's bytes change when a fill lands. `ctx` carries the inputs the fill engine shares across all makers — `MarketStats`, oracle data, available fee budget, tick/step size.

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

## The `Quoter` interface

The module `state/quoter.rs` defines the trait every liquidity source implements. The module-level doc comment carries the architectural narrative; the trait-level doc carries the fill-algorithm spec.

```rust
pub struct QuoteContext<'a> {
    pub stats: &'a MarketStats,
    pub oracle: &'a OraclePriceData,
    pub mm_oracle: Option<&'a MMOraclePriceData>,  // AMM setup only
    pub oracle_validity: Option<OracleValidity>,   // AMM setup only
    pub fee_budget: u64,
    pub tick: u64,
    pub step_size: u64,
    pub slot: u64,
    pub base_precision: u64,
    pub market_status: MarketStatus,               // AMM only
    pub market_config: u8,                          // AMM only
}

pub struct QuoterFill {
    pub side: PositionDirection,
    pub base_filled: u64,
    pub quote_filled: u64,
    pub clearing_price: u64,
    pub refresh_cost: u64,
    pub is_fee_exempt: bool,
    pub fee_policy: FillFeePolicy,
    pub quote_asset_amount_surplus: i64,
}

pub trait Quoter {
    fn setup(&mut self, _ctx: &QuoteContext) -> VelocityResult<()> { Ok(()) }

    /// The maker's single quoted price on this side (no-quote sentinel
    /// otherwise: u64::MAX for Long, 0 for Short).
    fn best_price(&self, ctx: &QuoteContext, side: PositionDirection) -> VelocityResult<u64>;

    /// Full fillable base at `best_price`. Cheap and non-mutating — analytic,
    /// never runs the actual fill. The discrete walk sizes each level with it.
    fn level_capacity(&self, ctx: &QuoteContext, side: PositionDirection) -> VelocityResult<u64>;

    fn is_prio(&self) -> bool { false }
    fn is_fee_exempt(&self) -> bool { false }
    fn fee_policy(&self) -> FillFeePolicy { FillFeePolicy::DlobMatch }

    /// Closed-form fill of `target_size` base at this maker's price.
    fn try_fill_solo(
        &self,
        ctx: &QuoteContext,
        side: PositionDirection,
        target_size: u64,
    ) -> VelocityResult<Option<QuoterFill>> {
        Ok(None)
    }
}

pub trait QuoterCommit: Quoter {
    fn commit_fill(&mut self, ctx: &QuoteContext, fill: &QuoterFill) -> VelocityResult<()>;
    fn on_market_event(&mut self, _ctx: &QuoteContext, _event: &MarketEvent) -> VelocityResult<()> { Ok(()) }
}
```

Quote methods are pure functions of `(self, ctx)`. `commit_fill` is the only mutation hook. The maker is the sole authority on how its bytes change; the fill engine just hands it the fill it won.

> **Note on the continuous AMM.** The constant-product vAMM is the one *continuous* maker. It is matched solo via `fill_amm_only` (below), which uses an inherent `AmmQuoter::cumulative_size` (the analytical inverse of its curve) to cap a take at the taker's limit — `cumulative_size` is **not** on the `Quoter` trait, because the discrete level walk never needs it. When the vAMM participates alongside DLOB orders it does so as `AmmJitQuoter`, which quotes a single fixed `jit_price` — i.e. it's discrete, like a DLOB order.

**`level_capacity` semantics.** The full base a maker can fill at its level. It must be cheap and non-mutating: compute it analytically (DLOB: remaining size; JIT vAMM: `min(throttle, reserve-bounded max)`), never by running the swap — probing capacity by swapping the AMM-JIT to its reserve boundary errors.

**`is_prio` semantics.** Priority makers take their full level capacity at the clearing price before pro-rata distributes the remainder to non-priority makers. Priority does *not* override price priority — a better `best_price` still wins regardless of `is_prio`. The JIT vAMM is prio; DLOB orders are not.

**`is_fee_exempt` / `fee_policy` semantics.** Fee-exempt makers don't pay/receive maker fees (the vAMM earns from spread, not rebates). `fee_policy` selects the fill controller's fee path (`AmmHouse` for AMM-side fills, `DlobMatch` for DLOB). Both are copied into each `QuoterFill`.

**`try_fill_solo`** computes a maker's closed-form fill at its price. `fill_amm_only` calls it to fill the whole take; the discrete walk calls it per winning maker on its allocated base. Every `Quoter` in the crate implements it.

## Fill algorithm

`controller/match.rs` has **two explicit fill paths** — there is no general continuous-curve clearing algorithm (no bisection, no price-domain search). The split reflects that the only continuous maker (the constant-product vAMM) is always matched solo; every multi-maker fill is over discrete single-price makers.

### Path 1 — `fill_amm_only` (sole continuous vAMM)

```text
fill_amm_only(amm, ctx, side, T, taker_limit):
    if amm.best_price(side) is no-quote or worse than taker_limit: empty
    cap = amm.cumulative_size(side, taker_limit)   # analytic curve inverse, clamps to the limit
    fill = amm.try_fill_solo(side, min(T, cap))    # closed-form swap
    amm.commit_fill(fill)
    return fill   # clearing_price = None on a partial
```

This is the only path that touches the curve. `cumulative_size` is an inherent `AmmQuoter` method (one call, not a loop) used purely to cap the take at the taker's limit. Byte-exact with the legacy `swap_base_asset`.

### Path 2 — `match_take` (discrete level walk)

```text
match_take(makers, ctx, side, T, taker_limit):
    # Each maker is one level: best_price + level_capacity (cheap, no swap).
    levels = [(id, best_price, is_prio, level_capacity)
              for each maker quoting on side within taker_limit, capacity > 0]
    sort levels best-first (price; prio wins ties)

    cumulative = 0
    for tie_group in levels grouped by equal price:
        group_supply = Σ capacity in tie_group
        if cumulative + group_supply <= T:
            fill each member its full capacity; cumulative += group_supply
            if cumulative == T: clearing_price = group.price; break
        else:
            # clearing level — distribute the residual across the tie group:
            residual = T - cumulative
            prio members take full capacity first;
            non-prio split the rest pro-rata by capacity (last absorbs rounding)
            clearing_price = group.price; break
    # fell through without clearing => partial fill, clearing_price = None

    # commit once per winning maker against its TOTAL allocated base
    for maker with base > 0:
        fill = maker.try_fill_solo(side, base)   # quote computed once, not per slice
        maker.commit_fill(fill)
```

No bisection, no tick-walking, no `cumulative_size`. Quote is computed once per maker on its total base (not summed per slice) so the reported `quote_filled` equals what `commit_fill` actually moved — this matters for the JIT vAMM, whose underlying swap is non-linear.

Cost: one `best_price` + one `level_capacity` per maker, plus one `try_fill_solo` + `commit_fill` per *winning* maker. For the dominant sole-AMM case (`fill_amm_only`) it's a single analytical fill.

### AMM-side details

`fill_amm_only` runs on `AmmQuoter`, whose `Quoter::setup` (called by the orchestrator before the fill) folds the conditional repeg / k-update into the AMM via `project_post_refresh_scalar` and refreshes the cached spread state (`update_amm_quote_state`). `setup` is slot-idempotent — re-running it in the same slot is a no-op on the curve. `commit_fill` applies the swap to the reserves, updates `base_asset_amount_with_amm`, and re-derives the cached ask/bid spread reserves (`refresh_cached_spread_reserves`). It reports `refresh_cost` via `QuoterFill` for the fill controller to apply to PerpMarket.

The JIT vAMM (`AmmJitQuoter`) participates in `match_take` as a discrete level: `best_price = jit_price`, `level_capacity = min(max_jit_base, reserve-bounded max)`. Its `commit_fill` moves reserves per the curve while the taker pays `jit_price`; the gap is `quote_asset_amount_surplus` (negative when the AMM subsidises the fill).

### Snapshot consistency

Quote methods (`best_price`, `level_capacity`, `try_fill_solo`) must be pure functions of `(self, ctx)` — no mutation, no global side effects, no clock reads not already in `ctx`. `commit_fill` is the only place state changes, after the fill resolves.

## Fill paths after the refactor

- **Pure AMM fill** (settlement, liquidation, the keeper/AMM order path) — `fill_amm_only(amm_quoter, ctx, side, T, limit)`. The dominant production case.
- **AMM JIT alongside a DLOB cross** — `match_take(&mut [&mut amm_jit, &mut dlob_quoter], ctx, side, T, limit)`. Both are discrete single-price levels; the walk routes by price (prio JIT vAMM wins ties).
- **DLOB-only** — `match_take` over the DLOB order levels (the AMM-JIT contributes zero when it declines). Today this is the AMM-JIT-declines case; later it's spline levels.
- **Future spline liquidity** — off-chain MMs push compact spline regions; the program materialises them into discrete levels (a `SplineQuoter`) that feed the same `match_take` walk. At that point `fill_amm_only` and the constant-product math are deleted with the vAMM, and the discrete walk is the whole engine.

After the match, the fill controller applies the aggregate `Match`: position counters on PerpMarket, protocol fees (per each maker's `is_fee_exempt` flag), pnl_pool, social loss, funding state if a funding update is due, `MarketStats` updates via `controller/market_stats.rs`, and `total_refresh_cost` deducted from AMM bookkeeping via the AMM module's helper.

The hard-coded pairwise matching rules in `controller/amm_jit.rs` and the DLOB-fill / JIT-auction logic in `controller/orders.rs` disappear.

## Boundary enforcement

AMM field visibility is `pub(crate)` scoped to `state/amm.rs` and submodules. Trait impls and `commit_fill` helpers live inside that module. External callers reach AMM state only through the `Quoter` interface or through AMM-defined methods on `&PerpMarket` for AMM-specific operations that don't fit the trait (admin withdrawals from `fee_pool` to revenue pool, operator-forced repegs).

Post-refactor litmus tests:

- `rg 'perp_market\.amm\.|market\.amm\.' programs/velocity/src/` outside `state/amm.rs`, `controller/amm*.rs`, `math/amm*.rs`, `math/cp_curve.rs` returns zero.
- `rg 'PerpMarket' programs/velocity/src/state/amm.rs programs/velocity/src/controller/amm*.rs programs/velocity/src/math/amm*.rs programs/velocity/src/math/cp_curve.rs` returns zero matches in function signatures (only `use` imports).
- An external module attempting `market.amm.total_fee` (or any AMM field) is a compile error.

## Out of scope

- **Cross-program `Quoter`** (CPI to maker programs in other on-chain programs). For now the trait is in-program Rust polymorphism. The cross-program form would require serialized-curve returns + read-only CPI; design when needed.
- **Tolerance-band pro-rata** (distributing pro-rata across makers whose prices are within ε of each other rather than exactly tied). The matcher ships with strict price priority and pro-rata only at exactly-tied ticks. Tolerance-band is a future policy knob.
- **Cross-program AMM excision itself.** This refactor structures the code along the future split line but keeps everything in `programs/velocity`. The actual move to a separate AMM program is a follow-up.
- **Parametric-curve quoters** (Phoenix-style spline liquidity). These will land as additional `Quoter` impls without matcher changes.

## File layout after the refactor

```
docs/
  amm-decoupling-and-maker-interface.md      this file
  alignment-and-native-offsets.md            updated offsets

programs/velocity/src/
  state/
    perp_market.rs       PerpMarket; market_stats: MarketStats; amm: AMM (tail)
    amm.rs               new: AMM { quote, books }, AmmQuoter, AmmMakerMut impls
    market_stats.rs      new: MarketStats struct
    maker.rs             new: Quoter trait, QuoteContext, QuoterFill, QuoterCommit
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

- `cargo fmt && cargo clippy -p velocity` clean.
- `cargo test -p velocity` — full unit suite. Particular scrutiny: `size`, `market_index_offset`, `native_instruction_offsets`, matcher property tests, AMM-JIT differential tests.
- `bash test-scripts/run-anchor-tests.sh` — full integration suite.
- `cd sdk && bun run prettify && bun run lint && bun run test:ci && bun run test:dlob`.
- CU benchmarks on representative fills: pure-AMM, AMM-JIT, JIT-auction-with-residual. Each within ~10% of pre-refactor baseline.
- Litmus greps above return zero.

After merging:

- Devnet wipe-and-reinit per the CLAUDE.md runbook. `deploy-scripts/verify-devnet.ts` reports a clean post-init state.
