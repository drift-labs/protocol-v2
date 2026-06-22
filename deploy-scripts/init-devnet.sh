#!/bin/sh
# Runs the devnet init runbook. Required env:
#   DEVNET_ADMIN       path to admin keypair json
#   SOL_LAZER_FEED_ID  pyth lazer u32 feed id for SOL/USD
#   PYTH_LAZER_TOKEN   auth token for Pyth Lazer relay (needed to post initial prices)
# Optional:
#   USDT_LAZER_FEED_ID        pyth lazer u32 feed id for USDT/USD (default 8)
#   PYTH_LAZER_ENDPOINTS      comma-sep WSS endpoints (default wss://pyth-lazer.dourolabs.app/v1/stream)
#   PYTH_LAZER_WAIT_MS        ms to wait for first price message (default 30000)
#   USDT_MINT                 reuse an existing USDT mint instead of creating one
#   USDT_MINT_KEYPAIR         keypair file for the USDT mint (vanity address)
#   USDT_INITIAL_SUPPLY       whole-token amount pre-minted to admin (default 10_000_000)
#   KEEPER_PUBKEYS            comma-sep keeper authority pubkeys to seed with dUSDT (Phase K; unset = skip)
#   KEEPER_FUND_AMOUNT        whole dUSDT to send each keeper (default 1000)
#   TOKEN_FAUCET_PROGRAM_ID   override (default V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB)
#   RPC_URL, LP_POOL_ID, LP_MAX_AUM, PROTECTED_MAKER_MAX_USERS, RECEIPT_PATH

set -eu

: "${DEVNET_ADMIN:?DEVNET_ADMIN must be set}"
: "${SOL_LAZER_FEED_ID:?SOL_LAZER_FEED_ID must be set}"
: "${PYTH_LAZER_TOKEN:?PYTH_LAZER_TOKEN must be set (Pyth Lazer relay auth token)}"

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

cd "$repo_root"
exec bun run "$script_dir/init-devnet.ts"
