#!/bin/bash
# Extract complete IDL from anchor 1.0 test binary, bypassing the broken
# `anchor idl build` CLI wrapper.
set -euo pipefail

BIN="$1"
OUT="$2"
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

"$BIN" __anchor_private --nocapture --test-threads=1 2>&1 \
    | sed 's/^test [^ ]* \.\.\. //' > "$TMP/clean.txt"

awk '/^--- IDL begin program ---$/{flag=1; next} /^--- IDL end program ---$/{flag=0} flag' "$TMP/clean.txt" > "$TMP/program.json"
awk '/^--- IDL begin errors ---$/{flag=1; next} /^--- IDL end errors ---$/{flag=0} flag' "$TMP/clean.txt" > "$TMP/errors.json"
# Address is emitted as `"\"<pubkey>\""` (double-quoted JSON string). Strip
# the outer wrapping to get the bare pubkey for the IDL `address` field.
ADDR=$(awk '/^--- IDL begin address ---$/{flag=1; next} /^--- IDL end address ---$/{flag=0} flag' "$TMP/clean.txt" | head -1 | sed 's/^"\\"\(.*\)\\""$/\1/')

# Split events into individual JSON files via awk
awk -v dir="$TMP" 'BEGIN{n=0; out=""}
    /^--- IDL begin event ---$/ {out=sprintf("%s/event-%d.json", dir, n); n++; next}
    /^--- IDL end event ---$/ {close(out); out=""; next}
    out != "" {print > out}
' "$TMP/clean.txt"

# Combine each per-event {event, types} object into one big array via jq -s
jq -s '.' "$TMP"/event-*.json > "$TMP/events-combined.json"

jq -s --arg addr "$ADDR" '.[0] + {
    address: $addr,
    errors: .[1],
    events: (.[2] | map(.event)),
    types: (
        (.[0].types + (.[2] | map(.types) | add // []))
        | group_by(.name)
        | map(.[0])
    )
}' "$TMP/program.json" "$TMP/errors.json" "$TMP/events-combined.json" \
| jq '
    # Mirror anchor-1.0 CLI `convert_module_paths`: strip Rust path
    # qualifiers from `name` fields when there is no resulting collision.
    walk(
        if type == "object" and has("name") and (.name | type == "string") and (.name | contains("::"))
        then .name |= (split("::") | last)
        else .
        end
    )
' > "$OUT"

echo "Wrote $OUT ($(wc -l < "$OUT") lines):"
jq '{events: (.events | length), errors: (.errors | length), instructions: (.instructions | length), accounts: (.accounts | length), types: (.types | length)}' "$OUT"
