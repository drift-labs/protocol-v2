if [ "$1" != "--skip-build" ]
  then
    anchor build &&
    cp target/idl/drift.json sdk/src/idl/
fi

test_files=(liquidityProvider.ts)

for test_file in ${test_files[@]}; do
  ANCHOR_TEST_FILE=${test_file} anchor test --skip-build || exit 1;
done
