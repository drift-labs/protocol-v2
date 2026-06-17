import {
	EntityTypes,
	IngestionSource,
	LastOrderStatus,
	OrderAction,
	OrderActionRecord,
	OrderRecord,
	SerializedMarketFilter,
} from '@backend/common';
import { OrderRepository } from '../../src/repositories/order';

const mockBatchWrite = jest.fn();
const mockQuery = jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
const mockPut = jest.fn();
const mockGet = jest.fn();

jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		batchWrite: mockBatchWrite,
		query: mockQuery,
		put: mockPut,
		get: mockGet,
	}),
}));

describe('OrderRepository', () => {
	const {
		createOrderRecords,
		createOrderActionRecords,
		getOrderRecords,
		getOrderActionRecords,
		getOrderRecordById,
		getOrderRecordsByIds,
		getOrderRecordFromAction,
	} = OrderRepository();

	beforeEach(() => {
		jest.clearAllMocks();
		mockPut.mockResolvedValue({});
	});

	describe('createOrderRecords', () => {
		it('should call batchWrite with correct parameters', async () => {
			const records: Partial<OrderRecord>[] = [
				{
					user: 'user1',
					orderId: 123,
					marketType: SerializedMarketFilter.SPOT,
					marketFilter: SerializedMarketFilter.SPOT,
					source: IngestionSource.SEQUENTIAL,
					baseAssetAmount: 100,
					quoteAssetAmount: 1000,
					ts: 1234567890,
				},
			];

			await createOrderRecords(records as OrderRecord[]);

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					{
						pk: 'USER#user1',
						sk: 'ORDER#TYPE#SPOT#TS#1234567890#ID#123',
						GSI1PK: 'USER#user1',
						GSI1SK: 'ORDER#MARKET#undefined#TS#1234567890#ID#123',
						GSI2PK: 'USER#user1#ORDER#123',
						GSI2SK: 'ORDER#TS#1234567890#ID#123',
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
						user: 'user1',
						orderId: 123,
						source: IngestionSource.SEQUENTIAL,
						marketType: SerializedMarketFilter.SPOT,
						marketFilter: SerializedMarketFilter.SPOT,
						baseAssetAmount: 100,
						quoteAssetAmount: 1000,
						ts: 1234567890,
					},
				],
			});
		});

		it('should return failed items from batchWrite', async () => {
			const failedItems = [{ pk: 'USER#user1', error: 'write error' }];
			mockBatchWrite.mockResolvedValue(failedItems);

			const records: Partial<OrderRecord>[] = [
				{
					user: 'user1',
					orderId: 123,
					marketFilter: SerializedMarketFilter.PERP,
				},
			];

			const result = await createOrderRecords(records as OrderRecord[]);
			expect(result).toBe(failedItems);
		});
	});

	describe('createOrderActionRecords', () => {
		const baseOrderAction: Partial<OrderActionRecord> = {
			user: 'user1',
			userOrderId: 123,
			marketType: SerializedMarketFilter.PERP,
			marketFilter: SerializedMarketFilter.PREDICTION,
			symbol: 'SOL-PERP',
			taker: 'user1',
			maker: 'user2',
			action: OrderAction.FILL,
			source: IngestionSource.SEQUENTIAL,
			takerOrderCumulativeBaseAssetAmountFilled: 50,
			takerOrderCumulativeQuoteAssetAmountFilled: 500,
			takerOrderBaseAssetAmount: 100,
			ts: 1234567890,
			txSig: 'sig123',
			txSigIndex: 1,
			entity: EntityTypes.User,
		};

		it('should successfully process order action when all operations succeed', async () => {
			mockBatchWrite.mockResolvedValue([]);
			const result = await createOrderActionRecords([baseOrderAction as OrderActionRecord]);
			expect(result).toEqual([]);
			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					{
						action: 'fill',
						createdAt: expect.any(Number),
						entity: 'user',
						maker: 'user2',
						marketType: 'perp',
						marketFilter: 'prediction',
						symbol: 'SOL-PERP',
						pk: 'USER#user1#ORDER#123',
						sk: 'ORDER_ACTION#TS#1234567890#SLOT#undefined#SIG#sig123#INDEX#00001',
						taker: 'user1',
						takerOrderBaseAssetAmount: 100,
						takerOrderCumulativeBaseAssetAmountFilled: 50,
						takerOrderCumulativeQuoteAssetAmountFilled: 500,
						ts: 1234567890,
						ttl: 1237246290,
						txSig: 'sig123',
						source: IngestionSource.SEQUENTIAL,
						txSigIndex: 1,
						user: 'user1',
						userOrderId: 123,
					},
				],
			});
			expect(mockPut).toHaveBeenCalledWith(
				expect.objectContaining({
					record: expect.objectContaining({
						pk: 'USER#user1',
						sk: 'ORDER_FILLED#ID#123',
						GSI1PK: 'USER#user1',
						GSI1SK: 'ORDER_FILLED#MARKET#SOL-PERP#TS#1234567890#ID#123',
						GSI2PK: 'USER#user1',
						GSI2SK: 'ORDER_FILLED#TYPE#PREDICTION#TS#1234567890#ID#123',
					}),
				})
			);
		});

		it('should write fill status record for fill actions', async () => {
			mockBatchWrite.mockResolvedValue([]);

			await createOrderActionRecords([baseOrderAction as OrderActionRecord]);

			expect(mockPut).toHaveBeenCalledWith(
				expect.objectContaining({
					record: expect.objectContaining({
						pk: 'USER#user1',
						sk: 'ORDER_FILLED#ID#123',
						GSI1PK: 'USER#user1',
						GSI1SK: 'ORDER_FILLED#MARKET#SOL-PERP#TS#1234567890#ID#123',
						GSI2PK: 'USER#user1',
						GSI2SK: 'ORDER_FILLED#TYPE#PREDICTION#TS#1234567890#ID#123',
					}),
				})
			);
		});

		it('should handle multiple order actions with mixed success/failure', async () => {
			const secondOrderAction = {
				...baseOrderAction,
				userOrderId: 124,
				takerOrderCumulativeBaseAssetAmountFilled: 75,
			};

			mockBatchWrite.mockResolvedValue([
				{
					...secondOrderAction,
					pk: 'USER#user1#ORDER#124',
					sk: 'ORDER_ACTION#TS#1234567890#SLOT#undefined#SIG#sig123#INDEX#00001',
				},
			]);

			const result = await createOrderActionRecords([
				baseOrderAction as OrderActionRecord,
				secondOrderAction as OrderActionRecord,
			]);

			expect(result).toEqual([expect.objectContaining(secondOrderAction)]);
			expect(mockPut).toHaveBeenCalledTimes(1);
		});

		it('should handle batch write failures', async () => {
			const failedWrite = {
				user: 'user1',
				userOrderId: 123,
				pk: 'USER#user1#ORDER#123',
				sk: 'ORDER_ACTION#TS#1234567890#SLOT#undefined#SIG#sig123#INDEX#00001',
				error: 'Write failed',
			};
			mockBatchWrite.mockResolvedValue([failedWrite]);
			const result = await createOrderActionRecords([baseOrderAction as OrderActionRecord]);
			expect(result).toEqual([failedWrite]);
			expect(mockPut).toHaveBeenCalledTimes(0);
		});
	});

	describe('getOrderRecords', () => {
		it('should call query with correct parameters', async () => {
			const id = 'user1';
			const marketFilter = SerializedMarketFilter.PERP;
			const startTs = 1000;
			const endTs = 2000;

			mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });

			await getOrderRecords({ id, marketFilter, startTs, endTs });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':startSk': `ORDER#TYPE#${marketFilter.toUpperCase()}#TS#${startTs}`,
					':endSk': `ORDER#TYPE#${marketFilter.toUpperCase()}#TS#${endTs}`,
				},
				lastEvaluatedKey: undefined,
				limit: 20,
			});
		});

		it('should handle pagination', async () => {
			const id = 'user1';
			const marketFilter = SerializedMarketFilter.PERP;
			const startTs = 1000;
			const endTs = 2000;
			const page = { pk: 'USER#user1', sk: 'ORDER#TYPE#PERP' };

			mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });

			await getOrderRecords({ id, marketFilter, startTs, endTs, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':startSk': `ORDER#TYPE#${marketFilter.toUpperCase()}#TS#${startTs}`,
					':endSk': `ORDER#TYPE#${marketFilter.toUpperCase()}#TS#${endTs}`,
				},
				lastEvaluatedKey: page,
				limit: 20,
			});
		});

		it('should pass limit to query', async () => {
			const id = 'user1';
			const marketFilter = SerializedMarketFilter.PERP;
			const startTs = 1000;
			const endTs = 2000;
			const limit = 5;

			mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });

			await getOrderRecords({ id, marketFilter, startTs, endTs, limit });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':startSk': `ORDER#TYPE#${marketFilter.toUpperCase()}#TS#${startTs}`,
					':endSk': `ORDER#TYPE#${marketFilter.toUpperCase()}#TS#${endTs}`,
				},
				lastEvaluatedKey: undefined,
				limit,
			});
		});

		it('should return records and metadata with cumulative fees', async () => {
			const mockItems = [
				{
					user: 'user1',
					orderId: '123',
					marketType: SerializedMarketFilter.PERP,
					ts: 1758585601,
				},
				{
					user: 'user1',
					orderId: '124',
					marketType: SerializedMarketFilter.PERP,
					ts: 1758585601,
				},
			];

			const mockAction1 = {
				user: 'user1',
				taker: 'user1',
				orderId: '123',
				action: 'cancel',
				ts: 1231,
				takerOrderCumulativeBaseAssetAmountFilled: '1',
				takerOrderCumulativeQuoteAssetAmountFilled: '123',
				takerOrderBaseAssetAmount: '100',
				actionExplanation: 'test',
			};

			const mockAction2 = {
				user: 'user1',
				maker: 'user1',
				orderId: '124',
				action: 'fill',
				ts: 1235,
				makerOrderCumulativeBaseAssetAmountFilled: '2',
				makerOrderCumulativeQuoteAssetAmountFilled: '223',
				makerOrderBaseAssetAmount: '200',
				actionExplanation: 'test',
			};

			const mockFee1 = { Item: { cumulativeFee: '10.5' } };
			const mockFee2 = { Item: { cumulativeFee: '15.2' } };

			const mockLastEvaluatedKey = { pk: 'USER#user1', sk: 'ORDER#TYPE#PERP' };

			mockQuery.mockResolvedValueOnce({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			mockQuery
				.mockResolvedValueOnce({ Items: [mockAction1] })
				.mockResolvedValueOnce({ Items: [mockAction2] });

			mockGet.mockResolvedValueOnce(mockFee1).mockResolvedValueOnce(mockFee2);
			const result = await getOrderRecords({
				id: 'user1',
				marketFilter: SerializedMarketFilter.PERP,
			});

			expect(result).toEqual({
				records: [
					{
						baseAssetAmountFilled: '1',
						cumulativeFee: '10.5',
						lastActionExplanation: 'test',
						lastActionStatus: 'partial_fill_cancelled',
						lastUpdatedTs: 1231,
						marketType: 'perp',
						orderId: '123',
						quoteAssetAmountFilled: '123',
						user: 'user1',
						ts: 1758585601,
					},
					{
						baseAssetAmountFilled: '2',
						cumulativeFee: '15.2',
						lastActionExplanation: 'test',
						lastActionStatus: 'partial_fill',
						lastUpdatedTs: 1235,
						marketType: 'perp',
						orderId: '124',
						quoteAssetAmountFilled: '223',
						user: 'user1',
						ts: 1758585601,
					},
				],
				meta: { nextPage: mockLastEvaluatedKey },
			});

			expect(mockGet).toHaveBeenCalledWith({
				pk: 'USER#user1#ORDER#123',
				sk: 'CUMULATIVE_FEE',
			});
			expect(mockGet).toHaveBeenCalledWith({
				pk: 'USER#user1#ORDER#124',
				sk: 'CUMULATIVE_FEE',
			});
		});

		it('should handle missing fee records', async () => {
			const mockItems = [
				{ user: 'user1', orderId: '123', marketType: SerializedMarketFilter.PERP },
			];

			const mockAction = {
				user: 'user1',
				taker: 'user1',
				orderId: '123',
				action: 'fill',
				ts: 1231,
				takerOrderCumulativeBaseAssetAmountFilled: '1',
				takerOrderCumulativeQuoteAssetAmountFilled: '123',
				takerOrderBaseAssetAmount: '100',
				actionExplanation: 'test',
			};

			const mockNoFee = { Item: null };

			mockQuery
				.mockResolvedValueOnce({ Items: mockItems, LastEvaluatedKey: null })
				.mockResolvedValueOnce({ Items: [mockAction] });

			mockGet.mockResolvedValueOnce(mockNoFee);

			const result = await getOrderRecords({
				id: 'user1',
				marketFilter: SerializedMarketFilter.PERP,
			});

			expect(result.records[0]).toEqual(
				expect.objectContaining({
					cumulativeFee: null,
					baseAssetAmountFilled: '1',
					quoteAssetAmountFilled: '123',
				})
			);
		});

		it('should handle missing order actions gracefully', async () => {
			const mockItems = [
				{ user: 'user1', orderId: '123', marketType: SerializedMarketFilter.PERP },
			];

			mockQuery
				.mockResolvedValueOnce({ Items: mockItems, LastEvaluatedKey: null })
				.mockResolvedValueOnce({ Items: [] });

			mockGet.mockResolvedValueOnce({ Item: null });

			const result = await getOrderRecords({
				id: 'user1',
				marketFilter: SerializedMarketFilter.PERP,
			});

			expect(result.records[0]).toEqual({
				user: 'user1',
				orderId: '123',
				marketType: 'perp',
			});
		});

		it('should handle actions with same timestamp and slot correctly', async () => {
			const mockItems = [
				{
					user: 'user1',
					orderId: '123',
					marketType: SerializedMarketFilter.PERP,
					ts: 1758585601,
				},
			];

			const sameTimestamp = 1234567890;
			const sameSlot = 100;

			const firstAction = {
				user: 'user1',
				taker: 'user1',
				orderId: '123',
				action: 'fill',
				ts: sameTimestamp,
				slot: sameSlot,
				takerOrderCumulativeBaseAssetAmountFilled: '50',
				takerOrderCumulativeQuoteAssetAmountFilled: '500',
				takerOrderBaseAssetAmount: '100',
				actionExplanation: 'first action',
			};

			const secondAction = {
				user: 'user1',
				taker: 'user1',
				orderId: '123',
				action: 'cancel',
				ts: sameTimestamp,
				slot: sameSlot,
				takerOrderCumulativeBaseAssetAmountFilled: '50',
				takerOrderCumulativeQuoteAssetAmountFilled: '500',
				takerOrderBaseAssetAmount: '100',
				actionExplanation: 'second action',
			};

			const sortedAction = {
				...secondAction,
				actionExplanation: 'sorted action',
			};

			mockQuery
				.mockResolvedValueOnce({ Items: mockItems, LastEvaluatedKey: null })
				.mockResolvedValueOnce({ Items: [firstAction, secondAction] })
				.mockResolvedValueOnce({ Items: [sortedAction] });

			mockGet.mockResolvedValueOnce({ Item: { cumulativeFee: '5.0' } });

			const result = await getOrderRecords({
				id: 'user1',
				marketFilter: SerializedMarketFilter.PERP,
			});

			expect(result.records[0]).toEqual(
				expect.objectContaining({
					lastActionExplanation: 'sorted action',
					cumulativeFee: '5.0',
				})
			);

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#user1#ORDER#123`,
				sk: `ORDER_ACTION#TS#${sameTimestamp}#SLOT#${sameSlot}`,
			});
		});
	});

	describe('getOrderRecordsByFill', () => {
		it('should query fill receipt index and merge records with fees', async () => {
			const id = 'user1';
			const marketFilter = SerializedMarketFilter.PERP;
			const symbol = 'BTC-PERP';
			const firstActionTs = 1234567890;
			const startTs = 1000;
			const endTs = 2000;

			mockQuery
				.mockResolvedValueOnce({
					Items: [
						{
							orderId: 123,
							ts: firstActionTs,
							marketFilter,
							symbol,
						},
					],
					LastEvaluatedKey: null,
				})
				.mockResolvedValueOnce({
					Items: [
						{
							user: id,
							orderId: 123,
							marketFilter,
						},
					],
					LastEvaluatedKey: null,
				})
				.mockResolvedValueOnce({
					Items: [
						{
							user: id,
							taker: id,
							action: 'fill',
							actionExplanation: 'fill',
							ts: firstActionTs,
							slot: 1,
							takerOrderCumulativeBaseAssetAmountFilled: 1,
							takerOrderCumulativeQuoteAssetAmountFilled: 2,
							takerOrderBaseAssetAmount: 1,
						},
					],
					LastEvaluatedKey: null,
				});

			mockGet.mockResolvedValueOnce({ Item: { cumulativeFee: 5 } });

			const result = await getOrderRecords({
				id,
				marketFilter,
				hasFill: true,
				symbol,
				startTs,
				endTs,
			});

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				secondaryIndex: 'GSI1',
				expression: 'GSI1PK = :pk AND GSI1SK BETWEEN :startSk AND :endSk',
				lastEvaluatedKey: undefined,
				expressionValues: {
					':startSk': `ORDER_FILLED#MARKET#${symbol.toUpperCase()}#TS#${startTs}`,
					':endSk': `ORDER_FILLED#MARKET#${symbol.toUpperCase()}#TS#${endTs}`,
				},
				limit: 20,
			});
			expect(result.records[0]).toEqual(
				expect.objectContaining({
					user: id,
					orderId: 123,
					lastActionStatus: LastOrderStatus.FILLED,
					lastUpdatedTs: firstActionTs,
					cumulativeFee: 5,
					baseAssetAmountFilled: 1,
					quoteAssetAmountFilled: 2,
				})
			);
		});

		it('should query fill receipt index between timestamps when provided', async () => {
			const id = 'user1';
			const marketFilter = SerializedMarketFilter.PERP;
			const symbol = 'BTC-PERP';
			const startTs = 1000;
			const endTs = 2000;

			mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: null });

			await getOrderRecords({
				id,
				marketFilter,
				hasFill: true,
				symbol,
				startTs,
				endTs,
			});

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				secondaryIndex: 'GSI1',
				expression: 'GSI1PK = :pk AND GSI1SK BETWEEN :startSk AND :endSk',
				lastEvaluatedKey: undefined,
				expressionValues: {
					':startSk': `ORDER_FILLED#MARKET#${symbol.toUpperCase()}#TS#${startTs}`,
					':endSk': `ORDER_FILLED#MARKET#${symbol.toUpperCase()}#TS#${endTs}`,
				},
				limit: 20,
			});
		});

		it('should pass limit to fill receipt query', async () => {
			const id = 'user1';
			const marketFilter = SerializedMarketFilter.PERP;
			const symbol = 'BTC-PERP';
			const startTs = 1000;
			const endTs = 2000;
			const limit = 10;

			mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: null });

			await getOrderRecords({
				id,
				marketFilter,
				hasFill: true,
				symbol,
				startTs,
				endTs,
				limit,
			});

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				secondaryIndex: 'GSI1',
				expression: 'GSI1PK = :pk AND GSI1SK BETWEEN :startSk AND :endSk',
				lastEvaluatedKey: undefined,
				expressionValues: {
					':startSk': `ORDER_FILLED#MARKET#${symbol.toUpperCase()}#TS#${startTs}`,
					':endSk': `ORDER_FILLED#MARKET#${symbol.toUpperCase()}#TS#${endTs}`,
				},
				limit,
			});
		});

		it('should query fill receipt index without symbol using primary keys', async () => {
			const id = 'user1';
			const marketFilter = SerializedMarketFilter.PERP;
			const startTs = 1000;
			const endTs = 2000;

			mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: null });

			await getOrderRecords({
				id,
				marketFilter,
				hasFill: true,
				startTs,
				endTs,
			});

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				secondaryIndex: 'GSI2',
				expression: 'GSI2PK = :pk AND GSI2SK BETWEEN :startSk AND :endSk',
				lastEvaluatedKey: undefined,
				expressionValues: {
					':startSk': `ORDER_FILLED#TYPE#${marketFilter.toUpperCase()}#TS#${startTs}`,
					':endSk': `ORDER_FILLED#TYPE#${marketFilter.toUpperCase()}#TS#${endTs}`,
				},
				limit: 20,
			});
		});
	});

	describe('getOrderRecordsBySymbol', () => {
		it('should call query with correct parameters', async () => {
			const id = 'user1';
			const marketFilter = SerializedMarketFilter.PERP;
			const symbol = 'BTC-PERP';
			const startTs = 1000;
			const endTs = 2000;

			mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });

			await getOrderRecords({ id, marketFilter, symbol, startTs, endTs });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				expression: 'GSI1PK = :pk AND GSI1SK BETWEEN :startSk AND :endSk',
				expressionValues: {
					':startSk': `ORDER#MARKET#${symbol}#TS#${startTs}`,
					':endSk': `ORDER#MARKET#${symbol}#TS#${endTs}`,
				},
				secondaryIndex: 'GSI1',
				lastEvaluatedKey: undefined,
				limit: 20,
			});
		});

		it('should handle pagination', async () => {
			const id = 'user1';
			const marketFilter = SerializedMarketFilter.PERP;
			const symbol = 'BTC-PERP';
			const startTs = 1000;
			const endTs = 2000;
			const page = { pk: 'USER#user1', sk: 'ORDER#MARKET#BTC-PERP#' };

			mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });

			await getOrderRecords({ id, marketFilter, symbol, startTs, endTs, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				expression: 'GSI1PK = :pk AND GSI1SK BETWEEN :startSk AND :endSk',
				expressionValues: {
					':startSk': `ORDER#MARKET#${symbol}#TS#${startTs}`,
					':endSk': `ORDER#MARKET#${symbol}#TS#${endTs}`,
				},
				secondaryIndex: 'GSI1',
				lastEvaluatedKey: page,
				limit: 20,
			});
		});

		it('should merge order records with latest actions and fees', async () => {
			const marketFilter = SerializedMarketFilter.PERP;
			const mockItems = [
				{ user: 'user1', orderId: '123', symbol: 'BTC-PERP', ts: 1758585601 },
			];

			const mockAction = {
				user: 'user1',
				taker: 'user1',
				orderId: '123',
				action: 'fill',
				ts: 1231,
				takerOrderCumulativeBaseAssetAmountFilled: '0.1',
				takerOrderCumulativeQuoteAssetAmountFilled: '1000',
				takerOrderBaseAssetAmount: '0.2',
				actionExplanation: 'partial fill',
			};

			const mockFee = { Item: { cumulativeFee: '2.5' } };

			mockQuery
				.mockResolvedValueOnce({ Items: mockItems, LastEvaluatedKey: null })
				.mockResolvedValueOnce({ Items: [mockAction] });

			mockGet.mockResolvedValueOnce(mockFee);

			const result = await getOrderRecords({
				id: 'user1',
				marketFilter,
				symbol: 'BTC-PERP',
			});

			expect(result.records[0]).toEqual(
				expect.objectContaining({
					user: 'user1',
					orderId: '123',
					symbol: 'BTC-PERP',
					cumulativeFee: '2.5',
					baseAssetAmountFilled: '0.1',
					quoteAssetAmountFilled: '1000',
					lastActionStatus: 'partial_fill',
					lastUpdatedTs: 1231,
					lastActionExplanation: 'partial fill',
				})
			);
		});
	});

	describe('getOrderActionRecords', () => {
		it('should call query with correct parameters', async () => {
			const accountId = 'user1';
			const orderId = 123;

			await getOrderActionRecords({ accountId, orderId });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${accountId}#ORDER#${orderId}`,
				sk: 'ORDER_ACTION',
				lastEvaluatedKey: undefined,
			});
		});

		it('should handle pagination', async () => {
			const accountId = 'user1';
			const orderId = 123;
			const page = { pk: 'USER#user1#ORDER#123', sk: 'ORDER_ACTION' };

			await getOrderActionRecords({ accountId, orderId, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${accountId}#ORDER#${orderId}`,
				sk: 'ORDER_ACTION',
				lastEvaluatedKey: page,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ accountId: 'user1', orderId: 123, action: 'fill' },
				{ accountId: 'user1', orderId: 123, action: 'cancel' },
			];
			const mockLastEvaluatedKey = {
				pk: 'USER#user1#ORDER#123',
				sk: 'ORDER_ACTION',
			};

			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getOrderActionRecords({
				accountId: 'user1',
				orderId: 123,
			});

			expect(result).toEqual({
				records: mockItems,
				meta: { nextPage: mockLastEvaluatedKey },
			});
		});
	});

	describe('getOrderRecordById', () => {
		it('should return null if no indexed record exists', async () => {
			const user = 'user1';
			const orderId = 123;

			mockQuery.mockResolvedValueOnce({ Items: [] });

			const result = await getOrderRecordById({ user, orderId });

			expect(result).toBeNull();
			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${user}#ORDER#${orderId}`,
				secondaryIndex: 'GSI2',
				expression: 'GSI2PK = :pk',
				limit: 1,
			});
		});

		it('should return indexed record when it exists', async () => {
			const user = 'user1';
			const orderId = 123;
			const mockOrderRecord = {
				orderId,
				user,
				marketFilter: 'perp',
				symbol: 'SOL-PERP',
			};

			mockQuery.mockResolvedValueOnce({ Items: [mockOrderRecord] });

			const result = await getOrderRecordById({ user, orderId });

			expect(result).toEqual(mockOrderRecord);
		});
	});

	describe('getOrderRecordsByIds', () => {
		it('should return records and missing ids', async () => {
			const user = 'user1';
			const orderIds = [123, 456];

			mockQuery.mockImplementation(({ pk }) => {
				if (pk === `USER#${user}#ORDER#123`) {
					return Promise.resolve({
						Items: [{ user, orderId: 123, marketFilter: 'perp' }],
					});
				}
				if (pk === `USER#${user}#ORDER#456`) {
					return Promise.resolve({ Items: [] });
				}
				return Promise.resolve({ Items: [] });
			});

			const result = await getOrderRecordsByIds({ user, orderIds });

			expect(result).toEqual({
				records: [expect.objectContaining({ orderId: 123 })],
				missingOrderIds: [456],
			});
		});
	});

	describe('getOrderRecordFromAction', () => {
		const mockUser = 'user1';
		const mockOrderId = 123;
		const mockMarketFilter = 'perp';
		const mockTs = 1738119113;

		it('should return null if no order records found', async () => {
			mockQuery.mockResolvedValueOnce({ Items: [] }).mockResolvedValueOnce({ Items: [] });

			const result = await getOrderRecordFromAction({
				user: mockUser,
				orderId: mockOrderId,
			});

			expect(result).toBeNull();
			expect(mockQuery).toHaveBeenNthCalledWith(1, {
				pk: `USER#${mockUser}#ORDER#${mockOrderId}`,
				secondaryIndex: 'GSI2',
				expression: 'GSI2PK = :pk',
				limit: 1,
			});
			expect(mockQuery).toHaveBeenNthCalledWith(2, {
				pk: `USER#${mockUser}#ORDER#${mockOrderId}`,
				sk: 'ORDER_ACTION',
				orderAsc: true,
				limit: 1,
			});
			expect(mockGet).not.toHaveBeenCalled();
		});

		it('should return order record when index record exists', async () => {
			const mockOrderRecord = {
				orderId: mockOrderId,
				user: mockUser,
				marketFilter: mockMarketFilter,
				symbol: 'SOL-PERP',
				orderType: 'TRIGGER_LIMIT',
			};

			mockQuery.mockResolvedValueOnce({ Items: [mockOrderRecord] });

			const result = await getOrderRecordFromAction({
				user: mockUser,
				orderId: mockOrderId,
			});

			expect(result).toEqual(mockOrderRecord);
			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${mockUser}#ORDER#${mockOrderId}`,
				secondaryIndex: 'GSI2',
				expression: 'GSI2PK = :pk',
				limit: 1,
			});
			expect(mockGet).not.toHaveBeenCalled();
		});

		it('should handle the case when order record does not exist', async () => {
			const mockActionRecord = {
				marketFilter: mockMarketFilter,
				ts: mockTs,
			};

			mockQuery
				.mockResolvedValueOnce({ Items: [] })
				.mockResolvedValueOnce({ Items: [mockActionRecord] });
			mockGet.mockResolvedValueOnce({ Item: null });

			const result = await getOrderRecordFromAction({
				user: mockUser,
				orderId: mockOrderId,
			});

			expect(result).toBeNull();
		});

		it('should handle errors from get operation', async () => {
			const mockActionRecord = {
				marketFilter: mockMarketFilter,
				ts: mockTs,
			};

			mockQuery
				.mockResolvedValueOnce({ Items: [] })
				.mockResolvedValueOnce({ Items: [mockActionRecord] });

			const error = new Error('Database error on get');
			mockGet.mockRejectedValueOnce(error);

			await expect(
				getOrderRecordFromAction({
					user: mockUser,
					orderId: mockOrderId,
				})
			).rejects.toThrow('Database error on get');

			expect(mockQuery).toHaveBeenCalled();
			expect(mockGet).toHaveBeenCalled();
		});

		it('should include latest merge data when includeLatest is true', async () => {
			const mockOrderRecord: Partial<OrderRecord> = {
				orderId: mockOrderId,
				user: mockUser,
				marketFilter: mockMarketFilter as SerializedMarketFilter,
				ts: mockTs,
				symbol: 'SOL-PERP',
				baseAssetAmountFilled: 0,
				quoteAssetAmountFilled: 0,
			};

			const mockLatestAction: Partial<OrderActionRecord> = {
				action: OrderAction.FILL,
				actionExplanation: 'fill',
				ts: mockTs + 10,
				slot: 999,
				user: mockUser,
				taker: mockUser,
				takerOrderCumulativeBaseAssetAmountFilled: 100,
				takerOrderCumulativeQuoteAssetAmountFilled: 1000,
				takerOrderBaseAssetAmount: 100,
			};

			mockQuery
				.mockResolvedValueOnce({ Items: [mockOrderRecord] })
				.mockResolvedValueOnce({ Items: [mockLatestAction] });

			mockGet.mockResolvedValueOnce({ Item: { cumulativeFee: 123 } });

			const result = await getOrderRecordFromAction({
				user: mockUser,
				orderId: mockOrderId,
				includeLatest: true,
			});

			expect(result).toMatchObject({
				...mockOrderRecord,
				lastUpdatedTs: mockLatestAction.ts,
				lastActionExplanation: mockLatestAction.actionExplanation,
				baseAssetAmountFilled: mockLatestAction.takerOrderCumulativeBaseAssetAmountFilled,
				quoteAssetAmountFilled: mockLatestAction.takerOrderCumulativeQuoteAssetAmountFilled,
			});
		});
	});
});
