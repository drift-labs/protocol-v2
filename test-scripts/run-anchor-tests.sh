if [ "$1" != "--skip-build" ]
  then
    anchor build &&
    cp target/idl/clearing_house.json sdk/src/idl/
fi

test_files=(clearingHouse.ts pyth.ts userAccount.ts admin.ts updateK.ts adminWithdraw.ts curve.ts whitelist.ts fees.ts idempotentCurve.ts maxDeposit.ts deleteUser.ts maxPositions.ts maxReserves.ts roundInFavor.ts minimumTradeSize.ts cappedSymFunding.ts)

for test_file in ${test_files[@]}; do
  export ANCHOR_TEST_FILE=${test_file} && anchor test --skip-build || exit 1;
done