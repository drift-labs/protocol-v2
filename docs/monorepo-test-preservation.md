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
| @velocity-exchange/sdk         | mixed  | 185+          | ✅ gated (own `sdk-tests` job) | restored — see below. Offline: test 102 / dlob 52(+1 pending) / bignum 12 / events 3 / velocitycore 16. `tests/ci` is live-RPC (verify-sdk-configs). |
| @velocity-exchange/dlob-server | jest   | 54            | ✅ gated (app preset) | —                                                                                                                                                                                                                                       |
| @backend/aggregator-api        | jest   | 337           | ✅ gated (app preset) | —                                                                                                                                                                                                                                       |
| @backend/candles               | jest   | 61            | ✅ gated (app preset) | —                                                                                                                                                                                                                                       |
| @backend/market-data           | jest   | 63            | ✅ gated (app preset) | —                                                                                                                                                                                                                                       |
| @backend/notification-engine   | jest   | 158           | ✅ gated (app preset) | — (Firebase fully mocked; the only failures were a stale User-buffer fixture, now `Buffer.alloc(4496)`)                                                                                                                                  |
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

### SDK test restoration — DONE (gated via `sdk-tests`)

All three original problems are resolved; the SDK now runs in a dedicated `sdk-tests` CI job
(mocha + `bun test`, separate from the jest `ts-tests` filter). Offline green:
`test` 102 / `test:dlob` 52 (+1 intentional pending) / `test:bignum` 12 / `test:events` 3 /
`test:velocitycore` 16.

1. **Runner split** — `tests/VelocityCore/*` (`import 'bun:test'`) excluded from the mocha
   `test` glob and run via `test:velocitycore`; the 2 failures were fixed (a fixture put
   `oracle` under `amm` instead of top-level `PerpMarketAccount`; the User-buffer fixtures
   were regenerated to the 4491-byte layout). Now 16/16.
2. **Stale tests vs source** — `tests/amm/test.ts` + `tests/dlob/helpers.ts` ported to the
   decoupled-AMM types (`MarketStats` split, top-level oracle); `tests/dlob/test.ts` expected
   fill counts updated to the real vAMM-decoupled DLOB behavior; dead `tests/decode/phoenix.ts`
   removed (feature gone). Also fixed a real circular-dependency bug in
   `src/constants/numericConstants.ts` surfaced by `test:bignum`.
3. **Tier 2 / live** — `tests/ci/*` stay out of the offline scripts; `verify-sdk-configs` now
   runs them on `schedule`/`workflow_dispatch` (was `if: false`) — set
   `MAINNET/DEVNET_RPC_ENDPOINT` secrets to enable.

## Rust (`rust/` workspace) — offline subset gates; live split out

`rust-workspace-check` runs `cargo test --workspace --all-targets` (rpc_tests OFF) with a
**Redis service container**, **gating** (no `continue-on-error`). Green: drift-rs lib 90,
swift 38, doctests 7. Live tests (RPC / funded keys / gRPC / Jupiter/Titan) are compiled out
via the project's `rpc_tests` cargo feature and run in a separate **non-blocking**
`rust-live-tests` job (`--features rpc_tests`, secrets, schedule/dispatch) — see handover #2.

| Crate    | Crate type | Offline (`src` + doctests)        | Live (`rpc_tests`-gated / `tests/*.rs`) |
| -------- | ---------- | --------------------------------- | --------------------------------------- |
| drift-rs | **lib**    | 90 pass + 7 doctests              | per-test `#[cfg(feature="rpc_tests")]` + tests/{integration,jupiter,titan}.rs (file-gated) |
| keep-rs  | **bin**    | 0 tests                           | —                                       |
| swift    | **bin**    | 38 pass                           | `swift_server::test_simulate_taker_order_rpc`, `user_account_fetcher::usermap_lookups` |

The split uses `rpc_tests` rather than `#[ignore]` (no silent skips): live tests are compiled
out of the default build entirely. **Feature-unification trap:** `cargo test --workspace
--features X` enables X for every member, so the offline gate stays clean only because no
member enables `rpc_tests` by default. The remaining `#[ignore]`s (6 in the velocity program,
4 `event_subscriber` base64-log tests) are tracked in the handover — none are mechanical
fixture fixes.
