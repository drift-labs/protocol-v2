# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Features

### Fixes

### Breaking

## [2.64.0] - 2023-02-20

### Features

- program: make derived auction start more passive ([#890](https://github.com/drift-labs/protocol-v2/pull/890))

### Fixes

### Breaking

## [2.63.0] - 2023-02-16

### Features

- program: longer derived auction durations for contract tier B and safer ([#889](https://github.com/drift-labs/protocol-v2/pull/889)) 
- program: always try update market order auction durations ([#882](https://github.com/drift-labs/protocol-v2/pull/882))
- program: amm drawdown check ([#865](https://github.com/drift-labs/protocol-v2/pull/865))
- program: relax oracle guardrail validity check for init margin calc for positive pnl ([#876](https://github.com/drift-labs/protocol-v2/pull/876))
- program: add more max spread baselines ([#858](https://github.com/drift-labs/protocol-v2/pull/858))

### Fixes

- sdk: fix bug in changeWallet that doesn't reset the user stats account if switching from a wallet with drift account to one without

### Breaking

## [2.62.0] - 2023-02-14

### Features

- program: more continuous calculation for calculate_jit_amount ([#882](https://github.com/drift-labs/protocol-v2/pull/882))

### Fixes

### Breaking

## [2.61.0] - 2023-02-09

### Features

- program: better derivation of perp auction params when missing and for triggers ([#869](https://github.com/drift-labs/protocol-v2/pull/869))
- program: calculate whether oracle's num quoters sufficient ([#860](https://github.com/drift-labs/protocol-v2/pull/860))

### Fixes

- program: include derisk lp order action explanation

### Breaking

## [2.60.0] - 2023-02-07

### Features

- program: sanitize perp auction params ([#859](https://github.com/drift-labs/protocol-v2/pull/859))
- program: add repay borrow explanation ([#862](https://github.com/drift-labs/protocol-v2/pull/862))
- program: derisk lp more granularly ([#849](https://github.com/drift-labs/protocol-v2/pull/849))

### Fixes

### Breaking

## [2.59.0] - 2023-01-30

### Features

- program: separate out paused operations from market status ([#839](https://github.com/drift-labs/protocol-v2/pull/839))
- program: use decayed last_oracle_conf_pct as lower bound for update ([#840](https://github.com/drift-labs/protocol-v2/pull/840))

### Fixes

### Breaking

## [2.58.0] - 2023-01-27

### Features

### Fixes

- program: AmmPaused doesnt block all fills

### Breaking

## [2.57.0] - 2023-01-25

### Features

- program: add recenter amm ix ([#836](https://github.com/drift-labs/protocol-v2/pull/836))

### Fixes

### Breaking

## [2.56.0] - 2023-01-24

### Features

### Fixes

- program: enable jit maker to fill same slot as taker placed ([#835](https://github.com/drift-labs/protocol-v2/pull/835))

### Breaking

## [2.55.0] - 2023-01-18

### Features

### Fixes

- program: standardize lp shares in attempt_burn_user_lp_shares_for_risk_reduction ([#826](https://github.com/drift-labs/protocol-v2/pull/826))

### Breaking

## [2.54.0] - 2023-01-15

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
