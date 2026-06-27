# deploy-scripts

Devnet deployment scripts for the velocity program. The devnet quote token is **dUSDT** — a velocity-controlled SPL mint created in Phase 0 and distributed via the `token_faucet` program. Internal env vars and identifiers still use `USDT` (e.g. `USDT_MINT`, `usdtMint`) for brevity; on-chain ticker / spot market name is `dUSDT`.

The devnet program id is read from `[programs.devnet].velocity` in `Anchor.toml` — that and the `declare_id!` in `programs/velocity/src/lib.rs` (Anchor enforces they match) are the source of truth. Override with `VELOCITY_DEVNET_PROGRAM_ID=…` only for one-off testing.

## Program upgrades via CI (preferred)

Program upgrades to **mainnet** and **devnet** are gated through a Squads multisig and proposed by GitHub Actions; the scripts in this directory remain for emergency / direct deploys against the devnet upgrade keypair.

| Target | Trigger | Workflow |
| --- | --- | --- |
| **mainnet** | Push tag `program-velocity-<version>` (e.g. `program-velocity-2.163.0`) | [`.github/workflows/release-program.yaml`](../.github/workflows/release-program.yaml) |
| **devnet** | Run **Manual Devnet Program Deploy** from the Actions tab (pick program + branch) | [`.github/workflows/manual-devnet-deploy.yaml`](../.github/workflows/manual-devnet-deploy.yaml) |

Both workflows do the same thing on different multisigs:

1. Build the program — `anchor idl build` for the IDL JSON (no SBF compile), `solana-verify build` for a reproducible `.so` (Docker image pinned in workflow env). Devnet velocity strips `mainnet-beta` so the devnet-only instructions are compiled in and production gates are off. (Done by the local [`build-program`](../.github/actions/build-program/) composite action — the Solana Foundation reusable build can't express `--skip-lint` or devnet's `--no-default-features`, so the build stays in-house.)
2. Stage the upgrade with [`solana-foundation/github-actions/prepare-squads-release`](https://github.com/solana-foundation/github-actions/tree/main/prepare-squads-release) (pinned by commit SHA), wrapped by the local [`buffer-deploy`](../.github/actions/buffer-deploy/) action. It writes the `.so` to a BPF Upgradeable Loader buffer (resumable — re-sends only missing chunks on retry), writes the IDL JSON to a program-metadata buffer, transfers both buffer authorities to the multisig vault PDA, and (mainnet) exports a `solana-verify` PDA transaction. `buffer-deploy` first asserts the program's **canonical IDL metadata account already exists** (it never creates it — see [Initial deploy](#initial-deploy-create-the-idl-metadata-account) below) and fails fast with instructions if it doesn't. It then logs the program + metadata buffer addresses and the on-chain buffer hash next to the local verifiable `.so` hash (run summary) for multisig-side verification — reproduce it with [`verify-buffer.sh`](#verifying-a-buffer-before-signing-the-squads-proposal).
3. Propose the Squads transaction with [`solana-foundation/squads-program-action`](https://github.com/solana-foundation/squads-program-action) (official, SHA-pinned). Because the IDL metadata account already exists, this is a single vault transaction: `SetData` from the IDL buffer (grow first only if the IDL changed by < 10 KiB) + BPF Loader `Upgrade` + the `solana-verify` PDA instruction (mainnet). One tx, no batch. The proposal is **not** auto-executed — multisig signers approve + execute through the Squads UI.

   > CI only ever **updates** the IDL. The canonical metadata account can only be **created** by the program's upgrade authority, so it is created once at initial program deploy (while the deployer still holds upgrade authority), before authority is handed to the multisig — see [Initial deploy](#initial-deploy-create-the-idl-metadata-account). After that every release is a single-tx `SetData`.

### Required GitHub secrets

| Secret | Purpose |
| --- | --- |
| `MAINNET_RPC_ENDPOINT` / `DEVNET_RPC_ENDPOINT` | Solana RPC URLs (private RPC strongly recommended for mainnet — write-buffer needs ~1200 chunked writes). |
| `MAINNET_DEPLOYER_KEYPAIR` / `DEVNET_DEPLOYER_KEYPAIR` | Solana keypair as a raw `[..]` byte array. Pays buffer rent + signs the Squads proposal. Must be a multisig member with Voter permissions. |
| `MAINNET_MULTISIG` / `DEVNET_MULTISIG` | Squads multisig PDA. |
| `MAINNET_MULTISIG_VAULT` / `DEVNET_MULTISIG_VAULT` | The vault PDA owned by the multisig (Squads "vault index 0"). This is the on-chain program upgrade authority and the IDL metadata authority. |

### Initial deploy: create the IDL metadata account

CI **only updates** the IDL — it never creates the canonical metadata account, because creating one requires the program's **upgrade authority** to sign (program-metadata: "canonical metadata accounts are created by the program upgrade authority"). After launch the upgrade authority is the multisig vault, and creating velocity's ~53 KB account through a vault CPI would need a batched proposal — so instead **the canonical IDL account is created once, by the deployer, at initial program deploy, while the deployer still holds the upgrade authority** (no multisig, no batch — the deployer just sends the chunked writes directly). The Anchor CLI does **not** do this: `anchor deploy` only deploys the program, and `anchor idl init` targets the legacy on-chain IDL account, not the program-metadata account velocity's clients resolve. Use the program-metadata CLI explicitly.

Run this once per cluster (mainnet is not deployed yet; devnet's account already exists), against a **private RPC**, in order — **before** transferring the upgrade authority to the multisig:

```bash
PROGRAM_ID=vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P
RPC=<private-rpc-url>
DEPLOYER=<deployer-keypair.json>          # must be the current program upgrade authority
VAULT=<MAINNET_MULTISIG_VAULT pubkey>

# 1. Deploy the program (deployer is the upgrade authority at this point).
solana program deploy target/deploy/velocity.so \
  --program-id <program-keypair.json> \
  --upgrade-authority "$DEPLOYER" -u "$RPC" --use-rpc

# 2. Build the mainnet IDL JSON (no SBF compile; default features = mainnet, so
#    devnet-only instructions are excluded — matches what CI's build-program emits).
anchor idl build --skip-lint -p velocity -o target/idl/velocity.json

# 3. Create the canonical IDL metadata account (deployer signs as upgrade authority).
npx @solana-program/program-metadata@0.5.1 create idl "$PROGRAM_ID" \
  target/idl/velocity.json --keypair "$DEPLOYER" --rpc "$RPC"

# 4. Delegate the metadata account to the multisig vault so CI can update it.
npx @solana-program/program-metadata@0.5.1 set-authority idl "$PROGRAM_ID" \
  --new-authority "$VAULT" --keypair "$DEPLOYER" --rpc "$RPC"

# 5. Hand the program upgrade authority to the multisig vault (LAST — after the
#    account exists; the vault remains able to update the canonical account as the
#    upgrade authority, and is also the delegated metadata authority from step 4).
solana program set-upgrade-authority "$PROGRAM_ID" \
  --new-upgrade-authority "$VAULT" -k "$DEPLOYER" -u "$RPC"
```

From then on, the tag-/dispatch-triggered workflows above handle every release as a single-tx `SetData` + `Upgrade`. If `buffer-deploy` ever fails with "Canonical IDL metadata account … does not exist", this step was skipped.

### Cutting a mainnet release

```bash
# 1. Bump programs/velocity/Cargo.toml version
# 2. Land that on mainnet-beta
git checkout mainnet-beta
git pull
# 3. Tag it
git tag program-velocity-2.163.0
git push origin program-velocity-2.163.0
# 4. Watch Actions → Release Program to Mainnet → wait for Squads proposal
# 5. Sign + execute in the Squads UI
```

The `mainnet-beta` branch tracks what is (or is about to be) live on mainnet; `master` is active development. The tag itself is the deploy trigger — branch state doesn't gate the workflow. This assumes the program and its canonical IDL account already exist on mainnet — for the very first mainnet deploy, do [Initial deploy](#initial-deploy-create-the-idl-metadata-account) first.

### Verifying a buffer before signing the Squads proposal

Before approving an upgrade in the Squads UI, confirm the staged buffer is
actually what the source compiles to — don't trust the hash CI printed. The CI
`buffer-deploy` step logs the program buffer address and its hash;
`verify-buffer.sh` reproduces the hash from source and compares:

```bash
# Build velocity (devnet flavor) and check it against the buffer the run logged:
deploy-scripts/verify-buffer.sh velocity \
  https://github.com/velocity-exchange/velocity-v1/actions/runs/<id>/job/<id> \
  --devnet --rpc "$SOLANA_RPC"

# Or check a known buffer directly, reusing an already-built .so:
deploy-scripts/verify-buffer.sh velocity --buffer <bufferPubkey> --rpc "$SOLANA_RPC" --skip-build
```

It exits non-zero on a mismatch. Needs `solana-verify`, `gh` (authenticated),
and the solana CLI on `PATH`. Drop `--devnet` for a mainnet build.

---

## Runbook

1. **Build** both programs (x86_64 toolchain; see root `CLAUDE.md`):
   ```
   bash deploy-scripts/build-devnet.sh
   ```
   Builds `velocity` (no default features, no mainnet-beta gate, devnet `declare_id!`) and `token_faucet` (used to distribute devnet dUSDT). The deploy scripts read the devnet program id from `Anchor.toml`; you do not need to set `VELOCITY_DEVNET_PROGRAM_ID` unless overriding for one-off testing.
2. **Deploy** (first time — fresh programs):
   - **Vanity program id + buffer (recommended for large velocity.so uploads):** Build (`bash deploy-scripts/build-devnet.sh`), save your **program keypair JSON** whose pubkey matches `[programs.devnet].velocity` in `Anchor.toml` under `deploy-scripts/out/` (gitignored). If you only have a recovery phrase / seed words, recover once:
     ```
     solana-keygen recover ASK -o deploy-scripts/out/velocity-program-devnet.json --skip-seed-phrase-validation
     ```
     …paste your phrase when prompted (pass `--skip-seed-phrase-validation` if the words are not on the BIP39 English list). Then create the on-chain buffer and deploy from it:
     ```
     export VELOCITY_DEVNET_UPGRADE_KEYPAIR=/path/to/admin-or-buffer-authority.json
     export PROGRAM_KEYPAIR=$PWD/deploy-scripts/out/velocity-program-devnet.json
     bash deploy-scripts/write-buffer-devnet.sh
     BUFFER_ACCOUNT_KEYPAIR=$PWD/deploy-scripts/out/velocity-so-write-buffer-keypair.json \
       PROGRAM_KEYPAIR=$PROGRAM_KEYPAIR bash deploy-scripts/deploy-from-buffer-devnet.sh
     ```
     If your vanity run only printed a short “seed” (e.g. `6IPs6rIASB0S38TO`), treat it as the custom word or passphrase your tool uses with the rest of its output; the recovered pubkey must equal `[programs.devnet].velocity` from `Anchor.toml` — confirm with `solana-keygen pubkey` on the recovered JSON. The deploy scripts will reject a mismatching `PROGRAM_KEYPAIR`.
     Prefer a **private devnet RPC** via `SOLANA_RPC` or `RPC_URL` so `write-buffer` does not hit rate limits.

   - **Alternatively:** `anchor deploy --program-name velocity` … `anchor deploy --program-name token_faucet` with devnet and `PROGRAM_KEYPAIR` / `--program-keypair`.

   For **subsequent upgrades** (same program id): `bash deploy-scripts/deploy-devnet.sh`. The script reads the program id from `Anchor.toml`; set `VELOCITY_DEVNET_UPGRADE_KEYPAIR` (path to the upgrade authority keypair), or legacy `SOLANA_PATH` + `DEVNET_ADMIN`. Override `VELOCITY_DEVNET_PROGRAM_ID=…` only for one-off testing against a non-canonical id.
3. **Sync IDL** into the SDK so the init script sees current instruction shapes:
   ```
   anchor build -- --features anchor-test && cp target/idl/velocity.json sdk/src/idl/velocity.json
   ```
4. **Initialize on-chain state** (phases 0 + A–H in one pass; idempotent):
   ```
   DEVNET_ADMIN=/path/to/admin.json \
   SOL_LAZER_FEED_ID=<u32 feed id> \
   PYTH_LAZER_TOKEN=<pyth lazer relay token> \
   bash deploy-scripts/init-devnet.sh
   ```
   Phase 0 creates a fresh 6-decimal dUSDT SPL mint, pre-mints `USDT_INITIAL_SUPPLY` (default 10M) to the admin ATA, then initializes the `token_faucet` for that mint — transferring mint authority to the faucet PDA so anyone can call `mint_to_user` for devnet dUSDT. The mint keypair is saved to `deploy-scripts/out/usdt-mint.json` (override via `USDT_MINT_KEYPAIR`); the resolved mint pubkey is persisted to the receipt. Re-runs reuse the same mint. To skip mint creation and reuse an existing mint, set `dUSDT_MINT=<pubkey>`.

   Phase C+ subscribes to Pyth Lazer over WSS and posts an initial signed price update for both feeds (SOL + USDT) — required because phase C2 (SOL spot) and phase D (SOL-PERP) call `get_oracle_price` at init, and so does phase E. Phase E runs `update_spot_market_oracle` to switch dUSDT from `QuoteAsset` (the program-mandated init source for spot[0]) to `PythLazerStableCoin` pointing at the USDT lazer PDA. **Phase F is optional** and can be skipped (`SKIP_PHASE_F=1`); a minimal functional devnet deploy is complete after Phase E.

   Writes a receipt to `deploy-scripts/out/devnet-deployment.json` with every created PDA, the dUSDT mint, the token_faucet config PDA, and tx signatures.

   Read-only verifier: `bun run deploy-scripts/verify-devnet.ts <SOL_FEED_ID> <USDT_FEED_ID>` derives every expected PDA from the configured program id and reports which exist on chain. Useful before/after to confirm what was created.
5. **Patch SDK constants** with values from the receipt — these ship as `PublicKey.default` placeholders until the deployment exists:
   - `sdk/src/config.ts` → `configs.devnet.QUOTE_MINT_ADDRESS` ← `usdtMint`
   - `sdk/src/constants/spotMarkets.ts` → `DevnetSpotMarkets[0].mint` ← `usdtMint`, `DevnetSpotMarkets[0].oracle` ← `pythLazerOracles[<usdtFeedId>].pubkey`, `DevnetSpotMarkets[1].oracle` ← `pythLazerOracles[<solFeedId>].pubkey`
   - `sdk/src/constants/perpMarkets.ts` → `DevnetPerpMarkets[0].oracle` ← `pythLazerOracles[<solFeedId>].pubkey`
   - `ui/src/config.ts` → `VELOCITY_PROGRAM_ID` ← receipt `programId` (rebuild + redeploy the bundle)

## Distributing devnet dUSDT to test wallets

After Phase 0 the `token_faucet` program owns the dUSDT mint authority. Any wallet can request tokens by calling `token_faucet.mint_to_user(amount)` with their ATA — see `sdk/src/tokenFaucet.ts` for a TS client. The receipt records the faucet program id, `faucet_config` PDA, and `mint_authority` PDA so bots/scripts can wire up directly.

## Env vars

Required:
- `DEVNET_ADMIN` — path to admin keypair file; becomes `State.admin` **immutably** and the initial dUSDT mint authority (until Phase 0 hands it to the faucet PDA).
- `SOL_LAZER_FEED_ID` — Pyth Lazer u32 feed id for SOL/USD.
- `PYTH_LAZER_TOKEN` — auth token for the Pyth Lazer relay. Required because non-quote spot markets and perp markets call `get_oracle_price` at init, and `update_spot_market_oracle` (Phase E) does too — Phase C+ subscribes to the relay and posts a signed price update before the dependent phases run.

Optional:
- `USDT_LAZER_FEED_ID` — Pyth Lazer u32 feed id for USDT/USD (default `8`). The PythLazerOracle PDA for this feed becomes the dUSDT spot[0] oracle after Phase E.
- `PYTH_LAZER_ENDPOINTS` — comma-separated WSS endpoints (default `wss://pyth-lazer.dourolabs.app/v1/stream`).
- `PYTH_LAZER_WAIT_MS` — milliseconds to wait for the first signed price message before failing (default `30000`).
- `USDT_MINT` — reuse an existing dUSDT SPL mint (6 decimals) instead of creating one.
- `USDT_MINT_KEYPAIR` — path to the keypair for the mint to create (default `deploy-scripts/out/usdt-mint.json`). Use a vanity keypair if desired.
- `USDT_INITIAL_SUPPLY` — whole-token amount pre-minted to admin before the faucet takes mint authority (default `10000000`).
- `TOKEN_FAUCET_PROGRAM_ID` — override (default `V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB`).
- `RPC_URL` (default `https://api.devnet.solana.com`)
- `LP_POOL_ID` (default `1`; id `0` is the "not in a pool" sentinel)
- `LP_MAX_AUM` (default `1_000_000`, multiplied by `QUOTE_PRECISION`)
- `RECEIPT_PATH` (default `deploy-scripts/out/devnet-deployment.json`)
- `SKIP_PHASE_C2=1`, `SKIP_PHASE_D=1`, `SKIP_PHASE_E=1`, `SKIP_PHASE_F=1` — bypass individual phases. **Phase F is optional** (LP pool + dUSDT constituent) — skip freely. Phase E (oracle switch) is **required** for a functional dUSDT spot[0] — only skip during partial re-runs.
- `NON_INTERACTIVE=1` (or `YES=1`) — skip every confirmation prompt; useful for CI

By default the script pauses before pre-flight and before each phase (0 + A–G), printing the resolved inputs (mint, oracle, LP id, etc.) and waiting for `y` to continue. Pre-flight verifies both the velocity and token_faucet programs are deployed/executable, and that any caller-supplied `USDT_MINT` is a real token mint, before any state is touched.

## What gets initialized

See `.claude/plans/velocity-devnet-deployment.md` for the authoritative plan. Summary:

Required phases (0 → E):

- **0**  dUSDT SPL mint (6 dec) + `token_faucet` initialized for that mint
- **A**  global `State` + `AmmCache`
- **B**  dUSDT spot market at index 0 (oracle source forced by program to `QuoteAsset`)
- **C**  Pyth Lazer SOL + USDT oracle PDAs (created empty)
- **C+** post initial Pyth Lazer signed price update for both feeds (one tx)
- **C2** SOL spot market at index 1 (uses SOL Pyth Lazer oracle)
- **D**  SOL-PERP at index 0 (uses SOL Pyth Lazer oracle)
- **E**  switch dUSDT spot market oracle to `PythLazerStableCoin` pointing at the USDT lazer PDA — required because the program forces `QuoteAsset` at init for spot[0] (`admin.rs:217-228`); the only path to `PythLazerStableCoin` is the post-init `update_spot_market_oracle` ix.

Optional phase (skip with `SKIP_PHASE_F=1`):

- **F**  LP pool + dUSDT constituent

Skipped by design (left for later):
- Additional spot markets beyond dUSDT/SOL (BTC, ETH, …)
- `initializeIfRebalanceConfig` (needs ≥2 spot markets — currently satisfied; can be enabled)
- Spot DEX fulfillment (OpenBook V2 / Phoenix / Serum)
- User-invoked flows: `initializeInsuranceFundStake`, `initializeReferrerName`

## Verification

After the script finishes, confirm the program is live (program id from `Anchor.toml`):

```
solana program show "$(sh -c '. deploy-scripts/_lib.sh; velocity_devnet_program_id')" --url devnet
```

Then run the read-only verifier — derives every expected PDA and reports which exist:

```
bun run deploy-scripts/verify-devnet.ts <SOL_FEED_ID> <USDT_FEED_ID>
# e.g. bun run deploy-scripts/verify-devnet.ts 6 8
```

Or inspect the receipt and spot-check with `solana account <pubkey> --url devnet`.

End-to-end smoke: use a second wallet to call `VelocityClient.initializeUserAccount()` → `deposit(usdtAmount, 0)` → `placePerpOrder({ marketIndex: 0, ... })` and observe a keeper fill.

## Operational notes (learned on first deploy)

- **Use a private RPC for `solana program` writes.** The public `api.devnet.solana.com` rate-limits the ~5,000 chunked writes a velocity upgrade requires (velocity.so is ~5 MB → ~5,000 × 1 KB chunks) and fails partway through with `Data writes to account failed: Custom error: Max retries exceeded` and/or `Blockhash expired. N retries remaining`, leaving a partial buffer on chain. Pass a private RPC via `--url` to `solana program …` directly, or set `SOLANA_RPC` / `RPC_URL` for the helper scripts (`write-buffer-devnet.sh` / `deploy-from-buffer-devnet.sh` read it). `anchor program upgrade --provider.cluster <url>` works for the wrapper too, but it does **not** propagate the URL to the underlying `solana program deploy` subprocess — so also `solana config set --url <url>` before invoking anchor. Velocity has a Triton pool at `https://velocity-velocity-a827.devnet.rpcpool.com/<token>` — see user memory `reference_velocity_devnet_rpc.md`.

- **`anchor upgrade` is deprecated → `anchor program upgrade` in Anchor 1.0.** Same flags, same `solana program deploy` underneath. `deploy-devnet.sh` uses the new form.

- **Prefer the two-phase `write-buffer` → `deploy-from-buffer` flow over `anchor program upgrade`** for any upload more than a few hundred KB. The single-shot `anchor program upgrade` / bare `solana program deploy <file.so>` creates an *anonymous* internal buffer, then auto-closes it on fatal error to refund rent — so on the next attempt there's nothing to resume from and you start at chunk 0 again. The two-phase flow uses a **named buffer keypair** so the on-chain buffer persists across attempts and `write-buffer` resumes by only re-sending chunks that haven't landed yet. Use the helper scripts:
  ```
  export VELOCITY_DEVNET_UPGRADE_KEYPAIR=/path/to/upgrade-authority.json
  export SOLANA_RPC=https://velocity-velocity-a827.devnet.rpcpool.com/<token>
  bash deploy-scripts/write-buffer-devnet.sh     # ← re-run this until it exits clean
  BUFFER_ACCOUNT_KEYPAIR=deploy-scripts/out/velocity-so-write-buffer-keypair.json \
    bash deploy-scripts/deploy-from-buffer-devnet.sh
  ```
  The buffer keypair file is reused across `write-buffer-devnet.sh` invocations; each pass closes more gaps until the buffer is whole.

- **Symptom: `Failed to parse ELF file: invalid section header` / `invalid account data for instruction`** when running the swap (`program deploy --buffer …`). The buffer is **partial** — some chunk-writes silently never landed even though `write-buffer` exited 0. The CLI's exit code isn't a reliable "buffer is complete" signal: a last-batch retry success can mask earlier dropped writes. Fix:
  ```
  solana program show <BUFFER_PK> --url <rpc>     # compare Data Length to ls -l target/deploy/velocity.so
  bash deploy-scripts/write-buffer-devnet.sh      # re-run; resume fills missing chunks
  ```
  Two to three resume passes is normal. When `solana program show` reports Data Length ≈ .so size (BPF loader prepends ~45-byte header), the buffer is whole. Adding `--with-compute-unit-price 1000` to the underlying `solana program write-buffer` invocation (or via the `write-buffer-devnet.sh` env) helps individual chunk-writes win contention faster.

- **Why the upload "starts from scratch each time" in the wrapper flow but not in the helper-script flow.** `anchor program upgrade` / `solana program deploy <file>` invent a new buffer pubkey per invocation and never expose it; on partial failure the recent CLI tears the buffer down to refund rent. The next invocation has no buffer to resume into. The helper scripts hold the buffer keypair file on disk, so the next invocation finds the same partial buffer on chain and only writes the gaps.

- **If a buffer is orphaned, reclaim the SOL** — each abandoned buffer locks ~38 SOL (devnet rent for a velocity-sized buffer):
  ```
  # List buffers under each candidate authority (CLI default keypair vs. upgrade authority)
  solana program show --buffers --url <rpc>
  solana program show --buffers --url <rpc> \
    --buffer-authority $(solana-keygen pubkey "$VELOCITY_DEVNET_UPGRADE_KEYPAIR")

  # Close one
  solana program close <BUFFER_PK> --url <rpc> \
    --recipient $(solana-keygen pubkey "$VELOCITY_DEVNET_UPGRADE_KEYPAIR") \
    --buffer-authority "$VELOCITY_DEVNET_UPGRADE_KEYPAIR"

  # Close all buffers under one authority in one shot
  solana program close --buffers --url <rpc> \
    --recipient $(solana-keygen pubkey "$VELOCITY_DEVNET_UPGRADE_KEYPAIR") \
    --buffer-authority "$VELOCITY_DEVNET_UPGRADE_KEYPAIR"
  ```
  `--buffer-authority` must point at the keypair file (signer), not just the pubkey. If `--buffers` finds nothing under either candidate authority but balances look intact, the CLI already auto-closed and refunded — no action needed.
- **`anchor build` for the velocity keypair mismatch:** the checked-in `target/deploy/velocity-keypair.json` is a placeholder, so `anchor build` fails with "Program ID mismatch" on a clean checkout. Pass `--ignore-keys` — the deployed program id is hard-coded in source and the local keypair is unused for upgrade.
- **`bun` strict type-only re-exports:** `bun run deploy-scripts/init-devnet.ts` fails if the SDK re-exports a type without the `type` keyword (e.g. `export { PythLazerPriceFeedArray }`). This was fixed in `sdk/src/index.ts` and `sdk/src/pyth/index.ts`; keep an eye on it when adding new SDK exports.
- **Pyth Lazer message must include `feedUpdateTimestamp`.** The on-chain `post_pyth_lazer_oracle_update` ix silently skips updates whose payload lacks `FeedUpdateTimestamp` (`programs/velocity/src/instructions/pyth_lazer_oracle.rs:99-102`) — the tx returns Ok with no on-chain write, and the next phase fails with `Unable to read oracle price`. Phase C+ subscribes with `feedUpdateTimestamp` plus `bestBid/AskPrice` (used for confidence) and `exponent`; do not strip these properties.
- **dUSDT oracle is a two-step init.** `handle_initialize_spot_market` (`admin.rs:217-228`) hard-requires the quote spot market to be `OracleSource::QuoteAsset` with `oracle = Pubkey::default()`. Switching to `PythLazerStableCoin` afterwards is done in Phase E via `update_spot_market_oracle`, which itself reads the new oracle (`admin.rs:1295-1300`) — so the USDT lazer PDA must already have a posted price. This is why Phase C+ runs before Phase E and must succeed.
