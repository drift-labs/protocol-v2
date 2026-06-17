<div align="center">
  <img height="120x" src="https://uploads-ssl.webflow.com/611580035ad59b20437eb024/616f97a42f5637c4517d0193_Logo%20(1)%20(1).png" />

  <h1 style="margin-top:20px;">Keeper Bots for Drift Protocol v2</h1>

  <p>
    <a href="https://docs.drift.trade/tutorial-keeper-bots"><img alt="Docs" src="https://img.shields.io/badge/docs-tutorials-blueviolet" /></a>
    <a href="https://discord.com/channels/849494028176588802/878700556904980500"><img alt="Discord Chat" src="https://img.shields.io/discord/889577356681945098?color=blueviolet" /></a>
    <a href="https://opensource.org/licenses/Apache-2.0"><img alt="License" src="https://img.shields.io/github/license/project-serum/anchor?color=blueviolet" /></a>
  </p>
</div>

# Setting up


This repo has two main branches:

* `master`: bleeding edge, may be unstable, currently running on the `devnet` cluster
* `mainnet-beta`: stable, currently running on the `mainnet-beta` cluster

## Setup Environment

### yaml Config file:

A `.yaml` file can be used to configure the bot setup now. See `example.config.yaml` for a commented example.

Then you can run the bot by loading the config file:
```shell
yarn run dev --config-file=example.config.yaml
```

Here is a table defining the various fields and their usage/defaults:

| Field             | Type   | Description | Default |
| ----------------- | ------ | --- | --- |
| global            | object | global configs to apply to all running bots | - |
| global.endpoint   | string | RPC endpoint to use | - |
| global.wsEndpoint | string | (optional) Websocket endpoint to use | derived from `global.endpoint` |
| global.keeperPrivateKey  | string | (optional) The private key to use to pay/sign transactions | `KEEPER_PRIVATE_KEY` environment variable |
| global.initUser   | bool   | Set `true` to init a fresh userAccount | `false` |
| global.websocket  | bool   | Set `true` to run the selected bots in websocket mode if compatible| `false` |
| global.runOnce    | bool   | Set `true` to run only one iteration of the selected bots | `false` |
| global.debug      | bool   | Set `true` to enable debug logging | `false` |
| global.subaccounts | list  | (optional) Which subaccount IDs to load | `0` |
| enabledBots       | list   | list of bots to enable, matching key must be present under `botConfigs` | - |
| botConfigs        | object | configs for associated bots | - |
| botConfigs.<bot_type> | object | config for a specific <bot_type> | - |


### Install dependencies

Run from repo root to install all npm dependencies:
```shell
yarn install
yarn build
```


## Initialize User

A `ClearingHouseUser` must be created before interacting with the `ClearingHouse` program.

```shell
yarn run dev --init-user
```

Alternatively, you can put the private key into a browser wallet and use the UI at https://app.drift.trade to initialize the user.

## Collateral

Some bots (i.e. trading, liquidator and JIT makers) require collateral in order to keep positions open, a helper function is included to help with depositing collateral.
A user must be initialized first before collateral may be deposited.

```shell
# deposit 10,000 USDC
yarn run dev --force-deposit 10000
```

Alternatively, you can put the private key into a browser wallet and use the UI at https://app.drift.trade to deposit collateral.

Free collateral is what is determines the size of borrows and perp positions that an account can have. Free collateral = total collateral - initial margin requirement. Total collateral is the value of the spot assets in your account + unrealized perp pnl. The initial margin requirement is the total weighted value of the perp positions and spot liabilities in your account. The initial margin requirement weights are determined [here](https://docs.drift.trade/cross-collateral-deposits). In simple terms, free collateral is essentially the amount of total collateral that is not being used up by borrows and existing perp positions and open orders.


# Run Bots

After creating your `config.yaml` file as above, run with:
  
```shell
yarn run dev --config-file=config.yaml
```

By default, some [Prometheus](https://prometheus.io/) metrics are exposed on `localhost:9464/metrics`.

# Notes on some bots

## Filler Bot

Include `filler` and/or `spotFiller` under `.enabledBots` in `config.yaml`. For a lightweight version
of a filler bot for perp markets, include `fillerLite` rather than `filler` in `config.yaml`. The lighter 
version of the filler can be run on public RPCs for testing, but is not as stable.

Read the docs: https://docs.drift.trade/keepers-and-decentralised-orderbook

Fills (matches) crossing orders on the exchange for a small cut of the taker fees. Fillers maintain a copy of the DLOB to look
for orders that cross. Fillers will also attempt to execute triggerable orders. 

### Common errors

When running the filler bots, you might see the following error codes in the transaction logs on a failed in pre-flight simulation:

#### For perps

| Error             | Description |   
| ----------------- | ------ |
| OrderDoesNotExist | Outcompeted: Order was already filled by someone else|
| OrderNotTriggerable | Outcompeted: order was already triggered by someone else |
| RevertFill |  Outcompeted: order was already filled by someone else|


#### Other messages

| Message | Description |
| --------|--------------|
| filler last active slot != current slot | You might see this when outcompeted on a fill. The *filler last active slot* was the last slot that the filler had a successful fill in, so it may diverge *current slot* if the filler has not placed a successful order.


## Liquidator Bot

The liquidator bot monitors spot and perp markets for bankrupt accounts, and attempts to liquidate positions according to the protocol's [liquidation process](https://docs.drift.trade/liquidators).

### Notes on derisking
You may also set `disableAutoDerisking` to `true`, to disable the derisking loop. You may want to do this as part of a larger strategy
where you are ok with taking on risk at a favorable to market price (liquidation fee applied).

### Notes on configuring subaccount

By default the liquidator will attempt to liqudate (inherit the risk of)
endangered positions in all markets. Set `botConfigs.liquidator.perpMarketIndicies` and/or `botConfigs.liquidator.spotMarketIndicies`
in the config file to restrict which markets you want to liquidate. The
account specified in `global.subaccounts` will be used as the active
account.

`perpSubaccountConfig` and `spotSubaccountConfig` can be used instead
of `perpMarketIndicies` and `spotMarketIndicies` to specify a mapping
from subaccount to list of market indicies. The value of these 2 fields
are json strings:

### An example `config.yaml`
```
botConfigs:
  ...
  liquidator:
    ...
    perpSubAccountConfig:
      0:
        - 0
        - 1
        - 2
      1:
        - 3
        - 4
        - 5
        - 6
        - 7
        - 8
        - 9
        - 10
        - 11
        - 12
    spotSubAccountConfig:
      0:
        - 0
        - 1
        - 2
```
Means the liquidator will liquidate perp markets 0-2 using subaccount 0, perp markets 3-12 using subaccount 1, and spot markets 0-2 using subaccount 0. It will also use jupiter to derisk spot assets into USDC. Make sure that for all subaccounts specified in the botConfigs, that they are also listed in the global configs. So for the above example config:

```
global:
  ...
  subaccounts: [0, 1]
```

### Common errors

When running the liquidator, you might see the following error codes in the transaction logs on a failed in pre-flight simulation:

| Error             | Description |   
| ----------------- | ------ |
| SufficientCollateral | The account you're trying to liquidate has sufficient collateral and can't be liquidated |
| InvalidSpotPosition | Outcompeted: the liqudated account's spot position was already liquidated. |
| InvalidPerpPosition | Outcompeted: the liqudated account's perp position was already liquidated. |

## Jit Maker

The jit maker bot supplies liquidity to the protocol by participating in jit acutions for perp markets. Before running a jit maker bot, be sure to read the documentation below:

Read the docs on jit auctions: https://docs.drift.trade/just-in-time-jit-auctions

Read the docs on the jit proxy client: https://github.com/drift-labs/jit-proxy/blob/master/ts/sdk/Readme.md

Be aware that running a jit maker means taking on positional risk, so be sure to manage your risk properly!

### Implementation 

This sample jit maker uses the jit proxy client, and updates ```JitParams``` for the markets specified in the config. The bot will update its bid and ask to match the current top level market in the DLOB, and specifies its maximum position size to keep leverage at 1. The jit maker will attempt to fill taker orders that cross its market that's specified in the ```JitParams```. If the current auction price does not cross the bid/ask the transaction will fail during pre-flight simulation, because for the purposes of the jit proxy program, the market is considered the market maker's worst acceptable price of execution. For order execution, the jit maker currently uses the ```JitterSniper``` -- read more on the jitters and different options in the jit proxy client documentation (link above). 

This bot is meant to serve as a starting off point for participating in jit auctions. To increase strategy complexity, consider different strategies for updating your markets. To change the amount of leverage, change the constant ```TARGET_LEVERAGE_PER_ACCOUNT``` before running.

### Common errors

| Error             | Description |   
| ----------------- | ------ |
| BidNotCrossed/AskNotCrossed | The jit proxy program simulation fails if the auction price is not lower than the jit param bid or higher than jit param ask. Bot's market, oracle price, or auction price changed during execution. Can be a latency issue, either slow order submission or slow websocket/polling connection. |
| OrderNotFound | Outcompeted: the taker order was already filled. |

### Running the bot and notes on configs

```jitMaker.config.yaml``` is supplied as an example, and a jit maker can be run with ```yarn run dev --config-file=jitMaker.config.yaml```. Jit maker bots require colleteral, so make sure to specify depositing collateral in the config file using ```forceDeposit```, or deposit collateral using the app or SDK before running the bot. 

To avoid errors being thrown during initialization, remember to enumerate in the global configs the subaccounts being used in the bot configs. An example below in a config.yaml file:

```
global:
  ...
  subaccounts: [0, 1] <----- bot configs specify subaccounts of [0, 1, 1], so make sure we load in [0, 1] in global configs to properly initialize driftClient!


botConfigs:
  jitMaker:
    botId: "jitMaker"
    dryRun: false
    # below, ordering is important: match the subaccountIds to perpMarketindices.
    # e.g. to MM perp markets 0, 1 both on subaccount 0, then subaccounts=[0,0], perpMarketIndicies=[0,1]
    #      to MM perp market 0 on subaccount 0 and perp market 1 on subaccount 1, then subaccounts=[0, 1], perpMarketIndicies=[0, 1]
    # also, make sure all subaccounts are loaded in the global config subaccounts above to avoid errors
    subaccounts: [0, 1, 1] <--------------- the subaccount set should be specified above too!
    perpMarketIndicies: [0, 1, 2]

```
