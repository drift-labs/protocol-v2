# Realtime Archiver

## Overview

The Realtime Archiver ingests Drift Protocol events, writes normalized records to DynamoDB, and archives raw/processed files in S3. It has two ingestion paths: sequential (finalized, authoritative) and gRPC (confirmed, low-latency). For more details, see `docs/record-ingestion-backfill.md`.

### Sequential Ingestion

Sequential ingestion incrementally ingests slots from the blockchain. It is unfiltered and fetches all blockchain events. It has mechanisms to offload to async slot ingestion when it falls more than 20 slots behind the tip. State, including current slot, missed, failed and skipped slots are all synced to the realtime-archiver-state table in dynamo. It runs 2 shards to split the workload by odd and even slots.

### Fumarole Ingestion

Fumarole ingestion is an alternative for finalised, authoritative events. It is a new offering from Triton with a mechanism closer to gRPC. It is a subscribable stream which allows us to filter events to drift and drift vault program ids. Asides from promising high availability, the key difference is that it is stateful allowing us to reconnect and resume from a specific slot in the event of service interruptions. The volume of data processed is a lot less and it simplifies state management. In the event ingestion stops beyond the resumable period the consumer group will need to be recreated, which can be triggered by setting START_FROM_TIP=true when starting the process. Should the process fall more than 500 slots behind the tip, it will be force restarted, and the missed slots will be picked up by the slot verifier lambda which trails behind by 1000 slots.

## Entrypoints

-   **Sequential ingestion:** `apps/realtime-archiver/src/index.ts`
-   **Fumarole ingestion:** `apps/realtime-archiver/src/fumarole-ingestion.ts`
-   **gRPC ingestion:** `apps/realtime-archiver/src/grpc-ingestion.ts`
-   **Archiver:** `apps/realtime-archiver/src/archiver.ts`
-   **Async slot ingestion:** `apps/realtime-archiver/src/async-slot-ingestion.ts`
-   **Record ingestion (Lambda):** `apps/realtime-archiver/src/record-ingestion.ts`
-   **Backfill ingestion (Lambda):** `apps/realtime-archiver/src/record-ingestion-backfill.ts`

## Getting Started

### Prerequisites

-   Node.js 20+
-   Yarn
-   AWS credentials configured (see `docs/connecting-to-aws.md`)
-   S3 access for ingestion/archives

### Installation

```bash
yarn install
yarn workspace @backend/realtime-archiver build
```

### Development

```bash
# Sequential ingestion

yarn workspace @backend/realtime-archiver start

# Fumarole ingestion

yarn workspace @backend/realtime-archiver start-fumarole

# gRPC ingestion

yarn workspace @backend/realtime-archiver start-grpc

# Archiver (S3 -> processed archives)

yarn workspace @backend/realtime-archiver archive

# Async slot ingestion

yarn workspace @backend/realtime-archiver async
```

### Best Development Workflow

Iterate using unit tests first:

```bash
yarn test apps/realtime-archiver
```

## Configuration

Environment variables (defaults shown where applicable):

-   `ENV`: Deployment environment (default: `mainnet-beta`)
-   `ENDPOINT`: Solana RPC endpoint
-   `INGESTION_ID`: Required ID for sequential ingestion state
-   `URL`: gRPC base URL (optional; derived from `ENDPOINT`)
-   `TOKEN`: gRPC auth token (optional; derived from `ENDPOINT`)
-   `S3_BUCKET`: Override ingestion/archival bucket
-   `FILTERED_USERS`: Comma-separated users to skip in backfill ingestion
-   `PORT`: Health server port (default: `3000`)
-   `METRICS_PORT`: Prometheus scrape port
-   `MAX_PARALLEL_BATCHES`: Parallelism for DLQ processing
-   `START_FROM_TIP`: Recreates the fumarole consumer group and subscribes from the tip of the blockchain (default: `false`)

## LocalStack E2E (Kinesis -> record-ingestion -> DynamoDB)

1. Start LocalStack and load env:

```bash
./scripts/dev/localstack-up.sh
source scripts/dev/localstack-env.sh
```

2. Start an ingestion producer:

```bash
yarn workspace @backend/realtime-archiver start
# or
yarn workspace @backend/realtime-archiver start-grpc
```

This will push events into the LocalStack Kinesis stream and invoke the record-ingestion Lambda,
which writes to the LocalStack DynamoDB tables.

## Dry Run Mode

The ingestion pipeline supports a code-level dry run flag:

-   `Ingestion({ dryRun: true })` skips sending events to Kinesis and skips state offloads during shutdown.
-   `GrpcEventSubscriber({ dryRun: true })` logs serialized events and does not enqueue them.

There is no environment flag wired for this today; it’s intended for debugging via code changes or tests.

## Credentials and Services

This service depends on AWS (Kinesis, S3, DynamoDB, SQS) and RPC access. For local setup:

-   `docs/connecting-to-aws.md`
