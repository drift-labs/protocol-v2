# Monorepo CI — handover

State of the `fix/monorepo-ci-green` work (PR #85). The PR gate is built around a single
`ci-gate` aggregator job; every other job is path-gated and reports "skipped" when its paths
didn't change (branch protection must require **only** `CI gate` — see Outstanding #1).
Companion detail: [monorepo-test-preservation.md](./monorepo-test-preservation.md).

## TL;DR

Everything that can gate deterministically now gates and is green locally. The remaining
items are (a) one GitHub-settings change only you can make, (b) live-RPC suites that can't run
until velocity is on devnet, (c) a handful of documented program `#[ignore]`s that need a
protocol owner's call, and (d) one dead test to delete. None are silent coverage loss.

**Do not merge until PR #85's re-run is green** — the last push fixed `sdk-tests` + `vault-tests`
and added the Docker build jobs; their first CI run is the thing to watch (esp. the rust image
builds, ~15–20 min).

## Done

- **Build / format / lint** at-or-above standalone parity (prettier scope + 100/4 overrides;
  rust fmt + clippy gate on the program; `cargo fmt --check` on the `rust/` workspace).
- **`ci-gate`** aggregator is the intended single required check.
- **TS app suites gated & green** — dlob-server (swc app preset) + keeper-bots-v2 (mocha).
  See preservation doc for the per-suite counts and the swc-preset rationale.
- **SDK suite restored & gated** (new `sdk-tests` job — mocha + `bun test`, separate from the
  jest `ts-tests` filter). Green offline: `test` 102, `test:dlob` 52 (+1 intentional pending),
  `test:bignum` 12, `test:events` 3, `test:velocitycore` 16. Restoration also fixed a **real
  SDK bug** (circular dep in `numericConstants.ts` — `MAX_I64`/`MIN_I64` built via `BigNum`
  before `bigNum.ts` finished importing `ZERO`) and deleted a dead Phoenix decode test (feature
  removed). `tests/ci/*` stay out (live RPC — see Outstanding #3).
- **Rust offline workspace gates** — `rust-workspace-check` runs `cargo test --workspace
  --all-targets` (rpc_tests OFF) with a **Redis service container**, no `continue-on-error`.
  Green: drift-rs lib 90, swift 38, doctests 7. Live tests are compiled out via the project's
  `rpc_tests` cargo feature and run in a separate non-blocking `rust-live-tests` job.
- **velocity program unit tests gate** — `cargo test -p velocity --lib`: 841 pass, fmt + clippy
  clean. 6 remaining `#[ignore]`s now carry precise reasons (Outstanding #4).
- **Vaults integration tests gated & green** — `vault-tests` job (bankrun). Full suite passes
  (41 tests across managerUpdate / depositMax / feeUpdate / sharesExamples /
  transferVaultDepositorShares / trustedVault / driftVaults) after fixing `run-vault-tests.sh`
  (see below).
- **Docker image build checks** — `docker-images-ts` (dlob-server, keeper-bots-v2) +
  `docker-images-rust` (keep-rs/swift) build every shipped image (same Dockerfiles + `docker-info.json` args as
  `docker-on-tag`, `push: false`). Path-gated via new `docker_ts`/`docker_rust` change filters;
  `type=gha` layer cache. In `ci-gate`'s required set.
- **Vendoring coverage audit** — diffed every vendored suite against its upstream drift-labs
  source repo: no hermetic test was silenced/deleted/assertion-gutted by the consolidation.

### Key fixes worth remembering

- **`run-vault-tests.sh` per-program build.** The old single `anchor build -- --no-default-features
  --features no-entrypoint,anchor-test` applied **velocity's** flags to **all** programs:
  `--no-default-features` stripped the vaults/pyth/token_faucet entrypoints → 896-byte stub
  `.so`s → bankrun `Program is not deployed` → `invalid account data for instruction 2` in
  every vault `before` hook. And vaults needs `--features anchor-test` for the test `admin::ID`
  (`45HdJoU4…`, `constants.rs`) the fee-update tests sign with (else `is_admin` → `0x7d3`).
  Fix: build velocity alone with the no-default flags; vaults with `--features anchor-test`;
  fixtures with defaults.
- **Rust live-test split** uses `rpc_tests` (no `#[ignore]` hiding). Watch the **workspace
  feature-unification trap**: `cargo test --workspace --features X` turns X on for every member,
  so the offline gate stays clean only because no member enables `rpc_tests`.
- **SDK flaky timing test** (`TransactionConfirmationManager`) converted to sinon fake timers
  (`clock.tickAsync`) — a real `setTimeout(1250)` + exact `3 calls` assertion flaked on slow CI.

## Outstanding

### 1. Branch protection — **your action** (GitHub settings, can't be done from the repo)
Set **`CI gate`** as the *only* required status check; remove the individual job checks
(fmt-clippy, prettier, anchor-tests, …). Until then the path-gating design isn't enforced (a
required check that reports "skipped" blocks the merge forever).

### 2. Live rust tests — pending devnet deploy
`rust-live-tests` (`cargo test --workspace --features rpc_tests`) **compiles** (the bit-rotted
live tests were ported to the forked API: `RpcAccountProvider`→`RpcClient`, `subscribe_all_*`,
`OracleMap::get_by_market`, `AMM.oracle`→top-level, etc.) but has **never been run** — it needs
a live velocity deployment. Runs on `schedule` + `workflow_dispatch`, **not** in `ci-gate`.
**Once devnet is live:** set secrets (`TEST_DEVNET_RPC_ENDPOINT` → the deploy,
`TEST_MAINNET_RPC_ENDPOINT`, `TEST_PRIVATE_KEY`, `TEST_MAINNET_PRIVATE_KEY`, `TEST_GRPC_X_TOKEN`),
dispatch the job, fix what the first real run surfaces. `titan` is intentionally NOT enabled
(its dep tree breaks the velocity host-lib compile; Titan/Jupiter are mainnet-only). Sanity-check
adapted tests first: oraclemap `test_oracle_map` (now market-keyed; market-index→asset
assumptions inherited from the old mainnet test, unverified) and usermap (post-unsubscribe
assertions dropped — `unsubscribe` now consumes the map).

### 3. Live SDK config tests — pending secrets
`verify-sdk-configs` runs `tests/ci/*` (needs `MAINNET_RPC_ENDPOINT` + `DEVNET_RPC_ENDPOINT`),
now on `schedule` + `workflow_dispatch` (was `if: false`). Set the secrets to enable. Not in
`ci-gate`.

### 4. velocity program `#[ignore]`s — need a protocol owner's call (NOT silent)
6 unit tests remain ignored with precise reasons; each is a behavioral/data question, not a
mechanical fixture fix (the legacy-snapshot layout migration is done — see
`test_utils/legacy_snapshot.rs`):
- `vlp/amm/math/repeg/tests.rs` ×2 and `controller/liquidation/tests.rs::test` — snapshots now
  load correctly, but the scenario no longer triggers under current math (AMM can't lower K /
  user isn't underwater). Stale assertion vs. needs a fresh velocity-layout snapshot.
- `math/orders/tests.rs::swift_failure` — its perp-market blobs are **upstream drift** layout
  (SIZE 1256, never existed here); needs a fresh velocity-layout snapshot.
- `controller/orders/amm_jit_tests.rs::…zero_price_long_imbalance` — expected fee `2033008`
  predates the spread-cache refactor; needs a domain owner to recompute (didn't guess a number).
- (`test_utils/legacy_snapshot.rs::print_regenerated` stays ignored — it's a regeneration tool.)

### 5. Dead test to delete (removed feature) — cheap cleanup
- drift-rs `dlob::tests::dlob_l2_snapshot_max_leverage_filtering` — tests a max-leverage L2
  filtering feature that **doesn't exist in this fork**; delete or implement.

### 6. `Some(0)` isolated-deposit quirk — product decision (1-line lib change)
`swift_server::simulate_taker_order_rpc` treats a zero-amount isolated deposit as a real deposit
(forces network sim + appends a zero-transfer ix) instead of `None`. Harmless on-chain but
likely unintended; normalizing `Some(0)`→`None` is a one-liner left for you to decide.

### 7. Confirmations / follow-ups
- **infrastructure-v3 services removed** — candles, market-data, multisig-monitor,
  aggregator-api, notification-engine, realtime-archiver and their `@backend/*` support libs
  were pulled back out of this monorepo; they deploy from `infrastructure-v3`. (Likewise
  `apps/snapshots`, which was never vendored.)
- **`MAX_USER_ACCOUNT_SIZE_BYTES = 4376`** in `packages/sdk/src/userMap/userMap.ts` looks stale
  vs `User::SIZE = 4496` — worth a check.
- **drift-rs `event_subscriber` 4 base64-log `#[ignore]`s** (`parses_*` are fixed/un-ignored;
  these 4 are `rpc_tests`-gated and need *real captured mainnet tx logs* that can't be
  synthesized) — revisit when live infra exists.

## Quick reference

- App jest preset: `jest.config.app.cjs` (swc + `jest.setup.app.ts` `genMockKey`). Each wired
  app has a one-line `jest.config.cjs` re-exporting it + `"test": "jest"`.
- SDK suite runs in its own `sdk-tests` job (mocha/bun, not jest). Add SDK offline scripts there.
- `ts-tests` filter list is enumerated on purpose (never `./apps/*`) — append `--filter=<pkg>`.
- Rust offline gate: `rust-workspace-check` (Redis service). Live: `rust-live-tests` (`rpc_tests`).
- Vault tests: `vault-tests` job → `test-scripts/run-vault-tests.sh` (per-program anchor build).
- Docker checks: `docker-images-ts` / `docker-images-rust`, gated by `docker_ts`/`docker_rust`.
- All jobs + the `ci-gate` `needs` list live in `.github/workflows/main.yml`.
