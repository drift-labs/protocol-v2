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

CI job `ts-tests` runs the `@backend/*` libs plus the green app suites:
`turbo run test --filter='./packages/*' --filter='!@velocity-exchange/sdk'
--filter=@backend/candles --filter=@backend/market-data --filter=@backend/multisig-monitor
--filter=@backend/aggregator-api --filter=@backend/realtime-archiver
--filter=@velocity-exchange/dlob-server --filter=@drift-labs/keeper-bots-v2`. Suites are
enumerated explicitly (not `./apps/*`) so an unwired app — e.g. notification-engine, which
has no `test` script and is Firebase/env-dependent — can't silently slip into the gate.

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
| @drift-labs/keeper-bots-v2     | mocha  | 2             | ✅ gated              | —                                                                                                                                                                                                                                       |
| @velocity-exchange/sdk         | mixed  | many          | ❌ multi-issue        | needs a real test-restoration pass — see below |
| @velocity-exchange/dlob-server | jest   | 54            | ✅ gated (app preset) | —                                                                                                                                                                                                                                       |
| @backend/aggregator-api        | jest   | 337           | ✅ gated (app preset) | —                                                                                                                                                                                                                                       |
| @backend/candles               | jest   | 61            | ✅ gated (app preset) | —                                                                                                                                                                                                                                       |
| @backend/market-data           | jest   | 63            | ✅ gated (app preset) | —                                                                                                                                                                                                                                       |
| @backend/notification-engine   | jest   | 158 (88 fail) | ⚠️ failing            | Firebase/env-dependent — needs `setupFiles` + test env (partly Tier 2); no `test` script yet                                                                                                                                            |
| @backend/multisig-monitor      | jest   | 79            | ✅ gated (app preset) | —                                                                                                                                                                                                                                       |
| @backend/realtime-archiver     | swc    | 120           | ✅ gated (app preset)  | —                                                                                                                                                                                                     |

The recurring app-suite cause was the **transformer**, not just missing setup: the
origin repos ran `@swc/jest`, and the monorepo's only preset was ts-jest. Wiring each app
to `jest.config.app.cjs` (swc) recovers its suites with no per-suite fixes — candles
(61), market-data (63), multisig-monitor (79), aggregator-api (337) all run fully green,
matching how they were tested in infrastructure-v3 (one root `jest` on `@swc/jest`).
realtime-archiver: all suites green (120 tests).

- **realtime-archiver `test/services/ingestion.test.ts`** (was quarantined via
  `testPathIgnorePatterns`) is **re-enabled**. The real failure was `value instanceof BN`
  in `@backend/common`'s `simpleSerialize`: the test's `jest.mock('@velocity-exchange/sdk', …)`
  factory replaced the whole module and omitted `BN`, so the constructor resolved to
  `undefined` (`Right-hand side of 'instanceof' is not an object`). The `SolanaJSONRPCError`
  path was a red herring — the `@solana/web3.js` mock already spreads `requireActual`, so
  that constructor is real. Fix: add `BN: require('bn.js')` to the SDK mock factory (the
  SDK's `BN` is bn.js's constructor, so `instanceof` semantics are preserved).

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

`rust-workspace-check` runs `cargo check --all-targets` (the **gate** — compiles all test
code; fixed: builder-codes `OrderParams` fields + a `UiTransactionError` `.into()` drift),
then `cargo test --all-targets` as a **non-gating** step (`continue-on-error`, 20-min
timeout). Both run only when rust paths change. The decision is deliberate: the rust
tests **execute** whenever the workspace compiles (visible in CI logs) but never block a
merge — because, as below, much of the suite needs live RPC/Redis and there is no clean
offline subset to select.

| Crate    | Crate type | Tests in `src` (`#[test]`)        | Integration (`tests/*.rs`)           |
| -------- | ---------- | --------------------------------- | ------------------------------------ |
| drift-rs | **lib**    | ~123, **network-intermixed**      | tests/{integration,jupiter,titan}.rs (live APIs → Tier 2) |
| keep-rs  | **bin**    | **0**                             | —                                    |
| swift    | **bin**    | ~40, **mixed** (9 pure + RPC/Redis) | —                                  |

Why gating on `cargo test` (and why an `#[ignore]` pass is **not** required):

1. **`--lib` only matches lib targets.** keep-rs and swift are **binary** crates, so
   `--lib` would run **none** of their tests. The non-gating step uses `--all-targets`
   so bin-crate tests run too.
2. **drift-rs's lib tests are network-intermixed.** ~8 of 23 `src` test files call
   `test_envs::{mainnet,devnet}_endpoint` (live RPC). They live as `#[tokio::test]`
   unit tests in `src`, not under `tests/`, with **no `#[ignore]` marker** — so there's
   no offline subset to select. Run non-gating, their failures don't block merges.
3. **keep-rs has no unit tests** (the earlier "9" was wrong).

If the rust suite is ever wanted **as a gate** (not the current decision), the work is:
mark every RPC/Redis test `#[ignore]` (or put it behind a `live`/`tier2` feature) across
drift-rs + swift, gate `cargo test` on the offline subset, and add a **separate
secrets+Redis job** running `-- --ignored`. Until/unless that's wanted, the non-gating
step above preserves execution without the annotation pass.
