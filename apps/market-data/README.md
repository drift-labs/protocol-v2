# Market Data Service

## Overview

The Market Data Service is a system designed to ingest and cache market data for Drift Protocol. It serves as a data bridge between Drift SDKs, Athena, and the Aggregator API by:

1. Fetching market data from Drift SDKs
2. Querying historical data from Athena
3. Storing processed data in Redis for fast retrieval
4. Providing a reliable data source for the Aggregator API

For a detailed system architecture diagram showing how this service integrates with the rest of the Drift Protocol infrastructure, please refer to `system.pdf`.

## Architecture Components

### 1. Data Ingestion

The service handles data ingestion through:

-   Scheduled data ingestion from Drift SDKs
-   Athena queries for historical data
-   Redis caching for fast data access
-   Data transformation and normalization

### 2. Task Scheduler + Pipelines

-   A scheduler coordinates recurring tasks (stats, markets, vaults, analytics)
-   Claim accrual sync tasks can materialize rebate progress into claim records from Athena
-   A trade pipeline consumes trade events from SQS and updates leaderboard/volume
-   Tasks are exposed via the local control API for ad-hoc runs

## Tech Stack

-   Node.js 20+
-   TypeScript
-   Drift SDK + Vaults SDK
-   AWS Services:
    -   Athena for data querying
    -   SQS for trade pipeline ingestion
    -   Redis (Elasticache) for caching
-   Docker for containerization
-   OpenTelemetry/Prometheus metrics

## Getting Started

### Prerequisites

-   Node.js 20+
-   Yarn
-   AWS credentials configured (see `docs/connecting-to-aws.md`)
-   Redis/ElastiCache access (see `docs/connecting-to-elasticache.md`)

### Installation

```bash
yarn install
yarn workspace @backend/market-data build
```

### Development

Start the task runner:

```bash
yarn workspace @backend/market-data start-tasks
```

Start a specific task:

```bash
TASK=tokens yarn workspace @backend/market-data start-tasks
```

### Building

```bash
yarn workspace @backend/market-data build
```

### Best Development Workflow

The best way to develop on this service is to iterate with unit tests first:

```bash
yarn test apps/market-data
```

## Configuration

Environment variables (defaults shown where applicable):

-   `ENV`: Deployment environment (default: `mainnet-beta`)
-   `ENDPOINT`: Solana RPC endpoint (falls back to the default in `@backend/common`)
-   `APP_STAGE`: Stage label used by Prometheus tasks (default: `mainnet-beta`)
-   `PORT`: Health/API server port (default: `3000`)
-   `METRICS_PORT`: Prometheus scrape port (defaults to the OpenTelemetry exporter default)
-   `REDIS_URL`: Redis connection URL
-   `ORDERBOOK_REDIS_URL`: Optional Redis URL for orderbook data
-   `ATHENA_DATABASE`: Athena database name
-   `ATHENA_OUTPUT_BUCKET`: S3 bucket for Athena output
-   `VERIFY_TYPES`: Comma-separated leaderboard verify types (`pnl`, `volume`, `fees`)
-   `ENABLE_LEADERBOARD`: Feature flag for leaderboard processing (`true`/`false`)
-   `SQS_QUEUE_URL`: SQS queue used by the trade pipeline

The accrual claim campaigns themselves are currently hardcoded in
[claims.ts](/Users/jackwaller/infrastructure-v3/apps/market-data/src/tasks/claims.ts).

## Credentials and Services

This service depends on AWS (Athena/S3/SQS) and Redis for normal operation. For local setup:

-   `docs/connecting-to-aws.md`
-   `docs/connecting-to-elasticache.md`
