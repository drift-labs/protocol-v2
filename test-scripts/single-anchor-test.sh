if [ "$1" != "--skip-build" ]
  then
    anchor build --arch sbf &&
    cp target/idl/drift.json sdk/src/idl/
fi

test_files=(order.ts)

for test_file in ${test_files[@]}; do
  SBF_OUT_DIR=/target/deploy ANCHOR_TEST_FILE=${test_file} anchor test --skip-build || exit 1;
done
