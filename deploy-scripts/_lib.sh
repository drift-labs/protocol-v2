#!/bin/sh
# Shared helpers for devnet deploy scripts. Source with:
#   . "$(dirname "$0")/_lib.sh"
#
# Sets:
#   script_dir   absolute path to deploy-scripts/
#   repo_root    absolute path to repo root
#
# Defines:
#   velocity_devnet_program_id   prints [programs.devnet].velocity from Anchor.toml
#   resolve_velocity_devnet_program_id <varname>
#                             sets <varname> to $<varname> if non-empty, else
#                             to the Anchor.toml value; errors if both are empty
#   resolve_upgrade_keypair <varname>
#                             sets <varname> from VELOCITY_DEVNET_UPGRADE_KEYPAIR,
#                             or legacy SOLANA_PATH/$DEVNET_ADMIN; errors if neither

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

velocity_devnet_program_id() {
	awk -F'"' '
		/^\[programs\.devnet\]/ { s=1; next }
		/^\[/                   { s=0 }
		s && $1 ~ /^velocity[[:space:]]*=/ { print $2; exit }
	' "$repo_root/Anchor.toml"
}

resolve_velocity_devnet_program_id() {
	# Resolve the devnet program id into the named variable.
	# Env override wins; otherwise read from Anchor.toml.
	# Sets VELOCITY_DEVNET_PROGRAM_ID_ENV=1 when the env value was used (for
	# confirm_program_id's source reporting).
	_var="$1"
	eval "_cur=\${$_var:-}"
	VELOCITY_DEVNET_PROGRAM_ID_ENV=""
	if [ -n "$_cur" ]; then
		VELOCITY_DEVNET_PROGRAM_ID_ENV=1
	else
		_cur="$(velocity_devnet_program_id)"
	fi
	if [ -z "$_cur" ]; then
		echo "Could not resolve $_var from \$_var or Anchor.toml [programs.devnet].velocity" >&2
		exit 1
	fi
	eval "$_var=\"\$_cur\""
}

resolve_upgrade_keypair() {
	_var="$1"
	if [ -n "${VELOCITY_DEVNET_UPGRADE_KEYPAIR:-}" ]; then
		eval "$_var=\"\$VELOCITY_DEVNET_UPGRADE_KEYPAIR\""
	elif [ -n "${SOLANA_PATH:-}" ] && [ -n "${DEVNET_ADMIN:-}" ]; then
		eval "$_var=\"\$SOLANA_PATH/\$DEVNET_ADMIN\""
	else
		echo "Set VELOCITY_DEVNET_UPGRADE_KEYPAIR (recommended), or both SOLANA_PATH and DEVNET_ADMIN" >&2
		exit 1
	fi
}

# Print the resolved program id + its source, then prompt for confirmation
# unless NON_INTERACTIVE=1 / YES=1. Call AFTER resolve_velocity_devnet_program_id.
#
# Usage: confirm_program_id <id> <action-description>
confirm_program_id() {
	_pid="$1"
	_action="${2:-on-chain action}"
	if [ -n "${VELOCITY_DEVNET_PROGRAM_ID_ENV:-}" ]; then
		_src="VELOCITY_DEVNET_PROGRAM_ID env override"
	else
		_src="$repo_root/Anchor.toml [programs.devnet].velocity"
	fi
	echo ""
	echo "=== devnet $_action ==="
	echo "  program id : $_pid"
	echo "  source     : $_src"
	echo ""
	if [ "${NON_INTERACTIVE:-}" = "1" ] || [ "${YES:-}" = "1" ]; then
		echo "  (NON_INTERACTIVE/YES set — proceeding without prompt)"
		return 0
	fi
	printf "Proceed against this program id? [y/N] "
	read _ans
	case "$_ans" in
		y|Y|yes|YES) ;;
		*) echo "aborted." >&2; exit 1 ;;
	esac
}
