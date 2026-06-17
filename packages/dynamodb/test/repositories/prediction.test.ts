import { EntityTypes, IngestionSource, PredictionRecord } from '@backend/common';
import { PredictionRepository } from '../../src/repositories/prediction';

const mockBatchWrite = jest.fn();
const mockQuery = jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		batchWrite: mockBatchWrite,
		query: mockQuery,
	}),
}));

const mockOrderAction = jest.fn();
jest.mock('../../src/repositories/order', () => ({
	OrderRepository: () => ({
		createOrderActionRecords: mockOrderAction,
	}),
}));

describe('PredictionRepository', () => {
	const {
		createPredictionRecords,
		getPredictionRecords,
		getPredictionRecordsBySymbol,
		getPredictionRecordsBetweenTimestamps,
	} = PredictionRepository();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('createPredictionRecords', () => {
		it('should call batchWrite with correct parameters', async () => {
			mockOrderAction.mockResolvedValue([]);
			mockBatchWrite.mockResolvedValue([]);

			const records: Partial<PredictionRecord>[] = [
				{
					user: 'user1',
					slot: 123,
					ts: 1234567890,
					txSig: '123',
					symbol: 'TRUMP-WIN',
					txSigIndex: 123,
					source: IngestionSource.SEQUENTIAL,
					entity: EntityTypes.User,
				},
				{
					slot: 124,
					ts: 1234567891,
					txSig: '124',
					symbol: 'TRUMP-WIN',
					txSigIndex: 124,
					source: IngestionSource.SEQUENTIAL,
					entity: EntityTypes.Market,
				},
			];

			await createPredictionRecords(records as PredictionRecord[]);

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					{
						pk: `USER#user1`,
						sk: `PREDICTION#TS#1234567890#SLOT#123#SIG#123#INDEX#00123`,
						GSI1PK: `USER#user1`,
						GSI1SK: `PREDICTION#MARKET#TRUMP-WIN#TS#1234567890#SLOT#123#SIG#123#INDEX#00123`,
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
						user: 'user1',
						slot: 123,
						ts: 1234567890,
						txSig: '123',
						symbol: 'TRUMP-WIN',
						txSigIndex: 123,
						source: IngestionSource.SEQUENTIAL,
						entity: EntityTypes.User,
					},
					{
						pk: `MARKET#TRUMP-WIN`,
						sk: `PREDICTION#TS#1234567891#SLOT#124#SIG#124#INDEX#00124`,
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
						slot: 124,
						ts: 1234567891,
						txSig: '124',
						symbol: 'TRUMP-WIN',
						txSigIndex: 124,
						source: IngestionSource.SEQUENTIAL,
						entity: EntityTypes.Market,
					},
				],
			});
		});

		it('should return the result of batchWrite', async () => {
			const failedWrite = [{ id: '1', data: 'test1' }];
			const failedUpdate = [{ id: '2', data: 'test2' }];
			mockBatchWrite.mockResolvedValue(failedWrite);
			mockOrderAction.mockResolvedValue(failedUpdate);

			const records: Partial<PredictionRecord>[] = [
				{
					user: 'user1',
					ts: 1234567890,
					txSig: '123',
					txSigIndex: 123,
					entity: EntityTypes.User,
				},
			];

			const result = await createPredictionRecords(records as PredictionRecord[]);
			expect(result).toEqual([...failedUpdate, ...failedWrite]);
		});
	});

	describe('getPredictionRecords', () => {
		it('should call query with correct parameters for user', async () => {
			const id = 'user1';
			await getPredictionRecords({ id, entity: EntityTypes.User });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				sk: 'PREDICTION',
				lastEvaluatedKey: undefined,
			});
		});

		it('should call query with correct parameters for market', async () => {
			const id = 'BTC';
			await getPredictionRecords({ id, entity: EntityTypes.Market });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `MARKET#${id}`,
				sk: 'PREDICTION',
				lastEvaluatedKey: undefined,
			});
		});

		it('should handle pagination', async () => {
			const id = 'user1';
			const page = { pk: 'USER#user1', sk: 'PREDICTION#TS#1500000000' };
			await getPredictionRecords({ id, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				sk: 'PREDICTION',
				lastEvaluatedKey: page,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ user: 'user1', ts: 1234567890, txSigIndex: 1 },
				{ user: 'user1', ts: 1234567891, txSigIndex: 2 },
			];
			const mockLastEvaluatedKey = { pk: 'USER#user1', sk: 'PREDICTION#TS#1234567891' };
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getPredictionRecords({ id: 'user1' });

			expect(result).toEqual({
				records: mockItems,
				meta: { nextPage: mockLastEvaluatedKey },
			});
		});
	});

	describe('getPredictionRecordsBySymbol', () => {
		it('should call query with correct parameters', async () => {
			const id = 'user1';
			const symbol = 'SOL-PERP';
			await getPredictionRecordsBySymbol({ id, symbol });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				sk: `PREDICTION#MARKET#${symbol}#`,
				secondaryIndex: 'GSI1',
				lastEvaluatedKey: undefined,
			});
		});

		it('should handle pagination', async () => {
			const id = 'user1';
			const symbol = 'SOL-PERP';
			const page = { pk: 'USER#user1', sk: 'PREDICTION#MARKET#SOL-PERP#TS#1500000000' };
			await getPredictionRecordsBySymbol({ id, symbol, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				sk: `PREDICTION#MARKET#${symbol}#`,
				secondaryIndex: 'GSI1',
				lastEvaluatedKey: page,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ user: 'user1', symbol: 'SOL-PERP', ts: 1234567890 },
				{ user: 'user1', symbol: 'SOL-PERP', ts: 1234567891 },
			];
			const mockLastEvaluatedKey = {
				pk: 'USER#user1',
				sk: 'PREDICTION#MARKET#SOL-PERP#TS#1234567891',
			};
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getPredictionRecordsBySymbol({
				id: 'user1',
				symbol: 'SOL-PERP',
			});

			expect(result).toEqual({
				records: mockItems,
				meta: { nextPage: mockLastEvaluatedKey },
			});
		});
	});

	describe('getPredictionRecordsBetweenTimestamps', () => {
		const id = 'user1';
		const startTs = 1000000000;
		const endTs = 2000000000;

		it('should call query with correct parameters for user', async () => {
			await getPredictionRecordsBetweenTimestamps({
				id,
				startTs,
				endTs,
			});

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#user1',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'USER#user1',
					':startSk': 'PREDICTION#TS#1000000000',
					':endSk': 'PREDICTION#TS#2000000000',
				},
				lastEvaluatedKey: undefined,
			});
		});

		it('should call query with correct parameters for market', async () => {
			await getPredictionRecordsBetweenTimestamps({
				id: 'BTC',
				startTs,
				endTs,
				entity: EntityTypes.Market,
			});

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'MARKET#BTC',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'MARKET#BTC',
					':startSk': 'PREDICTION#TS#1000000000',
					':endSk': 'PREDICTION#TS#2000000000',
				},
				lastEvaluatedKey: undefined,
			});
		});

		it('should handle pagination', async () => {
			const page = { pk: 'USER#user1', sk: 'PREDICTION#TS#1500000000' };
			await getPredictionRecordsBetweenTimestamps({
				id,
				startTs,
				endTs,
				page,
			});

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#user1',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'USER#user1',
					':startSk': 'PREDICTION#TS#1000000000',
					':endSk': 'PREDICTION#TS#2000000000',
				},
				lastEvaluatedKey: page,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ pk: 'USER#user1', sk: 'PREDICTION#TS#1500000000', txSigIndex: 1 },
				{ pk: 'USER#user1', sk: 'PREDICTION#TS#1600000000', txSigIndex: 2 },
			];
			const mockLastEvaluatedKey = {
				pk: 'USER#user1',
				sk: 'PREDICTION#TS#1600000000',
			};
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getPredictionRecordsBetweenTimestamps({
				id,
				startTs,
				endTs,
			});

			expect(result).toEqual({
				records: mockItems,
				meta: { nextPage: mockLastEvaluatedKey },
			});
		});
	});
});
