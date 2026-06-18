# Swift Example Maker

Example listens to incoming swift orders on a subset of markets: `["sui-perp", "eth-perp", "xrp-perp"]` and tries to fill them.
Runs on devnet by default

## Run
Run on devnet
```shell
PRIVATE_KEY="<base58 private key>" RUST_LOG=swift=debug cargo run --release
```

Run on mainnet
```shell
PRIVATE_KEY="<base58 private key>" MAINNET=1 RPC_URL="mainnet-rpc.example.com" RUST_LOG=swift=debug cargo run --release
```

alternatively use a `.env` file

---

## Logs
latency numbers show the diff between when taker order was accepted by swift server and
when received locally.
Most of the latency is internal to the swift server where the tx is simulated for
correctness before it is forwarded.

```log
uuid: F9gaynQV, latency: 74ms
```

The most accurate guage of network latency is the heartbeat msg (ms)
```log
[2025-03-06T06:05:58Z DEBUG swift] heartbeat latency: 0
```
