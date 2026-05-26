# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

For execution flow maps, module responsibility matrix, account type locations, and SDK↔program mappings, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Package Manager

Use `bun` (not yarn/npm) for JavaScript/TypeScript dependency management: `bun install`, `bun run <script>`.

## Build

**M1/Apple Silicon:** Always use an x86_64 cross-compile toolchain — never a native aarch64 toolchain. Native ARM toolchains break memory layout expectations for zero-copy accounts, which must match the on-chain (x86_64) representation.

- Anchor 0.29.x branches: `rustup default 1.76.0-x86_64-apple-darwin`
- Anchor 1.0 branches: `rustup default stable-x86_64-apple-darwin`

**Rust version and zero-copy struct alignment:** Rust ≥ 1.77 corrected `align_of::<u128>()` to 16 bytes on x86_64; the on-chain SBF target has always kept it at 8 bytes. All zero-copy structs in this repo are explicitly padded so `(SIZE - 8) % 16 == 0` and u128/i128 fields are ordered before any `PoolBalance` fields — this makes `sizeof` identical on all targets regardless of Rust version. You must still develop and test with Rust ≥ 1.77 so that x86_64 exercises real 16-byte u128 alignment and any future struct change that breaks the invariant is caught locally (the `const_assert_eq!` guards fire) rather than silently diverging on-chain. The minimum for Anchor 1.0 branches is Rust ≥ 1.89 (Anchor 1.0 MSRV). See [`docs/alignment-and-native-offsets.md`](./docs/alignment-and-native-offsets.md) for the full invariant rules and guidance on adding fields to zero-copy structs.

**Solana programs (Rust/Anchor):**
```bash
anchor build
# With anchor-test feature (required for TS integration tests):
anchor build -- --features anchor-test
```

**SDK:**
```bash
cd sdk/ && bun install && bun run build
```

**Update IDL after program changes:**

NEVER hand-edit `sdk/src/idl/drift.json` or `sdk/src/idl/drift.ts` — they are generated artifacts. To change them, modify the Rust program and regenerate. Manual edits will silently drift from on-chain layout and break clients.

```bash
anchor build -- --features anchor-test && cp target/idl/drift.json sdk/src/idl/drift.json
```

After regenerating the JSON, also regenerate the TypeScript IDL the SDK imports:
```bash
anchor idl type sdk/src/idl/drift.json --out sdk/src/idl/drift.ts
```

**Fast IDL-only regeneration** (no SBF .so build, useful when only field names/layouts changed):
```bash
anchor idl build -p drift -o target/idl/drift.json -- --features anchor-test
cp target/idl/drift.json sdk/src/idl/drift.json
anchor idl type sdk/src/idl/drift.json --out sdk/src/idl/drift.ts
```
`anchor idl build` runs under `cargo test` with the host toolchain, which sidesteps the bundled-cargo issues described below.

### macOS build environment

Two pitfalls that fresh setups regularly hit. If you see either symptom, apply the matching fix before debugging anything else.

**Symptom: `c/blake3_impl.h:4:10: fatal error: 'assert.h' file not found`** during `anchor build`.
The Solana platform-tools clang has no built-in macOS SDK path; it can't find system headers. Fix:
```bash
export SDKROOT="$(xcrun --show-sdk-path)"
```
(or prefix the build command with it). Add it to your shell profile so future sessions inherit it.

**Symptom: `feature 'edition2024' is required ... not stabilized in this version of Cargo (1.84.0)`** when downloading `toml_datetime` / `wincode` / `toml_parser`.
The bundled cargo in older platform-tools (v1.51 ships cargo 1.84) can't parse `edition2024` deps. Fix by upgrading platform-tools — the Anchor 1.0 branches need ≥ v1.54:
```bash
cargo-build-sbf --tools-version v1.54 --force-tools-install
```
Run that once; subsequent `anchor build` invocations will use the new toolchain. Check with `cargo-build-sbf --version`.

**Symptom: program panics with `Access violation in unknown section at address 0x80 of size 8`** (or similar address) at runtime, on instructions that touch types you didn't change.
This is almost always **stale SBF build artifacts** after a Cargo.lock dep change. SBF caches compiled `.rlib`s under `target/sbpf-solana-solana/`, and the cache key doesn't catch every dep-resolution change — the resulting `.so` loads but reads/writes wrong offsets. Whenever Cargo.lock dep versions change (e.g. after `cargo update`, or after switching branches with different lockfiles), do:
```bash
rm -rf target/sbpf-solana-solana target/deploy
cargo-build-sbf --tools-version v1.54 -- --features anchor-test
```

## Testing

**Rust unit tests:**
```bash
cargo test -p drift                    # drift program only
cargo test -p drift -- --show-output  # with stdout
```

**Single TypeScript integration test:**
```bash
ts-mocha -t 300000 ./tests/<test_file>.ts
```

**Full TypeScript integration test suite** (builds first, then runs all ~70 test files serially):
```bash
bash test-scripts/run-anchor-tests.sh
# Skip rebuild if .so is already built:
bash test-scripts/run-anchor-tests.sh --skip-build
```
The integration tests in `tests/` resolve `@coral-xyz/anchor` and friends from the **repo-root** `node_modules`, not from `sdk/`. If you only ran `bun install` inside `sdk/`, the test files will fail to load with `Cannot find module '@coral-xyz/anchor'`. Run `bun install` at the repo root first.

**SDK unit tests:**
```bash
cd sdk/ && bun run test:dlob    # DLOB tests
cd sdk/ && bun run test:ci      # CI subset
```

**Lint/format:**
```bash
cargo fmt                        # Rust
cd sdk/ && bun run prettify:fix  # SDK (TypeScript)
```

**Always run `cargo fmt` and `cargo clippy -p drift` before declaring Rust work complete.** CI runs `cargo fmt -- --check` and `cargo clippy -p drift` (see `.github/workflows/main.yml`) and will fail the PR otherwise. The equivalent SDK gate is `cd sdk/ && bun run prettify` + `bun run lint`. Do not hand off a change until those commands are clean.

## Devnet program upgrade

Full runbook lives in [`deploy-scripts/README.md`](./deploy-scripts/README.md). Read its "Operational notes" section before any devnet upgrade. The key rules:

- **Always use a private RPC** for `solana program` / `anchor program upgrade` writes — drift.so is ~5 MB (~5,000 chunked writes) and `api.devnet.solana.com` reliably rate-limits the upload partway through. Drift's Triton URL is recorded in memory `reference_drift_devnet_rpc.md`. Also `solana config set --url <url>` so the underlying CLI inherits it.
- **Prefer the two-phase deploy over `anchor program upgrade`.** Drive `deploy-scripts/write-buffer-devnet.sh` (creates / resumes a named on-chain buffer) and then `deploy-scripts/deploy-from-buffer-devnet.sh` (one-tx swap). `anchor program upgrade` creates an anonymous buffer and auto-closes it on failure, so the next retry restarts from chunk 0; the two-phase flow keeps the buffer pubkey on disk so re-running `write-buffer-devnet.sh` resumes by only re-sending chunks that didn't land.
- **Resume until done.** `write-buffer` can exit 0 with the buffer still partial. Verify with `solana program show <BUFFER_PK>` — Data Length must be ≥ the .so size. If `deploy-from-buffer` fails with `Failed to parse ELF file: invalid section header` / `invalid account data for instruction`, the buffer is partial — re-run `write-buffer-devnet.sh` against the same buffer keypair and re-attempt.
- **Reclaim rent from orphaned buffers** (~38 SOL each for drift-sized buffers): `solana program show --buffers [--buffer-authority <pk>]` to list, `solana program close --buffers --recipient <pk> --buffer-authority <keypair>` to close all under one authority. Check both the CLI default keypair and the upgrade-authority keypair as candidate authorities.
- **Anchor 1.0 renamed `anchor upgrade` → `anchor program upgrade`.** `deploy-devnet.sh` uses the new form.

After a successful upgrade with a layout-breaking change, run `deploy-scripts/wipe-devnet.ts` (calls the devnet-only `force_wipe_accounts_devnet` ix) then `deploy-scripts/init-devnet.sh` to recreate state under the new layouts.

### Wipe-and-reinit pitfalls

Each item below cost real time before being understood — read this before touching the wipe path.

- **SPL token vaults survive a drift-only wipe.** Solana rule: only the owning program can decrement an account's lamports. `force_wipe_accounts_devnet` zeroes drift-owned PDAs but cannot touch `spot_market_vault` / `insurance_fund_vault` (Token-program owned). After a wipe these vaults linger and `initialize_spot_market` then fails with `Allocate: account ... already in use` because Anchor's `init` constraint unconditionally calls System Allocate on the same PDA address.
- **Closing an SPL token account requires `amount == 0`.** Token program rejects `close_account` with `Non-native account can only be closed if its balance is zero` (error `0xb`). The wipe ix must `spl_token::burn` (or transfer) before closing — and `burn` needs the mint passed as a writable account. The wipe-devnet.ts script reads each vault's data on chain to find its mint and passes `(vault, mint)` pairs in `remaining_accounts`.
- **Mixing manual lamport mutation with CPI in one loop trips the runtime.** Solana's per-CPI conservation check fires with `sum of account balances before and after instruction do not match` if you manually credit admin lamports and then CPI into another program that also rebalances lamports. Fix: do all CPI closes in one pass, then all manual drains in a second pass.
- **The IDL regen recipe must drop `mainnet-beta` or devnet-only ixs vanish from the IDL.** Default features include `mainnet-beta`, which strips `#[cfg(not(feature = "mainnet-beta"))]` items. The deployed `.so` *has* the ix (built via `build-devnet.sh` with `--no-default-features`) but `program.methods.forceWipeAccountsDevnet` is undefined on the SDK because the IDL doesn't list it. Use: `anchor idl build -p drift -o target/idl/drift.json -- --no-default-features --features no-entrypoint,anchor-test` then `cp` and `anchor idl type`.
- **Anchor 1.0 `.accounts()` is implicitly `accountsPartial` and may reorder.** When sending a wipe ix with explicit `driftSigner` + `tokenProgram`, the auto-resolver can shift them into `remaining_accounts`. Use `.accountsStrict({...})` for fixed account sets.
- **`deploy-from-buffer-devnet.sh` insists on a `PROGRAM_KEYPAIR` file.** For an *upgrade* you don't need the program keypair — only the upgrade authority. Direct: `solana program deploy target/deploy/drift.so --buffer <BUF_PK> --program-id <PROGRAM_PUBKEY> --upgrade-authority <KP> -u <URL>` (`--program-id` accepts a Pubkey for upgrades).
- **`wipe-devnet.ts` walks `.wiped-*.json` archives too**, not just the active receipt. Any spot-market index ever recorded gets its derived vault PDAs included in subsequent wipes. Don't delete the archives until you're certain there are no lingering on-chain accounts.
- **Phase G (LP pool) creates more orphan token accounts.** The LP-pool subaccounts (e.g. dUSDT constituent token vault) survive a wipe the same way as spot vaults. If you don't need an LP pool, `SKIP_PHASE_G=1`. Otherwise extend the `wipe-devnet.ts` collector to derive the LP-pool vault PDAs.
- **Removing a feature (e.g. PR #38 PMM removal) breaks deploy scripts.** SDK exports referenced by `init-devnet.ts` / `verify-devnet.ts` vanish; the script crashes at import. After any feature removal, search `deploy-scripts/` for helpers named after it and rip that phase out before the next devnet run.

## Git / commit conventions

**Never add Claude (or any AI assistant) as a `Co-Authored-By` on commits, PR bodies, or anywhere else in version control.** Write commit messages and PR descriptions as the human author. No `🤖 Generated with …` footers either.

## Architecture

This is **Drift Protocol v2** — a Solana perpetuals and spot trading protocol.

### Programs (`programs/`)
- **`drift/`** — Core protocol (Anchor, ~500k+ lines of Rust). Entry point: `src/lib.rs`. Main instruction handlers in `src/instructions/`:
  - `user.rs` — trading instructions (place/cancel/fill orders)
  - `keeper.rs` — keeper/crank instructions (settle PnL, funding, liquidations)
  - `admin.rs` — admin/governance instructions
  - `lp_pool.rs`, `lp_admin.rs` — LP pool management
- **`pyth/`, `pyth-lazer/`, `switchboard/`, `switchboard-on-demand/`** — Oracle stubs/integrations (minimal, mostly `no-entrypoint` wrappers)
- **`openbook_v2/`, `token_faucet/`** — DEX integration and test utilities

### SDK (`sdk/`)
TypeScript library (`@velocity-exchange/sdk`). Key modules in `src/`:
- `driftClient.ts` — main client class
- `user.ts` — user account abstraction
- `dlob/` — Decentralized Limit Order Book implementation
- `math/` — pricing, margin, funding math
- `idl/drift.json` — generated Anchor IDL (do not edit manually)

### Tests (`tests/`)
~70 TypeScript integration tests using ts-mocha + Anchor's local validator (bankrun for some). Each test spins up a local validator with the program deployed. Tests are run serially by `run-anchor-tests.sh`.

### Program internals
- `programs/drift/src/math/` — core math (funding, fees, margin, AMM)
- `programs/drift/src/state/` — account structs (User, PerpMarket, SpotMarket, etc.)
- `programs/drift/src/controller/` — stateful operations (position updates, fills, liquidations)
- `programs/drift/src/validation/` — pre-instruction validation

### Doc comments

All modules have doc comments. When making feature or refactor changes, update any module-level doc comments that would be invalidated by the change.

### Error enum stability

The drift program's `Error` enum is ABI-stable — on-chain clients identify errors by numeric code. When modifying it:
- **Add** new variants at the **bottom** only, never insert between existing ones.
- **Remove** by marking the variant as deprecated (e.g., `/// @deprecated`) and leaving it in place — do not delete or reorder.

### Key design patterns
- Drift uses a custom native entrypoint (discriminator `[0xFF, 0xFF, 0xFF, 0xFF, opcode]`) for high-frequency keeper instructions that bypass Anchor overhead, alongside the standard Anchor `#[program]` entrypoint.
- `remaining_accounts` is used extensively to pass variable numbers of oracle accounts, spot markets, and maker accounts to instructions.
- Zero-copy account loading (`AccountLoader`) is used for large accounts (User, PerpMarket).
- Feature flags: `mainnet-beta` (production gates), `anchor-test` (enables test helpers), `no-entrypoint`/`cpi` (for SDK dependencies).
