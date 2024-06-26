if [ "$1" != "--skip-build" ]
  then
    anchor build -- --features anchor-test &&
    cp target/idl/drift.json sdk/src/idl/
fi

test_files=(maxDeposit.ts)

ts-mocha --parallel -t 300000 "${test_files[@]/#/./tests/}" || exit 1