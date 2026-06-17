# Aggregator API

## Overview

The Aggregator API is a Fastify service that exposes a unified API for Drift Protocol data (market, user, stats, and notifications) and transaction-building endpoints. It can run locally as a web server or be deployed as an AWS Lambda (API Gateway) handler, and it ships with Swagger UI for exploration.

Swagger UI (local): http://localhost:3000/playground
OpenAPI JSON (local): http://localhost:3000/openapi.json

## API Surface

High-level route groups (see Swagger for full schemas):

-   `/market/*` market data (candles, trades, funding rates, swaps, deposits, rewards, insurance fund, insurance fund stake)
-   `/user/*` user history (deposits, rewards, funding payments, liquidations, LP, orders, predictions, settle PnL, swaps, trades, positions, snapshots)
-   `/stats/*` system stats (liquidations, bankruptcies, vaults, markets, funding rates, insurance fund, DLP, leaderboard, rates)
-   `/authority/*` authority-level data and snapshots
-   `/notifications/*` notifications and device registration (requires Solana auth headers)
-   `/tx/*` transaction construction/simulation (gated by feature flags; see Configuration)

## Features

-   REST endpoints for user, market, stats, notifications, authority, and tx flows
-   CSV response support for selected endpoints
-   Swagger UI documentation at `/playground`
-   OpenAPI JSON at `/openapi.json`
-   Automatic compression (br, gzip, deflate)
-   CORS enabled
-   Centralized error handling with structured logging

## Tech Stack

-   Node.js 20+
-   TypeScript + Fastify
-   AWS Lambda + API Gateway
-   DynamoDB, Redis, S3 (via internal packages)
-   Drift SDK
-   Swagger/OpenAPI

## Getting Started

### Prerequisites

-   Node.js 20+
-   Yarn
-   AWS credentials configured (see `docs/connecting-to-aws.md`)

### Installation

```bash
yarn install

yarn workspaces run build
```

### Development

To start the app in development mode:

```bash
yarn workspace @backend/aggregator-api dev
```

This will:

1. Build the TypeScript files
2. Watch for changes
3. Run the server locally at http://localhost:3000

You can also run directly from the package directory:

```bash
cd apps/aggregator-api
yarn dev
```

### Best Development Workflow

The best way to develop on this service is to iterate with unit tests first. Run the unit tests as your primary feedback loop before starting the server:

```bash
yarn test apps/aggregator-api
```

### Building

```bash
yarn workspace @backend/aggregator-api build
```

### Production

For production deployment:

```bash
yarn start
```

## Configuration

The API can be configured through environment variables (defaults shown where applicable):

-   `RUNNING_LOCAL`: If set to `false`, requests must include `x-origin-verify` header (see Authentication)
-   `AGGREGATOR_API_SECRET`: Shared secret used to validate the `x-origin-verify` header
-   `ENV`: Drift environment (`mainnet-beta` by default)
-   `ENDPOINT`: Solana RPC endpoint (falls back to the default endpoint in `@backend/common`)
-   `CACHE_PROXY_FUNCTION_NAME`: Optional Lambda function name for cache proxy reads (candles/stats/markets/leaderboard)
-   `ENABLE_ONCHAIN_ENDPOINTS`: Feature flag for `/tx` on-chain endpoints (default `true`)
-   `ENABLE_FEE_PAYER`: Feature flag for `/tx/fee` endpoints (default `true`)
-   `FEE_PAYER_PRIVATE_KEY`: Fee payer key for `/tx/fee`
-   `FEE_PAYER_ROUTE_DISABLED`: Set to `true` to disable `/tx/fee` even if the feature flag is enabled
-   `PRIVY_APP_ID`: Privy app ID (required for `/tx/fee`)
-   `PRIVY_APP_SECRET`: Privy app secret (required for `/tx/fee`)
-   `PRIVY_VERIFICATION_KEY`: Privy verification key (optional, used for token verification)
-   `PRIORITY_FEE_LIMIT`: Optional upper bound for priority fee calculation

The service also relies on AWS credentials and backing stores (DynamoDB, Redis, S3) for data access.
For local access instructions, see:

-   `docs/connecting-to-aws.md`
-   `docs/connecting-to-elasticache.md`

## Cache Proxy (ElastiCache Access)

This service optionally reads from Redis/ElastiCache for candles, stats, markets, and leaderboard data. In production, the Aggregator API runs as a Lambda **outside** the VPC, while ElastiCache sits **inside** the VPC and is not directly reachable from the Lambda network. The cache-proxy exists to bridge that gap.

### Why it exists

-   Lambda is deployed outside the VPC for faster cold-starts and simplified networking.
-   ElastiCache is inside the VPC and cannot be accessed from that Lambda directly.
-   A separate “cache-proxy” Lambda **inside** the VPC can access ElastiCache and return cached results.

### How it works

-   If `CACHE_PROXY_FUNCTION_NAME` is **not** set, the Aggregator API reads directly from Redis using `@backend/redis`.
-   If `CACHE_PROXY_FUNCTION_NAME` **is** set, the API invokes the cache-proxy Lambda and forwards a small request payload (e.g. `getCandlesForResolution`, `getLeaderboard`, `getMarketSummary`).
-   The cache-proxy Lambda performs the Redis query inside the VPC and returns the results to the Aggregator API.

## Testing

Tests live under `apps/aggregator-api/test`. Run all tests from the repo root:

```bash
yarn test
```

To run only Aggregator API tests:

```bash
yarn test apps/aggregator-api
```

## Contributing

1. Create a feature branch from `master`
2. Make your changes
3. Run tests: `yarn test`
4. Submit a PR for review
