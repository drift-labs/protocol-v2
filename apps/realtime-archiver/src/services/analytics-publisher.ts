import { PutRecordsRequestEntry } from '@aws-sdk/client-kinesis';
import { IngestionSource } from '@backend/common';
import { Kinesis } from '@backend/kinesis';
import {
	isSupportedAnalyticsEventType,
	transformDepositRecordToAnalytics,
	transformTradeRecordToAnalytics,
} from './analytics-transform';
import { AnalyticsDepositRecord, AnalyticsTradeRecord } from './analytics-types';
import { resolveAuthorities } from './authority-resolver';

type AnalyticsPublishResult = {
	tradesPublished: number;
	depositsPublished: number;
};

const getTradeStreamName = () => process.env.CURATED_TRADE_KINESIS_STREAM;
const getDepositStreamName = () => process.env.CURATED_DEPOSIT_KINESIS_STREAM;

const createRecords = (rows: Array<AnalyticsTradeRecord | AnalyticsDepositRecord>) =>
	rows.map(
		(row) =>
			({
				Data: Buffer.from(JSON.stringify(row)),
				PartitionKey: `dt=${row.dt}`,
			}) satisfies PutRecordsRequestEntry
	);

export const publishCuratedRecords = async ({
	records,
}: {
	records: any[];
}): Promise<AnalyticsPublishResult> => {
	const tradeStreamName = getTradeStreamName();
	const depositStreamName = getDepositStreamName();

	if (!tradeStreamName && !depositStreamName) {
		return {
			tradesPublished: 0,
			depositsPublished: 0,
		};
	}

	const supportedRecords = records.filter(
		(record) =>
			isSupportedAnalyticsEventType(record.eventType) &&
			record.source === IngestionSource.SEQUENTIAL
	);

	const authorities = await resolveAuthorities({
		userPubkeys: supportedRecords.flatMap((record) => [record.maker, record.taker]),
	});

	const tradeRows = supportedRecords
		.filter((record) => record.eventType === 'TradeRecord')
		.map((record) =>
			transformTradeRecordToAnalytics({
				record,
				makerAuthority: record.maker ? authorities[record.maker] : undefined,
				takerAuthority: record.taker ? authorities[record.taker] : undefined,
			})
		);

	const depositRows = supportedRecords
		.filter((record) => record.eventType === 'DepositRecord')
		.map((record) => transformDepositRecordToAnalytics({ record }));

	if (tradeStreamName && tradeRows.length > 0) {
		await Kinesis({ overrideStreamName: tradeStreamName }).putRecords(createRecords(tradeRows));
	}

	if (depositStreamName && depositRows.length > 0) {
		await Kinesis({ overrideStreamName: depositStreamName }).putRecords(
			createRecords(depositRows)
		);
	}

	return {
		tradesPublished: tradeRows.length,
		depositsPublished: depositRows.length,
	};
};
