# Migrating from Drift Protocol v2 to Velocity

This repo is a fork of [`velocity-exchange/protocol-v2`](https://github.com/velocity-exchange/protocol-v2)
(fork point: `0ae3e3b1d`, SDK `v2.163.0-beta.0`, April 2026). The original Drift program is
**paused**; Velocity is an **entirely new program deployment** with a new program ID, a
reduced feature set, and a renamed SDK.

This document tracks everything that changed between the two repos from an integrator's
point of view. It reflects the current state of `master` — every PR referenced below is
**merged**.

---

## 1. At a glance

|                   | Drift (old)                                   | Velocity (new)                                                   |
| ----------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| Program ID        | `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH` | `vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P` (devnet & mainnet) |
| npm package       | `@drift-labs/sdk` `2.163.0-beta.0`            | `@velocity-exchange/sdk` `0.2.x` (version reset)                 |
| Main client class | `DriftClient`                                 | `VelocityClient` — **no back-compat aliases**                    |
| Anchor            | 0.29.0                                        | 1.0 (`@anchor-lang/core@1.0.1`), new IDL format                  |
| IDL               | `drift.json`                                  | `velocity.json`                                                  |
| Rust crate        | `drift` (`programs/drift/`)                   | `velocity` (`programs/velocity/`)                                |
| Package manager   | yarn                                          | bun                                                              |

Because the program ID is new, **every PDA address changes** (seed strings are unchanged,
but the program ID input to derivation is different) and **no on-chain state carries
over** — users, markets, and balances start fresh on Velocity. Anchor account and
instruction discriminators are derived from names, not the program ID, so the
discriminators for surviving accounts/instructions (`User`, `PerpMarket`,
`place_perp_order`, …) are byte-identical to Drift's — but the account **layouts**
behind them changed (see §5), so old decoders must not be pointed at Velocity accounts.

---

## 2. Feature removals

These Drift features do not exist on Velocity. Integrations touching them must be removed
or reworked.

| Feature                                                       | Removed in | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Spot DLOB trading**                                         | #6         | `place_spot_order`, `place_and_take_spot_order`, `place_and_make_spot_order`, `fill_spot_order` deleted. New error `SpotDlobTradingDisabled` (6350). Spot markets still exist for collateral/borrow-lend, but cannot be traded on the order book.                                                                                                                                                                                                                                                                                                                  |
| **External spot fulfillment (Serum / Phoenix / OpenBook v2)** | #36        | All `*_fulfillment_config` instructions and SDK subscribers (`serumSubscriber`, `phoenixSubscriber`, `openbookV2Subscriber`, fulfillment config maps) deleted.                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Fuel (points/incentives)**                                  | #36        | All `*_fuel` instructions, `User.last_fuel_bonus_update_ts`, `PerpMarket.fuel_boost_*`, SDK `math/fuel`, `FuelSeasonRecord`, `FuelSweepRecord` deleted.                                                                                                                                                                                                                                                                                                                                                                                                          |
| **vAMM LP ("BAMM" LP shares)**                                | #36        | `PerpPosition.lp_shares` and friends removed; `LPRecord`/`LPAction` types deleted. Replaced by the new VLP module (§3).                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Protected maker mode**                                      | #38        | All `protected_maker_*` instructions (`update_user_protected_maker_orders`, `update_perp_market_protected_maker_params`, `initialize_protected_maker_mode_config`, `update_protected_maker_mode_config`), the `ProtectedMakerModeConfig` on-chain account (PDA seed `protected_maker_mode_config`), the `UserStatus::ProtectedMakerOrders` bit, and SDK `math/protectedMakerParams` / `math/userStatus` / `getProtectedMakerModeConfigPublicKey` / `AdminClient.initializeProtectedMakerModeConfig` / `updateProtectedMakerModeConfig` / `VelocityClient.updateUserProtectedMakerOrders` deleted. `PerpMarket.protected_maker_*` fields replaced in place by padding; `InvalidProtectedMakerModeConfig` error preserved as a `@deprecated` stub. |
| **High leverage mode**                                        | #2, #47    | `enable_user_high_leverage_mode`, `disable_user_high_leverage_mode`, `initialize_high_leverage_mode_config`, `update_high_leverage_mode_config`, `update_perp_market_high_leverage_margin_ratio` deleted. `User.margin_mode` (a `MarginMode` enum) replaced in place by `padding_former_margin_mode: u8`; the `MarginMode` enum is deleted. `PerpMarket.high_leverage_margin_ratio_initial`/`_maintenance` replaced by `padding_former_hlm: [u8; 4]`. `InvalidHighLeverageModeConfig` / `CouldNotDeserializeHighLeverageModeConfig` renamed to `Deprecated*` stubs (numeric codes preserved). SDK `PollingHighLeverageModeConfigAccountSubscriber` / `WebSocketHighLeverageModeConfigAccountSubscriber` deleted. PR #47 removed the residual `HIGH_LEVERAGE_MIN_MARGIN_RATIO` constant. |
| **Prediction markets**                                        | #13        | `initialize_prediction_market` deleted; `ContractType::Prediction` renamed to `ContractType::DeprecatedPrediction` (discriminant preserved, not reused). `InvalidPredictionMarketOrder` renamed to `DepreciatedPredictionMarketOrder` (code 6284). The SDK `ContractType` no longer exposes a `PREDICTION` static.                                                                                                                                                                                                                                                |
| **Pyth pull/push (legacy)**                                   | #7         | Program instructions `initialize_pyth_pull_oracle`, `update_pyth_pull_oracle`, `post_pyth_pull_oracle_update_atomic`, `post_multi_pyth_pull_oracle_updates_atomic` deleted — keepers posting pull oracle updates must stop calling these. SDK `pythPullClient`, `pythOracleUtils` deleted. `AdminClient.initializePerpMarket` / `initializeSpotMarket` default `oracleSource` changed from `OracleSource.PYTH` to `OracleSource.PYTH_LAZER`. Pyth Lazer is the supported Pyth path. The pull `OracleSource` variants (`PythPull`, `Pyth1KPull`, `Pyth1MPull`, `PythStableCoinPull`) **keep their original names** (marked `@deprecated` in doc-comments only — they were _not_ renamed to `Deprecated*`). |
| **Switchboard oracles**                                       | #14        | Both classic and on-demand removed from SDK (`oracles/switchboardClient`, `oracles/switchboardOnDemandClient`); `OracleSource` discriminants preserved as `Deprecated*`.                                                                                                                                                                                                                                                                                                                                                                                          |
| **Legacy referrer-reward fee path**                           | #67        | Removed the legacy epoch-capped referrer-reward path routed through `UserStats`. Deleted: `UserStats.fees.total_referrer_reward`, `UserStats.fees.current_epoch_referrer_reward`, `UserStats.next_epoch_ts`; `FeeStructure.referrer_reward_epoch_upper_bound` → `padding` (offset/size preserved, IDL field name changed); the `FeatureBitFlags::BuilderReferral` bit and `State.builder_referral_enabled()`; the `MAX_REFERRER_REWARD_EPOCH_UPPER_BOUND` constant. `RevenueShareEscrowAccount` lost four fields (`referrerBoostExpireTs`, `referrerRewardOffset`, `refereeFeeNumeratorOffset`, `referrerBoostNumerator`; `reservedFixed` grew 17→24 bytes). SDK: `referrerInfo?: ReferrerInfo` removed from `placeAndMakePerpOrder`, `placeAndMakeSignedMsgPerpOrders`, `fillPerpOrder` and related ix-builders. Referrer rewards now flow exclusively through the escrow-based path (#73). |
| **Gov-token (DRIFT) stake fee discount**                      | #80        | Staking the governance token in the spot-market-15 insurance fund no longer grants a fee discount: perp fee tiers are now determined by 30-day volume only. Instructions `update_user_gov_token_insurance_stake` and `update_delegate_user_gov_token_insurance_stake` deleted; `UserStats.if_staked_gov_token_amount` replaced by padding. Spot market 15 has no special treatment anymore (the gov-specific IF revenue-settle APR cap was removed; the general cap applies).                                                                                       |
| **Protocol-owned insurance fund shares & IF rebalance**       | #75        | The IF is 100% staker-owned. Deleted: `admin_withdraw_from_insurance_fund_vault`, `transfer_protocol_if_shares_to_revenue_pool`, `begin/end_insurance_fund_swap`, `initialize/update_if_rebalance_config`, `initialize/update_protocol_if_shares_transfer_config`, `deposit_into_insurance_fund_stake`, the `IfRebalanceConfig` / `ProtocolIfSharesTransferConfig` accounts, and `HotRole::IfRebalance` (+ `State.hot_if_rebalance`). `InsuranceFund.total_factor`/`user_factor` are replaced by a single `if_fee_factor` (lending-yield carveout to stakers). Protocol revenue no longer flows through IF shares at all. |

## 3. Feature additions

| Feature                                          | Added in       | Integrator impact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **VLP module** (`programs/velocity/src/vlp/`)    | #65, #66       | New AMM + hedge architecture. `PerpMarket` gains `hedge_config: HedgeConfig` and `market_stats: MarketStats`. The five flat LP-pool config fields on `PerpMarketAccount` (`lpPoolId`, `lpStatus`, `lpPausedOperations`, `lpFeeTransferScalar`, `lpExchangeFeeExcluscionScalar`) were replaced by a single `hedgeConfig` sub-object (`{ poolId, status, pausedOperations, exchangeFeeExclusionScalar, feeTransferScalar }`).                                                                                                                                                                                                                                                                                                                                                                       |
| **Tiered admin keys**                            | #36, #63       | `State.admin` replaced by cold/warm/hot key model (`cold_admin`, `warm_admin`, `hot_*` keys). Anyone reading `State.admin` directly must update. In #76, `update_spot_market_oracle` and `update_spot_market_expiry` were promoted from warm-admin to cold-admin-only (swapping an oracle re-prices the withdraw-guard notional cap).                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Native fast-path entrypoint**                  | fork; #63      | Keeper instructions with discriminator `[0xFF, 0xFF, 0xFF, 0xFF, opcode]` bypass Anchor dispatch (e.g. MM oracle update = opcode 0). These do not appear in the IDL. Inherited from the Drift fork; #63 refactored the native admin handlers to a zero-copy struct cast. The handlers now re-establish Anchor's account guarantees before trusting any byte: `State` and `PerpMarket` are loaded via `AccountLoader` (program ownership + discriminator) and the slot comes from the `Clock` sysvar (see the `native-path` change-log row).                                                                                                                                                                                                                                                                |
| **`transfer_deposit_by_delegate` + `update_user_allow_delegate_transfer`** | #45 | Delegates can transfer spot deposits between subaccounts once the authority opts in. Before a delegate can call `transfer_deposit_by_delegate`, the owner must call `update_user_allow_delegate_transfer(true)` to set the `AllowDelegateTransfer` bit in `UserStats.delegate_permissions`. SDK: `VelocityClient.updateUserAllowDelegateTransfer(...)` and `transferDepositByDelegate(...)`. `UserStatsAccount` gains a `delegatePermissions: number` field (1 byte carved from trailing padding; size and all other offsets unchanged at 240 bytes).                                                                                                                                                                                                                                              |
| **`transfer_fee_and_pnl_pool`**                  | #1             | Admin instruction to rebalance tokens between a perp market's AMM fee pool and PnL pool (same or cross-market). Requires the **warm admin** key. SDK: `AdminClient.transferFeeAndPnlPool(perpMarketIndexWithFeePool, perpMarketIndexWithPnlPool, amount, direction)` and `getTransferFeeAndPnlPoolIx(...)`. Direction via the new `TransferFeeAndPnlPoolDirection` export (`.FEE_TO_PNL_POOL` / `.PNL_TO_FEE_POOL`). Emits a `TransferFeeAndPnlPoolRecord` event (`ts`, `slot`, `perp_market_index_with_fee_pool`, `perp_market_index_with_pnl_pool`, `direction`, `amount`).                                                                                                                                                                                                                       |
| **Funding rate clamp + floor increase**          | #12            | Funding floor raised from 7.3% to 10.95% annualized (`FUNDING_RATE_OFFSET_DENOMINATOR` 5000 → 3333). Dead-zone clamp added: when `\|mark_twap − oracle_twap\| ≤ 0.05%` of oracle price (`FUNDING_RATE_CLAMP_DENOMINATOR = 2000`), the funding premium is suppressed to the offset-only floor value. Changes funding dynamics vs Drift for low-divergence markets. (Superseded by the per-market continuous dead zone in #94.)                                                                                                                                                                                                                                                                                                                                                                    |
| **Continuous funding dead zone (per-market)**    | #94            | Replaces #12's global hard cutoff with a per-market continuous ramp. Two new `AMM` fields (occupying the 8 bytes previously `_padding_funding_twap`): `funding_clamp_threshold: u32` (noise band, BPS_PRECISION; default 5 bps) and `funding_ramp_slope: u32` (PERCENTAGE_PRECISION; default 1.0×). New admin instruction `update_perp_market_funding_dead_zone(funding_clamp_threshold, funding_ramp_slope)`; SDK `AdminClient.updatePerpMarketFundingDeadZone(...)` / `getUpdatePerpMarketFundingDeadZoneIx(...)`. `PerpMarketAccount` gains `fundingClampThreshold` / `fundingRampSlope` (replacing `paddingFundingTwap`). `PerpMarket` size unchanged (1304).                                                                                                                                |
| **MM oracle validation**                         | #60            | Slot-monotonicity, minimum 2-slot gap, and a 1% per-write step cap added to the existing MM oracle native handler.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Special user status**                          | #17            | New `User.special_user_status: u8` bitmask field (replaces 1 byte of padding; account size unchanged); new `SpecialUserStatus` SDK enum (`VammHedger = 1`). Two new instructions: `update_special_user_status(status)` (admin/hot-wallet — `AdminClient.updateSpecialUserStatus` / `getUpdateSpecialUserStatusIx`) and `special_transfer_perp_position_to_vamm(market_index, amount)` (user-callable, authority signs, only when `special_user_status == VammHedger` — `VelocityClient.specialTransferPerpPositionToVamm` / `getSpecialTransferPerpPositionToVammIx`). New error `InvalidTransferPerpPosition` (6312).                                                                                                                                                                            |
| **Builder codes**                                | #68            | Optional `builder_idx` / `builder_fee_tenth_bps` on `OrderParams`; new `change_approved_builder` instruction and `RevenueShareEscrow` account. Existing order placements are unaffected (fields are optional).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Revenue-share fill enforcement**               | #68, #73       | Perp fills fail with `UnableToLoadRevenueShareAccount` (6324 / `0x18b4`) unless the taker's `RevenueShareEscrow` is passed in remaining accounts when (a) the taker order carries a builder code, or (b) the taker's `UserStats.referrer_status` has the `BuilderReferral` bit (escrow exists with a referrer). Liquidation fills and the feature-flag-off state are exempt. Fillers must attach the escrow for any taker that has one with a referrer — see §4.4. Referral rewards also no longer accrue (and referral slots are no longer created) for escrows without a referrer.                                                                                                                                                                                                              |
| **Funding bias spread widening**                 | #77            | New `AMM.funding_bias_sensitivity` field widens the vAMM's paying-side spread while it pays funding, up to `1 + sensitivity/100` at the funding offset floor. New admin instruction `update_perp_market_funding_bias_sensitivity`; SDK gains `AdminClient.updatePerpMarketFundingBiasSensitivity`. Default 0 = off, no quote change until enabled. Alongside this, `last_funding_oracle_twap` moved from `PerpMarket` to `MarketStats` (carved out of `MarketStats.padding`); the old `PerpMarket` slot became `_padding_funding_twap` and was later repurposed as the live `funding_clamp_threshold` + `funding_ramp_slope` fields by #94 — all offsets and sizes are unchanged and existing accounts need no migration. SDK: `PerpMarketAccount.lastFundingOracleTwap` is now `marketStats.lastFundingOracleTwap`. |
| **Withdraw guard notional cap**                  | #76            | `update_withdraw_guard_threshold` now requires the spot market's `oracle` account and rejects any threshold worth more than $10k notional (`MAX_WITHDRAW_GUARD_THRESHOLD_NOTIONAL`, priced at the max of live price and 5-min TWAP). New error `WithdrawGuardThresholdNotionalTooLarge` (6352 / `0x18D0`). SDK `AdminClient.updateWithdrawGuardThreshold(spotMarketIndex, withdrawGuardThreshold, oracle?)` / `getUpdateWithdrawGuardThresholdIx(...)` gain an optional trailing `oracle?` (auto-resolved from the subscription cache or on-chain when omitted; manual instruction construction must include it).                                                                                                                                                                                  |
| **`VelocityCore` SDK module**                    | #21            | Subscription-free instruction-building API (`packages/sdk/src/core/`, exported via `export * from './core'`). Static helpers for PDAs, account decoding, remaining-accounts construction, signed-msg helpers, and pure instruction builders for deposit / withdraw / orders / fill / trigger / settlement / perp liquidation / place-cancel-modify / funding-rate updates — without a subscribed `VelocityClient`. See §4.5.                                                                                                                                                                                                                                                                                                                                                                    |
| **Vaults program + SDK**                         | #83, #85       | The drift-vaults program and its TS client are now first-party in this repo: the `vaults` program (`programs/vaults/`, ID `vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR`) and the `@velocity-exchange/vaults-sdk` package (`packages/vaults-sdk/`). Renames vs upstream drift-vaults: Rust crate/dir `drift_vaults` → `vaults`; the CPI dep on the core program resolves by its real crate name `velocity` (not the `drift` alias); SDK type `DriftVaults` → `Vaults`; IDL `drift_vaults.json` → `vaults.json` (generated from the program via `bun run program:idl:vaults`, never hand-edited). The program ID is unchanged.                                                                                                                                                                       |
| **Fee redesign + AMM isolation**                 | #75            | Explicit per-fill three-way fee split (`FeeStructure.amm_fee_numerator` / `if_fee_numerator`; protocol = residual). Per-market `PerpMarket.fee_ledger: FeeLedger` tracks gross fees + pending carveouts. Protocol fees accrue to a withdrawable `protocol_fee_pool` (perp + spot) and exit via `withdraw_protocol_fees_perp/spot` (new `HotRole::FeeWithdraw` key; pays the ATA of `State.protocol_fee_recipient_perp` / `_spot` (separately configurable treasuries), created on demand). Streaming sweep (`sweep_perp_market_fees`, permissionless) materializes carveouts out of the pnl pool; emits `PerpMarketFeeSweepRecord`. The AMM's books contain only its own money — its configurable fee provision is clawed back in bankruptcy as the backstop of last resort. Liquidations gain a `protocol_liquidation_fee` cut (new `protocol_fee` field on liquidation records). New errors `InvalidProtocolFeeRecipient` (6353) / `InsufficientProtocolFees` (6354). Full design doc: [`FEES.md`](../FEES.md). |

---

## 4. SDK surface changes

### 4.1 Package and tooling

```bash
# old
npm install @drift-labs/sdk
# new
npm install @velocity-exchange/sdk
```

- Versioning reset: `2.163.0-beta.0` → `0.x` (changesets manage releases from this repo; release-please was removed).
- Anchor dependency: `@coral-xyz/anchor@0.29.0` → `@anchor-lang/core@1.0.1` (aliased as
  `@coral-xyz/anchor`). The IDL is Anchor-1.0 format and will not load in 0.29 clients.
- **IDL account name casing**: Anchor 1.0 emits camelCase account names in the IDL. Any code
  that passes an account name as a string to a coder method (e.g.
  `program.coder.accounts.decodeUnchecked('PerpMarket', …)`) must change PascalCase →
  camelCase: `'PerpMarket'` → `'perpMarket'`, `'SpotMarket'` → `'spotMarket'`, `'User'` →
  `'user'`, etc.
- Repo tooling moved from yarn to bun (only matters if you build from source).
- Anchor imports inside the SDK go through an isomorphic layer (`sdk/src/isomorphic/anchor`)
  with separate node/browser builds.

### 4.2 Renames (no deprecated aliases — find/replace required)

PR #37 originally shipped `@deprecated` Drift aliases; they have since been **removed**.
The old names no longer exist.

| Old                                         | New                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `DriftClient`                               | `VelocityClient`                                                    |
| `DriftClientConfig`                         | `VelocityClientConfig`                                              |
| `DriftClientSubscriptionConfig`             | `VelocityClientSubscriptionConfig`                                  |
| `DriftEnv`                                  | `VelocityEnv`                                                       |
| `DRIFT_PROGRAM_ID`                          | `VELOCITY_PROGRAM_ID`                                               |
| `DRIFT_ORACLE_RECEIVER_ID`                  | `VELOCITY_ORACLE_RECEIVER_ID` (same pubkey)                         |
| `USDC_MINT_ADDRESS`                         | `QUOTE_MINT_ADDRESS` (#18; devnet value changed to the dUSDT placeholder `GqmEqYsy8EyvofDpmtFxK8zhYrgWgNokAtYoduQdL7v6`, mainnet USDC unchanged) |
| `WebSocketDriftClientAccountSubscriber(V2)` | `WebSocketVelocityClientAccountSubscriber(V2)`                      |
| `pollingDriftClientAccountSubscriber`       | `pollingVelocityClientAccountSubscriber`                            |
| `grpcDriftClientAccountSubscriber(V2)`      | `grpcVelocityClientAccountSubscriber(V2)`                           |
| `Program<Drift>`                            | `Program<Velocity>` (alias `VelocityProgram`)                       |

### 4.3 Removed exports

Importing any of these now fails at build time:

`math/fuel`, `serum/*`, `phoenix/*`, `openbook/*`, `oracles/pythPullClient`,
`oracles/switchboardClient`, `oracles/switchboardOnDemandClient`, `util/pythOracleUtils`,
`math/userStatus`, `math/protectedMakerParams`,
`accounts/*HighLeverageModeConfigAccountSubscriber`, `util/tps` (and its `estimateTps`
helper), `getProtectedMakerModeConfigPublicKey`,
`AdminClient.initializeProtectedMakerModeConfig` / `updateProtectedMakerModeConfig`,
`VelocityClient.updateUserProtectedMakerOrders`,
plus types `LPRecord`, `LPAction`, `FuelSeasonRecord`, `FuelSweepRecord`,
`ProtectedMakerModeConfig`,
`SpotFulfillmentType`, `SpotFulfillmentStatus`, `SpotFulfillmentConfigStatus`.

Config fields `SERUM_V3`, `PHOENIX`, `OPENBOOK`, `SERUM_LOOKUP_TABLE`,
`PYTH_PULL_ORACLE_LOOKUP_TABLE` were dropped from the env config object.

Gov-token stake fee discount removal (#80): `VelocityClient.updateUserGovTokenInsuranceStake`
/ `getUpdateUserGovTokenInsuranceStakeIx`,
`AdminClient.updateDelegateUserGovTokenInsuranceStake` /
`getUpdateDelegateUserGovTokenInsuranceStakeIx`, and constants
`GOV_SPOT_MARKET_INDEX` and `MAX_APR_PER_REVENUE_SETTLE_TO_INSURANCE_FUND_VAULT_GOV`
(the `constants/insuranceFund` module) were removed.

Dead-export cleanup (#82): the following previously-exported symbols had no consumer
inside the SDK, its tests, or any velocity-exchange org repository and were removed.
The module `tx/forwardOnlyTxSender` was deleted (`ForwardOnlyTxSender` class) —
**but later restored in #89** (see §4.6).
Removed `math` functions: `builderCodesEnabled`, `builderReferralEnabled`,
`calculateAvailablePerpLiquidity`, `calculateBudgetedK` (the non-`BN` variant;
`calculateBudgetedKBN` is unaffected), `calculateCollateralValueOfDeposit`,
`calculateLiquidationPrice` (`calculateLiquidationPriceAfterPerpTrade` is unaffected),
`calculateMaxSpread`, `calculateNewMarketAfterTrade`,
`calculateOraclePriceForPerpMargin`, `calculateOracleReserveSpread`,
`calculatePerpMarketBaseLiquidatorFee`, `calculatePositionFundingPNL`,
`calculateUserMaxPerpOrderSize`, `fetchMSolMetrics`, `isOrderReduceOnly`,
`isOrderRiskIncreasing`, `isOrderRiskIncreasingInSameDirection`, `isTakingOrder`,
`trimVaaSignatures`. Also removed: `memcmp` helper `getUserThatHasBeenLP`, constants
`MAX_I64` / `TEN_MILLION`, type `MSOL_METRICS_ENDPOINT_RESPONSE`, and the deep-import-only
`PYTH_SOLANA_RECEIVER_IDL` (`pyth/types`). The misspelled constant `PTYH_LAZER_PROGRAM_ID`
was renamed to the correctly-spelled `PYTH_LAZER_PROGRAM_ID`.

(`calculateMaxRemainingDeposit` was in this removal batch but was restored in #89 — see §4.6.)

Legacy referrer migration removal (#149): `VelocityClient.migrateReferrer` /
`getMigrateReferrerIx` were removed. These wrapped the `migrate_referrer` program
instruction, which backfilled `RevenueShareEscrow.referrer` from `UserStats.referrer`
for escrows created before that copy was folded into escrow initialization. The
instruction's entrypoint had already been removed with the legacy referral model, so it
was absent from the IDL and the SDK methods threw at runtime; escrow initialization now
copies the referrer unconditionally, making the migration redundant.

### 4.4 Type-level breaking changes

- **`oraclePriceOffset` is now `BN`** (was `number`) on `Order` and `OrderParams` —
  widened to i64 on-chain in #51. Code passing raw numbers must wrap in `new BN(...)`.
- **`Order.quoteAssetAmount` removed.** This field never existed on the on-chain `Order`
  struct (which only has `quoteAssetAmountFilled`); it was a vestigial SDK-type member that
  the decoder always populated with `0`. The TS `Order` type now matches the IDL. Read
  filled quote from `quoteAssetAmountFilled` instead.
- `PerpMarketAccount`: oracle fields (`oracle`, `oracleSource`, …) moved from `amm.*` to
  the top level; aggregate position/funding stats moved into the market; new
  `marketStats` and `hedgeConfig` sub-structs (the latter replacing the flat `lp*` fields,
  #66); fuel/PMM/HLM/LP fields removed. `lastFundingOracleTwap` now lives at
  `marketStats.lastFundingOracleTwap` (#77); `fundingClampThreshold` / `fundingRampSlope`
  replace `paddingFundingTwap` (#94).
- `PerpPosition`: `lpShares`, `lastQuoteAssetAmountPerLp`, `perLpBase` removed.
- `StateAccount`: single `admin` replaced by the cold/warm/hot key set.
- `UserStatsAccount`: `ifStakedGovTokenAmount` removed (gov-stake fee discount removal, #80);
  `getUserFeeTier` no longer applies a stake-based discount. New `delegatePermissions: number`
  field (#45) — set/cleared by `update_user_allow_delegate_transfer`, gates whether a delegate
  may call `transfer_deposit_by_delegate`.
- `CurveRecord` event → `AmmCurveChanged` (fields changed too).
- **Revenue-share escrow on fills** (#68, #73): `ReferrerStatus` enum gains
  `BuilderReferral = 4`; new `isBuilderReferral(userStats)`, `escrowHasReferrer(escrow)`,
  and `hasBuilderParams(orderParams)` helpers in `math/builder`.
  `fillPerpOrder` / `getFillPerpOrderIx`, `placeAndTakePerpOrder` /
  `getPlaceAndTakePerpOrderIx`, `placeAndMakePerpOrder` /
  `getPlaceAndMakePerpOrderIx`, and `getPlaceAndMakeSignedMsgPerpOrderIxs` accept an
  optional trailing `takerEscrow` (the taker's decoded `RevenueShareEscrowAccount`,
  e.g. from a `RevenueShareEscrowMap`) so the taker's escrow is attached when the
  taker is referred (required by the program's fill-time enforcement — see §3). The
  builders validate `takerEscrow.authority` against the taker's authority. **Note:** #68
  originally took a `revenueShareEscrowMap?: RevenueShareEscrowMap` on
  `placeAndTakePerpOrder` / `getPlaceAndTakePerpOrderIx`; #73 replaced that with the
  decoded `takerEscrow?` — callers passing a map must switch to the decoded escrow account.
  The settle-PnL builders keep their map-based `revenueShareEscrowMap` param.
- **Fee redesign** (#75):
  - `PerpMarketAccount`: `totalExchangeFee` / `totalLiquidationFee` moved into a new
    nested `feeLedger: FeeLedger` (with `pendingProtocolFee`, `pendingIfFee`,
    `ammProtocolFeesReceived`, `pendingAmmProvision`); new `protocolFeePool`,
    `protocolLiquidationFee`, `feePoolBufferTarget` fields.
  - `SpotMarketAccount`: new `protocolFeePool`, `protocolLiquidationFee`,
    `protocolFeeFactor`; `insuranceFund.totalFactor`/`userFactor` → `ifFeeFactor`.
  - `StateAccount`: new `protocolFeeRecipientPerp` / `protocolFeeRecipientSpot`
    (two separately configurable treasury keys, one for perp, one for spot) / `hotFeeWithdraw`;
    `FeeStructure` gains `ammFeeNumerator` / `ifFeeNumerator` (carved from reserved padding).
  - `calculateUpdatedAMM` / `calculateBidAskPrice` / `calculateUpdatedAMMSpreadReserves` /
    `calculateOptimalPegAndBudget` / `calculateNewAmm` dropped their `totalExchangeFee`
    parameter (the AMM no longer has a fee floor).
  - `updatePerpMarketAmmSummaryStats` dropped `excludeTotalLiqFee`.
- **Strict null-checking surfaced on some accessors** (#74/#78, when the SDK turned
  on `"strict": true`). A few public signatures were widened to expose the `undefined`
  the runtime already returned:
  - `DLOBNode.getPrice(...)` now returns `BN | undefined` (was `BN`). It always could
    return `undefined` for orders without a resolvable limit price (e.g. post-auction
    market orders); the type now admits it. A new `getPriceOrThrow(...)` is provided for
    call sites that structurally require a defined price.
  - `BlockhashSubscriber.getLatestBlockHeight()` now returns `number | undefined` (was
    `number`) — `undefined` before any blockhash has been fetched, as the runtime
    already did.
  - `nextRevenuePoolSettleApr(spotMarket, vaultBalance, amount)`'s third positional
    `amount: BN` is now required (was `amount?: BN`); the function always dereferenced it,
    so omitting it already produced `NaN`/threw at runtime.
  - `BasicUserAccountSubscriber.getUserAccountAndSlot()` and
    `BasicUserStatsAccountSubscriber.getUserStatsAccountAndSlot()` now return
    `DataAndSlot<T> | undefined` (was the non-optional `DataAndSlot<T>`), matching the
    `UserAccountSubscriber` / `UserStatsAccountSubscriber` interface — they return
    `undefined` until an account is loaded, as the runtime already did. Relatedly, the
    `{ data, slot }` pair these and the polling subscribers store is now **atomic**: a
    loaded account always carries a real `slot` (`number`, never `undefined`; seeded
    accounts use `0` as an oldest-possible sentinel), so `DataAndSlot.slot` can be relied
    on as defined. `doesAccountExist()` on these subscribers is now a type predicate.
  - `User.getUserAccountAndSlot()` (and `VelocityClient.getUserAccountAndSlot()`) keep
    their `DataAndSlot<UserAccount> | undefined` return — `undefined` until the account
    loads, as the runtime already did. A new `User.getUserAccountAndSlotOrThrow()` is
    provided for call sites that structurally require a loaded account.
  - **`UserAccountSubscriber` "not subscribed" contract is now uniform.** Every
    implementation's `getUserAccountAndSlot()` throws `NotSubscribedError` when called
    before `subscribe()` — the WebSocket and polling subscribers already did, and the
    gRPC-multi and WebSocket-program subscribers now match. Consequently
    `User.getUserAccount()` **throws** when not subscribed and returns `undefined` only
    when subscribed but the account was not found on chain (since `subscribe()` awaits
    the initial fetch, `undefined` means "not found", not "still loading"). The
    `getUserAccountOrThrow()` / `getUserAccountAndSlotOrThrow()` error message changed
    from `User account not loaded: <pubkey>` to `User account not found: <pubkey>`;
    both still propagate `NotSubscribedError` when called before subscribing. Consumers
    that matched on the old message string should update.

### 4.5 New: `VelocityCore` (#21)

A subscription-free instruction-building module (`export * from './core'`) for
integrators who only need to construct instructions (PDAs, remaining accounts, deposit /
withdraw / order / fill / liquidation builders) without running a full subscribed client.

### 4.6 New exports

These public exports were **added** (or restored) relative to the fork point:

- `TransferFeeAndPnlPoolDirection` enum-class (`FEE_TO_PNL_POOL` / `PNL_TO_FEE_POOL`),
  `AdminClient.transferFeeAndPnlPool` / `getTransferFeeAndPnlPoolIx` (#1).
- `SpecialUserStatus` enum (`VammHedger = 1`); `AdminClient.updateSpecialUserStatus` /
  `getUpdateSpecialUserStatusIx`; `VelocityClient.specialTransferPerpPositionToVamm` /
  `getSpecialTransferPerpPositionToVammIx` (#17).
- `VelocityClient.updateUserAllowDelegateTransfer` / `transferDepositByDelegate` (#45).
- `AdminClient.updatePerpMarketFundingDeadZone` / `getUpdatePerpMarketFundingDeadZoneIx` (#94).
- `AdminClient.updatePerpMarketFundingBiasSensitivity` (#77).
- `AdminClient.updateWithdrawGuardThreshold` / `getUpdateWithdrawGuardThresholdIx` gained an
  optional trailing `oracle?` arg (#76).
- `VelocityCore` module (#21, see §4.5).
- **Restored in #89** (had been removed in #82): `ForwardOnlyTxSender` (`tx/forwardOnlyTxSender`)
  and `calculateMaxRemainingDeposit` (`math/spotMarket`).
- `PriceUpdateAccount` is now re-exported from the package root (#97); previously it was only
  reachable via a subpath import.
- Several types were added by the `types.ts` ↔ IDL reconciliation — see §4.7.

### 4.7 SDK type reconciliation (`types.ts` ↔ IDL)

The hand-maintained TypeScript mirrors in `sdk/src/types.ts` are not generated from the IDL
(the SDK does not use Anchor's `IdlAccounts`/`IdlTypes`/`IdlEvents` helpers), and had drifted
from the generated `idl/velocity.json`. This batch realigns them. Integrators who decoded
accounts/events with the previous TS shapes should note:

- **Added fields** (present in the IDL / emitted on-chain all along, missing from the TS type):
  - Account structs: `StateAccount.pauseAdmin` + `lpPoolFeatureBitFlags`; `PerpMarketAccount.poolId`;
    `SpotMarketAccount.expiryTs`; `UserStatsAccount.disableUpdatePerpBidAskTwap` + `pausedOperations`;
    `InsuranceFundStake.lastValidTs`; `AmmCache.bump`;
    `LPPoolAccount.targetOracleDelayFeeBpsPer10Slots` + `targetPositionDelayFeeBpsPer10Slots`.
  - `AMM`: the bid/ask reserve set (`askBaseAssetReserve`, `askQuoteAssetReserve`,
    `bidBaseAssetReserve`, `bidQuoteAssetReserve`), `lastOracleReservePriceSpreadPct`,
    `lastSpreadUpdateSlot`, `longSpread`, `shortSpread`, `referencePriceOffset`.
  - Event/record types: `DepositRecord` (`signer?`, `userTokenAmountAfter`);
    `OrderActionRecord` (`triggerPrice`, `builderIdx`, `builderFee`); `LiquidationRecord` (`bitFlags`);
    `LiquidatePerpRecord` + `LiquidateSpotRecord` (`protocolFee`).
- **Corrected field types** (no on-chain change — the TS type was wrong):
  - `LiquidationRecord.canceledOrderIds`: `BN[]` → `number[]`.
  - `LiquidatePerpRecord.userOrderId` / `liquidatorOrderId`: `BN` → `number`.
  - `OrderFillerRewardStructure.rewardNumerator` / `rewardDenominator`: `BN` → `number`.
  - `RevenueShareSettleRecord.ts`: `number` → `BN`.
- **Removed phantom fields** (never existed on-chain): `LPSwapRecord.outMint` / `inMint`,
  `LPMintRedeemRecord.lpMint`.
- **New exported types**: `PrelaunchOracleParams`, `PythLazerOracle`,
  `UpdatePerpMarketSummaryStatsParams`, `SignedMsgWsDelegatesAccount`, `PerpMarketFeeSweepRecord`,
  `ProtocolFeeWithdrawRecord`, `TransferFeeAndPnlPoolRecord`.

---

## 5. On-chain layout & ABI notes

- **Account discriminators unchanged** for surviving accounts (`User`, `UserStats`,
  `State`, `PerpMarket`, `SpotMarket`, …) — Anchor derives them from the account name.
  Same for surviving instruction discriminators.
- **Layouts changed**: `User` is 4376 → 4496 bytes. `PerpMarket` grew across several PRs:
  1216 → 1240 (#16, Anchor-1.0 16-byte `PoolBalance` alignment), reorganized through the
  AMM decoupling (#65) and `HedgeConfig` addition down to 1224 (#66), then 1224 → 1304
  (#75, embedded `FeeLedger` + protocol fee fields). The current size is **1304 bytes**,
  with u128/i128 fields front-loaded for alignment. Any custom (non-IDL) decoder must be
  rebuilt against `sdk/src/idl/velocity.json`.
- **Error codes are ABI-stable**: removed variants were renamed to `Deprecated*` stubs
  in place (numeric codes preserved); new variants are appended at the end. The tail of the
  enum is now `SpotDlobTradingDisabled` (6350), `InvalidAdminTier` (6351),
  `WithdrawGuardThresholdNotionalTooLarge` (6352), `InvalidProtocolFeeRecipient` (6353),
  `InsufficientProtocolFees` (6354), `InvalidNativeStateAccount` (6355),
  `InvalidNativePerpMarketAccount` (6356). Decode errors by code as before, but expect
  `Deprecated*` names for retired features.
- **PDA seed strings unchanged** (`drift_state`, `user`, `spot_market_vault`, …) — only
  the program ID changed, so all derived addresses differ from Drift's.
- **`UserStats` layout preserved** across the gov-stake fee discount removal (#80) and the
  delegate-permissions addition (#45): `if_staked_gov_token_amount` was replaced in place by
  padding, and `delegate_permissions: u8` (#45) was carved from the trailing padding. The
  account size (240 bytes) and every other field offset are unchanged — existing accounts
  stay valid, but custom decoders must account for the new `delegate_permissions` byte.
  The `update_user_gov_token_insurance_stake` and
  `update_delegate_user_gov_token_insurance_stake` instructions no longer exist.
- **`MarketStatus` discriminants shifted** (#5): the deprecated `FundingPaused`, `AmmPaused`,
  `FillPaused`, `WithdrawPaused` variants were removed, so the surviving variants are now
  `Initialized` (0), `Active` (1), `ReduceOnly` (2), `Settlement` (3), `Delisted` (4) —
  vs Drift's `ReduceOnly` (6), `Settlement` (7), `Delisted` (8). `MarketStatus` is stored
  directly in `PerpMarket.status` / `SpotMarket.status`, so any custom (non-IDL) decoder
  built against the old Drift discriminants will silently misread these states.
- **Oracle support**: Pyth (push), Pyth Lazer, Prelaunch, QuoteAsset. Switchboard is a
  `Deprecated*` enum stub; the legacy Pyth pull variants (`PythPull`, `Pyth1KPull`,
  `Pyth1MPull`, `PythStableCoinPull`) keep their **original** names (not `Deprecated*`).
  All deprecated/removed sources return `InvalidOracle` if used.

---

## 6. Change log vs upstream (merged PRs)

| PR        | Change                                                                                                                                                                                                                                                                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1        | `transfer_fee_and_pnl_pool` instruction (warm-admin); rebalance AMM fee pool ↔ PnL pool. SDK `AdminClient.transferFeeAndPnlPool` / `getTransferFeeAndPnlPoolIx`; new `TransferFeeAndPnlPoolDirection` export; emits `TransferFeeAndPnlPoolRecord` event                                                                                                                       |
| #2, #47   | Remove high leverage mode: instructions, `User.margin_mode`/`MarginMode`, `PerpMarket` HLM fields, HLM config subscribers, `HIGH_LEVERAGE_MIN_MARGIN_RATIO` (#47); error variants → `Deprecated*` stubs                                                                                                                                                                       |
| #5        | `MarketStatus` refactor: extract into own module; remove deprecated `FundingPaused`/`AmmPaused`/`FillPaused`/`WithdrawPaused`; discriminants for `ReduceOnly`/`Settlement`/`Delisted` shift 6/7/8 → 2/3/4                                                                                                                                                                      |
| #6        | Disable spot DLOB trading (`SpotDlobTradingDisabled` = 6350)                                                                                                                                                                                                                                                                                                                  |
| #7        | Remove legacy Pyth pull/push (program instructions + SDK clients); default `oracleSource` → `PYTH_LAZER`                                                                                                                                                                                                                                                                      |
| #12       | Funding floor raised 7.3% → 10.95% annualized (`FUNDING_RATE_OFFSET_DENOMINATOR` 5000 → 3333) + 0.05% dead-zone clamp (`FUNDING_RATE_CLAMP_DENOMINATOR` = 2000)                                                                                                                                                                                                                |
| #13       | Remove prediction markets (`ContractType::Prediction` → `DeprecatedPrediction`; `InvalidPredictionMarketOrder` → `DepreciatedPredictionMarketOrder`, 6284)                                                                                                                                                                                                                    |
| #14       | Remove Switchboard oracle support (classic + on-demand)                                                                                                                                                                                                                                                                                                                       |
| #16       | Anchor 0.29 → 1.0; `PerpMarket::SIZE` 1216 → 1240 (16-byte `PoolBalance` alignment); IDL account names now camelCase (affects string-keyed coder calls)                                                                                                                                                                                                                       |
| #17       | Special user account status: `User.special_user_status` bitmask + `SpecialUserStatus` enum; new `update_special_user_status` (admin) + `special_transfer_perp_position_to_vamm` (user); new error `InvalidTransferPerpPosition` (6312)                                                                                                                                        |
| #18       | SDK quote-mint cleanup: `USDC_MINT_ADDRESS` → `QUOTE_MINT_ADDRESS`; devnet value → dUSDT placeholder, mainnet unchanged                                                                                                                                                                                                                                                       |
| #21       | SDK core (`VelocityCore`) expansion, isomorphic Anchor build, perp instruction delegation                                                                                                                                                                                                                                                                                    |
| #26       | New program ID + devnet deployment                                                                                                                                                                                                                                                                                                                                           |
| #36       | Remove fuel, vAMM LP, Serum/Phoenix orderbooks; add admin commands                                                                                                                                                                                                                                                                                                           |
| #37       | SDK rename Drift → Velocity (aliases since removed)                                                                                                                                                                                                                                                                                                                           |
| #38       | Remove protected maker mode (instructions, `ProtectedMakerModeConfig` account + PDA helper, SDK math/admin/client methods, `PerpMarket` fields)                                                                                                                                                                                                                               |
| #39       | Yarn → Bun                                                                                                                                                                                                                                                                                                                                                                   |
| #45       | `transfer_deposit_by_delegate` + `update_user_allow_delegate_transfer`; `UserStats.delegate_permissions` field (carved from padding, size unchanged)                                                                                                                                                                                                                          |
| #51       | `oracle_price_offset` widened to i64                                                                                                                                                                                                                                                                                                                                         |
| #52–#59   | release-please publishing for SDK (`0.0.x`) — later replaced by changesets                                                                                                                                                                                                                                                                                                    |
| #60       | MM oracle validation — strict slot-monotonicity, min 2-slot gap, and 1% per-write step cap on the existing MM oracle native handler                                                                                                                                                                                                                                          |
| #63       | Zero-copy native admin handlers (refactor of the inherited native fast-path entrypoint)                                                                                                                                                                                                                                                                                      |
| #65       | Decouple AMM from rest of codebase                                                                                                                                                                                                                                                                                                                                           |
| #66       | VLP module (vAMM + hedge): flat `lp*` `PerpMarketAccount` fields restructured into `hedgeConfig`; `PerpMarket::SIZE` → 1224                                                                                                                                                                                                                                                   |
| #67       | Remove legacy referrer-reward fee path (`UserStats` epoch fields, `FeeStructure.referrer_reward_epoch_upper_bound`, `FeatureBitFlags::BuilderReferral`, four `RevenueShareEscrowAccount` fields, SDK `referrerInfo?` params)                                                                                                                                                   |
| #68       | Builder codes on non-swift orders; fill-time enforcement of builder + referral revenue share (escrow required when taker has a builder order or a referred escrow)                                                                                                                                                                                                            |
| #70       | Rebrand program crate drift → velocity                                                                                                                                                                                                                                                                                                                                       |
| #71       | This migration guide                                                                                                                                                                                                                                                                                                                                                         |
| #73       | Enforce referral revenue share at fill time: `fill_perp_order` rejects (`UnableToLoadRevenueShareAccount`) when taker has `BuilderReferral` but no escrow supplied; SDK `placeAndTakePerpOrder` param `revenueShareEscrowMap` → `takerEscrow`                                                                                                                                  |
| #74, #78  | Enable TypeScript `strict` mode in the SDK. No runtime behavior change; a few public accessor signatures widened to expose already-possible `undefined` (`DLOBNode.getPrice`, `BlockhashSubscriber.getLatestBlockHeight`, the basic/polling user(-stats) subscribers' `get…AndSlot()`) and `nextRevenuePoolSettleApr`'s `amount` made required. The user(-stats) subscribers' stored `{ data, slot }` pair is now atomic (§4.4) |
| #75       | Fee redesign (explicit per-fill carveouts, withdrawable protocol fees via `protocolFeeRecipientPerp`/`protocolFeeRecipientSpot`, 100% staker-owned IF) + AMM isolation; `PerpMarket::SIZE` 1224 → 1304; new errors 6353/6354                                                                                                                                                   |
| #76       | Withdraw guard threshold notional cap: `update_withdraw_guard_threshold` now requires an `oracle` account; rejects > $10k notional; new error `WithdrawGuardThresholdNotionalTooLarge` (6352); `update_spot_market_oracle`/`_expiry` promoted to cold admin; SDK `updateWithdrawGuardThreshold` gains optional `oracle?`                                                       |
| #77       | Funding bias spread widening: `AMM.funding_bias_sensitivity` + `update_perp_market_funding_bias_sensitivity` admin ix; `last_funding_oracle_twap` moved `PerpMarket` → `MarketStats` (offset-preserving)                                                                                                                                                                       |
| #80       | Remove gov-token (DRIFT) stake fee discount: gov stake-sync instructions, `UserStats.if_staked_gov_token_amount` (→ padding), gov IF revenue-settle APR cap, `GOV_SPOT_MARKET_INDEX`                                                                                                                                                                                          |
| #82       | Remove 27 unused SDK exports (see §4.3 dead-export cleanup); rename misspelled `PTYH_LAZER_PROGRAM_ID` → `PYTH_LAZER_PROGRAM_ID`                                                                                                                                                                                                                                               |
| #83, #85  | Vendor drift-vaults into the monorepo as the `vaults` program + `@velocity-exchange/vaults-sdk` (renames `drift_vaults` → `vaults`, `DriftVaults` → `Vaults`; CPI dep resolves as `velocity`)                                                                                                                                                                                 |
| #89       | Restore `ForwardOnlyTxSender` (`tx/forwardOnlyTxSender`) and `calculateMaxRemainingDeposit` (`math/spotMarket`) to the SDK public API (both removed in #82)                                                                                                                                                                                                                   |
| #94       | Continuous funding dead zone: per-market `funding_clamp_threshold` + `funding_ramp_slope` (recycle `_padding_funding_twap`) replace #12's global hard cutoff; `update_perp_market_funding_dead_zone` ix; `AdminClient.updatePerpMarketFundingDeadZone`; `PerpMarketAccount.fundingClampThreshold`/`fundingRampSlope` replace `paddingFundingTwap`                              |
| #97       | Re-export `PriceUpdateAccount` from the `@velocity-exchange/sdk` package root; migrate dlob-server + keeper-bots-v2 to the workspace SDK                                                                                                                                                                                                                                       |
| #127 | Reconcile hand-written `sdk/src/types.ts` mirrors with the generated IDL: add previously-missing account/event fields, correct `BN`↔`number` field types, drop phantom (never-on-chain) `*Mint` record fields, export new param/record types (§4.7). No on-chain layout change                                                                                |
| native-path | Harden the native fast-path admin handlers (`update_mm_oracle_native`, `update_amm_spread_adjustment_native`): authenticate against the program-owned `State` account loaded via `AccountLoader` (owner + discriminator), require the market slot to hold a program-owned `PerpMarket` (replaces an unchecked `bytemuck` cast), and read the slot from the `Clock` sysvar instead of a caller-supplied account. New errors `InvalidNativeStateAccount` (6355) / `InvalidNativePerpMarketAccount` (6356). The `update_amm_spread_adjustment_native` ix now requires the `State` account at index 2 (SDK `getUpdateAmmSpreadAdjustmentNativeIx` is now async and adds it) |
| #139      | `transfer_deposit` / `transfer_deposit_by_delegate` now enforce the same admission checks as direct deposit/withdraw: the recipient credit requires active spot-market status for a positive deposit balance (`MarketActionPaused`) and respects `max_token_deposits` (`MaxDeposit`); the source debit honors direct-withdraw's reduce-only cap (`ReduceOnlyWithdrawIncreasedRisk`). Transfers that previously succeeded into a capped/non-active/reduce-only market now revert. No ABI/layout change |
| #149      | Remove the dead `migrate_referrer` program instruction (handler + accounts struct; entrypoint already removed with the legacy referral model, so no IDL/ABI change) and its non-functional SDK wrappers `VelocityClient.migrateReferrer` / `getMigrateReferrerIx` (§4.3)                                                                                       |
| #155 | Uniform `UserAccountSubscriber` "not subscribed" contract: gRPC-multi and WebSocket-program subscribers' `getUserAccountAndSlot()` now throw `NotSubscribedError` before `subscribe()` (matching WebSocket/polling), so `User.getUserAccount()` throws when not subscribed and returns `undefined` only when not found; `getUserAccount(AndSlot)OrThrow` message `User account not loaded` → `User account not found` (§4.4)                                                            |
| #172 | Decouple solvency-repair from withdrawals: new `State.solvency_status` (1 B carved from padding, size unchanged) + `SolvencyStatus` bitflag; `resolve_perp_pnl_deficit`/`resolve_perp_bankruptcy`/`resolve_spot_bankruptcy` now gated by `solvency_repair_not_paused` instead of `WithdrawPaused`; new `update_solvency_status` instruction (cold-admin only); SDK `SolvencyStatus` enum, `StateAccount.solvencyStatus`, `solvencyRepairPaused()` helper, `AdminClient.updateSolvencyStatus` |

---

## 7. Migration checklist

1. **Swap the dependency**: `@drift-labs/sdk` → `@velocity-exchange/sdk`.
2. **Find/replace renames** (§4.2). There are no runtime aliases; TypeScript will surface
   every site as a compile error.
3. **Update the program ID** everywhere it is hardcoded:
   `vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P`.
4. **Re-derive all PDAs / cached addresses.** Nothing derived against the Drift program
   ID is valid on Velocity. User accounts must be re-initialized; balances do not migrate.
5. **Replace the IDL** if you load it yourself: use `sdk/src/idl/velocity.json`
   (Anchor 1.0 format) and an Anchor 1.0 client. Update any string-keyed coder calls to the
   new camelCase account names (§4.1).
6. **Wrap `oraclePriceOffset` values in `BN`.**
7. **Delete integrations with removed features** (§2): spot DLOB orders, Serum/Phoenix/
   OpenBook fulfillment, fuel, LP shares, protected maker, high leverage mode,
   prediction markets, Switchboard/Pyth-pull oracles, gov-token stake fee discount.
8. **Update account decoders/indexers** to the new `User` / `PerpMarket` / `State` /
   `UserStats` layouts and the shifted `MarketStatus` discriminants (§5); discriminators
   match Drift's, so guard by program ID, not discriminator.
9. **Re-test error handling**: codes are stable, but retired codes now decode to
   `Deprecated*` names and new codes exist past the old end of the enum (through 6354).
10. **Adopt builder codes** (optional): approve builders via `changeApprovedBuilder(...)`
    and set `builderIdx` / `builderFeeTenthBps` on `OrderParams`. No action needed if you
    don't use builders. If you are a filler, attach the taker's `RevenueShareEscrow` in
    remaining accounts when the taker has a builder order or a referred escrow (see §3
    fill-time enforcement).
11. **Re-pull the IDL and types** for the fee redesign — `PerpMarket` is now 1304 bytes and
    fee fields live in `feeLedger` (§4.4). IF stakers receive 100% of settled revenue (no
    protocol share mint). If you index fees, the authoritative flow description is
    [`FEES.md`](../FEES.md).
