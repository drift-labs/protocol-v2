# @velocity-exchange/jit-proxy

## 0.2.1

### Patch Changes

- Updated dependencies [[`9854dfa`](https://github.com/velocity-exchange/velocity-v1/commit/9854dfa1c915938fe08495568f262285ffb6c933), [`6d58632`](https://github.com/velocity-exchange/velocity-v1/commit/6d58632540814c739fc3848e4110c2a24547722b), [`3042967`](https://github.com/velocity-exchange/velocity-v1/commit/304296799e8d5b8a6525cb18cfd8398637c00521)]:
  - @velocity-exchange/sdk@0.5.0

## 0.2.0

### Minor Changes

- [#176](https://github.com/velocity-exchange/velocity-v1/pull/176) [`00306b4`](https://github.com/velocity-exchange/velocity-v1/commit/00306b4fba0d7c84fb1c82d3964e15144dc5145f) Thanks [@ChewingGlass](https://github.com/ChewingGlass)! - Vendor the jit-proxy client into the monorepo as `@velocity-exchange/jit-proxy`, ported to Anchor 1.0 and built against `@velocity-exchange/sdk` (replacing the upstream `@drift-labs/jit-proxy`, which was built against `@drift-labs/sdk` and assumed Drift account layouts). This fixes a crash in the JIT maker (`Cannot read properties of undefined (reading 'negative')`) where the jitter read `perpMarketAccount.amm.minOrderSize` — a field Velocity removed from perp markets — when handling a taker account update with an open perp order. The perp dust guard now uses Velocity's layout (no perp min-order-size), and the synthetic `Order` no longer sets the removed `quoteAssetAmount` field. keeper-bots-v2 now consumes the vendored package.

### Patch Changes

- Updated dependencies [[`dff8a47`](https://github.com/velocity-exchange/velocity-v1/commit/dff8a4754f6b736fed330b2ab4fa5685db4f8159), [`900c07d`](https://github.com/velocity-exchange/velocity-v1/commit/900c07d9da7e106c82fbe65b3d92226d090bdee9), [`8df28ac`](https://github.com/velocity-exchange/velocity-v1/commit/8df28ac6d113760ae4a8cdff4ad438cb25efce2c), [`bafd699`](https://github.com/velocity-exchange/velocity-v1/commit/bafd6990f8322f232d2f0d17042beb0e9c567164)]:
  - @velocity-exchange/sdk@0.4.0
