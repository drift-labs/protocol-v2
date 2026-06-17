# Notification Engine

## Overview

The Notification Engine processes Drift Protocol events and delivers notifications through multiple providers (Dialect, Firebase, Redis). It consumes SNS/SQS messages for price alerts, account updates, and record updates. For the full system workflow, see `docs/notification-system.md`.

## Entrypoints

-   **Lambda handler**: `apps/notification-engine/src/index.ts` (processes SNS-wrapped SQS messages)
-   **Risk manager**: `apps/notification-engine/src/risk-manager.ts` (risk evaluation + notification queue processing)
-   **Update stream**: `apps/notification-engine/src/update-stream.ts` (publishes per-user updates to Redis)
-   **Oracle feed**: `apps/notification-engine/src/oracle-feed.ts` (streams oracle updates and publishes price alerts to SNS)

## Getting Started

### Prerequisites

-   Node.js 20+
-   Yarn
-   AWS credentials configured (see `docs/connecting-to-aws.md`)
-   Redis/ElastiCache access if using Redis notifications (see `docs/connecting-to-elasticache.md`)

### Installation

```bash
yarn install
yarn workspace @backend/notification-engine build
```

### Development

Run the core services locally:

```bash
# Risk manager

yarn workspace @backend/notification-engine risk-manager

# Oracle feed

yarn workspace @backend/notification-engine oracle-feed

# Update stream (optional)

yarn workspace @backend/notification-engine ts-node src/update-stream.ts
```

### Best Development Workflow

Iterate using unit tests first:

```bash
yarn test apps/notification-engine
```

## Configuration

Environment variables (defaults shown where applicable):

**General**

-   `ENV`: Deployment environment (default: `mainnet-beta`)
-   `ENDPOINT`: Solana RPC endpoint (falls back to the default in `@backend/common`)
-   `PORT`: HTTP server port (default: `3000`)
-   `METRICS_PORT`: Prometheus scrape port (defaults to the OpenTelemetry exporter default)

**Notification delivery / dry-run**

-   `NOTIFICATION_SENDING_ENABLED`: Set to `true` to send live notifications
-   `NOTIFICATION_WHITELIST_AUTHORITIES`: Comma-separated authorities allowed to receive notifications in dry-run
-   `NOTIFICATION_COOLDOWN_SECONDS`: Cooldown between notifications
-   `MAX_NOTIFICATION_AGE_SECONDS`: Max age for account notifications (seconds)
-   `MAX_RECORD_AGE_SECONDS`: Max age for record-based notifications (seconds)

**Queues / batching**

-   `SQS_QUEUE_URL`: Default SQS queue for processors
-   `NOTIFICATION_QUEUE`: Override SQS queue for risk manager enqueue
-   `BATCH_SIZE`: SQS batch size (default: `10`)
-   `MAX_PARALLEL_BATCHES`: Parallel batch count (default: `1` or `5` depending on service)
-   `UPDATE_MAX_PER_FLUSH`: Max updates per Redis publish flush (default: `100`)
-   `USER_RISK_MIN_INTERVAL_MS`: Minimum ms between risk updates per user (default: `3000`)

**Oracle feed (price alerts)**

-   `URL`: gRPC stream base URL (optional; derived from `ENDPOINT`)
-   `TOKEN`: gRPC auth token (optional; derived from `ENDPOINT`)
-   `PRICE_THRESHOLD`: Fractional price change threshold (default: `0.001`)
-   `MIN_UPDATE_INTERVAL`: Min seconds between updates per oracle (default: `5`)
-   `SNS_TOPIC_ARN`: SNS topic for price alerts (defaults to `DEFAULT_SNS_TOPIC`)
-   `SNS_FIFO_TOPIC_ARN`: FIFO SNS topic for price alerts (if used)

**Providers**

-   `REDIS_URL`: Redis connection URL (enables Redis provider)
-   `DIALECT_ENVIRONMENT`: Dialect env (default: `development`)
-   `DIALECT_SDK_CREDENTIALS`: Dialect SDK credentials JSON
-   `DEFAULT_DIALECT_NOTIFICATION_TYPE_ID`: Dialect default notification type
-   `FIREBASE_PROJECT_ID`: Firebase project ID
-   `FIREBASE_CLIENT_EMAIL`: Firebase client email
-   `FIREBASE_PRIVATE_KEY`: Firebase private key

**Risk auditor**

-   `ALERT_SUMMARY`: Set to `true` to emit summary alerts

## Credentials and Services

This service depends on AWS (SNS/SQS/DynamoDB), Redis (Elasticache), and optional provider credentials (Dialect/Firebase). For local setup, see:

-   `docs/connecting-to-aws.md`
-   `docs/connecting-to-elasticache.md`
-   `docs/notification-system.md`
