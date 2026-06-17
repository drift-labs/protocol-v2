# Candle Service

## Overview

The Candle Service is a distributed system designed to process and serve real-time candlestick data for Drift Protocol markets. It handles both finalized and real-time trade data to generate accurate OHLCV (Open, High, Low, Close, Volume) candles across multiple timeframes.

## Features

-   Multiple resolution support:
    -   1 minute
    -   5 minutes
    -   15 minutes
    -   1 hour
    -   4 hours
    -   1 day
    -   1 week
    -   1 month
-   Real-time candle updates via WebSocket
-   Historical candle data storage
-   Support for both spot and perpetual markets
-   Automatic empty candle generation
-   Data consistency checks and recovery
-   Prometheus metrics integration
-   Dual processor modes (gRPC vs finalized) for low-latency updates + authoritative storage

## Architecture Components

### 1. Candle Processor

The candle processor is responsible for:

-   Processing finalized trade data
-   Creating and updating candle records
-   Empty candle generation for periods without trades
-   Data validation and consistency checks

### 2. WebSocket Server

Provides real-time market data with:

-   Client subscription management
-   Real-time candle updates
-   Connection health monitoring
-   Metrics tracking

### 3. Cache Management

Handles data caching and synchronization:

-   Redis cache for real-time data
-   DynamoDB for persistent storage
-   Background sync processes
-   Data recovery mechanisms

## Processor Modes (gRPC vs Finalized)

There are two processor modes, controlled by `IS_GRPC`:

### Finalized processor (`IS_GRPC=false`)

-   Consumes **finalized** trade/oracle messages (sequential ingestion) from SQS
-   Writes candles to DynamoDB (source of truth)
-   Sends failed messages to the DLQ (`CANDLE_DLQ_URL`) when configured

### gRPC processor (`IS_GRPC=true`)

-   Consumes **confirmed** trade/oracle messages from the gRPC ingestion stream (separate queue)
-   Writes candles to Redis for low-latency reads (not the source of truth)
-   Publishes buffered updates to Redis channels for WebSocket subscribers
-   Runs `CandleSync` periodically to backfill/cache finalized data from DynamoDB

### Why both exist

-   **Confirmed** data is not guaranteed to have executed on-chain (reorgs can drop it).
-   **gRPC** provides low-latency updates for UI/clients using confirmed data.
-   **Finalized** provides the authoritative, durable candle history.
-   The periodic sync reconciles Redis with finalized data so cached candles stay accurate.

## Tech Stack

-   Node.js 20+
-   TypeScript
-   Redis (Elasticache)
-   DynamoDB
-   AWS SQS
-   Docker
-   OpenTelemetry for metrics

## Infrastructure

The service utilizes several AWS services:

-   EKS for container orchestration
-   DynamoDB for persistent storage
-   Redis (Elasticache) for real-time data
-   SQS for message processing
-   CloudWatch for monitoring

## Getting Started

### Prerequisites

-   Node.js 20+
-   Yarn
-   AWS credentials configured for DynamoDB/SQS access (see `docs/connecting-to-aws.md`)
-   Redis/ElastiCache access for candle cache + WebSocket streams (see `docs/connecting-to-elasticache.md`)

### Installation

```bash
yarn install

yarn workspaces run build
```

### Running Locally

Start the candle processor:

```bash
yarn workspace @backend/candles start
```

Run the processor in gRPC mode:

```bash
IS_GRPC=true yarn workspace @backend/candles start
```

Start the WebSocket server:

```bash
yarn workspace @backend/candles start-ws
```

Test WebSocket connections:

```bash
yarn workspace @backend/candles listen-ws
```

### Building

```bash
yarn workspace @backend/candles build
```

### Configuration

Environment variables:

-   `ENV`: Deployment environment (default: `mainnet-beta`)
-   `ENDPOINT`: Solana RPC endpoint (falls back to the default in `@backend/common`)
-   `IS_GRPC`: Enable gRPC processor mode (`true`/`false`)
-   `PORT`: Health/WS server port (default: `3000`)
-   `METRICS_PORT`: Prometheus scrape port (defaults to the OpenTelemetry exporter default)
-   `MAX_PARALLEL_BATCHES`: Maximum parallel SQS batches processed at once
-   `CANDLE_DLQ_URL`: Dead letter queue URL for failed messages (finalized mode)
-   `CANDLE_TABLE`: Override DynamoDB table name for candle storage
-   `SYNC_SIZE`: Max candles per symbol/resolution during sync (default: `250`)
-   `WHITELISTED_MARKETS`: Comma-separated symbols to include (optional)
-   `BLACKLISTED_MAKERS`: Comma-separated makers to exclude (optional)
-   `MAX_PRICE_DEVIATION_PCT`: Max allowed price deviation (default: `3`)
-   `MIN_NOTIONAL_VALUE`: Minimum notional for a trade (default: `250`)
-   `REDIS_URL`: Redis connection URL
-   `ORDERBOOK_REDIS_URL`: Optional Redis URL for orderbook channels (ws-multi-redis)
-   `USERMAP_REDIS_URL`: Optional Redis URL for usermap channels (ws-multi-redis)

## Credentials and Services

This service relies on AWS (DynamoDB/SQS) and Redis for normal operation. For local setup, follow:

-   `docs/connecting-to-aws.md`
-   `docs/connecting-to-elasticache.md`

## Best Development Workflow

The best way to develop on this service is to iterate with unit tests first. Run the unit tests as your primary feedback loop before running the processors:

```bash
yarn test apps/candles
```

## Data Flow

1. Trade/oracle events received through SQS
2. Candle processor generates/updates candle records
3. Finalized mode writes to DynamoDB; gRPC mode writes to Redis
4. Redis publishes updates to WebSocket clients
5. CandleSync (gRPC mode) periodically reconciles Redis with finalized candles

## WebSocket API

Connect to the WebSocket server and subscribe to candle updates:

```json
{
	"type": "subscribe",
	"symbol": "SOL-PERP",
	"resolution": "1"
}
```

Available resolutions: "1", "5", "15", "60", "240", "D", "W", "M"

Channel-based subscriptions are also supported:

```json
{
	"type": "subscribe",
	"channelType": "markets"
}
```

Supported `channelType` values: `candle`, `volume`, `markets`, `pricing`.

## Contributing

1. Create a feature branch from `master`
2. Make your changes
3. Run tests: `yarn test`
4. Submit a PR for review
