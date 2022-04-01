  test_file=../stress/sim.ts
  export ANCHOR_TEST_FILE=${test_file} && anchor test --skip-build || exit 1;
