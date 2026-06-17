import { EntityTypes, IngestionSource, RecordTypes } from '@backend/common';
import { S3Event } from 'aws-lambda';
import { handler } from '../src/record-ingestion-backfill';

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
jest.mock('@backend/sqs', () => ({
	SQS: () => ({
		putMessages: mockPutMesssages,
	}),
}));

const mockGetObject = jest.fn();
jest.mock('@backend/s3', () => ({
	S3: () => ({
		getObject: mockGetObject,
	}),
}));

jest.mock('../src/services/analytics-publisher', () => ({
	publishCuratedRecords: (...args: unknown[]) => mockPublishCuratedRecords(...args),
}));

describe('S3 Record Ingestion', () => {
	let mockEvent: S3Event;
	const MOCK_TIME = 1234567890000;

	beforeEach(() => {
		jest.spyOn(Date, 'now').mockImplementation(() => MOCK_TIME);

		jest.clearAllMocks();

		mockEvent = {
			Records: [
				{
					s3: {
						bucket: {
							name: 'test-bucket',
						},
						object: {
							key: 'test-key',
						},
					},
				},
			],
		} as unknown as S3Event;
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
		symbol: 'USDC',
		txSigIndex: 123,
		user: 'test-user',
		userAuthority: undefined,
		entity: 'user',
		source: IngestionSource.SEQUENTIAL,
	};

	it('should process SettlePnlRecord successfully', async () => {
		mockGetObject.mockResolvedValue(
			JSON.stringify({
				eventType: RecordTypes.SettlePnlRecord,
				user: 'test-user',
				ts: 123,
				txSig: '123',
				txSigIndex: 123,
				slot: 123,
			}) + '\n'
		);

		mockSettle.mockResolvedValue([]);
		const result = await handler(mockEvent);

		expect(result.statusCode).toBe(200);
		expect(JSON.parse(result.body).failedRecordsCount).toBe(0);
		expect(mockSettle).toHaveBeenCalledWith([
			{ ...settleRecord, source: IngestionSource.BACKFILL },
		]);
	});

	it('should process DepositRecord successfully', async () => {
		mockGetObject.mockResolvedValue(
			JSON.stringify({
				user: 'test-user',
				ts: 123,
				txSig: '123',
				txSigIndex: 123,
				marketIndex: 0,
				eventType: RecordTypes.DepositRecord,
			}) + '\n'
		);

		mockDeposit.mockResolvedValue([]);
		const result = await handler(mockEvent);

		expect(result.statusCode).toBe(200);
		expect(JSON.parse(result.body).failedRecordsCount).toBe(0);
		expect(mockDeposit).toHaveBeenCalledWith([
			{ ...depositRecord, source: IngestionSource.BACKFILL },
			{ ...depositRecord, entity: EntityTypes.Market, source: IngestionSource.BACKFILL },
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
		mockGetObject.mockResolvedValue(
			JSON.stringify({
				eventType: RecordTypes.SettlePnlRecord,
				user: 'test-user',
				ts: 123,
				txSig: '123',
				txSigIndex: 123,
				slot: 123,
			}) + '\n'
		);

		const record = {
			pk: 'USER#test-user',
			sk: 'SETTLE_PNL#TS#123#SLOT#123#SIG#123#INDEX#00123',
		};
		mockSettle.mockResolvedValue([record]);

		const result = await handler(mockEvent);

		expect(mockPutMesssages).toHaveBeenCalledWith({
			records: [
				{
					Id: '1234567890000-0',
					MessageBody: JSON.stringify({
						error: 'insert_failure',
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
							source: IngestionSource.BACKFILL,
						},
						eventType: 'SettlePnlRecord',
					}),
				},
			],
		});
		expect(JSON.parse(result.body).failedRecordsCount).toBe(0);
	});

	it('should skip non-whitelisted event types', async () => {
		mockGetObject.mockResolvedValue(
			JSON.stringify({ id: '1', eventType: 'NonWhitelistedType' }) + '\n'
		);

		const result = await handler(mockEvent);

		expect(JSON.parse(result.body).failedRecordsCount).toBe(0);
		expect(mockSettle).not.toHaveBeenCalled();
		expect(mockDeposit).not.toHaveBeenCalled();
	});

	it('should deduplicate records', async () => {
		const duplicateRecord =
			JSON.stringify({
				eventType: RecordTypes.SettlePnlRecord,
				user: 'test-user',
				ts: 123,
				txSig: '123',
				txSigIndex: 123,
				slot: 123,
			}) + '\n';

		mockGetObject.mockResolvedValue(duplicateRecord + duplicateRecord);

		await handler(mockEvent);

		expect(mockSettle).toHaveBeenCalledTimes(1);
		expect(mockSettle).toHaveBeenCalledWith([
			{ ...settleRecord, source: IngestionSource.BACKFILL },
		]);
	});

	it('should handle multiple record types in a single file', async () => {
		const multipleRecords =
			JSON.stringify({
				eventType: RecordTypes.SettlePnlRecord,
				user: 'test-user',
				ts: 123,
				txSig: '123',
				txSigIndex: 123,
				slot: 123,
			}) +
			'\n' +
			JSON.stringify({
				user: 'test-user',
				ts: 123,
				txSig: '123',
				txSigIndex: 123,
				marketIndex: 0,
				eventType: RecordTypes.DepositRecord,
			}) +
			'\n';

		mockGetObject.mockResolvedValue(multipleRecords);

		await handler(mockEvent);

		expect(mockSettle).toHaveBeenCalledWith([
			{ ...settleRecord, source: IngestionSource.BACKFILL },
		]);
		expect(mockDeposit).toHaveBeenCalledWith([
			{ ...depositRecord, source: IngestionSource.BACKFILL },
			{ ...depositRecord, entity: 'market', source: IngestionSource.BACKFILL },
		]);
	});

	it('should handle errors in database operations', async () => {
		mockGetObject.mockResolvedValue(
			JSON.stringify({
				eventType: RecordTypes.SettlePnlRecord,
				user: 'test-user',
				ts: 123,
				txSig: '123',
				txSigIndex: 123,
				slot: 123,
			}) + '\n'
		);

		mockSettle.mockRejectedValue(new Error('Database error'));

		const result = await handler(mockEvent);
		expect(result.statusCode).toBe(200);
		expect(mockPutMesssages).toHaveBeenCalled();
	});
});
