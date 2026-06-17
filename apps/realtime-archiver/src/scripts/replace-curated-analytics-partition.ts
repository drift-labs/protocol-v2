import { Athena } from '@backend/athena';
import { DEFAULT_S3_BUCKET, logger, RecordTypes } from '@backend/common';
import { S3 } from '@backend/s3';
import Bottleneck from 'bottleneck';
import { Archiver } from '../services/archive';
import { publishCuratedRecords } from '../services/analytics-publisher';

type SupportedRecordType = RecordTypes.TradeRecord | RecordTypes.DepositRecord;

const DEFAULT_SOURCE = 'seq';
const PROCESSED_ROOT = 'processed_files';
const ANALYTICS_TABLES: Record<SupportedRecordType, string> = {
	[RecordTypes.TradeRecord]: 'curated_traderecords',
	[RecordTypes.DepositRecord]: 'curated_depositrecords',
};

const usage = () =>
	[
		'Usage:',
		'  replace-curated-analytics-partition.ts --date YYYY-MM-DD [options]',
		'',
		'Options:',
		'  --date <YYYY-MM-DD>              Partition date to replace',
		'  --record-type <TradeRecord[,DepositRecord]>',
		'                                   Record types to replace (default: TradeRecord,DepositRecord)',
		'  --source-bucket <name>           Source archive bucket (defaults to S3_BUCKET or DEFAULT_S3_BUCKET)',
		'  --help                           Show this message',
		'',
		'This command always replaces the curated partition by:',
		'  1. deleting S3 objects under dt=<date> for the analytics table',
		'  2. dropping the Athena partition',
		'  3. replaying sequential processed files for the same day into analytics streams',
	].join('\n');

const getArg = (args: string[], name: string) => {
	const index = args.indexOf(`--${name}`);
	if (index === -1) return undefined;
	return args[index + 1];
};

const hasFlag = (args: string[], name: string) => args.includes(`--${name}`);

const parseDate = (value: string) => {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) {
		throw new Error(`Invalid date "${value}". Expected YYYY-MM-DD.`);
	}

	const [, year, month, day] = match;
	return {
		dt: value,
		year,
		month,
		day,
		date: new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))),
	};
};

const parseRecordTypes = (value?: string): SupportedRecordType[] => {
	if (!value) {
		return [RecordTypes.TradeRecord, RecordTypes.DepositRecord];
	}

	const raw = value
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);

	const invalid = raw.filter(
		(recordType) =>
			recordType !== RecordTypes.TradeRecord && recordType !== RecordTypes.DepositRecord
	);

	if (invalid.length > 0) {
		throw new Error(
			`Invalid record types: ${invalid.join(
				', '
			)}. Expected TradeRecord and/or DepositRecord.`
		);
	}

	return raw as SupportedRecordType[];
};

const buildProcessedPrefix = ({
	recordType,
	year,
	month,
	day,
}: {
	recordType: SupportedRecordType;
	year: string;
	month: string;
	day: string;
}) => {
	return `${PROCESSED_ROOT}/source=${DEFAULT_SOURCE}/eventType=${recordType}/year=${year}/month=${month}/day=${day}/`;
};

const parseS3Uri = (uri: string) => {
	const match = /^s3:\/\/([^/]+)\/?(.*)$/.exec(uri);
	if (!match) {
		throw new Error(`Unsupported S3 URI: ${uri}`);
	}

	return {
		bucket: match[1],
		prefix: match[2],
	};
};

const normalizePrefix = (prefix: string) => {
	if (!prefix) return '';
	return prefix.endsWith('/') ? prefix : `${prefix}/`;
};

const getShowCreateStatement = async (tableName: string) => {
	const rows = await Athena().query(`SHOW CREATE TABLE ${tableName}`);
	if (rows.length === 0) {
		throw new Error(`No SHOW CREATE TABLE output returned for ${tableName}`);
	}

	return rows
		.map((row) =>
			Object.values(row)
				.filter((value): value is string => Boolean(value))
				.join(' ')
		)
		.join('\n');
};

const getTableLocation = async (tableName: string) => {
	const createStatement = await getShowCreateStatement(tableName);
	const locationMatch = createStatement.match(/LOCATION\s+'([^']+)'/i);

	if (!locationMatch) {
		throw new Error(`Could not determine S3 location for ${tableName}`);
	}

	return parseS3Uri(locationMatch[1]);
};

const dropPartitionIfExists = async (tableName: string, dt: string) => {
	try {
		await Athena().query(`ALTER TABLE ${tableName} DROP PARTITION (dt='${dt}')`);
		logger.info(`Dropped Athena partition dt=${dt} from ${tableName}`);
	} catch (error) {
		const { message } = error as Error;
		if (message.includes('Partition not found')) {
			logger.warn(`Partition dt=${dt} did not exist in ${tableName}`);
			return;
		}

		throw error;
	}
};

const validateCuratedStreams = (recordTypes: SupportedRecordType[]) => {
	if (
		recordTypes.includes(RecordTypes.TradeRecord) &&
		!process.env.CURATED_TRADE_KINESIS_STREAM
	) {
		throw new Error('CURATED_TRADE_KINESIS_STREAM is required for TradeRecord replacement');
	}

	if (
		recordTypes.includes(RecordTypes.DepositRecord) &&
		!process.env.CURATED_DEPOSIT_KINESIS_STREAM
	) {
		throw new Error('CURATED_DEPOSIT_KINESIS_STREAM is required for DepositRecord replacement');
	}
};

const replaceCuratedPartition = async ({
	recordType,
	dt,
}: {
	recordType: SupportedRecordType;
	dt: string;
}) => {
	const tableName = ANALYTICS_TABLES[recordType];
	const { bucket, prefix } = await getTableLocation(tableName);
	const partitionPrefix = `${normalizePrefix(prefix)}dt=${dt}/`;
	const { listAllObjects, deleteObject } = S3({ overrideBucketName: bucket });
	const objects = await listAllObjects(partitionPrefix);
	const deleteLimiter = new Bottleneck({
		maxConcurrent: 5,
		minTime: 50,
	});

	logger.info(
		`Replacing curated partition for ${recordType} using ${tableName} at s3://${bucket}/${partitionPrefix}`
	);

	if (objects.length > 0) {
		await Promise.all(
			objects.map((object) =>
				deleteLimiter.schedule(async () => {
					if (!object.Key) return;
					await deleteObject(object.Key);
				})
			)
		);
	}

	logger.info(`Deleted ${objects.length} object(s) for ${tableName} dt=${dt}`);
	await dropPartitionIfExists(tableName, dt);
};

const replayCuratedPartition = async ({
	recordType,
	dt,
	year,
	month,
	day,
	sourceBucket,
}: {
	recordType: SupportedRecordType;
	dt: string;
	year: string;
	month: string;
	day: string;
	sourceBucket: string;
}) => {
	const { getRecords } = Archiver();
	const { listAllObjects, getObject } = S3({ overrideBucketName: sourceBucket });
	const prefix = buildProcessedPrefix({ recordType, year, month, day });
	const files = await listAllObjects(prefix);
	let published = 0;

	if (files.length === 0) {
		logger.warn(`No processed files found for ${recordType} on ${dt} under ${prefix}`);
		return 0;
	}

	for (const file of files) {
		if (!file.Key) continue;

		const content = await getObject(file.Key);
		const records = getRecords({ content }).filter((record) => record.eventType === recordType);

		if (records.length === 0) {
			continue;
		}

		const result = await publishCuratedRecords({ records });
		published +=
			recordType === RecordTypes.TradeRecord
				? result.tradesPublished
				: result.depositsPublished;
	}

	logger.info(`Republished ${published} curated ${recordType} row(s) for dt=${dt}`);
	return published;
};

const main = async () => {
	const args = process.argv.slice(2);

	if (hasFlag(args, 'help')) {
		console.log(usage());
		process.exit(0);
	}

	const dateArg = getArg(args, 'date');
	if (!dateArg) {
		throw new Error('Missing required argument: --date');
	}

	const { dt, year, month, day } = parseDate(dateArg);
	const recordTypes = parseRecordTypes(getArg(args, 'record-type'));
	const sourceBucket =
		getArg(args, 'source-bucket') ?? process.env.S3_BUCKET ?? DEFAULT_S3_BUCKET;

	validateCuratedStreams(recordTypes);

	for (const recordType of recordTypes) {
		await replaceCuratedPartition({ recordType, dt });
	}

	for (const recordType of recordTypes) {
		await replayCuratedPartition({
			recordType,
			dt,
			year,
			month,
			day,
			sourceBucket,
		});
	}

	logger.info(
		`Curated analytics partition replacement complete for ${recordTypes.join(', ')} on ${dt}`
	);
};

main().catch((error) => {
	const { message } = error as Error;
	logger.error(`Unhandled error replacing curated analytics partition: ${message}`);
	process.exit(1);
});
