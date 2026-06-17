# Monorepo CI — outstanding items (handover)

State of the `fix/monorepo-ci-green` work. Build/format/lint and most test suites are
gated; what remains is below. Companion detail: [monorepo-test-preservation.md](./monorepo-test-preservation.md).

## Done (for context)

- **Build / format / lint** at-or-above standalone parity (prettier scope + 100/4 overrides; rust fmt gate on program + `rust/` workspace).
- **`ci-gate`** aggregator job is the intended single required check (path-gated jobs report "skipped", which would otherwise block merges).
- **TS test suites gated:** all `@backend/*` libs (ts-jest preset) + apps candles/market-data/multisig-monitor/aggregator-api/realtime-archiver/dlob-server (swc app preset) + keeper-bots-v2 (mocha).
- **Rust tests** run **non-gating** in `rust-workspace-check` (`cargo test --all-targets`, `continue-on-error`, 20-min timeout) — by decision; the program's own `cargo test --lib` stays gated.
- **vaults** program + `@velocity-exchange/vaults-sdk` vendored; IDL generated, not hand-edited.

## Outstanding

### 1. Branch protection — **your action, blocks nothing else but required**
Set **`CI gate`** as the *only* required status check; remove the individual job checks
(fmt-clippy, prettier, anchor-tests, …). Until then the path-gating design isn't actually
enforced. Cannot be done from the repo — GitHub settings only.

### 2. SDK suite (`@velocity-exchange/sdk`) — real project, excluded from gate
Three independent problems (see preservation doc §"SDK test restoration"):
- **Runner split:** `tests/VelocityCore/*` use `import 'bun:test'` — can't run under mocha. Need a `bun test tests/VelocityCore` CI step (currently fails 2/16).
- **Stale tests vs source:** `tests/amm/test.ts` references removed `AMM` fields (`historicalOracleData`, `orderStepSize`, `minOrderSize`) + `MMOraclePriceData`→`MarketStats` drift. Update assertions to current types.
- **Tier 2:** `tests/ci/*` need `MAINNET/DEVNET_RPC_ENDPOINT` — belong in the `verify-sdk-configs` job (currently `if: false`); re-enable with secrets.

### 3. notification-engine — env/Firebase, partly Tier 2
158 tests, 88 failing. No `test` script yet. Needs `setupFiles` + a test env; some cases
are Firebase-dependent (Tier 2, secrets job, not the PR gate). Wire the offline subset to
the swc app preset like the other apps; route the rest to a secrets job.

### 4. realtime-archiver — one suite quarantined
`test/services/ingestion.test.ts` is excluded via `testPathIgnorePatterns`. Fails on
`error instanceof SolanaJSONRPCError` resolving to `undefined` in the test realm (dual
`@solana/web3.js` instance / import issue). Re-enable once resolved. 8/9 suites green today.

### 5. vaults integration tests — anchor-tier, not wired
The real vaults tests are anchor integration tests (`drift-vaults/tests/*.test.ts`, ~14
files), not SDK unit tests. They belong with `anchor-tests` (local validator), not
`ts-tests`. Port + adapt to the velocity `vaults` program ID / renames. (The vaults
*program* rust unit tests already run for free in `unit-tests` via `cargo test --lib`.)

### 6. Rust tests as a gate — only if ever wanted (currently a deliberate no)
Decision: rust workspace tests run non-gating. To promote them to gating later: mark every
RPC/Redis test `#[ignore]` (or behind a `live`/`tier2` feature) across drift-rs + swift,
gate `cargo test` on the offline subset, add a separate secrets+Redis job for `-- --ignored`.

## Quick reference

- App jest preset: `jest.config.app.cjs` (swc + `jest.setup.app.ts` `genMockKey`). Each wired app has a one-line `jest.config.cjs` re-export + `"test": "jest"`.
- Lib jest preset: `jest.config.base.cjs` (ts-jest).
- CI gate job + the `ts-tests` filter list live in `.github/workflows/main.yml`.
- Add a newly-fixed suite by appending `--filter=<pkg-name>` to the `ts-tests` run step (enumerated on purpose — never `./apps/*`).
