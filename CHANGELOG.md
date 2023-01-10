# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Features

program: limit number of users to 1500
program: more rigorous risk decreasing check in place_perp_order/place_stop_order

### Fixes

ts-sdk: fix user.getUnrealizedPnl to account for lp position
program: cancel market order for not satisfying limit price only if there was some base asset amount filled

### Breaking

## [2.20.0] - 2023-01-03

### Features

program: place order returns early if max ts breached ([#317](https://github.com/drift-labs/protocol-v2/pull/317))
ts-sdk: batch getMultipleAccount calls in bulkAccountLoader ([#315](https://github.com/drift-labs/protocol-v2/pull/315))
program: add clippy deny for panic, expect and unwrap
program: add market index offset trait ([#287](https://github.com/drift-labs/protocol-v2/pull/287))
program: add size trait to accounts and events ([#286](https://github.com/drift-labs/protocol-v2/pull/286))

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
