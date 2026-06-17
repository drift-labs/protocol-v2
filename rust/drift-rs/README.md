<div align="center">
  <img height="120x" src="https://uploads-ssl.webflow.com/611580035ad59b20437eb024/616f97a42f5637c4517d0193_Logo%20(1)%20(1).png" />

  <h1 style="margin-top:20px;">drift-rs</h1>

  <p>
    <a href="https://crates.io/crates/drift-rs"><img alt="Crates.io" src="https://img.shields.io/crates/v/drift-rs.img" /></a>
    <a href="https://docs.drift.trade/developer-resources/sdk-documentation"><img alt="Docs" src="https://img.shields.io/badge/docs-tutorials-blueviolet" /></a>
    <a href="https://discord.com/channels/849494028176588802/878700556904980500"><img alt="Discord Chat" src="https://img.shields.io/discord/889577356681945098?color=blueviolet" /></a>
    <a href="https://opensource.org/licenses/Apache-2.0"><img alt="License" src="https://img.shields.io/github/license/project-serum/anchor?color=blueviolet" /></a>
  </p>
</div>

# drift-rs

Experimental, high performance Rust SDK for building offchain clients for [Drift V2](https://github.com/drift-labs/protocol-v2) protocol.

See the official [docs](https://docs.rs/drift-rs/latest/drift_rs/)

## Install
```toml
drift-rs = { git = "https://github.com/drift-labs/drift-rs", tag = "v1.0.0" }
```
_*_ crates.io requires [libdrift](https://github.com/drift-labs/drift-ffi-sys/?tab=readme-ov-file#from-source) is installed and linked locally


## Use
The `DriftClient` struct provides methods for reading drift program accounts and crafting transactions.  
It is built on a subscription model where live account updates are transparently cached and made accessible via accessor methods.  
The client may be subscribed either via Ws or gRPC.  

```rust
use drift_rs::{AccountFilter, DriftClient, Wallet, grpc::GrpcSubscribeOpts};
use solana_sdk::signature::Keypair;

async fn main() {
    let client = DriftClient::new(
        Context::MainNet,
        RpcClient::new("https://rpc-provider.com"),
        Keypair::new().into(),
    )
    .await
    .expect("connects");

    // Subscribe via WebSocket
    //
    // 1) Ws-based live market and price changes
    let markets = [MarketId::spot(1), MarketId::perp(0)];
    client.subscribe_markets(&markets).await.unwrap();
    client.subscribe_oracles(&markets).await.unwrap();
    client.subscribe_account("SUBACCOUNT_1");

    // OR 2) subscribe via gRPC (advanced)
    // gRPC automatically subscribes to all markets and oracles
    client.grpc_subscribe(
      "https://grpc.example.com".into(),
      "API-X-TOKEN".into(),
      GrpcSubscribeOpts::default()
        .user_accounts("SUBACCOUNT_1", "SUB_ACCOUNT_2")
        .on_slot(move |new_slot| {
          // do something on slot
        })
        .on_account(
          AccountFilter::partial().with_discriminator(User::DISCRIMINATOR),
          move |account| {
              // do something on user account updates
          })
    ).await;

    //
    // Fetch latest values
    ///
    let sol_perp_price = client.oracle_price(MarketId::perp(0));
    let subaccount_1: User = client.try_get_account("SUBACCOUNT_1"));
```
## Setup

### Mac

Install rosetta (m-series only) and configure Rust toolchain for `x86_64`  
⚠️ `1.76.0-x86_64` must also be installed alongside latest stable rust

```bash
softwareupdate --install-rosetta

# replace '1.85.0' with preferred latest stable version
rustup install 1.85.0-x86_64-apple-darwin 1.76.0-x86_64-apple-darwin --force-non-host

rustup override set 1.85.0-x86_64-apple-darwin
```

### Linux 
```bash
# replace '1.85.0' with preferred latest stable version
rustup install 1.85.0-x86_64-unknown-linux-gnu 1.76.0-x86_64-unknown-linux-gnu --force-non-host

rustup override set 1.85.0-x86_64-unknown-linux-gnu
```

⚠️ the non-x86_64 toolchains are incompatible due to memory layout differences between solana program (BPF) and aarch64 and will fail at runtime with deserialization errors like: `InvalidSize`.

## Local Development
drift-rs links to the drift program crate via FFI, build from source (default) by cloning git submodule or dynamically link with a version from [drift-ffi-sys](https://github.com/drift-labs/drift-ffi-sys/releases)

**clone repo and submodules**
```bash
git clone https://github.com/drift-labs/drift-rs &&\
cd drift-rs &&\
git submodule update --init --recursive
```

**build**
```bash
# Build from source (default)
CARGO_DRIFT_FFI_STATIC=1

# Provide a prebuilt drift_ffi_sys lib 
CARGO_DRIFT_FFI_PATH="/path/to/libdrift_ffi_sys"
```
## Development

## Release
`git tag v<MAJOR.MINOR.PATCH> && git push`

## Updating IDL types
from repo root dir:
```shell
./scripts/idl-update.sh
cargo check # build new IDL types
# commit changes...
```
