# Handoff: Fulfill-flow unification

You're picking this up mid-refactor. Read this end-to-end before touching code.

## Branch state

Branch `feat/decouple-amm`. All changes in this branch are work-tree only (uncommitted). 832 Rust unit tests + 281 TypeScript integration tests green. Last verified: integration suite `bash test-scripts/run-anchor-tests.sh`.

If anything below disagrees with what `git status` / `cargo test -p drift --lib` shows, the code is the source of truth.

## What's already landed in this branch

The AMM-decoupling refactor has been done in stages by prior sessions. This is the cumulative state, not just the most recent session's work:

- **Field migration**: ~80 fields moved off `AMM` onto `PerpMarket` directly (position counters, funding, oracle id, order step/tick) or onto `PerpMarket.market_stats: MarketStats` (mark/oracle TWAPs, vol, intensity, mm-oracle snapshot, `historical_oracle_data`). `AMM` keeps only AMM-internal state (reserves, peg, k, fee_pool, spread params).
- **AMM cache removed**: `long_spread`, `short_spread`, `reference_price_offset`, `last_oracle_reserve_price_spread_pct`, `ask/bid_*_asset_reserve` no longer cached on `AMM`. Materialized on demand via `crate::amm::math::spread::compute_amm_quote_state` → `AmmQuoteState`. This is the H2 entry in `docs/PR-decouple-amm.md`; means two consecutive fills in one refresh window now see different spreads. Documented + integration tests pass.
- **Mutation interface**: All non-AMM-module code that mutates `AMM` goes through `AmmContract` (insurance/revenue/settlement/fees) or `MakerCommit::commit_fill` / `on_market_event` (fills, funding, refresh). Trait + impls in `programs/drift/src/amm/quoter.rs`.
- **Quoter rename**: The earlier `Maker` / `AmmMaker` / `MakerCommit` / `MakerFill` names are now `Quoter` / `AmmQuoter` / `QuoterCommit` / `QuoterFill`. File `state/maker.rs` is now `state/quoter.rs`; `amm/maker.rs` is `amm/quoter.rs`. `AmmContract` trait lives in `amm/quoter.rs` next to its only impl.
- **Layout fix**: Three explicit `_padding_align_*` fields make Rust's `repr(C)` compiler-inserted padding explicit so the IDL byte-for-byte matches `repr(C)`. Without this the JS borsh decoder drifted past the variable-span `MarketStatus` enum. Don't remove.
- **Audit fixes**: H1 (oracle guard rails threaded into fulfill paths), H4 (`market_status` threaded into `MarketEvent::FundingApplied`), H5 (`AmmQuoteState::validate` runs inside `compute_amm_quote_state`), M3 (apply_fill_fees atomicity unit tests). All documented in `docs/PR-decouple-amm.md`.
- **Legacy entry points deleted**: `amm::controller::swap_base_asset` and `calculate_base_swap_output_with_spread` are gone. Test fixtures migrated. Parity test in `controller/match.rs` deleted (its reference impl was the deleted function).
- **Phase 1 of unification**: `FillFeePolicy` enum (`AmmHouse` / `DlobMatch`) added to `state/quoter.rs`. `Quoter::fee_policy()` method with `DlobMatch` default; `AmmQuoter` + `AmmJitQuoter` override to `AmmHouse`. Every `QuoterFill` construction site populates `fee_policy`. Matcher copies it from the quoter when building fills.

## Your job: the orchestrator collapse

### What's wrong today

`controller/orders.rs` has two top-level fulfill functions:

- **`fulfill_perp_order_with_amm`** (~400 lines, around line 2206): handles a sole-AMM fill. Internally calls `update_position_with_base_asset_amount` → `fill_perp_market_against_amm` → `match_take([AmmQuoter])`. So *this path already runs through the matcher*. The function's job is the orchestrator work around the match: validate the order, compute base/quote amount the AMM can fill, apply fees via `calculate_fee_for_fulfillment_with_amm`, update taker position via `update_position_with_base_asset_amount`, handle builder/referrer/filler rewards, emit `OrderActionRecord` with `OrderFilledWithAMM` (or `OrderFilledWithAMMJit` when called for a JIT slice).
- **`fulfill_perp_order_with_match`** (~500 lines, around line 2650): handles a DLOB-cross fill. Computes the JIT slice via `calculate_amm_jit_liquidity`, **recursively calls `fulfill_perp_order_with_amm`** with `override_base_asset_amount=Some(jit_amount), override_fill_price=Some(maker_price)` for the JIT slice. Then does the DLOB-vs-DLOB match math BY HAND via `calculate_fill_for_matched_orders` + `get_position_delta_for_fill` + `update_position_and_market` (NOT through the matcher). Applies match-schedule fees via `calculate_fee_for_fulfillment_with_match`, updates maker position + order + stats, emits `OrderFilledWithMatch` / `OrderFilledWithMatchJit`.

Both are dispatched from `fulfill_perp_order` (around line 1730) based on `PerpFulfillmentMethod::AMM` vs `PerpFulfillmentMethod::Match`.

### What the user wants

> "Fulfill_perp_order_with_match is just two makers — one is the amm jit, one is the match. In the main fulfill_perp_order it's just instantiating the right quoter and committing with that quoter."

The unification: replace both functions with one `fulfill_perp_order_step` that:

1. Builds the right `Vec<&mut dyn QuoterCommit>` from the `PerpFulfillmentMethod`:
   - `Amm(price)` → `[AmmQuoter::new(&mut market.amm, amm_quote_state)]`
   - `Match(maker_key, maker_order_index, maker_price)` → `[AmmJitQuoter::new(...), DlobOrderQuoter::new(&mut maker.orders[maker_order_index])]` (only include AmmJitQuoter if the JIT throttle says > 0)
2. Calls `match_take(quoters, ctx, side, target_size)` **once**.
3. Walks `match.fills`. For each fill, switches on `fill.fee_policy`:
   - `AmmHouse` → `calculate_fee_for_fulfillment_with_amm`, `<AMM as AmmContract>::apply_fill_fees`, emit `OrderFilledWithAMM` (or `OrderFilledWithAMMJit` if the fill landed against AmmJitQuoter in a multi-quoter match).
   - `DlobMatch` → `calculate_fee_for_fulfillment_with_match`, no AMM fee write, maker rebate, maker position update, maker order update, maker volume_30d, emit `OrderFilledWithMatch` (or `OrderFilledWithMatchJit` if maker order has the JIT flag).
4. Updates taker position once per fill via `update_position_and_market` (or per-fill if needed for pnl realization mid-fill).
5. Updates `total_exchange_fee` on `PerpMarket` from each fill's `fee_to_market`.
6. Distributes filler / referrer / builder fees per-fill or aggregated — match the existing behavior.
7. Finalizes taker order state (`update_order_after_fill`, `decrement_open_orders` if filled).
8. Same for maker order if DLOB fills happened.

### Critical design constraints

#### Borrow checker

`DlobOrderQuoter` holds `&mut Order` (taken from `maker.orders[idx]`). During `match_take`, you cannot also borrow `maker` for position updates. **Pattern**:

```rust
let result = {
    let mut amm_jit = AmmJitQuoter::new(&mut market.amm, ...);
    let mut dlob = DlobOrderQuoter::new(&mut maker.orders[maker_order_index]);
    let mut quoters: Vec<&mut dyn QuoterCommit> = vec![&mut amm_jit, &mut dlob];
    match_take(&mut quoters, &ctx, side, target_size)?
};  // quoters drop here; market.amm and maker.orders are no longer borrowed.

// Now apply post-match side effects to taker, maker user, market.
```

The match result needs to carry enough info per fill that the post-match dispatch knows *which quoter* the fill came from. The matcher's `Match.fills: SmallVec<[(QuoterId, QuoterFill); 4]>` already has `QuoterId` — that's the index into the original Vec. Use that to figure out "AmmJit fill" vs "DlobOrder fill" at dispatch time.

#### Fee schedules diverge

The existing fee math:

- **`calculate_fee_for_fulfillment_with_amm`** (`programs/drift/src/math/fees.rs`): takes `quote_asset_amount_surplus` (the AMM's spread profit) into account. Returns `FillFees` with `user_fee`, `fee_to_market`, `filler_reward`, `referee_discount`, `referrer_reward`, `fee_to_market_for_lp`, `maker_rebate=0`, `builder_fee`. AMM gets `apply_fill_fees(fee_to_market, surplus)` which credits the AMM's `total_fee` / `total_fee_minus_distributions` / `net_revenue_since_last_funding` / `total_mm_fee`.
- **`calculate_fee_for_fulfillment_with_match`** (same file): returns `FillFees` with a maker rebate. Taker pays house fee; maker gets rebate. No AMM credit. `market.total_exchange_fee += fee_to_market`.

These are the two cases `FillFeePolicy` enum maps to. Per-fill dispatch is straightforward.

#### `quote_asset_amount_surplus` semantics

For `AmmHouse` fills: surplus is the spread profit (or loss, on JIT subsidy) the AMM captured. Already populated in `AmmQuoter::try_fill_solo` and `AmmJitQuoter::try_fill_solo`. Pass it to `calculate_fee_for_fulfillment_with_amm` and to `<AMM as AmmContract>::apply_fill_fees`.

For `DlobMatch` fills: surplus is 0 (DLOB orders quote one price). Pass 0 / don't pass.

#### Position update timing matters

Two routes used today:

- **`update_position_with_base_asset_amount`** (controller/position.rs:364): the AMM path uses this. Internally does `fill_perp_market_against_amm` (which already mutates AMM reserves + `base_asset_amount_with_amm` via `AmmQuoter::commit_fill`), then `update_position_and_market` for the taker position.
- **`update_position_and_market`** (controller/position.rs, earlier): the match path uses this directly. Doesn't touch AMM.

In the unified orchestrator, after `match_take` returns, the AMM reserves + `base_asset_amount_with_amm` are *already mutated* (done inside `commit_fill` during the match). So per-fill you only need `update_position_and_market` for taker (and maker, on DLOB-side fills) — DON'T re-route through `fill_perp_market_against_amm`, that'd double-apply.

#### Order state finalization

After all per-fill dispatch:

- For taker order: `update_order_after_fill(&mut taker.orders[taker_order_index], total_base_filled, total_quote_filled)`. If `is_filled`, `taker.decrement_open_orders(...)`, set `status = OrderStatus::Filled`, decrement `market_position.open_orders`.
- For each DLOB maker order touched: same finalize.

`update_order_after_fill` returns `is_filled`. Use it.

#### Event emission per fill (not per fulfill_step call)

Today `fulfill_perp_order_with_amm` emits ONE `OrderActionRecord` per call. `fulfill_perp_order_with_match` emits ONE per call too. But when the latter calls the former for a JIT slice, that's TWO records emitted from one logical fulfill step (one `OrderFilledWithAMMJit`, one `OrderFilledWithMatch`).

In the unified orchestrator, emit **one record per fill** in `match.fills`. So a JIT + DLOB match still emits two records. Preserve.

The `OrderActionExplanation` mapping:

- `FillFeePolicy::AmmHouse` + single-quoter match (only AmmQuoter) → `OrderFilledWithAMM`
- `FillFeePolicy::AmmHouse` + multi-quoter match (AmmJitQuoter present) → `OrderFilledWithAMMJit`
- `FillFeePolicy::DlobMatch` + maker order has `JitMaker` flag → `OrderFilledWithMatchJit`
- `FillFeePolicy::DlobMatch` + standard maker → `OrderFilledWithMatch`
- Any case + `is_liquidation == true` → `OrderActionExplanation::Liquidation`

#### Mark TWAP update

Both existing functions call `market.market_stats.update_mark_twap_from_estimates(...)` before fills. The unified orchestrator should call it once per `fulfill_perp_order_step` call, not per fill — pre-match.

The "execution premium price" hint for the TWAP is the maker price in the match case, or the AMM's bid/ask price for AMM-only. Use the same dispatch logic as today (`market_side_price` for AMM-only, `maker_price` for match).

#### JIT throttle still computed by caller

`calculate_amm_jit_liquidity` (in `programs/drift/src/amm/math/jit.rs`) computes the throttled JIT base amount. It needs caller context (taker order, valid_oracle_price, maker base amount). Keep calling it in the orchestrator; pass the result to `AmmJitQuoter::new(..., max_jit_base)`.

If `max_jit_base == 0`, don't include the AmmJitQuoter in the Vec at all.

#### Existing helpers to reuse, not rewrite

- `calculate_amm_jit_liquidity` (JIT throttle math)
- `calculate_fee_for_fulfillment_with_amm` (AMM fee schedule)
- `calculate_fee_for_fulfillment_with_match` (DLOB fee schedule)
- `get_position_delta_for_fill` (signed base/quote → PositionDelta)
- `update_position_and_market` (apply position delta + market counter writes)
- `update_order_after_fill` (filled-amount accumulation, status flip)
- `decrease_open_bids_and_asks` (open-orders bookkeeping)
- `get_order_action_record` / `emit_stack` (event emission)
- `credit_filler_perp_pnl` (filler reward + filler stats)
- `get_taker_and_maker_for_order_record` (event metadata)
- `<AMM as AmmContract>::apply_fill_fees` (AMM-side fee accounting)
- `market.total_exchange_fee += fee_to_market` (PerpMarket-level)

### Suggested implementation order

1. Read `fulfill_perp_order_with_amm` and `fulfill_perp_order_with_match` line-by-line. They're in `controller/orders.rs`. Be sure you understand every side effect.
2. Look at `fill_perp_market_against_amm` in `controller/match.rs` — that's the existing helper that runs `match_take([AmmQuoter])`. It does almost the AMM-only orchestrator work for you.
3. Write `fulfill_perp_order_step` from scratch alongside the existing functions. Don't delete yet.
4. Wire `fulfill_perp_order` (the outer dispatch loop at orders.rs:1730) to call your new function for the `Amm` branch first. Run unit + integration. If green, do the `Match` branch.
5. Once both branches green, delete `fulfill_perp_order_with_amm` and `fulfill_perp_order_with_match`. Run suite.

### Tests

- **Unit suite**: `cargo test -p drift --lib`. Should be 832 passing baseline.
- **Integration suite**: `bash test-scripts/run-anchor-tests.sh`. Takes ~10 min. 281 passing baseline. Don't skip.
- **Hot tests to watch**: anything in `tests/` that places + fills perp orders. Especially `placeAndMakePerp.ts`, `multipleMakerOrders.ts`, `marketOrder.ts`, `oracleFillPriceGuardrails.ts`, `postOnly.ts`. The amm-jit tests in `tests/amm-jit*` (if present) and `tests/jit*.ts`.
- **`controller/orders/amm_jit_tests.rs`** — Rust-side AMM JIT tests, lots of them. These hit `fulfill_perp_order` end-to-end. If the new orchestrator is byte-equivalent, they pass without changes.
- **`controller/orders/tests.rs`** — DLOB match tests. Same story.

If any test fails on a fee-amount or position-amount assertion, the unification has introduced a real semantic change. Don't paper over it; figure out why.

### Files you'll touch

- `programs/drift/src/controller/orders.rs` — main work. Add `fulfill_perp_order_step`. Modify `fulfill_perp_order`. Delete the two old functions.
- (Maybe) `programs/drift/src/amm/quoter.rs` — if AmmJitQuoter needs an additional accessor or a derived field, add it here.
- (Maybe) `programs/drift/src/controller/match.rs` — if you need a new variant of `fill_perp_market_against_amm` for multi-quoter, add it here.

### Files NOT to touch (keep stable)

- `programs/drift/src/amm/math/*` — pure math, no AMM mutations needed for this refactor.
- `programs/drift/src/state/quoter.rs` — Quoter trait + FillFeePolicy already in place.
- Layout-padding fields in `state/perp_market.rs`. Removing any of them will break the on-chain decoder.

### Pre-flight checklist

Before you start coding:

1. `cargo test -p drift --lib` — expect 832 passing.
2. Read this entire doc.
3. Read `docs/PR-decouple-amm.md` for the H1/H2/H3/H4/H5 context — these were audit findings against master, and the unification work shouldn't reintroduce any of them.
4. Read `programs/drift/src/controller/orders.rs:2206-3166` end-to-end. (the two fulfill functions and `credit_filler_perp_pnl`.)
5. Read `programs/drift/src/controller/match.rs:660-720` — `fill_perp_market_against_amm` + `apply_match_to_perp_market`.
6. Read `programs/drift/src/amm/quoter.rs:815-980` — `AmmJitQuoter` impl.

### Post-flight checklist

Before you call it done:

1. `cargo test -p drift --lib` — expect 832+ passing (might be a few more if you added unit tests).
2. `bash test-scripts/run-anchor-tests.sh` — expect 281 passing.
3. `cargo clippy -p drift --lib --tests 2>&1 | grep -E "^error|^warning: unused"` — no new unused-import warnings introduced.
4. `cargo fmt -p drift`.
5. Look for any remaining `fulfill_perp_order_with_amm` / `fulfill_perp_order_with_match` references with `grep -rn 'fulfill_perp_order_with_' programs/drift/src/`. Should only show test files where the orchestrator is invoked through the outer `fulfill_perp_order` path.
6. Update `docs/PR-decouple-amm.md` with a "Fulfill unification" section if landing this in the same PR; otherwise update the design doc.

### When you're done

Tell the user:
- Whether the audit findings (H1/H2/H3/H4/H5/M3) are still all addressed.
- Whether you preserved the per-fill event semantics (one record per fill, JIT+DLOB still emits two).
- The diff size in `controller/orders.rs` net of deletions.
- Anything you couldn't preserve byte-for-byte and why.

Good luck.
