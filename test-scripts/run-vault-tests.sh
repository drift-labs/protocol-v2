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
set -e
trap 'echo -e "\nStopped by signal $? (SIGINT)"; exit 0' INT

if [ "$1" != "--skip-build" ]; then
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
  driftVaults.ts
)

for test_file in "${test_files[@]}"; do
  ts-mocha --exit -t 300000 ./tests/vaults/${test_file} || exit 1
done
