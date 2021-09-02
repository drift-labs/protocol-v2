if [ "$1" != "--skip-build" ]
  then
    anchor build &&
    cp target/idl/clearing_house.json sdk/src/idl/
fi

anchor test --skip-build tests/clearingHouse.spec.ts &&
anchor test --skip-build tests/pyth.spec.ts &&
anchor test --skip-build tests/userAccount.spec.ts &&
anchor test --skip-build tests/mockUSDCFaucet.spec.ts