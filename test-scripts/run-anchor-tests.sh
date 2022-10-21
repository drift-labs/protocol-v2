if [ "$1" != "--skip-build" ]
  then
    anchor build &&
    cp target/idl/clearing_house.json sdk/src/idl/
fi

test_files=(
  repegAndSpread.ts
   clearingHouse.ts
   ordersWithSpread.ts
   marketOrder.ts 
   triggerOrders.ts 
   stopLimits.ts userOrderId.ts postOnly.ts
   placeAndMakeSpotOrder.ts
   roundInFavorBaseAsset.ts
   marketOrderBaseAssetAmount.ts oracleOffsetOrders.ts
   userDelegate.ts subaccounts.ts pyth.ts userAccount.ts 
   admin.ts
   assetTier.ts
   pauseExchange.ts 
   adminWithdraw.ts whitelist.ts
   updateK.ts curve.ts 
   cappedSymFunding.ts
   maxDeposit.ts
   cancelAllOrders.ts
)

for test_file in ${test_files[@]}; do
  export ANCHOR_TEST_FILE=${test_file} && anchor test --skip-build || exit 1;
done