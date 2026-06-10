#!/bin/sh
# Upload velocity.so into a staging buffer on devnet. Use a private RPC (set
# SOLANA_RPC or RPC_URL) to avoid public devnet rate limits on large writes.
#
# Prerequisites: bash deploy-scripts/build-devnet.sh
#
# Env (see deploy-scripts/.env.example):
#   VELOCITY_DEVNET_PROGRAM_ID   override; default reads [programs.devnet].velocity from Anchor.toml
#   VELOCITY_DEVNET_UPGRADE_KEYPAIR  (or SOLANA_PATH + DEVNET_ADMIN) — buffer authority
#   BUFFER_AUTHORITY   override (defaults to upgrade keypair path)
#   FEE_PAYER          override (defaults to same)
#   BUFFER_ACCOUNT_KEYPAIR  new file to create for this buffer account (default
#                           deploy-scripts/out/velocity-so-write-buffer-keypair.json)
#   PROGRAM_SO         default target/deploy/velocity.so
#   SOLANA_RPC / RPC_URL   default https://api.devnet.solana.com

set -eu

. "$(dirname "$0")/_lib.sh"

resolve_velocity_devnet_program_id VELOCITY_DEVNET_PROGRAM_ID
PROGRAM_SO="${PROGRAM_SO:-target/deploy/velocity.so}"
SOLANA_RPC="${SOLANA_RPC:-${RPC_URL:-https://api.devnet.solana.com}}"

resolve_upgrade_keypair UPGRADE_KEYPAIR

BUFFER_AUTHORITY="${BUFFER_AUTHORITY:-$UPGRADE_KEYPAIR}"
FEE_PAYER="${FEE_PAYER:-$UPGRADE_KEYPAIR}"
BUFFER_ACCOUNT_KEYPAIR="${BUFFER_ACCOUNT_KEYPAIR:-deploy-scripts/out/velocity-so-write-buffer-keypair.json}"

if [ ! -f "$PROGRAM_SO" ]; then
	echo "Missing $PROGRAM_SO — run: bash deploy-scripts/build-devnet.sh" >&2
	exit 1
fi

PROGRAM_KEYPAIR="${PROGRAM_KEYPAIR:-}"
if [ -n "$PROGRAM_KEYPAIR" ] && [ -f "$PROGRAM_KEYPAIR" ]; then
	KP=$(solana-keygen pubkey "$PROGRAM_KEYPAIR")
	if [ "$KP" != "$VELOCITY_DEVNET_PROGRAM_ID" ]; then
		echo "PROGRAM_KEYPAIR pubkey $KP != VELOCITY_DEVNET_PROGRAM_ID $VELOCITY_DEVNET_PROGRAM_ID" >&2
		exit 1
	fi
fi

confirm_program_id "$VELOCITY_DEVNET_PROGRAM_ID" "write-buffer for upcoming deploy"

mkdir -p "$(dirname "$BUFFER_ACCOUNT_KEYPAIR")"
if [ ! -f "$BUFFER_ACCOUNT_KEYPAIR" ]; then
	solana-keygen new --no-bip39-passphrase -s -o "$BUFFER_ACCOUNT_KEYPAIR"
fi

solana program write-buffer "$PROGRAM_SO" \
	-u "$SOLANA_RPC" \
	--buffer "$BUFFER_ACCOUNT_KEYPAIR" \
	--buffer-authority "$BUFFER_AUTHORITY" \
	--fee-payer "$FEE_PAYER"

BUFFER_PK=$(solana-keygen pubkey "$BUFFER_ACCOUNT_KEYPAIR")
echo ""
echo "Buffer keypair file: $BUFFER_ACCOUNT_KEYPAIR"
echo "Buffer pubkey: $BUFFER_PK"
echo ""
echo "Initial deploy from this buffer:"
echo "  BUFFER_ACCOUNT_KEYPAIR=$BUFFER_ACCOUNT_KEYPAIR PROGRAM_KEYPAIR=<your-$VELOCITY_DEVNET_PROGRAM_ID.json> \\"
echo "    bash deploy-scripts/deploy-from-buffer-devnet.sh"
