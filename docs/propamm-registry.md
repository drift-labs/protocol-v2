# PropAMM Registry V1

The PropAMM Registry is a Drift-owned global account that records which
PropAMM accounts are approved for order matching. It is the protocol's
canonical whitelist of known-good PropAMMs.

- global (not per-market)
- consumed offchain by matchers, crankers, and UIs — not read on-chain
  during `fill_perp_order2`
- does not gate PropAMM account initialization
- admin-managed today, extensible to hot-wallet authority later
- generic across PropAMM programs (`midprice_pino` is the default by convention)

## Account Layout

One singleton PDA account owned by the Drift program.

```
 PDA seeds: ["prop_amm_registry"]

 PropAmmRegistry
 ┌────────┬────────┬───────────────────────────────────────────┐
 │ Offset │  Size  │ Field                                     │
 ├────────┼────────┼───────────────────────────────────────────┤
 │      0 │      8 │ discriminator        (Anchor account)     │
 │      8 │      1 │ version              u8, currently 1      │
 │      9 │      4 │ entries_len          u32 (Borsh Vec len)  │
 │     13 │ 99 × N │ entries[0..N]        PropAmmRegistryEntry │
 └────────┴────────┴───────────────────────────────────────────┘

 Total size: 8 + 1 + 4 + (N × 99) bytes
```

### PropAmmRegistryEntry (99 bytes)

```
 PropAmmRegistryEntry
 ┌────────┬────────┬───────────────────────────────────────────┐
 │ Offset │  Size  │ Field                                     │
 ├────────┼────────┼───────────────────────────────────────────┤
 │      0 │      1 │ status              u8                    │
 │        │        │   0 = disabled                            │
 │        │        │   1 = active                              │
 │      1 │      2 │ market_index        u16                   │
 │      3 │     32 │ maker_subaccount    Pubkey                │
 │     35 │     32 │ propamm_program     Pubkey                │
 │     67 │     32 │ propamm_account     Pubkey                │
 └────────┴────────┴───────────────────────────────────────────┘
```

### Uniqueness

An entry is identified by its composite key:

```
(market_index, maker_subaccount, propamm_program, propamm_account)
```

No two entries in the registry may share the same key. `approve_prop_amms`
enforces this by upserting — re-enabling an existing disabled entry rather
than inserting a duplicate.

## Instructions

All three instructions are admin-only (`state.admin` must sign).

### 1. approve_prop_amms

Inserts new entries or re-enables disabled ones. Creates the registry PDA
and the PropAMM matcher PDA if they do not yet exist.

**Accounts:**

```
 ┌───┬──────────┬──────────────────────────────────────────────┐
 │ # │  Access  │ Account                                      │
 ├───┼──────────┼──────────────────────────────────────────────┤
 │ 0 │ mut,sign │ admin                                        │
 │ 1 │ readonly │ state                                        │
 │ 2 │ mut      │ prop_amm_matcher     PDA ["prop_amm_matcher"]│
 │ 3 │ mut      │ prop_amm_registry    PDA ["prop_amm_registry"]│
 │ 4 │ readonly │ rent                                         │
 │ 5 │ readonly │ system_program                                │
 │ … │ readonly │ remaining_accounts:                          │
 │   │          │   one propamm_account per entry, in order    │
 └───┴──────────┴──────────────────────────────────────────────┘
```

**Instruction data:**

```
 ┌────────┬────────┬───────────────────────────────────────────┐
 │ Offset │  Size  │ Field                                     │
 ├────────┼────────┼───────────────────────────────────────────┤
 │      0 │      4 │ entries_len          u32 (Borsh Vec len)  │
 │      4 │ 98 × N │ entries[0..N]        PropAmmApprovalParams│
 └────────┴────────┴───────────────────────────────────────────┘

 PropAmmApprovalParams  (98 bytes)
 ┌────────┬────────┬───────────────────────────────────────────┐
 │ Offset │  Size  │ Field                                     │
 ├────────┼────────┼───────────────────────────────────────────┤
 │      0 │      2 │ market_index        u16                   │
 │      2 │     32 │ maker_subaccount    Pubkey                │
 │     34 │     32 │ propamm_program     Pubkey                │
 │     66 │     32 │ propamm_account     Pubkey                │
 └────────┴────────┴───────────────────────────────────────────┘
```

**Validation:**

```
- admin == state.admin
- no duplicate keys within a single request
- for each entry[i]:
    remaining_accounts[i].key() == entry.propamm_account
    remaining_accounts[i].owner == entry.propamm_program
- existing entries with the same key are re-enabled (upsert), not duplicated
```

### 2. disable_prop_amms

Sets `status = 0` on matching entries. Idempotent — disabling an already
disabled or nonexistent entry is a no-op.

**Accounts:**

```
 ┌───┬──────────┬──────────────────────────────────────────────┐
 │ # │  Access  │ Account                                      │
 ├───┼──────────┼──────────────────────────────────────────────┤
 │ 0 │ mut,sign │ admin                                        │
 │ 1 │ readonly │ state                                        │
 │ 2 │ mut      │ prop_amm_registry    PDA ["prop_amm_registry"]│
 │ 3 │ readonly │ system_program                                │
 └───┴──────────┴──────────────────────────────────────────────┘
```

**Instruction data:**

```
 ┌────────┬────────┬───────────────────────────────────────────┐
 │ Offset │  Size  │ Field                                     │
 ├────────┼────────┼───────────────────────────────────────────┤
 │      0 │      4 │ keys_len             u32 (Borsh Vec len)  │
 │      4 │ 98 × N │ keys[0..N]           PropAmmKey           │
 └────────┴────────┴───────────────────────────────────────────┘

 PropAmmKey  (98 bytes)
 ┌────────┬────────┬───────────────────────────────────────────┐
 │ Offset │  Size  │ Field                                     │
 ├────────┼────────┼───────────────────────────────────────────┤
 │      0 │      2 │ market_index        u16                   │
 │      2 │     32 │ maker_subaccount    Pubkey                │
 │     34 │     32 │ propamm_program     Pubkey                │
 │     66 │     32 │ propamm_account     Pubkey                │
 └────────┴────────┴───────────────────────────────────────────┘
```

### 3. remove_prop_amms

Physically removes matching entries from the registry (swap-remove).
Idempotent — removing a nonexistent entry is a no-op.

**Accounts:** Same as `disable_prop_amms`.

**Instruction data:** Same as `disable_prop_amms`.

## Consumption

```
Onchain:
- The registry is NOT read during fill_perp_order2.
- Matching does not enforce registry membership — any valid PropAMMAccount
  passed to the matcher will be filled if it meets the interface spec.

Offchain:
- Crankers, DLOB servers, and UIs SHOULD read the registry to determine
  which PropAMM accounts to include in fill transactions.
- Only entries with status == 1 (active) should be used.
- The registry is the source of truth for which (program, account) pairs
  are sanctioned by the protocol admin.
```

## Assumptions

```
- Registry is canonical onchain metadata for offchain systems
- Matching whitelist enforcement is offchain only
- PropAMM account initialization remains ungated (any program can create one)
- state.admin is the sole authority (no delegated hot-wallet yet)
```
