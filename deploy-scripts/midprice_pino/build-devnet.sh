#!/usr/bin/env bash
# Build midprice_pino and copy .so + program keypair to target/deploy.
# PROTOCOL_V2_ROOT: protocol-v2-deploy repo root with programs/midprice_pino (defaults to ../.. from this script).
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
MIDPRICE_DIR="$ROOT/programs/midprice_pino"

if [[ ! -d "$MIDPRICE_DIR" ]]; then
  echo "ERROR: programs/midprice_pino not found under $ROOT" >&2
  exit 1
fi

echo "Building midprice_pino in $MIDPRICE_DIR..."
mkdir -p "$ROOT/target/deploy"
(cd "$MIDPRICE_DIR" && cargo build-sbf --tools-version v1.52)

cp "$MIDPRICE_DIR/target/deploy/midprice_pino.so" "$ROOT/target/deploy/midprice_pino.so"
echo "Copied -> $ROOT/target/deploy/midprice_pino.so"

if [[ -f "$MIDPRICE_DIR/target/deploy/midprice_pino-keypair.json" ]]; then
  cp "$MIDPRICE_DIR/target/deploy/midprice_pino-keypair.json" "$ROOT/target/deploy/midprice_pino-keypair.json"
  echo "Copied -> $ROOT/target/deploy/midprice_pino-keypair.json"
fi
