#!/usr/bin/env bash
# Deploy midprice_pino.so to devnet.
# PROTOCOL_V2_ROOT: protocol-v2-deploy repo root (defaults to ../.. from this script; same as Makefile).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "${PROTOCOL_V2_ROOT:-}" ]]; then
  _default="$SCRIPT_DIR/../.."
  if [[ ! -d "$_default/programs/midprice_pino" ]]; then
    echo "ERROR: PROTOCOL_V2_ROOT is not set and programs/midprice_pino not found under $_default" >&2
    echo "Set PROTOCOL_V2_ROOT to your protocol-v2-deploy repo root (directory containing programs/)." >&2
    exit 1
  fi
  PROTOCOL_V2_ROOT="$(cd "$_default" && pwd)"
fi

ROOT="$(cd "$PROTOCOL_V2_ROOT" && pwd)"
SO="$ROOT/target/deploy/midprice_pino.so"

if [[ ! -f "$SO" ]]; then
  echo "ERROR: Missing $SO — run make build-devnet first" >&2
  exit 1
fi

SOLANA_URL="${SOLANA_URL:-https://api.devnet.solana.com}"

# Program address comes from this keypair (same as bankrun tests/fixtures).
# Override: PROGRAM_KEYPAIR=... for a different program id keypair.
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

if [[ ! -f "$PROG_KEY" ]]; then
  echo "ERROR: Program keypair not found: $PROG_KEY" >&2
  exit 1
fi
if [[ ! -f "$PAYER_KEY" ]]; then
  echo "ERROR: Deployer keypair not found: $PAYER_KEY" >&2
  exit 1
fi

echo "Deploying midprice_pino.so to $SOLANA_URL"
echo "Program id keypair (--program-id): $PROG_KEY"
echo "Deployer / fee payer (--keypair): $PAYER_KEY"

exec solana program deploy \
  --program-id "$PROG_KEY" \
  "$SO" \
  --url "$SOLANA_URL" \
  --keypair "$PAYER_KEY"
