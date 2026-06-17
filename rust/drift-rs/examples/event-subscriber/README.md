# Event Subscriber Example

Shows how to use the `EventSubscriber`. Default will run with websocket, run with `--grpc` flag to use a Yellowstone grpc datasource. The example terminates after 50 fill events.

Run on mainnet
```shell
WS_RPC_ENDPOINT=wss://your-rpc-with-wss.com cargo run
```

or 

```shell
GRPC_ENDPOINT=https://your-rpc-with-grpc.com:2053 GRPC_X_TOKEN=00000000-0000-0000-0000-000000000000 cargo run -- --grpc
```

Enable logging with `RUST_LOG=debug`

alternatively use a `.env` file