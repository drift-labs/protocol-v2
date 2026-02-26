# midprice_pino (Prop AMM)

Midprice-based orderbook program from [prop-amm-poc](https://github.com/your-org/prop-amm-poc), integrated with **Drift** as the exchange.

- **Initialize** a midprice account with `authorized_exchange_program_id` = Drift program ID so only Drift can apply fills.
- **Authority** on the midprice account = Drift **User** account pubkey (the maker providing liquidity).
- Each PropAMM account must be associated with a Drift **User** and **UserStats** account (the maker). When matching, Drift updates maker/taker positions and updates both UserStats (maker_volume_30d, taker_volume_30d).
- Drift matches taker orders against these books via `match_perp_order_via_prop_amm` and CPIs to `apply_fills_batch` with the matcher PDA: `PDA(drift_program_id, ["matcher", maker_user_pubkey])`.
- **Remaining accounts** for the match instruction: `[midprice_program]`, then per AMM: `(matcher_authority, midprice_account, maker_user, maker_user_stats)`.

## Instructions

- `0` – update_mid_price (16 bytes)
- `1` – initialize_mid_price_account (market_index: u16, authorized_exchange_program_id: [u8;32])
- `2` – set_orders (ask_len, bid_len, packed (offset:i64, size:u64)…)
- `3` – apply_fill (single fill)
- `4` – apply_fills_batch (repeated abs_index:u16, is_ask:u8, fill_size:u64)

## Building

From repo root (with workspace members resolving):

```bash
cargo build -p midprice_pino
```

If `programs/drift_mollusk_tests` is missing a Cargo.toml, add it to workspace `exclude` in the root `Cargo.toml` so `cargo build -p drift` works.
