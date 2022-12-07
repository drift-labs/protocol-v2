# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Features

### Fixes

- program: fix amm-jit erroring out when bids/asks are zero ([#279](https://github.com/drift-labs/protocol-v2/pull/279))

### Breaking

## [2.2.0] - 2022-12-06

### Features

- ts-sdk: add btc/eth perp market configs for mainnet ([#277](https://github.com/drift-labs/protocol-v2/pull/277))
- program: reduce if stake requirement for better fee tier ([#275](https://github.com/drift-labs/protocol-v2/pull/275))
- program: new oracle order where auction price is oracle price offset ([#269](https://github.com/drift-labs/protocol-v2/pull/269)).
- program: block negative pnl settles which would lead to more borrows when quote spot utilization is high ([#273](https://github.com/drift-labs/protocol-v2/pull/273)).
- program: update the amm min/max_base_asset_reserve upon k decreases within update_amm ([#282](https://github.com/drift-labs/protocol-v2/pull/282))

### Fixes

- ts-sdk: fix bugs in calculateSpreadBN
- ts-sdk: fix additional bug in calculateSpreadBN (negative nums)

### Breaking
