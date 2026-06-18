# Migrating from Drift Protocol v2 to Velocity

This repo is a fork of [`drift-labs/protocol-v2`](https://github.com/drift-labs/protocol-v2)
(fork point: `0ae3e3b1d`, SDK `v2.163.0-beta.0`, April 2026). The original Drift program is
**paused**; Velocity is an **entirely new program deployment** with a new program ID, a
reduced feature set, and a renamed SDK.

This document tracks everything that changed between the two repos from an integrator's
point of view. It reflects the state of `master` plus the open PRs:

- **PR #68** — builder codes on non-swift orders (marked _pending_ below)
- **`fee-arch`** — fee redesign + AMM isolation (marked _pending_ below)

---

## 1. At a glance

|                   | Drift (old)                                   | Velocity (new)                                                   |
| ----------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| Program ID        | `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH` | `vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P` (devnet & mainnet) |
| npm package       | `@drift-labs/sdk` `2.163.0-beta.0`            | `@velocity-exchange/sdk` `0.0.5` (version reset)                 |
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

| Feature | Removed in | Notes |
|---|---|---|
| **Spot DLOB trading** | #6 | `place_spot_order`, `place_and_take_spot_order`, `place_and_make_spot_order`, `fill_spot_order` deleted. New error `SpotDlobTradingDisabled`. Spot markets still exist for collateral/borrow-lend, but cannot be traded on the order book. |
| **External spot fulfillment (Serum / Phoenix / OpenBook v2)** | #36 | All `*_fulfillment_config` instructions and SDK subscribers (`serumSubscriber`, `phoenixSubscriber`, `openbookV2Subscriber`, fulfillment config maps) deleted. |
| **Fuel (points/incentives)** | #36 | All `*_fuel` instructions, `User.last_fuel_bonus_update_ts`, `PerpMarket.fuel_boost_*`, SDK `math/fuel`, `FuelSeasonRecord`, `FuelSweepRecord` deleted. |
| **vAMM LP ("BAMM" LP shares)** | #36 | `PerpPosition.lp_shares` and friends removed; `LPRecord`/`LPAction` types deleted. Replaced by the new VLP module (§6). |
| **Protected maker mode** | #38 | All `protected_maker_*` instructions, `UserStatus::ProtectedMakerOrders` bit, SDK `math/protectedMakerParams` deleted. |
| **High leverage mode** | — | `enable_user_high_leverage_mode` etc. deleted; `User.margin_mode` field removed; SDK high-leverage-mode config subscribers deleted. |
| **Prediction markets** | #13 | `initialize_prediction_market` deleted; `ContractType::Prediction` removed. |
| **Pyth pull/push (legacy)** | #7 | `pythPullClient`, `pythOracleUtils` deleted from SDK. Pyth Lazer is the supported Pyth path. Deprecated `OracleSource` discriminants are preserved (not reused). |
| **Switchboard oracles** | #14 | Both classic and on-demand removed from SDK; `OracleSource` discriminants preserved as `Deprecated*`. |
| **HLM** | #2, #47 | Dead code removed. |
| **Legacy fee path** | #67 | `total_fee_lower_bound` accounting removed. (Superseded again by the fee redesign below — the AMM protocol floor itself is now gone.) |
| **Gov-token (DRIFT) stake fee discount** | — | Staking the governance token in the spot-market-15 insurance fund no longer grants a fee discount: perp fee tiers are now determined by 30-day volume only. Instructions `update_user_gov_token_insurance_stake` and `update_delegate_user_gov_token_insurance_stake` deleted; `UserStats.if_staked_gov_token_amount` replaced by padding. Spot market 15 has no special treatment anymore (the gov-specific IF revenue-settle APR cap was removed; the general cap applies). |
| **Protocol-owned insurance fund shares & IF rebalance** (*pending, `fee-arch`*) | fee-arch | The IF is 100% staker-owned. Deleted: `admin_withdraw_from_insurance_fund_vault`, `transfer_protocol_if_shares_to_revenue_pool`, `begin/end_insurance_fund_swap`, `initialize/update_if_rebalance_config`, `initialize/update_protocol_if_shares_transfer_config`, `deposit_into_insurance_fund_stake`, the `IfRebalanceConfig` / `ProtocolIfSharesTransferConfig` accounts, and `HotRole::IfRebalance` (+ `State.hot_if_rebalance`). `InsuranceFund.total_factor`/`user_factor` are replaced by a single `if_fee_factor` (lending-yield carveout to stakers). Protocol revenue no longer flows through IF shares at all. |

## 3. Feature additions

| Feature | Added in | Integrator impact |
|---|---|---|
| **VLP module** (`programs/velocity/src/vlp/`) | #65, #66 | New AMM + hedge architecture. `PerpMarket` gains `hedge_config: HedgeConfig` and `market_stats: MarketStats`. |
| **Tiered admin keys** | #36, #63 | `State.admin` replaced by cold/warm/hot key model (`cold_admin`, `warm_admin`, `hot_*` keys). Anyone reading `State.admin` directly must update. |
| **Native fast-path entrypoint** | #60, #63 | Keeper instructions with discriminator `[0xFF, 0xFF, 0xFF, 0xFF, opcode]` bypass Anchor dispatch (e.g. MM oracle update = opcode 0). These do not appear in the IDL. |
| **`transfer_deposit_by_delegate`** | #45 | Delegates can transfer deposits between subaccounts. |
| **`transfer_fee_and_pnl_pool`** | #1 | Admin pool rebalancing. |
| **Funding rate clamp** | #12 | Funding-rate price divergence clamped (±3%) — changes funding dynamics vs Drift. |
| **MM oracle validation** | #60 | Slot-gap and step-cap checks on MM oracle updates. |
| **Special user status** | #17 | New `User.special_user_status` field (`SpecialUserStatus::VammHedger`). |
| **Builder codes** | #68 | Optional `builder_idx` / `builder_fee_tenth_bps` on `OrderParams`; new `change_approved_builder` instruction and `RevenueShareEscrow` account. Existing order placements are unaffected (fields are optional). |
| **Funding bias spread widening** (*pending, PR #77*) | #77 | New `AMM.funding_bias_sensitivity` field (consumes one byte of `padding_post_amm`, sizes unchanged) widens the vAMM's paying-side spread while it pays funding, up to `1 + sensitivity/100` at the funding offset floor. New admin instruction `update_perp_market_funding_bias_sensitivity`; SDK gains `AdminClient.updatePerpMarketFundingBiasSensitivity`. Default 0 = off, no quote change until enabled. Alongside this, `last_funding_oracle_twap` moved from `PerpMarket` to `MarketStats` (carved out of `MarketStats.padding`; the old `PerpMarket` slot became `_padding_funding_twap`, so all offsets and sizes are unchanged and existing accounts need no migration). SDK: `PerpMarketAccount.lastFundingOracleTwap` is now `marketStats.lastFundingOracleTwap`. |
| **Revenue-share fill enforcement** | #68 | Perp fills fail with `UnableToLoadRevenueShareAccount` (6324 / `0x18b4`) unless the taker's `RevenueShareEscrow` is passed in remaining accounts when (a) the taker order carries a builder code, or (b) the taker's `UserStats.referrer_status` has the `BuilderReferral` bit (escrow exists with a referrer). Liquidation fills and the feature-flag-off state are exempt. Fillers must attach the escrow for any taker that has one with a referrer — see SDK §4.4. Referral rewards also no longer accrue (and referral slots are no longer created) for escrows without a referrer. |
| **Vaults program + SDK** | monorepo | The drift-vaults program and its TS client are now first-party in this repo: the `vaults` program (`programs/vaults/`, ID `vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR`) and the `@velocity-exchange/vaults-sdk` package (`packages/vaults-sdk/`). Renames vs upstream drift-vaults: Rust crate/dir `drift_vaults` → `vaults`; the CPI dep on the core program resolves by its real crate name `velocity` (not the `drift` alias); SDK type `DriftVaults` → `Vaults`; IDL `drift_vaults.json` → `vaults.json` (generated from the program via `bun run program:idl:vaults`, never hand-edited). The program ID is unchanged. |
| **Fee redesign + AMM isolation** (_pending, `fee-arch`_) | fee-arch | Explicit per-fill three-way fee split (`FeeStructure.amm_fee_numerator` / `if_fee_numerator`; protocol = residual). Per-market `PerpMarket.fee_ledger: FeeLedger` tracks gross fees + pending carveouts. Protocol fees accrue to a withdrawable `protocol_fee_pool` (perp + spot) and exit via `withdraw_protocol_fees_perp/spot` (new `HotRole::FeeWithdraw` key; pays the ATA of `State.protocol_fee_recipient_perp` / `_spot` (separately configurable treasuries), created on demand). Streaming sweep (`sweep_perp_market_fees`, permissionless) materializes carveouts out of the pnl pool; emits `PerpMarketFeeSweepRecord`. The AMM's books contain only its own money — its configurable fee provision is clawed back in bankruptcy as the backstop of last resort. Liquidations gain a `protocol_liquidation_fee` cut (new `protocol_fee` field on liquidation records). Full design doc: [`FEES.md`](../FEES.md). |

---

## 4. SDK surface changes

### 4.1 Package and tooling

```bash
# old
npm install @drift-labs/sdk
# new
npm install @velocity-exchange/sdk
```

- Versioning reset: `2.163.0-beta.0` → `0.0.x` (release-please manages releases from this repo).
- Anchor dependency: `@coral-xyz/anchor@0.29.0` → `@anchor-lang/core@1.0.1` (aliased as
  `@coral-xyz/anchor`). The IDL is Anchor-1.0 format and will not load in 0.29 clients.
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
| `USDC_MINT_ADDRESS`                         | `QUOTE_MINT_ADDRESS` (devnet value changed; mainnet USDC unchanged) |
| `WebSocketDriftClientAccountSubscriber(V2)` | `WebSocketVelocityClientAccountSubscriber(V2)`                      |
| `pollingDriftClientAccountSubscriber`       | `pollingVelocityClientAccountSubscriber`                            |
| `grpcDriftClientAccountSubscriber(V2)`      | `grpcVelocityClientAccountSubscriber(V2)`                           |
| `Program<Drift>`                            | `Program<Velocity>` (alias `VelocityProgram`)                       |

### 4.3 Removed exports

Importing any of these now fails at build time:

`math/fuel`, `serum/*`, `phoenix/*`, `openbook/*`, `oracles/pythPullClient`,
`oracles/switchboardOnDemandClient`, `util/pythOracleUtils`, `math/userStatus`,
`math/protectedMakerParams`, `accounts/*HighLeverageModeConfigAccountSubscriber`,
`util/tps` (and its `estimateTps` helper),
plus types `LPRecord`, `LPAction`, `FuelSeasonRecord`, `FuelSweepRecord`,
`SpotFulfillmentType`, `SpotFulfillmentStatus`, `SpotFulfillmentConfigStatus`.

Config fields `SERUM_V3`, `PHOENIX`, `OPENBOOK`, `SERUM_LOOKUP_TABLE`,
`PYTH_PULL_ORACLE_LOOKUP_TABLE` were dropped from the env config object.

Gov-token stake fee discount removal: `VelocityClient.updateUserGovTokenInsuranceStake`
/ `getUpdateUserGovTokenInsuranceStakeIx`,
`AdminClient.updateDelegateUserGovTokenInsuranceStake` /
`getUpdateDelegateUserGovTokenInsuranceStakeIx`, and constants
`GOV_SPOT_MARKET_INDEX` and `MAX_APR_PER_REVENUE_SETTLE_TO_INSURANCE_FUND_VAULT_GOV`
(the `constants/insuranceFund` module) were removed.

### 4.4 Type-level breaking changes

- **`oraclePriceOffset` is now `BN`** (was `number`) on `Order` and `OrderParams` —
  widened to i64 on-chain in #51. Code passing raw numbers must wrap in `new BN(...)`.
- **`Order.quoteAssetAmount` removed.** This field never existed on the on-chain `Order`
  struct (which only has `quoteAssetAmountFilled`); it was a vestigial SDK-type member that
  the decoder always populated with `0`. The TS `Order` type now matches the IDL. Read
  filled quote from `quoteAssetAmountFilled` instead.
- `PerpMarketAccount`: oracle fields (`oracle`, `oracleSource`, …) moved from `amm.*` to
  the top level; aggregate position/funding stats moved into the market; new
  `marketStats` and `hedgeConfig` sub-structs; fuel/PMM/HLM/LP fields removed.
- `PerpPosition`: `lpShares`, `lastQuoteAssetAmountPerLp`, `perLpBase` removed.
- `StateAccount`: single `admin` replaced by the cold/warm/hot key set.
- `UserStatsAccount`: `ifStakedGovTokenAmount` removed (gov-stake fee discount removal).
  `getUserFeeTier` no longer applies a stake-based discount.
- `CurveRecord` event → `AmmCurveChanged` (fields changed too).
- **Revenue-share escrow on fills** (PR #68): `ReferrerStatus` enum gains
  `BuilderReferral = 4`; new `isBuilderReferral(userStats)`, `escrowHasReferrer(escrow)`,
  and `hasBuilderParams(orderParams)` helpers in `math/builder`.
  `fillPerpOrder` / `getFillPerpOrderIx`, `placeAndTakePerpOrder` /
  `getPlaceAndTakePerpOrderIx`, `placeAndMakePerpOrder` /
  `getPlaceAndMakePerpOrderIx`, and `getPlaceAndMakeSignedMsgPerpOrderIxs` accept an
  optional trailing `takerEscrow` (the taker's decoded `RevenueShareEscrowAccount`,
  e.g. from a `RevenueShareEscrowMap`) so the taker's escrow is attached when the
  taker is referred (required by the program's fill-time enforcement — see §3). The
  builders validate `takerEscrow.authority` against the taker's authority. The
  settle-PnL builders keep their map-based `revenueShareEscrowMap` param.
- **Strict null-checking surfaced on some accessors** (PR #74/#78, when the SDK turned
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

_Pending, `fee-arch`:_

- `PerpMarketAccount`: `totalExchangeFee` / `totalLiquidationFee` moved into a new
  nested `feeLedger: FeeLedger` (with `pendingProtocolFee`, `pendingIfFee`,
  `ammProtocolFeesReceived`, `pendingAmmProvision`); new `protocolFeePool`,
  `protocolLiquidationFee`, `feePoolBufferTarget` fields.
- `SpotMarketAccount`: new `protocolFeePool`, `protocolLiquidationFee`,
  `protocolFeeFactor`; `insuranceFund.totalFactor`/`userFactor` → `ifFeeFactor`.
- `StateAccount`: new `protocolFeeRecipient` / `hotFeeWithdraw`; `FeeStructure` gains
  `ammFeeNumerator` / `ifFeeNumerator` (carved from reserved padding).
- `calculateUpdatedAMM` / `calculateBidAskPrice` / `calculateUpdatedAMMSpreadReserves` /
  `calculateOptimalPegAndBudget` / `calculateNewAmm` dropped their `totalExchangeFee`
  parameter (the AMM no longer has a fee floor).
- `updatePerpMarketAmmSummaryStats` dropped `excludeTotalLiqFee`.

### 4.5 New: `VelocityCore`

A subscription-free instruction-building module (`export * from './core'`) for
integrators who only need to construct instructions (PDAs, remaining accounts, deposit /
withdraw / order / fill / liquidation builders) without running a full subscribed client.

---

## 5. On-chain layout & ABI notes

- **Account discriminators unchanged** for surviving accounts (`User`, `UserStats`,
  `State`, `PerpMarket`, `SpotMarket`, …) — Anchor derives them from the account name.
  Same for surviving instruction discriminators.
- **Layouts changed**: `User` is 4376 → 4496 bytes; `PerpMarket` is 1216 → 1224 bytes
  with substantial field reorganization (u128/i128 fields front-loaded for alignment) —
  and 1224 → 1304 bytes once `fee-arch` lands (embedded `FeeLedger` + protocol fee
  fields). Any custom (non-IDL) decoder must be rebuilt against
  `sdk/src/idl/velocity.json`.
- **Error codes are ABI-stable**: removed variants were renamed to `Deprecated*` stubs
  in place (numeric codes preserved); new variants are appended at the end
  (`InvalidAdminTier`, `SpotDlobTradingDisabled`, …). Decode errors by code as before,
  but expect `Deprecated*` names for retired features.
- **PDA seed strings unchanged** (`drift_state`, `user`, `spot_market_vault`, …) — only
  the program ID changed, so all derived addresses differ from Drift's.
- **`UserStats` layout preserved** after the gov-stake fee discount removal:
  `if_staked_gov_token_amount` was replaced in place by padding, so the account size
  (240 bytes) and every other field offset are unchanged — existing accounts stay valid.
  The `update_user_gov_token_insurance_stake` and
  `update_delegate_user_gov_token_insurance_stake` instructions no longer exist.
- **Oracle support**: Pyth (push), Pyth Lazer, Prelaunch, QuoteAsset. Switchboard and
  legacy Pyth pull are deprecated enum stubs.

---

## 6. Change log vs upstream (merged PRs)

| PR | Change |
|---|---|
| #1 | `transfer_fee_and_pnl_pool` instruction |
| #2, #47 | Remove HLM |
| #5 | `MarketStatus` refactor |
| #6 | Disable spot DLOB trading |
| #7 | Remove legacy Pyth pull/push |
| #12 | Funding clamp + floor increase |
| #13 | Remove prediction markets |
| #14 | Remove Switchboard oracle support |
| #16 | Anchor 0.29 → 1.0 |
| #17 | Special user account status |
| #21 | SDK core expansion, isomorphic Anchor build, perp instruction delegation |
| #26 | New program ID + devnet deployment |
| #36 | Remove fuel, vAMM LP, Serum/Phoenix orderbooks; add admin commands |
| #37 | SDK rename Drift → Velocity (aliases since removed) |
| #38 | Remove protected maker mode |
| #39 | Yarn → Bun |
| #45 | `transfer_deposit_by_delegate` |
| #51 | `oracle_price_offset` widened to i64 |
| #52–#59 | release-please publishing for SDK (`0.0.x`) |
| #60 | MM oracle validation (slot gap, step cap) + native handlers |
| #63 | Zero-copy native admin handlers |
| #65 | Decouple AMM from rest of codebase |
| #66 | VLP module (vAMM + hedge) |
| #67 | Remove legacy fee path |
| #68 | Builder codes on non-swift orders; fill-time enforcement of builder + referral revenue share (escrow required when taker has a builder order or a referred escrow) |
| #70 | Rebrand program crate drift → velocity |
| #71 | This migration guide |
| #77 *(open)* | Funding bias spread widening: `AMM.funding_bias_sensitivity` + `update_perp_market_funding_bias_sensitivity` admin ix; `last_funding_oracle_twap` moved `PerpMarket` → `MarketStats` (offset-preserving) |
| #74, #78 *(open)* | Enable TypeScript `strict` mode in the SDK. No runtime behavior change; a few public accessor signatures widened to expose already-possible `undefined` (`DLOBNode.getPrice`, `BlockhashSubscriber.getLatestBlockHeight`, the basic/polling user(-stats) subscribers' `get…AndSlot()`) and `nextRevenuePoolSettleApr`'s `amount` made required. The user(-stats) subscribers' stored `{ data, slot }` pair is now atomic (`slot` always defined) (§4.4) |
| #80 | Remove gov-token (DRIFT) stake fee discount: gov stake-sync instructions, `UserStats.if_staked_gov_token_amount` (→ padding), gov IF revenue-settle APR cap, `GOV_SPOT_MARKET_INDEX` |
| `fee-arch` _(open)_ | Fee redesign (explicit carveouts, withdrawable protocol fees, 100% staker-owned IF) + AMM isolation |
| `monorepo` _(open)_ | Vendor drift-vaults into the monorepo as the `vaults` program + `@velocity-exchange/vaults-sdk` (renames `drift_vaults` → `vaults`, `DriftVaults` → `Vaults`; CPI dep resolves as `velocity`) |

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
   (Anchor 1.0 format) and an Anchor 1.0 client.
6. **Wrap `oraclePriceOffset` values in `BN`.**
7. **Delete integrations with removed features** (§2): spot DLOB orders, Serum/Phoenix/
   OpenBook fulfillment, fuel, LP shares, protected maker, high leverage mode,
   prediction markets, Switchboard/Pyth-pull oracles.
8. **Update account decoders/indexers** to the new `User` / `PerpMarket` / `State`
   layouts (§5); discriminators match Drift's, so guard by program ID, not discriminator.
9. **Re-test error handling**: codes are stable, but retired codes now decode to
   `Deprecated*` names and new codes exist past the old end of the enum.
10. _(After PR #68 lands)_ optionally adopt builder codes: approve builders via
    `changeApprovedBuilder(...)` and set `builderIdx` / `builderFeeTenthBps` on
    `OrderParams`. No action needed if you don't use builders.
11. _(After `fee-arch` lands)_ re-pull the IDL and types — `PerpMarket` grows to 1304
    bytes and fee fields move into `feeLedger` (§4.4). IF stakers now receive 100% of
    settled revenue (no protocol share mint). If you index fees, the authoritative
    flow description is [`FEES.md`](../FEES.md).
