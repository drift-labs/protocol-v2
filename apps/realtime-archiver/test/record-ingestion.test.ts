import { EntityTypes, IngestionSource, RecordTypes } from '@backend/common';
import { KinesisStreamEvent } from 'aws-lambda';
import { handler } from '../src/record-ingestion';

const mockSettle = jest.fn();
const mockDeposit = jest.fn();
jest.mock('@backend/dynamodb', () => {
	const original = jest.requireActual('@backend/dynamodb');
	return {
		...original,
		SettlePnlRepository: jest.fn().mockImplementation(() => ({
			createSettlePnlRecords: mockSettle,
		})),
		DepositRepository: jest.fn().mockImplementation(() => ({
			createDepositRecords: mockDeposit,
		})),
	};
});

const mockPutMesssages = jest.fn().mockResolvedValue({});
const mockPublishCuratedRecords = jest.fn().mockResolvedValue({
	tradesPublished: 0,
	depositsPublished: 0,
});
jest.mock('@backend/sqs', () => {
	return {
		SQS: () => {
			return {
				putMessages: mockPutMesssages,
			};
		},
	};
});

jest.mock('../src/services/analytics-publisher', () => ({
	publishCuratedRecords: (...args: unknown[]) => mockPublishCuratedRecords(...args),
}));

describe('Record Ingestion', () => {
	let mockEvent: KinesisStreamEvent;

	beforeEach(() => {
		jest.clearAllMocks();

		mockEvent = {
			Records: [
				{
					kinesis: {
						partitionKey: 'partitionKey1',
						kinesisSchemaVersion: '1.0',
						data: Buffer.from(
							JSON.stringify({
								eventType: RecordTypes.SettlePnlRecord,
								user: 'test-user',
								ts: 123,
								txSig: '123',
								txSigIndex: 123,
								slot: 123,
							})
						).toString('base64'),
						sequenceNumber: 'seq1',
						approximateArrivalTimestamp: 123,
					},
					eventID: 'event1',
					eventName: 'aws:kinesis:record',
					eventVersion: '1.0',
					eventSource: 'aws:kinesis',
					awsRegion: 'us-west-2',
					invokeIdentityArn: 'arn:aws:iam::123456789012:role/lambda-role',
					eventSourceARN: 'arn:aws:kinesis:us-west-2:123456789012:stream/lambda-stream',
				},
			],
		};
	});

	const settleRecord = {
		baseAssetAmount: 0,
		explanation: undefined,
		marketIndex: undefined,
		pnl: 0,
		quoteAssetAmountAfter: 0,
		quoteEntryAmount: 0,
		settlePrice: 0,
		slot: 123,
		ts: 123,
		txSig: '123',
		txSigIndex: 123,
		user: 'test-user',
		entity: 'user',
		source: IngestionSource.SEQUENTIAL,
	};

	const depositRecord = {
		amount: 0,
		depositRecordId: undefined,
		direction: undefined,
		explanation: undefined,
		marketCumulativeBorrowInterest: 0,
		marketCumulativeDepositInterest: 0,
		marketDepositBalance: 0,
		marketIndex: 0,
		marketWithdrawBalance: 0,
		oraclePrice: 0,
		slot: undefined,
		totalDepositsAfter: 0,
		totalWithdrawsAfter: 0,
		ts: 123,
		txSig: '123',
		txSigIndex: 123,
		symbol: 'USDC',
		user: 'test-user',
		userAuthority: undefined,
		entity: 'user',
		source: IngestionSource.SEQUENTIAL,
	};

	it('should process SettlePnlRecord successfully', async () => {
		mockSettle.mockResolvedValue([]);
		const result = await handler(mockEvent);
		expect(result.batchItemFailures).toEqual([]);
		expect(mockSettle).toHaveBeenCalledWith([settleRecord]);
	});

	it('should process DepositRecord successfully', async () => {
		mockEvent.Records[0].kinesis.data = Buffer.from(
			JSON.stringify({
				user: 'test-user',
				ts: 123,
				txSig: '123',
				txSigIndex: 123,
				marketIndex: 0,
				eventType: RecordTypes.DepositRecord,
			})
		).toString('base64');

		mockDeposit.mockResolvedValue([]);

		const result = await handler(mockEvent);

		expect(result.batchItemFailures).toEqual([]);
		expect(mockDeposit).toHaveBeenCalledWith([
			depositRecord,
			{ ...depositRecord, entity: EntityTypes.Market },
		]);
		expect(mockPublishCuratedRecords).toHaveBeenCalledWith({
			records: [
				expect.objectContaining({
					eventType: RecordTypes.DepositRecord,
					user: 'test-user',
				}),
			],
		});
	});

	it('should handle and report failed records', async () => {
		const record = {
			pk: 'USER#test-user',
			sk: 'SETTLE_PNL#TS#123#SLOT#123#SIG#123#INDEX#00123',
		};
		mockSettle.mockResolvedValue([record]);
		const result = await handler(mockEvent);
		expect(mockPutMesssages).toHaveBeenCalledWith({
			records: [
				{
					Id: `seq1`,
					MessageBody: JSON.stringify({
						error: 'insert_failure',
						kinesisRecord: mockEvent.Records[0].kinesis,
						record: {
							txSig: '123',
							txSigIndex: 123,
							slot: 123,
							pnl: 0,
							user: 'test-user',
							baseAssetAmount: 0,
							quoteAssetAmountAfter: 0,
							quoteEntryAmount: 0,
							ts: 123,
							settlePrice: 0,
							marketIndex: undefined,
							explanation: undefined,
							entity: 'user',
							source: IngestionSource.SEQUENTIAL,
						},
						eventType: 'SettlePnlRecord',
					}),
				},
			],
		});
		expect(result.batchItemFailures).toEqual([]);
	});

	it('should skip non-whitelisted event types', async () => {
		mockEvent.Records[0].kinesis.data = Buffer.from(
			JSON.stringify({ id: '1', eventType: 'NonWhitelistedType' })
		).toString('base64');

		const result = await handler(mockEvent);

		expect(result.batchItemFailures).toEqual([]);
		expect(mockSettle).not.toHaveBeenCalled();
		expect(mockDeposit).not.toHaveBeenCalled();
	});

	it('should deduplicate records', async () => {
		mockEvent.Records.push({
			...mockEvent.Records[0],
			kinesis: { ...mockEvent.Records[0].kinesis, sequenceNumber: 'seq2' },
		});

		await handler(mockEvent);

		expect(mockSettle).toHaveBeenCalledTimes(1);
		expect(mockSettle).toHaveBeenCalledWith([settleRecord]);
	});

	it('should handle multiple record types in a single event', async () => {
		mockEvent.Records.push({
			...mockEvent.Records[0],
			kinesis: {
				...mockEvent.Records[0].kinesis,
				data: Buffer.from(
					JSON.stringify({
						user: 'test-user',
						ts: 123,
						txSig: '123',
						txSigIndex: 123,
						marketIndex: 0,
						eventType: RecordTypes.DepositRecord,
					})
				).toString('base64'),
				sequenceNumber: 'seq2',
			},
		});

		await handler(mockEvent);

		expect(mockSettle).toHaveBeenCalledWith([settleRecord]);
		expect(mockDeposit).toHaveBeenCalledWith([
			depositRecord,
			{ ...depositRecord, entity: EntityTypes.Market },
		]);
	});

	it('should handle errors in database operations', async () => {
		mockSettle.mockRejectedValue(new Error('Database error'));
		await expect(handler(mockEvent)).resolves.toEqual({
			batchItemFailures: [{ itemIdentifier: 'seq1' }],
		});
	});
});
