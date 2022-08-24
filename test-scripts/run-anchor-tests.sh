if [ "$1" != "--skip-build" ]
  then
    anchor build &&
    cp target/idl/clearing_house.json sdk/src/idl/  
fi

test_files=(
  referrer.ts
  liquidityProvider.ts
  liquidatePerpPnlForDeposit.ts liquidateBorrowForPerpPnl.ts
  liquidateBorrow.ts liquidatePerp.ts
  order.ts bankDepositWithdraw.ts prepegMarketOrderBaseAssetAmount.ts
  updateAMM.ts repegAndSpread.ts clearingHouse.ts ordersWithSpread.ts
  marketOrder.ts triggerOrders.ts stopLimits.ts userOrderId.ts postOnly.ts
  roundInFavorBaseAsset.ts marketOrderBaseAssetAmount.ts oracleOffsetOrders.ts
  subaccounts.ts pyth.ts userAccount.ts admin.ts updateK.ts adminWithdraw.ts
  curve.ts idempotentCurve.ts roundInFavor.ts cappedSymFunding.ts
)
for test_file in ${test_files[@]}; do
  export ANCHOR_TEST_FILE=${test_file} && anchor test --skip-build || exit 1;
done