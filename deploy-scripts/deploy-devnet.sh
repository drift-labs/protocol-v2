#!/bin/sh
set -eu

. "$(dirname "$0")/_lib.sh"

resolve_velocity_devnet_program_id VELOCITY_DEVNET_PROGRAM_ID
resolve_upgrade_keypair UPGRADE_KEYPAIR

confirm_program_id "$VELOCITY_DEVNET_PROGRAM_ID" "anchor upgrade"

anchor program upgrade \
	--program-id "$VELOCITY_DEVNET_PROGRAM_ID" \
	--provider.cluster devnet \
	--provider.wallet "$UPGRADE_KEYPAIR" \
	target/deploy/velocity.so
