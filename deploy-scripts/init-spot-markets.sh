#!/bin/sh
# Runs the mainnet spot (lending) market init runbook (init-spot-markets.ts).
# Run AFTER init-mainnet.sh. Fill the lending params in
# deploy-scripts/params/relaunch-spot-markets.json first; the script refuses
# to run while any of them is null.
#
# Required env:
#   ADMIN_KEYPAIR      path to admin keypair json (State.cold_admin)
#   RPC_URL            private mainnet RPC
#   PYTH_LAZER_TOKEN   auth token for Pyth Lazer relay
# Optional:
#   PROGRAM_ID             default: SDK mainnet config program id
#   PARAMS_PATH            default deploy-scripts/params/relaunch-spot-markets.json
#   RECEIPT_PATH           default deploy-scripts/out/relaunch-spot-markets.json
#   PYTH_LAZER_ENDPOINTS   comma-sep WSS endpoints
#   PYTH_LAZER_WAIT_MS     ms to wait for first price message (default 30000)
#   NON_INTERACTIVE=1      skip confirmation prompts

set -eu

: "${ADMIN_KEYPAIR:?ADMIN_KEYPAIR must be set}"
: "${RPC_URL:?RPC_URL must be set (private mainnet RPC)}"
: "${PYTH_LAZER_TOKEN:?PYTH_LAZER_TOKEN must be set (Pyth Lazer relay auth token)}"

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

cd "$repo_root"
exec bun run "$script_dir/init-spot-markets.ts"
