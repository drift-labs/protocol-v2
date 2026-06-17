import {
	EntityTypes,
	IngestionSource,
	logger,
	PredictionRecord,
	RecordTypes,
	SerializedMarketFilter,
	TradeRecord,
} from '@backend/common';
import { S3 } from '@backend/s3';
import { VelocityEnv, initialize } from '@velocity-exchange/sdk';
import Bottleneck from 'bottleneck';
import { parse } from 'csv-parse/sync';
import * as fs from 'fs/promises';
import { Archiver } from '../services/archive';

const userLimiter = new Bottleneck({
	maxConcurrent: 50,
});

const marketLimiter = new Bottleneck({
	maxConcurrent: 1,
});

const entityLimiter = new Bottleneck({
	maxConcurrent: 50,
});

const driftEnv = (process.env.ENV || 'mainnet-beta') as VelocityEnv;
const { PERP_MARKETS, SPOT_MARKETS } = initialize({ env: driftEnv });
const PREDICTION_MARKETS = PERP_MARKETS.filter((market) => market.category?.includes('Prediction'));

const sourceS3 = S3({ overrideBucketName: 'drift-historical-data-v2' });
const { paginateAndUploadRecords, getRecordPathName } = Archiver();

const S3_PREFIX = 'program/dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH';

const PATH_TO_EVENT_TYPE: { [key: string]: RecordTypes } = {
	tradeRecords: RecordTypes.TradeRecord,
	fundingPaymentRecords: RecordTypes.FundingPaymentRecord,
	fundingRateRecords: RecordTypes.FundingRateRecord,
	liquidationRecords: RecordTypes.LiquidationRecord,
	insuranceFundRecords: RecordTypes.InsuranceFundRecord,
	insuranceFundStakeRecords: RecordTypes.InsuranceFundStakeRecord,
	lpRecord: RecordTypes.LPRecord,
	settlePnlRecords: RecordTypes.SettlePnlRecord,
	swapRecords: RecordTypes.SwapRecord,
	depositRecords: RecordTypes.DepositRecord,
};

const RECORD_TYPE_PERMISSIONS: any = {
	[RecordTypes.TradeRecord]: {
		entities: [EntityTypes.Market, EntityTypes.User],
	},
	[RecordTypes.FundingPaymentRecord]: {
		entities: [EntityTypes.User],
	},
	[RecordTypes.FundingRateRecord]: {
		entities: [EntityTypes.Market],
	},
	[RecordTypes.LiquidationRecord]: {
		entities: [EntityTypes.User],
	},
	[RecordTypes.InsuranceFundRecord]: {
		entities: [EntityTypes.Market],
	},
	[RecordTypes.InsuranceFundStakeRecord]: {
		entities: [EntityTypes.Authority],
	},
	[RecordTypes.LPRecord]: {
		entities: [EntityTypes.User],
	},
	[RecordTypes.SettlePnlRecord]: {
		entities: [EntityTypes.User],
	},
	[RecordTypes.SwapRecord]: {
		entities: [EntityTypes.User],
	},
	[RecordTypes.DepositRecord]: {
		entities: [EntityTypes.User],
	},
};

const CHECKPOINT_FILE = 'output/checkpoint.json';

const saveCheckpoint = async (data: any) => {
	try {
		await fs.mkdir('output', { recursive: true });
		const existingData = await loadCheckpoint();
		const checkpoint = {
			...existingData,
			...data,
			lastUpdated: new Date(),
			processedCounts: {
				...existingData?.processedCounts,
				...data.processedCounts,
			},
		};
		await fs.writeFile(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
		logger.info(`Checkpoint saved: ${JSON.stringify(checkpoint)}`);
	} catch (error) {
		logger.error(`Error saving checkpoint: ${error}`);
	}
};

const loadCheckpoint = async () => {
	try {
		const data = await fs.readFile(CHECKPOINT_FILE, 'utf-8');
		return JSON.parse(data);
	} catch {
		return null;
	}
};
const getPathNameForRecordType = (recordType: RecordTypes): string => {
	const entry = Object.entries(PATH_TO_EVENT_TYPE).find(([_, value]) => value === recordType);
	if (!entry) {
		throw new Error(`No path name found for record type: ${recordType}`);
	}
	return entry[0];
};

const extractPathInfo = (key: string) => {
	const parts = key.split('/');
	const dateStr = parts[parts.length - 1];
	const recordType = parts[parts.length - 3];
	const entityType = parts[2];
	const entityId = parts[3];

	const eventType = PATH_TO_EVENT_TYPE[recordType];
	if (!eventType) {
		throw new Error(`Unknown record type in path: ${recordType}`);
	}

	const year = parseInt(dateStr.substring(0, 4));
	const month = parseInt(dateStr.substring(4, 6));
	const day = parseInt(dateStr.substring(6, 8));

	const entity =
		entityType === 'market'
			? EntityTypes.Market
			: entityType === 'authority'
			? EntityTypes.Authority
			: EntityTypes.User;

	return {
		entityId,
		entity,
		eventType,
		year,
		month,
		day,
	};
};

const getEntityRecords = async (
	entity: EntityTypes.User | EntityTypes.Authority,
	entityId: string,
	recordType: RecordTypes
) => {
	const monthlyData: { [key: string]: any[] } = {};

	let continuationKey = undefined;
	let allFilesProcessed = false;

	const filePaths: string[] = [];

	while (!allFilesProcessed) {
		const files = await sourceS3.listObjects(
			`${S3_PREFIX}/${entity}/${entityId}/${getPathNameForRecordType(recordType)}`,
			{
				startAfter: continuationKey,
			}
		);

		if (files.length === 0) {
			allFilesProcessed = true;
			continue;
		}

		files.forEach((file) => {
			if (file.Key) {
				const pathInfo = extractPathInfo(file.Key);
				const fileDate = new Date(`${pathInfo.year}-${pathInfo.month}-${pathInfo.day}`);
				const cutoffDate = new Date('2024-11-30');

				if (fileDate <= cutoffDate) {
					filePaths.push(file.Key);
				}
			}
		});

		continuationKey = files[files.length - 1].Key;
	}

	const processFile = async (filePath: string) => {
		const content = await sourceS3.getObject(filePath);
		const pathInfo = extractPathInfo(filePath);

		const records = parse(content, {
			columns: true,
			skip_empty_lines: true,
			cast: true,
			delimiter: ',',
		}).map((record: any) => ({
			...record,
			eventType: pathInfo.eventType,
			entity: pathInfo.entity,
			txSigIndex: null,
			source: IngestionSource.BACKFILL,
			...(entity == EntityTypes.User && { user: entityId }),
			...(entity == EntityTypes.Authority && { userAuthority: entityId }),

			// Various data issues found
			...(pathInfo.eventType === RecordTypes.LiquidationRecord && {
				canceledOrderIds: Array.isArray(record.canceledOrderIds)
					? record.canceledOrderIds
					: [],
			}),
		}));

		if (pathInfo.eventType === RecordTypes.TradeRecord) {
			const tradeRecords = records
				.filter(
					(record: TradeRecord) =>
						!PREDICTION_MARKETS.some(
							(market) =>
								market.marketIndex.toString() === record.marketIndex.toString()
						)
				)
				.map((record: TradeRecord) => {
					const market =
						record.marketType === SerializedMarketFilter.SPOT
							? SPOT_MARKETS.find((x) => x.marketIndex === record.marketIndex)
							: PERP_MARKETS.find((x) => x.marketIndex === record.marketIndex);
					return {
						...record,
						symbol: market?.symbol ?? 'NA',
					};
				});

			const predictionRecords = records
				.filter((record: PredictionRecord) =>
					PREDICTION_MARKETS.some(
						(market) => market.marketIndex.toString() === record.marketIndex.toString()
					)
				)
				.map((record: PredictionRecord) => {
					const market = PERP_MARKETS.find((x) => x.marketIndex === record.marketIndex);
					return {
						...record,
						marketFilter: 'prediction',
						symbol: market?.symbol ?? 'NA',
					};
				});

			return [
				{
					monthKey: `${pathInfo.entity}-${pathInfo.entityId}-${pathInfo.year}-${pathInfo.month}-${RecordTypes.TradeRecord}`,
					records: tradeRecords,
				},
				{
					monthKey: `${pathInfo.entity}-${pathInfo.entityId}-${pathInfo.year}-${pathInfo.month}-${RecordTypes.PredictionRecord}`,
					records: predictionRecords,
				},
			];
		}

		return [
			{
				monthKey: `${pathInfo.entity}-${pathInfo.entityId}-${pathInfo.year}-${pathInfo.month}-${pathInfo.eventType}`,
				records,
			},
		];
	};

	logger.info(`Found ${filePaths.length} files for ${entity} ${entityId}`);

	const results = await Promise.all(
		filePaths.map((filePath) => entityLimiter.schedule(() => processFile(filePath)))
	);

	results.forEach((result) => {
		if (!result) return;
		result.forEach(({ monthKey, records }) => {
			if (records.length === 0) return;
			if (!monthlyData[monthKey]) {
				monthlyData[monthKey] = [];
			}
			monthlyData[monthKey].push(...records);
		});
	});

	Object.entries(monthlyData).forEach(([_, records]) => {
		records.sort((a, b) => b.ts - a.ts);
	});

	return monthlyData;
};

const getEntityIds = async (entity: EntityTypes, checkpoint?: string) => {
	const keys = checkpoint
		? await sourceS3.listKeys(`${S3_PREFIX}/${entity}/`, {
				startAfter: `${S3_PREFIX}/${entity}/${checkpoint}`,
				delimiter: '/',
		  })
		: await sourceS3.listKeys(`${S3_PREFIX}/${entity}/`);

	return keys
		.filter((key) => key != undefined)
		.map((key) => key.split(`/${entity}/`)[1].replace('/', ''));
};

const processEntity = async (
	entity: EntityTypes.User | EntityTypes.Authority,
	entityId: string,
	recordType: RecordTypes
) => {
	const monthlyData = await getEntityRecords(entity, entityId, recordType);
	const uploadPromises = Object.entries(monthlyData).map(([monthKey, records]) =>
		entityLimiter.schedule(async () => {
			const [entityType, entityId, year, month, eventType] = monthKey.split('-');
			logger.info(`Processing ${monthKey}: ${records.length} records`);

			const uploadKey = getRecordPathName({
				id: entityId,
				eventType: eventType as RecordTypes,
				year: parseInt(year),
				month: parseInt(month),
				entity: entityType as EntityTypes,
			});

			await paginateAndUploadRecords({
				records,
				key: `${uploadKey}`,
			});

			logger.info(`Uploaded ${records.length} records to ${uploadKey}`);
		})
	);

	return Promise.all(uploadPromises);
};

const processMarket = async (symbol: string, recordType: RecordTypes) => {
	logger.info(`Starting to process market ${symbol}`);
	let continuationKey = undefined;
	let allFilesProcessed = false;
	let processedFiles = 0;

	while (!allFilesProcessed) {
		const files = await sourceS3.listObjects(
			`${S3_PREFIX}/market/${symbol}/${getPathNameForRecordType(recordType)}`,
			{
				startAfter: continuationKey,
			}
		);

		if (files.length === 0) {
			allFilesProcessed = true;
			continue;
		}

		await Promise.all(
			files.map((file) =>
				entityLimiter.schedule(async () => {
					const filePath = file.Key;
					if (!filePath) return Promise.resolve();

					const pathInfo = extractPathInfo(filePath);
					const fileDate = new Date(`${pathInfo.year}-${pathInfo.month}-${pathInfo.day}`);
					const cutoffDate = new Date('2024-11-30');

					if (fileDate > cutoffDate) {
						return Promise.resolve();
					}

					const content = await sourceS3.getObject(filePath);

					const records = parse(content, {
						columns: true,
						skip_empty_lines: true,
						cast: true,
						delimiter: ',',
					}).map((record: any) => ({
						...record,
						eventType: pathInfo.eventType,
						entity: pathInfo.entity,
						txSigIndex: null,
						source: IngestionSource.BACKFILL,
						symbol,
					}));

					records.sort((a: any, b: any) => b.ts - a.ts);

					const uploadKey = getRecordPathName({
						id: symbol,
						eventType: recordType,
						year: pathInfo.year,
						month: pathInfo.month,
						day: pathInfo.day,
						entity: EntityTypes.Market,
					});

					await paginateAndUploadRecords({
						records,
						key: `${uploadKey}`,
						cache: false,
					});

					logger.info(
						`Processed and uploaded ${records.length} records for ${symbol} ` +
							`${pathInfo.year}-${pathInfo.month}-${pathInfo.day}`
					);
				})
			)
		);

		processedFiles += files.length;
		logger.info(`Processed ${processedFiles} files so far for ${symbol}`);

		continuationKey = files[files.length - 1].Key;
	}

	logger.info(`Completed processing market ${symbol}`);
};

const main = async (recordTypeToProcess: RecordTypes) => {
	const checkpoint = await loadCheckpoint();
	const processedCounts = {
		users: 0,
		authorities: 0,
		markets: 0,
	};

	const ignore = ['DRVmgMNSj8U58up5dhZxmBqyeQLg5iT3nj55a6LyG2VJ'];

	const permissions = RECORD_TYPE_PERMISSIONS[recordTypeToProcess];
	logger.info(`Starting backfill for record type: ${recordTypeToProcess}`);
	logger.info(`Permissions: ${JSON.stringify(permissions)}`);

	if (permissions.entities.includes(EntityTypes.User)) {
		let hasMore = true;
		let lastUser = checkpoint?.lastProcessedUser;
		logger.info('Starting user processing...');
		logger.info(`Resuming from user: ${lastUser || 'beginning'}`);

		while (hasMore) {
			const users = await getEntityIds(EntityTypes.User, lastUser);
			if (users.length === 0) {
				hasMore = false;
				break;
			}

			logger.info(
				`Found batch of ${users.length} users starting from ${lastUser || 'beginning'}`
			);

			await Promise.all(
				users.map((userId) =>
					userLimiter.schedule(async () => {
						processedCounts.users++;
						if (ignore.includes(userId)) return;
						logger.info(`Processing user ${processedCounts.users}: ${userId}`);
						await processEntity(EntityTypes.User, userId, recordTypeToProcess);
					})
				)
			);

			lastUser = users[users.length - 1];

			await saveCheckpoint({
				lastProcessedUser: lastUser,
				recordType: recordTypeToProcess,
				processedCounts,
			});

			if (users.length < 1000) {
				hasMore = false;
			}
		}

		logger.info(`Completed processing ${processedCounts.users} users`);
	}

	if (permissions.entities.includes(EntityTypes.Authority)) {
		let hasMore = true;
		let lastAuthority = checkpoint?.lastProcessedAuthority;
		logger.info('Starting authority processing...');
		logger.info(`Resuming from authority: ${lastAuthority || 'beginning'}`);

		while (hasMore) {
			const authorities = await getEntityIds(EntityTypes.Authority, lastAuthority);
			if (authorities.length === 0) {
				hasMore = false;
				break;
			}

			logger.info(
				`Found batch of ${authorities.length} authorities starting from ${
					lastAuthority || 'beginning'
				}`
			);

			await Promise.all(
				authorities.map((authorityId) =>
					userLimiter.schedule(async () => {
						processedCounts.authorities++;
						logger.info(
							`Processing authority ${processedCounts.authorities}: ${authorityId}`
						);
						await processEntity(
							EntityTypes.Authority,
							authorityId,
							recordTypeToProcess
						);
					})
				)
			);

			lastAuthority = authorities[authorities.length - 1];

			await saveCheckpoint({
				lastProcessedAuthority: lastAuthority,
				recordType: recordTypeToProcess,
				processedCounts,
			});

			if (authorities.length < 1000) {
				hasMore = false;
			}
		}

		logger.info(`Completed processing ${processedCounts.authorities} authorities`);
	}

	if (permissions.entities.includes(EntityTypes.Market)) {
		logger.info('Starting market processing...');
		const lastMarket = checkpoint?.lastProcessedMarket;
		logger.info(`Resuming from market: ${lastMarket || 'beginning'}`);
		const marketSymbols = await getEntityIds(EntityTypes.Market, lastMarket);
		logger.info(`Found ${marketSymbols.length} markets to process`);

		await Promise.all(
			marketSymbols.map((symbol) =>
				marketLimiter.schedule(async () => {
					processedCounts.markets++;
					logger.info(
						`Processing market ${processedCounts.markets}/${marketSymbols.length}: ${symbol}`
					);
					await processMarket(symbol, recordTypeToProcess);
					await saveCheckpoint({
						lastProcessedMarket: symbol,
						recordType: recordTypeToProcess,
						processedCounts,
					});
				})
			)
		);

		logger.info(`Completed processing ${processedCounts.markets} markets`);
	}

	logger.info('Processing complete');
	logger.info(
		`Final counts - Users: ${processedCounts.users}, Authorities: ${processedCounts.authorities}, Markets: ${processedCounts.markets}`
	);
};

if (process.env.NODE_ENV !== 'test') {
	const recordType = process.argv[2];
	if (!recordType || !Object.values(RecordTypes).includes(recordType as RecordTypes)) {
		console.log('Please provide a valid record type. Available types:');
		Object.entries(RECORD_TYPE_PERMISSIONS).forEach(([type, permissions]: [string, any]) => {
			console.log(
				`- ${type} (Available for: ${permissions.entities.join(', ')}${
					permissions.marketTypes
						? `, Market types: ${permissions.marketTypes.join(', ')}`
						: ''
				})`
			);
		});
		process.exit(1);
	}

	main(recordType as RecordTypes).catch((error) => {
		logger.error(`Unhandled error in main: ${error}`);
	});
}
