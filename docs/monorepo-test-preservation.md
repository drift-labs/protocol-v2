# Monorepo test preservation

Status of the test suites carried over from the pre-consolidation repos, and what
remains to wire each one back into CI. Goal: every origin repo's tests run in CI
again (no silent coverage loss), without forcing infra-dependent tests into the PR
gate.

## Tiers

- **Tier 1 — hermetic, runs in the PR gate.** Pure unit tests that mock all infra
  (network, AWS, RPC, validators). Fast and deterministic.
- **Tier 2 — needs live infra/credentials.** RPC endpoints, Firebase, AWS, the
  Titan/Jupiter APIs, or a local validator. Kept out of the PR gate; runs in a
  dedicated job with secrets, or locally.

## TypeScript

Shared jest preset: `jest.config.base.cjs`. Each wired package has a one-line
`jest.config.cjs` re-exporting it and a `"test": "jest"` script. jest/ts-jest/
@types/jest live in the root `devDependencies`.

CI job `ts-tests` runs `turbo run test --filter='./packages/*' --filter='!@velocity-exchange/sdk'`.

| Package                        | Runner | Tests         | State                 | Action to fully preserve                                                                                                                                                                                                                |
| ------------------------------ | ------ | ------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| @backend/athena                | jest   | 26            | ✅ gated              | —                                                                                                                                                                                                                                       |
| @backend/common                | jest   | 42            | ✅ gated              | —                                                                                                                                                                                                                                       |
| @backend/dynamodb              | jest   | 378           | ✅ gated              | —                                                                                                                                                                                                                                       |
| @backend/kinesis               | jest   | 11            | ✅ gated              | —                                                                                                                                                                                                                                       |
| @backend/prometheus            | jest   | 7             | ✅ gated              | —                                                                                                                                                                                                                                       |
| @backend/redis                 | jest   | 145           | ✅ gated              | —                                                                                                                                                                                                                                       |
| @backend/s3                    | jest   | 8             | ✅ gated              | —                                                                                                                                                                                                                                       |
| @backend/sns                   | jest   | 5             | ✅ gated              | —                                                                                                                                                                                                                                       |
| @backend/sqs                   | jest   | 9             | ✅ gated              | —                                                                                                                                                                                                                                       |
| @drift-labs/keeper-bots-v2     | mocha  | 2             | ✅ passes (not gated) | add `test` to the gate once confirmed in CI env                                                                                                                                                                                         |
| @velocity-exchange/sdk         | mixed  | many          | ❌ multi-issue        | needs a real test-restoration pass — see below |
| @velocity-exchange/dlob-server | jest   | 3             | ❌ broken             | its existing jest config loads 0 suites (compile/import error) — fix config + imports                                                                                                                                                   |
| @backend/aggregator-api        | jest   | 20            | ⚠️ unverified         | fastify suites; build is intentionally skipped, so wire test against `src`                                                                                                                                                              |
| @backend/candles               | jest   | 61 (28 fail)  | ⚠️ failing            | restore jest setup/env from origin repo                                                                                                                                                                                                 |
| @backend/market-data           | jest   | 63 (17 fail)  | ⚠️ failing            | restore jest setup/env                                                                                                                                                                                                                  |
| @backend/notification-engine   | jest   | 158 (88 fail) | ⚠️ failing            | Firebase/env-dependent — needs `setupFiles` + test env (partly Tier 2)                                                                                                                                                                  |
| @backend/multisig-monitor      | jest   | 79 (1 fail)   | ⚠️ 1 failing          | fix the single failing case                                                                                                                                                                                                             |
| @backend/realtime-archiver     | jest   | 67            | ❌ broken             | imports `@velocity-exchange/sdk/src/idl/drift.json` — renamed to `velocity.json` during consolidation                                                                                                                                   |

The recurring app-suite cause: the origin repos kept `setupFiles`/env/`moduleNameMapper`
in their own jest config, which had no equivalent in the monorepo until
`jest.config.base.cjs`. Restoring each app means re-adding its setup (env defaults,
the drift→velocity idl mapping) per package, then deciding Tier 1 vs Tier 2.

### SDK test restoration (not a quick fix)

The sdk has three independent problems; greening it is its own project. The sdk
tsconfig now allowlists `types: ["node", "mocha", "chai"]` (the earlier `types: []`
hoist fix had stripped the mocha globals, breaking test compilation), but that only
unblocks compilation — the suites themselves need work:

1. **Runner split.** `tests/VelocityCore/*` `import 'bun:test'` and cannot run under
   mocha — the kitchen-sink `test` script (`mocha tests/**/*.ts`) chokes on them.
   They have a dedicated `test:velocitycore` (`bun test`) script, but it is **not
   wired into CI and currently fails 2/16**, so they are not actually covered. To
   split honestly: exclude `tests/VelocityCore` from the mocha `test` script AND add
   a CI step running `bun test tests/VelocityCore` (after fixing the 2 failures).
2. **Stale tests vs source.** `tests/amm/test.ts` references `AMM` fields removed in
   the funding refactor (`historicalOracleData`, `orderStepSize`, `minOrderSize`) and
   has `MMOraclePriceData`→`MarketStats` type drift. These assertions need updating to
   the current sdk types.
3. **Tier 2.** `tests/ci/*` need `MAINNET/DEVNET_RPC_ENDPOINT`. Their home is the
   `verify-sdk-configs` job, which is currently `if: ${{ false }}` (disabled) — so
   excluding them from an offline `test` does not lose coverage that exists today, but
   re-enabling that job (with secrets) is the way to actually preserve them.

## Rust (`rust/` workspace)

`rust-workspace-check` runs `cargo check --all-targets`, which compiles all test code
(fixed: builder-codes `OrderParams` fields + a `UiTransactionError` `.into()` drift).
It does **not execute** the tests.

| Crate    | Unit tests | Integration                          | Notes                                    |
| -------- | ---------- | ------------------------------------ | ---------------------------------------- |
| drift-rs | 139        | tests/{integration,jupiter,titan}.rs | integration tests hit live APIs → Tier 2 |
| keep-rs  | 9          | —                                    | likely Tier 1                            |
| swift    | 40         | —                                    | likely Tier 1                            |

Action: add `cargo test --manifest-path rust/Cargo.toml --lib` to the rust job once
the lib unit tests are confirmed offline-safe (no RPC). Leave `tests/*.rs` integration
suites for a Tier-2 job.
