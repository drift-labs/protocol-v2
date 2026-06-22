#!/bin/bash
# Runs the vaults integration suite (tests/vaults/) under ts-mocha + bankrun.
#
# Unlike the velocity suite (run-anchor-tests.sh), the velocity program is built
# WITHOUT the mainnet-beta feature here. The vault program creates a drift user +
# user-stats on behalf of depositors via CPI (authority = vault PDA, payer =
# manager); velocity's mainnet-beta build gates that behind an
# external-depositor whitelist (programs/velocity/src/instructions/user.rs), so a
# mainnet-beta .so rejects every vault initialize. Dropping the default features
# compiles the gate out (it is `#[cfg(feature = "mainnet-beta")]`). The vaults +
# fixture programs build with their defaults; bankrun loads all of them from
# target/deploy via the localnet entries in Anchor.toml.
#
# Build/run modes (mirrors run-anchor-tests.sh so CI can cache the compiled .so):
#   (no arg)       build programs + build SDKs + run tests   — local dev
#   --build-only   build programs only                       — CI cache-miss step
#   --skip-build   sync IDL + build SDKs + run tests          — CI always-run step
# CI restores target/deploy + target/idl from a content-hashed cache; on a miss it
# runs `--build-only` then saves the cache, and always finishes with `--skip-build`.
set -e
trap 'echo -e "\nStopped by SIGINT"; exit 130' INT

MODE="${1:-}"

build_programs() {
  # Clean any restored/incremental SBF artifacts first — building on top of stale
  # .rlibs can emit a .so with wrong offsets after a Cargo.lock change (see
  # CLAUDE.md "Access violation" note). The program cache reuses the final .so on
  # a hit; on a miss we always build fresh.
  rm -rf target/sbpf-solana-solana target/deploy
  # Build velocity ALONE with the no-default-features flags (drops mainnet-beta so
  # the external-depositor whitelist gate is compiled out — see header).
  anchor build --ignore-keys --skip-lint -p velocity -- --no-default-features --features no-entrypoint,anchor-test
  cp target/idl/velocity.json packages/sdk/src/idl/
  cp target/types/velocity.ts packages/sdk/src/idl/
  # vaults: build with its DEFAULT features (keep the entrypoint) PLUS anchor-test.
  # Two reasons the original single workspace build was wrong:
  #   1. velocity's `--no-default-features` stripped vaults' own entrypoint, producing
  #      an 896-byte stub .so → bankrun "Program is not deployed" → "invalid account
  #      data for instruction" in every vault test's before hook.
  #   2. `anchor-test` selects the test admin id (constants.rs `admin::ID`) that the
  #      suite signs fee-update ix with; without it `is_admin` fails with 0x7d3.
  anchor build --ignore-keys --skip-lint -p vaults -- --features anchor-test
  # fixture programs: plain defaults.
  anchor build --ignore-keys --skip-lint -p pyth
  anchor build --ignore-keys --skip-lint -p token_faucet
}

if [ "$MODE" = "--build-only" ]; then
  build_programs
  exit 0
fi

if [ "$MODE" != "--skip-build" ]; then
  build_programs
else
  # --skip-build still needs the bundled SDK IDL/types to match the deployed
  # program, otherwise tx instructions target a layout bankrun never loaded. With
  # the CI program cache target/idl is always populated (restored on a hit, freshly
  # built on a miss), so a missing IDL means the caller skipped the build by
  # mistake — fail loudly rather than silently testing against a stale bundled IDL.
  if [ ! -f target/idl/velocity.json ] || [ ! -f target/types/velocity.ts ] || \
     [ ! -f target/deploy/velocity.so ] || [ ! -f target/deploy/vaults.so ] || \
     [ ! -f target/deploy/pyth.so ] || [ ! -f target/deploy/token_faucet.so ]; then
    echo "ERROR: required IDL, types, or .so artifacts are missing —" >&2
    echo "       cannot guarantee the SDK IDL matches the deployed program." >&2
    echo "       Run without --skip-build, or restore a fresh build into target/ first." >&2
    exit 1
  fi
  cp target/idl/velocity.json packages/sdk/src/idl/
  cp target/types/velocity.ts packages/sdk/src/idl/
fi

# The vault tests import the velocity + vaults SDKs by package root, which resolves
# through package.json `main` to the built lib/ — build them after the IDL sync.
( cd packages/sdk && bun run build >/dev/null )
( cd packages/vaults-sdk && bun run build >/dev/null )

export ANCHOR_WALLET=~/.config/solana/id.json

test_files=(
  managerUpdate.test.ts
  depositMax.test.ts
  feeUpdate.test.ts
  sharesExamples.test.ts
  transferVaultDepositorShares.test.ts
  trustedVault.test.ts
  velocityVaults.ts
)

# Run up to PARALLEL test files concurrently. bankrun is fully in-process, so each
# ts-mocha is an independent node process with its own SVM — files don't share
# chain state and can run in parallel. Output is buffered per file and only printed
# on failure so interleaved stdout from concurrent processes stays legible. Same
# reaper pattern as run-anchor-tests.sh.
PARALLEL=${PARALLEL:-4}
tmpdir=$(mktemp -d)
trap "rm -rf '$tmpdir'" EXIT

declare -a q_pids=()
declare -a q_files=()
declare -a q_logs=()
overall_failed=0

# Reap whichever queued child finishes first, to avoid head-of-line blocking when
# the oldest file is slow (velocityVaults.ts dominates). `wait -n` (bash >= 4.3)
# blocks efficiently; on bash 3.2 (macOS default) we fall back to a short poll.
collect_any() {
  if [ "${BASH_VERSINFO[0]}" -gt 4 ] || \
     { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -ge 3 ]; }; then
    wait -n || :
  fi

  local idx=-1
  while true; do
    local i
    for i in "${!q_pids[@]}"; do
      if ! kill -0 "${q_pids[$i]}" 2>/dev/null; then
        idx=$i
        break
      fi
    done
    [ $idx -ne -1 ] && break
    sleep 0.2
  done

  local pid="${q_pids[$idx]}"
  local file="${q_files[$idx]}"
  local log="${q_logs[$idx]}"
  q_pids=("${q_pids[@]:0:$idx}" "${q_pids[@]:$(( idx + 1 ))}")
  q_files=("${q_files[@]:0:$idx}" "${q_files[@]:$(( idx + 1 ))}")
  q_logs=("${q_logs[@]:0:$idx}" "${q_logs[@]:$(( idx + 1 ))}")
  # `wait <pid>` returns that child's remembered status even after it was
  # already reaped by `wait -n` or bash's async reaper.
  if wait "$pid"; then
    echo "  pass: $file"
  else
    echo ""
    echo "══════════════════════════════════════"
    echo "  FAIL: $file"
    echo "══════════════════════════════════════"
    cat "$log"
    overall_failed=1
  fi
}

for test_file in "${test_files[@]}"; do
  [ $overall_failed -eq 1 ] && break
  while [ ${#q_pids[@]} -ge $PARALLEL ]; do
    collect_any
    [ $overall_failed -eq 1 ] && break 2
  done
  log="$tmpdir/${test_file}"
  ts-mocha --exit -t 300000 "./tests/vaults/$test_file" >"$log" 2>&1 &
  q_pids+=($!)
  q_files+=("$test_file")
  q_logs+=("$log")
  echo "  start: $test_file"
done

while [ ${#q_pids[@]} -gt 0 ]; do
  collect_any
done

[ $overall_failed -eq 0 ] || exit 1
