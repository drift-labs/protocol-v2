# Oracle Cache Account

Describes the architecture for an oracle cache to be used initially by PropAMM filler logic.

## Overview

Margin-checking a maker (or taker) on Drift requires oracle price data for every market the maker
has a position in. With N makers each holding positions across M (<=16) markets, the
union of oracle accounts explodes past Solana's 64-account transaction limit.
Order matching against multiple maker accounts is the canonical example of this problem, with fills
involving more than 2 cross-collateralized makers quickly becoming unexecutable.

The solution presented here is an oracle cache account that collapses the oracle account requirement into a single read-only account, in the best case.
The use of an oracle cache account makes an intentionally narrow tradeoff: fill-time maker margin checks can tolerate bounded staleness for oracle prices, as long as solvency-critical operations use live oracle prices. The use of the cache account improves _fill liveness_ under account pressure without loosening the protocol's solvency guarantees.

### Oracle Cache Account

The oracle cache is a flat array of oracle price snapshots.
The cache account is opt-in and supplied only to cache-aware instructions.
Keepers update cache entries to maintain a configured freshness target, for example tighter bounds for
majors and looser bounds for tail assets.
As part of a fill tx a keeper may update the cache atomically ('paging'), it is not a strictly isolated process.
This paging / copy-in step does not ingest off-chain price payloads; it reloads oracle accounts that
are already on-chain and snapshots their current state into the cache account.

Cache entries that are stale are not loaded, so downstream reads see exactly the same `OracleNotFound` behavior they would see today if the oracle account had simply not been included.

Consider the following during a fill:
- if a required oracle is fresh in the cache, a maker may be evaluated as normal
- if a required oracle is stale or missing, the cache entry is unavailable and becomes an `OracleNotFound` error
- an `OracleNotFound` causes a maker to be skipped, not the entire fill
- liquidations and other sensitive flows still depend on live oracle accounts

The cache approach is consistent with existing Drift oracle semantics. The codebase already distinguishes between `OracleValidity::StaleForMargin` and `OracleValidity::StaleForAMM`, and
`is_oracle_valid_for_action()` already applies different acceptance rules depending on the
operation.

### OracleMap Integration

`OracleMap::load_one_with_cache()` is the sole integration point for the cache account.
At construction time it parses the cache account once and merges it with additional live oracle accounts from the remaining accounts list.

```
                         +----------------------+
                         |     margin check     |
                         +----------------------+
                                   |
                                   | get_price_data(SOL)
                                   | get_price_data(BTC)
                                   v
                         +----------------------+
                         |      OracleMap       |
                         +----------------------+
                              |            |
                              |            |
                              |            v
                              |      remaining_accounts
                              |      [      BTC      ]
                              v
                       oracle_price_cache
                   [ SOL ] [ BTC ] [ BONK ]

```

The OracleMap prioritizes loading latest oracle data, construction is as follows:
1) fresh cache entries are inserted into `OracleMap.price_data`, stale cache entries are ignored
2) primary market oracle passed directly to the ix is loaded normally (i.e BONK oracle in a BONK-PERP fill)
3) paging: if a live oracle account is included via `remaining_accounts`, it replaces any pre-loaded value for that oracle

That means by the time downstream code calls `oracle_map.get_price_data()`, the cache decision has
already been made. Cache-aware instructions therefore decide cache eligibility at OracleMap load time before running business logic.

### Effective Delay / Staleness

When a cache entry is materialized, its delay grows to reflect its age:

```
effective_delay = original_delay + (current_slot - cached_slot)
```

This baked-in delay is stored in the `OraclePriceData.delay` field returned
to callers. Consumer instructions then apply their own staleness thresholds
via `oracle_validity()` using the effective delay — all existing guard rails
(`slots_before_stale_for_margin`, `slots_before_stale_for_amm`, etc.) apply
without modification.

```
Example:
  Oracle publishes at slot 100 with delay = 2
  Keeper caches at slot 105       →  cached_slot = 105
  Fill reads at slot 160          →  age = 55

  effective_delay = 2 + 55 = 57
  oracle_validity threshold = 120  →  57 < 120  →  valid for margin
```

## Write Contention (Optimization)

It is possible that a single oracle cache account leads to write-contention on Solana. 
The proposed solution is using a double-buffer system of redundant accounts.

A protocol wide rule may coordinate which account is the write account vs. which is the read account e.g. in a double buffer situation
```
fn preferred_buffer(slot: u64) -> u8 {
    if (slot / 20) % 2 == 0 {
        0
    } else {
        1
    }
}
```

This allows Keepers to write to one buffer while fills read the other, reducing
read/write lock contention at the Solana runtime level. Buffer choice is an optimization —
every entry self-reports its age, so reading a stale buffer just means fewer cache hits, never incorrect prices.

## Accounts And Instructions
---

### Oracle Cache Account Layout

```
 PDA seeds: ["oracle_price_cache", cache_id, buffer_index]

 OraclePriceCache
 ┌────────┬────────┬───────────────────────────────────────────┐
 │ Offset │  Size  │ Field                                     │
 ├────────┼────────┼───────────────────────────────────────────┤
 │      0 │      8 │ discriminator        (Anchor account)     │
 ├────────┼────────┼───────────────────────────────────────────┤
 │      8 │      1 │ bump                 u8                   │
 │      9 │      1 │ max_age_slots        u8 (0 = default 60)  │
 │     10 │      1 │ cache_id             u8 (shard, v1 = 0)   │
 │     11 │      1 │ buffer_index         u8 (0 or 1)          │
 │     12 │      4 │ len                  u32 (entry count)    │
 ├────────┼────────┼───────────────────────────────────────────┤
 │     16 │ 96 × N │ entries[0..len]      CachedOracleEntry[]  │
 └────────┴────────┴───────────────────────────────────────────┘

 Serialized layout: 16 + (N × 96) bytes
 Allocated via `OraclePriceCache::space()`: 20 + (N × 96) bytes
 Example at 64 oracles: 6,160 bytes serialized, 6,164 bytes allocated
```

### CachedOracleEntry (96 bytes)

```
 CachedOracleEntry
 ┌────────┬────────┬───────────────────────────────────────────┐
 │ Offset │  Size  │ Field                                     │
 ├────────┼────────┼───────────────────────────────────────────┤
 │      0 │     32 │ oracle               Pubkey               │
 │     32 │      8 │ price                i64 (PRICE_PRECISION)│
 │     40 │      8 │ confidence           u64                  │
 │     48 │      8 │ delay                i64 (slots, at cache │
 │        │        │                      write time)           │
 │     56 │      8 │ cached_slot          u64 (Clock.slot when │
 │        │        │                      entry was written)    │
 │     64 │      8 │ publish_ts           u64 (source-native   │
 │        │        │                      publish timestamp,   │
 │        │        │                      0 if unavailable)    │
 │     72 │      1 │ oracle_source        u8 (OracleSource     │
 │        │        │                      discriminant)         │
 │     73 │      1 │ has_sufficient_      u8 (1 = yes, 0 = no) │
 │        │        │   data_points                              │
 │     74 │      1 │ max_age_slots_       u8 (0 = use cache    │
 │        │        │   override           default)              │
 │     75 │     21 │ _padding             reserved, must be 0  │
 └────────┴────────┴───────────────────────────────────────────┘
```

### remaining_accounts Layout

```
 FillPerpOrder2 remaining_accounts
 ┌───────────┬─────────────────────────────────────────────────┐
 │  Index    │ Account                                         │
 ├───────────┼─────────────────────────────────────────────────┤
 │  [0]      │ midprice_pino program (executable)              │
 │  [1..E]   │ live oracle accounts (optional, variable count) │
 │  [E..A]   │ spot market accounts                            │
 │  [A]      │ global PropAMM matcher PDA                      │
 │  [A+1..]  │ PropAMM accounts, maker Users, DLOB pairs, etc.│
 └───────────┴─────────────────────────────────────────────────┘

 E = oracles_end (detected by scanning until is_oracle_account returns false)
 A = amm_start  (detected by scanning for drift-owned PerpMarket/SpotMarket accounts)
```

The oracle boundary is discovered at runtime — `is_oracle_account()` checks
whether the account is owned by a known oracle program (Pyth, Switchboard,
etc.) or is a drift-owned PrelaunchOracle/PythLazerOracle. Scanning stops at
the first non-oracle account.

### Construction Flow

```
FillPerpOrder2
  │
  ├─ 1. OracleMap::load_one_with_cache(oracle, oracle_price_cache, slot)
  │      │
  │      ├─ load primary perp market oracle (live)
  │      └─ materialize fresh cache entries into price_data
  │
  ├─ 2. for remaining_accounts[1..]:
  │      │   if is_oracle_account → insert_live_oracle (evicts any cached value)
  │      │   else → stop, set oracles_end
  │      │
  │      └─ live oracles override any cache entry for same key
  │
  ├─ 3. load spot/perp market maps from remaining_accounts[oracles_end..]
  │
  └─ 4. per-maker margin check uses ordinary oracle_map.get_price_data()
         cache hit  → continue fill checks
         cache miss → skip the maker (not the whole fill)
```

### Keeper vs Matcher Responsibilities

```
                 ┌──────────────────────────────────────────┐
                 │            Keeper Bot                     │
                 │                                          │
                 │  Runs permissionless update_oracle_       │
                 │  price_cache on a timer (~every few       │
                 │  slots). Reads all live oracle accounts,  │
                 │  writes fresh snapshots into the cache    │
                 │  buffer. Maintains general freshness for  │
                 │  all oracles in the roster.               │
                 │                                          │
                 │  This handles the common case: most       │
                 │  makers' secondary oracles are fresh in   │
                 │  the cache and no live accounts needed.   │
                 └──────────────┬───────────────────────────┘
                                │ writes cache
                                ▼
                 ┌──────────────────────────────────────────┐
                 │        OraclePriceCache                  │
                 │  ┌─────────┐  ┌─────────┐               │
                 │  │Buffer 0 │  │Buffer 1 │               │
                 │  └─────────┘  └─────────┘               │
                 └──────────────┬───────────────────────────┘
                                │ read by matcher
                                ▼
                 ┌──────────────────────────────────────────┐
                 │          Matcher / Router                 │
                 │                                          │
                 │  Builds FillPerpOrder2 transactions.      │
                 │  Always includes oracle_price_cache.      │
                 │                                          │
                 │  Optionally pages in live oracles via     │
                 │  remaining_accounts[1..] when:            │
                 │  - cache entry is known to be stale       │
                 │  - maker would otherwise be skipped       │
                 │  - high-value fill justifies the extra    │
                 │    account slot + CU cost                 │
                 │                                          │
                 │  The decision is purely economic:          │
                 │  including a live oracle costs an account  │
                 │  slot but guarantees the maker won't be   │
                 │  skipped. Omitting it bets on the cache   │
                 │  being fresh enough.                      │
                 │                                          │
                 │  The system is correct either way — a      │
                 │  skipped maker just means that fill is     │
                 │  deferred, not lost.                       │
                 └──────────────────────────────────────────┘
```

When a maker's margin check hits `OracleNotFound`, the maker is skipped — not the
entire fill. This is the core safety property that makes bounded cache staleness
acceptable for fill-time margin checks: the fallback is always "defer this maker",
never "accept a maker without an oracle".


## Instructions

Three admin instructions (Anchor path) plus native fast-path variants for
keeper-hot-path operations (discriminator `0xFF 0xFF 0xFF 0xFF` + 1-byte
sub-discriminator). Admin authority is `state.admin` or the hot wallet.

### 1. initialize_oracle_price_cache

Creates both buffer PDAs for a given `cache_id` with `num_oracles` empty
entry slots. Entries start at `cached_slot = 0` (stale until keeper refreshes).

**Accounts:**

```
 ┌───┬──────────┬──────────────────────────────────────────────┐
 │ # │  Access  │ Account                                      │
 ├───┼──────────┼──────────────────────────────────────────────┤
 │ 0 │ mut,sign │ admin                                        │
 │ 1 │ readonly │ state                                        │
 │ 2 │ mut,init │ oracle_price_cache_0  PDA ["oracle_price_    │
 │   │          │   cache", cache_id, 0]                       │
 │ 3 │ mut,init │ oracle_price_cache_1  PDA ["oracle_price_    │
 │   │          │   cache", cache_id, 1]                       │
 │ 4 │ readonly │ rent                                         │
 │ 5 │ readonly │ system_program                                │
 └───┴──────────┴──────────────────────────────────────────────┘
```

**Instruction data:**

```
 ┌────────┬────────┬───────────────────────────────────────────┐
 │ Offset │  Size  │ Field                                     │
 ├────────┼────────┼───────────────────────────────────────────┤
 │      0 │      1 │ cache_id             u8                   │
 │      1 │      2 │ num_oracles          u16                  │
 └────────┴────────┴───────────────────────────────────────────┘
```

### 2. set_oracle_cache_entries

Replaces the oracle roster in both buffers. Handles grow/shrink via Anchor
realloc. Prices reset to 0 / `cached_slot = 0` (stale until keeper refreshes).

Also available as native fast-path (sub-discriminator `2`).

**Accounts (Anchor path):**

```
 ┌───┬──────────┬──────────────────────────────────────────────┐
 │ # │  Access  │ Account                                      │
 ├───┼──────────┼──────────────────────────────────────────────┤
 │ 0 │ mut,sign │ admin                                        │
 │ 1 │ readonly │ state                                        │
 │ 2 │ mut      │ oracle_price_cache_0  (realloc)              │
 │ 3 │ mut      │ oracle_price_cache_1  (realloc)              │
 │ 4 │ readonly │ rent                                         │
 │ 5 │ readonly │ system_program                                │
 └───┴──────────┴──────────────────────────────────────────────┘
```

**Accounts (native fast-path, sub-discriminator `2`):**

```
 ┌───┬──────────┬──────────────────────────────────────────────┐
 │ # │  Access  │ Account                                      │
 ├───┼──────────┼──────────────────────────────────────────────┤
 │ 0 │ mut,sign │ admin                                        │
 │ 1 │ readonly │ state                                        │
 │ 2 │ mut      │ oracle_price_cache_0                         │
 │ 3 │ mut      │ oracle_price_cache_1                         │
 │ 4 │ readonly │ system_program                                │
 │ 5 │ readonly │ rent                                         │
 └───┴──────────┴──────────────────────────────────────────────┘
```

**Instruction data (both paths):**

```
 ┌────────┬────────┬───────────────────────────────────────────┐
 │ Offset │  Size  │ Field                                     │
 ├────────┼────────┼───────────────────────────────────────────┤
 │      0 │      4 │ entries_len          u32 (Borsh Vec len)  │
 │      4 │ 34 × N │ entries[0..N]        OracleCacheEntryParams│
 └────────┴────────┴───────────────────────────────────────────┘

 OracleCacheEntryParams  (34 bytes)
 ┌────────┬────────┬───────────────────────────────────────────┐
 │ Offset │  Size  │ Field                                     │
 ├────────┼────────┼───────────────────────────────────────────┤
 │      0 │     32 │ oracle               Pubkey               │
 │     32 │      1 │ oracle_source        u8 (OracleSource)    │
 │     33 │      1 │ max_age_slots_override  u8 (0 = default)  │
 └────────┴────────┴───────────────────────────────────────────┘
```

### 3. update_oracle_price_cache (keeper, permissionless)

Reads live oracle accounts from remaining_accounts (Anchor) or accounts[1..]
(native) and writes fresh snapshots into matching cache entries. Only writes
if the live data is newer than the cached entry. For oracle sources that expose
publish timestamps, that field is stored and compared directly.
For sources that do not, the fallback rule is still at most one write per slot.
No signer required.

Also available as native fast-path (sub-discriminator `3`).

**Accounts (Anchor path):**

```
 ┌───┬──────────┬──────────────────────────────────────────────┐
 │ # │  Access  │ Account                                      │
 ├───┼──────────┼──────────────────────────────────────────────┤
 │ 0 │ mut      │ oracle_price_cache    (one buffer)           │
 │ … │ readonly │ remaining_accounts:                          │
 │   │          │   live oracle accounts to refresh             │
 └───┴──────────┴──────────────────────────────────────────────┘
```

**Accounts (native fast-path, sub-discriminator `3`):**

```
 ┌───┬──────────┬──────────────────────────────────────────────┐
 │ # │  Access  │ Account                                      │
 ├───┼──────────┼──────────────────────────────────────────────┤
 │ 0 │ mut      │ oracle_price_cache    (one buffer)           │
 │ 1… │ readonly │ live oracle accounts to refresh              │
 └───┴──────────┴──────────────────────────────────────────────┘
```

**Instruction data:** None (empty payload).

**Behavior:**

```
For each live oracle account provided:
- find entry where entry.oracle == account.key()
- read price via get_oracle_price(source, account, slot)
- if the oracle read exposes a publish timestamp, skip unless it is strictly greater than the stored `publish_ts`
- otherwise skip if entry.cached_slot >= current_slot
- write price, confidence, delay, cached_slot, publish_ts, oracle_source,
  has_sufficient_data_points into the entry
```

### 4. update_oracle_cache_config

Updates `max_age_slots` on both buffers for a given cache.

Also available as native fast-path (sub-discriminator `4`).

**Accounts (Anchor path):**

```
 ┌───┬──────────┬──────────────────────────────────────────────┐
 │ # │  Access  │ Account                                      │
 ├───┼──────────┼──────────────────────────────────────────────┤
 │ 0 │ mut,sign │ admin                                        │
 │ 1 │ readonly │ state                                        │
 │ 2 │ mut      │ oracle_price_cache_0                         │
 │ 3 │ mut      │ oracle_price_cache_1                         │
 └───┴──────────┴──────────────────────────────────────────────┘
```

**Accounts (native fast-path, sub-discriminator `4`):**

```
 ┌───┬──────────┬──────────────────────────────────────────────┐
 │ # │  Access  │ Account                                      │
 ├───┼──────────┼──────────────────────────────────────────────┤
 │ 0 │ mut,sign │ admin                                        │
 │ 1 │ readonly │ state                                        │
 │ 2 │ mut      │ oracle_price_cache_0                         │
 │ 3 │ mut      │ oracle_price_cache_1                         │
 └───┴──────────┴──────────────────────────────────────────────┘
```

**Instruction data:**

```
 ┌────────┬────────┬───────────────────────────────────────────┐
 │ Offset │  Size  │ Field                                     │
 ├────────┼────────┼───────────────────────────────────────────┤
 │      0 │      1 │ max_age_slots        u8                   │
 └────────┴────────┴───────────────────────────────────────────┘
```

## Native Fast-Path

The Drift program exposes a native entrypoint for performance-critical
cache operations, bypassing Anchor deserialization overhead. The wire format
uses a 5-byte prefix instead of the 8-byte Anchor discriminator:

```
 Native instruction prefix
 ┌────────┬────────┬───────────────────────────────────────────┐
 │ Offset │  Size  │ Field                                     │
 ├────────┼────────┼───────────────────────────────────────────┤
 │      0 │      4 │ magic                0xFF 0xFF 0xFF 0xFF  │
 │      4 │      1 │ sub_discriminator    u8                   │
 │        │        │   2 = set_oracle_cache_entries             │
 │        │        │   3 = update_oracle_price_cache            │
 │        │        │   4 = update_oracle_cache_config           │
 │      5 │  var   │ payload              (instruction-specific)│
 └────────┴────────┴───────────────────────────────────────────┘
```
