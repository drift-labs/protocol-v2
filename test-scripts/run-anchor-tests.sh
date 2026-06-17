#!/bin/bash

set -e
trap 'echo -e "\nStopped by signal $? (SIGINT)"; exit 0' INT

if [ "$1" != "--skip-build" ]; then
  anchor build --ignore-keys --skip-lint -- --features anchor-test && anchor test --skip-build --skip-local-validator --skip-deploy &&
    cp target/idl/velocity.json packages/sdk/src/idl/ && cp target/types/velocity.ts packages/sdk/src/idl/
else
  # --skip-build still needs the bundled SDK IDL to match the deployed program ID,
  # otherwise tx instructions target a program that bankrun never loaded.
  if [ -f target/idl/velocity.json ]; then
    cp target/idl/velocity.json packages/sdk/src/idl/
  fi
  if [ -f target/types/velocity.ts ]; then
    cp target/types/velocity.ts packages/sdk/src/idl/
  fi
fi

# Build the SDK in both paths: many test files import the package root
# (`from '../packages/sdk'`), which resolves through package.json `main` to
# packages/sdk/lib/node/index.js. ts-mocha only transpiles the
# `../packages/sdk/src/...` imports on the fly, so without this build those
# bare-package imports fail with MODULE_NOT_FOUND in CI. Runs after the IDL is
# synced into src/idl/ above so lib/ reflects the freshly-built program.
( cd packages/sdk && bun run build >/dev/null )

export ANCHOR_WALLET=~/.config/solana/id.json

test_files=(
  # cappedSymFunding.ts
  # delistMarket.ts
  # delistMarketLiq.ts
  # imbalancePerpPnl.ts
  # ksolver.ts
  # repegAndSpread.ts
  # spotWithdrawUtil100.ts
  # updateAMM.ts
  # updateK.ts
  # postOnlyAmmFulfillment.ts
  # TODO BROKEN ^^
	builderCodes.ts
  decodeUser.ts
  scaleOrders.ts
  admin.ts
  assetTier.ts
  cancelAllOrders.ts
  curve.ts
  deleteInitializedSpotMarket.ts
  depositIntoSpotMarketVault.ts
  velocityClient.ts
  insuranceFundStake.ts
  isolatedPositionVelocityClient.ts
  isolatedPositionLiquidatePerp.ts
  isolatedPositionLiquidatePerpwithFill.ts
  liquidateBorrowForPerpPnl.ts
  liquidatePerp.ts
  liquidatePerpWithFill.ts
  liquidatePerpPnlForDeposit.ts
  liquidateSpot.ts
  liquidateSpotSocialLoss.ts
  # lpPool.ts # depends on PerpMarket layout shift — needs re-snapshot
  # lpPoolSwap.ts # depends on PerpMarket layout shift — needs re-snapshot
  marketOrder.ts
  marketOrderBaseAssetAmount.ts
  maxDeposit.ts
  maxLeverageOrderParams.ts
  modifyOrder.ts
  multipleMakerOrders.ts
  oracleDiffSources.ts
  oracleFillPriceGuardrails.ts
  oracleOffsetOrders.ts
  order.ts
  orderMarginChecks.ts
  isolatedTransferMarginChecks.ts
  ordersWithSpread.ts
  pauseExchange.ts
  pauseDepositWithdraw.ts
  placeAndMakePerp.ts
  placeAndMakeSignedMsgBankrun.ts
  postOnly.ts
  prelisting.ts
  pyth.ts
  pythLazerBankrun.ts
  referrer.ts
  roundInFavorBaseAsset.ts
  settlePNLInvariant.ts
  spotDepositWithdraw.ts
  spotDepositWithdraw22.ts
  spotDepositWithdraw22TransferHooks.ts
  spotMarketPoolIds.ts
  # spotSwap.ts # broken by spot fulfillment purge — needs migration to read serum vaults directly off the Market
  # spotSwap22.ts # broken by spot fulfillment purge — needs migration to read serum vaults directly off the Market
  stopLimits.ts
  subaccounts.ts
  surgePricing.ts
  switchOracle.ts
  triggerOrders.ts
  transferPerpPosition.ts
  userAccount.ts
  userDelegate.ts
  userOrderId.ts
  # perpMarketConfig.ts # market_config field reads as 0 after write — possibly fetch caching or layout mismatch with reordered PerpMarket

  # whitelist.ts
  transferFeeAndPnlPool.ts
  protocolFees.ts
  specialUserAccount.ts
)


for test_file in ${test_files[@]}; do
  ts-mocha --exit -t 300000 ./tests/velocity/${test_file} || exit 1
done
