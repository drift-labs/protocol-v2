#!/usr/bin/env bash
#
# verify-buffer.sh — independently verify a GitHub Actions deploy.
#
# A multisig signer should NOT trust the buffer hash printed by CI. This script
# reproduces it from source:
#
#   1. Builds <program> locally with `solana-verify build` (verifiable, in the
#      same docker image CI uses) and hashes the resulting .so.
#   2. Pulls the on-chain buffer address that the Actions run logged.
#   3. Hashes that on-chain buffer and confirms it matches your local build.
#
# If the hashes match, the buffer the multisig is about to upgrade to is exactly
# what `<program>` compiles to from your current checkout.
#
# Usage:
#   deploy-scripts/verify-buffer.sh <program> <actions-run-or-job-url> [options]
#
#   <program>                 velocity | token_faucet (cargo library name)
#   <actions-run-or-job-url>  e.g. https://github.com/<org>/<repo>/actions/runs/<id>[/job/<id>]
#
# Options:
#   --devnet                  strip the mainnet-beta feature (velocity devnet build)
#   --rpc <url>               RPC used to read the on-chain buffer (else solana config / public)
#   --buffer <pubkey>         use this buffer address instead of parsing the run log
#   --image <docker-image>    verifiable-build image (default below)
#   --skip-build              reuse an existing target/deploy/<program>.so
#   -h, --help                show this help
#
# Requires: solana-verify, gh (authenticated), solana CLI on PATH.
set -euo pipefail

DEFAULT_IMAGE="solanafoundation/solana-verifiable-build:3.1.14"

die() { echo "error: $*" >&2; exit 1; }

program=""
run_url=""
devnet=0
rpc=""
buffer=""
image="$DEFAULT_IMAGE"
skip_build=0

need_value() { [ $# -ge 2 ] || die "$1 requires a value (got none — is the variable you passed set?)"; }

while [ $# -gt 0 ]; do
	case "$1" in
		--devnet) devnet=1; shift ;;
		--rpc) need_value "$@"; rpc="$2"; shift 2 ;;
		--buffer) need_value "$@"; buffer="$2"; shift 2 ;;
		--image) need_value "$@"; image="$2"; shift 2 ;;
		--skip-build) skip_build=1; shift ;;
		-h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		-*) die "unknown option: $1" ;;
		*)
			if [ -z "$program" ]; then program="$1"
			elif [ -z "$run_url" ]; then run_url="$1"
			else die "unexpected argument: $1"; fi
			shift ;;
	esac
done

[ -n "$program" ] || die "missing <program> (velocity | token_faucet)"
[ -n "$buffer" ] || [ -n "$run_url" ] || die "provide <actions-run-or-job-url> or --buffer <pubkey>"

command -v solana-verify >/dev/null || die "solana-verify not found on PATH"

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

# --- 1. resolve the on-chain buffer address ------------------------------------

logged_hash=""
if [ -z "$buffer" ]; then
	command -v gh >/dev/null || die "gh not found on PATH (needed to read the run log)"
	# Accept .../runs/<runId>[/job/<jobId>]; prefer the job id when present.
	job_id="$(printf '%s' "$run_url" | sed -nE 's#.*/job/([0-9]+).*#\1#p')"
	run_id="$(printf '%s' "$run_url" | sed -nE 's#.*/runs/([0-9]+).*#\1#p')"
	[ -n "$job_id" ] || [ -n "$run_id" ] || die "could not parse a run/job id from: $run_url"

	echo ">> fetching deploy log from GitHub Actions..." >&2
	if [ -n "$job_id" ]; then
		log="$(gh run view --job "$job_id" --log)"
	else
		log="$(gh run view "$run_id" --log)"
	fi

	# buffer-deploy logs the program (BPF) buffer address as `program buffer: <addr>`.
	# Match case-insensitively with flexible spacing so it works across log formats
	# ("Program buffer:" from the old collect step and "program buffer:" from the
	# newer consolidated summary). The trailing ":" right after "buffer" keeps this
	# from matching the "program buffer hash:" line. Take the last match.
	buffer="$(printf '%s' "$log" | grep -oiE 'program buffer:[[:space:]]+[1-9A-HJ-NP-Za-km-z]{32,44}' | tail -1 | awk '{print $NF}')"
	[ -n "$buffer" ] || die "could not find a 'program buffer:' address in the run log"
	# And the hash CI logged, for an extra cross-check (sha256 hex). Matches both
	# the old "Buffer hash:" and the new "program buffer hash:" lines.
	logged_hash="$(printf '%s' "$log" | grep -oiE 'buffer hash:[[:space:]]+[0-9a-f]{64}' | tail -1 | awk '{print $NF}')"
fi
echo ">> on-chain buffer: $buffer" >&2

# --- 2. verifiable build + local hash ------------------------------------------

so_path="$repo_root/target/deploy/${program}.so"
if [ "$skip_build" -eq 0 ]; then
	echo ">> building $program with solana-verify (image: $image)..." >&2
	build_args="--library-name $program -b $image"
	# velocity's declare_id! is cfg-gated; devnet build drops mainnet-beta so the
	# devnet program id resolves (mirrors .github/actions/build-program).
	if [ "$program" = "velocity" ] && [ "$devnet" -eq 1 ]; then
		( cd "$repo_root" && solana-verify build $build_args -- --no-default-features --features no-entrypoint )
	else
		( cd "$repo_root" && solana-verify build $build_args )
	fi
else
	echo ">> --skip-build: reusing $so_path" >&2
fi
[ -f "$so_path" ] || die "built artifact not found: $so_path"

local_hash="$(solana-verify get-executable-hash "$so_path")"

# --- 3. on-chain buffer hash + compare -----------------------------------------

# solana-verify reads the CLI config file; make sure one exists.
if [ -n "$rpc" ]; then
	solana config set --url "$rpc" >/dev/null 2>&1 || true
	onchain_hash="$(solana-verify get-buffer-hash --url "$rpc" "$buffer")"
else
	onchain_hash="$(solana-verify get-buffer-hash "$buffer")"
fi

echo
echo "program:            $program"
echo "buffer:             $buffer"
echo "local build hash:   $local_hash"
echo "on-chain buffer:    $onchain_hash"
[ -n "$logged_hash" ] && echo "hash logged by CI:  $logged_hash"
echo

if [ "$local_hash" = "$onchain_hash" ]; then
	echo "✅ MATCH — the on-chain buffer is exactly this source's verifiable build."
	if [ -n "$logged_hash" ] && [ "$logged_hash" != "$onchain_hash" ]; then
		echo "⚠️  note: the hash CI logged ($logged_hash) differs from the live buffer hash;"
		echo "    the buffer may have been replaced since the run — re-check the address."
	fi
	exit 0
else
	echo "❌ MISMATCH — do NOT approve. The buffer does not match this source build."
	exit 1
fi
