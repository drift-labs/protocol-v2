#!/bin/sh
# Builds both the velocity program (no default features, no mainnet-beta gate)
# and the token_faucet program used to distribute devnet USDT.
set -eu
# --ignore-keys: velocity's declare_id!() is cfg-gated (mainnet-beta vs not), but
# anchor's pre-build keypair sync only sees the mainnet-beta arm and trips on
# devnet builds where target/deploy/velocity-keypair.json holds the devnet pubkey.
anchor build --ignore-keys -p velocity -- --no-default-features --features no-entrypoint
anchor build --ignore-keys -p token_faucet