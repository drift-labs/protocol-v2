# @velocity-exchange/keeper-bots-v2

## 0.2.2

### Patch Changes

- Updated dependencies [[`9854dfa`](https://github.com/velocity-exchange/velocity-v1/commit/9854dfa1c915938fe08495568f262285ffb6c933), [`6d58632`](https://github.com/velocity-exchange/velocity-v1/commit/6d58632540814c739fc3848e4110c2a24547722b), [`3042967`](https://github.com/velocity-exchange/velocity-v1/commit/304296799e8d5b8a6525cb18cfd8398637c00521)]:
  - @velocity-exchange/sdk@0.5.0
  - @velocity-exchange/jit-proxy@0.2.1

## 0.2.1

### Patch Changes

- [#176](https://github.com/velocity-exchange/velocity-v1/pull/176) [`00306b4`](https://github.com/velocity-exchange/velocity-v1/commit/00306b4fba0d7c84fb1c82d3964e15144dc5145f) Thanks [@ChewingGlass](https://github.com/ChewingGlass)! - Vendor the jit-proxy client into the monorepo as `@velocity-exchange/jit-proxy`, ported to Anchor 1.0 and built against `@velocity-exchange/sdk` (replacing the upstream `@drift-labs/jit-proxy`, which was built against `@drift-labs/sdk` and assumed Drift account layouts). This fixes a crash in the JIT maker (`Cannot read properties of undefined (reading 'negative')`) where the jitter read `perpMarketAccount.amm.minOrderSize` — a field Velocity removed from perp markets — when handling a taker account update with an open perp order. The perp dust guard now uses Velocity's layout (no perp min-order-size), and the synthetic `Order` no longer sets the removed `quoteAssetAmount` field. keeper-bots-v2 now consumes the vendored package.

- Updated dependencies [[`dff8a47`](https://github.com/velocity-exchange/velocity-v1/commit/dff8a4754f6b736fed330b2ab4fa5685db4f8159), [`900c07d`](https://github.com/velocity-exchange/velocity-v1/commit/900c07d9da7e106c82fbe65b3d92226d090bdee9), [`8df28ac`](https://github.com/velocity-exchange/velocity-v1/commit/8df28ac6d113760ae4a8cdff4ad438cb25efce2c), [`bafd699`](https://github.com/velocity-exchange/velocity-v1/commit/bafd6990f8322f232d2f0d17042beb0e9c567164), [`00306b4`](https://github.com/velocity-exchange/velocity-v1/commit/00306b4fba0d7c84fb1c82d3964e15144dc5145f)]:
  - @velocity-exchange/sdk@0.4.0
  - @velocity-exchange/jit-proxy@0.2.0

## 0.2.0

### Minor Changes

- [#178](https://github.com/velocity-exchange/velocity-v1/pull/178) [`e3bfa3d`](https://github.com/velocity-exchange/velocity-v1/commit/e3bfa3ddfc39dc12556c45da51516734b3697e83) Thanks [@jonthia-drift](https://github.com/jonthia-drift)! - Added auto account creation for filler multithreaded bot

## 0.1.10

### Patch Changes

- Updated dependencies [[`b7d15b9`](https://github.com/velocity-exchange/velocity-v1/commit/b7d15b970a74d267aeaf20bb644d5344b9aadc61), [`2f6c64d`](https://github.com/velocity-exchange/velocity-v1/commit/2f6c64d54f1146d8e7f9ee4ab556929c6bf8b920), [`3f148f8`](https://github.com/velocity-exchange/velocity-v1/commit/3f148f8b477e4176e11e0660adb0e67dd5163d3b)]:
  - @velocity-exchange/sdk@0.3.0

## 0.1.9

### Patch Changes

- Updated dependencies [[`d3b58ab`](https://github.com/velocity-exchange/velocity-v1/commit/d3b58ab7e3ad33f0e6634ff87e9b150915b3aa13)]:
  - @velocity-exchange/sdk@0.2.6

## 0.1.8

### Patch Changes

- Updated dependencies [[`15073bc`](https://github.com/velocity-exchange/velocity-v1/commit/15073bc0b740b2d1cad471126a00368e72655bd5)]:
  - @velocity-exchange/sdk@0.2.5

## 0.1.7

### Patch Changes

- Updated dependencies [[`4f8e7aa`](https://github.com/velocity-exchange/velocity-v1/commit/4f8e7aaef0e35b190fc0b91cd29314d902d1ccab)]:
  - @velocity-exchange/sdk@0.2.4

## 0.1.6

### Patch Changes

- Updated dependencies [[`ae78769`](https://github.com/velocity-exchange/velocity-v1/commit/ae78769ef58355202c030435c2796ef045fe30a0)]:
  - @velocity-exchange/sdk@0.2.3

## 0.1.5

### Patch Changes

- Updated dependencies [[`022a949`](https://github.com/velocity-exchange/velocity-v1/commit/022a949cb1802171ca57a61260f86c8908f94f34)]:
  - @velocity-exchange/sdk@0.2.2
