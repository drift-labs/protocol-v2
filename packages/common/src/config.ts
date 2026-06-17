// force
export const DEFAULT_DYNAMO_TABLE = 'staging-record-db';
export const DEFAULT_STATE_TABLE = 'staging-realtime-archiver-state';
export const DEFAULT_SNAPSHOT_TABLE = 'staging-snapshots';
export const DEFAULT_ANALYTICS_TABLE = 'staging-analytics';
export const DEFAULT_CANDLE_TABLE = 'staging-candles';
export const DEFAULT_REALTIME_ARCHIVER_TABLE = 'staging-realtime-archiver-stream';
export const DEFAULT_KINESIS_STREAM = 'staging-realtime-archiver-stream';
export const DEFAULT_SQS_QUEUE =
	'https://sqs.eu-west-1.amazonaws.com/011528263343/trade-pipeline-queue.fifo';
export const DEFAULT_ENDPOINT =
	'https://drift-cranking-lb.rpcpool.com/f1ead98714b94a67f82203cce918';
export const DEFAULT_S3_BUCKET = 'staging-data-ingestion-bucket';
export const DEFAULT_REDIS_CLIENT = 'redis://localhost:63790';
export const DEFAULT_SNS_TOPIC = 'arn:aws:sns:eu-west-1:011528263343:staging-notifications';
export const DEFAULT_ATHENA_DATABASE = 'staging-archive';
export const DEFAULT_ATHENA_OUTPUT_BUCKET = 'staging-data-ingestion-bucket';
export const DEFAULT_PROM_URL = 'http://localhost:50000/prometheus';
export const RECORD_TTL_DAYS = 31;
export const NOTIFICATION_RECORD_DELETE_TTL_DAYS = 60;
export const GRPC_RECORD_TTL_MINS = 5;
export const RECORD_DELETE_TTL_DAYS = 5;
