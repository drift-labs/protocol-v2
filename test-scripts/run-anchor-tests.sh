if [ "$1" != "--skip-build" ]; then
  anchor build -- --features anchor-test && anchor test --skip-build &&
    cp target/idl/drift.json sdk/src/idl/
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
  admin.ts
  assetTier.ts
  cancelAllOrders.ts
  curve.ts
  deleteInitializedSpotMarket.ts
  driftClient.ts
  fillSpot.ts
  insuranceFundStake.ts
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
  prelisting.ts
  pyth.ts
  pythPull.ts
  referrer.ts
  roundInFavorBaseAsset.ts
  serumTest.ts
  spotDepositWithdraw.ts
  spotSwap.ts
  stopLimits.ts
  subaccounts.ts
  surgePricing.ts
  switchboardTxCus.ts
  switchOracle.ts
  tradingLP.ts
  triggerOrders.ts
  triggerSpotOrder.ts
  userAccount.ts
  userDelegate.ts 
  userOrderId.ts
  whitelist.ts
)


for test_file in ${test_files[@]}; do
  ts-mocha -t 300000 ./tests/${test_file} || exit 1
done
cargo test --test integration