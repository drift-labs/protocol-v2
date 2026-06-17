### Quick Start

Drift Protocol Jit Market Making, offer fee rebates for providing liquidity.

1. create and fund an account on drift protocol

- can experiment using devnet, for mainnet make sure you understand the risks
- see [keeper-bots-v2 readme](https://github.com/drift-labs/keeper-bots-v2#initialize-user)
- or see https://drift-labs.github.io/v2-teacher/#introduction

2. get a private RPC endpoint

- RPC is node to method to send tx to solana validators
- _Recommended_: [Helius Free Tier](https://dev.helius.xyz/dashboard/app)
- more RPC colocation/resources can benefit competitiveness

3. examine `src/bots/jitMaker.ts`

- see/modify the strategy for providing jit liquidity
- default tries to intelligently provide within max leverage of 1x
- optionally can hedge perpetual with spot if available
- optionally set decision criteria on a per user basis

4. update parameters in `jitMaker.config.yaml`

- set the markets willing to provide jit liquidity

5. run strategy

- `yarn run dev --config-file=jitMaker.config.yaml`
- track and monitor to make improvements

6. join discord / open PR

- drift protocol promotes a open and helpful development community
- get technical help, discuss ideas, and make internet friends :D
