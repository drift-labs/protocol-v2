# propamm-sdk

Rust SDK for quoting on Drift's PropAMM system (`midprice_pino`).

## Usage

```toml
[dependencies]
propamm-sdk = { path = "crates/propamm-sdk" }
```

```rust
use std::sync::Arc;
use propamm_sdk::{PropAmmClient, OrderEntry, DRIFT_PROGRAM_ID, MIDPRICE_PINO_PROGRAM_ID};
use solana_keypair::read_keypair_file;

let payer = Arc::new(read_keypair_file("~/.config/solana/id.json").unwrap());
let client = PropAmmClient::new(
    "http://127.0.0.1:8899",
    payer,
    0,  // market_index
    0,  // subaccount_index
    MIDPRICE_PINO_PROGRAM_ID,
    DRIFT_PROGRAM_ID,
);

let slot = client.get_slot().await?;
let asks = vec![OrderEntry { offset: 1000, size: 1_000_000_000 }];
let bids = vec![OrderEntry { offset: -1000, size: 1_000_000_000 }];
let sig = client.quote(50_000_000_000, slot, &asks, &bids).await?;
```

## Examples

```bash
# One-shot quote against a local validator
RPC_URL=http://127.0.0.1:8899 \
KEYPAIR_PATH=~/.config/solana/id.json \
cargo run -p one-shot-quote

# Full maker bot with CLI config
cargo run -p maker-bot -- \
  --rpc-url http://127.0.0.1:8899 \
  --keypair-path ~/.config/solana/id.json \
  --oracle-pubkey <PYTH_ORACLE_PUBKEY> \
  --spread-bps 10 \
  --num-levels 3
```

## Structure

```
crates/propamm-sdk/src/
  client.rs        PropAmmClient - async entry point
  instructions.rs  Instruction builders (midprice-pino + Drift Anchor)
  oracle.rs        Pyth v2 price parsing
  monitor.rs       Fill monitoring (polling + WebSocket)
  pda.rs           PDA derivations
  constants.rs     Program IDs, precision, opcodes

examples/
  maker-bot/       Full quoting loop with CLI config
  one-shot-quote/  Minimal single-quote example
```

## Lifecycle

1. `PropAmmClient::initialize_midprice()` - create midprice PDA (Drift CPI)
2. `set_quote_ttl_ix()` - configure quote expiry
3. `client.quote(mid_price, slot, &asks, &bids)` - send combined update + set_orders tx
4. `monitor::poll_sequence_number()` / `subscribe_midprice()` - detect fills
5. `close_account_ix()` - reclaim lamports on shutdown