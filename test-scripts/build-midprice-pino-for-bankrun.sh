#!/usr/bin/env bash
# Build midprice_pino and deploy the .so + keypair to tests/fixtures so bankrun
# tests use the real program. Then run the PropAMM bankrun tests.
#
# Usage (from repo root):
#   ./test-scripts/build-midprice-pino-for-bankrun.sh        # build, deploy, run tests
#   ./test-scripts/build-midprice-pino-for-bankrun.sh --no-test   # build and deploy only
set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

FIXTURES="$REPO_ROOT/tests/fixtures"
DEPLOY="${DEPLOY:-target/deploy}"
RUN_TESTS=true
for arg in "$@"; do
  case "$arg" in
    --no-test) RUN_TESTS=false ;;
  esac
done

MIDPRICE_DIR="$REPO_ROOT/programs/midprice_pino"
echo "Building midprice_pino in $MIDPRICE_DIR..."
# build midprice program with latest solana tools
(cd "$MIDPRICE_DIR" && cargo build-sbf --tools-version v1.52)
echo "copying built midprice_pino.so to $..."
cp programs/midprice_pino/target/deploy/midprice_pino.so "$DEPLOY"

# build drift program with compatible/legacy tools
echo "Building drift program"
solana-install init 1.16.27 && anchor build

if [[ ! -f "$DEPLOY/midprice_pino.so" ]]; then
  echo "Error: $DEPLOY/midprice_pino.so not found after build." >&2
  exit 1
fi

mkdir -p "$FIXTURES"
cp "$DEPLOY/midprice_pino.so" "$FIXTURES/midprice_pino.so"
echo "Copied $DEPLOY/midprice_pino.so -> $FIXTURES/midprice_pino.so"

if [[ -f "$DEPLOY/midprice_pino-keypair.json" ]]; then
  cp "$DEPLOY/midprice_pino-keypair.json" "$FIXTURES/midprice_pino-keypair.json"
  echo "Copied $DEPLOY/midprice_pino-keypair.json -> $FIXTURES/midprice_pino-keypair.json"
else
  echo "Note: no keypair at $DEPLOY/midprice_pino-keypair.json; using existing $FIXTURES/midprice_pino-keypair.json if present."
fi

echo "Done. Bankrun tests will load midprice_pino from $FIXTURES."

if $RUN_TESTS; then
  anchor test
  echo """
  echo "Running PropAMM bankrun tests"
  echo """
  ANCHOR_WALLET=~/.config/solana/id.json ts-mocha -t 120000 ./tests/propAmmCUs.ts
fi
