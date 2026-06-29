# @velocity-exchange/sdk

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
