# PropAMM Feature Rollout Plan

This document covers the devnet deployment sequence for the PropAMM feature set
on the `spike/prop-amm` branch, and tracks which action items ship now vs later.

## Action Items: Now vs Later

### Ship now (this branch)

| Item | Why now |
|------|---------|
| Hot-wallet authority on registry ixs | One-line change to `validate_prop_amm_registry_authority`. Required for any automated ban flow. Without it, every disable requires cold admin signing. |

### Ship later (upgrade)

| Item | Why safe to defer | Migration cost |
|------|-------------------|----------------|
| Ban metadata fields on `PropAmmRegistryEntry` (ban_reason, banned_at_slot, ban_expiry_slot) | Registry is a single PDA with a `version` field. `save_prop_amm_registry` already reallocs on every write. A v1→v2 migration ix reads old 99-byte entries, writes new entries with extra fields zeroed, bumps version. One tx, no user-facing downtime. | Low — single-account migration ix |
| Cooldown system (auto-unban after N slots) | Requires ban metadata fields first. Enforcement is offchain (routers read registry). Can also be purely offchain until the metadata fields land. | Low — offchain logic + migration ix |
| Reserved bytes validation on PropAMMAccount header (offset 88) | Spec says "must be 0" but no parser uses these bytes today. Can add validation in a future `midprice_book_view` release without on-chain migration. | Zero |
| Skipped-fill logging in midprice_pino | Observability improvement only. Some `apply_fills` skip paths silently `continue`. Can add `msg!()` logs in a future deploy. | Zero |
| SDK admin wrappers for registry ixs (`approvePropAmms`, `disablePropAmms`, `removePropAmms`) | PDA helpers already exist in `pda.ts`. Can build ixs manually for devnet bootstrap. Wrappers needed before mainnet tooling. | Low — SDK only |
| Evidence bundle pointer (anti-spoofing) | Offchain concern. Keyed by propamm_account pubkey in S3/IPFS. No on-chain field needed. | Zero |
| Anchor-path exposure for oracle cache ixs (set_entries, update, update_config) | Native fast-path (0xFF prefix) is wired up and functional. Anchor paths exist as handlers but aren't in `#[program]`. Only matters if tooling needs IDL-based calls. | Low — lib.rs wiring |

### Why the registry is easy to migrate

The `PropAmmRegistry` is migration-friendly by design:

1. **Single PDA** — `seeds = ["prop_amm_registry"]`. One account to migrate, not thousands.
2. **Version field** — `load_prop_amm_registry` already checks `registry.version == PROP_AMM_REGISTRY_VERSION`. A migration ix can read v1 layout and write v2.
3. **Dynamic realloc** — `save_prop_amm_registry` reallocs to `PropAmmRegistry::space(N)` on every write. Changing entry size from 99 to e.g. 128 bytes just works after migration.
4. **Small entry count** — Tens of entries, not thousands. Migration fits in one tx.

Migration ix pseudocode:
```
fn migrate_prop_amm_registry_v2(ctx) {
    // read raw account data
    // parse N entries at 99-byte stride (v1 layout)
    // realloc to N * 128 bytes (v2 layout)
    // write entries with new fields zeroed (ban_reason=0, slots=0, padding=0)
    // set version = 2
}
```

No urgency to add padding now. The migration path is clean.

---

## Devnet Bootstrap Sequence

### Prerequisites

1. **Drift program** deployed to devnet (or upgraded with this branch)
2. **midprice_pino program** deployed to devnet — record its program ID
3. Drift State initialized (`initialize` ix) — record `state.admin` keypair
4. At least one perp market initialized (e.g. SOL-PERP, market_index=0)
5. Oracle accounts live on devnet (Pyth devnet feeds or mock oracles)

### Accounts to create

| # | Account | PDA Seeds | Created by |
|---|---------|-----------|------------|
| 1 | OraclePriceCache buffer 0 | `["oracle_price_cache", 0, 0]` | `initialize_oracle_price_cache` |
| 2 | OraclePriceCache buffer 1 | `["oracle_price_cache", 0, 1]` | `initialize_oracle_price_cache` |
| 3 | Maker UserStats | `["user_stats", maker_authority]` | `initialize_user_stats` |
| 4 | Maker User (subaccount) | `["user", maker_authority, subaccount_id]` | `initialize_user` |
| 5 | PropAMMAccount | owned by midprice_pino | midprice_pino init ix |
| 6 | PropAMM Matcher | `["prop_amm_matcher"]` | `approve_prop_amms` (lazy) |
| 7 | PropAMM Registry | `["prop_amm_registry"]` | `approve_prop_amms` (lazy) |

### Step 1 — Oracle Price Cache

```
# 1a. Create double-buffered cache with slots for all oracles you need
initialize_oracle_price_cache(cache_id=0, num_oracles=<N>)
  signer: state.admin
  accounts: [admin, state, cache_0 (init), cache_1 (init), rent, system_program]

# 1b. Populate oracle roster in both buffers
set_oracle_cache_entries(cache_id=0, entries=[
    { oracle: SOL_ORACLE,  oracle_source: Pyth, max_age_slots_override: 0 },
    { oracle: USDC_ORACLE, oracle_source: Pyth, max_age_slots_override: 0 },
    ... one per market oracle ...
])
  signer: state.admin (or admin_hot_wallet)
  use: native fast-path (0xFF_FF_FF_FF 0x02 <payload>) or SDK adminClient.setOracleCacheEntries()

# 1c. Keeper: refresh cache prices (permissionless, repeat on timer)
update_oracle_price_cache(cache_id=0, buffer_index=0, oracles=[SOL_ORACLE, USDC_ORACLE, ...])
update_oracle_price_cache(cache_id=0, buffer_index=1, oracles=[SOL_ORACLE, USDC_ORACLE, ...])
  no signer required
```

### Step 2 — Maker account

```
# 2a. Initialize maker authority's UserStats
initialize_user_stats()
  signer: maker_authority

# 2b. Initialize maker subaccount (Drift User PDA)
initialize_user(subaccount_id=0, name="propamm-maker")
  signer: maker_authority
  → record maker_user_pda = PDA["user", maker_authority, 0]

# 2c. Deposit collateral into maker subaccount
deposit(market_index=0 (USDC spot), amount=<collateral>)
  signer: maker_authority
```

### Step 3 — PropAMM account (midprice_pino side)

```
# 3a. Initialize PropAMMAccount on midprice_pino
#     Sets: discriminator "prammacc", version=1, flags=0, header_len,
#           market_index, maker_subaccount, reference_price, valid_until_slot
  signer: maker_authority (or designated PropAMM authority)

# 3b. Set initial quotes
set_orders(reference_price=<oracle_mid>, asks=[...], bids=[...], valid_until_slot=<future>)
  signer: PropAMM authority
```

### Step 4 — Registry approval

```
# 4a. Approve the PropAMM in the registry
#     Lazily creates prop_amm_matcher + prop_amm_registry PDAs on first call
approve_prop_amms(entries=[{
    market_index: 0,
    maker_subaccount: <maker_user_pda>,
    propamm_program: <midprice_pino_program_id>,
    propamm_account: <propamm_account_pubkey>,
}])
  signer: state.admin
  remaining_accounts: [propamm_account]  // ownership validated against propamm_program
```

### Step 5 — End-to-end fill test

```
# 5a. Taker places a market order
place_perp_order(market_index=0, direction=Long, base_asset_amount=1_000_000, order_type=Market)
  signer: taker_authority

# 5b. Cranker fills against PropAMM
fill_perp_order2(
    taker: taker_user_pda,
    taker_stats: taker_user_stats,
    oracle: SOL_ORACLE,
    oracle_price_cache: cache_buffer_0_pda,   // or buffer_1
    remaining_accounts: [
        midprice_pino_program,                 // [0] executable
        # <optional live oracles>,             # [1..E] if needed
        # <spot markets for margin>,           # [E..A]
        prop_amm_matcher_pda,                  // [A]
        propamm_account,                       // [A+1]
        maker_user_pda,                        // [A+2]
        # maker_user_stats,                    # if DLOB pair
        # filler, filler_stats,                # optional for rewards
    ]
)
  signer: cranker (permissionless)
```

### Step 6 — Verify

```
# Check registry state
# SDK: adminClient.program.account.propAmmRegistry.fetch(registryPda)

# Check cache freshness
# SDK: read OraclePriceCache account, inspect cached_slot vs current slot

# Check fill events
# Subscribe to Drift event logs for FillPerpOrder2 / PropAMM fill records
```

---

## Smoke-test checklist

- [ ] Oracle cache initialized (both buffers)
- [ ] Oracle cache populated with market oracles
- [ ] Keeper refreshing cache prices (both buffers, ~every few slots)
- [ ] Maker User PDA funded with collateral
- [ ] PropAMMAccount initialized and quoting (valid_until_slot in future)
- [ ] Registry entry approved (status=active)
- [ ] Taker order placed
- [ ] fill_perp_order2 succeeds — taker filled against PropAMM
- [ ] apply_fills CPI fires — PropAMMAccount book levels decremented
- [ ] Maker User position updated
- [ ] disable_prop_amms — cranker stops routing to disabled PropAMM
