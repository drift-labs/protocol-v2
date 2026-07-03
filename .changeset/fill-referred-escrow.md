---
"@velocity-exchange/sdk": minor
---

Attach the taker's `RevenueShareEscrow` on perp fills for referred takers. `getFillPerpOrderIx` gains an optional `takerIsReferred` flag; when set (or when the order carries a builder code) the deterministic escrow PDA is added to the fill. This mirrors the on-chain fill gate, which reads `UserStats.referrerStatus` (the `BuilderReferral` bit), so referred takers' fills no longer revert with `UnableToLoadRevenueShareAccount`. `ReferrerMap` gains `isBuilderReferral(authority)` and `mustGetIsBuilderReferral(authority)`, sourcing the bit from the UserStats fetch it already performs.
