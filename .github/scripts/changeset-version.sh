#!/usr/bin/env bash
# Wrapper for `changeset version` used by .github/workflows/changesets.yml.
#
# @changesets/changelog-github enriches changelog entries by querying the GitHub
# GraphQL API (api.github.com/graphql) during `changeset version`. That fetch
# intermittently dies with `ERR_STREAM_PREMATURE_CLOSE` ("Premature close"),
# which fails the whole job on roughly half of pushes to master. On that failure
# changesets reports "We have escaped applying the changesets, and no files should
# have been affected", so the version step is safe to re-run — retry it a few
# times with backoff before giving up.
set -uo pipefail

attempts=5
for i in $(seq 1 "$attempts"); do
  if bun run version-packages; then
    exit 0
  fi
  if [ "$i" -lt "$attempts" ]; then
    delay=$((i * 5))
    echo "::warning::changeset version attempt ${i}/${attempts} failed (likely a transient GitHub GraphQL fetch); retrying in ${delay}s..." >&2
    sleep "$delay"
  fi
done

echo "::error::changeset version failed after ${attempts} attempts." >&2
exit 1
