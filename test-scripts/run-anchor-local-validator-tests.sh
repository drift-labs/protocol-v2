if [ "$1" != "--skip-build" ]; then
  anchor build -- --features anchor-test &&
    cp target/idl/drift.json sdk/src/idl/
fi

export ANCHOR_WALLET=~/.config/solana/id.json

test_files=(
  placeAndMakeSwiftPerp.ts
)


for test_file in ${test_files[@]}; do
  export ANCHOR_TEST_FILE=${test_file} && anchor test --skip-build || exit 1
done