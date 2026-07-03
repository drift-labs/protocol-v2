#!/bin/sh
# Runs the mainnet base init runbook (init-mainnet.ts): State, hot roles,
# AmmCache, quote spot market, quote Lazer oracle. Perp markets come after,
# via: sh deploy-scripts/init-markets.sh
#
# Required env:
#   ADMIN_KEYPAIR        path to admin keypair json. Must be the state init
#                        authority (ids.rs) on first run; mainnet builds gate
#                        `initialize` to that key.
#   RPC_URL              private mainnet RPC
#   QUOTE_LAZER_FEED_ID  Pyth Lazer u32 feed id for the quote asset
#   PYTH_LAZER_TOKEN     auth token for Pyth Lazer relay
# Optional:
#   QUOTE_MINT             quote SPL mint (default: mainnet USDT)
#   QUOTE_SYMBOL           spot market 0 name (default USDT)
#   HOT_*                  hot-role authority overrides (see init-mainnet.ts)
#   PYTH_LAZER_ENDPOINTS   comma-sep WSS endpoints
#   PYTH_LAZER_WAIT_MS     ms to wait for first price message (default 30000)
#   RECEIPT_PATH           default deploy-scripts/out/mainnet-deployment.json
#   NON_INTERACTIVE=1      skip confirmation prompts
#   DRY_RUN=1 or --dry-run no transactions; log every ix as "[DRY RUN] would ..."

set -eu

: "${ADMIN_KEYPAIR:?ADMIN_KEYPAIR must be set}"
: "${RPC_URL:?RPC_URL must be set (private mainnet RPC)}"
: "${QUOTE_LAZER_FEED_ID:?QUOTE_LAZER_FEED_ID must be set}"
: "${PYTH_LAZER_TOKEN:?PYTH_LAZER_TOKEN must be set (Pyth Lazer relay auth token)}"

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

cd "$repo_root"
exec bun run "$script_dir/init-mainnet.ts" "$@"
