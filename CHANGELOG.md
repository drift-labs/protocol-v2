# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Features

### Fixes

- program: prevent user from enabling HLM when they are failing maintenance margin check [#2116](https://github.com/drift-labs/protocol-v2/pull/2116)

### Breaking

## [2.157.0] - 2026-02-11

### Features

- program: block amm fills when paused_operations set [#2108](https://github.com/drift-labs/protocol-v2/pull/2108)
- program: remove same slot matching restriction [#2104](https://github.com/drift-labs/protocol-v2/pull/2104)

### Fixes

### Breaking

- sdk: `helius-laserstream` is now an optional dependency; installs with `--no-optional` will disable LaserStream support. [#2087](https://github.com/drift-labs/protocol-v2/pull/2087)
- sdk: `LaserSubscribe` is deprecated and now lazy-loads with a warning; use `getLaserSubscribe()` instead. [#2087](https://github.com/drift-labs/protocol-v2/pull/2087)

## [2.156.0] - 2026-01-26

### Features

### Fixes

### Breaking

## [2.155.0] - 2026-01-20

### Features

- program: additional logging for amm fills [#2078](https://github.com/drift-labs/protocol-v2/pull/2078)
- program: allow delegate to transfer isolated pos deposit in sub account [#2079](https://github.com/drift-labs/protocol-v2/pull/2079)
- program: use load_maps in update_amms [#2081](https://github.com/drift-labs/protocol-v2/pull/2081)

### Fixes

### Breaking

## [2.154.0] - 2026-01-08

### Features

- program: isolated positions [#1757](https://github.com/drift-labs/protocol-v2/pull/1757)
- program: delete serum/openbook configs [#2066](https://github.com/drift-labs/protocol-v2/pull/2066)
- sdk: update yellowstone-grpc to rust client [#2070](https://github.com/drift-labs/protocol-v2/pull/2070)

### Fixes

### Breaking

- sdk: `channelOptions` in the GrpcConfigs type has been updated to work with new grpc lib

## [2.153.0] - 2025-12-30

### Features

- ui: save titan tx when quoted and reuse on swap by @cha-kos in [#2055](https://github.com/drift-labs/protocol-v2/pull/2055)
- feat: minified with esbuild by @LukasDeco in [#2056](https://github.com/drift-labs/protocol-v2/pull/2056)
- ui: fix falsely failing quotes from titan by @cha-kos in [#2058](https://github.com/drift-labs/protocol-v2/pull/2058)

### Fixes

- security patch: check feed id after pyth pull atomic update [84b5011](https://github.com/drift-labs/protocol-v2/commit/84b50116c15050c7d19608cd01745a8f7fc39b92)

### Breaking

## [2.152.0] - 2025-12-12

### Features

- program: add bit_flags to liquidation record [#2053](https://github.com/drift-labs/protocol-v2/pull/2053)

### Fixes

- program: fix base spread validate for perp market [#2052](https://github.com/drift-labs/protocol-v2/pull/2052)
- sdk: fix for initializing a new user account with a token2022 deposit

### Breaking

## [2.151.0] - 2025-12-03

### Features

- program: add reduce only atomic taking against amm option [#2037](https://github.com/drift-labs/protocol-v2/pull/2037)

### Fixes

### Breaking

## [2.150.0] - 2025-12-01

### Features

- program: stricter logic for atomic fills [#2042](https://github.com/drift-labs/protocol-v2/pull/2042)
- program: reset lp fields in update_user_idle [#2018](https://github.com/drift-labs/protocol-v2/pull/2018)

### Fixes

### Breaking

## [2.149.1] - 2025-11-19

### Features

### Fixes

### Breaking

- program: add DepositRecord::spot_balance_after [#2034](https://github.com/drift-labs/protocol-v2/pull/2034)

## [2.149.0] - 2025-11-19

### Features

- sdk: allow deposit from external authority directly to drift account

### Fixes

### Breaking

## [2.148.0] - 2025-11-14

### Features

- pyth lazer zero guard [#2023](https://github.com/drift-labs/protocol-v2/pull/2023)

### Fixes

### Breaking

## [2.147.0] - 2025-11-06

### Features

- whitelist ATA program in begin_swap ix [#2021](https://github.com/drift-labs/protocol-v2/pull/2021)

### Fixes

### Breaking

## [2.146.0] - 2025-11-03

### Features

- program: add isolated_position_deposit to signed msg params

### Fixes

### Breaking

## [2.145.1] - 2025-10-20

### Features

### Fixes

- dlp ([#1998](https://github.com/drift-labs/protocol-v2/pull/1998))
- dlp ([#1999](https://github.com/drift-labs/protocol-v2/pull/1999))
- dlp ([#2000](https://github.com/drift-labs/protocol-v2/pull/2000))

### Breaking

## [2.145.0] - 2025-10-28

### Features

- dlp ([#1885](https://github.com/drift-labs/protocol-v2/pull/1885))

### Fixes

### Breaking

## [2.144.0] - 2025-10-27

### Features

- program: use-5min-for-target-expiry-price ([#1967](https://github.com/drift-labs/protocol-v2/pull/1967))

### Fixes

### Breaking

## [2.143.0] - 2025-10-22

- program: relax filling conditions for low risk orders vs amm ([#1968](https://github.com/drift-labs/protocol-v2/pull/1968))
- sdk: make oracle validity match program and propogate to dlob and math functions ([#1968](https://github.com/drift-labs/protocol-v2/pull/1968))

### Features

- program: make imf smoother between hlm and non hlm users ([#1969](https://github.com/drift-labs/protocol-v2/pull/1969))

### Fixes

### Breaking

## [2.142.0] - 2025-10-14

### Features

- program: add titan to whitelisted swap programs ([#1952](https://github.com/drift-labs/protocol-v2/pull/1952))
- program: allow hot wallet to increase max spread and pause funding ([#1957](https://github.com/drift-labs/protocol-v2/pull/1957))

### Fixes

### Breaking

## [2.141.0] - 2025-10-03

### Features

- program: disallow builder to be escrow authority ([#1930](https://github.com/drift-labs/protocol-v2/pull/1930))
- dont panic on settle-pnl when no position ([#1928](https://github.com/drift-labs/protocol-v2/pull/1928))

### Fixes

### Breaking

## [2.140.0] - 2025-09-29

### Features

- program: builder codes ([#1805](https://github.com/drift-labs/protocol-v2/pull/1805))

### Fixes

### Breaking

## [2.139.0] - 2025-09-25

### Features

- program: all token 22 use immutable owner ([#1904](https://github.com/drift-labs/protocol-v2/pull/1904))
- program: allow resolve perp pnl deficit if pnl pool isnt 0 but at deficit ([#1909](https://github.com/drift-labs/protocol-v2/pull/1909))
- program: auction order params account for twap divergence ([#1882](https://github.com/drift-labs/protocol-v2/pull/1882))
- program: add delegate stake if ([#1859](https://github.com/drift-labs/protocol-v2/pull/1859))

### Fixes

### Breaking

## [2.138.0] - 2025-09-22

### Features

- program: support scaled ui extension ([#1894](https://github.com/drift-labs/protocol-v2/pull/1894))
- Revert "Crispeaney/revert swift max margin ratio ([#1877](https://github.com/drift-labs/protocol-v2/pull/1877))

### Fixes

### Breaking

## [2.137.0] - 2025-09-15

### Features

- program: post only respects reduce only ([#1878](https://github.com/drift-labs/protocol-v2/pull/1878))
- program: add sequence id to exchange/mm oracle ([#1834](https://github.com/drift-labs/protocol-v2/pull/1834))
- program: perp position max margin ratio ([#1847](https://github.com/drift-labs/protocol-v2/pull/1847))
- program: add padding to swift messages ([#1845](https://github.com/drift-labs/protocol-v2/pull/1845))
- program: rm lp ([#1755](https://github.com/drift-labs/protocol-v2/pull/1755))

### Fixes

- program: make it easier to fill step size orders ([#1799](https://github.com/drift-labs/protocol-v2/pull/1799))
- program: relax fee tier constraints for maker ([#1876](https://github.com/drift-labs/protocol-v2/pull/1876))

### Breaking

## [2.136.0] - 2025-09-03

### Features

- program: update referral fee validate rules ([#1843](https://github.com/drift-labs/protocol-v2/pull/1843))

### Fixes

### Breaking

## [2.134.0] - 2025-08-13

### Features

- program: add new settle pnl invariants ([#1812](https://github.com/drift-labs/protocol-v2/pull/1812))
- program: add update_perp_market_pnl_pool ([#1810](https://github.com/drift-labs/protocol-v2/pull/1810))
- program: increase min margin ratio invariant constant ([#1802](https://github.com/drift-labs/protocol-v2/pull/1802))
- program: update mark twap crank use 5min basis for bid/ask ([#1769](https://github.com/drift-labs/protocol-v2/pull/1769))

### Fixes

- program: remove burn lp shares invariant ([#1816](https://github.com/drift-labs/protocol-v2/pull/1816))
- program: correct fee tier 5 volume requirement ([#1800](https://github.com/drift-labs/protocol-v2/pull/1800))
- program: fix small number mark-twap-integer-bias ([#1783](https://github.com/drift-labs/protocol-v2/pull/1783))

### Breaking

## [2.133.0] - 2025-08-11

### Features

### Fixes

### Breaking

- program: have TRY_SETTLE pnl mode fail ([#1809](https://github.com/drift-labs/protocol-v2/pull/1809))

## [2.132.0] - 2025-08-06

### Features

- program: update max borrow delta/utilization thresholds ([#1760](https://github.com/drift-labs/protocol-v2/pull/1801))

### Fixes

### Breaking

## [2.131.1] - 2025-08-04

### Features

### Fixes

- program: update-fee-tier-validates ([#1798](https://github.com/drift-labs/protocol-v2/pull/1798))

### Breaking

## [2.131.0] - 2025-08-04

### Features

- program: update stake + volume fee tier determination ([#1792](https://github.com/drift-labs/protocol-v2/pull/1792))

### Fixes

- program: less aggressive fill bands for spot swaps ([#1796](https://github.com/drift-labs/protocol-v2/pull/1796))

### Breaking

## [2.130.0] - 2025-07-29

### Features

- program: new median price for trigger orders ([#1716](https://github.com/drift-labs/protocol-v2/pull/1716))
- program: mm oracle ([#1767](https://github.com/drift-labs/protocol-v2/pull/1767))
- program: add high leverage maintenance margin mode ([#1759](https://github.com/drift-labs/protocol-v2/pull/1759))

### Fixes

- program: update validate fill price to work both directions ([#1772](https://github.com/drift-labs/protocol-v2/pull/1772))

### Breaking

## [2.129.0] - 2025-07-23

### Features

- program: lp reduce only ([#1749](https://github.com/drift-labs/protocol-v2/pull/1749))
- program: new margin mode enum ([#1765](https://github.com/drift-labs/protocol-v2/pull/1765))

### Fixes

- program: fix reference price decay ([#1761](https://github.com/drift-labs/protocol-v2/pull/1761))

### Breaking

## [2.128.1] - 2025-07-21

### Features

### Fixes

- program: reference-price-offset-override ([#1760](https://github.com/drift-labs/protocol-v2/pull/1760))

### Breaking

## [2.128.0] - 2025-07-20

### Features

- program: smooth decay for reference price offset ([#1758)](https://github.com/drift-labs/protocol-v2/pull/1758))

### Fixes

### Breaking

## [2.127.0] - 2025-07-12

### Features

- program: allow hot admin to update prelaunch oracle ([#1734](https://github.com/drift-labs/protocol-v2/pull/1734))
- program: init passing in remaining accounts for transfer hook ([#1730](https://github.com/drift-labs/protocol-v2/pull/1730))

### Fixes

### Breaking

## [2.126.0] - 2025-07-09

### Features

- program: allow subset of transfer to revenue pool for protocol if ([#1721](https://github.com/drift-labs/protocol-v2/pull/1721))

### Fixes

- program: account for initial margin ratio for disable_user_high_leverage_mode and make it faster ([#1720](https://github.com/drift-labs/protocol-v2/pull/1720))
- program: fix AMM reference price offset ([#1683](https://github.com/drift-labs/protocol-v2/pull/1683))

### Breaking

## [2.125.0] - 2025-06-24

### Features

- program: use three points for std estimator ([#1686](https://github.com/drift-labs/protocol-v2/pull/1686))
- program: add inventory component amm_spread_adjustment ([#1690](https://github.com/drift-labs/protocol-v2/pull/1690))
- program: spot market specific rev pool to insurance cap ([#1692](https://github.com/drift-labs/protocol-v2/pull/1692))
- program: better account for imf in calculate_max_perp_order_size ([#1693](https://github.com/drift-labs/protocol-v2/pull/1693))

### Fixes

### Breaking

## [2.124.0] - 2025-06-18

### Features

- program: perp market amm oracle delay override ([#1679](https://github.com/drift-labs/protocol-v2/pull/1679))
- program: sanitize long tail perp market orders less frequently ([#1641](https://github.com/drift-labs/protocol-v2/pull/1641))
- program: programmatic rebalance between protocol owned if holdings ([#1653](https://github.com/drift-labs/protocol-v2/pull/1653))

### Fixes

### Breaking

## [2.123.0] - 2025-06-13

### Features

- program: simplify user can skip duration ([#1668](https://github.com/drift-labs/protocol-v2/pull/1668))
- program: allow limit orders without auctions in swift ([#1661](https://github.com/drift-labs/protocol-v2/pull/1661))
- program: add taker_speed_bump_override and amm_spread_adjustment ([#1665](https://github.com/drift-labs/protocol-v2/pull/1665))

### Fixes

### Breaking

## [2.122.0] - 2025-06-05

### Features

- program: add existing position fields to order records ([#1614](https://github.com/drift-labs/protocol-v2/pull/1614))

### Fixes

- sdk: fix to getMaxTradeSizeUSDCForPerp which was previously overshooting max allowed size due to IMF factor
- program: check limit price after applying buffer in trigger limit order ([#1648](https://github.com/drift-labs/protocol-v2/pull/1648))
- program: check limit price when setting auction for limit order ([#1650](https://github.com/drift-labs/protocol-v2/pull/1650))

### Breaking

## [2.121.0] - 2025-05-29

### Features

- program: multi piecewise interest rate curve ([#1560](https://github.com/drift-labs/protocol-v2/pull/1560))
- sdk: fees and max perp trade size calculation functions allow an optional parameter for a user using bitFlags to enter high leverage mode

### Fixes

- program: safely use saturating sub number_of_users fields per market ([#1616](https://github.com/drift-labs/protocol-v2/pull/1616))

### Breaking

## [2.120.0] - 2025-04-29

### Features

- program: add admin_deposit ([#1591](https://github.com/drift-labs/protocol-v2/pull/1591))

### Fixes

### Breaking

## [2.119.0] - 2025-04-21

### Features

- program: place perp order can update high leverage mode ([#1573](https://github.com/drift-labs/protocol-v2/pull/1573))
- sdk: generalized getSpotAssetValue and getSpotLiabilityValue to be able to be called without a user account ([#1577](https://github.com/drift-labs/protocol-v2/pull/1577))

### Fixes

### Breaking

## [2.118.0] - 2025-04-10

### Features

- program: make Pyra accounts exempt from force_delete_user ([#1569](https://github.com/drift-labs/protocol-v2/pull/1569))
- sdk: deprecate getPostSwitchboardOnDemandUpdateAtomicIx ([#1567](https://github.com/drift-labs/protocol-v2/pull/1567))
- program: maker trigger market oracle offset and fill with amm faster ([#1564](https://github.com/drift-labs/protocol-v2/pull/1564))
- program: sanitize signed msg orders with wider thresholds ([#1554](https://github.com/drift-labs/protocol-v2/pull/1554))

### Fixes

- program: add crossing start buffer auction to end price ([#1568](https://github.com/drift-labs/protocol-v2/pull/1568))

### Breaking

## [2.117.0] - 2025-03-31

### Features

- program: more lenient pool id check to allow users with referrer rewards to withdraw ([#1553](https://github.com/drift-labs/protocol-v2/pull/1553))
- program: add bitflags to order aciton records ([#1550](https://github.com/drift-labs/protocol-v2/pull/1550))

### Fixes

- program: fix user stats check for transfer_perp_position ([#1557](https://github.com/drift-labs/protocol-v2/pull/1557))

### Breaking

## [2.116.0] - 2025-03-21

### Features

### Fixes

- program: program: fix order status checks ([#1549](https://github.com/drift-labs/protocol-v2/pull/1539))

### Breaking

## [2.115.0] - 2025-03-20

### Features

- program: force lst pool oracle updates into same slot for liquidations ([#1537](https://github.com/drift-labs/protocol-v2/pull/1537))
- program: init dynamic offset for pmm ([#1524](https://github.com/drift-labs/protocol-v2/pull/1524))
- program: new order status logic to make tracking fills easier ([#1512](https://github.com/drift-labs/protocol-v2/pull/1512))
- program: make initting signedmsguserorder accounts permissionless ([#1533](https://github.com/drift-labs/protocol-v2/pull/1533))
- program: allow transfer perp position between two delegates ([#1538](https://github.com/drift-labs/protocol-v2/pull/1538))
- program: relax user-skip-auction-duration ([#1545](https://github.com/drift-labs/protocol-v2/pull/1545))

### Fixes

- program: fix reference price offset reserves ([#1516](https://github.com/drift-labs/protocol-v2/pull/1516))
- sdk: account for authority when useMarketLastSlotCache ([#1541](https://github.com/drift-labs/protocol-v2/pull/1541))
- program: delegate wallets sign taker pubkey into message ([#1546](https://github.com/drift-labs/protocol-v2/pull/1546))

### Breaking

## [2.114.0] - 2025-03-13

### Features

### Fixes

- program: add liq fees to calculate_perp_market_amm_summary_stats ([#1531](https://github.com/drift-labs/protocol-v2/pull/1531))

### Breaking

## [2.113.0] - 2025-03-06

### Features

- program: add transfer_perp_position ix ([#1514](https://github.com/drift-labs/protocol-v2/pull/1514))
- program: add signed_msg ws delegate account ([#1515](https://github.com/drift-labs/protocol-v2/pull/1515))

### Fixes

### Breaking

## [2.112.0] - 2025-03-03

### Features

- program: use custom margin ratio if oracle too stale for margin ([#1505](https://github.com/drift-labs/protocol-v2/pull/1505))
- program: enable limit orders with auctions in fastlane ([#1502](https://github.com/drift-labs/protocol-v2/pull/1502))
- program: set is_signed_msg bitflag on orders ([#1504](https://github.com/drift-labs/protocol-v2/pull/1504))

### Fixes

### Breaking

## [2.111.0] - 2025-02-25

### Features

### Fixes

- program: place signed order after tp/sl ([#1496](https://github.com/drift-labs/protocol-v2/pull/1496))
- program: rm oracle conf max 1 in validity checker ([#1497](https://github.com/drift-labs/protocol-v2/pull/1497))

### Breaking

## [2.110.0] - 2025-02-19

### Features

- program: add update oracle source invariant checks and logs ([#1480](https://github.com/drift-labs/protocol-v2/pull/1480))
- program: add transfer_pools ix ([#1472](https://github.com/drift-labs/protocol-v2/pull/1472))
- program: updated borrow thresholds for ([#1483](https://github.com/drift-labs/protocol-v2/pull/1483))

### Fixes

- program: change ordering of SL/TP order placement within signed msg orders ([#1495](https://github.com/drift-labs/protocol-v2/pull/1495))

### Breaking

## [2.109.0] - 2025-02-06

### Features

- program: add posted slot tail to order struct, use it to determine vamm availability for high volume users ([#1459](https://github.com/drift-labs/protocol-v2/pull/1459))
- program: add pyth lazer stable coin oracle type ([#1463](https://github.com/drift-labs/protocol-v2/pull/1463))
- program: removes devnet panics for swift and slightly changes sig verification ([#1464](https://github.com/drift-labs/protocol-v2/pull/1464))
- program: allow hot wallet admin to init market if not active ([#1454](https://github.com/drift-labs/protocol-v2/pull/1454))
- program: round down 1 for calculate_max_withdrawable ([#1461](https://github.com/drift-labs/protocol-v2/pull/1461))
- program: add fuel overflow account ([#1449](https://github.com/drift-labs/protocol-v2/pull/1449))
- program: add delegates to swift ([#1474](https://github.com/drift-labs/protocol-v2/pull/1474))

### Fixes

- program: fix hlm liq fee ([#1465](https://github.com/drift-labs/protocol-v2/pull/1465))

### Breaking

## [2.108.0] - 2025-01-30

### Features

- program: add separate liquidator fee for high leverage mode ([#1451](https://github.com/drift-labs/protocol-v2/pull/1451))
- program: update pyth lazer verification ([#1441](https://github.com/drift-labs/protocol-v2/pull/1441))

### Fixes

- program: apply liq buffer to negative pnl ([#1445](https://github.com/drift-labs/protocol-v2/pull/1445))
- program: update get fuel bonus numerator ts ([#1446](https://github.com/drift-labs/protocol-v2/pull/1446))

### Breaking

## [2.107.0] - 2025-01-20

### Features

- program: apply 10bps to protected market maker limit orders ([#1417](https://github.com/drift-labs/protocol-v2/pull/1417))
- program: allow lighthouse at end of swap ([#1429](https://github.com/drift-labs/protocol-v2/pull/1429))

### Fixes

### Breaking

## [2.106.0] - 2025-01-08

### Features

- program: liquidate spot with swap ([#1402](https://github.com/drift-labs/protocol-v2/pull/1402))

### Fixes

- program: account for fuel in swaps ([#1411](https://github.com/drift-labs/protocol-v2/pull/1411))
- program: account for fuel when there is full withdraw ([#1413](https://github.com/drift-labs/protocol-v2/pull/1413))

### Breaking

## [2.105.0] - 2025-01-02

### Features

- program: add ix to pause deposits/withdraws if vault invariant broken ([#1387](https://github.com/drift-labs/protocol-v2/pull/1387))

### Fixes

- program: fix spot swap fuel bonus ([#1411](https://github.com/drift-labs/protocol-v2/pull/1411))
- program: skip liq perp oracle twap check if market is in settlement ([#1406](https://github.com/drift-labs/protocol-v2/pull/1406))

### Breaking

## [2.104.0] - 2024-12-23

### Features

- program: pyth lazer integration ([#1361](https://github.com/drift-labs/protocol-v2/pull/1361))
- program: add ix to log user balances ([#1366](https://github.com/drift-labs/protocol-v2/pull/1366))

### Fixes

- program: fix force delete user for token 2022 ([#1358](https://github.com/drift-labs/protocol-v2/pull/1358))
- program: fix liquidating dust prediction mkt position ([#1397](https://github.com/drift-labs/protocol-v2/pull/1397))
- program: spot market decimals under 6 precision fixes ([#1399](https://github.com/drift-labs/protocol-v2/pull/1399))

### Breaking

## [2.103.0] - 2024-12-04

### Features

- program: add spot market pool ids ([#1250](https://github.com/drift-labs/protocol-v2/pull/1250))
- program: make oracle map work with different sources ([#1346](https://github.com/drift-labs/protocol-v2/pull/1346))
- program: allow read only ix after swap ([#1356](https://github.com/drift-labs/protocol-v2/pull/1356))

### Fixes

- program: fix force delete user for token 2022 ([#1358](https://github.com/drift-labs/protocol-v2/pull/1358))

### Breaking

- program: make ModifyOrderParams a bit flag and add ExcludePreviousFill ([#1357](https://github.com/drift-labs/protocol-v2/pull/1357))

## [2.102.0] - 2024-11-21

### Features

- program: force delete user init ([#1341](https://github.com/drift-labs/protocol-v2/pull/1341))
- program: rm withdraw fee ([#1334](https://github.com/drift-labs/protocol-v2/pull/1334))

### Fixes

- program: can update k looks at min order size ([#1338](https://github.com/drift-labs/protocol-v2/pull/1338))
- program: skip validate_post_only_order if amm paused ([#1202](https://github.com/drift-labs/protocol-v2/pull/1202))

### Breaking

## [2.101.0] - 2024-11-15

### Features

- program: upgrade switchboard on demand oracles ([#1329](https://github.com/drift-labs/protocol-v2/pull/1329))

### Fixes

### Breaking

## [2.100.0] - 2024-11-14

### Features

- program: add auction_duration_percentage to place and take ([#1320](https://github.com/drift-labs/protocol-v2/pull/1320))
- program: more lenient w invalid deposit oracles ([#1324](https://github.com/drift-labs/protocol-v2/pull/1324))
- program: rm usdc staking fee discount ([#1316](https://github.com/drift-labs/protocol-v2/pull/1316))
- program: allow hot admin wallet to init pyth oracle ([#1327](https://github.com/drift-labs/protocol-v2/pull/1327))
- program: update hlm fees ([#1317](https://github.com/drift-labs/protocol-v2/pull/1317))
- program: update hlm disable ([#1318](https://github.com/drift-labs/protocol-v2/pull/1318))

### Fixes

- sdk: getBestBids/Asks only considers price/time priority ([#1322](https://github.com/drift-labs/protocol-v2/pull/1322))

### Breaking

## [2.99.0] - 2024-11-04

### Features

### Fixes

- program: add update_user_stats_referrer_status to lib

### Breaking

## [2.98.0] - 2024-11-04

### Features

- sdk: init referrerMap ([#1295](https://github.com/drift-labs/protocol-v2/pull/1295))
- program: allow disable high leverage mode after 1 hour ([#1289](https://github.com/drift-labs/protocol-v2/pull/1289))
- sdk: driftClient unsub from delisted markets by default ([#1298](https://github.com/drift-labs/protocol-v2/pull/1298))
- program: allow amm to fill immediately ([#1258](https://github.com/drift-labs/protocol-v2/pull/1258))
- program: high leverage users pay higher fee ([#1287](https://github.com/drift-labs/protocol-v2/pull/1287))

### Fixes

- program: admin can sign everywhere hot wallet can ([#1290](https://github.com/drift-labs/protocol-v2/pull/1290))

### Breaking

## [2.97.0] - 2024-10-23

### Features

- program: high leverage mode ([#1240](https://github.com/drift-labs/protocol-v2/pull/1240))
- program: add flag for is_referred and is_referrer ([#1256 ](https://github.com/drift-labs/protocol-v2/pull/1256))
- program/sdk: rfq for devnet ([#1254](https://github.com/drift-labs/protocol-v2/pull/1254))
- program: let oracle offset orders have auctions ([#1273](https://github.com/drift-labs/protocol-v2/pull/1273))

### Fixes

### Breaking

## [2.96.0] - 2024-10-10

### Features

- program: reusue unused maker order id as success condition for place and take perp order ([#1218](https://github.com/drift-labs/protocol-v2/pull/1218))
- program/sdk: swift for devnet ([#1195](https://github.com/drift-labs/protocol-v2/pull/1195))
- sdk: EventSubscriber: support events server ([#1222](https://github.com/drift-labs/protocol-v2/pull/1222))
- sdk: add new DelistMarketSetting to handle delisted markets ([#1229](https://github.com/drift-labs/protocol-v2/pull/1229))
- program: add update-user-fuel-bonus ix ([#1247](https://github.com/drift-labs/protocol-v2/pull/1247))

### Fixes

- program: remove trigger limit resting limit order hook ([#1233](https://github.com/drift-labs/protocol-v2/pull/1233))
- program: fix max liquidation fee overflow ([#1232](https://github.com/drift-labs/protocol-v2/pull/1232))

### Breaking

## [2.95.0] - 2024-09-16

### Features

- program: update settle market guards ([#1216](https://github.com/drift-labs/protocol-v2/pull/1216))
- sdk:: cache toStringing oracle for drift client account subscribers ([#1220](https://github.com/drift-labs/protocol-v2/pull/1220))

### Fixes

- program: return early in update_perp_bid_ask_twap for prediction market with no bid/asks ([#1223](https://github.com/drift-labs/protocol-v2/pull/1223))
- sdk: avoid spamming getAccountInfo in drift client ws sub ([#1219](https://github.com/drift-labs/protocol-v2/pull/1219))

### Breaking

## [2.93.0] - 2024-08-29

### Features

### Fixes

- program: remove redundant clones ([#1199](https://github.com/drift-labs/protocol-v2/pull/1199))
- program: fix spot market map in force_cancel_orders ([#1209](https://github.com/drift-labs/protocol-v2/pull/1209))

### Breaking

## [2.93.0] - 2024-08-22

### Features

- program: dynamic liquidation fee for liq_perp_with_fill ([#1185](https://github.com/drift-labs/protocol-v2/pull/1185))
- program: calculate_accumulated_interest return early based on ts ([#1192](https://github.com/drift-labs/protocol-v2/pull/1192))
- program: add logging to pyth pull updates ([#1189](https://github.com/drift-labs/protocol-v2/pull/1189))

### Fixes

### Breaking

## [2.92.0] - 2024-08-12

### Features

- program: init prediction markets ([#1152](https://github.com/drift-labs/protocol-v2/pull/1152))

### Fixes

- program: make updateUserQuoteAssetInsuranceStake permissionless ([#1187](https://github.com/drift-labs/protocol-v2/pull/1187))
- program: fix openbook v2 oom issue ([#1186](https://github.com/drift-labs/protocol-v2/pull/1186))

### Breaking

## [2.91.0] - 2024-08-07

### Features

### Fixes

- program: look at drift stake to determine fee tier ([#1172](https://github.com/drift-labs/protocol-v2/pull/1172))

### Breaking

## [2.90.0] - 2024-08-03

### Features

### Fixes

- program: account for direction when looking at max borrow cap ([#1169](https://github.com/drift-labs/protocol-v2/pull/1169))

### Breaking

## [2.89.0] - 2024-08-02

### Features

### Fixes

- program: call get_token_interface in begin_swap

### Breaking

## [2.88.0] - 2024-08-01

### Features

### Fixes

- program: advance iter in get_token_interface and get_token_mint

### Breaking

## [2.87.0] - 2024-07-30

### Features

- program: add deposit into spot market vault ([#1159](https://github.com/drift-labs/protocol-v2/pull/1159))
- program: add liquidation via fill ([#1106](https://github.com/drift-labs/protocol-v2/pull/1106))
- program: add switchboard on demand integration ([#1154](https://github.com/drift-labs/protocol-v2/pull/1154))
- program: add support for token 2022 ([#1125](https://github.com/drift-labs/protocol-v2/pull/1125))

### Fixes

### Breaking

## [2.86.0] - 2024-07-22

### Features

- program: track fuel ([#1048](https://github.com/drift-labs/protocol-v2/pull/1048))
- program: add post multi pyth oracle updates atomic ([#1133](https://github.com/drift-labs/protocol-v2/pull/1133))
- program: track fuel for if staking ([#1127](https://github.com/drift-labs/protocol-v2/pull/1127))
- program: validate fee structure ([#1075](https://github.com/drift-labs/protocol-v2/pull/1075))
- program: check 5 min oracle twap divergence in trigger order ([#1116](https://github.com/drift-labs/protocol-v2/pull/1116))
- program: openbook v2 integration ([#1112](https://github.com/drift-labs/protocol-v2/pull/1112))
- program: spot fill checks if withdraws are paused ([#881](https://github.com/drift-labs/protocol-v2/pull/881))

### Fixes

- program: more oracle validation in admin fn ([#1082](https://github.com/drift-labs/protocol-v2/pull/1082))
- program: account for serum already having open order account ([#1077](https://github.com/drift-labs/protocol-v2/pull/1077))
- program: avoid truncated cast ([#1078](https://github.com/drift-labs/protocol-v2/pull/1078))
- program: check whitelist token amount ([#1076](https://github.com/drift-labs/protocol-v2/pull/1076))
- program: program: only let referrer set if number_of_sub_accounts_created is 0 ([#1083](https://github.com/drift-labs/protocol-v2/pull/1083))
- program: update increment_total_referrer_reward corner-case logic ([#1156](https://github.com/drift-labs/protocol-v2/pull/1156))

### Breaking

## [2.85.0] - 2024-07-02

### Features

- program: add tx optimized pyth pull ([#1111](https://github.com/drift-labs/protocol-v2/pull/1111))
- program: migrate all integration tests to bankrun ([#1090](https://github.com/drift-labs/protocol-v2/pull/1090))

### Fixes

### Breaking

## [2.84.0] - 2024-06-23

### Features

- program: check FillOrderAmm for amm is available ([#1107](https://github.com/drift-labs/protocol-v2/pull/1107))
- program: add spot borrow insurance limits ([#1080](https://github.com/drift-labs/protocol-v2/pull/1080))
- program: maker can be rewarded filler returns when amm gets fill ([#1093](https://github.com/drift-labs/protocol-v2/pull/1093))
- program: avoid overwriting 0 duration auction ([#1097](https://github.com/drift-labs/protocol-v2/pull/1097))
- program: add pyth pull oracles ([#1067](https://github.com/drift-labs/protocol-v2/pull/1067))

### Fixes

### Breaking

- program: upgrade to anchor 0.29.0 and solana 1.16

## [2.83.0] - 2024-06-06

### Features

- program: settle pnl block looks at oracle vs oracle 5min twap ([#1072](https://github.com/drift-labs/protocol-v2/pull/1072))
- program: add settle pnl mode ([#1030](https://github.com/drift-labs/protocol-v2/pull/1030))
- program: use strict price for maintenance margin check in settle pnl ([#1045](https://github.com/drift-labs/protocol-v2/pull/1045))
- program: order w ioc can still get auction ([#1074](https://github.com/drift-labs/protocol-v2/pull/1074))

### Fixes

- program: update_perp_auction_params_limit_orders unwraps oracle_price_offset
- ts-sdk: add market index to logging settle pnl error ([#1068](https://github.com/drift-labs/protocol-v2/pull/1068))
- program: enforce min price for oracle offsets ([#874](https://github.com/drift-labs/protocol-v2/pull/874))

### Breaking

## [2.82.0] - 2024-05-23

### Features

- program: TransferProtocolIfShares constraint ([#1055](https://github.com/drift-labs/protocol-v2/pull/1055))
- program: sanitize extreme auction end prices ([#1031](https://github.com/drift-labs/protocol-v2/pull/1031))
- program: add comprehensive admin function logging ([#1038](https://github.com/drift-labs/protocol-v2/pull/1038))

### Fixes

### Breaking

- ts-sdk: upgrade to node 18 and solana version 1.91.7 ([#1036](https://github.com/drift-labs/protocol-v2/pull/1036))

## [2.81.0] - 2024-04-22

### Features

### Fixes

- program: fix tracking unsettled quote for lp ([#1026](https://github.com/drift-labs/protocol-v2/pull/1026))

### Breaking

## [2.80.0] - 2024-04-20

### Features

- program: add ability to pause if operations ([#989](https://github.com/drift-labs/protocol-v2/pull/989))
- program: update auction end price in derive_market_order_auction_params ([#1022](https://github.com/drift-labs/protocol-v2/pull/1022))
- program: admin amm summary stats update and/or reset ([#912](https://github.com/drift-labs/protocol-v2/pull/912))

### Fixes

### Breaking

## [2.79.0] - 2024-04-18

### Features

### Fixes

- program: program: let user with positive pnl be settled if being liquidated ([#1020](https://github.com/drift-labs/protocol-v2/pull/1020))
- program: fix should_expire_order_before_fill ([#1021](https://github.com/drift-labs/protocol-v2/pull/1021))

### Breaking

## [2.78.0] - 2024-04-15

### Features

### Fixes

- program: set default ContractTier to HighlySpeculative ([#1013](https://github.com/drift-labs/protocol-v2/pull/1013))
- program: avoid dust borrows not being transferred

### Breaking

## [2.77.0] - 2024-04-13

### Features

- program: lax funding rate update oracle validity criteria ([#1009](https://github.com/drift-labs/protocol-v2/pull/1009))

### Fixes

- program: fix div by 0 in calculate_liability_transfer_to_cover_margin_shortage

### Breaking

## [2.76.0] - 2024-04-09

### Features

- program: rm admins ability to withdraw from if ([#990](https://github.com/drift-labs/protocol-v2/pull/990))
- program: add add ability to delete initialized spot market ([#998](https://github.com/drift-labs/protocol-v2/pull/998))
- program: more reliable oracle updates ([#1000](https://github.com/drift-labs/protocol-v2/pull/1000))

### Fixes

- program: avoid underflow in update pnl ([#1002](https://github.com/drift-labs/protocol-v2/pull/1002))

### Breaking

## [2.75.0] - 2024-04-01

### Features

- program: add fee adjustment to spot market ([#987](https://github.com/drift-labs/protocol-v2/pull/987))
- program: allow multiple makers to be passed into for spot fills ([#946](https://github.com/drift-labs/protocol-v2/pull/946))
- ts-sdk: add fn to get admin ix ([#980](https://github.com/drift-labs/protocol-v2/pull/980))
- program: add invariant check boolean for attempt settle revenue to insurance ([#937](https://github.com/drift-labs/protocol-v2/pull/937))
- program: improve best bid/ask estimate in mark twap update ([#975](https://github.com/drift-labs/protocol-v2/pull/975))
- program: add optional margin calculations for drift-rs ([#978](https://github.com/drift-labs/protocol-v2/pull/978))

### Fixes

### Breaking

## [2.74.0] - 2024-03-25

### Features

- program: add 'highly speculative' contract tier enum 4 ([#968](https://github.com/drift-labs/protocol-v2/pull/968))
- program: expand initialize market parameters ([#969](https://github.com/drift-labs/protocol-v2/pull/969))

### Fixes

- program: fix checking isolated tier in add_perp_lp_shares ([#965](https://github.com/drift-labs/protocol-v2/pull/965))

### Breaking

## [2.73.0] - 2024-03-15

### Features

### Fixes

- program: fix checking isolated tier in validate spot margin trading

### Breaking

## [2.72.0] - 2024-03-14

### Features

- program: skip isolated tier for auction start/end sanitize ([#958](https://github.com/drift-labs/protocol-v2/pull/958))

- program: check isolated perp market in validate spot margin trading ([#957](https://github.com/drift-labs/protocol-v2/pull/957))
- program: improve update prelaunch oracles and add ability to delete ([#956](https://github.com/drift-labs/protocol-v2/pull/956))
- program: allow user to settle realized pnl in reduce only market status ([#954](https://github.com/drift-labs/protocol-v2/pull/954))
- sdk: add function for toggling user account to reduceOnly ([#966](https://github.com/drift-labs/protocol-v2/pull/966))

### Fixes

- program: update spot index twap ts ([#948](https://github.com/drift-labs/protocol-v2/pull/948))

### Breaking

## [2.71.0] - 2024-03-11

### Features

- program: add back switchboard without cargo dependency ([#943](https://github.com/drift-labs/protocol-v2/pull/943))
- program: add admin fn to update funding period
- program: add prelaunch oracles ([#910](https://github.com/drift-labs/protocol-v2/pull/910))
- program: make isolated perp contract tier more ergonomic ([#913](https://github.com/drift-labs/protocol-v2/pull/913))
- program: add per market tier confidence interval guard ([#945](https://github.com/drift-labs/protocol-v2/pull/945))

### Fixes

### Breaking

- sdk: account for max confidence in isOracleValid ([#949](https://github.com/drift-labs/protocol-v2/pull/949))

## [2.70.0] - 2024-03-07

### Features

### Fixes

- program: fix allowing settle pnl on oracle delays when price is stable ([#940](https://github.com/drift-labs/protocol-v2/pull/940))

### Breaking

## [2.69.0] - 2024-03-06

### Features

- program: allow settle pnl on oracle delays when price is stable ([#929](https://github.com/drift-labs/protocol-v2/pull/929))
- program: cache validity in oracle map

### Fixes

### Breaking

- program: revert switchboard ([#935](https://github.com/drift-labs/protocol-v2/pull/935))

## [2.68.0] - 2024-03-05

### Features

- program: apply auction sanitizer to all contract tiers ([#932](https://github.com/drift-labs/protocol-v2/pull/932))

### Fixes

- program: fix flipping funding rates ([#931](https://github.com/drift-labs/protocol-v2/pull/931))

### Breaking

## [2.67.0] - 2024-03-05

### Features

### Fixes

- program: add switchboard ([#878](https://github.com/drift-labs/protocol-v2/pull/878))
- sdk: handle oracle failover when oracle is changed ([#875](https://github.com/drift-labs/protocol-v2/pull/875))

### Breaking

## [2.66.0] - 2024-02-28

### Features

### Fixes

- program: don't block oracle order prices when theres solely InsufficientDataPoints ([#919](https://github.com/drift-labs/protocol-v2/pull/919))

### Breaking

## [2.65.0] - 2024-02-26

### Features

- program: add pause operation for liquidation ([#880](https://github.com/drift-labs/protocol-v2/pull/880))

### Fixes

- program: fix entry/breakeven price calculations for lp remainders ([#864](https://github.com/drift-labs/protocol-v2/pull/864))
- program: handle derisk lp when orders array full ([#899](https://github.com/drift-labs/protocol-v2/pull/899))
- program: invalid borrow in get_referrer_info when maker is refferer ([#900](https://github.com/drift-labs/protocol-v2/pull/900))

### Breaking

## [2.64.0] - 2024-02-20

### Features

- program: make derived auction start more passive ([#890](https://github.com/drift-labs/protocol-v2/pull/890))

### Fixes

### Breaking

## [2.63.0] - 2024-02-16

### Features

- program: longer derived auction durations for contract tier B and safer ([#889](https://github.com/drift-labs/protocol-v2/pull/889))
- program: always try update market order auction durations ([#882](https://github.com/drift-labs/protocol-v2/pull/882))
- program: amm drawdown check ([#865](https://github.com/drift-labs/protocol-v2/pull/865))
- program: relax oracle guardrail validity check for init margin calc for positive pnl ([#876](https://github.com/drift-labs/protocol-v2/pull/876))
- program: add more max spread baselines ([#858](https://github.com/drift-labs/protocol-v2/pull/858))

### Fixes

- sdk: fix bug in changeWallet that doesn't reset the user stats account if switching from a wallet with drift account to one without

### Breaking

## [2.62.0] - 2024-02-14

### Features

- program: more continuous calculation for calculate_jit_amount ([#882](https://github.com/drift-labs/protocol-v2/pull/882))

### Fixes

### Breaking

## [2.61.0] - 2024-02-09

### Features

- program: better derivation of perp auction params when missing and for triggers ([#869](https://github.com/drift-labs/protocol-v2/pull/869))
- program: calculate whether oracle's num quoters sufficient ([#860](https://github.com/drift-labs/protocol-v2/pull/860))

### Fixes

- program: include derisk lp order action explanation

### Breaking

## [2.60.0] - 2024-02-07

### Features

- program: sanitize perp auction params ([#859](https://github.com/drift-labs/protocol-v2/pull/859))
- program: add repay borrow explanation ([#862](https://github.com/drift-labs/protocol-v2/pull/862))
- program: derisk lp more granularly ([#849](https://github.com/drift-labs/protocol-v2/pull/849))

### Fixes

### Breaking

## [2.59.0] - 2024-01-30

### Features

- program: separate out paused operations from market status ([#839](https://github.com/drift-labs/protocol-v2/pull/839))
- program: use decayed last_oracle_conf_pct as lower bound for update ([#840](https://github.com/drift-labs/protocol-v2/pull/840))

### Fixes

### Breaking

## [2.58.0] - 2024-01-27

### Features

### Fixes

- program: AmmPaused doesnt block all fills

### Breaking

## [2.57.0] - 2024-01-25

### Features

- program: add recenter amm ix ([#836](https://github.com/drift-labs/protocol-v2/pull/836))

### Fixes

### Breaking

## [2.56.0] - 2024-01-24

### Features

### Fixes

- program: enable jit maker to fill same slot as taker placed ([#835](https://github.com/drift-labs/protocol-v2/pull/835))

### Breaking

## [2.55.0] - 2024-01-18

### Features

### Fixes

- program: standardize lp shares in attempt_burn_user_lp_shares_for_risk_reduction ([#826](https://github.com/drift-labs/protocol-v2/pull/826))

### Breaking

## [2.54.0] - 2024-01-15

### Features

- sdk: move bracket orders into single instruction
- sdk: add ability to do placeAndTake order with bracket orders attached
- sdk: add option to cancel existing orders in market for place and take order
- sdk: add option to get signed settlePnl tx back from a market order
- program: auto derisk lp positions in settle pnl ([#766](https://github.com/drift-labs/protocol-v2/pull/766))
- program: increase full perp liquidation threshold ([#807](https://github.com/drift-labs/protocol-v2/pull/807))
- program: remove spot fee pool transfer ([#800](https://github.com/drift-labs/protocol-v2/pull/800))
- program: increase insurance tier max ([#784](https://github.com/drift-labs/protocol-v2/pull/784))
- sdk: can specify max custom margin ratio to initialize a new account with

### Fixes

- ts-sdk: contract tier funding rate clamp ([#785](https://github.com/drift-labs/protocol-v2/pull/785))
- ts-sdk: fix oracle is valid ([#806](https://github.com/drift-labs/protocol-v2/pull/806))

### Breaking

## [2.53.0] - 2023-12-31

### Features

### Fixes

- program: standardize limit auction prices ([#790](https://github.com/drift-labs/protocol-v2/pull/790))
- program: improve get_fallback_price([#797](https://github.com/drift-labs/protocol-v2/pull/797))
- program: derive auction for crossing limit with no duration ([#802](https://github.com/drift-labs/protocol-v2/pull/802))
- sdk: use tx params passed into deposit and withdraw functions

### Breaking

## [2.52.0] - 2023-12-22

### Features

- program: add ability to reclaim rent without deleting account ([#763](https://github.com/drift-labs/protocol-v2/pull/763))
- program: add borrow explanation to DepositRecords ([#772](https://github.com/drift-labs/protocol-v2/pull/772))
- sdk: OrderSubscriber has resync option ([#780](https://github.com/drift-labs/protocol-v2/pull/780))
- program: only consider recent last_active_slot in qualifies_for_withdraw_feen ([#756](https://github.com/drift-labs/protocol-v2/pull/756))
- program: amm can use reference price offset from oracle price based on clamped inventory and persist market premiums ([#681](https://github.com/drift-labs/protocol-v2/pull/681))

### Fixes

- program: handle underflow in calculate_liability_transfer_to_cover_margin_shortage ([#774](https://github.com/drift-labs/protocol-v2/pull/774))
- program: flip auction flag when trigger order adds auction ([#775](https://github.com/drift-labs/protocol-v2/pull/775))
- program: don't perform funding rate updates when slots_since_amm_update is stale ([#757](https://github.com/drift-labs/protocol-v2/pull/757))
- program: add update last slot for filler in pay_keeper_flat_reward_for_spot

### Breaking

## [2.51.0] - 2023-12-09

### Features

### Fixes

- program: consistent user of fee budget in calculate_optimal_peg_and_budget ([#754](https://github.com/drift-labs/protocol-v2/pull/754))

### Breaking

## [2.50.0] - 2023-12-09

### Features

### Fixes

- program: better account for liquidation fees in calculate_optimal_peg_and_budget ([#754](https://github.com/drift-labs/protocol-v2/pull/754))

### Breaking

## [2.49.0] - 2023-12-08

## [Unreleased]

### Features

- program: add init user fee ([#752](https://github.com/drift-labs/protocol-v2/pull/752))
- program: vamm gives maker rebate ([#653](https://github.com/drift-labs/protocol-v2/pull/653))

### Fixes

### Breaking

## [2.48.0] - 2023-12-01

### Features

### Fixes

- program: account for step size when canceling reduce only orders

### Breaking

- sdk: UserStatsMap use bulkAccountLoader (`UserStatsMap.subscribe` and `UserStatsMap.sync` now requires list of authorities) ([#716](https://github.com/drift-labs/protocol-v2/pull/716))

## [2.47.0] - 2023-11-26

### Features

- program: accelerated idle update for users with <$1000 equity

### Fixes

- ts-sdk: fix to modify order booleans

### Breaking

## [2.46.0] - 2023-11-24

### Features

- program: fill asset weight between init and maintenance ([#713](https://github.com/drift-labs/protocol-v2/pull/713))
- program: if order reduces maker position, check maintenance margin requirement ([#714](https://github.com/drift-labs/protocol-v2/pull/714))

### Fixes

### Breaking

## [2.45.0] - 2023-11-22

### Features

- program: trigger limits cant make if limit crosses trigger ([#707](https://github.com/drift-labs/protocol-v2/pull/702))

### Fixes

- sdk: fix vamm L2asks by using askAmm ([#708](https://github.com/drift-labs/protocol-v2/pull/708))
- program: add max_number_of_sub_accounts onto state account ([#710](https://github.com/drift-labs/protocol-v2/pull/710))

### Breaking

## [2.44.0] - 2023-11-17

### Features

### Fixes

- program: exhaustively search for referrer account on fill ([#702](https://github.com/drift-labs/protocol-v2/pull/702))

## [2.43.0] - 2023-11-16

### Features

- program: accelerate liquidations for tiny accounts ([#698](https://github.com/drift-labs/protocol-v2/pull/698))
- program: boost max sub accounts to 20k

### Fixes

- program: allow amm to fill step size ([#672](https://github.com/drift-labs/protocol-v2/pull/672))
- program: add add update_liquidation_margin_buffer_ratio ([#695](https://github.com/drift-labs/protocol-v2/pull/695))
- program: account for fee pool when settling positive pnl ([#687](https://github.com/drift-labs/protocol-v2/pull/687))
- sdk: fix bug which incorrectly calculated leverage after trade for a market with no position but short orders open
- sdk: fix bug in modifying an order that previously had auction params to a non-auction order
- sdk: add delta to calculateDepositRate function

### Breaking

## [2.42.0] - 2023-10-26

### Features

- program: add accelerated user update idle ([#669](https://github.com/drift-labs/protocol-v2/pull/669))
- program: make user status a bit flag ([#619](https://github.com/drift-labs/protocol-v2/pull/619))
- program: place and take uses auction end price for market orders ([#650](https://github.com/drift-labs/protocol-v2/pull/650))
- program: reduce cus for place_spot_order ([#662](https://github.com/drift-labs/protocol-v2/pull/662))
- program: bump max sub accounts to 15k
- program: user custom margin ratio works with spot ([#633](https://github.com/drift-labs/protocol-v2/pull/633))
- program: add swap price bands ([#611](https://github.com/drift-labs/protocol-v2/pull/611))
- program: add 5min twap price bands to liquidate_perp and liquidate_spot ([#570](https://github.com/drift-labs/protocol-v2/pull/570))
- program: add positive perp funding rate offset ([#576](https://github.com/drift-labs/protocol-v2/pull/576/files))

### Fixes

- program: add validation check in update max imbalances ([#667](https://github.com/drift-labs/protocol-v2/pull/667))

### Breaking

- sdk: remove getMakerLimitBids/Asks from DLOB
- sdk: updateUserMarginEnabled and updateUserCustomMarginRatio now take in an array of params to allow multiple subaccounts to be update in a single tx

## [2.41.0] - 2023-10-05

### Features

- program: order_breaches_maker_oracle_price_bands only uses init margin ratio ([#636](https://github.com/drift-labs/protocol-v2/pull/636))
- program: add fee_adjustment to perp market ([#629](https://github.com/drift-labs/protocol-v2/pull/629))
- program: add buffer to calculating max perp if fee ([#635](https://github.com/drift-labs/protocol-v2/pull/635))
- sdk: remove getMakerLimitBids/Asks ([#632](https://github.com/drift-labs/protocol-v2/pull/632))
- program: add ix to transfer protocol if shares ([#612](https://github.com/drift-labs/protocol-v2/pull/612))

### Fixes

- program: fix if staking rounding for fee tier selection ([#643](https://github.com/drift-labs/protocol-v2/pull/643))

### Breaking

## [2.40.0] - 2023-09-28

### Features

- program: add dynamic liquidation fee ([#601](https://github.com/drift-labs/protocol-v2/pull/601))
- sdk: add deriveOracleAuctionParams
- program: update to anchor 0.27.0 ([#617](https://github.com/drift-labs/protocol-v2/pull/617))

### Fixes

### Breaking

## [2.39.0] - 2023-09-07

### Features

- sdk: updated anchor to 0.28.1-beta.2
- sdk: add priorityFeeSubscriber
- program: allow up to 12500 users
- program: scale initial asset weight for spot markets based on total deposits ([#575](https://github.com/drift-labs/protocol-v2/pull/575))

### Fixes

- program: let auction start/end be the same ([#597](https://github.com/drift-labs/protocol-v2/pull/597))
- program: account for reduce only when checking margin in trigger order ([#583](https://github.com/drift-labs/protocol-v2/pull/583))
- program: use per_lp_base_unit for calculating base imbalance for lp jit ([#604](https://github.com/drift-labs/protocol-v2/pull/604))

### Breaking

## [2.38.0] - 2023-08-25

### Features

- program: add reduce only user status ([#560](https://github.com/drift-labs/protocol-v2/pull/560))
- program: add conditionally smaller conf_component logic for amm spread ([#577](https://github.com/drift-labs/protocol-v2/pull/577))
- program: add per_lp_base on market/position ([#568](https://github.com/drift-labs/protocol-v2/pull/568))

### Fixes

- program: add update_lp_market_position test for big k ([#565](https://github.com/drift-labs/protocol-v2/pull/565))
- sdk: fixed divide by 0 bug in withdraw amount when asset weight is 0 ([#572](https://github.com/drift-labs/protocol-v2/pull/572))

### Breaking

## [2.37.0] - 2023-08-02

### Features

- program: add deposit_into_spot_market_revenue_pool ([#520](https://github.com/drift-labs/protocol-v2/pull/520))
- program: make users w excessive withdraws pay fees ([#547](https://github.com/drift-labs/protocol-v2/pull/547))
- program: allow settle pnl and spot fills via match when utilization is 100% ([#525](https://github.com/drift-labs/protocol-v2/pull/525))
- program: new update_perp_bid_ask_twap ix ([#548](https://github.com/drift-labs/protocol-v2/pull/548))
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
