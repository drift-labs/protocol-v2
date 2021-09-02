# Moët

## Installation

https://project-serum.github.io/anchor/getting-started/installation.html

```
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
rustup component add rustfmt


sh -c "$(curl -sSfL https://release.solana.com/v1.7.4/install)"

sudo apt-get update && sudo apt-get upgrade && sudo apt-get install -y pkg-config build-essential libudev-dev

cargo install --git https://github.com/project-serum/anchor --tag v0.11.1 anchor-cli --locked
```

## Running Tests

### Install Dependencies

```
yarn global add typescript
yarn global add mocha
yarn global add ts-mocha
yarn install
```

### Run Protocol Tests

```
sh ./scripts/run-anchor-test
```

### Install SDK yarn

```
cd sdk
yarn install
```

### Run Tests w/ new IDL
```
anchor build
cp target/idl/* sdk/src/idl/*
sh ./scripts/run-anchor-test --skip-build
```

### Run Stress Tests
- uses historical market data from the `vAMM` repo (expected in same top directory) for oracles (solUsd)
- simulations are parameterized: 
- - RANDSIM vs loading from a `stress_event_timeline.csv`
- - `numUsers, numMarkets, userCapital, K`
- run and check your `output/` for simulation results
- - `stress_event_timeline.csv` (can be reused to verify/reconcile different backends)
- - `stress_state_timeline.csv` (market/user/clearinghouse state summaries)

```
cd .. &&
git clone https://github.com/MoetFinance/vAMM &&
unzip *.csv.zip &&
cd ../moet &&
anchor test utils/stress.ts
```

### Committing Changes

We use a typescript and rust linter. If it blocks you from committing your changes, try `yarn lint:fix` or `cargo fmt --`

- be sure you've run yarn install under both `/` and `sdk/`
- be sure to stop `solana-test-validator` when commiting and running `yarn lint`

### Deploying

```
anchor launch
```
To modify what network it deploys to, you must edit `Anchor.toml`
