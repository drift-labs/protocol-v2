solana-keygen new -o $(pwd)/anchor.json --silent --force --no-bip39-passphrase && 
export ANCHOR_WALLET=$(pwd)/anchor.json && 
clearinghouse_id=$(cat programs/clearing_house/src/lib.rs | grep declare_id! | tail -n 1) &&
clearinghouse_id=${clearinghouse_id:13:44} && 
pyth_id=$(cat programs/pyth/src/lib.rs | grep declare_id! | tail -n 1) &&
pyth_id=${pyth_id:13:43} && 
~/.local/share/solana/install/releases/1.11.1/solana-release/bin/solana-test-validator -r \
--bpf-program $clearinghouse_id target/deploy/clearing_house.so \
--bpf-program $pyth_id target/deploy/pyth.so \
--mint $(solana-keygen pubkey $ANCHOR_WALLET) \
--geyser-plugin-config ../../solana-accountsdb-plugin-postgres/config.json
