<div align="center">
  <img height="120" src="./assets/velocity-logo.svg" />

  <h1 style="margin-top:20px;">Velocity Exchange</h1>

  <p>
    <a href="https://drift-labs.github.io/v2-teacher/"><img alt="Docs" src="https://img.shields.io/badge/docs-tutorials-blueviolet" /></a>
    <a href="https://discord.com/channels/849494028176588802/878700556904980500"><img alt="Discord Chat" src="https://img.shields.io/discord/889577356681945098?color=blueviolet" /></a>
    <a href="https://opensource.org/licenses/Apache-2.0"><img alt="License" src="https://img.shields.io/github/license/project-serum/anchor?color=blueviolet" /></a>
  </p>
</div>

# Drift Protocol v2

This repository provides open source access to Drift V2's Typescript SDK, Solana Programs, and more.

Integrating Drift? [Go here](./sdk/README.md)

# SDK Guide

SDK docs can be found [here](./sdk/README.md)

# Example Bot Implementations

Example bots (makers, liquidators, fillers, etc) can be found [here](https://github.com/drift-labs/keeper-bots-v2)

# Building Locally

Note: If you are running the build on an Apple computer with an M1 chip, please set the default rust toolchain to `stable-x86_64-apple-darwin`

```bash
rustup default stable-x86_64-apple-darwin
```

## Compiling Programs

```bash
# build v2
anchor build
# install packages
bun install
# build sdk
cd sdk/ && bun install && bun run build && cd ..
```

## Running Rust Test

For running cargo tests, you'll need version 1.70. You'll also need Solana CLI version 1.16.27

```bash
rustup override set 1.70
cargo test
```

## Running Javascript Tests

```bash
bash test-scripts/run-anchor-tests.sh
```

# Development (with devcontainer)

We've provided a devcontainer `Dockerfile` to help you spin up a dev environment with the correct versions of Rust, Solana, and Anchor for program development.

Build the container and tag it `drift-dev`:

```
cd .devcontainer && docker build -t drift-dev .
```

Open a shell to the container:

```
# Find the container ID first
docker ps

# Then exec into it
docker exec -it <CONTAINER_ID> /bin/bash
```

Alternatively use an extension provided by your IDE to make use of the dev container. For example on vscode/cursor:

```
1. Press Ctrl+Shift+P (or Cmd+Shift+P on Mac)
2. Type "Dev Containers: Reopen in Container"
3. Select it and wait for the container to build
4. The IDE terminal should be targeting the dev container now
```

Use the dev container as you would a local build environment:

```
# build program
anchor build

# update idl
anchor build -- --features anchor-test && cp target/idl/drift.json sdk/src/idl/drift.json

# run cargo tests
cargo test

# run typescript tests
bash test-scripts/run-anchor-tests.sh
```

## Development (with docker-compose)

You can also run the dev environment using Docker Compose:

```bash
cd .devcontainer
docker compose up -d
docker compose exec drift bash
```

# Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please). You never bump a version or publish to npm by hand — version numbers, `CHANGELOG.md` entries, Git tags, and npm publishes are all derived from [Conventional Commit](https://www.conventionalcommits.org/) history.

## What you need to do

PRs are **squash-merged**, so the squashed commit subject is the PR title. That means **your PR title must be a valid Conventional Commit** — it's the only thing release-please reads. The `pr-title-lint` check enforces this on every PR.

| PR title prefix | Effect on the next release |
| --- | --- |
| `feat: …` | minor bump (see pre-1.0 note below) |
| `fix: …` / `perf: …` | patch bump |
| `feat!: …` or a `BREAKING CHANGE:` footer | major bump (see pre-1.0 note below) |
| `docs:` `test:` `build:` `ci:` `chore:` `style:` `refactor:` | no version bump (some appear in the changelog, some are hidden) |

Add a scope when useful, e.g. `fix(margin): correct rounding on partial fills`.

> **Pre-1.0 note:** while a package's major version is `0` (the SDK is currently `0.x`), release-please down-shifts bumps by one level — `feat` behaves like a patch and a breaking change behaves like a minor. Set `bump-minor-pre-major: true` in `release-please-config.json` if you want `feat` to drive minor bumps before 1.0.
>
> **Reminder — flip this on the first release:** we deliberately ship the first
> few releases with the down-shifted (default) behavior to keep early `0.x`
> versions calm. Once we cut the first real release and want `feat:` to mean a
> proper minor bump, set `bump-minor-pre-major: true` in
> [`release-please-config.json`](./release-please-config.json) and update this
> table.

## How a release happens

1. **You merge a feature/fix PR** into `master` with a Conventional Commit title.
2. **release-please opens (or updates) a "release PR"** titled `chore(master): release …`. This PR bumps the version in `package.json`, regenerates `CHANGELOG.md`, and updates `.release-please-manifest.json`. It is **recomputed on every push** to `master` — the version reflects the highest bump across all unreleased commits, and new commits keep getting added to it. It does **not** publish anything.
3. **You merge the release PR** when you're ready to ship. release-please then creates the Git tag(s) and GitHub Release(s).
4. **Publish jobs run automatically** (`.github/workflows/release-please.yml`), publishing the bumped packages to npm via OIDC [trusted publishing](https://docs.npmjs.com/trusted-publishers) — no `NPM_TOKEN`. Downstream repos are notified via `repository_dispatch`.

Leaving the release PR open is fine and expected — accumulate changes until you want to cut a release, then merge it.

## Managed packages

| Path | npm package | Tag format |
| --- | --- | --- |
| `sdk/` | `@velocity-exchange/sdk` (+ `-browser`) | `sdk-v<version>` |
| `cli-admin/` | `@velocity-exchange/admin-cli` | `cli-admin-v<version>` |

Versions are tracked independently in [`.release-please-manifest.json`](./.release-please-manifest.json); per-package settings live in [`release-please-config.json`](./release-please-config.json).

## Forcing a specific version

Add a `Release-As:` footer to a commit (or a manually titled PR), e.g.:

```bash
git commit --allow-empty -m "chore: release 1.0.0" -m "Release-As: 1.0.0"
```

# Bug Bounty

Information about the Bug Bounty can be found [here](./bug-bounty/README.md)
