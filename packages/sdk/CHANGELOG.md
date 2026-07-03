# @velocity-exchange/sdk

## 0.4.0

### Minor Changes

- [#197](https://github.com/velocity-exchange/velocity-v1/pull/197) [`900c07d`](https://github.com/velocity-exchange/velocity-v1/commit/900c07d9da7e106c82fbe65b3d92226d090bdee9) Thanks [@jordy25519](https://github.com/jordy25519)! - Attach the taker's `RevenueShareEscrow` on perp fills for referred takers. `getFillPerpOrderIx` gains an optional `takerIsReferred` flag; when set (or when the order carries a builder code) the deterministic escrow PDA is added to the fill. This mirrors the on-chain fill gate, which reads `UserStats.referrerStatus` (the `BuilderReferral` bit), so referred takers' fills no longer revert with `UnableToLoadRevenueShareAccount`. `ReferrerMap` gains `isBuilderReferral(authority)` and `mustGetIsBuilderReferral(authority)`, sourcing the bit from the UserStats fetch it already performs.

- [#189](https://github.com/velocity-exchange/velocity-v1/pull/189) [`8df28ac`](https://github.com/velocity-exchange/velocity-v1/commit/8df28ac6d113760ae4a8cdff4ad438cb25efce2c) Thanks [@ChesterSim](https://github.com/ChesterSim)! - Program↔SDK parity fixes from the 2026-07-02 audit: renamed deprecated Switchboard
  OracleSource keys to match the IDL (fixes a decode crash on affected markets), applied
  the $100 initial-margin unrealized-PnL cap, standardized auction/limit prices to order
  tick size across the DLOB, isolated-position handling in bankruptcy/liquidation math,
  corrected MM-oracle validity gating, referrer_status memcmp offset, PerpOperation and
  OrderBitFlag bit values, wired five missing event records into EventSubscriber, fixed
  withdraw-limit divisors, multi-pool margin segregation, referee/builder fee estimation,
  and added AdminClient.updatePauseAdmin plus admin CLI commands for pause-admin rotation
  and fee-pool transfers. Also fixed withdrawFromIsolatedPerpPosition's withdraw-all path:
  it substituted the MIN_I64 sentinel into the instruction's unsigned u64 amount (serializing
  as 2^63, so full withdrawals always failed on-chain with InsufficientCollateral); it now
  clamps the request to the position's deposit plus claimable PnL.

  Follow-up completeness fixes: DLOBSubscriber.getL2/getL3 (and the dlob-server publisher) now
  thread orderTickSize so the public book view is tick-standardized like on-chain; added
  hasIsolatedMarginBankrupt and wired isolated-only bankruptcy detection into keeper resolution
  (isIsolatedPositionBankrupt now guards against non-isolated indices); getMarketFees applies the
  referee discount and calculateFeeForQuoteAmount accepts builder params so both public fee-prediction
  entry points match on-chain; and isFallbackAvailableLiquiditySource now fully mirrors
  amm_fill_gates_ok, adding the market-drawdown and MM-vs-exchange oracle volatility gates.

  Low-risk parity follow-ups: MarginCategory now includes 'Fill' as a single shared type, handled
  across perp margin ratio / unrealized-asset-weight and spot asset/liability weights (the
  integer-averaged midpoint of initial and maintenance, mirroring get_margin_ratio /
  get_asset_weight / get_liability_weight) instead of throwing or returning undefined; the
  worst-tier taker-fee estimate in calculateEntriesEffectOnFreeCollateral now ceil-divides to match
  calculate_taker_fee; MM-oracle validity is computed with the raw exchange confidence (matching
  get_mm_oracle_price_data) while the returned MM price keeps its diff-adjusted confidence; and
  corrected the OracleSourceNum doc (it is an SDK-internal oracle-id encoding, not the on-chain
  Borsh discriminant).

  Visible/breaking API changes in this release: `OracleSource.SWITCHBOARD` /
  `OracleSource.SWITCHBOARD_ON_DEMAND` (and the corresponding `OracleSourceNum` entries) are renamed
  to `DEPRECATED_SWITCHBOARD` / `DEPRECATED_SWITCHBOARD_ON_DEMAND` with no aliases kept for the old
  names; `ContractType.FUTURE` is renamed to `DEPRECATED_FUTURE`; and `FeatureBitFlags.BUILDER_REFERRAL`
  is removed outright, since no such on-chain flag exists. Separately, `getLimitPrice` gained a new
  optional trailing `tickSize` parameter — the existing `fallbackPrice` parameter stays in its original
  4th position, so old 4-argument call sites keep working unchanged.

### Patch Changes

- [#199](https://github.com/velocity-exchange/velocity-v1/pull/199) [`dff8a47`](https://github.com/velocity-exchange/velocity-v1/commit/dff8a4754f6b736fed330b2ab4fa5685db4f8159) Thanks [@jordy25519](https://github.com/jordy25519)! - Add BTC-PERP (index 1) and ETH-PERP (index 2) to `DevnetPerpMarkets`, reflecting the two Pyth-Lazer perp markets re-created on devnet. ETH-PERP uses lazer feed 2 (real ETH price feed).

- [#193](https://github.com/velocity-exchange/velocity-v1/pull/193) [`bafd699`](https://github.com/velocity-exchange/velocity-v1/commit/bafd6990f8322f232d2f0d17042beb0e9c567164) Thanks [@jordy25519](https://github.com/jordy25519)! - Remove the stale `FettyRIP` (marketIndex 2) entry from `DevnetPerpMarkets`. That perp market was deleted on-chain, but the hand-maintained devnet config still listed it, so consumers that enumerate all perp markets (keeper-bots-v2, dlob-server) crashed with `Perp market config for 2 not found` when resolving the nonexistent market. The devnet config now mirrors on-chain state (SOL-PERP at index 0 only).

## 0.3.0

### Minor Changes

- [#172](https://github.com/velocity-exchange/velocity-v1/pull/172) [`b7d15b9`](https://github.com/velocity-exchange/velocity-v1/commit/b7d15b970a74d267aeaf20bb644d5344b9aadc61) Thanks [@0xahzam](https://github.com/0xahzam)! - Decouple solvency-repair from the withdraw pause. The `resolve_perp_pnl_deficit`,
  `resolve_perp_bankruptcy`, and `resolve_spot_bankruptcy` instructions are now gated by a
  new `State.solvencyStatus` bitfield instead of `WithdrawPaused`, so user withdrawals can
  be halted while solvency repair keeps running (or repair can be frozen on its own). Adds
  the `SolvencyStatus` enum, `StateAccount.solvencyStatus`, a `solvencyRepairPaused()`
  helper, `AdminClient.updateSolvencyStatus`, and the `exchange set-solvency-status` admin
  CLI command.

- [#141](https://github.com/velocity-exchange/velocity-v1/pull/141) [`3f148f8`](https://github.com/velocity-exchange/velocity-v1/commit/3f148f8b477e4176e11e0660adb0e67dd5163d3b) Thanks [@ChewingGlass](https://github.com/ChewingGlass)! - Harden the native fast-path admin handlers. The
  `update_amm_spread_adjustment_native` instruction now requires the program
  `State` account: `getUpdateAmmSpreadAdjustmentNativeIx` is now **async** and
  returns a `Promise<TransactionInstruction>` (it derives and appends the state
  account), and its compute-unit budget was raised to cover the on-chain account
  validation. Direct callers must `await` the builder. Two new program error
  codes are surfaced in the IDL: `InvalidNativeStateAccount` (6355) and
  `InvalidNativePerpMarketAccount` (6356).

### Patch Changes

- [#173](https://github.com/velocity-exchange/velocity-v1/pull/173) [`2f6c64d`](https://github.com/velocity-exchange/velocity-v1/commit/2f6c64d54f1146d8e7f9ee4ab556929c6bf8b920) Thanks [@ChesterSim](https://github.com/ChesterSim)! - Fix stale `User` account byte offsets in `memcmp` filters and `OrderSubscriber`.

  The Velocity `User` account is 4496 bytes, but the memcmp filters and the
  `OrderSubscriber` staleness check still used offsets from the older 4376-byte
  layout. As a result `getUserWithOrderFilter()` matched zero accounts, so any
  consumer that bulk-loads users-with-orders (e.g. the DLOB server's
  `OrderSubscriber.fetch()`) loaded no orders and produced an empty order book
  (vAMM-only L2, empty L3). Offsets for `idle`, `hasOpenOrder`, `hasOpenAuction`,
  `poolId`, and `lastActiveSlot` are corrected to match the on-chain layout.

## 0.2.6

### Patch Changes

- [#156](https://github.com/velocity-exchange/velocity-v1/pull/156) [`d3b58ab`](https://github.com/velocity-exchange/velocity-v1/commit/d3b58ab7e3ad33f0e6634ff87e9b150915b3aa13) Thanks [@ChesterSim](https://github.com/ChesterSim)! - Fix account decoder to pass account names as-is instead of capitalizing them. The
  Anchor v1 IDL program constructor already camelCases account names, so the extra
  `capitalize()` call was incorrect and caused decoding failures in the gRPC and
  WebSocket subscribers.

## 0.2.5

### Patch Changes

- [#155](https://github.com/velocity-exchange/velocity-v1/pull/155) [`15073bc`](https://github.com/velocity-exchange/velocity-v1/commit/15073bc0b740b2d1cad471126a00368e72655bd5) Thanks [@ChesterSim](https://github.com/ChesterSim)! - Make the `UserAccountSubscriber` "not subscribed" contract consistent and fix a
  misleading error message. `getUserAccountAndSlot()` now throws `NotSubscribedError`
  when called before `subscribe()` on the gRPC-multi and WebSocket-program subscribers
  too (the WebSocket and polling subscribers already did) — so `User.getUserAccount()`
  uniformly throws when not subscribed and returns `undefined` only when subscribed but
  the account was not found on chain. `getUserAccountOrThrow()` /
  `getUserAccountAndSlotOrThrow()` now throw `User account not found: <pubkey>` (was
  `User account not loaded`), since after `subscribe()` resolves a missing account means
  "not found", not "still loading".

## 0.2.4

### Patch Changes

- [#127](https://github.com/velocity-exchange/velocity-v1/pull/127) [`4f8e7aa`](https://github.com/velocity-exchange/velocity-v1/commit/4f8e7aaef0e35b190fc0b91cd29314d902d1ccab) Thanks [@ChesterSim](https://github.com/ChesterSim)! - reflect Typescript types on IDL changes

## 0.2.3

### Patch Changes

- [#100](https://github.com/velocity-exchange/velocity-v1/pull/100) [`ae78769`](https://github.com/velocity-exchange/velocity-v1/commit/ae78769ef58355202c030435c2796ef045fe30a0) Thanks [@ChesterSim](https://github.com/ChesterSim)! - add back ForwardOnlyTxSender and calculateMaxRemainingDeposit

## 0.2.2

### Patch Changes

- [#97](https://github.com/velocity-exchange/velocity-v1/pull/97) [`022a949`](https://github.com/velocity-exchange/velocity-v1/commit/022a949cb1802171ca57a61260f86c8908f94f34) Thanks [@ChewingGlass](https://github.com/ChewingGlass)! - Re-export `PriceUpdateAccount` from the package root and declare `@types/node` as a devDependency (fixes the SDK build under isolated installs). Enables downstream apps (dlob-server, keeper-bots-v2) to consume the velocity SDK without reaching into subpaths.

## 0.2.1

### Patch Changes

- [`4fd7462`](https://github.com/velocity-exchange/velocity-v1/commit/4fd7462bfa3c55e31e3457b1b65f519cf052a6fa) Thanks [@ChewingGlass](https://github.com/ChewingGlass)! - Testing new changelog based package publishing flow
