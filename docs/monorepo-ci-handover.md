# Monorepo CI — outstanding items (handover)

State of the `fix/monorepo-ci-green` work. Build/format/lint and most test suites are
gated; what remains is below. Companion detail: [monorepo-test-preservation.md](./monorepo-test-preservation.md).

## Done (for context)

- **Build / format / lint** at-or-above standalone parity (prettier scope + 100/4 overrides; rust fmt gate on program + `rust/` workspace).
- **`ci-gate`** aggregator job is the intended single required check (path-gated jobs report "skipped", which would otherwise block merges).
- **TS test suites gated:** all `@backend/*` libs (ts-jest preset) + apps candles/market-data/multisig-monitor/aggregator-api/realtime-archiver/dlob-server/notification-engine (swc app preset) + keeper-bots-v2 (mocha).
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

### 3. notification-engine — **DONE**
All 158 tests pass offline on the swc app preset — no Tier 2 / secrets split was needed.
The Firebase suite fully mocks `firebase-admin`/`firebase-admin/{app,messaging}`, and the
shared `jest.setup.app.ts` already supplies the `genMockKey()` global the suites expect, so
no extra `setupFiles` or test env was required. The only real failures were the 4 cases in
`test/risk-manager.test.ts` that decode a hardcoded `mockBuffer` User-account fixture: the
fixture was sized to the old (upstream-drift) User layout, so `decodeUser` overran it
(`offset out of range … <= 4372`) once velocity's `User::SIZE` grew to 4496. Replaced the
stale base64 literal with a `Buffer.alloc(4496)` fixture (positions/orders zero → decodes to
an empty account; `getHealth`/`getHealthComponents`/`subscribe` are mocked, so contents don't
matter). Added `"test": "jest"` + a `jest.config.cjs` re-export and appended
`--filter=@backend/notification-engine` to the `ts-tests` run step.

Note for follow-up (out of scope here): `packages/sdk/src/userMap/userMap.ts`'s
`MAX_USER_ACCOUNT_SIZE_BYTES = 4376` looks similarly stale against `User::SIZE = 4496` —
worth a separate check.

### 4. realtime-archiver — one suite quarantined — **DONE**
`test/services/ingestion.test.ts` is re-enabled (`testPathIgnorePatterns` override removed,
config back to the plain app-preset re-export). The real failure was `value instanceof BN`
in `@backend/common`'s `simpleSerialize`, not `SolanaJSONRPCError`: the test's
`jest.mock('@velocity-exchange/sdk', …)` factory replaced the whole module and dropped the
re-exported `BN`, so the constructor was `undefined`. Fixed by adding `BN: require('bn.js')`
to that mock factory. All 9 suites (120 tests) green; `@backend/realtime-archiver` was
already in the `ts-tests` filter, so no workflow change.

### 5. vaults integration tests — anchor-tier, not wired
The real vaults tests are anchor integration tests (`drift-vaults/tests/*.test.ts`, ~14
files), not SDK unit tests. They belong with `anchor-tests` (local validator), not
`ts-tests`. Port + adapt to the velocity `vaults` program ID / renames. (The vaults
*program* rust unit tests already run for free in `unit-tests` via `cargo test --lib`.)

### 6. Rust tests as a gate — **in progress** (offline subset gates; live split out)
Decision reversed: the offline-deterministic rust tests now gate; live tests are compiled
out by default and run in a separate non-blocking job. No `#[ignore]`-based hiding — the
split uses the project's existing `rpc_tests` cargo feature (drift-rs already had it; added
the same feature to swift).

What's done:
- **Completed the `rpc_tests` gating** that the drift-labs import left half-applied. Live
  tests that had leaked into the default build are now `#[cfg(feature = "rpc_tests")]`:
  drift-rs `account_map::test_user_subscribe`, the four `oraclemap::*`, both `marketmap::*`,
  `blockhash_subscriber_updates`, `priority_fee_subscribe`, `event_subscriber::log_stream_handles_jit_proxy_events`;
  swift `user_account_fetcher::usermap_lookups`, `swift_server::test_simulate_taker_order_rpc`.
  The whole-file live suites `tests/{integration,jupiter,titan}.rs` got file-level
  `#![cfg(feature = "rpc_tests")]` (titan: `all(titan, rpc_tests)` — `titan` is unified on
  via keep-rs, so `rpc_tests` is what keeps it out of the default run). Watch the
  **workspace feature-unification** trap: `cargo test --workspace --features X` turns X on
  for every member, so the gate stays clean only because no member enables `rpc_tests`.
- **CI**: `rust-workspace-check` now runs `cargo test --workspace --all-targets` (rpc_tests
  OFF) with a **Redis service container**, no `continue-on-error` → gating. New
  `rust-live-tests` job runs `--features "rpc_tests titan"` with secrets
  (`TEST_MAINNET_RPC_ENDPOINT`, `TEST_DEVNET_RPC_ENDPOINT`, `TEST_PRIVATE_KEY`,
  `TEST_MAINNET_PRIVATE_KEY`, `TEST_GRPC_X_TOKEN`) on `schedule` + `workflow_dispatch`; it is
  NOT in `ci-gate`'s `needs`, so it never blocks PRs.

What's left before the gate is green (tracked offline failures, all fork regressions —
NOT to be hidden behind a feature):
- **9 serialization fixture/logic bugs.** Velocity added fields to
  `OrderParams`/`SignedMsgOrderParamsMessage` (`builder_idx`, `builder_fee_tenth_bps`,
  `isolated_position_deposit`, `max_margin_ratio`), so swift's hardcoded pre-fork byte/hex
  fixtures misalign (`Invalid Option representation: …`; uuid shifted 2 bytes). Affected:
  swift `types::messages::{deser_signed_msg_type_with_len_from_raw_bytes_v0,v1,
  deserialize_incoming_signed_message_delegated, deserialize_incoming_signed_message_with_signing_authority}`,
  `types::types::from_incoming_message_valid_utf8_uuid`, `swift_server::test_is_isolated_deposit`,
  drift-rs `swift_order_subscriber::{deser_ix_payload, test_swift_order_deser,
  deserialize_incoming_signed_message_delegated}`. Fix = regenerate the fixtures from the
  current serializer. **Assumption (verify): velocity is pre-mainnet with no deployed
  old-format clients, so the v0/v1 "parse old wire format" tests can be regenerated to
  current-format round-trips. If old clients must be supported, the deser must instead be
  made version-tolerant.**
- **7 doctests** (`dlob::L2Book::*`, `DLOBNotifier::user_update`, `TransactionBuilder::initialize_user_account`,
  `priority_fee_subscriber`, `jupiter::DriftClient::jupiter_swap_query` — last is a compile
  failure = real API drift). Mark the network-bound examples ` ```no_run ` and fix the
  jupiter example.
- A handful of pre-existing upstream `#[ignore]`s remain (4 `event_subscriber` "base64 logs
  need updating", 1 `dlob`, 2 swift) — fold into the same scheme / fix the stale fixtures.

**Live job now compiles; running it is the open TODO.** The live test code was bit-rotted
(~68 errors: `DriftClient::subscribe`, `RpcAccountProvider`, `SlotSubscriber.event_emitter`,
`AMM.oracle`, changed arities) — it has been **ported to the current forked API** and now
builds: `cargo check --workspace --all-targets --features rpc_tests` is clean (and the offline
build is unaffected). The ported tests have **never been run** — they need a live velocity
deployment to point at. The `rust-live-tests` job runs `--features rpc_tests` with secrets on
schedule + workflow_dispatch; it will fail at runtime until velocity is on devnet and the
`TEST_*` secrets are set. **Final step (TODO): once devnet is live, set the secrets, point
`TEST_DEVNET_RPC_ENDPOINT` at the deploy, dispatch the job, and fix what the first real run
surfaces.** `titan` is intentionally NOT enabled (its dep tree breaks the velocity host-lib
compile; Titan/Jupiter are mainnet-only) — re-add and resolve the conflict if those swap tests
are wanted. A few tests were adapted where the old API was gone (notably oraclemap
`test_oracle_map` — now market-keyed via `get_by_market`, market-index→asset assumptions
inherited from the old mainnet test and unverified; usermap post-unsubscribe assertions dropped
because `unsubscribe` now consumes the map) — sanity-check intent before trusting the first run.

## Quick reference

- App jest preset: `jest.config.app.cjs` (swc + `jest.setup.app.ts` `genMockKey`). Each wired app has a one-line `jest.config.cjs` re-export + `"test": "jest"`.
- Lib jest preset: `jest.config.base.cjs` (ts-jest).
- CI gate job + the `ts-tests` filter list live in `.github/workflows/main.yml`.
- Add a newly-fixed suite by appending `--filter=<pkg-name>` to the `ts-tests` run step (enumerated on purpose — never `./apps/*`).
