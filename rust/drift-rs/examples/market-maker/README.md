## Market Maker Example

Place and cancel fixed limit and floating limit orders

Run mainnet WebSocket example
```shell
PRIVATE_KEY="<base58 private key>" \
MAINNET=1 \
RPC_URL="mainnet-rpc.example.com" \
 cargo run --release
```

Run mainnet gRPC example
```shell
PRIVATE_KEY="<base58 private key>" \
MAINNET=1 \
RPC_URL="mainnet-rpc.example.com" \
GRPC_URL="" \
GRPC_X_TOKEN="" \
 cargo run --release -- --grpc
```

## JIT Making
Drift MMs can also provide Just in Time (JIT) matching via swift and jit-proxy helper program.
for examples see the `swift-maker` example and the jit-proxy example: https://github.com/drift-labs/jit-proxy/tree/master/rust
