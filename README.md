<div align="center">
  <img height="120x" src="https://uploads-ssl.webflow.com/611580035ad59b20437eb024/616f97a42f5637c4517d0193_Logo%20(1)%20(1).png" />

  <h1 style="margin-top:20px;">Drift Protocol v2</h1>

  <p>
    <a href="https://docs.drift.trade/developer-resources/sdk-documentation"><img alt="Docs" src="https://img.shields.io/badge/docs-tutorials-blueviolet" /></a>
    <a href="https://discord.com/channels/849494028176588802/878700556904980500"><img alt="Discord Chat" src="https://img.shields.io/discord/889577356681945098?color=blueviolet" /></a>
    <a href="https://opensource.org/licenses/Apache-2.0"><img alt="License" src="https://img.shields.io/github/license/project-serum/anchor?color=blueviolet" /></a>
  </p>
</div>

# Drift Protocol v2

This repository provides open source access to Drift V2's Typescript SDK, Solana Programs, and more.

# SDK Guide

SDK docs can be found [here](./sdk/README.md)

# Example Bot Implementations

Example bots (makers, liquidators, fillers, etc) can be found [here](https://github.com/drift-labs/keeper-bots-v2)

# Building Locally

Note: If you are running the build on an Apple computer with an M1 chip, please set the default rust toolchain to `stable-x86_64-apple-darwin`

```bash
rustup default stable-x86_64-apple-darwin
```

## Compiling Programs

```bash
# build v2
anchor build
# install packages
yarn
# build sdk
cd sdk/ && yarn && yarn build && cd ..
```

## Running Rust Test

```bash
cargo test
```

## Running Javascript Tests

```bash
bash test-scripts/run-anchor-tests.sh
```

# Bug Bounty

Information about the Bug Bounty can be found [here](./bug-bounty/README.md)
