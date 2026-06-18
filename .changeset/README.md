# Changesets

This monorepo uses [changesets](https://github.com/changesets/changesets) for versioning and
publishing the library packages under `packages/*` (`@velocity-exchange/sdk`,
`@velocity-exchange/admin-cli`, `@velocity-exchange/vaults-sdk`). Apps under `apps/*` are
`private` and ship as Docker images (see `docker-info.json` / `docker-on-tag.yml`), not npm.

Workflow:

1. In a PR that changes a publishable package, run `bun run changeset` and describe the bump.
2. On merge to `master`, the `changesets` workflow opens/updates a **Version Packages** PR that
   runs `changeset version` (bumps versions + writes CHANGELOGs). Merge it to commit the bumps.
3. Push a tag `release-v<date-or-number>` — the `npm-publish` workflow publishes every
   non-private `packages/*` whose committed version isn't already on the registry (idempotent).
