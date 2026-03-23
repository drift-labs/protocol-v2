# PropAMM Interface V1

This document defines the standard for Drift integration with arbitrary PropAMM programs.
A program must adhere to the following constructions to be compatible:

1. Maintain a `PropAMMAccount` for the public quote surface
   A program-owned account with standardized data layout, consisting of a header and executable quote representation

2. Implement the `apply_fills` hook
   This is the post-match CPI hook Drift calls after it settles the trade

Program vs account:

- `propamm_program` is an executable Solana program
- `propamm_account` is a data account owned by a designated `propamm_program`
- Drift loads `propamm_account` during matching
- Drift CPI-calls `propamm_program` during `apply_fills`

## API 1: PropAMMAccount

The `PropAMMAccount` is the public quote surface Drift and offchain systems parse.

- owned by a user-designated PropAMM program
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
 │     86 │      2 │ level_entry_size     u16, >= 16           │
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

The first 16 bytes of each level entry are standardized.
Programs may append per-level opaque bytes if `level_entry_size > 16`.

```
 PropAMMLevelV1   (minimum 16 bytes)
 ┌────────┬────────┬───────────────────────────────────────────┐
 │ Offset │  Size  │ Field                                     │
 ├────────┼────────┼───────────────────────────────────────────┤
 │      0 │      8 │ price_offset         i64, signed          │
 │        │        │   effective = reference_price + offset     │
 │      8 │      8 │ base_asset_amount    u64, remaining size   │
 ├────────┼────────┼───────────────────────────────────────────┤
 │     16 │  var   │ (opaque, if level_entry_size > 16)        │
 └────────┴────────┴───────────────────────────────────────────┘
```

### Header Flags

The `flags` field is reserved for future use. In V1, all bits must be zero. Parsers must reject accounts where `flags != 0` to ensure forward compatibility — future versions may use flag bits to alter parsing behavior (e.g., indicating compressed quote data or alternative level formats).

### PropAMMAccount Rules

```
Ownership:
- PropAMMAccount.owner == propamm_program

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
- ask offsets > 0
- bid offsets < 0
- ask price = reference_price + positive offset
- bid price = reference_price - abs(negative offset)

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

1. **The instruction MUST be named `apply_fills`** (Anchor discriminator:
   `sha256("global:apply_fills")[..8]`).

2. **The instruction MUST always return `Ok(())`.**
   Drift settles positions *before* the CPI. If the CPI reverts, the maker
   holds a position delta with no book update, and the same fills could be
   re-applied on the next match (double-fill). Invalid fills must be silently
   skipped, never reverted.

3. **The instruction MUST accept exactly these accounts, in order:**

```
 Accounts
 ┌───┬──────────┬──────────────────────────────────────────────┐
 │ # │  Access  │ Account                                      │
 ├───┼──────────┼──────────────────────────────────────────────┤
 │ 0 │ signer   │ drift_propamm_matcher  (Drift PDA signer)   │
 │ 1 │ readonly │ clock  (Sysvar)                              │
 │ 2 │ writable │ propamm_account                              │
 └───┴──────────┴──────────────────────────────────────────────┘
```

4. **The instruction data MUST follow this wire format** (after the 8-byte
   Anchor discriminator):

```
 Instruction Data  (variable length)
 ┌────────┬────────┬───────────────────────────────────────────┐
 │ Offset │  Size  │ Field                                     │
 ├────────┼────────┼───────────────────────────────────────────┤
 │      0 │      2 │ market_index              u16             │
 │      2 │      8 │ expected_sequence_number   u64            │
 │     10 │      2 │ fills_len                  u16            │
 │     12 │ 11 × N │ fills[0..fills_len]        FillRefV1[]    │
 └────────┴────────┴───────────────────────────────────────────┘

 FillRefV1  (11 bytes, packed)
 ┌────────┬────────┬───────────────────────────────────────────┐
 │ Offset │  Size  │ Field                                     │
 ├────────┼────────┼───────────────────────────────────────────┤
 │      0 │      1 │ is_ask          u8, 1 = ask, 0 = bid     │
 │      1 │      2 │ level_index     u16, index in that side   │
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
