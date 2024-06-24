if [ "$1" != "--skip-build" ]; then
  anchor build -- --features anchor-test &&
    cp target/idl/drift.json sdk/src/idl/
fi

test_files=(
  admin.ts
  assetTier.ts
  cancelAllOrders.ts
  # cappedSymFunding.ts
  curve.ts
  deleteInitializedSpotMarket.ts
  # delistMarket.ts
  # delistMarketLiq.ts
  driftClient.ts
  fillSpot.ts
  # imbalancePerpPnl.ts
  insuranceFundStake.ts
  # ksolver.ts
  liquidateBorrowForPerpPnl.ts
  liquidateMaxLps.ts
  liquidatePerp.ts
  liquidatePerpAndLp.ts
  liquidatePerpPnlForDeposit.ts
  liquidateSpot.ts
  liquidateSpotSocialLoss.ts
  liquidityProvider.ts
  marketOrder.ts
  marketOrderBaseAssetAmount.ts
  maxDeposit.ts
  maxLeverageOrderParams.ts
  modifyOrder.ts
  multipleMakerOrders.ts
  multipleSpotMakerOrders.ts
  oracleFillPriceGuardrails.ts
  oracleOffsetOrders.ts
  order.ts
  ordersWithSpread.ts
  pauseExchange.ts
  perpLpJit.ts
  perpLpRiskMitigation.ts
  phoenixTest.ts
  placeAndMakePerp.ts
  placeAndMakeSpotOrder.ts
  postOnly.ts
  postOnlyAmmFulfillment.ts
  prelisting.ts
  pyth.ts
  pythPull.ts
  referrer.ts
  # repegAndSpread.ts
  roundInFavorBaseAsset.ts
  serumTest.ts
  spotDepositWithdraw.ts
  spotSwap.ts
  # spotWithdrawUtil100.ts
  stopLimits.ts
  subaccounts.ts
  surgePricing.ts
  switchboardTxCus.ts
  switchOracle.ts
  tradingLP.ts
  triggerOrders.ts
  triggerSpotOrder.ts
  # updateAMM.ts
  # updateK.ts
  userAccount.ts
  userDelegate.ts 
  userOrderId.ts
  whitelist.ts
)


for test_file in ${test_files[@]}; do
  export ANCHOR_TEST_FILE=${test_file} && anchor test --skip-build || exit 1
done
