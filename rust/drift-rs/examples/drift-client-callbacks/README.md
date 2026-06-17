# DriftClient Callback Subscriptions Example

This example demonstrates how to subscribe to the DriftClient with callbacks and process market updates in real-time.

## Overview

This example shows how to:
- Subscribe to Drift market updates using the callback system
- Deserialize market account data 
- Access AMM fields like `base_asset_amount_with_amm`
- Handle market updates efficiently

## Usage

### Quick Start (Mainnet)
```bash
cd examples/drift-client-callbacks
cargo run
```

### With Custom RPC Endpoint
```bash
RPC_URL=https://your-rpc-endpoint.com cargo run
```

### Configuration Options
```bash
# Run for 60 seconds
cargo run -- --duration 60

RPC_URL=https://your-rpc-endpoint.com cargo run

# Debug logging
RUST_LOG=debug cargo run
```

## Callback Implementation

### Subscribing to Market Updates
```rust
// Subscribe to perp markets with a callback
client.subscribe_markets_with_callback(&markets, Some(|update| {
    // Process market update
    process_market_update(update);
})).await?;
```

### Processing Market Data
```rust
// Callback to process market updates
let callback = move |update: &AccountUpdate| {
    // Deserialize PerpMarket from account data
    match deserialize_perp_market(&update.data) {
        Ok(market) => {
            println!(
                "Market {}: base_asset_amount_with_amm = {}",
                market.market_index, 
                market.amm.base_asset_amount_with_amm
            );
        }
        Err(e) => {
            eprintln!("Failed to deserialize market: {}", e);
        }
    }
};
```

## Important Gotchas and Considerations

### 1. **Account Data Deserialization**
- Market account data can be deserialized directly using `try_deserialize`
- Handle deserialization errors gracefully - not all updates may be valid

### 2. **Callback Lifetime and State**
- Callbacks capture state by value or reference
- Use `Arc<Mutex<>>` for shared mutable state across callbacks
- Callbacks run on the subscription thread - avoid blocking operations

### 3. **Subscription Management**
- Always call `unsubscribe()` when done to clean up resources
- Subscriptions auto-reconnect on network issues
- Multiple callbacks can subscribe to the same market

### 4. **Performance Considerations**
- Callbacks execute synchronously - keep them fast
- Heavy computation should be offloaded to separate tasks
- Consider batching updates if processing is expensive
