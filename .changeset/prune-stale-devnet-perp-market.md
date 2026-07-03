---
"@velocity-exchange/sdk": patch
---

Remove the stale `FettyRIP` (marketIndex 2) entry from `DevnetPerpMarkets`. That perp market was deleted on-chain, but the hand-maintained devnet config still listed it, so consumers that enumerate all perp markets (keeper-bots-v2, dlob-server) crashed with `Perp market config for 2 not found` when resolving the nonexistent market. The devnet config now mirrors on-chain state (SOL-PERP at index 0 only).
