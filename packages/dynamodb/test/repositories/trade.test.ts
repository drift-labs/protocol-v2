import { EntityTypes, IngestionSource, TradeRecord } from '@backend/common';
import { TradeRepository } from '../../src/repositories/trade';

const mockBatchWrite = jest.fn();
const mockQuery = jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
const mockUpdate = jest.fn();

jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		batchWrite: mockBatchWrite,
		query: mockQuery,
		update: mockUpdate,
	}),
}));

const mockOrderAction = jest.fn();
jest.mock('../../src/repositories/order', () => ({
	OrderRepository: () => ({
		createOrderActionRecords: mockOrderAction,
	}),
}));

jest.mock('@backend/common', () => ({
	...jest.requireActual('@backend/common'),
	isFeatureEnabled: jest.fn().mockReturnValue(true),
}));

describe('TradeRepository', () => {
	const {
		createTradeRecords,
		getTradeRecords,
		getTradeRecordsBySymbol,
		getTradeRecordsBetweenTimestamps,
		getPositionRecords,
	} = TradeRepository();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('createTradeRecords', () => {
		it('should call batchWrite with correct parameters', async () => {
			mockOrderAction.mockResolvedValue([]);
			mockBatchWrite.mockResolvedValue([]);
			mockUpdate.mockResolvedValue({});

			const records: Partial<TradeRecord>[] = [
				{
					user: 'user1',
					slot: 123,
					ts: 1234567890,
					txSig: '123',
					symbol: 'SOL-PERP',
					txSigIndex: 123,
					source: IngestionSource.SEQUENTIAL,
					entity: EntityTypes.User,
				},
				{
					user: 'user2',
					slot: 124,
					ts: 1234567891,
					txSig: '123',
					symbol: 'SOL-PERP',
					txSigIndex: 123,
					source: IngestionSource.SEQUENTIAL,
					entity: EntityTypes.Market,
				},
			];

			await createTradeRecords(records as TradeRecord[]);

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					{
						pk: 'USER#user1',
						sk: 'TRADE#TS#1234567890#SLOT#123#SIG#123#INDEX#00123',
						GSI1PK: 'USER#user1',
						GSI1SK: 'TRADE#MARKET#SOL-PERP#TS#1234567890#SLOT#123#SIG#123#INDEX#00123',
						user: 'user1',
						slot: 123,
						ts: 1234567890,
						txSig: '123',
						txSigIndex: 123,
						source: IngestionSource.SEQUENTIAL,
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
						entity: 'user',
						symbol: 'SOL-PERP',
					},
					{
						pk: 'MARKET#SOL-PERP',
						sk: 'TRADE#TS#1234567891#SLOT#124#SIG#123#INDEX#00123',
						user: 'user2',
						slot: 124,
						ts: 1234567891,
						txSig: '123',
						txSigIndex: 123,
						source: IngestionSource.SEQUENTIAL,
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
						symbol: 'SOL-PERP',
						entity: 'market',
					},
				],
			});
		});

		it('should return the result of batchWrite', async () => {
			const failedWrite = [{ id: '1', data: 'test1' }];
			const failedUpdate = [{ id: '2', data: 'test2' }];
			mockBatchWrite.mockResolvedValue(failedWrite);
			mockOrderAction.mockResolvedValue(failedUpdate);
			mockUpdate.mockResolvedValue({});

			const records: Partial<TradeRecord>[] = [
				{
					user: 'user1',
					ts: 1234567890,
					txSigIndex: 123,
					entity: EntityTypes.Market,
				},
			];

			const result = await createTradeRecords(records as TradeRecord[]);

			expect(result).toEqual([...failedUpdate, ...failedWrite]);
		});

		describe('updateCumulativeFeeRecords', () => {
			it('should update cumulative fee for taker trades', async () => {
				mockOrderAction.mockResolvedValue([]);
				mockBatchWrite.mockResolvedValue([]);
				mockUpdate.mockResolvedValue({});

				const records: Partial<TradeRecord>[] = [
					{
						user: 'user1',
						taker: 'user1',
						maker: 'user2',
						takerFee: 5.5,
						makerFee: 2.5,
						fillRecordId: 'fill123',
						ts: 1234567890,
						userOrderId: 100,
						entity: EntityTypes.User,
						slot: 123,
						txSig: 'sig123',
						txSigIndex: 1,
						source: IngestionSource.SEQUENTIAL,
					},
				];

				await createTradeRecords(records as TradeRecord[]);

				expect(mockUpdate).toHaveBeenCalledWith({
					pk: 'USER#user1#ORDER#100',
					sk: 'CUMULATIVE_FEE',
					updateExpression:
						'SET lastUpdatedTs = :timestamp, #ttl = :ttl ADD cumulativeFee :fee, processedFillIds :idSet',
					conditionExpression:
						'attribute_not_exists(processedFillIds) OR NOT contains(processedFillIds, :fillId)',
					expressionNames: {
						'#ttl': 'ttl',
					},
					expressionValues: {
						':fee': 5.5,
						':timestamp': expect.any(Number),
						':idSet': new Set(['fill123']),
						':fillId': 'fill123',
						':ttl': expect.any(Number),
					},
				});
			});

			it('should update cumulative fee for maker trades', async () => {
				mockOrderAction.mockResolvedValue([]);
				mockBatchWrite.mockResolvedValue([]);
				mockUpdate.mockResolvedValue({});

				const records: Partial<TradeRecord>[] = [
					{
						user: 'user2',
						taker: 'user1',
						maker: 'user2',
						takerFee: 5.5,
						makerFee: 2.5,
						fillRecordId: 'fill456',
						ts: 1234567890,
						userOrderId: 200,
						entity: EntityTypes.User,
						slot: 124,
						txSig: 'sig456',
						txSigIndex: 2,
						source: IngestionSource.SEQUENTIAL,
					},
				];

				await createTradeRecords(records as TradeRecord[]);

				expect(mockUpdate).toHaveBeenCalledWith({
					pk: 'USER#user2#ORDER#200',
					sk: 'CUMULATIVE_FEE',
					updateExpression:
						'SET lastUpdatedTs = :timestamp, #ttl = :ttl ADD cumulativeFee :fee, processedFillIds :idSet',
					conditionExpression:
						'attribute_not_exists(processedFillIds) OR NOT contains(processedFillIds, :fillId)',
					expressionNames: {
						'#ttl': 'ttl',
					},
					expressionValues: {
						':fee': 2.5,
						':timestamp': expect.any(Number),
						':idSet': new Set(['fill456']),
						':fillId': 'fill456',
						':ttl': expect.any(Number),
					},
				});
			});

			it('should skip records with zero fees', async () => {
				mockOrderAction.mockResolvedValue([]);
				mockBatchWrite.mockResolvedValue([]);

				const records: Partial<TradeRecord>[] = [
					{
						user: 'user1',
						taker: 'user1',
						maker: 'user2',
						takerFee: 0,
						makerFee: 0,
						fillRecordId: 'fill789',
						ts: 1234567890,
						userOrderId: 300,
						entity: EntityTypes.User,
						slot: 125,
						txSig: 'sig789',
						txSigIndex: 3,
						source: IngestionSource.SEQUENTIAL,
					},
				];

				await createTradeRecords(records as TradeRecord[]);

				expect(mockUpdate).not.toHaveBeenCalled();
			});

			it('should skip records with null/undefined fees', async () => {
				mockOrderAction.mockResolvedValue([]);
				mockBatchWrite.mockResolvedValue([]);

				const records: Partial<TradeRecord>[] = [
					{
						user: 'user1',
						taker: 'user1',
						maker: 'user2',
						takerFee: undefined,
						makerFee: undefined,
						fillRecordId: 'fill999',
						ts: 1234567890,
						userOrderId: 400,
						entity: EntityTypes.User,
						slot: 126,
						txSig: 'sig999',
						txSigIndex: 4,
						source: IngestionSource.SEQUENTIAL,
					},
				];

				await createTradeRecords(records as TradeRecord[]);

				expect(mockUpdate).not.toHaveBeenCalled();
			});

			it('should handle negative fees', async () => {
				mockOrderAction.mockResolvedValue([]);
				mockBatchWrite.mockResolvedValue([]);
				mockUpdate.mockResolvedValue({});

				const records: Partial<TradeRecord>[] = [
					{
						user: 'user1',
						taker: 'user1',
						maker: 'user2',
						takerFee: -3.5,
						makerFee: 1.5,
						fillRecordId: 'fill111',
						ts: 1234567890,
						userOrderId: 500,
						entity: EntityTypes.User,
						slot: 127,
						txSig: 'sig111',
						txSigIndex: 5,
						source: IngestionSource.SEQUENTIAL,
					},
				];

				await createTradeRecords(records as TradeRecord[]);

				expect(mockUpdate).toHaveBeenCalledWith(
					expect.objectContaining({
						expressionValues: expect.objectContaining({
							':fee': -3.5,
						}),
					})
				);
			});

			it('should process multiple records with fees', async () => {
				mockOrderAction.mockResolvedValue([]);
				mockBatchWrite.mockResolvedValue([]);
				mockUpdate.mockResolvedValue({});

				const records: Partial<TradeRecord>[] = [
					{
						user: 'user1',
						taker: 'user1',
						maker: 'user2',
						takerFee: 5.5,
						makerFee: 2.5,
						fillRecordId: 'fill001',
						ts: 1234567890,
						userOrderId: 100,
						entity: EntityTypes.User,
						slot: 128,
						txSig: 'sig001',
						txSigIndex: 6,
						source: IngestionSource.SEQUENTIAL,
					},
					{
						user: 'user2',
						taker: 'user1',
						maker: 'user2',
						takerFee: 3.0,
						makerFee: 1.0,
						fillRecordId: 'fill002',
						ts: 1234567891,
						userOrderId: 200,
						entity: EntityTypes.User,
						slot: 129,
						txSig: 'sig002',
						txSigIndex: 7,
						source: IngestionSource.SEQUENTIAL,
					},
					{
						user: 'user3',
						taker: 'user3',
						maker: 'user4',
						takerFee: 0,
						makerFee: 0,
						fillRecordId: 'fill003',
						ts: 1234567892,
						userOrderId: 300,
						entity: EntityTypes.User,
						slot: 130,
						txSig: 'sig003',
						txSigIndex: 8,
						source: IngestionSource.SEQUENTIAL,
					},
				];

				await createTradeRecords(records as TradeRecord[]);

				expect(mockUpdate).toHaveBeenCalledTimes(2);
				expect(mockUpdate).toHaveBeenNthCalledWith(
					1,
					expect.objectContaining({
						pk: 'USER#user1#ORDER#100',
						sk: 'CUMULATIVE_FEE',
						expressionValues: expect.objectContaining({
							':fee': 5.5,
							':fillId': 'fill001',
						}),
					})
				);
				expect(mockUpdate).toHaveBeenNthCalledWith(
					2,
					expect.objectContaining({
						pk: 'USER#user2#ORDER#200',
						sk: 'CUMULATIVE_FEE',
						expressionValues: expect.objectContaining({
							':fee': 1.0,
							':fillId': 'fill002',
						}),
					})
				);
			});

			it('should handle conditional check failures gracefully', async () => {
				mockOrderAction.mockResolvedValue([]);
				mockBatchWrite.mockResolvedValue([]);

				const conditionalCheckError = new Error('ConditionalCheckFailedException');
				conditionalCheckError.name = 'ConditionalCheckFailedException';
				mockUpdate.mockRejectedValue(conditionalCheckError);

				const records: Partial<TradeRecord>[] = [
					{
						user: 'user1',
						taker: 'user1',
						maker: 'user2',
						takerFee: 5.5,
						makerFee: 2.5,
						fillRecordId: 'duplicate_fill',
						ts: 1234567890,
						userOrderId: 100,
						entity: EntityTypes.User,
						slot: 132,
						txSig: 'sig456',
						txSigIndex: 10,
						source: IngestionSource.SEQUENTIAL,
					},
				];

				// Should not throw, should handle gracefully
				await expect(createTradeRecords(records as TradeRecord[])).resolves.not.toThrow();
			});
		});
	});

	describe('getTradeRecords', () => {
		it('should call query with correct parameters for user', async () => {
			const id = 'user1';
			await getTradeRecords({ id, entity: EntityTypes.User, limit: 30 });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				sk: 'TRADE',
				lastEvaluatedKey: undefined,
				limit: 30,
			});
		});

		it('should call query with correct parameters for market', async () => {
			const id = 'BTC';
			await getTradeRecords({ id, entity: EntityTypes.Market });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `MARKET#${id}`,
				sk: 'TRADE',
				lastEvaluatedKey: undefined,
				limit: 20,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ user: 'user1', ts: 1234567890, txSigIndex: 1 },
				{ user: 'user1', ts: 1234567891, txSigIndex: 2 },
			];
			const mockLastEvaluatedKey = { pk: 'USER#user1', sk: 'TRADE#TS#1234567891' };
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getTradeRecords({ id: 'user1' });

			expect(result).toEqual({
				records: mockItems,
				meta: { nextPage: mockLastEvaluatedKey },
			});
		});

		it('should handle pagination', async () => {
			const id = 'user1';
			const page = { pk: 'USER#user1', sk: 'TRADE#TS#1500000000' };
			await getTradeRecords({ id, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				sk: 'TRADE',
				lastEvaluatedKey: page,
				limit: 20,
			});
		});

		it('should return empty records and null nextPage when no items', async () => {
			mockQuery.mockResolvedValue({
				Items: [],
				LastEvaluatedKey: undefined,
			});

			const result = await getTradeRecords({ id: 'user1' });

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});
	});

	describe('getTradeRecordsBySymbol', () => {
		it('should call query with correct parameters for user', async () => {
			const id = 'user1';
			const symbol = 'SOL-PERP';
			await getTradeRecordsBySymbol({ id, symbol });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				sk: `TRADE#MARKET#${symbol}#`,
				secondaryIndex: 'GSI1',
				lastEvaluatedKey: undefined,
			});
		});

		it('should handle pagination correctly', async () => {
			const id = 'user1';
			const symbol = 'SOL-PERP';
			const page = {
				pk: 'USER#user1',
				sk: 'TRADE#MARKET#SOL-PERP#TS#1500000000',
			};

			await getTradeRecordsBySymbol({ id, symbol, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				sk: `TRADE#MARKET#${symbol}#`,
				secondaryIndex: 'GSI1',
				lastEvaluatedKey: page,
			});
		});

		it('should return records and metadata when items exist', async () => {
			const mockItems = [
				{
					pk: 'USER#user1',
					sk: 'TRADE#MARKET#SOL-PERP#TS#1500000000',
					symbol: 'SOL-PERP',
					txSigIndex: 1,
					source: IngestionSource.SEQUENTIAL,
				},
				{
					pk: 'USER#user1',
					sk: 'TRADE#MARKET#SOL-PERP#TS#1600000000',
					symbol: 'SOL-PERP',
					txSigIndex: 2,
				},
			];
			const mockLastEvaluatedKey = {
				pk: 'USER#user1',
				sk: 'TRADE#MARKET#SOL-PERP#TS#1600000000',
			};

			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getTradeRecordsBySymbol({
				id: 'user1',
				symbol: 'SOL-PERP',
			});

			expect(result).toEqual({
				records: mockItems,
				meta: { nextPage: mockLastEvaluatedKey },
			});
		});

		it('should return empty records and null nextPage when no items exist', async () => {
			mockQuery.mockResolvedValue({
				Items: [],
				LastEvaluatedKey: undefined,
			});

			const result = await getTradeRecordsBySymbol({
				id: 'user1',
				symbol: 'SOL-PERP',
			});

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});
	});

	describe('getTradeRecordsBetweenTimestamps', () => {
		const id = 'user1';
		const startTs = 1000000000;
		const endTs = 2000000000;

		it('should call query with correct parameters for user', async () => {
			await getTradeRecordsBetweenTimestamps({
				id,
				startTs,
				endTs,
				entity: EntityTypes.User,
			});

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#user1',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'USER#user1',
					':startSk': 'TRADE#TS#1000000000',
					':endSk': 'TRADE#TS#2000000000',
				},
				lastEvaluatedKey: undefined,
			});
		});

		it('should call query with correct parameters for market', async () => {
			await getTradeRecordsBetweenTimestamps({
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
					':startSk': 'TRADE#TS#1000000000',
					':endSk': 'TRADE#TS#2000000000',
				},
				lastEvaluatedKey: undefined,
			});
		});

		it('should handle pagination', async () => {
			const page = { pk: 'USER#user1', sk: 'TRADE#TS#1500000000' };
			await getTradeRecordsBetweenTimestamps({ id, startTs, endTs, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#user1',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'USER#user1',
					':startSk': 'TRADE#TS#1000000000',
					':endSk': 'TRADE#TS#2000000000',
				},
				lastEvaluatedKey: page,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ pk: 'USER#user1', sk: 'TRADE#TS#1500000000', txSigIndex: 1 },
				{ pk: 'USER#user1', sk: 'TRADE#TS#1600000000', txSigIndex: 2 },
			];
			const mockLastEvaluatedKey = { pk: 'USER#user1', sk: 'TRADE#TS#1600000000' };
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getTradeRecordsBetweenTimestamps({ id, startTs, endTs });

			expect(result).toEqual({
				records: mockItems,
				meta: { nextPage: mockLastEvaluatedKey },
			});
		});

		it('should return empty records and null nextPage when no items', async () => {
			mockQuery.mockResolvedValue({
				Items: [],
				LastEvaluatedKey: undefined,
			});

			const result = await getTradeRecordsBetweenTimestamps({ id, startTs, endTs });

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});
	});

	describe('getPositionRecords', () => {
		it('should call query with correct parameters', async () => {
			const id = 'user1';
			await getPositionRecords({ id });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#user1',
				sk: 'TRADE',
				filterExpression:
					'(taker = :user AND takerExistingQuoteEntryAmount <> :null) OR (maker = :user AND makerExistingQuoteEntryAmount <> :null)',
				expressionValues: {
					':user': 'user1',
					':null': null,
				},
				lastEvaluatedKey: null,
				limit: 300,
			});
		});

		it('should handle pagination correctly', async () => {
			const id = 'user1';
			const page = { pk: 'USER#user1', sk: 'TRADE#TS#1500000000' };
			await getPositionRecords({ id, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#user1',
				sk: 'TRADE',
				filterExpression:
					'(taker = :user AND takerExistingQuoteEntryAmount <> :null) OR (maker = :user AND makerExistingQuoteEntryAmount <> :null)',
				expressionValues: {
					':user': 'user1',
					':null': null,
				},
				lastEvaluatedKey: page,
				limit: 300,
			});
		});
		it('should combine position records correctly', async () => {
			const mockItems = [
				{
					taker: 'user1',
					takerFee: 1,
					userExistingBaseAssetAmount: 100,
					userExistingQuoteEntryAmount: 1000,
					takerExistingQuoteEntryAmount: 1000,
					makerExistingQuoteEntryAmount: 0,
					takerExistingBaseAssetAmount: 100,
					makerExistingBaseAssetAmount: 0,
					baseAssetAmountFilled: 150,
					quoteAssetAmountFilled: 500,
					userOrderId: '1',
				},
				{
					taker: 'user1',
					takerFee: 1,
					userExistingBaseAssetAmount: 50,
					userExistingQuoteEntryAmount: 500,
					takerExistingQuoteEntryAmount: 500,
					makerExistingQuoteEntryAmount: 0,
					takerExistingBaseAssetAmount: 50,
					makerExistingBaseAssetAmount: 0,
					baseAssetAmountFilled: 75,
					quoteAssetAmountFilled: 250,
					userOrderId: '1',
				},
			];
			mockQuery.mockResolvedValue({ Items: mockItems, LastEvaluatedKey: undefined });

			const result = await getPositionRecords({ id: 'user1' });

			expect(result.records[0]).toEqual({
				...mockItems[0],
				baseClosedForPnl: 150,
				userExistingQuoteEntryAmount: 1500,
				takerExistingQuoteEntryAmount: 1500,
				makerExistingQuoteEntryAmount: 0,
				userExistingBaseAssetAmount: 150,
				takerExistingBaseAssetAmount: 150,
				makerExistingBaseAssetAmount: 0,
				quoteAssetAmountFilled: 750,
				baseAssetAmountFilled: 225,
				userFee: 2,
			});
		});

		it('should respect maxUniqueOrders parameter', async () => {
			const id = 'user1';
			await getPositionRecords({ id, maxUniqueOrders: 10 });

			const mockItems = Array(15).fill({
				taker: 'user1',
				userOrderId: '1',
				takerFee: 1,
				userExistingBaseAssetAmount: 100,
				baseAssetAmountFilled: 50,
			});
			mockQuery.mockResolvedValue({ Items: mockItems, LastEvaluatedKey: undefined });

			const result = await getPositionRecords({ id, maxUniqueOrders: 10 });
			expect(result.records.length).toBeLessThanOrEqual(10);
		});
	});
});
