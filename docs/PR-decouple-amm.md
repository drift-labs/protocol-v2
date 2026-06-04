# Decouple AMM from PerpMarket

Draft PR description. Tracks the entire `feat/decouple-amm` branch's deviations from `master`.

## Summary

Refactor that decouples AMM-specific state and math from the rest of the protocol so the AMM can eventually become its own on-chain program. PerpMarket's god-struct shrinks: ~80 fields formerly on `AMM` move to `PerpMarket` (protocol-level counters, funding, oracle metadata) or to a new `MarketStats` sub-struct (mark/oracle TWAPs, vol, intensity, mm-oracle snapshot). The remaining `AMM` struct contains only AMM-internal state (reserves, peg, k, fee pool, spread params).

Every cross-module mutation of AMM state now goes through an explicit interface — `AmmContract` (admin / insurance / settlement / fees) or `MakerCommit::commit_fill` / `on_market_event` (fills, funding, refresh). No code outside `programs/drift/src/amm/` writes AMM fields directly.

## Behavior changes (read carefully)

**This branch is mostly a structural refactor. Section 1 (spread cache) is behavior-preserving vs master — the cache was briefly removed and then restored, so it's documented here mainly to record the round-trip. The two changes with real on-chain consequences are §2 (DLOB-vs-DLOB fee bucketing) and §3 (`protocol_floor`). Both are deliberate; both deserve explicit sign-off from anyone reviewing.**

### 1. Spread / reference-offset stay cached on `AMM`; refresh consolidated into one in-place mutator

> An earlier iteration of this branch *removed* the cached spread fields and recomputed them on demand per quote (returning an `AmmQuoteState` value). That was reversed: the team reads `long_spread` / `short_spread` / `reference_price_offset` / the spread reserves straight off the account for tracking and dashboards, and master's "fills in a refresh window see the same quote" stability is worth keeping. The `AmmQuoteState` struct is deleted; the fields live on `AMM` again.

**State.** `AMM` retains `long_spread`, `short_spread`, `reference_price_offset`, `last_oracle_reserve_price_spread_pct`, and the spread-adjusted reserves `ask_base_asset_reserve` / `ask_quote_asset_reserve` / `bid_base_asset_reserve` / `bid_quote_asset_reserve` as cached fields (as on master), plus a new **`last_spread_update_slot: u64`** recording when the cache was last refreshed. (`last_oracle_conf_pct` lives on `MarketStats`, written by `MarketStats::update_oracle_conf_pct`.)

**Writer.** The legacy `update_spreads` + `update_spread_reserves` mutators are consolidated into one `update_amm_quote_state(&mut AMM, &MarketStats, &MMOraclePriceData, reserve_price, slot)` (`amm/math/spread.rs`) that recomputes all the cached fields and writes them back in place, stamping `last_spread_update_slot`. It is the only writer; every quote/fill/funding/auction/JIT path **reads** the cached fields off `AMM` (no per-quote recompute, no struct threaded through call sites).

**Refresh points.** The cache is refreshed by (a) the keeper crank (`PerpMarket::update_oracle_derived_stats`), (b) the fill `Quoter::setup` against the post-projection curve, (c) `update_funding_rate`, (d) the mark-twap crank, and (e) the fulfillment-routing step in `fulfill_perp_order_step` (off the current reserves, before `setup` re-refreshes post-projection). Within a single fill, `setup` writes the cache once and every maker-match in that fill reads the same value — preserving master's promise that quotes are stable within a refresh window.

**vs master.** Master refreshed the cache only in the explicit `_update_amm` crank; the keeper cranked each market before fills. This branch additionally refreshes at fill `setup` (post-projection) so a fill quotes against the curve state it is about to trade on, but the per-fill recompute is the same `update_spreads` / `update_spread_reserves` body master ran, and within-fill stability is unchanged. `formulaic_update_k`, AMM-JIT shrink (`amm/math/jit.rs`), and the per-fill AMM bid/ask all read the cached `amm.long_spread` / `amm.short_spread` again, exactly as on master.

### 2. DLOB-vs-DLOB fills no longer credit AMM-side fee accumulators

**Before (master).** Every fill — AMM-side and DLOB-vs-DLOB — credited the AMM's `total_fee`, `total_fee_minus_distributions`, and `net_revenue_since_last_funding`. The protocol treated all maker-fee revenue as the AMM's pool.

**After.** Only AMM-side fills credit those counters. DLOB-vs-DLOB fills credit only `PerpMarket.total_exchange_fee` (a new perp-market-level protocol-revenue counter).

**Consequences.** Fees that previously flowed straight into the AMM's repeg / k-update budget now sit on the perp market. The AMM's `total_fee_minus_distributions` grows more slowly — which makes formulaic k-ups affordable less often and makes formulaic k-downs (triggered when `net_revenue_since_last_funding < funding_imbalance_cost`) fire more aggressively on losses. **The protocol still keeps the full fee** — only the bucket changes.

**The intent.** A clear fee-separation contract: DLOB-vs-DLOB fees count toward the perp market's `total_exchange_fee` (which sets the protocol-share floor for the AMM); an admin handler moves the actual SPL tokens from the perp market's `pnl_pool` into the AMM's `fee_pool` (which adjusts `total_fee_minus_distributions` correspondingly).

**Admin path exists.** `handle_transfer_fee_and_pnl_pool(direction: PnlToFeePool, amount)` in `amm/admin.rs:1157` moves SPL token balance between `perp_market.pnl_pool` and `perp_market.amm.fee_pool`, updating `total_fee_minus_distributions` atomically. No new handler needed — but the protocol now requires explicit admin action to give the AMM extra repeg / k-update budget from DLOB-vs-DLOB volume, rather than automatically diverting (1 − protocol_share) of every fee.

**Operational note.** The protocol still collects the full fee on every fill. What changed is that DLOB-vs-DLOB fees no longer auto-flow into the AMM's spendable budget — they sit in `pnl_pool` until admin moves them. If the AMM is the dominant counterparty, the difference is small; if DLOB volume dominates, the AMM will require periodic admin top-ups to keep repegs / k-ups affordable.

### 3. `AMM::protocol_floor` is now AMM-only (was implicitly market-wide)

**Before.** `AMM::protocol_floor(total_exchange_fee, total_liquidation_fee)` computed the AMM's reserved-fee floor from two *market-level* accumulators:

```
floor = (market.total_exchange_fee × 50%) + market.total_liquidation_fee
        - amm.total_fee_withdrawn
```

The 50% term included taker fees from DLOB-vs-DLOB fills (which the AMM never earned) and the liquidation-fee term was IF revenue (which never flowed to the AMM at all). The floor was used to size the AMM's spending budget for funding rebates and formulaic k-updates via `repeg::calculate_fee_pool`. Pre-DLOB this was coherent (every fill was AMM-vs-user, `amm.total_fee == market.total_exchange_fee`). Post-DLOB it just shrunk the AMM's spendable cap by fees the AMM never received.

**After.** `AMM::protocol_floor()` takes no arguments and computes purely from AMM-internal state:

```
floor = (amm.total_fee × 50%) - amm.total_fee_withdrawn
```

`ProjectionInputs` (the `Quoter::setup` payload) and `FundingMarketInputs` (the funding-math snapshot) both lose their `total_exchange_fee` / `total_liquidation_fee` fields — the AMM no longer needs them. The on-chain math now matches what an isolated AMM (future-CPI world) would compute with no visibility into market-level numbers.

**Consequences.**

- The AMM's spending budget for funding rebates / formulaic k-ups goes **up** by `(0.5 × DLOB-fill exchange fees) + total_liquidation_fee`. The old floor was artificially banking those amounts against the AMM; under the new model they're not phantom-retained.
- `controller::perp_pools::calculate_revenue_pool_transfer` (the IF settlement path) still uses the market-wide formula via `get_total_fee_lower_bound(&PerpMarket)`. That caller legitimately sizes the IF claim against *all* market fees, not just AMM ones — explicitly different semantics, intentionally kept market-wide.

**Operational lever.** If the AMM ever needs a top-up from the broader market, the existing `handle_transfer_fee_and_pnl_pool(direction: PnlToFeePool)` ix is the explicit path — moves SPL balance from `pnl_pool` to `amm.fee_pool` *and* bumps `amm.total_fee_minus_distributions`. No implicit borrowing through floor accounting.

## Architecture

### Struct partition

`PerpMarket` (the god struct, simplified):
- `pubkey`, `name`, `market_index`, `status`, `contract_type`, `contract_tier`, `paused_operations`
- Risk params: `margin_ratio_initial/maintenance`, `imf_factor`, `liquidator_fee`, `if_liquidation_fee`
- Open-interest counters: `base_asset_amount_long/short`, `quote_asset_amount`, `quote_entry_amount_long/short`, `quote_break_even_amount_long/short`, `max_open_interest`, `total_social_loss`, `number_of_users_with_base/users`
- Protocol fees: `total_exchange_fee`, `total_liquidation_fee`
- Funding: `cumulative_funding_rate_long/short`, `last_funding_rate*`, `net_unsettled_funding_pnl`, `last_funding_oracle_twap`
- Oracle id: `oracle`, `oracle_source`, `oracle_slot_delay_override`, `oracle_low_risk_slot_delay_override`
- Order params: `order_step_size`, `order_tick_size`
- Pools: `pnl_pool`, `insurance_claim`
- LP config: `lp_status`, `lp_paused_operations`, `lp_pool_id`, `lp_fee_transfer_scalar`, `lp_exchange_fee_excluscion_scalar`
- `market_stats: MarketStats` (sub-struct, see below)
- `amm: AMM` (sub-struct, see below) — *last field, so a future excision into a dedicated AMM program is a clean truncate at this offset*

`MarketStats` (new sub-struct, lives on `PerpMarket.market_stats`):
- Mark/oracle TWAPs: `last_mark_price_twap`, `last_mark_price_twap_5min`, `last_bid_price_twap`, `last_ask_price_twap`, `last_oracle_normalised_price`, `historical_oracle_data`
- Rolling vol/intensity: `mark_std`, `oracle_std`, `last_oracle_conf_pct`, `volume_24h`, `long_intensity_volume`, `short_intensity_volume`
- Timestamps: `last_mark_price_twap_ts`, `last_trade_ts`, `last_24h_avg_funding_rate`, `funding_period`
- Order config: `min_order_size`
- mm-oracle snapshot: `mm_oracle_price`, `mm_oracle_slot`, `mm_oracle_sequence_id`
- `last_reference_price_offset`, `last_oracle_valid`

`AMM` (shrunk; only AMM-internal state):
- Curve: `base_asset_reserve`, `quote_asset_reserve`, `concentration_coef`, `min/max_base_asset_reserve`, `sqrt_k`, `peg_multiplier`, `terminal_quote_asset_reserve`
- AMM's net counterparty position: `base_asset_amount_with_amm`
- AMM-private oracle snapshot: `last_update_slot`
- AMM's books: `fee_pool`, `total_fee`, `total_mm_fee`, `total_fee_minus_distributions`, `total_fee_withdrawn`, `net_revenue_since_last_funding`
- Spread config: `base_spread`, `max_spread`, `max_fill_reserve_fraction`, `max_slippage_ratio`, `amm_spread_adjustment`, `amm_inventory_spread_adjustment`, `reference_price_offset_deadband_pct`
- Cached spread state (refreshed in place by `update_amm_quote_state`): `long_spread`, `short_spread`, `reference_price_offset`, `last_oracle_reserve_price_spread_pct`, `ask_base_asset_reserve`, `ask_quote_asset_reserve`, `bid_base_asset_reserve`, `bid_quote_asset_reserve`, `last_spread_update_slot`
- Behavior: `curve_update_intensity`, `amm_jit_intensity`

### Maker interface

New module `programs/drift/src/state/maker.rs` defines the matcher-facing interface:

- `Maker` trait: `best_price`, `cumulative_size`, `try_fill_solo`, `is_prio`, `is_fee_exempt`.
- `MakerCommit` trait: `commit_fill`, `on_market_event`. Split from `Maker` so quotes take `&self` (matcher bisection) while commits take `&mut self`.
- `QuoteContext`: per-quote inputs (`stats`, `oracle`, `fee_budget`, `tick`, `slot`, `base_precision`).
- `MakerFill`: per-maker fill output (size, price, refresh-cost).
- `MarketEvent`: typed events the AMM consumes (`Refresh`, `FundingApplied`).
- `MarketEventEffects`: typed outputs (curve record, fee deltas, period-revenue snapshot).
- `DlobOrderMaker`: wraps an `Order` as a `Maker`.

`programs/drift/src/amm/maker.rs` hosts the AMM-side impls:

- `AmmMaker`: wraps `&mut AMM` for matcher use.
- `AmmJitMaker`: vAMM JIT auction participant.
- `impl AmmContract for AMM`: the AMM-side write interface (`record_credit`, `record_revenue_withdrawal`, `apply_settlement_counterparty`, `record_amm_pnl`, `apply_fill_fees`, `transfer_revenue_to_pool`, `deposit_to_fee_pool`, `withdraw_from_fee_pool`). The trait *definition* and the *impl* co-locate.

### Matcher

`programs/drift/src/controller/match.rs` implements the segment-walk + bisection + pro-rata + priority-first algorithm. The current production fill path (sole-AMM swap) uses the closed-form `try_fill_solo` shortcut — byte-equivalent to master's `swap_base_asset`. The multi-maker code path is compiled in but unreachable from production today; a future change can wire it without touching the matcher.

### AMM mutators moved to methods on `AMM`

- `update_concentration_coef`, `move_price`, `recenter`, `apply_k_update`, `adjust_k_cost_and_update` are now `impl AMM` methods. Bodies byte-equivalent to master's free functions.

### MarketStats mutators moved to methods on `MarketStats`

- `update_oracle_twap`, `update_mark_twap`, `update_mark_twap_from_estimates`, `update_mark_twap_crank` are now `impl MarketStats` methods. Take `&AMM` read-only (or no AMM) instead of the master `&mut AMM`. Bodies byte-equivalent.
- `update_oracle_conf_pct`, `update_mark_std`, `update_oracle_std`, `update_volume_24h` similar.

### Misc structural moves

- `calculate_oracle_twap_5min_price_spread_pct` → `HistoricalOracleData::twap_5min_spread_pct` (zero AMM dependency).
- `is_oracle_mark_too_divergent` → `math/oracle::is_mark_oracle_too_divergent` (zero AMM dependency).

### Layout

`PerpMarket::SIZE` is **1208 bytes** (1200-byte struct + 8-byte discriminator), with explicit `_padding_align_*` fields absorbing Rust's implicit `repr(C)` alignment padding so the IDL matches `repr(C)` byte-for-byte (the JS borsh decoder reads sequentially after the variable-span `MarketStatus` enum and would otherwise drift). Re-adding the cached spread state to `AMM` grew the struct by 80 bytes vs. the cache-removed iteration; the `(SIZE − 8) % 16 == 0` zero-copy invariant holds, and the four `u128` spread reserves are placed in the contiguous `u128` block to keep 16-byte alignment.

Native-handler offsets are pinned by regression tests in `state/traits/tests.rs`: `mm_oracle_price=720`, `mm_oracle_slot=728`, `mm_oracle_sequence_id=736` (in `MarketStats`, unchanged), and `amm_spread_adjustment=1202` (in `AMM`, shifted by the re-added cache fields). The `amm_spread_adjustment` native handler deserializes the full `PerpMarket` via `bytemuck` and writes the field by name, so it is layout-agnostic — only the guard test's literal updates.

## Bug fixes that landed in the same branch

- **H1**: `controller/orders.rs` fulfill helpers no longer hard-code `OracleGuardRails::default()`; they receive `&state.oracle_guard_rails.validity` from `fill_perp_order`.
- **H4**: `MarketEvent::FundingApplied` now carries `market_status` so `get_update_k_result` can relax its k-down precondition on `ReduceOnly` markets (matching master).
- **H5**: `update_amm_quote_state` calls `validate_amm_quote_state(amm)` after writing the cache. Catches a corrupted spread/reserve refresh at the source — the only way bad spread state can reach a fill is through that refresh. Master's equivalent invariants ran in `validate_perp_market`; this keeps them adjacent to the writer.

## Test changes

- 844 Rust unit tests green (added tests around the AMM quoter, the in-place `update_amm_quote_state` cache refresh + `validate_amm_quote_state`, matcher, `apply_fill_fees` atomicity).
- 286 TypeScript integration tests green (the enabled `tests/` suite; a handful of files remain disabled for unrelated layout/feature reasons — see `test-scripts/run-anchor-tests.sh`).

## Out of scope

- Devnet wipe-and-reinit. Post-merge step, runbook in `deploy-scripts/README.md`.
- Mainnet upgrade. The layout changes are mainnet-incompatible without a migration; mainnet rollout requires either (a) a struct-versioning shim or (b) a freeze-and-rebuild. Tracked separately.
