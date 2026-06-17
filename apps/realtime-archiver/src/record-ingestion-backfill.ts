import {
	DepositRecord,
	FundingPaymentRecord,
	FundingRateRecord,
	IngestionSource,
	InsuranceFundRecord,
	InsuranceFundStakeRecord,
	InsuranceFundSwapRecord,
	isFeatureEnabled,
	LiquidationRecord,
	logger,
	LPRecord,
	OrderActionRecord,
	OrderRecord,
	PredictionRecord,
	ProcessedS3Record,
	RecordIngestionFailure,
	RecordTypes,
	RewardRecord,
	SettlePnlRecord,
	SwapRecord,
	TradeRecord,
	VaultDepositorRecord,
} from '@backend/common';
import {
	DepositRepository,
	FundingPaymentRepository,
	FundingRateRepository,
	getRecordKeys,
	InsuranceFundRepository,
	InsuranceFundStakeRepository,
	InsuranceFundSwapRepository,
	LiquidationRepository,
	LPRepository,
	OrderRepository,
	PoolRepository,
	PredictionRepository,
	RewardRepository,
	SettlePnlRepository,
	SwapRepository,
	TradeRepository,
	VaultRepository,
} from '@backend/dynamodb';
import { S3 } from '@backend/s3';
import { SQS } from '@backend/sqs';
import { S3Event } from 'aws-lambda';
import { publishCuratedRecords } from './services/analytics-publisher';
import { Archiver } from './services/archive';

const WHITELIST_EVENTS = [
	RecordTypes.OrderRecord,
	RecordTypes.OrderActionRecord,
	RecordTypes.PredictionRecord,
	RecordTypes.TradeRecord,
	RecordTypes.SettlePnlRecord,
	RecordTypes.DepositRecord,
	RecordTypes.RewardRecord,
	RecordTypes.LiquidationRecord,
	RecordTypes.LPRecord,
	RecordTypes.LPMintRedeemRecord,
	RecordTypes.FundingPaymentRecord,
	RecordTypes.InsuranceFundStakeRecord,
	RecordTypes.InsuranceFundRecord,
	RecordTypes.InsuranceFundSwapRecord,
	RecordTypes.FundingRateRecord,
	RecordTypes.SwapRecord,
	...(isFeatureEnabled('VAULT_DEPOSITOR') ? [RecordTypes.VaultDepositorRecord] : []),
];

const FILTERED_USERS = process.env.FILTERED_USERS?.split(',') || [
	'E6vCUxgcNfRLSu1wPHwqiN419LB22GAujb97tZDa91mh',
	'2aMcirYcF9W8aTFem6qe8QtvfQ22SLY6KUe6yUQbqfHk',
	'BRksHqLiq2gvQw1XxsZq6DXZjD3GB5a9J63tUBgd6QS9',
];

export const handler = async (event: S3Event) => {
	const { getObject } = S3();
	const { createOrderRecords, createOrderActionRecords } = OrderRepository();
	const { createTradeRecords } = TradeRepository();
	const { createPredictionRecords } = PredictionRepository();
	const { createSwapRecords } = SwapRepository();
	const { createDepositRecords } = DepositRepository();
	const { createRewardRecords } = RewardRepository();
	const { createSettlePnlRecords } = SettlePnlRepository();
	const { createLiquidationRecords } = LiquidationRepository();
	const { createLPRecords } = LPRepository();
	const { createInsuranceFundRecords } = InsuranceFundRepository();
	const { createInsuranceFundStakeRecords } = InsuranceFundStakeRepository();
	const { createFundingRateRecords } = FundingRateRepository();
	const { createFundingPaymentRecords } = FundingPaymentRepository();
	const { createVaultDepositRecords } = VaultRepository();
	const { createInsuranceFundSwapRecords } = InsuranceFundSwapRepository();
	const { createLPMintRedeemRecords } = PoolRepository();

	const { transformRecord, getRecords } = Archiver();
	const { putMessages } = SQS();

	const failedRecords: string[] = [];
	const recordsByEventType = {} as Record<RecordTypes, ProcessedS3Record[]>;
	const processedKeys = new Set<string>();
	const curatedCandidateRecords: any[] = [];

	const getUniqueProcessingKey = ({ pk, sk }: { pk: string; sk: string }) => {
		return `${pk}#${sk}`;
	};

	const addFailedRecordsToDLQ = async (records: ProcessedS3Record[], eventType: RecordTypes) => {
		return putMessages({
			records: records.map((record, index) => ({
				Id: `${Date.now()}-${index}`,
				MessageBody: JSON.stringify({
					error: RecordIngestionFailure.INSERT,
					record: record.record,
					eventType,
				}),
			})),
		});
	};

	for (const record of event.Records) {
		const key = record.s3.object.key;
		const sourceKey = decodeURIComponent(record.s3.object.key);
		const content = await getObject(sourceKey);

		const records = getRecords({ content });

		for await (const [index, record] of records.entries()) {
			try {
				const eventType = record.eventType as RecordTypes;

				if (!WHITELIST_EVENTS.includes(eventType) || FILTERED_USERS.includes(record.user))
					continue;

				if (
					eventType === RecordTypes.TradeRecord ||
					eventType === RecordTypes.DepositRecord
				) {
					curatedCandidateRecords.push(record);
				}

				const transformedItems = transformRecord(record);
				for (const item of transformedItems) {
					const itemKey = getUniqueProcessingKey(getRecordKeys(item, eventType));

					if (processedKeys.has(itemKey)) {
						logger.info(`Skipping duplicate record: ${itemKey}`);
						continue;
					}

					processedKeys.add(itemKey);

					if (!recordsByEventType[eventType]) {
						recordsByEventType[eventType] = [];
					}

					recordsByEventType[eventType].push({
						record: {
							...item,
							source: IngestionSource.BACKFILL,
						},
						identifier: `${key}-${index}`,
					});
				}
			} catch (error) {
				const { message } = error as Error;
				logger.warn(`Failed to process record: ${message}, content: ${record}`);
				failedRecords.push(record);
			}
		}
	}

	if (curatedCandidateRecords.length > 0) {
		await publishCuratedRecords({ records: curatedCandidateRecords });
	}

	const promises = Object.entries(recordsByEventType).map(
		async ([eventTypeString, processedRecords]) => {
			const eventType = eventTypeString as RecordTypes;
			const records = processedRecords.map((processedRecord) => processedRecord.record);

			if (records.length === 0) return;

			let failedRecords: Record<string, any>[] = [];

			try {
				switch (eventType) {
					case RecordTypes.OrderRecord:
						failedRecords = await createOrderRecords(records as OrderRecord[]);
						break;
					case RecordTypes.OrderActionRecord:
						failedRecords = await createOrderActionRecords(
							records as OrderActionRecord[]
						);
						break;
					case RecordTypes.TradeRecord:
						failedRecords = await createTradeRecords(records as TradeRecord[]);
						break;
					case RecordTypes.PredictionRecord:
						failedRecords = await createPredictionRecords(
							records as PredictionRecord[]
						);
						break;
					case RecordTypes.SwapRecord:
						failedRecords = await createSwapRecords(records as SwapRecord[]);
						break;
					case RecordTypes.SettlePnlRecord:
						failedRecords = await createSettlePnlRecords(records as SettlePnlRecord[]);
						break;
					case RecordTypes.DepositRecord:
						failedRecords = await createDepositRecords(records as DepositRecord[]);
						break;
					case RecordTypes.RewardRecord:
						failedRecords = await createRewardRecords(records as RewardRecord[]);
						break;
					case RecordTypes.LiquidationRecord:
						failedRecords = await createLiquidationRecords(
							records as LiquidationRecord[]
						);
						break;
					case RecordTypes.LPRecord:
						failedRecords = await createLPRecords(records as LPRecord[]);
						break;
					case RecordTypes.LPMintRedeemRecord:
						failedRecords = await createLPMintRedeemRecords(records as LPRecord[]);
						break;
					case RecordTypes.FundingPaymentRecord:
						failedRecords = await createFundingPaymentRecords(
							records as FundingPaymentRecord[]
						);
						break;
					case RecordTypes.InsuranceFundStakeRecord:
						failedRecords = await createInsuranceFundStakeRecords(
							records as InsuranceFundStakeRecord[]
						);
						break;
					case RecordTypes.InsuranceFundRecord:
						failedRecords = await createInsuranceFundRecords(
							records as InsuranceFundRecord[]
						);
						break;
					case RecordTypes.FundingRateRecord:
						failedRecords = await createFundingRateRecords(
							records as FundingRateRecord[]
						);
						break;
					case RecordTypes.VaultDepositorRecord:
						failedRecords = await createVaultDepositRecords(
							records as VaultDepositorRecord[]
						);
						break;
					case RecordTypes.InsuranceFundSwapRecord:
						failedRecords = await createInsuranceFundSwapRecords(
							records as InsuranceFundSwapRecord[]
						);
						break;
				}

				if (failedRecords && failedRecords.length) {
					const failedRecordsForDLQ: ProcessedS3Record[] = [];
					const failedItemKeys = new Set(
						failedRecords.map((item) =>
							getUniqueProcessingKey({ pk: item.pk, sk: item.sk })
						)
					);

					processedRecords.forEach((processedRecord) => {
						const recordKey = getUniqueProcessingKey(
							getRecordKeys(processedRecord.record, eventType)
						);

						if (failedItemKeys.has(recordKey)) {
							failedRecordsForDLQ.push(processedRecord);
						}
					});

					await addFailedRecordsToDLQ(failedRecordsForDLQ, eventType);
				}
			} catch (error) {
				const { message } = error as Error;
				logger.warn(`Failed to write records of type ${eventType} to DynamoDB: ${message}`);
				await addFailedRecordsToDLQ(processedRecords, eventType);
			}
		}
	);

	await Promise.all(promises);

	if (failedRecords.length) {
		await logger.error(`Total number of parsing failures: ${failedRecords.length}`);
	}

	return {
		statusCode: 200,
		body: JSON.stringify({
			message: 'Processing complete',
			failedRecordsCount: failedRecords.length,
		}),
	};
};
