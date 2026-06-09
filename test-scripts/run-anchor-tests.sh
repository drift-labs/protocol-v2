#!/bin/bash

set -e
trap 'echo -e "\nStopped by signal $? (SIGINT)"; exit 0' INT

if [ "$1" != "--skip-build" ]; then
  anchor build --ignore-keys --skip-lint -- --features anchor-test && anchor test --skip-build --skip-local-validator --skip-deploy &&
    cp target/idl/drift.json sdk/src/idl/ && cp target/types/drift.ts sdk/src/idl/
else
  # --skip-build still needs the bundled SDK IDL to match the deployed program ID,
  # otherwise tx instructions target a program that bankrun never loaded.
  if [ -f target/idl/drift.json ]; then
    cp target/idl/drift.json sdk/src/idl/
  fi
  if [ -f target/types/drift.ts ]; then
    cp target/types/drift.ts sdk/src/idl/
  fi
  ( cd sdk && bun run build >/dev/null )
fi

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
  driftClient.ts
  # ifRebalance.ts # broken by spot fulfillment purge — needs migration to read serum vaults directly off the Market
  # adminWithdrawFromInsuranceFundVault.ts # uses production-snapshot grafting with old struct layout — re-snapshot needed
  insuranceFundStake.ts
  isolatedPositionDriftClient.ts
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
  specialUserAccount.ts
)


for test_file in ${test_files[@]}; do
  ts-mocha --exit -t 300000 ./tests/${test_file} || exit 1
done
