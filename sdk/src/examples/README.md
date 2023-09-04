# Drift Protocol - Examples

Welcome to the examples directory for the Drift Protocol! This README serves as a guide to help you understand how to run and interact with the example code snippets and full projects available in this repository.

## Prerequisites

- Node.js (v14+)
- TypeScript
- `ts-node` package for running TypeScript code
- A Solana wallet
- Basic understanding of smart contracts and the Solana ecosystem

## Installing Dependencies

Before running any example, make sure you install the required dependencies:

```
yarn install
```

## Quick Start

To quickly get started with loading a Drift Protocol LOB (Limit Order Book), you can run:

```
ts-node -T src/examples/loadDlob.ts
```

This script will perform necessary initializations and populate the LOB with sample data.

## Available Examples

### loadDlob.ts

This example demonstrates how to load a limit order book (LOB) in the Drift Protocol. It covers the following steps:

- Initialization of the LOB
- Population with sample orders
- Retrieval of order book data

To run this example, execute:

```
ts-node -T src/examples/loadDlob.ts
```

### logRecentTrades.ts

This example demonstrates how to use the event subscriber.

To run this example, execute:

```
ts-node -T src/examples/logRecentTrades.ts
```


## Note

These examples assume that you have set up your environment variables, such as `RPC_ADDRESS` and `ENVIRONMENT`, according to the main README of the Drift Protocol repository.

## Further Reading

- [Drift Protocol Documentation](https://drift-labs.github.io/v2-teacher/#introduction)
- [Solana Documentation](https://docs.solana.com/)

## Support

For further assistance, you can reach out on our [Discord server](https://discord.com/invite/fMcZBH8ErM) or [file an issue](#) on GitHub.