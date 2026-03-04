# midprice_pino (Prop AMM)

Midprice-based orderbook program integrated with **Drift** as the exchange.

- **Initialize** a midprice account (no exchange ID stored; only Drift's matcher PDA can apply fills, enforced in-program).
- **Authority** on the midprice account = Drift **User** account pubkey (the maker providing liquidity).
- Each PropAMM account must be associated with a Drift **User** and **UserStats** account (the maker). When matching, Drift updates maker/taker positions and updates both UserStats (maker_volume_30d, taker_volume_30d).
- Drift matches taker orders against these books via `match_perp_order_via_prop_amm` and CPIs to `apply_fills` with the matcher PDA: `PDA(drift_program_id, ["matcher", maker_user_pubkey])`.
- **Remaining accounts** for the match instruction: `[midprice_program]`, then per AMM: `(matcher_authority, midprice_account, maker_user, maker_user_stats)`.

## Account layout (v2)

90-byte header followed by variable-length order entries.

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0 | 8 | `layout_version` | u64 LE, currently 1 |
| 8 | 32 | `authority` | Owner pubkey that signs write instructions |
| 40 | 16 | `mid_price` | u64 LE price + 8 reserved bytes |
| 56 | 8 | `ref_slot` | u64 LE slot of last quote-setting write |
| 64 | 2 | `market_index` | u16 LE |
| 66 | 2 | `ask_len` | u16 LE number of ask orders |
| 68 | 2 | `bid_len` | u16 LE number of bid orders |
| 70 | 2 | `ask_head` | u16 LE index of first live ask |
| 72 | 2 | `bid_head` | u16 LE index of first live bid |
| 74 | 8 | `quote_ttl_slots` | u64 LE, 0 = no expiry |
| 82 | 8 | `sequence_number` | u64 LE, monotonically increasing |
| 90+ | 16×N | orders | Each: (offset: i64 LE, size: u64 LE) |

## Instructions

| Opcode | Name | Accounts | Payload |
|--------|------|----------|---------|
| 0 | `update_mid_price` | `[midprice (w), authority (s)]` | 16 bytes (u64 price + 8 reserved) |
| 1 | `initialize` | `[midprice (w), authority (s)]` | 2 or 34 bytes: `market_index:u16 [\| authority_to_store:[u8;32]]` |
| 2 | `set_orders` | `[midprice (w), authority (s)]` | `ask_len:u16 \| bid_len:u16 \| entries…` |
| 3 | `apply_fills` | `[matcher (s), clock, midprice_0 (w), midprice_1 (w), …]` | First 2 bytes: `market_index` (u16 LE); must match each midprice account's stored market_index (CPI protection). Then per maker: `u16 num_fills` + 11×num_fills bytes. Filling is permissionless (no authority accounts). |
| 5 | `set_quote_ttl` | `[midprice (w), authority (s)]` | 8 bytes (u64 LE TTL in slots) |
| 6 | `close_account` | `[midprice (w), authority (s), dest (w)]` | 0 bytes |
| 7 | `transfer_authority` | `[midprice (w), authority (s)]` | 32 bytes (new authority pubkey) |

Accounts marked `(w)` must be writable, `(s)` must be signer.

## Quote TTL

When `quote_ttl_slots > 0`, the quote is considered expired when `current_slot - ref_slot > quote_ttl_slots`. The consumer (Drift's `prop_amm.rs`) rejects expired quotes when reading the midprice, and **apply_fills** rejects expired quotes before applying any fill (requires **clock** as the fourth account). A value of 0 disables expiry.

The `ref_slot` is automatically updated to the current Clock slot when `update_mid_price` or `set_orders` is called.

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
| 6 | 0x40 | `AUTH_ERR_UNSUPPORTED_LAYOUT_VERSION` | Layout version not recognized |
| 7 | 0x80 | `AUTH_ERR_QUOTE_EXPIRED` | Quote TTL exceeded |
| 8 | 0x100 | `AUTH_ERR_MARKET_INDEX_MISMATCH` | Midprice account market_index does not match CPI market_index |
| 9 | 0x200 | `AUTH_ERR_INVALID_CLOCK` | accounts[1] is not the Clock sysvar (apply_fills) |

Multiple bits may be set when multiple preconditions fail simultaneously.

## Building
For bankrun tests with the real midprice_pino program:

```bash
./test-scripts/build-midprice-pino-for-bankrun.sh
```
