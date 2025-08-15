# setup private company synthetic markets

## Setup

```bash
yarn install   # install sdk dependencies
```

## Local Development

```bash
# run validator first:
solana-test-validator

# then:
yarn ts-node --project scripts/tsconfig.json scripts/setup-localnet.ts

#deploy the anchor program first:
export ANCHOR_WALLET=~/.config/solana/id.json && anchor test --skip-build --run tests/admin.ts
anchor deploy

yarn ts-node --project scripts/tsconfig.json scripts/deploy-complete-system.ts
yarn ts-node --project scripts/tsconfig.json scripts/test-openai-market.ts
yarn ts-node --project scripts/tsconfig.json scripts/test-funding-rates.ts
```

## Network Commands

```bash
yarn ts-node --project scripts/tsconfig.json scripts/initialize-openai-market.ts
SOLANA_CLUSTER=devnet yarn ts-node --project scripts/tsconfig.json scripts/initialize-openai-market.ts
SOLANA_CLUSTER=mainnet yarn ts-node --project scripts/tsconfig.json scripts/initialize-openai-market.ts

yarn ts-node --project scripts/tsconfig.json scripts/setup-openai-oracle.ts
SOLANA_CLUSTER=devnet yarn ts-node --project scripts/tsconfig.json scripts/setup-openai-oracle.ts

yarn ts-node --project scripts/tsconfig.json scripts/test-openai-market.ts
SOLANA_CLUSTER=devnet yarn ts-node --project scripts/tsconfig.json scripts/test-openai-market.ts

yarn ts-node --project scripts/tsconfig.json scripts/test-funding-rates.ts
SOLANA_CLUSTER=devnet yarn ts-node --project scripts/tsconfig.json scripts/test-funding-rates.ts

yarn ts-node --project scripts/tsconfig.json scripts/mock-oracle.ts

yarn ts-node --project scripts/tsconfig.json scripts/deploy-complete-system.ts
SOLANA_CLUSTER=devnet yarn ts-node --project scripts/tsconfig.json scripts/deploy-complete-system.ts
SOLANA_CLUSTER=mainnet yarn ts-node --project scripts/tsconfig.json scripts/deploy-complete-system.ts
```

## Manual Setup

```bash
sh -c "$(curl -sSfL https://release.solana.com/v1.16.0/install)"

cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install latest && avm use latest

solana-keygen new --no-passphrase
export ANCHOR_WALLET=~/.config/solana/id.json

solana-test-validator --detach

# configure and fund
solana config set --url localhost
solana airdrop 2
```
