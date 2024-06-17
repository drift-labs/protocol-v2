if [ "$1" != "--skip-build" ]
  then
    anchor build  -- --features anchor-test &&
    cp target/idl/drift.json sdk/src/idl/
fi

test_files=(switchboardTxCus.ts)

for test_file in ${test_files[@]}; do
  SBF_OUT_DIR=/target/deploy ANCHOR_TEST_FILE=${test_file} anchor test --skip-build || exit 1;
done
