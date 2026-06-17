import {
	DEFAULT_S3_BUCKET,
	IngestionSource,
	logger,
	RECORD_TTL_DAYS,
	RecordTypes,
} from '@backend/common';
import { S3 } from '@backend/s3';
import Bottleneck from 'bottleneck';
import { createInterface } from 'readline/promises';

type BackfillTarget = 'dynamodb' | 's3';

type BackfillConfig = {
	bucket: string;
	recordTypes: RecordTypes[];
	startDate: Date;
	endDate: Date;
	runId: string;
	dryRun: boolean;
	allowExpired: boolean;
	maxAgeDays: number;
	copiesPerSecond: number;
	target: BackfillTarget;
};

const DEFAULT_SOURCE = IngestionSource.SEQUENTIAL;
const DEFAULT_COPIES_PER_SECOND = 1;
const DEFAULT_TARGET: BackfillTarget = 'dynamodb';
const UNPROCESSED_ROOT = 'unprocessed';
const PROCESSED_ROOT = 'processed_files';

const usage = () => {
	const recordTypes = Object.values(RecordTypes).join(', ');
	return [
		'Usage:',
		'  backfill-record-ingestion.ts --record-type <RecordType[,RecordType]> --start-date YYYY-MM-DD --end-date YYYY-MM-DD [options]',
		'',
		'Options:',
		'  --bucket <name>             S3 bucket (defaults to S3_BUCKET or DEFAULT_S3_BUCKET)',
		'  --target <dynamodb|s3>      Copy processed_files into backfills/ (dynamodb) or move processed_files back to unprocessed (s3)',
		'  --run-id <id>               Backfill run id for the backfills/ prefix (dynamodb target)',
		'  --copies-per-second <n>     Max copy/move operations per second (default: 1)',
		'  --dry-run                   List keys only, do not copy or move',
		'  --allow-expired             Allow backfilling data older than TTL window',
		`  --max-age-days <n>          TTL window in days (default: ${RECORD_TTL_DAYS})`,
		'  --interactive               Prompt for configuration values',
		'  --help                      Show this message',
		'',
		'Note: source is fixed to seq.',
		`Available RecordTypes: ${recordTypes}`,
	].join('\n');
};

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
	return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
};

const parseTarget = (value: string): BackfillTarget => {
	const normalized = value.trim().toLowerCase();
	if (normalized === 'dynamodb' || normalized === 's3') {
		return normalized as BackfillTarget;
	}
	if (normalized === 'ingestion') {
		return 'dynamodb';
	}
	if (normalized === 'archive') {
		return 's3';
	}
	throw new Error(`Invalid target "${value}". Expected dynamodb or s3.`);
};

const parseMaxAgeDays = (value: string) => {
	const maxAgeDays = Number(value);
	if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
		throw new Error('max-age-days must be a positive number');
	}
	return maxAgeDays;
};

const parseCopiesPerSecond = (value: string) => {
	const copiesPerSecond = Number(value);
	if (!Number.isFinite(copiesPerSecond) || copiesPerSecond <= 0) {
		throw new Error('copies-per-second must be a positive number');
	}
	return copiesPerSecond;
};

const pad2 = (value: number) => value.toString().padStart(2, '0');

const enumerateDates = (start: Date, end: Date) => {
	const dates: Date[] = [];
	const cursor = new Date(start.getTime());
	while (cursor <= end) {
		dates.push(new Date(cursor.getTime()));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return dates;
};

const buildPrefix = ({
	root,
	recordType,
	date,
}: {
	root: string;
	recordType: RecordTypes;
	date: Date;
}) => {
	const year = date.getUTCFullYear();
	const month = pad2(date.getUTCMonth() + 1);
	const day = pad2(date.getUTCDate());
	return `${root}/source=${DEFAULT_SOURCE}/eventType=${recordType}/year=${year}/month=${month}/day=${day}/`;
};

const parseRecordTypes = (value: string) => {
	const raw = value
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);

	const invalid = raw.filter(
		(recordType) => !Object.values(RecordTypes).includes(recordType as RecordTypes)
	);
	if (invalid.length > 0) {
		throw new Error(`Invalid record types: ${invalid.join(', ')}`);
	}

	return raw.map((recordType) => recordType as RecordTypes);
};

const promptInput = async (
	rl: ReturnType<typeof createInterface>,
	prompt: string,
	defaultValue?: string
) => {
	const suffix = defaultValue ? ` [${defaultValue}]` : '';
	const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
	return answer || defaultValue || '';
};

const promptYesNo = async (
	rl: ReturnType<typeof createInterface>,
	prompt: string,
	defaultValue: boolean
) => {
	const suffix = defaultValue ? 'Y/n' : 'y/N';
	for (;;) {
		const answer = (await rl.question(`${prompt} (${suffix}): `)).trim().toLowerCase();
		if (!answer) return defaultValue;
		if (['y', 'yes'].includes(answer)) return true;
		if (['n', 'no'].includes(answer)) return false;
		console.log('Please enter y or n.');
	}
};

const promptRecordTypes = async (rl: ReturnType<typeof createInterface>, defaultValue?: string) => {
	for (;;) {
		const input = await promptInput(rl, 'Record types (comma-separated)', defaultValue);
		if (!input) {
			console.log('Record types are required.');
			continue;
		}
		try {
			return parseRecordTypes(input);
		} catch (error) {
			console.log((error as Error).message);
		}
	}
};

const promptDateValue = async (
	rl: ReturnType<typeof createInterface>,
	prompt: string,
	defaultValue?: string
) => {
	for (;;) {
		const input = await promptInput(rl, prompt, defaultValue);
		if (!input) {
			console.log('Date is required.');
			continue;
		}
		try {
			return parseDate(input);
		} catch (error) {
			console.log((error as Error).message);
		}
	}
};

const promptNumberValue = async (
	rl: ReturnType<typeof createInterface>,
	prompt: string,
	defaultValue: string,
	parser: (value: string) => number
) => {
	for (;;) {
		const input = await promptInput(rl, prompt, defaultValue);
		if (!input) {
			console.log('Value is required.');
			continue;
		}
		try {
			return parser(input);
		} catch (error) {
			console.log((error as Error).message);
		}
	}
};

const promptTarget = async (rl: ReturnType<typeof createInterface>, defaultValue: string) => {
	for (;;) {
		const input = await promptInput(rl, 'Backfill target (dynamodb|s3)', defaultValue);
		if (!input) {
			console.log('Target is required.');
			continue;
		}
		try {
			return parseTarget(input);
		} catch (error) {
			console.log((error as Error).message);
		}
	}
};

const listKeysForPrefix = async (
	listAllObjects: (prefix: string) => Promise<{ Key?: string }[]>,
	prefix: string
) => {
	const objects = await listAllObjects(prefix);
	return objects.flatMap((object) => (object.Key ? [object.Key] : []));
};

const promptForConfig = async (args: string[]): Promise<BackfillConfig> => {
	if (!process.stdin.isTTY) {
		throw new Error('Interactive mode requires a TTY.');
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const target = await promptTarget(rl, getArg(args, 'target') ?? DEFAULT_TARGET);
		const recordTypes = await promptRecordTypes(
			rl,
			getArg(args, 'record-type') ?? getArg(args, 'record-types')
		);
		const startDate = await promptDateValue(
			rl,
			'Start date (YYYY-MM-DD)',
			getArg(args, 'start-date')
		);
		let endDate = await promptDateValue(rl, 'End date (YYYY-MM-DD)', getArg(args, 'end-date'));
		while (endDate < startDate) {
			console.log('end-date must be >= start-date');
			endDate = await promptDateValue(rl, 'End date (YYYY-MM-DD)', undefined);
		}

		const allowExpired = await promptYesNo(
			rl,
			'Allow expired data',
			hasFlag(args, 'allow-expired')
		);
		const maxAgeDays = await promptNumberValue(
			rl,
			'Max age days',
			getArg(args, 'max-age-days') ?? `${RECORD_TTL_DAYS}`,
			parseMaxAgeDays
		);
		const copiesPerSecond = await promptNumberValue(
			rl,
			'Copies per second',
			getArg(args, 'copies-per-second') ?? `${DEFAULT_COPIES_PER_SECOND}`,
			parseCopiesPerSecond
		);
		const dryRun = await promptYesNo(rl, 'Dry run (list only)', hasFlag(args, 'dry-run'));
		const runIdDefault =
			getArg(args, 'run-id') ??
			new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
		const runId =
			target === 'dynamodb' ? await promptInput(rl, 'Run id', runIdDefault) : runIdDefault;
		const bucket = await promptInput(
			rl,
			'S3 bucket',
			getArg(args, 'bucket') ?? process.env.S3_BUCKET ?? DEFAULT_S3_BUCKET
		);

		return {
			bucket,
			recordTypes,
			startDate,
			endDate,
			runId,
			dryRun,
			allowExpired,
			maxAgeDays,
			copiesPerSecond,
			target,
		};
	} finally {
		rl.close();
	}
};

const buildConfig = async (): Promise<BackfillConfig> => {
	const args = process.argv.slice(2);
	if (hasFlag(args, 'help')) {
		console.log(usage());
		process.exit(0);
	}

	const sourceArg = getArg(args, 'source');
	if (sourceArg && sourceArg !== DEFAULT_SOURCE) {
		throw new Error('Source is fixed to seq; remove --source or set it to seq.');
	}
	if (sourceArg) {
		logger.warn('Ignoring --source; source is fixed to seq.');
	}

	const recordTypeArg = getArg(args, 'record-type') ?? getArg(args, 'record-types');
	const startDateArg = getArg(args, 'start-date');
	const endDateArg = getArg(args, 'end-date');
	const hasRequiredArgs = Boolean(recordTypeArg && startDateArg && endDateArg);
	const wantsInteractive =
		hasFlag(args, 'interactive') || (!hasRequiredArgs && process.stdin.isTTY);

	if (wantsInteractive) {
		return promptForConfig(args);
	}

	if (!hasRequiredArgs) {
		throw new Error('Missing required arguments. Use --help for usage.');
	}

	const recordTypes = parseRecordTypes(recordTypeArg as string);

	const startDate = parseDate(startDateArg as string);
	const endDate = parseDate(endDateArg as string);
	if (startDate > endDate) {
		throw new Error('start-date must be <= end-date');
	}

	const maxAgeDays = parseMaxAgeDays(getArg(args, 'max-age-days') ?? `${RECORD_TTL_DAYS}`);
	const target = parseTarget(getArg(args, 'target') ?? DEFAULT_TARGET);
	const copiesPerSecond = parseCopiesPerSecond(
		getArg(args, 'copies-per-second') ?? `${DEFAULT_COPIES_PER_SECOND}`
	);

	const runId =
		getArg(args, 'run-id') ?? new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');

	return {
		bucket: getArg(args, 'bucket') ?? process.env.S3_BUCKET ?? DEFAULT_S3_BUCKET,
		recordTypes,
		startDate,
		endDate,
		runId,
		dryRun: hasFlag(args, 'dry-run'),
		allowExpired: hasFlag(args, 'allow-expired'),
		maxAgeDays,
		copiesPerSecond,
		target,
	};
};

const main = async () => {
	const config = await buildConfig();
	const { listAllObjects, copyObject, moveObject } = S3({
		overrideBucketName: config.bucket,
	});
	const limiter = new Bottleneck({
		maxConcurrent: 1,
		minTime: Math.max(1, Math.ceil(1000 / config.copiesPerSecond)),
	});
	const now = new Date();
	const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	cutoff.setUTCDate(cutoff.getUTCDate() - config.maxAgeDays);

	const operationLabel = config.target === 'dynamodb' ? 'copy' : 'move';
	const operationPastTense = config.target === 'dynamodb' ? 'copied' : 'moved';
	const targetLabel =
		config.target === 'dynamodb'
			? `dynamodb backfill run ${config.runId}`
			: 's3 archive backfill run';

	logger.info(
		`Starting ${targetLabel} for ${config.recordTypes.join(', ')} (${config.startDate
			.toISOString()
			.slice(0, 10)} to ${config.endDate
			.toISOString()
			.slice(0, 10)}). ${operationLabel} rate: ${config.copiesPerSecond}/sec${
			config.dryRun ? ' (dry run)' : ''
		}`
	);

	const dates = enumerateDates(config.startDate, config.endDate);
	const eligibleDates = config.allowExpired ? dates : dates.filter((date) => date >= cutoff);

	if (!config.allowExpired && eligibleDates.length !== dates.length) {
		logger.warn(
			`Skipping ${dates.length - eligibleDates.length} day(s) older than TTL window (${
				config.maxAgeDays
			} days). Use --allow-expired to override.`
		);
	}

	let totalKeys = 0;
	let totalProcessed = 0;

	for (const recordType of config.recordTypes) {
		for (const date of eligibleDates) {
			const unprocessedPrefix = buildPrefix({
				root: UNPROCESSED_ROOT,
				recordType,
				date,
			});
			const processedPrefix = buildPrefix({
				root: PROCESSED_ROOT,
				recordType,
				date,
			});

			const keys = await listKeysForPrefix(listAllObjects, processedPrefix);

			if (keys.length === 0) {
				logger.info(`No files for ${recordType} on ${processedPrefix}`);
				continue;
			}

			totalKeys += keys.length;
			logger.info(`Found ${keys.length} file(s) for ${recordType} at ${processedPrefix}`);

			if (config.dryRun) {
				continue;
			}

			await Promise.all(
				keys.map((key) =>
					limiter.schedule(async () => {
						if (config.target === 'dynamodb') {
							const destinationKey = `backfills/${config.runId}/${key}`;
							logger.info(`Copying file: ${key}`);
							await copyObject(key, destinationKey);
						} else {
							const destinationKey = key.replace(processedPrefix, unprocessedPrefix);
							await moveObject(key, destinationKey);
						}
						totalProcessed += 1;
					})
				)
			);
		}
	}

	if (config.dryRun) {
		logger.info(`Dry run complete. ${totalKeys} file(s) matched.`);
		return;
	}

	logger.info(
		`Backfill ${operationLabel} complete. ${totalProcessed}/${totalKeys} file(s) ${operationPastTense}.`
	);
};

main().catch((error) => {
	const { message } = error as Error;
	logger.error(`Unhandled error in backfill script: ${message}`);
	process.exit(1);
});
