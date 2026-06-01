# Decouple AMM from PerpMarket

Draft PR description. Tracks the entire `feat/decouple-amm` branch's deviations from `master`.

## Summary

Refactor that decouples AMM-specific state and math from the rest of the protocol so the AMM can eventually become its own on-chain program. PerpMarket's god-struct shrinks: ~80 fields formerly on `AMM` move to `PerpMarket` (protocol-level counters, funding, oracle metadata) or to a new `MarketStats` sub-struct (mark/oracle TWAPs, vol, intensity, mm-oracle snapshot). The remaining `AMM` struct contains only AMM-internal state (reserves, peg, k, fee pool, spread params).

Every cross-module mutation of AMM state now goes through an explicit interface — `AmmContract` (admin / insurance / settlement / fees) or `MakerCommit::commit_fill` / `on_market_event` (fills, funding, refresh). No code outside `programs/drift/src/amm/` writes AMM fields directly.

## Behavior changes (read carefully)

**This branch is mostly a structural refactor, but two changes have real on-chain consequences. Both are deliberate; both deserve explicit sign-off from anyone reviewing.**

### 1. Spread / reference-offset are no longer cached on `AMM` — recomputed per quote

**Before (master).** `AMM` held `long_spread`, `short_spread`, `reference_price_offset`, `last_oracle_reserve_price_spread_pct`, `ask_base_asset_reserve`, `ask_quote_asset_reserve`, `bid_base_asset_reserve`, `bid_quote_asset_reserve`, `last_oracle_conf_pct` as cached fields. They were updated only by `_update_amm` (the explicit refresh crank). Between cranks, two consecutive fills saw byte-identical spread / reserves.

**After.** Those fields are gone from `AMM`. Every quote (fill, funding tick, auction-param compute, JIT eligibility) calls `compute_amm_quote_state(&AMM, &MarketStats, &MMOraclePriceData, reserve_price, slot)` and materialises the same struct on the stack. Two consecutive fills within one refresh window now see *different* spreads — because the recompute inputs (`base_asset_amount_with_amm`, reserves, `total_fee_minus_distributions`) are themselves mutated by every fill.

**Consequences.** The per-call math is byte-equivalent to what master's `update_spreads` would have produced at that moment, but several code paths now react to "live" spread state where they previously locked in the most recent crank's value:

- `formulaic_update_k` budget gate: master tested `max(long_spread, short_spread) <= base_spread` against the cached value. The branch tests against the just-recomputed value.
- AMM-JIT shrink (`amm/math/jit.rs`): `jit_base_asset_amount` is computed against fresh spreads.
- AMM bid/ask price quoted per fill reflects the just-recomputed spread.

**Why it's defensible.** The cached spread *was* a snapshot of "what `compute_amm_quote_state` would return right now"; we just stopped persisting it. The on-chain compute itself is byte-equivalent to master's `update_spreads` body.

**Why it might not be.** Master's caching was a deliberate stability mechanism: two fills atomically queued in the same slot saw the same quote. The branch breaks that promise.

**Verification needed.** Run integration fixtures (or replay mainnet fills) and confirm fill prices match master ± a documented tolerance. If they don't, decide whether to (a) accept the new behavior and document it, or (b) re-introduce the cache (post-compute, write the result back onto `AMM`).

### 2. DLOB-vs-DLOB fills no longer credit AMM-side fee accumulators

**Before (master).** Every fill — AMM-side and DLOB-vs-DLOB — credited the AMM's `total_fee`, `total_fee_minus_distributions`, and `net_revenue_since_last_funding`. The protocol treated all maker-fee revenue as the AMM's pool.

**After.** Only AMM-side fills credit those counters. DLOB-vs-DLOB fills credit only `PerpMarket.total_exchange_fee` (a new perp-market-level protocol-revenue counter).

**Consequences.** Fees that previously flowed straight into the AMM's repeg / k-update budget now sit on the perp market. The AMM's `total_fee_minus_distributions` grows more slowly — which makes formulaic k-ups affordable less often and makes formulaic k-downs (triggered when `net_revenue_since_last_funding < funding_imbalance_cost`) fire more aggressively on losses. **The protocol still keeps the full fee** — only the bucket changes.

**The intent.** A clear fee-separation contract: DLOB-vs-DLOB fees count toward the perp market's `total_exchange_fee` (which sets the protocol-share floor for the AMM); an admin handler moves the actual SPL tokens from the perp market's `pnl_pool` into the AMM's `fee_pool` (which adjusts `total_fee_minus_distributions` correspondingly).

**Admin path exists.** `handle_transfer_fee_and_pnl_pool(direction: PnlToFeePool, amount)` in `amm/admin.rs:1157` moves SPL token balance between `perp_market.pnl_pool` and `perp_market.amm.fee_pool`, updating `total_fee_minus_distributions` atomically. No new handler needed — but the protocol now requires explicit admin action to give the AMM extra repeg / k-update budget from DLOB-vs-DLOB volume, rather than automatically diverting (1 − protocol_share) of every fee.

**Operational note.** The protocol still collects the full fee on every fill. What changed is that DLOB-vs-DLOB fees no longer auto-flow into the AMM's spendable budget — they sit in `pnl_pool` until admin moves them. If the AMM is the dominant counterparty, the difference is small; if DLOB volume dominates, the AMM will require periodic admin top-ups to keep repegs / k-ups affordable.

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
- Spread params: `base_spread`, `max_spread`, `max_fill_reserve_fraction`, `max_slippage_ratio`, `amm_spread_adjustment`, `amm_inventory_spread_adjustment`, `reference_price_offset_deadband_pct`
- Behavior: `curve_update_intensity`, `amm_jit_intensity`

**Removed entirely (no replacement; computed on demand via `compute_amm_quote_state`):**
- `long_spread`, `short_spread`, `reference_price_offset`
- `last_oracle_reserve_price_spread_pct`
- `ask_base_asset_reserve`, `ask_quote_asset_reserve`, `bid_base_asset_reserve`, `bid_quote_asset_reserve`

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

`PerpMarket` size unchanged (1112 bytes including 8-byte discriminator) by adding three explicit `_padding_align_*` fields that absorb Rust's implicit `repr(C)` alignment padding. This makes the IDL byte-for-byte match `repr(C)` so the JS borsh decoder (which reads sequentially after the variable-span `MarketStatus` enum) doesn't drift.

Native-handler offsets (`mm_oracle_price=720`, `mm_oracle_slot=728`, `mm_oracle_sequence_id=736`, `amm_spread_adjustment=1094`) are pinned by regression tests in `state/traits/tests.rs`.

## Bug fixes that landed in the same branch

- **H1**: `controller/orders.rs` fulfill helpers no longer hard-code `OracleGuardRails::default()`; they receive `&state.oracle_guard_rails.validity` from `fill_perp_order`.
- **H4**: `MarketEvent::FundingApplied` now carries `market_status` so `get_update_k_result` can relax its k-down precondition on `ReduceOnly` markets (matching master).
- **H5**: `compute_amm_quote_state` calls `quote_state.validate(amm)` before returning. Catches a corrupted spread/reserve compute at the source. Master's equivalent invariants ran in `validate_perp_market`; the branch removed them from there (the fields they checked no longer exist on `AMM`) and re-introduced them inside the AMM via `AmmQuoteState::validate`.

## Test changes

- 829 Rust unit tests green (added new tests around `AmmMaker`, `AmmQuoteState`, matcher, `apply_fill_fees` atomicity).
- 281 TypeScript integration tests green (entire `tests/` suite).

## Out of scope

- Devnet wipe-and-reinit. Post-merge step, runbook in `deploy-scripts/README.md`.
- Mainnet upgrade. The layout changes are mainnet-incompatible without a migration; mainnet rollout requires either (a) a struct-versioning shim or (b) a freeze-and-rebuild. Tracked separately.
