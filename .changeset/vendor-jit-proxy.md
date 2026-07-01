---
"@velocity-exchange/jit-proxy": minor
"@velocity-exchange/keeper-bots-v2": patch
---

Vendor the jit-proxy client into the monorepo as `@velocity-exchange/jit-proxy`, ported to Anchor 1.0 and built against `@velocity-exchange/sdk` (replacing the upstream `@drift-labs/jit-proxy`, which was built against `@drift-labs/sdk` and assumed Drift account layouts). This fixes a crash in the JIT maker (`Cannot read properties of undefined (reading 'negative')`) where the jitter read `perpMarketAccount.amm.minOrderSize` — a field Velocity removed from perp markets — when handling a taker account update with an open perp order. The perp dust guard now uses Velocity's layout (no perp min-order-size), and the synthetic `Order` no longer sets the removed `quoteAssetAmount` field. keeper-bots-v2 now consumes the vendored package.
