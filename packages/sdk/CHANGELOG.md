# @velocity-exchange/sdk

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
