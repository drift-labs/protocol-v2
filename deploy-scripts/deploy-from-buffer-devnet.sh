#!/bin/sh
# First-time program deploy on devnet from a buffer created by write-buffer-devnet.sh
# (same cluster + upgrade authority). Re-runs after the program exists: use
# deploy-scripts/deploy-devnet.sh (anchor upgrade) instead.
#
# Env:
#   BUFFER_ACCOUNT_KEYPAIR   required — same file passed to write-buffer-devnet.sh
#   PROGRAM_KEYPAIR          required — JSON keypair whose pubkey is VELOCITY_DEVNET_PROGRAM_ID
#   VELOCITY_DEVNET_PROGRAM_ID  override; default reads [programs.devnet].velocity from Anchor.toml
#   PROGRAM_SO               default target/deploy/velocity.so (ELF sanity check)
#   VELOCITY_DEVNET_UPGRADE_KEYPAIR | SOLANA_PATH+DEVNET_ADMIN — upgrade authority
#   SOLANA_RPC / RPC_URL

set -eu

. "$(dirname "$0")/_lib.sh"

resolve_velocity_devnet_program_id VELOCITY_DEVNET_PROGRAM_ID
PROGRAM_SO="${PROGRAM_SO:-target/deploy/velocity.so}"
SOLANA_RPC="${SOLANA_RPC:-${RPC_URL:-https://api.devnet.solana.com}}"

BUFFER_ACCOUNT_KEYPAIR="${BUFFER_ACCOUNT_KEYPAIR:?Set BUFFER_ACCOUNT_KEYPAIR (output from write-buffer-devnet.sh)}"
PROGRAM_KEYPAIR="${PROGRAM_KEYPAIR:?Set PROGRAM_KEYPAIR — JSON file for program id $VELOCITY_DEVNET_PROGRAM_ID}"

if [ ! -f "$BUFFER_ACCOUNT_KEYPAIR" ]; then
	echo "BUFFER_ACCOUNT_KEYPAIR not found: $BUFFER_ACCOUNT_KEYPAIR" >&2
	exit 1
fi
if [ ! -f "$PROGRAM_KEYPAIR" ]; then
	echo "PROGRAM_KEYPAIR not found: $PROGRAM_KEYPAIR" >&2
	exit 1
fi
if [ ! -f "$PROGRAM_SO" ]; then
	echo "Missing $PROGRAM_SO — run: bash deploy-scripts/build-devnet.sh" >&2
	exit 1
fi

KP=$(solana-keygen pubkey "$PROGRAM_KEYPAIR")
if [ "$KP" != "$VELOCITY_DEVNET_PROGRAM_ID" ]; then
	echo "PROGRAM_KEYPAIR pubkey $KP != VELOCITY_DEVNET_PROGRAM_ID $VELOCITY_DEVNET_PROGRAM_ID" >&2
	exit 1
fi

resolve_upgrade_keypair UPGRADE_KEYPAIR

confirm_program_id "$VELOCITY_DEVNET_PROGRAM_ID" "first-time program deploy from buffer"

solana program deploy "$PROGRAM_SO" \
	-u "$SOLANA_RPC" \
	--buffer "$BUFFER_ACCOUNT_KEYPAIR" \
	--program-id "$PROGRAM_KEYPAIR" \
	--upgrade-authority "$UPGRADE_KEYPAIR"

echo "Deployed program $VELOCITY_DEVNET_PROGRAM_ID"
