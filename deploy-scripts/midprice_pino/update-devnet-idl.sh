#!/usr/bin/env bash
# Upload midprice_pino IDL to on-chain program metadata (devnet) via program-metadata CLI.
# Requires: idl.json (default: next to this script), payer keypair, devnet RPC.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "${PROTOCOL_V2_ROOT:-}" ]]; then
  _default="$SCRIPT_DIR/../.."
  if [[ ! -d "$_default/programs/midprice_pino" ]]; then
    echo "ERROR: PROTOCOL_V2_ROOT is not set and programs/midprice_pino not found under $_default" >&2
    exit 1
  fi
  PROTOCOL_V2_ROOT="$(cd "$_default" && pwd)"
fi

ROOT="$(cd "$PROTOCOL_V2_ROOT" && pwd)"
SOLANA_URL="${SOLANA_URL:-https://api.devnet.solana.com}"

if [[ -n "${PROGRAM_KEYPAIR:-}" ]]; then
  PROG_KEY="$PROGRAM_KEYPAIR"
else
  PROG_KEY="$ROOT/tests/fixtures/midprice_pino-keypair.json"
fi

if [[ -n "${DEPLOYER_KEYPAIR:-}" ]]; then
  PAYER_KEY="$DEPLOYER_KEYPAIR"
elif [[ -n "${SOLANA_PATH:-}" && -n "${DEVNET_ADMIN:-}" ]]; then
  PAYER_KEY="${SOLANA_PATH}/${DEVNET_ADMIN}"
else
  echo "ERROR: Set DEPLOYER_KEYPAIR, or both SOLANA_PATH and DEVNET_ADMIN (payer keypair)." >&2
  exit 1
fi

IDL_JSON="${IDL_JSON:-$SCRIPT_DIR/idl.json}"

if [[ ! -f "$PROG_KEY" ]]; then
  echo "ERROR: Program keypair not found: $PROG_KEY" >&2
  exit 1
fi
if [[ ! -f "$PAYER_KEY" ]]; then
  echo "ERROR: Deployer keypair not found: $PAYER_KEY" >&2
  exit 1
fi
if [[ ! -f "$IDL_JSON" ]]; then
  echo "ERROR: IDL file not found: $IDL_JSON" >&2
  echo "Set IDL_JSON=/path/to/idl.json or add deploy-scripts/midprice_pino/idl.json" >&2
  exit 1
fi

PROGRAM_ID="$(solana-keygen pubkey "$PROG_KEY")"

echo "Writing IDL to program metadata on $SOLANA_URL"
echo "  program: $PROGRAM_ID"
echo "  idl:     $IDL_JSON"
echo "  payer:   $PAYER_KEY"

exec npx @solana-program/program-metadata@latest write idl "$PROGRAM_ID" "$IDL_JSON" \
  -k "$PAYER_KEY" \
  --rpc "$SOLANA_URL" \
  --format json
