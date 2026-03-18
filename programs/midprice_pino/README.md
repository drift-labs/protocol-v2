# midprice_pino (Prop AMM)

Midprice-based orderbook program integrated with **Drift** as the exchange.

- Implements the **PropAMM Interface V1** (`propamm-interface-v1.md`): standardized 96-byte header + `apply_fills` CPI hook.
- **Maker subaccount** is the Drift **User** PDA stored directly in the header.
- Each PropAMM account must be associated with a Drift **User** and **UserStats** account (the maker). When matching, Drift updates maker/taker positions and both UserStats (maker_volume_30d, taker_volume_30d).
- Drift matches taker orders against these books via `fill_perp_order2` and CPIs to `apply_fills` with the global matcher PDA: `PDA(drift_program_id, ["prop_amm_matcher"])`.
- **Remaining accounts** for the match instruction: `[midprice_program]`, then per AMM: `(propamm_account, maker_user)`.

## Account layout (PropAMM Interface V1)

96-byte standardized header + 56-byte program-specific opaque region + variable-length quote block.

### Standardized header (96 bytes)

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0 | 8 | `discriminator` | `"prammacc"` |
| 8 | 1 | `version` | u8, must be 1 |
| 9 | 1 | `flags` | u8, must be 0 in V1 |
| 10 | 2 | `header_len` | u16 LE, = 96 |
| 12 | 2 | `market_index` | u16 LE |
| 14 | 32 | `maker_subaccount` | Drift User PDA (seeds = `["user", authority, subaccount_id]`) |
| 46 | 8 | `sequence_number` | u64 LE, monotonically increasing, wraps |
| 54 | 8 | `valid_until_slot` | u64 LE, live iff `current_slot <= valid_until_slot` |
| 62 | 8 | `reference_price` | u64 LE, reprices whole ladder in O(1) |
| 70 | 4 | `quote_data_offset` | u32 LE, start of quote block (= 152 for midprice_pino) |
| 74 | 4 | `quote_data_len` | u32 LE, total bytes of quote block |
| 78 | 2 | `ask_len` | u16 LE |
| 80 | 2 | `bid_len` | u16 LE |
| 82 | 2 | `ask_head` | u16 LE, index of first non-empty ask |
| 84 | 2 | `bid_head` | u16 LE, index of first non-empty bid |
| 86 | 2 | `level_entry_size` | u16 LE, stride per level (>= 16) |
| 88 | 8 | `reserved` | zero |

### Midprice_pino opaque region (offsets 96–151)

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 96 | 32 | `authority` | Owner pubkey that signs write instructions |
| 128 | 8 | `order_tick_size` | u64 LE, 0 = any price accepted |
| 136 | 8 | `min_order_size` | u64 LE |
| 144 | 8 | `quote_ttl_slots` | u64 LE, stored for SDK convenience; `valid_until_slot` is the on-chain deadline |

### Quote block (offset 152+)

Each level: `price_offset: i64 LE` + `base_asset_amount: u64 LE` (16 bytes).
Effective price = `reference_price + price_offset`.
Asks at indices `[0, ask_len)`, bids at `[ask_len, ask_len + bid_len)`.
Maximum 128 levels (asks + bids combined).

## Instructions

| Opcode | Name | Accounts | Payload |
|--------|------|----------|---------|
| 0 | `update_mid_price` | `[midprice (w), authority (s)]` | 16 bytes: `reference_price` (u64) + `valid_until_slot` (u64) |
| 1 | `initialize` | `[midprice (w), authority (s), drift_matcher (s)]` | 52 bytes: `market_index` (u16), `subaccount_index` (u16), `maker_subaccount` ([u8;32]), `order_tick_size` (u64), `min_order_size` (u64). CPI-only from Drift. |
| 2 | `set_orders` | `[midprice (w), authority (s)]` | `valid_until_slot` (u64), `ask_len` (u16), `bid_len` (u16), then 16×N order entries (offset i64 LE, size u64 LE). Tick/size validated against values stored on account. |
| 3 | `apply_fills` | `[matcher (s), clock, midprice_0 (w), …]` | `market_index` (u16); then per maker: `num_fills` (u16), `expected_sequence` (u64), then 11×num_fills bytes (`abs_index` u16, `is_ask` u8, `fill_size` u64). |
| 5 | `set_quote_ttl` | `[midprice (w), authority (s)]` | 8 bytes: `ttl_slots` (u64) |
| 6 | `close_account` | `[midprice (w), authority (s), dest (w)]` | 0 bytes |
| 7 | `transfer_authority` | `[midprice (w), authority (s)]` | 32 bytes: new authority pubkey |
| 8 | `update_tick_sizes` | `[midprice (w), authority (s), drift_matcher (s)]` | 16 bytes: `order_tick_size` (u64), `min_order_size` (u64). CPI-only from Drift. |

Accounts marked `(w)` must be writable, `(s)` must be signer.

## Quote TTL

`valid_until_slot` is the absolute slot deadline. When > 0, quotes are live iff `current_slot <= valid_until_slot`. The consumer (Drift's `prop_amm.rs`) rejects expired quotes when reading the account, and **apply_fills** skips expired makers before applying fills (requires **clock** as accounts[1]). A value of 0 disables expiry.

The `valid_until_slot` is set directly by the maker via `update_mid_price` or `set_orders`. The `quote_ttl_slots` stored in the opaque region is available for SDK convenience (auto-computing `valid_until_slot = current_slot + ttl`).

## Sequence number

A monotonically increasing u64 counter (`sequence_number`) is incremented after every write instruction (init, update, set_orders, apply_fills, set_quote_ttl, transfer_authority). Consumers can use it to detect stale reads or confirm that a specific write has landed.

## Error codes

Returned as `ProgramError::Custom(u32)` where the low byte is a bitmask:

| Bit | Value | Name | Meaning |
|-----|-------|------|---------|
| 0 | 0x01 | `AUTH_ERR_IMMUTABLE` | Account not writable |
| 1 | 0x02 | `AUTH_ERR_MISSING_SIGNATURE` | Missing required signature |
| 2 | 0x04 | `AUTH_ERR_ILLEGAL_OWNER` | Account not owned by this program |
| 3 | 0x08 | `AUTH_ERR_INVALID_ACCOUNT_DATA` | Account data too small |
| 4 | 0x10 | `AUTH_ERR_INVALID_AUTHORITY` | Authority mismatch |
| 5 | 0x20 | `AUTH_ERR_ALREADY_INITIALIZED` | Account already initialized |
| 6 | 0x40 | `AUTH_ERR_UNSUPPORTED_LAYOUT_VERSION` | Layout version / discriminator not recognized |
| 7 | 0x80 | `AUTH_ERR_QUOTE_EXPIRED` | Quote TTL exceeded (`current_slot > valid_until_slot`) |
| 8 | 0x100 | `AUTH_ERR_MARKET_INDEX_MISMATCH` | Midprice account market_index does not match CPI market_index |
| 9 | 0x200 | `AUTH_ERR_INVALID_CLOCK` | accounts[1] is not the Clock sysvar (apply_fills) |
| 12 | 0x1000 | `AUTH_ERR_ORDER_TICK_OR_SIZE` | Order not on tick or below min_order_size |
| 13 | 0x2000 | `AUTH_ERR_INIT_REQUIRES_DRIFT_CPI` | Init/update_tick_sizes invoked directly; must be CPI from Drift |

Multiple bits may be set when multiple preconditions fail simultaneously.

## Building

For bankrun tests with the real midprice_pino program:

```bash
./test-scripts/build-midprice-pino-for-bankrun.sh
```
