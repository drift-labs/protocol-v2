# Velocity v2 Devnet Deployment Plan

## At a glance

End-to-end flow, in order. Every step past build/deploy is driven by `deploy-scripts/init-devnet.ts`.

| # | Step | How |
|---|---|---|
| 1 | **Build** `velocity` + `token_faucet` | `bash deploy-scripts/build-devnet.sh` |
| 2 | **Deploy** both programs to devnet | `anchor deploy --program-name velocity` / `--program-name token_faucet` |
| 3 | **Sync IDL** into SDK | `cp target/idl/velocity.json sdk/src/idl/velocity.json` |
| 4 | **Init** — run once (idempotent) | `bash deploy-scripts/init-devnet.sh` |

What the init script does, phase by phase:

| Phase | What | Key call(s) |
|---|---|---|
| 0 | Create **dUSDT** mint, pre-mint to admin, wire `token_faucet` (transfers mint authority to faucet PDA) | `createMint` → `token_faucet.initialize` |
| A | Global state + AMM cache | `initialize(usdtMint)` → `initializeAmmCache` |
| B | **dUSDT spot market @ index 0** (quote) | `initializeSpotMarket(..., QUOTE_ASSET)` |
| C | **Pyth Lazer SOL/USD oracle** PDA | `initializePythLazerOracle(solFeedId)` |
| D | **SOL-PERP @ index 0** | `initializePerpMarket(...)` |
| E | IF shares transfer config (global) | `initializeProtocolIfSharesTransferConfig` |
| F | LP pool id=1 + dUSDT constituent | `initializeLpPool` → `initializeConstituent` |
| G | Protected-maker-mode config (global) | `initializeProtectedMakerModeConfig` |

Required env: `$DEVNET_ADMIN`, `$SOL_LAZER_FEED_ID`. Optional: `$USDT_MINT*`, `$USDT_INITIAL_SUPPLY`, `$TOKEN_FAUCET_PROGRAM_ID`.

Outputs: `deploy-scripts/out/devnet-deployment.json` (PDAs + tx sigs + SDK config), `deploy-scripts/out/usdt-mint.json` (mint keypair — preserve for re-runs).

Distribution: any wallet calls `token_faucet.mint_to_user` to self-serve dUSDT (see `sdk/src/tokenFaucet.ts`).

---

## Context

Deploy the Velocity Protocol v2 program to **Solana devnet** as a fresh, minimum-viable instance and then layer on LP pools, insurance-fund staking config, and admin governance (protected maker mode, IF rebalance). The devnet quote asset is **dUSDT** — a velocity-controlled 6-decimal SPL mint created during Phase 0 of the init script and distributed via the `token_faucet` program (we own the mint authority via a faucet PDA, so anyone can self-serve test tokens). Internal identifiers (`USDT_MINT`, `usdtMint`, etc.) still spell the token "USDT" for brevity; on-chain ticker / spot market name is **dUSDT**. All price oracles use **Pyth Lazer**. Scope at launch: dUSDT spot (index 0) + one SOL‑PERP perp (index 0). Everything else (additional spot/perps, DEX fulfillment, referrer claims) is left for later — but the one‑time admin plumbing for IF, LP and governance is included so users can immediately stake IF, LP pools can accept constituents, and maker/rebalancer configs are in place.

Deliverable: a sequenced runbook + a deploy script (`deploy-scripts/init-devnet.ts`) that the admin wallet runs once after `anchor deploy`, producing a live, tradable devnet protocol.

## Prerequisites

- Toolchain: `rustup default stable-x86_64-apple-darwin` (Anchor 1.0 branch, never native aarch64 — zero-copy alignment).
- `bun` for SDK (`cd sdk && bun install && bun run build`).
- A funded devnet admin wallet (path via `$DEVNET_ADMIN`); this key becomes `State.admin` **immutably** and is the initial mint authority for the dUSDT mint until Phase 0 transfers authority to the `token_faucet` PDA.
- **No pre-existing quote mint required.** Phase 0 of `init-devnet.ts` creates a fresh 6-decimal SPL mint we control (ticker `dUSDT`), pre-mints an initial supply to the admin, then initializes `token_faucet` for that mint so anyone can self-serve devnet dUSDT via `token_faucet.mint_to_user`. Override via `$USDT_MINT` only if you want to reuse a pre-existing mint instead.
- Pyth Lazer SOL/USD feed ID (u32) — fetch from Pyth Lazer devnet feed registry at deploy time; not hardcoded in this repo.
- `Token Program` and `Token-2022` are already on devnet (nothing to do).

## Programs to deploy

| Program | Path | Required | Notes |
|---|---|---|---|
| `velocity` | `programs/velocity/` | yes | Core protocol. Program ID is declared: `vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P` (`programs/velocity/src/lib.rs:70-73`). |
| `openbook_v2` | `programs/openbook_v2/` | skip | Only needed if enabling OpenBook V2 spot fulfillment (not in scope). |
| `token_faucet` | `programs/token_faucet/` | **yes** | Distributes the devnet dUSDT mint to test wallets. Program ID `V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB` (non-mainnet). Phase 0 of the init script transfers dUSDT mint authority to the `mint_authority` PDA owned by this program so any wallet can call `mint_to_user`. |

`programs/pyth-lazer/` is **not a deployable program** — it's a Rust library crate (`crate-type = ["lib"]`, no Anchor entrypoint) providing Lazer message types and signature-verification utilities that the velocity program links against. The actual Pyth Lazer verifier program is deployed and maintained by Pyth Labs on devnet/mainnet; we consume it, we do not deploy it. No action needed for this crate at deploy time beyond it being compiled into the velocity program.

Build: `bash deploy-scripts/build-devnet.sh` (builds `velocity` with `--no-default-features --features no-entrypoint` to omit the `mainnet-beta` gate — see `programs/velocity/Cargo.toml:12-23` — and `token_faucet` with default features).

Deploy (fresh, not upgrade): run `anchor deploy --program-name velocity` and `anchor deploy --program-name token_faucet` against `--provider.cluster devnet --provider.wallet $DEVNET_ADMIN`. The existing `deploy-scripts/deploy-devnet.sh` uses `anchor upgrade` — only use that for subsequent upgrades.

After deploy: `anchor build -- --features anchor-test && cp target/idl/velocity.json sdk/src/idl/velocity.json` so the init script sees the latest IDL.

## Initialization sequence

Write the runbook as `deploy-scripts/init-devnet.ts` using `@velocity-exchange/sdk` `AdminClient`. All calls are admin-signed.

### Phase 0 — Mint dUSDT and wire token_faucet for distribution

0. **Create the dUSDT SPL mint.** Use `@solana/spl-token`'s `createMint(connection, admin, mintAuthority=admin, freezeAuthority=null, decimals=6, mintKeypair)`. The mint keypair is generated and persisted to `deploy-scripts/out/usdt-mint.json` (override via `$USDT_MINT_KEYPAIR`); set `$USDT_MINT` to skip creation and reuse a pre-existing mint. Idempotent: if the mint account already exists at the keypair's pubkey, creation is skipped.

0.1. **Pre-mint admin supply.** Mint `$USDT_INITIAL_SUPPLY` (default `10_000_000` whole tokens) to the admin's dUSDT ATA so the admin can seed vaults and test wallets without going through the faucet. Skipped on re-run once mint authority has been transferred to the faucet PDA.

0.2. **Initialize `token_faucet` for the mint.** Call `token_faucet.initialize` (program id `V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB`, override via `$TOKEN_FAUCET_PROGRAM_ID`). The handler creates a `FaucetConfig` PDA `[b"faucet_config", mint]` and SetAuthorities the mint to its `mint_authority` PDA `[b"mint_authority", mint]` (`programs/token_faucet/src/lib.rs:17-40`). After this step, any wallet can call `token_faucet.mint_to_user(amount)` with their ATA to receive devnet dUSDT — see `sdk/src/tokenFaucet.ts` for a TS client. Idempotent: skipped if `FaucetConfig` PDA already exists.

The receipt records `usdtMint` (the dUSDT mint), `usdtMintKeypairPath`, `tokenFaucet.{programId, faucetConfig, mintAuthority, initTxSig}`, and pre-mint tx sig. An intermediate receipt is written immediately after Phase 0 so the mint isn't lost if a later phase fails.

### Phase A — Global state (one‑time, must be first)

1. **`AdminClient.initialize(usdtMint, false)`** — `sdk/src/adminClient.ts:100`. Creates the `State` PDA `[b"velocity_state"]` and derives `velocity_signer`. Handler: `programs/velocity/src/instructions/admin.rs:106` (`handle_initialize`). `quoteAssetMint` is parametric — passing the USDT mint is sufficient; no code hardcodes USDC (`admin.rs:121` just stores the mint). `State` starts with `number_of_markets = 0`, `number_of_spot_markets = 0`.

2. **`AdminClient.updatePerpAuctionDuration(10)`** — recommended default. Sets the min perp auction duration visible to keepers/fillers. `State.min_perp_auction_duration` is already 10 from `handle_initialize` (`admin.rs:120`), so this is optional but explicit.

3. **`AdminClient.initializeAmmCache()`** — `sdk/src/adminClient.ts:703`. Creates `AmmCache` PDA pre‑allocated for up to 16 perp markets. **Required before any `initializePerpMarket` call.**

### Phase B — Quote spot market (dUSDT @ index 0)

4. **`AdminClient.initializeSpotMarket(...)`** — `sdk/src/adminClient.ts:136`. Must be index 0. Required values:
   - `mint` = dUSDT mint created in Phase 0.
   - `oracle` = `PublicKey.default()`.
   - `oracleSource` = `OracleSource.QUOTE_ASSET`.
   - Weights: `initialAssetWeight=SPOT_WEIGHT_PRECISION`, `maintenanceAssetWeight=SPOT_WEIGHT_PRECISION`, `initialLiabilityWeight=SPOT_WEIGHT_PRECISION`, `maintenanceLiabilityWeight=SPOT_WEIGHT_PRECISION`.
   - Rates: `optimalUtilization=SPOT_MARKET_RATE_PRECISION/2`, `optimalRate=SPOT_MARKET_RATE_PRECISION`, `maxRate=SPOT_MARKET_RATE_PRECISION`.
   - `assetTier=COLLATERAL`, `name="dUSDT"`.

   Creates the `SpotMarket` PDA, the `spot_market_vault`, and the `insurance_fund_vault` (both token accounts owned by `velocity_signer`). Template parameters lifted from `tests/testHelpers.ts:1145` (`initializeQuoteSpotMarket`).

### Phase C — Pyth Lazer SOL/USD oracle

5. **`AdminClient.initializePythLazerOracle(solFeedId)`** — `sdk/src/adminClient.ts:4737-4746`. Creates the `PythLazerOracle` PDA `[b"pyth_lazer", feed_id.to_le_bytes()]` (seed constant: `programs/velocity/src/state/pyth_lazer_oracle.rs:5`; handler: `programs/velocity/src/instructions/admin.rs:4541-4552`). Capture the returned PDA pubkey — that PDA is the `priceOracle` passed to `initializePerpMarket`.

### Phase D — SOL‑PERP (index 0)

6. **`AdminClient.initializePerpMarket(...)`** — `sdk/src/adminClient.ts:542`. Core args:
   - `marketIndex = 0`.
   - `priceOracle = <PythLazerOracle PDA from step 5>`.
   - `oracleSource = OracleSource.PYTH_LAZER`.
   - AMM seed: `baseAssetReserve = 1000 * AMM_RESERVE_PRECISION`, `quoteAssetReserve = 1000 * AMM_RESERVE_PRECISION`, `pegMultiplier = PEG_PRECISION` (tune at real deploy time against oracle price).
   - `periodicity = 3600` (funding update cadence).
   - `contractTier = SPECULATIVE`, `marginRatioInitial = 2000` (20%), `marginRatioMaintenance = 500` (5%).
   - `orderStepSize = BASE_PRECISION/10000`, `orderTickSize = PRICE_PRECISION/100000`, `minOrderSize = BASE_PRECISION/10000`.
   - `maxSpread = 142500`, `baseSpread = 0`, `curveUpdateIntensity = 0`, `ammJitIntensity = 0`.
   - `activeStatus = true`, `name = "SOL-PERP"`, `lpPoolId = 0` (default pool id — will be wired to the real LP pool in Phase F).

   Template lifted from `tests/admin.ts:99-108`.

### Phase E — Insurance fund admin config

7. **`AdminClient.initializeProtocolIfSharesTransferConfig()`** — `sdk/src/adminClient.ts:3996-4024`. Creates the global `ProtocolIfSharesTransferConfig` PDA (one‑time; governs IF share transfers). Without it, IF share transfer flows are blocked.

   *No per‑market or per‑user IF admin call is needed.* The per‑market IF vault was created in step 4 as part of `initializeSpotMarket`. `initializeInsuranceFundStake` is **user‑invoked** on first stake (`programs/velocity/src/instructions/if_staker.rs:33-57`) — the deployer does not call it.

### Phase F — LP pool scaffolding

8. **`AdminClient.initializeLpPool(lpPoolId=1, minMintFee, maxAum, maxSettleQuoteAmountPerMarket, lpTokenMintKeypair)`** — `sdk/src/adminClient.ts:5262-5281`. Creates the `LPPool`, `AmmConstituentMapping`, and `ConstituentTargetBase` PDAs, plus a 6‑decimal LP token mint with authority = LP pool PDA. Handler: `programs/velocity/src/instructions/lp_admin.rs:35-111`. Use `lpPoolId=1`; id `0` is the sentinel used by perp markets that are *not* in a pool.

9. **`AdminClient.initializeConstituent(lpPoolId=1, { spotMarketIndex: 0, ... })`** — `sdk/src/adminClient.ts:5355-5414`. Adds dUSDT (index 0) as the first constituent. Handler: `programs/velocity/src/instructions/lp_admin.rs:114-211`. Set modest `swapFees`, `maxWeightDeviation`, and initial target weight 100% until more constituents are added. Creates the constituent's token vault owned by `velocity_signer`.

   *Further constituents (SOL spot, etc.) are added later with the same call.* No perp‑constituent init instruction exists — perps participate via `lpPoolId` set on the perp market. The constituent's vault holds dUSDT issued by our own mint.

### Phase G — Governance / maker / rebalancer configs

10. **`AdminClient.initializeProtectedMakerModeConfig(maxUsers)`** — `sdk/src/adminClient.ts:4767-4803`. Admin one‑time, global. Creates `ProtectedMakerModeConfig` PDA `[b"protected_maker_mode_config"]` (struct at `programs/velocity/src/instructions/admin.rs:6000-6020`). Pick a generous `maxUsers` (e.g., 200) for devnet.

11. **`AdminClient.initializeIfRebalanceConfig(params)`** — `sdk/src/adminClient.ts:4597-4627`. Per `(in_market_index, out_market_index)` pair. For devnet launch we only have dUSDT (index 0) so skip unless/until a second spot market is added; keep the helper stubbed and document in the script how to invoke once SOL spot lands.

*Referrer names are user‑invoked (`programs/velocity/src/instructions/user.rs:292-325`) — no admin setup.*

## Necessary code changes for dUSDT quote asset support

Switching the deployment from the repo's current devnet **USDC @ spot market 0** assumptions to **dUSDT @ spot market 0** is not just an init-script concern. The on-chain program already accepts an arbitrary quote mint in `initialize`, so the core quote-asset switch does **not** require new protocol logic by itself, but the SDK and deployment config must be updated so clients/keepers resolve the correct mint, oracle PDAs, and market metadata. Because we own the dUSDT mint via `token_faucet`, no upstream registry coordination is required — the mint pubkey is whatever Phase 0 emits.

### Program changes

- **No quote-asset-specific program logic change is required** for the base deployment. `handle_initialize` stores the quote mint passed by the admin, and `initializeSpotMarket(..., oracleSource = QUOTE_ASSET)` supports a USDT quote market at index 0.
- **Do not add any USDC-specific branching in program code.** If any helper script or downstream tool needs the quote mint, read it from `State` / market config rather than hardcoding USDC.
- **Separate non-quote caveat:** if the deployment still wants `ProtocolIfSharesTransferConfig` initialization in scope, that requires restoring the currently commented-out program entrypoints in `programs/velocity/src/lib.rs`; this is not caused by USDT specifically, but it is a real code-level blocker for that phase.

### SDK / client config changes

1. **Introduce a deployment-specific SDK config instead of reusing the repo's current devnet defaults unchanged.**
   - Current devnet config in `sdk/src/config.ts` and `sdk/src/constants/{spotMarkets,perpMarkets}.ts` assumes the existing shared devnet deployment, including:
   - program id `vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P`
   - quote mint = canonical devnet USDC
   - pre-existing oracle PDA addresses
   - If this new deployment replaces the repo's canonical devnet environment, update those files directly.
   - If it is a parallel/custom devnet instance, create a dedicated config path (preferred) so existing devnet users do not silently switch to the new markets.

2. **Update quote spot market metadata for market index 0.**
   - In the deployment-specific spot-market config, change market 0 from `USDC` to `dUSDT`.
   - Set `mint` to the dUSDT mint emitted by Phase 0 of the init script.
   - Set `symbol/name` to `dUSDT`.
   - Set the quote market's oracle metadata to match the actual on-chain initialization. If market 0 is initialized with `OracleSource.QUOTE_ASSET`, the SDK config should reflect that rather than continuing to point at the old devnet stablecoin oracle account.

3. **Update perp market oracle addresses to the newly derived Lazer PDAs.**
   - The perp market config cannot keep using the current hardcoded devnet oracle pubkeys.
   - For this deployment, `PerpMarket[0].oracle` should be the `PythLazerOracle` PDA derived from **this deployment's program id** and the configured SOL feed id.
   - The init script should write the resolved PDA(s) into an artifact that the SDK config can consume.

4. **Make the quote-mint config naming generic where practical.**
   - `sdk/src/config.ts` currently exposes `USDC_MINT_ADDRESS`, which becomes misleading once devnet quote collateral is dUSDT.
   - Preferred change: introduce `QUOTE_MINT_ADDRESS` (or equivalent) and migrate quote-aware consumers to use that field.
   - If renaming is too disruptive immediately, add a deployment-specific override and leave a compatibility alias, but document that the field is semantically "quote mint", not necessarily USDC.

5. **Update scripts/tests/helpers that assume "devnet quote == USDC".**
   - Any script that reads `getConfig().USDC_MINT_ADDRESS`, `DevnetSpotMarkets[0]`, or hardcodes canonical devnet USDC should be switched to the deployment-specific quote market config.
   - Operator-facing env vars in the new deployment scripts remain `USDT_MINT` / `USDT_MINT_KEYPAIR` / `USDT_INITIAL_SUPPLY` for brevity (the on-chain ticker is `dUSDT`); if this is expected to generalize later, prefer neutral names like `QUOTE_MINT`.

6. **Emit a generated deployment artifact for downstream consumers.**
   - `deploy-scripts/init-devnet.ts` should not only write a receipt of tx signatures/PDAs; it should also write the exact market/oracle config needed by keepers, bots, and SDK consumers.
   - Minimum contents: `programId`, `usdtMint` (the dUSDT mint), `tokenFaucet.{programId, faucetConfig, mintAuthority}`, `spotMarket0`, `perpMarket0`, `pythLazerOraclePubkeys`, and any LP pool ids created during init.
   - This avoids hand-copying PDAs from logs into `sdk/src/constants/*.ts`.

## Files to create / modify

| Path | Action | Purpose |
|---|---|---|
| `deploy-scripts/init-devnet.ts` | **create** | TypeScript runbook executing Phases 0 + A–G above via `AdminClient` and (Phase 0) `@solana/spl-token` + raw `token_faucet` Anchor program calls. Idempotency: every PDA / mint creation step checks on-chain state and skips if already present. Writes a JSON receipt (`deploy-scripts/out/devnet-deployment.json`) with every created PDA + tx signature; also persists the dUSDT mint keypair to `deploy-scripts/out/usdt-mint.json` (override path with `$USDT_MINT_KEYPAIR`). |
| `deploy-scripts/init-devnet.sh` | **create** | Thin shell wrapper: `bun run deploy-scripts/init-devnet.ts`. Requires `$DEVNET_ADMIN` and `$SOL_LAZER_FEED_ID`; mint env vars are optional. |
| `deploy-scripts/build-devnet.sh` | **modify** | Build both `velocity` (with `--no-default-features --features no-entrypoint`) and `token_faucet` so both `.so`s are ready to deploy. |
| `deploy-scripts/README.md` | **create (short)** | Minimal operator runbook pointing at build → deploy → init scripts, env vars (`$DEVNET_ADMIN`, `$SOL_LAZER_FEED_ID`, optional `$USDT_MINT*`/`$USDT_INITIAL_SUPPLY`/`$TOKEN_FAUCET_PROGRAM_ID`), distribution flow, and the receipt path. Kept short per user preference. |
| `sdk/src/config.ts` | **modify** | Add a deployment-specific config/override path for the new devnet instance and stop relying on the existing devnet USDC assumptions. |
| `sdk/src/constants/spotMarkets.ts` | **modify** | Define the quote spot market for the new deployment as **dUSDT @ index 0** with the correct mint/oracle metadata. |
| `sdk/src/constants/perpMarkets.ts` | **modify** | Point `SOL-PERP` at the newly created `PythLazerOracle` PDA for this deployment instead of the current shared-devnet oracle pubkey. |

No quote-asset-specific program (Rust) changes should be necessary. SDK/config changes are required. If `ProtocolIfSharesTransferConfig` remains in scope, that specific instruction surface may require a program/IDL change before this runbook can execute end-to-end.

## Reusable references

- `tests/testHelpers.ts:1145` (`initializeQuoteSpotMarket`) — canonical spot-market-0 args.
- `tests/testHelpers.ts:1184` (`initializeSolSpotMarket`) — template if/when adding SOL spot.
- `tests/admin.ts:90-110` — full minimum init sequence (state → spot0 → amm cache → perp0), directly portable to `init-devnet.ts`.
- `sdk/src/addresses/pda.ts` — PDA derivation helpers (`getVelocityStateAccountPublicKey`, `getSpotMarketPublicKey`, `getPerpMarketPublicKey`, `getPythLazerOraclePublicKey`, `getLpPoolPublicKey`, `getConstituentPublicKey`).
- `sdk/src/constants/spotMarkets.ts:30-50` — pattern for the per-cluster market config array; after init, add a "devnet" entry here (or a parallel file) so downstream SDK consumers resolve markets by index.

## Verification

1. **Programs on chain**: `solana program show vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P --url devnet` returns a valid program.
2. **State account**: `AdminClient.getStateAccount()` returns `admin == $DEVNET_ADMIN`, `number_of_spot_markets == 1`, `number_of_markets == 1`.
3. **Spot market**: fetch `SpotMarket[0]`, assert `mint == dUSDT mint`, `oracle_source == QUOTE_ASSET`, name decodes to `"dUSDT"`, and the spot vault/IF vault are Token accounts owned by `velocity_signer`.
4. **Perp market**: fetch `PerpMarket[0]`, assert `amm.oracle == <lazer PDA>` and `oracle_source == PYTH_LAZER`; `AmmCache` has a non‑zero slot at index 0.
5. **LP**: `LPPool` PDA for id `1` exists; `Constituent` for (pool=1, spot=0) exists; the LP token mint's authority is the LP pool PDA.
6. **Governance PDAs**: `ProtectedMakerModeConfig` and `ProtocolIfSharesTransferConfig` fetchable (non-null, correct owner = velocity program).
7. **dUSDT mint + faucet**: confirm the dUSDT mint exists with `decimals == 6` and current `mint_authority == tokenFaucet.mintAuthority` PDA recorded in the receipt. Calling `token_faucet.mint_to_user` from a fresh wallet should top up its dUSDT ATA without touching admin keys.
8. **End-to-end smoke**:
   - Run `ts-mocha -t 300000 ./tests/admin.ts` against the devnet config (points at the deployed program) to exercise the same init sequence in a known-good way; skip if the test infra doesn't support a remote cluster, in which case run locally against the same built `velocity.so`.
   - Have a second test wallet pull dUSDT via the faucet, call `VelocityClient.initializeUserAccount()`, `deposit(dUsdtAmount, 0)`, then `placePerpOrder({ marketIndex: 0, baseAssetAmount: ..., ... })` with a keeper loop to fill. Observing a filled order on devnet is the real green light.
9. **Rollback**: The initial program deploy retains the buffer; if Phase 0/A..G errors, the programs are still upgradable via `deploy-scripts/deploy-devnet.sh`. State/market accounts, once created, **cannot be cleanly deleted** — ensure the admin wallet and Lazer feed id are correct *before* running Phase A. Phase 0 itself is restartable: as long as the dUSDT mint keypair is preserved at `usdt-mint.json`, re-runs reuse the same mint and skip already-completed sub-steps.

## Current devnet deployment

As of 2026-04-22 the devnet stack is fully initialized. Authoritative values live in `deploy-scripts/out/devnet-deployment.json` (gitignored — keypairs + local-only metadata); the pubkeys are duplicated here for quick reference.

| Account | Pubkey |
|---|---|
| velocity program | `vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P` |
| token_faucet program | `V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB` |
| admin (State.admin, immutable) | `HL7uposJAPpecWFZQRMXe26ryKauCDYJN56MHqjq6Ypi` |
| dUSDT mint (6 dec) | `8FfvSRKMZRDHrCBy142XMUXrKEkXnxDQ4YmJv7xbAw8Q` |
| token_faucet config PDA | `A5pgLYFVj2oNeZX3Bqi8jCnxNkLPzUNJCnNVisqcuth7` |
| token_faucet mint authority PDA | `DgqYwE7MdWhTFWwN1heNsbuZE5AxxzozQvNFe6tpJFqB` |
| State | `5zpq7DvB6UdFFvpmBPspGPNfUGoBRRCE2HHg5u3gxcsN` |
| AmmCache | `BhCDG7fVRrrBj4nUxhPUzLK4LyrS8YGd7Ty7cvLBEq8G` |
| SpotMarket 0 (dUSDT) | `6gMq3mRCKf8aP3ttTyYhuijVZ2LGi14oDsBbkgubfLB3` |
| PythLazerOracle (feed 6, SOL/USD) | `3m6i4RFWEDw2Ft4tFHPJtYgmpPe21k56M3FHeWYrgGBz` |
| PerpMarket 0 (SOL-PERP) | `8UJgxaiQx5nTrdDgph5FiahMmzduuLTLf5WmsPegYA6W` |
| ProtocolIfSharesTransferConfig | `39V44DZCvm4e2J1fWU7yszNAdYhCoLHWBfCwuXiBomYk` |
| LP pool (id=1) | `ELgW8UwFRAUc7YpRMzJiuVVwSFmPHMW9knY6hBx9vRxa` |
| Constituent (pool=1, spot=0) | `CB87ZvrM3onYtg1uh27p6VLLyhW7sBkC9npY8xaKJoGk` |
| ProtectedMakerModeConfig | `cid3w4yZ1MRduxa7ZhZduSan6FtujeKNTmLyY9nuD2s` |

SDK constants have been patched to match (`sdk/src/config.ts` `QUOTE_MINT_ADDRESS`, `sdk/src/constants/spotMarkets.ts` `DevnetSpotMarkets[0].mint`, `sdk/src/constants/perpMarkets.ts` `DevnetPerpMarkets[0].oracle`).

## Re-deployment under a fresh program id (in progress 2026-04-23)

### Why

The "deploy" we ran on 2026-04-22 was actually an `anchor upgrade` against the long-lived devnet program id `vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P`. That id has held velocity bytecode since well before the Anchor 1.0 migration commit (`fc922b0d8`), which changed zero-copy struct layouts (alignment padding, derive ordering, possibly field order). All `State` / `PerpMarket` / `SpotMarket` / `AmmCache` / `User` / `UserStats` / IF accounts created under the previous bytecode are now decoded with the new layout and must be considered corrupt.

The init script we ran is idempotent and short-circuits when accounts already exist, so the only on-chain object actually freshly created on 2026-04-22 was the new dUSDT mint + token_faucet wiring. Every other PDA in the table above is a legacy account being mis-decoded.

User-owned accounts (`User`, `UserStats`, IF stakes from prior testers) cannot be deleted by us. Any in-place wipe of admin-owned accounts still leaves those user accounts borked, with no admin recourse. So we relocate to a new program id and treat every account under the old id as garbage.

### New program id

Random keypair generated via `solana-keygen new` (vanity grind abandoned — not worth the wait for a devnet-only id). Keypair stored at `deploy-scripts/out/devnet-program-keypair.json` — gitignored, treated as the program-upgrade authority for the new devnet program.

**Pubkey:** `FGXfSBCXqSTkBX6zTQyPo8JbC11pn5DGKYm9MSbLC7P2`

### Files to swap (program id only)

Mainnet remains untouched — `declare_id!` is already feature-gated.

| Path | Edit |
|---|---|
| `programs/velocity/src/lib.rs:73` | `#[cfg(not(feature = "mainnet-beta"))] declare_id!("FGXfSBCXqSTkBX6zTQyPo8JbC11pn5DGKYm9MSbLC7P2");` (leave the `mainnet-beta` arm alone) |
| `Anchor.toml:21` | `velocity = "FGXfSBCXqSTkBX6zTQyPo8JbC11pn5DGKYm9MSbLC7P2"` under `[programs.devnet]` (or whichever section is active) |
| `sdk/src/config.ts` | `configs.devnet.VELOCITY_PROGRAM_ID = "FGXfSBCXqSTkBX6zTQyPo8JbC11pn5DGKYm9MSbLC7P2"` |
| `deploy-scripts/deploy-devnet.sh` | `--program-id FGXfSBCXqSTkBX6zTQyPo8JbC11pn5DGKYm9MSbLC7P2` |
| `sdk/src/idl/velocity.{json,ts}`, `target/idl/velocity.json`, `target/types/velocity.ts` | regenerate via `anchor build -- --features anchor-test && cp target/idl/velocity.json sdk/src/idl/velocity.json` |

Test-fixture references to the old id (under `programs/velocity/src/**/tests.rs` and `sdk/tests/events/parseLogsForCuUsage.ts`) can stay — they're string literals in test data, not live references.

### Runbook

1. **Generate keypair** → `deploy-scripts/out/devnet-program-keypair.json`. Pubkey recorded above.
2. **Swap source** per the table above.
3. **Build**: `bash deploy-scripts/build-devnet.sh` (likely needs `--ignore-keys` again — the local placeholder keypair won't match the new id either, but the deployed id is whatever we pass on the CLI).
4. **Deploy fresh**: `anchor deploy --provider.cluster <triton-rpc> --provider.wallet <admin> --program-name velocity --program-keypair deploy-scripts/out/devnet-program-keypair.json` — this is an *initial* deploy, not an upgrade. token_faucet is unchanged and stays at `V4v1mQi…` (no redeploy needed; its mint authority PDA depends on the dUSDT mint, not on velocity's program id).
5. **Sync IDL** into the SDK.
6. **Re-init**: move aside `deploy-scripts/out/devnet-deployment.json` (so the init script writes a fresh receipt), then run phases 0+A–G. Decisions before the run:
    - **Reuse the existing dUSDT mint** (`8FfvSRKMZRDHrCBy142XMUXrKEkXnxDQ4YmJv7xbAw8Q`)? Yes — set `dUSDT_MINT` to it. The mint is owned by SPL Token, not by velocity, so it's untouched by the program swap; reusing it preserves the 10M pre-mint and any test-wallet balances.
    - **token_faucet wiring**: already correct for that mint; init Phase 0 will detect it's initialized and skip.
    - All other PDAs (`State`, `AmmCache`, `SpotMarket[0]`, `PythLazerOracle`, `PerpMarket[0]`, `ProtocolIfSharesTransferConfig`, LP pool/constituent, `ProtectedMakerModeConfig`) re-derive against the new program id, so they're fresh and the init script will create them.
7. **Repatch SDK constants** from the new receipt:
    - `sdk/src/config.ts` → `configs.devnet.QUOTE_MINT_ADDRESS` (unchanged if reusing mint), `VELOCITY_PROGRAM_ID` (NEW)
    - `sdk/src/constants/spotMarkets.ts` → `DevnetSpotMarkets[0].mint` (unchanged if reusing mint)
    - `sdk/src/constants/perpMarkets.ts` → `DevnetPerpMarkets[0].oracle` ← new `PythLazerOracle` PDA from the receipt
8. **Tear down old program** to recover rent and remove the source-of-confusion:
    - `solana program show vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P --url <rpc>` to confirm upgrade authority is the admin
    - `solana program close vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P --keypair <admin> --bypass-warning`
    - Rent (~38 SOL) refunds to the admin. **Irreversible** — confirm with the user before running.
    - Borked legacy PDAs become unowned/unreachable garbage; they're dust on devnet.
9. **Verify** per the existing checklist (state.admin, market shapes, faucet authority, smoke trade).

### Cost / risk

- Buffer rent again: ~38 SOL temporarily during deploy, refunded once the program is finalized. Admin wallet currently has ~40 SOL — should be sufficient; top up via faucet or user-forwarding if not.
- Risk window: between step 4 and step 7, SDK constants point at a program that doesn't have a `State` yet. Anything reading `DevnetSpotMarkets[0]` against the new id will fail until step 6 finishes. Acceptable since only we are using the devnet.

### Re-deployment receipt (2026-04-23)

Velocity program `FGXfSBCXqSTkBX6zTQyPo8JbC11pn5DGKYm9MSbLC7P2` deployed at slot 457460050 (tx via Triton RPC). Init phases 0+A,B,C,F,G ran cleanly under the new id. Two phases skipped this round:

- **Phase D (SOL-PERP)** skipped via `SKIP_PHASE_D=1`. The freshly created `PythLazerOracle` PDA had no price posted, so `initializePerpMarket` failed `InvalidOracle (6035)` — "Multiple larger than oracle precision". Unblock by cranking the new oracle once with a Pyth Lazer publisher signature, then re-run with `SKIP_PHASE_D` unset.
- **Phase E (`ProtocolIfSharesTransferConfig`)** skipped via `SKIP_PHASE_E=1`. The instruction is currently commented out in `programs/velocity/src/lib.rs:1717-1721`, so it isn't in the IDL. Re-enable by uncommenting + rebuilding + re-upgrading the program if/when devnet needs IF share transfers.

Two adjustments were also made to `init-devnet.ts` while running:
- Switched the program-id source from `VELOCITY_PROGRAM_ID` to the new `VELOCITY_DEVNET_PROGRAM_ID` constant in `sdk/src/config.ts` (so devnet doesn't piggyback the mainnet id).
- `initializeConstituent` reads spot market 0 via the websocket subscriber cache. The main `AdminClient` was constructed with `spotMarketIndexes: []` (markets didn't exist at startup). Phase F.2 now spins up a transient `AdminClient` with `spotMarketIndexes: [0]` for that single call.

| Account | Pubkey |
|---|---|
| velocity program (devnet) | `FGXfSBCXqSTkBX6zTQyPo8JbC11pn5DGKYm9MSbLC7P2` |
| token_faucet program | `V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB` |
| admin (State.admin, immutable) | `HL7uposJAPpecWFZQRMXe26ryKauCDYJN56MHqjq6Ypi` |
| dUSDT mint (6 dec, **reused** from prior deploy) | `8FfvSRKMZRDHrCBy142XMUXrKEkXnxDQ4YmJv7xbAw8Q` |
| token_faucet config PDA (unchanged) | `A5pgLYFVj2oNeZX3Bqi8jCnxNkLPzUNJCnNVisqcuth7` |
| token_faucet mint authority PDA (unchanged) | `DgqYwE7MdWhTFWwN1heNsbuZE5AxxzozQvNFe6tpJFqB` |
| State | `F5yjMkHa2wAXagYifsjZp8WvjvKGNshRAcWd684agqcp` |
| AmmCache | `4TqNgTNPS26vhDxp94eVR4iD9QSaEvbVELJUVqoqd22c` |
| SpotMarket 0 (dUSDT) | `H4UqRQuYXBbfPyiADFsWwRhajS7Jpwu3zyYwFn47GXC4` |
| PythLazerOracle (feed 6, SOL/USD) | `57ZE6W8mGWPQokUHjyfTAexvVLK8xuMbWn9HGg6fG7oW` |
| PerpMarket 0 (SOL-PERP) | **NOT INITIALIZED** (Phase D skipped); derived PDA is `AnT1Xu3RG9GyuGzhsxKQqYgLRupSbTNkangaLqeLziSg` |
| ProtocolIfSharesTransferConfig | **NOT INITIALIZED** (Phase E skipped); derived PDA is `6ShCZHgnucuaHEQ4MZjzbVqTvubamc9sjMwQhzXDLZFA` |
| LP pool (id=1) | `GLybnswR5113ZU2XHomrEjZn8N8oYUhYaLgEcmmXvwGv` |
| LP pool mint | `GLMY6Wq1KYdViKhoLV2okMf3yrfzrvaRhLVNZ4m2AjJo` |
| Constituent (pool=1, spot=0) | `7wVMDLArAzW6bMtr8dg9LgR9htjZrusQXD2AwyLGbL9J` |
| ProtectedMakerModeConfig | `FHGkB8K79obtnuKpe2hfsEbmRtaK1RnxM1odJbWmoQ8C` |

SDK constants patched: `sdk/src/config.ts` adds `VELOCITY_DEVNET_PROGRAM_ID` and points `configs.devnet.VELOCITY_PROGRAM_ID` at it; `sdk/src/constants/perpMarkets.ts` `DevnetPerpMarkets[0].oracle` updated to the new Lazer PDA. `QUOTE_MINT_ADDRESS` and `DevnetSpotMarkets[0].mint` are unchanged (mint reused).
