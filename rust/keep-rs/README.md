# Rust Keeper Bots
Example rust keeper bots

## Configuration

Copy `.env.example` to `.env` and substitute valid RPC credentials:

Required environment variables:
- `BOT_PRIVATE_KEY` - Base58 encoded private key
- `RPC_URL` - Solana RPC endpoint
- `GRPC_ENDPOINT` - Drift gRPC endpoint
- `GRPC_X_TOKEN` - Authentication token for gRPC
~- `PYTH_LAZER_TOKEN` - Pyth price feed access token~

## Run Perp Filler
The perp filler matches swift orders and onchain auction orders against resting liquidity.
It also attempts to uncross resting limit orders.

```shell
RUST_LOG=filler=info,dlob=info,swift=info \
    cargo run --release -- --mainnet --filler
```

- use `--dry` flag for tx simulation only

## Run 'Perp With Fill' Liquidator
Liquidator bot attemps to close liquidatable perp positions against resting limit orders and spot borrows with atomic swaps.

```shell
RUST_LOG=liquidator=info,dlob=info,swift=info \
    cargo run --release -- --mainnet --liquidator
```

## Event Flow Diagram (Filler)

The following diagram illustrates the flow of events in the Filler Bot, from receiving gRPC and websocket events, updating the orderbook (DLOB), to sending and confirming transactions:

```mermaid
flowchart TD
    subgraph Event_Sources
        A1["gRPC Slot Update"]
        A2["gRPC Account Update"]
        A3["gRPC Transaction Update"]
        A4["Swift Order Websocket"]
    end

    subgraph DLOB_and_Notifier
        B1["DLOB (Orderbook State)"]
        B2["DLOBNotifier"]
    end

    subgraph FillerBot_MainLoop
        C1["Slot Receiver (from gRPC)"]
        C2["Swift Order Stream"]
        C3["Find Crosses"]
        C4["try_auction_fill / try_swift_fill"]
    end

    subgraph Transaction_Worker
        D1["TxWorker.send_tx"]
        D2["TxWorker.confirm_tx"]
    end

    %% Event flow
    A1 -- "on_slot_update_fn" --> B2
    A1 -- "on_slot_update_fn" --> C1
    A2 -- "on_account_update_fn" --> B2
    A3 -- "on_transaction_update_fn" --> D2
    A4 -- "New Swift Order" --> C2

    B2 -- "DLOBEvent::SlotOrPriceUpdate / Order" --> B1
    B1 -- "Orderbook State" --> C3
    C1 -- "New Slot" --> C3
    C2 -- "New Swift Order" --> C3
    C3 -- "Crosses Found?" --> C4
    C4 -- "Build Transaction" --> D1
    D1 -- "Send Transaction" --> Solana["Solana Network"]
    Solana -- "Transaction Update" --> A3
    D2 -- "Confirm & Metrics" --> FillerBot_MainLoop
    D1 -- "PendingTxs" --> D2

    %% Feedback
    D2 -- "Update Metrics, PendingTxs" --> FillerBot_MainLoop
```

## Transaction Lifecycle Diagram

The following diagram shows the complete lifecycle of a transaction from creation to confirmation, including error handling and competition scenarios:

```mermaid
flowchart TD
    subgraph "Transaction Creation"
        A1["Cross Detection"]
        A2["Build Transaction"]
        A3["Calculate Priority Fee"]
        A4["Set CU Limit"]
    end

    subgraph "Transaction Sending"
        B1["TxWorker.send_tx"]
        B2["Sign & Send to RPC"]
        B3["Add to PendingTxs"]
        B4["Increment Metrics"]
    end

    subgraph "Transaction Confirmation"
        C1["gRPC Transaction Update"]
        C2["TxWorker.confirm_tx"]
        C3["Get Transaction Details"]
        C4["Parse Transaction Logs"]
        C5["Update Metrics"]
    end

    subgraph "Success Path"
        D1["Transaction Success"]
        D2["Parse Fill Events"]
        D3["Compare Expected vs Actual Fills"]
        D4["Record Performance Metrics"]
    end

    subgraph "Error Paths"
        E1["Send Error"]
        E2["Confirmation Error"]
        E3["Transaction Failed"]
        E4["Insufficient Funds"]
        E5["Compute Unit Exceeded"]
    end

    subgraph "Competition Scenarios"
        F1["AMM Fill Beats Us"]
        F2["Higher Priority Fee"]
        F3["Order Already Filled"]
        F4["Partial Fill"]
    end

    %% Main flow
    A1 --> A2 --> A3 --> A4 --> B1 --> B2 --> B3 --> B4
    B2 --> C1 --> C2 --> C3 --> C4 --> C5

    %% Success path
    C4 --> D1 --> D2 --> D3 --> D4

    %% Error paths
    B2 --> E1
    C3 --> E2
    C4 --> E3
    E3 --> E4
    E3 --> E5

    %% Competition scenarios
    D2 --> F1
    D2 --> F2
    D2 --> F3
    D3 --> F4

    %% Styling
    classDef success fill:#d4edda,stroke:#155724,color:#155724
    classDef error fill:#f8d7da,stroke:#721c24,color:#721c24
    classDef competition fill:#fff3cd,stroke:#856404,color:#856404
    classDef process fill:#d1ecf1,stroke:#0c5460,color:#0c5460

    class D1,D2,D3,D4 success
    class E1,E2,E3,E4,E5 error
    class F1,F2,F3,F4 competition
    class A1,A2,A3,A4,B1,B2,B3,B4,C1,C2,C3,C4,C5 process
```

## Liquidator Overview

### 1. Initialization (`LiquidatorBot::new`)
- **DLOB**: Decentralized Limit Order Book for finding makers to match against
- **TxWorker**: Dedicated thread for sending and confirming transactions
- **MarketState**: Caches market metadata and oracle prices
- **gRPC Subscriptions**: Real-time updates for users, oracles, markets
- **Liquidation Worker**: Background thread that processes liquidatable users

### 2. Main Event Loop (`LiquidatorBot::run`)
- Processes gRPC events in batches (up to 32 events)
- Maintains user account state in memory
- Tracks high-risk users (free margin < 20% of requirement)
- Rechecks high-risk users on oracle price updates
- Periodically rechecks all users (every 64 cycles)

### 3. Margin Status Checking
Three states are tracked:
- **Liquidatable**: `total_collateral < margin_requirement`
- **High Risk**: `free_margin < 20% of margin_requirement`
- **Safe**: All others

### 4. Liquidation Worker Thread
- Receives liquidatable users via channel
- Implements rate limiting (5 slots minimum between attempts)
- Gets dynamic priority fees (60th percentile)
- Executes liquidation strategy

### 5. Liquidation Strategy (`LiquidateWithMatchStrategy`)
- **Perp Liquidations**: 
  - Finds largest perp position
  - Queries DLOB for top makers (asks for longs, bids for shorts)
  - Builds `liquidate_perp_with_fill` transaction
  
- **Spot Liquidations**:
  - Finds borrow positions (skip dust)
  - Uses largest deposit as collateral
  - Queries Jupiter for swap route
  - Builds `liquidate_spot_with_swap` transaction

### 6. Transaction Lifecycle
- Transactions are built with priority fees and compute limits
- Sent to blockchain via TxSender channel
- TxWorker handles signing and sending
- Transaction confirmations update metrics and remove from pending set

## Tx Summary
print some recent tx stats
```bash
 RUST_LOG=info cargo run --release --bin=tx_history <PUBKEY> --rpc-url <RPC_URL>
 ```
