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

Two shared jest presets, by suite kind:

- **`jest.config.base.cjs`** (ts-jest) — the `@backend/*` **libs**. Pure unit tests
  that type-check clean.
- **`jest.config.app.cjs`** (@swc/jest + `jest.setup.app.ts`) — the `apps/*` suites.
  Apps were authored against swc semantics: they need `jest.mock` factory hoisting
  and must not type-check at run time (app sources aren't strictly type-clean vs the
  vendored SDK types). ts-jest fails both ways — `isolatedModules: true` skips mock
  hoisting; `isolatedModules: false` blocks on type errors — so apps use swc, as they
  did in infrastructure-v3.

Each wired package has a one-line `jest.config.cjs` re-exporting the right preset and
a `"test": "jest"` script. jest/ts-jest/@swc/jest/@types/jest live in root `devDependencies`.

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
| @backend/realtime-archiver     | swc    | 67 (+1 suite quarantined) | ✅ wired (app preset)  | re-enable `test/services/ingestion.test.ts` (see below)                                                                                                                                               |

The recurring app-suite cause was the **transformer**, not just missing setup: the
origin repos ran `@swc/jest`, and the monorepo's only preset was ts-jest. Apps wired to
`jest.config.app.cjs` (swc) recover their suites. realtime-archiver: 8/9 suites green
(67 tests) under the app preset.

- **realtime-archiver `test/services/ingestion.test.ts`** is quarantined via
  `testPathIgnorePatterns`. It fails on `error instanceof SolanaJSONRPCError` in
  `src/services/ingestion.ts` — the constructor resolves to `undefined` in the test
  realm's `@solana/web3.js` instance. Likely a dual-instance / import issue; re-enable
  once resolved.

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
It does **not execute** the tests, and — see below — executing them is **not** the
quick win it first looks like.

| Crate    | Crate type | Tests in `src` (`#[test]`)        | Integration (`tests/*.rs`)           |
| -------- | ---------- | --------------------------------- | ------------------------------------ |
| drift-rs | **lib**    | ~123, **network-intermixed**      | tests/{integration,jupiter,titan}.rs (live APIs → Tier 2) |
| keep-rs  | **bin**    | **0**                             | —                                    |
| swift    | **bin**    | ~40, **mixed** (9 pure + RPC/Redis) | —                                  |

Why `cargo test --manifest-path rust/Cargo.toml --lib` is the **wrong** action (it
was the original plan here — it isn't viable):

1. **`--lib` only matches lib targets.** keep-rs and swift are **binary** crates, so
   `--lib` silently runs **none** of their tests — only drift-rs's lib tests.
2. **drift-rs's lib tests are network-intermixed.** ~8 of 23 `src` test files call
   `test_envs::{mainnet,devnet}_endpoint` (live RPC). They live as `#[tokio::test]`
   unit tests in `src`, not under `tests/`, so `--lib` would execute them and
   flake/fail the PR gate without secrets.
3. **No filter exists.** Pure and live tests share modules and **none are marked
   `#[ignore]`**, so there's no clean offline subset to select.
4. **keep-rs has no unit tests** (the earlier "9" was wrong).

Verified-pure subset today: swift `types::` (8 in `types/messages.rs` + 1 in
`types/types.rs`) — runs offline (`cargo test -p swift-server 'types::'`, exit 0), but
pays swift's full multi-minute compile for 9 tests → low ROI as a standalone step.

Action (the real work, not a one-liner): mark every RPC/Redis test `#[ignore]` (or
put it behind a `live`/`tier2` feature) across drift-rs + swift. Then the PR gate can
run `cargo test` (offline subset only) and a **separate secrets+Redis job** runs
`-- --ignored`. Until that annotation pass lands, leave the rust gate at
`cargo check --all-targets` (compile-only).
