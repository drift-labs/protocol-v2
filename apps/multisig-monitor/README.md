# Multisig Monitor

## Overview

The Multisig Monitor watches Drift's Squads v4 multisigs and council signer wallets in real time, decoding governance events and posting them to Slack. It consumes Yellowstone Fumarole (durable, persistent-subscriber gRPC) and runs two parallel detection streams:

### Multisig activity stream

Subscribes to transactions whose account list includes any watched multisig or council signer. Decodes the Squads v4 instruction (proposal lifecycle, vault/config transaction create/execute, direct config changes) and renders the event to Slack. For `vault_transaction_create` and `vault_transaction_execute`, inner CPIs are decoded against bundled Anchor IDLs (Drift, Drift Vaults) — so an alert surfaces _what's actually being approved_ (e.g. `updateAdmin · admin: <newKey>`) at create time, before any threshold is reached.

### Council nonce stream

Subscribes to SystemProgram-owned accounts of size 80 (durable nonce account layout) whose authority arg (offset 8) equals a watched council signer. **This is the only path that catches the Apr 1 2026 attack pattern** — the malicious tx referenced the council signer pubkey only inside the `InitializeNonceAccount` instruction _data_, never in the tx's accountKeys list, so the transaction filter alone would miss it. The Yellowstone snapshot delivered on connect populates a DynamoDB `seen-nonces` store without alerting; subsequent deltas fire alerts.

State (seen-signatures with TTL, seen-nonces permanent) lives in a dedicated DynamoDB table for cross-restart deduplication. The persistent Fumarole subscriber handles slot resume durably, so no slot tracking is needed.

## Entrypoints

-   **Live monitor**: `apps/multisig-monitor/src/index.ts` (Fumarole subscriber + health server + DynamoDB state store)
-   **Replay tool**: `apps/multisig-monitor/scripts/replay.ts` (replay a historical tx through the same pipeline; see [Replay Tool](#replay-tool))

## Getting Started

### Prerequisites

-   Node.js 20+
-   Yarn
-   AWS credentials configured (see `docs/connecting-to-aws.md`)
-   DynamoDB access for the state table
-   Triton Fumarole `xToken` (for the live monitor) or any Solana RPC URL (for replay)

### Installation

```bash
yarn install
yarn workspace @backend/multisig-monitor build
```

### Development

```bash
# Live monitor (esbuild bundle + node)

yarn workspace @backend/multisig-monitor start

# Replay a historical transaction (dry-run by default — see below)

yarn workspace @backend/multisig-monitor replay --signature <sig>
```

There's no ts-node-based dev mode for the live monitor: `@triton-one/yellowstone-fumarole` ships CJS code under a `"type": "module"` package, which trips Node's runtime resolution. esbuild bundles around the issue, so `yarn start` (which builds + runs) is the canonical path.

### Best Development Workflow

Iterate using unit tests first:

```bash
yarn test apps/multisig-monitor
```

The Apr 1 2026 exploit fixtures are preserved in `test/squads/enrich_create.test.ts` and `test/signer/extractor.test.ts` as regression guards. If they break, the detection logic has regressed.

## Configuration

Environment variables (defaults shown where applicable):

**Watch list (required)**

-   `MULTISIG_ADDRESSES`: Comma-separated Squads multisig addresses to monitor
-   `SIGNER_ADDRESSES`: Comma-separated council signer wallets (nonce-targeting alerts; may be empty)

**Slack delivery (required)**

-   `SLACK_WEBHOOK_URL`: Default Slack webhook for all alerts
-   `MULTISIG_ROUTES`: Optional `addr1:url1,addr2:url2` — per-multisig override. Falls back to `SLACK_WEBHOOK_URL`.

**Fumarole (required for live monitor; ignored by replay)**

-   `FUMAROLE_ENDPOINT`: Triton Fumarole endpoint (default: `https://ams.rpcpool.com`)
-   `FUMAROLE_X_TOKEN`: Fumarole auth token
-   `FUMAROLE_SUBSCRIBER_NAME`: Persistent subscriber name (default: `multisig-monitor-${APP_STAGE}`)
-   `START_FROM_TIP`: `true` to delete and recreate the persistent subscriber from the chain tip
-   `FROM_SLOT`: Recreate the subscriber starting at this specific slot
-   `MAX_SLOT_DIFFERENCE`: Slots behind tip before forcing reconnect-from-tip (default: `500`)
-   `RPC_URL`: Solana RPC endpoint, used by the slot-lag check. Optional — without it, the lag check is disabled.

**State store**

-   `STATE_TABLE`: DynamoDB table name (default: `${APP_STAGE}-multisig-monitor-state`)
-   `SEEN_SIGNATURE_TTL_HOURS`: TTL for seen-signature entries (default: `24`)

**Filtering (optional)**

-   `INSTRUCTION_TYPES`: Comma-separated Squads instruction allowlist (empty = all)
-   `CONFIG_TYPES`: Comma-separated config-action allowlist for `config_transaction_create` (empty = all)

**Display flags**

-   `SHOW_PERMISSIONS`: `true` to render member permissions (default: `false`)
-   `SHOW_TIMESTAMPS`: `true` to include block timestamps (default: `false`)
-   `TRUNCATE_ADDRESSES`: `true` to render truncated form (`abcd...wxyz`) alongside the full address (default: `false`)

**Server / logging**

-   `PORT`: Health server port (default: `3000`)
-   `METRICS_PORT`: Prometheus scrape port (default: OpenTelemetry exporter default)
-   `LOG_LEVEL`: `error` | `info` | `debug` (default: `error`)
-   `APP_STAGE`: Used for subscriber name + state table name (default: `local`)

## Replay Tool

The replay tool fetches a historical transaction by signature and runs it through the same `extractOperations` + `extractSignerEvents` + layer-2 IDL decode pipeline as the live monitor. By default it prints the would-be Slack payload as JSON; pass `--send` to actually POST to Slack.

```
yarn workspace @backend/multisig-monitor replay --signature <sig> [--send] [--rpc-url <url>]

  --signature, -s   Solana transaction signature (base58)
  --send            POST the rendered Slack payload (default: dry-run, prints JSON)
  --dry-run         (default) print the rendered payload, don't POST
  --rpc-url         override RPC_URL env var
  --help, -h        show this message
```

### Examples

Replay the Apr 1 2026 vault_transaction_create against mainnet (the create surfaces the embedded `Drift::updateAdmin` CPI before any approval threshold):

```bash
MULTISIG_ADDRESSES=2LW6PSEjp81xSEttWwXDB6Etb1eKdhYPbFEojYbyhx88,BBC5gSPh71YB2eUXdCqvkmL6kj6YDkUQJpX997qXUt2Q,4PRvmZFr5qCBxTXbgnVoeZisPGxRPNDTj8HWTwuwXfen \
  SIGNER_ADDRESSES=13GXtbGV8mNfNLDNbVKPrTcHTpfZ4CYrXviRCZmyxQvj,39JyWrdbVdRqjzw9yyEjxNtTbTKcTPLdtdCgbz7C7Aq8,6UJbu9ut5VAsFYQFgPEa5xPfoyF5bB5oi4EknFPvu924,7TxYEAKSHRuCs1QpxssoeuaewqdQzHf93EKQP7bNYYxh,HgjySRE1j9T2NwFrGbK2hXk4Przoz31xdciedmt6CHF6 \
  yarn workspace @backend/multisig-monitor replay \
    --rpc-url https://api.mainnet-beta.solana.com \
    --signature 2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H
```

Replay the Mar 31 2026 create_nonce_account against mainnet which targeted one of the signer wallets as the authority:

```bash
MULTISIG_ADDRESSES=2LW6PSEjp81xSEttWwXDB6Etb1eKdhYPbFEojYbyhx88,BBC5gSPh71YB2eUXdCqvkmL6kj6YDkUQJpX997qXUt2Q,4PRvmZFr5qCBxTXbgnVoeZisPGxRPNDTj8HWTwuwXfen \
  SIGNER_ADDRESSES=13GXtbGV8mNfNLDNbVKPrTcHTpfZ4CYrXviRCZmyxQvj,39JyWrdbVdRqjzw9yyEjxNtTbTKcTPLdtdCgbz7C7Aq8,6UJbu9ut5VAsFYQFgPEa5xPfoyF5bB5oi4EknFPvu924,7TxYEAKSHRuCs1QpxssoeuaewqdQzHf93EKQP7bNYYxh,HgjySRE1j9T2NwFrGbK2hXk4Przoz31xdciedmt6CHF6 \
  yarn workspace @backend/multisig-monitor replay \
    --rpc-url https://api.mainnet-beta.solana.com \
    --signature 59yWWZjnLeu3WP6Dqj4NW21NWHhdNwkToCbypdNrAHKmhk5C37ZDUygbuDVPSN2XqYzME88k6Ss3sBKGdrmrWrX3
```

Re-run with `--send` after exporting `SLACK_WEBHOOK_URL` to actually deliver to a (sandbox) Slack channel.

### Exit codes

-   `0` — pipeline ran (with or without alerts)
-   `1` — invalid args / missing required env
-   `2` — tx not found at the configured RPC, or RPC error
-   `3` — Slack delivery failed (only with `--send`)

## Bundled IDLs

Layer-2 inner-CPI decoding uses bundled Anchor IDLs to avoid a per-program on-chain `Program.fetchIdl` round-trip. Currently registered in `src/squads/known-idls.ts`:

-   **Drift** (`dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`) via `@velocity-exchange/sdk`
-   **Drift Vaults** (`vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR`) via `@drift-labs/vaults-sdk`

CPIs into programs not in the registry surface as program ID + accounts + (at execute time) the Anchor instruction name from program logs — but without decoded arg names/values. To add coverage for a new program, import its IDL and add it to the registry.

## Credentials and Services

This service depends on AWS (DynamoDB), Triton Fumarole, and Slack webhooks. For local setup:

-   `docs/connecting-to-aws.md`
