# PropAMM Interface V1

This document defines the standard for Drift integration with arbitrary PropAMM programs.
A program must adhere to the following to be compatible:

1. Maintain a `PropAMMAccount` for the public quote surface
   A program-owned account with standardized data layout, consisting of a header and quote levels

2. Implement the `apply_fills` hook
   Post-match CPI hook Drift calls after settling the trade

3. Be registered in the on-chain PropAMM registry
   Admin-approved `(propamm_program, propamm_account, maker_subaccount, market_index)` tuples

## Terminology

- `propamm_program` — an executable Solana program that owns PropAMM accounts
- `propamm_account` — a data account owned by a `propamm_program`
- `prop_amm_registry` — on-chain Drift account listing approved program/account pairs
- `drift_propamm_matcher` — Drift PDA (`seeds = ["prop_amm_matcher"]`) that signs `apply_fills` CPI
- Drift loads `propamm_account` read-only during matching
- Drift CPI-calls `propamm_program` during `apply_fills`

## Registration

Before a PropAMM program+account pair can participate in matching, it must be
registered by the Drift admin via `approve_prop_amms`. The registry stores:

```
PropAmmRegistryEntry {
    status:           u8,      // 0 = disabled, 1 = active
    market_index:     u16,
    maker_subaccount: Pubkey,  // Drift User PDA
    propamm_program:  Pubkey,  // executable program that owns the account
    propamm_account:  Pubkey,  // the PropAMMAccount data account
}
```

During matching, Drift validates each PropAMM account against the registry:
- The account key must match an active entry's `propamm_account`
- The account's owner must match the entry's `propamm_program`
- The paired maker must match the entry's `maker_subaccount`
- The market index from the account header must match the entry's `market_index`

Entries can be disabled (`disable_prop_amms`) or removed (`remove_prop_amms`).

## Tick and step-size enforcement

Drift enforces the perp market's `order_tick_size` and `order_step_size` at
matching time. PropAMM programs do **not** need to track or enforce these
parameters — Drift is the authority.

Effective prices from PropAMM book levels are rounded to the market tick grid
using the standard passive-favorable convention (same as `standardize_price`
used for Drift limit orders):

```
Ask (maker selling):  round UP    →  ceil(price / tick_size) * tick_size
Bid (maker buying):   round DOWN  →  floor(price / tick_size) * tick_size
```

After rounding, the level must still cross the taker's limit price. If it does
not, the level is skipped.

Level sizes are truncated to the nearest `order_step_size`:

```
fill_size = floor(base_asset_amount / step_size) * step_size
```

If the truncated size is zero, the level is skipped.

This means PropAMM programs are free to quote at any granularity. Drift will
align fills to the market grid before matching. Programs MAY optionally
enforce tick sizes internally (for better maker UX / quote validation), but
this is not required for protocol correctness.

## Initialization and account management

Drift does **not** mediate PropAMM account initialization or configuration.
These are between the maker and their PropAMM program directly.

The `drift_propamm_matcher` PDA is deterministic:
`PDA(drift_program_id, ["prop_amm_matcher"])`. PropAMM programs that need to
verify the matcher at `apply_fills` time can derive it from a known Drift
program ID without needing Drift to co-sign during initialization.

## API 1: PropAMMAccount

The `PropAMMAccount` is the public quote surface Drift and offchain systems parse.

- owned by a registered `propamm_program`
- read directly by Drift matcher from passed account data
- read by offchain indexers / UIs / crankers
- contains all fillable PropAMM liquidity
- may also contain program-defined opaque bytes

### Account Layout

All fields are little-endian, packed with no alignment padding.
Implementations should use `#[repr(C, packed)]` or explicit LE byte reads.

```
 PropAMMAccount
 ┌─────────────────────────────────────────────────────────────┐
 │                     STANDARDIZED HEADER                     │
 │  (96 bytes minimum, actual size = header_len)               │
 ├────────┬────────┬───────────────────────────────────────────┤
 │ Offset │  Size  │ Field                                     │
 ├────────┼────────┼───────────────────────────────────────────┤
 │      0 │      8 │ discriminator        "prammacc" (ASCII)   │
 │      8 │      1 │ version              1                    │
 │      9 │      1 │ flags                reserved, must be 0  │
 │     10 │      2 │ header_len           u16, >= 96           │
 │     12 │      2 │ market_index         u16                  │
 │     14 │     32 │ maker_subaccount     Pubkey (Drift User   │
 │        │        │                      PDA: seeds = ["user",│
 │        │        │                      authority,            │
 │        │        │                      subaccount_id])       │
 │     46 │      8 │ sequence_number      u64, bump on change  │
 │     54 │      8 │ valid_until_slot     u64, live iff        │
 │        │        │                      slot <= this value    │
 │     62 │      8 │ reference_price      u64, reprices the    │
 │        │        │                      whole ladder in O(1)  │
 │     70 │      4 │ quote_data_offset    u32, byte offset of  │
 │        │        │                      Quote Block start     │
 │     74 │      4 │ quote_data_len       u32, total byte len  │
 │        │        │                      of Quote Block        │
 │     78 │      2 │ ask_len              u16                  │
 │     80 │      2 │ bid_len              u16                  │
 │     82 │      2 │ ask_head             u16                  │
 │     84 │      2 │ bid_head             u16                  │
 │     86 │      2 │ level_entry_size     u16, >= 10           │
 │     88 │      8 │ reserved             must be 0            │
 ├────────┴────────┴───────────────────────────────────────────┤
 │                     OPAQUE REGION (optional)                │
 │  [header_len .. quote_data_offset)                          │
 │  Program-defined bytes. Drift does not read this region.    │
 ├─────────────────────────────────────────────────────────────┤
 │                     QUOTE BLOCK                             │
 │  [quote_data_offset .. quote_data_offset + quote_data_len)  │
 │                                                             │
 │  ┌───────────────────────────────────────────────────────┐  │
 │  │ asks[0..ask_len]   each level_entry_size bytes        │  │
 │  │ bids[0..bid_len]   each level_entry_size bytes        │  │
 │  └───────────────────────────────────────────────────────┘  │
 │                                                             │
 ├─────────────────────────────────────────────────────────────┤
 │                     OPAQUE TAIL (optional)                  │
 │  [quote_data_offset + quote_data_len .. account_data_len)   │
 │  Program-defined bytes. Drift does not read this region.    │
 └─────────────────────────────────────────────────────────────┘
```

### Level Entry Layout (PropAMMLevelV1)

The first 10 bytes of each level entry are standardized.
Programs may append per-level opaque bytes if `level_entry_size > 10`.

```
 PropAMMLevelV1   (minimum 10 bytes)
 ┌────────┬────────┬───────────────────────────────────────────┐
 │ Offset │  Size  │ Field                                     │
 ├────────┼────────┼───────────────────────────────────────────┤
 │      0 │      2 │ tick_count           u16, ticks from ref  │
 │        │        │   ask price = ref + tick_count * tick_size │
 │        │        │   bid price = ref - tick_count * tick_size │
 │      2 │      8 │ base_asset_amount    u64, remaining size   │
 ├────────┼────────┼───────────────────────────────────────────┤
 │     10 │  var   │ (opaque, if level_entry_size > 10)        │
 └────────┴────────┴───────────────────────────────────────────┘
```

### Header Flags

The `flags` field is reserved for future use. In V1, all bits must be zero. Parsers must reject accounts where `flags != 0` to ensure forward compatibility — future versions may use flag bits to alter parsing behavior (e.g., indicating compressed quote data or alternative level formats).

### PropAMMAccount Rules

```
Ownership:
- PropAMMAccount.owner == propamm_program (registered in PropAMM registry)

Binding:
- maker_subaccount == Drift User PDA (derived as PDA(drift_program, ["user", authority, subaccount_id]))
- market_index == taker market_index

Liveness:
- current_slot <= valid_until_slot

Parsing:
- header_len must be at least 96 (V1 header size)
- quote_data_offset must point inside the account
- quote_data_len must fit inside the account
- quote_data_len must be large enough for ask_len + bid_len entries at level_entry_size
- ask_len + bid_len must not exceed 128 (prevents unbounded parsing CU)

Pricing:
- tick_count > 0 for all live levels (0 is invalid)
- ask price = reference_price + tick_count * tick_size
- bid price = reference_price - tick_count * tick_size
- On-tick by construction; Drift may additionally round to market tick grid (passive-favorable)

Ordering (hard requirement — misordered books cause the matcher to skip valid fills):
- live asks MUST be sorted ascending by effective price
- live bids MUST be sorted descending by effective price

State updates:
- bump sequence_number on any executable change
- advance ask_head / bid_head as leading levels empty
```

## API 2: apply_fills CPI

Drift calls this instruction on the PropAMM program via CPI **after** it has
already settled the taker and maker positions. The call notifies the PropAMM of
what was filled so it can update its book.

### Hard requirements

1. **The instruction discriminator is a single byte: opcode `3`.**

2. **The instruction MUST always return `Ok(())`.**
   Drift settles positions *before* the CPI. If the CPI reverts, the maker
   holds a position delta with no book update, and the same fills could be
   re-applied on the next match (double-fill). Invalid fills must be silently
   skipped, never reverted.

3. **The instruction MUST accept these accounts, in order:**

```
 Accounts
 ┌───┬──────────┬──────────────────────────────────────────────┐
 │ # │  Access  │ Account                                      │
 ├───┼──────────┼──────────────────────────────────────────────┤
 │ 0 │ signer   │ drift_propamm_matcher  (Drift PDA signer)   │
 │ 1 │ readonly │ clock  (Sysvar)                              │
 │ 2…│ writable │ propamm_account_0, propamm_account_1, ...   │
 └───┴──────────┴──────────────────────────────────────────────┘
```

Multiple PropAMM accounts may be batched in a single CPI (one per maker).

4. **The instruction data MUST follow this wire format** (after the 1-byte
   opcode):

```
 Instruction Data  (variable length)
 ┌────────┬────────┬───────────────────────────────────────────┐
 │ Offset │  Size  │ Field                                     │
 ├────────┼────────┼───────────────────────────────────────────┤
 │      0 │      2 │ market_index              u16             │
 ├────────┼────────┼───────────────────────────────────────────┤
 │        │        │ Per-maker batch (repeated for each        │
 │        │        │ propamm_account in accounts[2..]):        │
 │      — │      2 │   fills_len                 u16           │
 │      — │      8 │   expected_sequence_number  u64           │
 │      — │ 11 × N │   fills[0..fills_len]       FillRefV1[]  │
 └────────┴────────┴───────────────────────────────────────────┘

 FillRefV1  (11 bytes, packed)
 ┌────────┬────────┬───────────────────────────────────────────┐
 │ Offset │  Size  │ Field                                     │
 ├────────┼────────┼───────────────────────────────────────────┤
 │      0 │      2 │ abs_index       u16, index in book        │
 │      2 │      1 │ is_ask          u8, 1 = ask, 0 = bid     │
 │      3 │      8 │ fill_size       u64, base amount filled   │
 └────────┴────────┴───────────────────────────────────────────┘
```

### Validation the PropAMM program MUST perform

For each fill entry the program must check all of the following. Any fill that
fails a check is silently skipped (not reverted).

```
- signer == Drift global PropAMM matcher PDA
- market_index == PropAMMAccount.market_index
- expected_sequence_number == PropAMMAccount.sequence_number
- current_slot <= PropAMMAccount.valid_until_slot
- fill_size > 0
- is_ask/level_index refers to a valid level within the book
- fill_size <= level's current base_asset_amount
```

### State updates on valid fills

```
- decrement the filled level's base_asset_amount by fill_size
- advance ask_head / bid_head past any fully consumed leading levels
- bump sequence_number
- optionally update opaque program-defined bytes in PropAMMAccount
- implementations SHOULD log skipped fills for observability
```

## Remaining accounts layout (FillPerpOrder2)

The `FillPerpOrder2` instruction uses `remaining_accounts` with this layout:

```
[propamm_program]
[live_oracle_0, live_oracle_1, ...]    (optional, for maker margin cache)
[spot_market_0, spot_market_1, ...]    (collateral markets)
[matcher_PDA]
(propamm_account, maker_user)*         (PropAMM pairs, detected by "prammacc" discriminator)
(dlob_user, dlob_user_stats)*          (DLOB maker pairs)
[referrer_user, referrer_stats]        (optional)
```
