# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Features

- program: dont check price bands for place order ([#556](https://github.com/drift-labs/protocol-v2/pull/556))

### Fixes

### Breaking

## [2.36.0] - 2023-07-26

### Features

- program: usdt oracle uses pyth stablecoin oracle source

### Fixes

- program: add buffer before limit tif can be expired ([#551](https://github.com/drift-labs/protocol-v2/pull/551))
- ts-sdk: fix abs for dustBaseAssetValue in getPerpPositionWithLPSettle ([#543](https://github.com/drift-labs/protocol-v2/pull/543))
- program: add a fixed buffer margin requirement for lp_shares ([#546](https://github.com/drift-labs/protocol-v2/pull/546))
- program: use fill margin type in fulfill_spot_order
- ts-sdk: add buffer to max leverage for LP contributions

### Breaking

- ts-sdk: account for lp shares in liq price ([#522](https://github.com/drift-labs/protocol-v2/pull/522))
- ts-sdk: getPerpPositionWithLPSettle has flag to account for burn lp share ([#522](https://github.com/drift-labs/protocol-v2/pull/522))

## [2.35.0] - 2023-07-18

### Features

- program: add cancel orders by ids ([#540](https://github.com/drift-labs/protocol-v2/pull/540))
- program: add post only slide for perps ([#541](https://github.com/drift-labs/protocol-v2/pull/541))
- program: allow up to 10000 users

### Fixes

- program: if taker increases free colalteral, check maintenance health ([#538](https://github.com/drift-labs/protocol-v2/pull/538))
- program: improve bid/ask twap update for infrequent trading ([#529](https://github.com/drift-labs/protocol-v2/pull/529))
- sdk: simplify, mirror contract, and write tests for predicting funding rate function ([#529](https://github.com/drift-labs/protocol-v2/pull/529))

### Breaking

## [2.34.0] - 2023-07-11

### Features

### Fixes

- program: include amm jit in base used to calculate price band (([#536](https://github.com/drift-labs/protocol-v2/pull/536)))

### Breaking

## [2.34.0] - 2023-07-11

### Features

- program: safety improvements for swaps (([#528](https://github.com/drift-labs/protocol-v2/pull/528)))
- program: track `total_fee_earned_per_lp` on amm (([#526](https://github.com/drift-labs/protocol-v2/pull/526)))
- program: add additional withdraw/borrow guards around fast utilization changes (([#517](https://github.com/drift-labs/protocol-v2/pull/517)))
- program: new margin type for when orders are being filled (([#518](https://github.com/drift-labs/protocol-v2/pull/518)))
- program: new fill price bands (([#516](https://github.com/drift-labs/protocol-v2/pull/516)))

### Fixes

- program: use emit_stack for place orders (([#533](https://github.com/drift-labs/protocol-v2/pull/533)))
- program: tweaks for setting init asset weight to 0 (([#523](https://github.com/drift-labs/protocol-v2/pull/523)))
- program: add vault invariant to update_spot_market_cumulative_interest ix (([#524](https://github.com/drift-labs/protocol-v2/pull/524)))
- program: check oracles valid in meets_withdraw_margin_requirement if number_of_liabilities > 0
- program: only get quote spot market if user has quote position in validate_spot_margin_trading
- program: fix decrement_open_orders for makers

### Breaking

## [2.33.0] - 2023-06-30

### Features

### Fixes

- program: fix margin calculation of unrealized funding pnl for lps (([#513](https://github.com/drift-labs/protocol-v2/pull/513)))

### Breaking

## [2.32.0] - 2023-06-23

### Features

- ts-sdk: add getMaxSwapAmount (([#488](https://github.com/drift-labs/protocol-v2/pull/488)))
- program: add bulk place orders ix (([#499](https://github.com/drift-labs/protocol-v2/pull/499)))
- ts-sdk: add stakeForMSOL to driftClient (([#500](https://github.com/drift-labs/protocol-v2/pull/500)))
- ts-sdk: driftClient accepts default txParams (([#496](https://github.com/drift-labs/protocol-v2/pull/496)))
- ts-sdk: add method to force inclusion of markets in ix remaining accounts (([#503](https://github.com/drift-labs/protocol-v2/pull/503)))

### Fixes

- program: emit lp records in liquidate_perp (([#498](https://github.com/drift-labs/protocol-v2/pull/498)))
- program: check margin enabled in swaps (([#501](https://github.com/drift-labs/protocol-v2/pull/501)))

### Breaking

- ts-sdk: remove user.getSpotTokenAmount as its a duplicate
- ts-sdk: remove RetrySender dependency on Provider (([#497](https://github.com/drift-labs/protocol-v2/pull/497)))

## [2.31.0] - 2023-06-06

### Features

- program: store if use has open orders/auctions on user account (([#480](https://github.com/drift-labs/protocol-v2/pull/480)))
- program: add user perp lp jit liquidity toward a target base (([#448](https://github.com/drift-labs/protocol-v2/pull/448)))
- ts-sdk: drift client will query rpc to find all markets/oracles if they're not explicitly specified (([#469](https://github.com/drift-labs/protocol-v2/pull/469)))
- ts-sdk: fix client borrow interest rate calculation (([#479](https://github.com/drift-labs/protocol-v2/pull/479)))

### Fixes

- program: fix settle lp position math error for large step sizes (([#473](https://github.com/drift-labs/protocol-v2/pull/473)))

### Breaking

- ts-sdk: user map default excludes idle users (([#471](https://github.com/drift-labs/protocol-v2/pull/471)))

## [2.30.0] - 2023-05-18

### Features

- program: allow up to 7500 subaccounts
- program: allow users to swap on jupiter inside of drift account ([#462](https://github.com/drift-labs/protocol-v2/pull/462))
- ts-sdk: add mSOL spot market ([#467](https://github.com/drift-labs/protocol-v2/pull/467))

### Fixes

### Breaking

## [2.29.0] - 2023-05-12

### Features

- sdk: expose method in account subscriber to change polling frequency

### Fixes

### Breaking

- program: modify_order and modify_order_by_id now expect a ModifyOrderPolicy ([#461](https://github.com/drift-labs/protocol-v2/pull/461))
- program: cancel_order does not fail if order does not exist ([#461](https://github.com/drift-labs/protocol-v2/pull/461))

## [2.28.0] - 2023-05-11

### Features

- program: add precision docs to the state accounts ([#452](https://github.com/drift-labs/protocol-v2/pull/452))

### Fixes

### Breaking

- ts-sdk: driftClient.getTokenAmount now returns negative for borrows ([#452](https://github.com/drift-labs/protocol-v2/pull/452))
- ts-sdk: txSender.sendVersionedTransaction now expects VersionedTransaction ([#452](https://github.com/drift-labs/protocol-v2/pull/452))

## [2.27.0] - 2023-05-02

### Features

- ts-sdk: add SUI perp market ([#453](https://github.com/drift-labs/protocol-v2/pull/453))

### Fixes

### Breaking

## [2.26.0] - 2023-05-02

### Features

- program: use forked version of anchor 0.26.0 that supports large idls ([#451](https://github.com/drift-labs/protocol-v2/pull/451))
- program: add security.txt ([#450](https://github.com/drift-labs/protocol-v2/pull/450))
- program: add L2 and L3 view of DLOB ([#445](https://github.com/drift-labs/protocol-v2/pull/445))
- ts-sdk: new DLOBSubscriber class to keep updated DLOB ([#439](https://github.com/drift-labs/protocol-v2/pull/439))
- program: add support for phoenix spot markets ([#437](https://github.com/drift-labs/protocol-v2/pull/437))
- sdk: ability to add stake from subaccount
- ts-sdk: Add phoenix subscriber ([#444](https://github.com/drift-labs/protocol-v2/pull/444))
- sdk: driftClient allows subscription to delegate accounts; pass includeDelegates or authoritySubaccountMap to constructor/updateWallet ([#432](https://github.com/drift-labs/protocol-v2/pull/432))

### Fixes

- program: check max_token_deposits at the end of fill_spot_order ([#441](https://github.com/drift-labs/protocol-v2/pull/441))
- program: force_cancel_orders only skips position reducing orders
- program: allow amm to pull up to FEE_POOL_TO_REVENUE_POOL_THRESHOLD into fee pool ([#436](https://github.com/drift-labs/protocol-v2/pull/436))
- program: fix modify order trigger condition
- sdk: fix removing unstaked sol
- program: fix math error in settle_revenue_to_insurance_fund for large sizes ([#443](https://github.com/drift-labs/protocol-v2/pull/443))
- program: fix revenue pool corner case for updating last_revenue_withdraw_ts ([#447](https://github.com/drift-labs/protocol-v2/pull/447))

### Breaking

## [2.25.0] - 2023-04-13

### Features

- sdk: add BNB perp market
- program: update to anchor 0.26.0 ([#428](https://github.com/drift-labs/protocol-v2/pull/428))
- program: add modify_order ix ([#422](https://github.com/drift-labs/protocol-v2/pull/422))
- sdk: more accurate calculation of insurance stake value during unstake request ([#426](https://github.com/drift-labs/protocol-v2/pull/426))

### Fixes

- sdk: fix isOracleValid confidenceTooLarge calc ([#425](https://github.com/drift-labs/protocol-v2/pull/425))

- sdk: Remove redundant fetchAccounts in userMap.ts

### Breaking

## [2.24.0] - 2023-04-03

### Features

- program: ability to delete a market that was just initialized ([#413](https://github.com/drift-labs/protocol-v2/pull/413))
- program: revenue pool wont settle to IF if utilization unhealthy ([#402](https://github.com/drift-labs/protocol-v2/pull/402))

### Fixes

- program: add ctx.accounts.insurance_fund_vault.reload()? after vault updates ([#402](https://github.com/drift-labs/protocol-v2/pull/402))

### Breaking

## [2.23.0] - 2023-04-03

### Features

- program: include usdc oracle ([#397](https://github.com/drift-labs/protocol-v2/pull/397))
- ts-sdk: add addAllUsers to DriftClient
- program: program: when checking if user is idle, let balanceType be borrow if scaled balance is 0 ([#397](https://github.com/drift-labs/protocol-v2/pull/397))

### Fixes

### Breaking

## [2.22.0] - 2023-03-23

### Features

- sdk: add isUserBankrupt ([#399](https://github.com/drift-labs/protocol-v2/pull/399))
- program: update revenue pool fund settlement logic ([#398](https://github.com/drift-labs/protocol-v2/pull/398))

### Fixes

- sdk: fix claimable pnl ([#384](https://github.com/drift-labs/protocol-v2/pull/384))
- program: borrow liquidity check accounts for if user has borrow or deposit ([#400](https://github.com/drift-labs/protocol-v2/pull/400))
- program: slightly relax withdraw limits ([#400](https://github.com/drift-labs/protocol-v2/pull/400))
- sdk: filter undefined accounts ([#406](https://github.com/drift-labs/protocol-v2/pull/406))

### Breaking

## [2.21.0] - 2023-03-19

### Features

- program: account for openbook referrer rebate being greater than quote sold ([#394](https://github.com/drift-labs/protocol-v2/pull/394))
- sdk: add sync to UserMap and UserStatsMap ([#395](https://github.com/drift-labs/protocol-v2/pull/395))
- program: revert fill ix ([#391](https://github.com/drift-labs/protocol-v2/pull/391))
- program: flag users as idle on-chain ([#386](https://github.com/drift-labs/protocol-v2/pull/386))

### Fixes

### Breaking

## [2.20.0] - 2023-03-10

### Features

- program: add referrer name account to enforce unique referrer names ([#357](https://github.com/drift-labs/protocol-v2/pull/357))
- program: only let amm fill up to tick above/below user limit price ([#381](https://github.com/drift-labs/protocol-v2/pull/381))
- program: allow multiple makers in fill_perp_order ([#341](https://github.com/drift-labs/protocol-v2/pull/341))
- sdk: add getPerpMarketExtendedInfo to drift client

### Fixes

### Breaking

## [2.19.0] - 2023-03-01

### Features

- program: allow post only to match older taker limit orders ([#378](https://github.com/drift-labs/protocol-v2/pull/378))
- ts-sdk: serum subscriber supports websockets ([#365](https://github.com/drift-labs/protocol-v2/pull/365))
- program: max number of subaccounts to 3000
- program: amm spread logic more consistent across market by using liquidity ratio rather than base asset amount for inventory spread scaling([#374](https://github.com/drift-labs/protocol-v2/pull/374))
- program: add pyth1M/pyth1K as OracleSource ([#375](https://github.com/drift-labs/protocol-v2/pull/375))

### Fixes

### Breaking

## [2.18.0] - 2023-02-24

### Features

- program: account for contract tier in liquidate_perp_pnl_for_deposit ([#368](https://github.com/drift-labs/protocol-v2/pull/368))
- program: simplifications for order fills ([#370](https://github.com/drift-labs/protocol-v2/pull/370))
- program: block atomic fills ([#369](https://github.com/drift-labs/protocol-v2/pull/369))
- program: allow limit orders to go through auction ([#355](https://github.com/drift-labs/protocol-v2/pull/355))
- program: improve conditions for withdraw/borrow guard ([#354](https://github.com/drift-labs/protocol-v2/pull/354))

### Fixes

- ts-sdk: fix resolvePerpBankrupcty to work with all perp market indexes
- ts-sdk: getTokenAmount uses divCeil ([#371](https://github.com/drift-labs/protocol-v2/pull/371))
- program: allow limit orders to have explicit zero auction duration passed in params ([#373](https://github.com/drift-labs/protocol-v2/pull/373))

### Breaking

## [2.17.0] - 2023-02-17

### Features

- program: order params utilize post only enum ([#361](https://github.com/drift-labs/protocol-v2/pull/361))

### Fixes

- program: twap tweaks, update only on new cluster time ([#362](https://github.com/drift-labs/protocol-v2/pull/362))

### Breaking

## [2.16.0] - 2023-02-14

### Features

- sdk: add support for market lookup table ([#359](https://github.com/drift-labs/protocol-v2/pull/359))
- program: tweak calculate_size_premium_liability_weight to have smaller effect on initial margin ([#350](https://github.com/drift-labs/protocol-v2/pull/350))
- ts-sdk: updates for accounting for spot leverage ([#295](https://github.com/drift-labs/protocol-v2/pull/295))
- ts-sdk: added new methods for modifying orders to include spot and more params ([#353](https://github.com/drift-labs/protocol-v2/pull/353))
- ts-sdk: flagged old modifyPerpOrder and modifyPerpOrderByUserOrderId as deprecated

### Fixes

- ts-sdk: DLOB matching logic accounts for zero-price spot market orders not matching resting limit orders
- ts-sdk: new squareRootBN implementation using bit shifting (2x speed improvement)
- program: fix overflow in calculate_long_short_vol_spread ([#352](https://github.com/drift-labs/protocol-v2/pull/352))
- program: dont let users disable margin trading if they have margin orders open
- program: tweaks to fix max leverage order param flag with imf factor ([#351](https://github.com/drift-labs/protocol-v2/pull/351))
- program: improve bid/ask twap calculation for funding rate stability ([#345](https://github.com/drift-labs/protocol-v2/pull/345))
- ts-sdk: fix borrow limit calc ([#356](https://github.com/drift-labs/protocol-v2/pull/356))

### Breaking

## [2.15.0] - 2023-02-07

### Features

- ts-sdk: add aptos

### Fixes

### Breaking

## [2.14.0] - 2023-02-06

### Features

- program: flag to set max leverage for orders ([#346](https://github.com/drift-labs/protocol-v2/pull/346))
- program: do imf size discount for maintainance spot asset weight ([#343](https://github.com/drift-labs/protocol-v2/pull/343))
- ts-sdk: new liquidation price to account for delta neutral strategies ([#340](https://github.com/drift-labs/protocol-v2/pull/340))
- ts-sdk: add txParams to all instructions, bump @solana/web3.js ([#344](https://github.com/drift-labs/protocol-v2/pull/344))

### Fixes

- program: extend time before limit order is considered resting ([#349](https://github.com/drift-labs/protocol-v2/pull/349))
- ts-sdk: improve funding rate prediction
- program: block jit maker orders from cross vamm
- program: cancel_order_by_user_order_id fails if order is not found

### Breaking

## [2.13.0] - 2023-01-31

### Features

- program: perp bankruptcies pay from fee pool before being socialized ([#332](https://github.com/drift-labs/protocol-v2/pull/332))
- ts-sdk: add calculateAvailablePerpLiquidity
- program: enforce min order size when trading against amm ([#334](https://github.com/drift-labs/protocol-v2/pull/334))

### Fixes

- ts-sdk: fix the getBuyingPower calculation
- ts-sdk: improved perp estimated liq price formula ([#338](https://github.com/drift-labs/protocol-v2/pull/338))
- ts-sdk: update methods to account for new leverage formula ([#339](https://github.com/drift-labs/protocol-v2/pull/339))

### Breaking

## [2.12.0] - 2023-01-22

### Features

- program: allow for 2000 users
- program: add resting limit order logic ([#328](https://github.com/drift-labs/protocol-v2/pull/328))
- ts-sdk: add calculateEstimatedSpotEntryPrice
- ts-sdk: add ability to add priority fees ([#331](https://github.com/drift-labs/protocol-v2/pull/331))
- ts-sdk: new calculateEstimatedPerpEntryPrice that accounts for dlob & vamm ([#326](https://github.com/drift-labs/protocol-v2/pull/326))

### Fixes

- program: better rounding for openbook limit price
- program: fix paying fee_pool_delta when filling with open book
- program: bitflags for exchange status ([#330](https://github.com/drift-labs/protocol-v2/pull/330))
- program: update fee calculation for filling against openbook
- program: relax conditions for valid oracle price in fulfill_perp_order
- program: handle fallback price when amm has no liquidity ([#324](https://github.com/drift-labs/protocol-v2/pull/324))
- sdk: add getRestingLimitBids/Asks to DLOB ([#325](https://github.com/drift-labs/protocol-v2/pull/325))
- program: tweak oracle price used for determine_perp_fulfillment_methods

### Breaking

## [2.11.0] - 2023-01-11

### Features

- program: remove canceling market orders with limit price after first fill
- program: try to match against multiple of makers orders ([#315](https://github.com/drift-labs/protocol-v2/pull/316))
- program: limit number of users to 1500
- program: more rigorous risk decreasing check in place_perp_order/place_stop_order

### Fixes

- program: avoid overflow when calculating overflow ([#322](https://github.com/drift-labs/protocol-v2/pull/322))
- ts-sdk: fix user.getUnrealizedPnl to account for lp position
- program: cancel market order for not satisfying limit price only if there was some base asset amount filled

### Breaking

## [2.10.0] - 2023-01-03

### Features

- program: place order returns early if max ts breached ([#317](https://github.com/drift-labs/protocol-v2/pull/317))
- ts-sdk: batch getMultipleAccount calls in bulkAccountLoader ([#315](https://github.com/drift-labs/protocol-v2/pull/315))
- program: add clippy deny for panic, expect and unwrap
- program: add market index offset trait ([#287](https://github.com/drift-labs/protocol-v2/pull/287))
- program: add size trait to accounts and events ([#286](https://github.com/drift-labs/protocol-v2/pull/286))

### Fixes

- program: add access control for spot market updates similar to perp market ([#284](https://github.com/drift-labs/protocol-v2/pull/284))
- ts-sdk: allow websocket subscriber to skip getAccount call to rpc ([#313](https://github.com/drift-labs/protocol-v2/pull/313))
- ts-sdk: always add market account for cancelOrders if market index included
- anchor tests: make deterministic to run in ci ([#289](https://github.com/drift-labs/protocol-v2/pull/289))
- ts-sdk: fix deprecated calls to `@solana/web3.js` ([#299](https://github.com/drift-labs/protocol-v2/pull/307))
- ts-sdk: fix calculateAssetWeight for Maintenance Margin ([#308](https://github.com/drift-labs/protocol-v2/pull/308))
- ts-sdk: fix UserMap for websocket usage ([#308](https://github.com/drift-labs/protocol-v2/pull/310))

### Breaking

## [2.9.0] - 2022-12-23

### Features

- program: use vamm price to guard against bad fills for limit orders ([#304](https://github.com/drift-labs/protocol-v2/pull/304))

### Fixes

- ts-sdk: expect signTransaction from wallet adapters to return a copy ([#299](https://github.com/drift-labs/protocol-v2/pull/299))

### Breaking

## [2.8.0] - 2022-12-22

### Features

- program: add force_cancel_orders to cancel risk-increasing orders for users with excessive leverage ([#298](https://github.com/drift-labs/protocol-v2/pull/298))

### Fixes

- program: fix calculate_availability_borrow_liquidity ([#301](https://github.com/drift-labs/protocol-v2/pull/301))
- program: fix casting in fulfill_spot_order_with_match to handle implied max_base_asset_amounts
- sdk: fix BulkAccountLoader starvation ([#300](https://github.com/drift-labs/protocol-v2/pull/300))

### Breaking

## [2.7.0] - 2022-12-19

### Features

### Fixes

program: more leniency in allowing risk decreasing trades for perps ([#297](https://github.com/drift-labs/protocol-v2/pull/297))
program: fix is_user_being_liquidated in deposit

### Breaking

## [2.6.0] - 2022-12-16

### Features

program: allow keeper to switch user status to active by calling liquidate perp ([#296](https://github.com/drift-labs/protocol-v2/pull/296))

### Fixes

- program: more precise update k in prepeg ([#294](https://github.com/drift-labs/protocol-v2/pull/294))
- program: allow duplicative reduce only orders ([#293](https://github.com/drift-labs/protocol-v2/pull/293))
- program: fix should_cancel_reduce_only_order
- ts-sdk: add Oracle OrderType to dlob idl

### Breaking

## [2.5.0] - 2022-12-13

### Features

### Fixes

- program: disable lower bound check for update amm once it's already been breached ([#292](https://github.com/drift-labs/protocol-v2/pull/292))
- ts-sdk: fix DLOB.updateOrder ([#290](https://github.com/drift-labs/protocol-v2/pull/290))
- ts-sdk: make calculateClaimablePnl mirror on-chain logic ([#291](https://github.com/drift-labs/protocol-v2/pull/291))
- ts-sdk: add margin trading toggle field to user accounts, update toggle margin trading function to add ability to toggle for any subaccount rather than just the active ([#285](https://github.com/drift-labs/protocol-v2/pull/285))

### Breaking

## [2.4.0] - 2022-12-09

### Features

- program: check if place_perp_order can lead to breach in max oi ([#283](https://github.com/drift-labs/protocol-v2/pull/283))
- program: find fallback maker order if passed order id doesnt exist ([#281](https://github.com/drift-labs/protocol-v2/pull/281))

### Fixes

- program: fix amm-jit so makers can fill the full size of their order after amm-jit occurs ([#280](https://github.com/drift-labs/protocol-v2/pull/280))

### Breaking

## [2.3.0] - 2022-12-07

### Features

### Fixes

- program: update the amm min/max_base_asset_reserve upon k decreases within update_amm ([#282](https://github.com/drift-labs/protocol-v2/pull/282))
- program: fix amm-jit erroring out when bids/asks are zero ([#279](https://github.com/drift-labs/protocol-v2/pull/279))
- ts-sdk: fix overflow in inventorySpreadScale

### Breaking

## [2.2.0] - 2022-12-06

### Features

- ts-sdk: add btc/eth perp market configs for mainnet ([#277](https://github.com/drift-labs/protocol-v2/pull/277))
- program: reduce if stake requirement for better fee tier ([#275](https://github.com/drift-labs/protocol-v2/pull/275))
- program: new oracle order where auction price is oracle price offset ([#269](https://github.com/drift-labs/protocol-v2/pull/269)).
- program: block negative pnl settles which would lead to more borrows when quote spot utilization is high ([#273](https://github.com/drift-labs/protocol-v2/pull/273)).

### Fixes

- ts-sdk: fix bugs in calculateSpreadBN
- ts-sdk: fix additional bug in calculateSpreadBN (negative nums)

### Breaking
