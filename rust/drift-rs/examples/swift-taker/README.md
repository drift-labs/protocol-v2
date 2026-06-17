# Swift Example Taker

Example swift taker client.
Runs on devnet by default

## Run
Run on devnet
```shell
PRIVATE_KEY="<base58 private key>" RUST_LOG=swift=debug cargo run --release

# Deposit Trade
PRIVATE_KEY="<base58 private key>" RUST_LOG=swift=debug cargo run --release -- --deposit-trade

# Isolated Margin Order
PRIVATE_KEY="<base58 private key>" RUST_LOG=swift=debug cargo run --release -- --isolated-position 100000000

```

Run on mainnet
```shell
PRIVATE_KEY="<base58 private key>" MAINNET=1 RPC_URL="mainnet-rpc.example.com" RUST_LOG=swift=debug cargo run --release
```

alternatively use a `.env` file

## Flags

- `--deposit-trade`: Makes a depositTrade request that deposits collateral and places an order in a single transaction
- `--isolated-position <integer>`: Causes the order to use isolated margin with the supplied amount of USDC collateral (in base units, e.g., 100000000 = 100 USDC)
