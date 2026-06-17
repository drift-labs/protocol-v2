import { EntityTypes, getTimestampDay, RecordTypes, SerializedMarketFilter } from '@backend/common';
import Fastify, { FastifyInstance } from 'fastify';
import Pagination from '../../src/plugins/pagination';
import RuntimeTransformer from '../../src/plugins/runtime-transformer';
import Users from '../../src/routes/user/';
import { fetchArchiveData } from '../../src/utils/fetch-archive-data';
import {
	createMockDepositRecord,
	createMockEarnSnapshotRecord,
	createMockFundingPaymentRecord,
	createMockLiquidationRecord,
	createMockLPRecord,
	createMockOrderActionRecord,
	createMockOrderRecord,
	createMockPositionRecord,
	createMockSettlePnlRecord,
	createMockSwapRecord,
	createMockTradingSnapshotRecord,
	createMockVaultDepositorSnapshotRecord,
} from '../mockRecords';

const mockDeposit = jest.fn();
const mockDepositTimestamp = jest.fn();
const mockTrade = jest.fn();
const mockTradeSymbol = jest.fn();
const mockTradeTimestamp = jest.fn();
const mockSwap = jest.fn();
const mockSwapTimestamp = jest.fn();
const mockSettlePnl = jest.fn();
const mockSettlePnlTimestamp = jest.fn();
const mockFundingPayment = jest.fn();
const mockFundingPaymentTimestamp = jest.fn();
const mockLiquidation = jest.fn();
const mockLiquidationTimestamp = jest.fn();
const mockLP = jest.fn();
const mockLPTimestamp = jest.fn();
const mockPrediction = jest.fn();
const mockPredictionSymbol = jest.fn();
const mockPredictionTimestamp = jest.fn();
const mockOrder = jest.fn();
const mockOrderSymbol = jest.fn();
const mockGetPreviousSnapshot = jest.fn();
const mockGetSnapshotsBetweenTimestamps = jest.fn();
const mockReward = jest.fn();
const mockRewardTimestamp = jest.fn();
const mockPosition = jest.fn();

jest.mock('@backend/dynamodb', () => ({
	DepositRepository: jest.fn(() => ({
		getDepositRecords: mockDeposit,
		getDepositRecordsBetweenTimestamps: mockDepositTimestamp,
	})),
	RewardRepository: jest.fn(() => ({
		getRewardRecords: mockReward,
		getRewardRecordsBetweenTimestamps: mockRewardTimestamp,
	})),
	TradeRepository: jest.fn(() => ({
		getTradeRecords: mockTrade,
		getTradeRecordsBySymbol: mockTradeSymbol,
		getTradeRecordsBetweenTimestamps: mockTradeTimestamp,
		getPositionRecords: mockPosition,
	})),
	SwapRepository: jest.fn(() => ({
		getSwapRecords: mockSwap,
		getSwapRecordsBetweenTimestamps: mockSwapTimestamp,
	})),
	SettlePnlRepository: jest.fn(() => ({
		getSettlePnlRecords: mockSettlePnl,
		getSettlePnlRecordsBetweenTimestamps: mockSettlePnlTimestamp,
	})),
	FundingPaymentRepository: jest.fn(() => ({
		getFundingPaymentRecords: mockFundingPayment,
		getFundingPaymentRecordsBetweenTimestamps: mockFundingPaymentTimestamp,
	})),
	LiquidationRepository: jest.fn(() => ({
		getLiquidationRecords: mockLiquidation,
		getLiquidationRecordsBetweenTimestamps: mockLiquidationTimestamp,
	})),
	LPRepository: jest.fn(() => ({
		getLPRecords: mockLP,
		getLPRecordsBetweenTimestamps: mockLPTimestamp,
	})),
	PredictionRepository: jest.fn(() => ({
		getPredictionRecords: mockPrediction,
		getPredictionRecordsBySymbol: mockPredictionSymbol,
		getPredictionRecordsBetweenTimestamps: mockPredictionTimestamp,
	})),
	OrderRepository: jest.fn(() => ({
		getOrderRecords: mockOrder,
		getOrderActionRecords: mockOrderSymbol,
	})),
	SnapshotRepository: jest.fn(() => ({
		getPreviousSnapshot: mockGetPreviousSnapshot,
		getSnapshotsBetweenTimestamps: mockGetSnapshotsBetweenTimestamps,
	})),
}));

const fixedTimestamp = 1234567890;
jest.mock('@backend/common', () => ({
	...jest.requireActual('@backend/common'),
	getTimestamp: jest.fn(({ days } = {}) =>
		days ? fixedTimestamp + days * 86400 : fixedTimestamp
	),
	getTimestampHour: jest.fn(({ days }) =>
		days ? fixedTimestamp + days * 86400 : fixedTimestamp
	),
	getTimestampDay: jest.fn(({ days }) => fixedTimestamp + days * 86400),
}));

jest.mock('../../src/utils/fetch-archive-data', () => ({
	fetchArchiveData: jest.fn(),
}));

const mockGetUserVolumeAndFees = jest.fn();
jest.mock('@backend/redis', () => ({
	...jest.requireActual('@backend/redis'),
	LeaderboardCacheRepository: () => ({
		getUserVolumeAndFees: mockGetUserVolumeAndFees,
	}),
}));

describe('Users Routes', () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		app = Fastify();
		await app.register(Pagination);
		await app.register(RuntimeTransformer);
		await app.register(Users, { prefix: 'user' });
	});

	afterEach(() => {
		jest.clearAllMocks();
		app.close();
	});

	describe('GET /user/:accountId/orders/:marketFilter', () => {
		it('should return orders for a given account ID and market type', async () => {
			const mockRecords = [
				createMockOrderRecord({ cumulativeFee: 0.0123 }),
				createMockOrderRecord(),
			];
			const mockMeta = { nextPage: 'someToken' };
			mockOrder.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/orders/perp',
			});

			expect(response.statusCode).toBe(200);
			expect(mockOrder).toHaveBeenCalledWith({
				id: 'testAccount',
				marketFilter: 'perp',
				page: undefined,
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1234567890,
						txSig: 'abc123',
						txSigIndex: 0,
						slot: 12345,
						user: 'testuser',
						status: 'open',
						orderType: 'LIMIT',
						marketType: 'perp',
						marketFilter: 'perp',
						orderId: 123,
						userOrderId: 456,
						marketIndex: 1,
						price: '50000.000000',
						baseAssetAmount: '1.000000000',
						quoteAssetAmount: '50000.000000',
						baseAssetAmountFilled: '0.000000000',
						quoteAssetAmountFilled: '0.000000',
						direction: 'LONG',
						reduceOnly: false,
						triggerPrice: '0.000000',
						triggerCondition: 'ABOVE',
						existingPositionDirection: 'LONG',
						postOnly: false,
						immediateOrCancel: false,
						oraclePriceOffset: '0.000000',
						auctionDuration: 0,
						auctionStartPrice: '0.000000',
						auctionEndPrice: '0.000000',
						cumulativeFee: '0.012300',
						maxTs: 1234567890,
						symbol: 'BTC-PERP',
					},
					{
						ts: 1234567890,
						txSig: 'abc123',
						txSigIndex: 0,
						slot: 12345,
						user: 'testuser',
						status: 'open',
						orderType: 'LIMIT',
						marketType: 'perp',
						marketFilter: 'perp',
						orderId: 123,
						userOrderId: 456,
						marketIndex: 1,
						price: '50000.000000',
						baseAssetAmount: '1.000000000',
						quoteAssetAmount: '50000.000000',
						baseAssetAmountFilled: '0.000000000',
						quoteAssetAmountFilled: '0.000000',
						direction: 'LONG',
						reduceOnly: false,
						triggerPrice: '0.000000',
						triggerCondition: 'ABOVE',
						existingPositionDirection: 'LONG',
						postOnly: false,
						immediateOrCancel: false,
						oraclePriceOffset: '0.000000',
						auctionDuration: 0,
						auctionStartPrice: '0.000000',
						auctionEndPrice: '0.000000',
						maxTs: 1234567890,
						symbol: 'BTC-PERP',
					},
				],
				meta: expect.objectContaining({
					nextPage: expect.any(String),
				}),
			});
		});

		it('should support filtering orders with fills', async () => {
			const mockRecords = [createMockOrderRecord()];
			const mockMeta = { nextPage: null };
			mockOrder.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/orders/perp?hasFill=true',
			});

			expect(response.statusCode).toBe(200);
			expect(mockOrder).toHaveBeenCalledWith({
				id: 'testAccount',
				marketFilter: 'perp',
				page: undefined,
				hasFill: true,
			});
		});

		it('should support timestamp filters for orders', async () => {
			const mockRecords = [createMockOrderRecord()];
			const mockMeta = { nextPage: null };
			mockOrder.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/orders/perp?startTs=1700000000&endTs=1700003600',
			});

			expect(response.statusCode).toBe(200);
			expect(mockOrder).toHaveBeenCalledWith({
				id: 'testAccount',
				marketFilter: 'perp',
				page: undefined,
				startTs: 1700000000,
				endTs: 1700003600,
			});
		});

		it('should handle pagination for orders', async () => {
			const lastEvaluatedKey = {
				pk: 'USER#testAccount',
				sk: 'ORDER#TYPE#PERP',
			};
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');

			await app.inject({
				method: 'GET',
				url: `/user/testAccount/orders/perp?page=${encodedToken}`,
			});

			expect(mockOrder).toHaveBeenCalledWith({
				id: 'testAccount',
				marketFilter: 'perp',
				page: lastEvaluatedKey,
			});
		});

		it('should validate market type parameter', async () => {
			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/orders/INVALID_MARKET_TYPE',
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);
			expect(payload.error).toBe('ValidationError');
		});
	});

	describe('GET /user/:accountId/orders/:marketFilter/:symbol', () => {
		it('should return orders for a given account ID and symbol', async () => {
			const mockRecords = [createMockOrderRecord(), createMockOrderRecord()];
			const mockMeta = { nextPage: 'someToken' };
			mockOrder.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/orders/perp/BTC-PERP',
			});

			expect(response.statusCode).toBe(200);
			expect(mockOrder).toHaveBeenCalledWith({
				id: 'testAccount',
				marketFilter: 'perp',
				symbol: 'BTC-PERP',
				page: undefined,
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1234567890,
						txSig: 'abc123',
						txSigIndex: 0,
						slot: 12345,
						user: 'testuser',
						status: 'open',
						orderType: 'LIMIT',
						marketType: 'perp',
						marketFilter: 'perp',
						orderId: 123,
						userOrderId: 456,
						marketIndex: 1,
						price: '50000.000000',
						baseAssetAmount: '1.000000000',
						quoteAssetAmount: '50000.000000',
						baseAssetAmountFilled: '0.000000000',
						quoteAssetAmountFilled: '0.000000',
						direction: 'LONG',
						reduceOnly: false,
						triggerPrice: '0.000000',
						triggerCondition: 'ABOVE',
						existingPositionDirection: 'LONG',
						postOnly: false,
						immediateOrCancel: false,
						oraclePriceOffset: '0.000000',
						auctionDuration: 0,
						auctionStartPrice: '0.000000',
						auctionEndPrice: '0.000000',
						maxTs: 1234567890,
						symbol: 'BTC-PERP',
					},
					{
						ts: 1234567890,
						txSig: 'abc123',
						txSigIndex: 0,
						slot: 12345,
						user: 'testuser',
						status: 'open',
						orderType: 'LIMIT',
						marketType: 'perp',
						marketFilter: 'perp',
						orderId: 123,
						userOrderId: 456,
						marketIndex: 1,
						price: '50000.000000',
						baseAssetAmount: '1.000000000',
						quoteAssetAmount: '50000.000000',
						baseAssetAmountFilled: '0.000000000',
						quoteAssetAmountFilled: '0.000000',
						direction: 'LONG',
						reduceOnly: false,
						triggerPrice: '0.000000',
						triggerCondition: 'ABOVE',
						existingPositionDirection: 'LONG',
						postOnly: false,
						immediateOrCancel: false,
						oraclePriceOffset: '0.000000',
						auctionDuration: 0,
						auctionStartPrice: '0.000000',
						auctionEndPrice: '0.000000',
						maxTs: 1234567890,
						symbol: 'BTC-PERP',
					},
				],
				meta: expect.objectContaining({
					nextPage: expect.any(String),
				}),
			});
		});

		it('should support timestamp filters for symbol orders', async () => {
			const mockRecords = [createMockOrderRecord()];
			const mockMeta = { nextPage: null };
			mockOrder.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/orders/perp/BTC-PERP?startTs=1700000000&endTs=1700003600',
			});

			expect(response.statusCode).toBe(200);
			expect(mockOrder).toHaveBeenCalledWith({
				id: 'testAccount',
				marketFilter: 'perp',
				symbol: 'BTC-PERP',
				page: undefined,
				startTs: 1700000000,
				endTs: 1700003600,
			});
		});

		it('should handle pagination for symbol-specific orders', async () => {
			const lastEvaluatedKey = {
				pk: 'USER#testAccount',
				sk: 'ORDER#MARKET#BTC-PERP#',
			};
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');

			await app.inject({
				method: 'GET',
				url: `/user/testAccount/orders/perp/BTC-PERP?page=${encodedToken}`,
			});

			expect(mockOrder).toHaveBeenCalledWith({
				id: 'testAccount',
				marketFilter: 'perp',
				symbol: 'BTC-PERP',
				page: lastEvaluatedKey,
			});
		});
	});

	describe('GET /user/:accountId/orders/:orderId/actions', () => {
		it('should return order actions for a given order ID', async () => {
			const mockRecords = [createMockOrderActionRecord(), createMockOrderActionRecord()];
			const mockMeta = { nextPage: 'someToken' };
			mockOrderSymbol.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/orders/123/actions',
			});

			expect(response.statusCode).toBe(200);
			expect(mockOrderSymbol).toHaveBeenCalledWith({
				accountId: 'testAccount',
				orderId: 123,
				page: undefined,
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1634567890,
						txSig: 'mock-tx-sig-123456',
						txSigIndex: 0,
						slot: 100000000,
						fillerReward: '0.100000',
						baseAssetAmountFilled: '1.500000000',
						quoteAssetAmountFilled: '45000.000000',
						takerFee: '0.050000',
						makerRebate: '0.020000',
						referrerReward: '0.010000',
						quoteAssetAmountSurplus: '0.000000',
						takerOrderBaseAssetAmount: '2.000000000',
						takerOrderCumulativeBaseAssetAmountFilled: '1.500000000',
						takerOrderCumulativeQuoteAssetAmountFilled: '45000.000000',
						makerOrderBaseAssetAmount: '5.000000000',
						makerOrderCumulativeBaseAssetAmountFilled: '3.000000000',
						makerOrderCumulativeQuoteAssetAmountFilled: '90000.000000',
						oraclePrice: '30000.000000',
						makerFee: '0.030000',
						action: 'fill',
						bitFlags: 0,
						actionExplanation: 'Order filled',
						marketIndex: 0,
						marketType: 'perp',
						marketFilter: 'perp',
						filler: 'filler-pubkey-123',
						fillRecordId: 'fill-record-123',
						taker: 'taker-pubkey-456',
						takerOrderId: 'taker-order-789',
						takerOrderDirection: 'long',
						maker: 'maker-pubkey-789',
						makerOrderId: 'maker-order-012',
						makerOrderDirection: 'short',
						spotFulfillmentMethodFee: '0.000000',
						user: 'user-pubkey-345',
						symbol: 'SOL',
					},
					{
						ts: 1634567890,
						txSig: 'mock-tx-sig-123456',
						txSigIndex: 0,
						slot: 100000000,
						fillerReward: '0.100000',
						baseAssetAmountFilled: '1.500000000',
						quoteAssetAmountFilled: '45000.000000',
						takerFee: '0.050000',
						makerRebate: '0.020000',
						referrerReward: '0.010000',
						quoteAssetAmountSurplus: '0.000000',
						takerOrderBaseAssetAmount: '2.000000000',
						takerOrderCumulativeBaseAssetAmountFilled: '1.500000000',
						takerOrderCumulativeQuoteAssetAmountFilled: '45000.000000',
						makerOrderBaseAssetAmount: '5.000000000',
						makerOrderCumulativeBaseAssetAmountFilled: '3.000000000',
						makerOrderCumulativeQuoteAssetAmountFilled: '90000.000000',
						oraclePrice: '30000.000000',
						makerFee: '0.030000',
						action: 'fill',
						bitFlags: 0,
						actionExplanation: 'Order filled',
						marketIndex: 0,
						marketType: 'perp',
						marketFilter: 'perp',
						filler: 'filler-pubkey-123',
						fillRecordId: 'fill-record-123',
						taker: 'taker-pubkey-456',
						takerOrderId: 'taker-order-789',
						takerOrderDirection: 'long',
						maker: 'maker-pubkey-789',
						makerOrderId: 'maker-order-012',
						makerOrderDirection: 'short',
						spotFulfillmentMethodFee: '0.000000',
						user: 'user-pubkey-345',
						symbol: 'SOL',
					},
				],
				meta: expect.objectContaining({
					nextPage: expect.any(String),
				}),
			});
		});

		it('should handle pagination for order actions', async () => {
			const lastEvaluatedKey = {
				pk: 'USER#testAccount#ORDER#123',
				sk: 'ORDER_ACTION',
			};
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');

			await app.inject({
				method: 'GET',
				url: `/user/testAccount/orders/123/actions?page=${encodedToken}`,
			});

			expect(mockOrderSymbol).toHaveBeenCalledWith({
				accountId: 'testAccount',
				orderId: 123,
				page: lastEvaluatedKey,
			});
		});

		it('should validate orderId parameter', async () => {
			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/orders/invalid_order_id/actions',
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);
			expect(payload.error).toBe('ValidationError');
		});

		it('should handle errors gracefully', async () => {
			mockOrderSymbol.mockRejectedValue(new Error('Database error'));

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/orders/123/actions',
			});

			expect(response.statusCode).toBe(500);
		});
	});

	describe('GET /user/:accountId/trades', () => {
		it('should return trades for a given account ID', async () => {
			const mockRecords = [createMockOrderActionRecord(), createMockOrderActionRecord()];
			const mockMeta = { nextPage: 'someToken' };
			mockTrade.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/trades',
			});

			expect(response.statusCode).toBe(200);
			expect(mockTrade).toHaveBeenCalledWith({
				id: 'testAccount',
				page: undefined,
			});
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1634567890,
						txSig: 'mock-tx-sig-123456',
						txSigIndex: 0,
						slot: 100000000,
						fillerReward: '0.100000',
						baseAssetAmountFilled: '1.500000000',
						quoteAssetAmountFilled: '45000.000000',
						takerFee: '0.050000',
						makerRebate: '0.020000',
						referrerReward: '0.010000',
						quoteAssetAmountSurplus: '0.000000',
						takerOrderBaseAssetAmount: '2.000000000',
						takerOrderCumulativeBaseAssetAmountFilled: '1.500000000',
						takerOrderCumulativeQuoteAssetAmountFilled: '45000.000000',
						makerOrderBaseAssetAmount: '5.000000000',
						makerOrderCumulativeBaseAssetAmountFilled: '3.000000000',
						makerOrderCumulativeQuoteAssetAmountFilled: '90000.000000',
						oraclePrice: '30000.000000',
						makerFee: '0.030000',
						action: 'fill',
						bitFlags: 0,
						actionExplanation: 'Order filled',
						marketIndex: 0,
						marketType: 'perp',
						marketFilter: 'perp',
						filler: 'filler-pubkey-123',
						fillRecordId: 'fill-record-123',
						taker: 'taker-pubkey-456',
						takerOrderId: 'taker-order-789',
						takerOrderDirection: 'long',
						maker: 'maker-pubkey-789',
						makerOrderId: 'maker-order-012',
						makerOrderDirection: 'short',
						spotFulfillmentMethodFee: '0.000000',
						user: 'user-pubkey-345',
						symbol: 'SOL',
					},
					{
						ts: 1634567890,
						txSig: 'mock-tx-sig-123456',
						txSigIndex: 0,
						slot: 100000000,
						fillerReward: '0.100000',
						baseAssetAmountFilled: '1.500000000',
						quoteAssetAmountFilled: '45000.000000',
						takerFee: '0.050000',
						makerRebate: '0.020000',
						referrerReward: '0.010000',
						quoteAssetAmountSurplus: '0.000000',
						takerOrderBaseAssetAmount: '2.000000000',
						takerOrderCumulativeBaseAssetAmountFilled: '1.500000000',
						takerOrderCumulativeQuoteAssetAmountFilled: '45000.000000',
						makerOrderBaseAssetAmount: '5.000000000',
						makerOrderCumulativeBaseAssetAmountFilled: '3.000000000',
						makerOrderCumulativeQuoteAssetAmountFilled: '90000.000000',
						oraclePrice: '30000.000000',
						makerFee: '0.030000',
						action: 'fill',
						bitFlags: 0,
						actionExplanation: 'Order filled',
						marketIndex: 0,
						marketType: 'perp',
						marketFilter: 'perp',
						filler: 'filler-pubkey-123',
						fillRecordId: 'fill-record-123',
						taker: 'taker-pubkey-456',
						takerOrderId: 'taker-order-789',
						takerOrderDirection: 'long',
						maker: 'maker-pubkey-789',
						makerOrderId: 'maker-order-012',
						makerOrderDirection: 'short',
						spotFulfillmentMethodFee: '0.000000',
						user: 'user-pubkey-345',
						symbol: 'SOL',
					},
				],
				meta: expect.objectContaining({
					nextPage: expect.any(String),
				}),
			});
		});

		it('should handle pagination for trades', async () => {
			const lastEvaluatedKey = { pk: 'USER#testAccount', sk: 'TRADE#TS#1234567890' };
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');
			const mockRecords = [createMockOrderActionRecord()];
			const mockMeta = { nextPage: 'someToken' };
			mockTrade.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			await app.inject({
				method: 'GET',
				url: `/user/testAccount/trades?page=${encodedToken}`,
			});

			expect(mockTrade).toHaveBeenCalledWith({
				id: 'testAccount',
				page: lastEvaluatedKey,
			});
		});

		it('should handle errors gracefully', async () => {
			mockTrade.mockRejectedValue(new Error('Database error'));

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/trades',
			});

			expect(response.statusCode).toBe(500);
		});
	});

	describe('GET /user/:accountId/trades/:symbol', () => {
		it('should return trades for a given account ID and symbol', async () => {
			const mockRecords = [createMockOrderActionRecord(), createMockOrderActionRecord()];
			const mockMeta = { nextPage: 'someToken' };
			mockTradeSymbol.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/trades/BTC-PERP',
			});

			expect(response.statusCode).toBe(200);
			expect(mockTradeSymbol).toHaveBeenCalledWith({
				id: 'testAccount',
				symbol: 'BTC-PERP',
				page: undefined,
			});
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1634567890,
						txSig: 'mock-tx-sig-123456',
						txSigIndex: 0,
						slot: 100000000,
						fillerReward: '0.100000',
						baseAssetAmountFilled: '1.500000000',
						quoteAssetAmountFilled: '45000.000000',
						takerFee: '0.050000',
						makerRebate: '0.020000',
						referrerReward: '0.010000',
						quoteAssetAmountSurplus: '0.000000',
						takerOrderBaseAssetAmount: '2.000000000',
						takerOrderCumulativeBaseAssetAmountFilled: '1.500000000',
						takerOrderCumulativeQuoteAssetAmountFilled: '45000.000000',
						makerOrderBaseAssetAmount: '5.000000000',
						makerOrderCumulativeBaseAssetAmountFilled: '3.000000000',
						makerOrderCumulativeQuoteAssetAmountFilled: '90000.000000',
						oraclePrice: '30000.000000',
						makerFee: '0.030000',
						action: 'fill',
						bitFlags: 0,
						actionExplanation: 'Order filled',
						marketIndex: 0,
						marketType: 'perp',
						marketFilter: 'perp',
						filler: 'filler-pubkey-123',
						fillRecordId: 'fill-record-123',
						taker: 'taker-pubkey-456',
						takerOrderId: 'taker-order-789',
						takerOrderDirection: 'long',
						maker: 'maker-pubkey-789',
						makerOrderId: 'maker-order-012',
						makerOrderDirection: 'short',
						spotFulfillmentMethodFee: '0.000000',
						user: 'user-pubkey-345',
						symbol: 'SOL',
					},
					{
						ts: 1634567890,
						txSig: 'mock-tx-sig-123456',
						txSigIndex: 0,
						slot: 100000000,
						fillerReward: '0.100000',
						baseAssetAmountFilled: '1.500000000',
						quoteAssetAmountFilled: '45000.000000',
						takerFee: '0.050000',
						makerRebate: '0.020000',
						referrerReward: '0.010000',
						quoteAssetAmountSurplus: '0.000000',
						takerOrderBaseAssetAmount: '2.000000000',
						takerOrderCumulativeBaseAssetAmountFilled: '1.500000000',
						takerOrderCumulativeQuoteAssetAmountFilled: '45000.000000',
						makerOrderBaseAssetAmount: '5.000000000',
						makerOrderCumulativeBaseAssetAmountFilled: '3.000000000',
						makerOrderCumulativeQuoteAssetAmountFilled: '90000.000000',
						oraclePrice: '30000.000000',
						makerFee: '0.030000',
						action: 'fill',
						bitFlags: 0,
						actionExplanation: 'Order filled',
						marketIndex: 0,
						marketType: 'perp',
						marketFilter: 'perp',
						filler: 'filler-pubkey-123',
						fillRecordId: 'fill-record-123',
						taker: 'taker-pubkey-456',
						takerOrderId: 'taker-order-789',
						takerOrderDirection: 'long',
						maker: 'maker-pubkey-789',
						makerOrderId: 'maker-order-012',
						makerOrderDirection: 'short',
						spotFulfillmentMethodFee: '0.000000',
						user: 'user-pubkey-345',
						symbol: 'SOL',
					},
				],
				meta: expect.objectContaining({
					nextPage: expect.any(String),
				}),
			});
		});

		it('should handle pagination for symbol-specific trades', async () => {
			const lastEvaluatedKey = {
				pk: 'USER#testAccount',
				sk: 'TRADE#MARKET#BTC-PERP#TS#1234567890',
			};
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');

			await app.inject({
				method: 'GET',
				url: `/user/testAccount/trades/BTC-PERP?page=${encodedToken}`,
			});

			expect(mockTradeSymbol).toHaveBeenCalledWith({
				id: 'testAccount',
				symbol: 'BTC-PERP',
				page: lastEvaluatedKey,
			});
		});
	});

	describe('GET /user/:accountId/trades/:year/:month', () => {
		it('should return archived trades', async () => {
			const mockResult = {
				success: true,
				records: [createMockOrderActionRecord(), createMockOrderActionRecord()],
				meta: {
					records: 2,
					totalRecords: 2,
					totalPages: 1,
					currentPage: 1,
					nextPage: null,
				},
			};

			(fetchArchiveData as jest.Mock).mockResolvedValue(mockResult);

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/trades/2024/6',
			});
			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'testAccount',
				year: 2024,
				month: 6,
				page: 1,
				recordType: RecordTypes.TradeRecord,
				getLatestRecords: expect.any(Function),
			});
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1634567890,
						txSig: 'mock-tx-sig-123456',
						txSigIndex: 0,
						slot: 100000000,
						fillerReward: '0.100000',
						baseAssetAmountFilled: '1.500000000',
						quoteAssetAmountFilled: '45000.000000',
						takerFee: '0.050000',
						makerRebate: '0.020000',
						referrerReward: '0.010000',
						quoteAssetAmountSurplus: '0.000000',
						takerOrderBaseAssetAmount: '2.000000000',
						takerOrderCumulativeBaseAssetAmountFilled: '1.500000000',
						takerOrderCumulativeQuoteAssetAmountFilled: '45000.000000',
						makerOrderBaseAssetAmount: '5.000000000',
						makerOrderCumulativeBaseAssetAmountFilled: '3.000000000',
						makerOrderCumulativeQuoteAssetAmountFilled: '90000.000000',
						oraclePrice: '30000.000000',
						makerFee: '0.030000',
						action: 'fill',
						bitFlags: 0,
						actionExplanation: 'Order filled',
						marketIndex: 0,
						marketType: 'perp',
						marketFilter: 'perp',
						filler: 'filler-pubkey-123',
						fillRecordId: 'fill-record-123',
						taker: 'taker-pubkey-456',
						takerOrderId: 'taker-order-789',
						takerOrderDirection: 'long',
						maker: 'maker-pubkey-789',
						makerOrderId: 'maker-order-012',
						makerOrderDirection: 'short',
						spotFulfillmentMethodFee: '0.000000',
						user: 'user-pubkey-345',
						symbol: 'SOL',
					},
					{
						ts: 1634567890,
						txSig: 'mock-tx-sig-123456',
						txSigIndex: 0,
						slot: 100000000,
						fillerReward: '0.100000',
						baseAssetAmountFilled: '1.500000000',
						quoteAssetAmountFilled: '45000.000000',
						takerFee: '0.050000',
						makerRebate: '0.020000',
						referrerReward: '0.010000',
						quoteAssetAmountSurplus: '0.000000',
						takerOrderBaseAssetAmount: '2.000000000',
						takerOrderCumulativeBaseAssetAmountFilled: '1.500000000',
						takerOrderCumulativeQuoteAssetAmountFilled: '45000.000000',
						makerOrderBaseAssetAmount: '5.000000000',
						makerOrderCumulativeBaseAssetAmountFilled: '3.000000000',
						makerOrderCumulativeQuoteAssetAmountFilled: '90000.000000',
						oraclePrice: '30000.000000',
						makerFee: '0.030000',
						action: 'fill',
						bitFlags: 0,
						actionExplanation: 'Order filled',
						marketIndex: 0,
						marketType: 'perp',
						marketFilter: 'perp',
						filler: 'filler-pubkey-123',
						fillRecordId: 'fill-record-123',
						taker: 'taker-pubkey-456',
						takerOrderId: 'taker-order-789',
						takerOrderDirection: 'long',
						maker: 'maker-pubkey-789',
						makerOrderId: 'maker-order-012',
						makerOrderDirection: 'short',
						spotFulfillmentMethodFee: '0.000000',
						user: 'user-pubkey-345',
						symbol: 'SOL',
					},
				],
				meta: {
					records: 2,
					totalRecords: 2,
					currentPage: 1,
					totalPages: 1,
					nextPage: null,
				},
			});
		});
	});

	describe('GET /user/:accountId/predictions', () => {
		it('should return predictions for a given account ID', async () => {
			const mockRecords = [
				createMockOrderActionRecord({ marketFilter: SerializedMarketFilter.PREDICTION }),
				createMockOrderActionRecord({ marketFilter: SerializedMarketFilter.PREDICTION }),
			];
			const mockMeta = { nextPage: 'someToken' };
			mockPrediction.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/predictions',
			});

			expect(response.statusCode).toBe(200);
			expect(mockPrediction).toHaveBeenCalledWith({
				id: 'testAccount',
				page: undefined,
			});
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1634567890,
						txSig: 'mock-tx-sig-123456',
						txSigIndex: 0,
						slot: 100000000,
						fillerReward: '0.100000',
						baseAssetAmountFilled: '1.500000000',
						quoteAssetAmountFilled: '45000.000000',
						takerFee: '0.050000',
						makerRebate: '0.020000',
						referrerReward: '0.010000',
						quoteAssetAmountSurplus: '0.000000',
						takerOrderBaseAssetAmount: '2.000000000',
						takerOrderCumulativeBaseAssetAmountFilled: '1.500000000',
						takerOrderCumulativeQuoteAssetAmountFilled: '45000.000000',
						makerOrderBaseAssetAmount: '5.000000000',
						makerOrderCumulativeBaseAssetAmountFilled: '3.000000000',
						makerOrderCumulativeQuoteAssetAmountFilled: '90000.000000',
						oraclePrice: '30000.000000',
						makerFee: '0.030000',
						action: 'fill',
						bitFlags: 0,
						actionExplanation: 'Order filled',
						marketIndex: 0,
						marketType: 'perp',
						marketFilter: 'prediction',
						filler: 'filler-pubkey-123',
						fillRecordId: 'fill-record-123',
						taker: 'taker-pubkey-456',
						takerOrderId: 'taker-order-789',
						takerOrderDirection: 'long',
						maker: 'maker-pubkey-789',
						makerOrderId: 'maker-order-012',
						makerOrderDirection: 'short',
						spotFulfillmentMethodFee: '0.000000',
						user: 'user-pubkey-345',
						symbol: 'SOL',
					},
					{
						ts: 1634567890,
						txSig: 'mock-tx-sig-123456',
						txSigIndex: 0,
						slot: 100000000,
						fillerReward: '0.100000',
						baseAssetAmountFilled: '1.500000000',
						quoteAssetAmountFilled: '45000.000000',
						takerFee: '0.050000',
						makerRebate: '0.020000',
						referrerReward: '0.010000',
						quoteAssetAmountSurplus: '0.000000',
						takerOrderBaseAssetAmount: '2.000000000',
						takerOrderCumulativeBaseAssetAmountFilled: '1.500000000',
						takerOrderCumulativeQuoteAssetAmountFilled: '45000.000000',
						makerOrderBaseAssetAmount: '5.000000000',
						makerOrderCumulativeBaseAssetAmountFilled: '3.000000000',
						makerOrderCumulativeQuoteAssetAmountFilled: '90000.000000',
						oraclePrice: '30000.000000',
						makerFee: '0.030000',
						action: 'fill',
						bitFlags: 0,
						actionExplanation: 'Order filled',
						marketIndex: 0,
						marketType: 'perp',
						marketFilter: 'prediction',
						filler: 'filler-pubkey-123',
						fillRecordId: 'fill-record-123',
						taker: 'taker-pubkey-456',
						takerOrderId: 'taker-order-789',
						takerOrderDirection: 'long',
						maker: 'maker-pubkey-789',
						makerOrderId: 'maker-order-012',
						makerOrderDirection: 'short',
						spotFulfillmentMethodFee: '0.000000',
						user: 'user-pubkey-345',
						symbol: 'SOL',
					},
				],
				meta: expect.objectContaining({
					nextPage: expect.any(String),
				}),
			});
		});

		it('should handle pagination for predictions', async () => {
			const lastEvaluatedKey = {
				pk: 'USER#testAccount',
				sk: 'PREDICTION#TS#1234567890',
			};
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');

			await app.inject({
				method: 'GET',
				url: `/user/testAccount/predictions?page=${encodedToken}`,
			});

			expect(mockPrediction).toHaveBeenCalledWith({
				id: 'testAccount',
				page: lastEvaluatedKey,
			});
		});
	});

	describe('GET /user/:accountId/predictions/:symbol', () => {
		it('should return predictions for a given account ID and symbol', async () => {
			const mockRecords = [
				createMockOrderActionRecord({ marketFilter: SerializedMarketFilter.PREDICTION }),
				createMockOrderActionRecord({ marketFilter: SerializedMarketFilter.PREDICTION }),
			];
			const mockMeta = { nextPage: 'someToken' };
			mockPredictionSymbol.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/predictions/TRUMP-WIN-2024-BET',
			});

			expect(response.statusCode).toBe(200);
			expect(mockPredictionSymbol).toHaveBeenCalledWith({
				id: 'testAccount',
				symbol: 'TRUMP-WIN-2024-BET',
				page: undefined,
			});
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1634567890,
						txSig: 'mock-tx-sig-123456',
						txSigIndex: 0,
						slot: 100000000,
						fillerReward: '0.100000',
						baseAssetAmountFilled: '1.500000000',
						quoteAssetAmountFilled: '45000.000000',
						takerFee: '0.050000',
						makerRebate: '0.020000',
						referrerReward: '0.010000',
						quoteAssetAmountSurplus: '0.000000',
						takerOrderBaseAssetAmount: '2.000000000',
						takerOrderCumulativeBaseAssetAmountFilled: '1.500000000',
						takerOrderCumulativeQuoteAssetAmountFilled: '45000.000000',
						makerOrderBaseAssetAmount: '5.000000000',
						makerOrderCumulativeBaseAssetAmountFilled: '3.000000000',
						makerOrderCumulativeQuoteAssetAmountFilled: '90000.000000',
						oraclePrice: '30000.000000',
						makerFee: '0.030000',
						action: 'fill',
						bitFlags: 0,
						actionExplanation: 'Order filled',
						marketIndex: 0,
						marketType: 'perp',
						marketFilter: 'prediction',
						filler: 'filler-pubkey-123',
						fillRecordId: 'fill-record-123',
						taker: 'taker-pubkey-456',
						takerOrderId: 'taker-order-789',
						takerOrderDirection: 'long',
						maker: 'maker-pubkey-789',
						makerOrderId: 'maker-order-012',
						makerOrderDirection: 'short',
						spotFulfillmentMethodFee: '0.000000',
						user: 'user-pubkey-345',
						symbol: 'SOL',
					},
					{
						ts: 1634567890,
						txSig: 'mock-tx-sig-123456',
						txSigIndex: 0,
						slot: 100000000,
						fillerReward: '0.100000',
						baseAssetAmountFilled: '1.500000000',
						quoteAssetAmountFilled: '45000.000000',
						takerFee: '0.050000',
						makerRebate: '0.020000',
						referrerReward: '0.010000',
						quoteAssetAmountSurplus: '0.000000',
						takerOrderBaseAssetAmount: '2.000000000',
						takerOrderCumulativeBaseAssetAmountFilled: '1.500000000',
						takerOrderCumulativeQuoteAssetAmountFilled: '45000.000000',
						makerOrderBaseAssetAmount: '5.000000000',
						makerOrderCumulativeBaseAssetAmountFilled: '3.000000000',
						makerOrderCumulativeQuoteAssetAmountFilled: '90000.000000',
						oraclePrice: '30000.000000',
						makerFee: '0.030000',
						action: 'fill',
						bitFlags: 0,
						actionExplanation: 'Order filled',
						marketIndex: 0,
						marketType: 'perp',
						marketFilter: 'prediction',
						filler: 'filler-pubkey-123',
						fillRecordId: 'fill-record-123',
						taker: 'taker-pubkey-456',
						takerOrderId: 'taker-order-789',
						takerOrderDirection: 'long',
						maker: 'maker-pubkey-789',
						makerOrderId: 'maker-order-012',
						makerOrderDirection: 'short',
						spotFulfillmentMethodFee: '0.000000',
						user: 'user-pubkey-345',
						symbol: 'SOL',
					},
				],
				meta: expect.objectContaining({
					nextPage: expect.any(String),
				}),
			});
		});

		it('should handle pagination for symbol-specific predictions', async () => {
			const lastEvaluatedKey = {
				pk: 'USER#testAccount',
				sk: 'PREDICTION#MARKET#TRUMP-WIN-2024-BET#TS#1234567890',
			};
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');

			await app.inject({
				method: 'GET',
				url: `/user/testAccount/predictions/TRUMP-WIN-2024-BET?page=${encodedToken}`,
			});

			expect(mockPredictionSymbol).toHaveBeenCalledWith({
				id: 'testAccount',
				symbol: 'TRUMP-WIN-2024-BET',
				page: lastEvaluatedKey,
			});
		});
	});

	describe('GET /user/:accountId/predictions/:year/:month', () => {
		it('should return archived predictions', async () => {
			const mockResult = {
				success: true,
				records: [
					createMockOrderActionRecord({
						marketFilter: SerializedMarketFilter.PREDICTION,
					}),
					createMockOrderActionRecord({
						marketFilter: SerializedMarketFilter.PREDICTION,
					}),
				],
				meta: {
					records: 2,
					totalRecords: 2,
					totalPages: 1,
					currentPage: 1,
					nextPage: null,
				},
			};
			(fetchArchiveData as jest.Mock).mockResolvedValue(mockResult);

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/predictions/2024/6',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'testAccount',
				year: 2024,
				month: 6,
				page: 1,
				recordType: RecordTypes.PredictionRecord,
				getLatestRecords: expect.any(Function),
			});
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1634567890,
						txSig: 'mock-tx-sig-123456',
						txSigIndex: 0,
						slot: 100000000,
						fillerReward: '0.100000',
						baseAssetAmountFilled: '1.500000000',
						quoteAssetAmountFilled: '45000.000000',
						takerFee: '0.050000',
						makerRebate: '0.020000',
						referrerReward: '0.010000',
						quoteAssetAmountSurplus: '0.000000',
						takerOrderBaseAssetAmount: '2.000000000',
						takerOrderCumulativeBaseAssetAmountFilled: '1.500000000',
						takerOrderCumulativeQuoteAssetAmountFilled: '45000.000000',
						makerOrderBaseAssetAmount: '5.000000000',
						makerOrderCumulativeBaseAssetAmountFilled: '3.000000000',
						makerOrderCumulativeQuoteAssetAmountFilled: '90000.000000',
						oraclePrice: '30000.000000',
						makerFee: '0.030000',
						action: 'fill',
						bitFlags: 0,
						actionExplanation: 'Order filled',
						marketIndex: 0,
						marketType: 'perp',
						marketFilter: 'prediction',
						filler: 'filler-pubkey-123',
						fillRecordId: 'fill-record-123',
						taker: 'taker-pubkey-456',
						takerOrderId: 'taker-order-789',
						takerOrderDirection: 'long',
						maker: 'maker-pubkey-789',
						makerOrderId: 'maker-order-012',
						makerOrderDirection: 'short',
						spotFulfillmentMethodFee: '0.000000',
						user: 'user-pubkey-345',
						symbol: 'SOL',
					},
					{
						ts: 1634567890,
						txSig: 'mock-tx-sig-123456',
						txSigIndex: 0,
						slot: 100000000,
						fillerReward: '0.100000',
						baseAssetAmountFilled: '1.500000000',
						quoteAssetAmountFilled: '45000.000000',
						takerFee: '0.050000',
						makerRebate: '0.020000',
						referrerReward: '0.010000',
						quoteAssetAmountSurplus: '0.000000',
						takerOrderBaseAssetAmount: '2.000000000',
						takerOrderCumulativeBaseAssetAmountFilled: '1.500000000',
						takerOrderCumulativeQuoteAssetAmountFilled: '45000.000000',
						makerOrderBaseAssetAmount: '5.000000000',
						makerOrderCumulativeBaseAssetAmountFilled: '3.000000000',
						makerOrderCumulativeQuoteAssetAmountFilled: '90000.000000',
						oraclePrice: '30000.000000',
						makerFee: '0.030000',
						action: 'fill',
						bitFlags: 0,
						actionExplanation: 'Order filled',
						marketIndex: 0,
						marketType: 'perp',
						marketFilter: 'prediction',
						filler: 'filler-pubkey-123',
						fillRecordId: 'fill-record-123',
						taker: 'taker-pubkey-456',
						takerOrderId: 'taker-order-789',
						takerOrderDirection: 'long',
						maker: 'maker-pubkey-789',
						makerOrderId: 'maker-order-012',
						makerOrderDirection: 'short',
						spotFulfillmentMethodFee: '0.000000',
						user: 'user-pubkey-345',
						symbol: 'SOL',
					},
				],
				meta: {
					records: 2,
					totalRecords: 2,
					currentPage: 1,
					totalPages: 1,
					nextPage: null,
				},
			});
		});

		it('should handle pagination for archived predictions', async () => {
			const mockResult = {
				success: true,
				records: [
					createMockOrderActionRecord({
						marketFilter: SerializedMarketFilter.PREDICTION,
					}),
					createMockOrderActionRecord({
						marketFilter: SerializedMarketFilter.PREDICTION,
					}),
				],
				meta: {
					records: 1,
					totalRecords: 3,
					totalPages: 3,
					currentPage: 2,
					nextPage: 3,
				},
			};
			(fetchArchiveData as jest.Mock).mockResolvedValue(mockResult);

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/predictions/2024/6?page=2',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'testAccount',
				year: 2024,
				month: 6,
				page: 2,
				recordType: RecordTypes.PredictionRecord,
				getLatestRecords: expect.any(Function),
			});
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1634567890,
						txSig: 'mock-tx-sig-123456',
						txSigIndex: 0,
						slot: 100000000,
						fillerReward: '0.100000',
						baseAssetAmountFilled: '1.500000000',
						quoteAssetAmountFilled: '45000.000000',
						takerFee: '0.050000',
						makerRebate: '0.020000',
						referrerReward: '0.010000',
						quoteAssetAmountSurplus: '0.000000',
						takerOrderBaseAssetAmount: '2.000000000',
						takerOrderCumulativeBaseAssetAmountFilled: '1.500000000',
						takerOrderCumulativeQuoteAssetAmountFilled: '45000.000000',
						makerOrderBaseAssetAmount: '5.000000000',
						makerOrderCumulativeBaseAssetAmountFilled: '3.000000000',
						makerOrderCumulativeQuoteAssetAmountFilled: '90000.000000',
						oraclePrice: '30000.000000',
						makerFee: '0.030000',
						action: 'fill',
						bitFlags: 0,
						actionExplanation: 'Order filled',
						marketIndex: 0,
						marketType: 'perp',
						marketFilter: 'prediction',
						filler: 'filler-pubkey-123',
						fillRecordId: 'fill-record-123',
						taker: 'taker-pubkey-456',
						takerOrderId: 'taker-order-789',
						takerOrderDirection: 'long',
						maker: 'maker-pubkey-789',
						makerOrderId: 'maker-order-012',
						makerOrderDirection: 'short',
						spotFulfillmentMethodFee: '0.000000',
						user: 'user-pubkey-345',
						symbol: 'SOL',
					},
					{
						ts: 1634567890,
						txSig: 'mock-tx-sig-123456',
						txSigIndex: 0,
						slot: 100000000,
						fillerReward: '0.100000',
						baseAssetAmountFilled: '1.500000000',
						quoteAssetAmountFilled: '45000.000000',
						takerFee: '0.050000',
						makerRebate: '0.020000',
						referrerReward: '0.010000',
						quoteAssetAmountSurplus: '0.000000',
						takerOrderBaseAssetAmount: '2.000000000',
						takerOrderCumulativeBaseAssetAmountFilled: '1.500000000',
						takerOrderCumulativeQuoteAssetAmountFilled: '45000.000000',
						makerOrderBaseAssetAmount: '5.000000000',
						makerOrderCumulativeBaseAssetAmountFilled: '3.000000000',
						makerOrderCumulativeQuoteAssetAmountFilled: '90000.000000',
						oraclePrice: '30000.000000',
						makerFee: '0.030000',
						action: 'fill',
						bitFlags: 0,
						actionExplanation: 'Order filled',
						marketIndex: 0,
						marketType: 'perp',
						marketFilter: 'prediction',
						filler: 'filler-pubkey-123',
						fillRecordId: 'fill-record-123',
						taker: 'taker-pubkey-456',
						takerOrderId: 'taker-order-789',
						takerOrderDirection: 'long',
						maker: 'maker-pubkey-789',
						makerOrderId: 'maker-order-012',
						makerOrderDirection: 'short',
						spotFulfillmentMethodFee: '0.000000',
						user: 'user-pubkey-345',
						symbol: 'SOL',
					},
				],
				meta: { records: 1, totalRecords: 3, currentPage: 2, totalPages: 3, nextPage: 3 },
			});
		});
	});

	describe('GET /user/:accountId/swaps', () => {
		it('should return swaps for a given account ID', async () => {
			const mockRecords = [createMockSwapRecord(), createMockSwapRecord()];

			const mockMeta = { nextPage: 'someToken' };
			mockSwap.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/swaps',
			});

			expect(response.statusCode).toBe(200);
			expect(mockSwap).toHaveBeenCalledWith({ id: 'testAccount', page: undefined });
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1634567890,
						txSig: 'mock-tx-sig-123456',
						txSigIndex: 0,
						slot: 100000000,
						user: 'user-pubkey-345',
						outMarketIndex: 1,
						inMarketIndex: 0,
						amountOut: '100.000000000',
						amountIn: '95.000000',
						outOraclePrice: '30000.000000',
						inOraclePrice: '1.000000',
						fee: '0.100000000',
						inSymbol: 'USDC',
						outSymbol: 'SOL',
					},
					{
						ts: 1634567890,
						txSig: 'mock-tx-sig-123456',
						txSigIndex: 0,
						slot: 100000000,
						user: 'user-pubkey-345',
						outMarketIndex: 1,
						inMarketIndex: 0,
						amountOut: '100.000000000',
						amountIn: '95.000000',
						outOraclePrice: '30000.000000',
						inOraclePrice: '1.000000',
						fee: '0.100000000',
						inSymbol: 'USDC',
						outSymbol: 'SOL',
					},
				],
				meta: expect.objectContaining({
					nextPage: expect.any(String),
				}),
			});
		});

		it('should handle pagination for swaps', async () => {
			const lastEvaluatedKey = { pk: 'USER#testAccount', sk: 'SWAP#TS#1234567890' };
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');
			const mockRecords = [createMockSwapRecord()];
			const mockMeta = { nextPage: 'nextPageToken' };
			mockSwap.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			await app.inject({
				method: 'GET',
				url: `/user/testAccount/swaps?page=${encodedToken}`,
			});

			expect(mockSwap).toHaveBeenCalledWith({
				id: 'testAccount',
				page: lastEvaluatedKey,
			});
		});
	});

	describe('GET /user/:accountId/swaps/:year/:month', () => {
		it('should return archived swaps for a given account ID, year, and month', async () => {
			const mockResult = {
				success: true,
				records: [createMockSwapRecord(), createMockSwapRecord()],
				meta: {
					records: 2,
					totalRecords: 2,
					totalPages: 1,
					currentPage: 1,
					nextPage: null,
				},
			};
			(fetchArchiveData as jest.Mock).mockResolvedValue(mockResult);

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/swaps/2024/6',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'testAccount',
				year: 2024,
				month: 6,
				page: 1,
				recordType: RecordTypes.SwapRecord,
				getLatestRecords: expect.any(Function),
			});
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1634567890,
						txSig: 'mock-tx-sig-123456',
						txSigIndex: 0,
						slot: 100000000,
						user: 'user-pubkey-345',
						outMarketIndex: 1,
						inMarketIndex: 0,
						amountOut: '100.000000000',
						amountIn: '95.000000',
						outOraclePrice: '30000.000000',
						inOraclePrice: '1.000000',
						fee: '0.100000000',
						inSymbol: 'USDC',
						outSymbol: 'SOL',
					},
					{
						ts: 1634567890,
						txSig: 'mock-tx-sig-123456',
						txSigIndex: 0,
						slot: 100000000,
						user: 'user-pubkey-345',
						outMarketIndex: 1,
						inMarketIndex: 0,
						amountOut: '100.000000000',
						amountIn: '95.000000',
						outOraclePrice: '30000.000000',
						inOraclePrice: '1.000000',
						fee: '0.100000000',
						inSymbol: 'USDC',
						outSymbol: 'SOL',
					},
				],
				meta: {
					records: 2,
					totalRecords: 2,
					currentPage: 1,
					totalPages: 1,
					nextPage: null,
				},
			});
		});

		it('should handle pagination for archived swaps', async () => {
			const mockResult = {
				success: true,
				records: [createMockSwapRecord()],
				meta: {
					records: 1,
					totalRecords: 3,
					totalPages: 3,
					currentPage: 2,
					nextPage: 3,
				},
			};
			(fetchArchiveData as jest.Mock).mockResolvedValue(mockResult);

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/swaps/2024/6?page=2',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'testAccount',
				year: 2024,
				month: 6,
				page: 2,
				recordType: RecordTypes.SwapRecord,
				getLatestRecords: expect.any(Function),
			});
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1634567890,
						txSig: 'mock-tx-sig-123456',
						txSigIndex: 0,
						slot: 100000000,
						user: 'user-pubkey-345',
						outMarketIndex: 1,
						inMarketIndex: 0,
						amountOut: '100.000000000',
						amountIn: '95.000000',
						outOraclePrice: '30000.000000',
						inOraclePrice: '1.000000',
						fee: '0.100000000',
						inSymbol: 'USDC',
						outSymbol: 'SOL',
					},
				],
				meta: { records: 1, totalRecords: 3, currentPage: 2, totalPages: 3, nextPage: 3 },
			});
		});
	});

	describe('GET /user/:accountId/deposits', () => {
		it('should return deposits for a given account ID', async () => {
			const mockRecords = [createMockDepositRecord(), createMockDepositRecord()];

			const mockMeta = { nextPage: 'someToken' };
			mockDeposit.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/deposits',
			});

			expect(response.statusCode).toBe(200);
			expect(mockDeposit).toHaveBeenCalledWith({ id: 'testAccount', page: undefined });
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						amount: '1000.000000',
						oraclePrice: '1.500000',
						marketDepositBalance: '5000.000000000',
						marketWithdrawBalance: '3000.000000000',
						marketCumulativeDepositInterest: '100.0000000000',
						marketCumulativeBorrowInterest: '50.0000000000',
						totalDepositsAfter: '6000.000000',
						totalWithdrawsAfter: '4000.000000',
						depositRecordId: 'mock-deposit-record-id',
						userAuthority: 'mock-user-authority',
						user: 'mock-user',
						direction: 'deposit',
						explanation: 'Mock deposit record',
						marketIndex: 0,
						symbol: 'USDC',
					},
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						amount: '1000.000000',
						oraclePrice: '1.500000',
						marketDepositBalance: '5000.000000000',
						marketWithdrawBalance: '3000.000000000',
						marketCumulativeDepositInterest: '100.0000000000',
						marketCumulativeBorrowInterest: '50.0000000000',
						totalDepositsAfter: '6000.000000',
						totalWithdrawsAfter: '4000.000000',
						depositRecordId: 'mock-deposit-record-id',
						userAuthority: 'mock-user-authority',
						user: 'mock-user',
						direction: 'deposit',
						explanation: 'Mock deposit record',
						marketIndex: 0,
						symbol: 'USDC',
					},
				],
				meta: { nextPage: 'InNvbWVUb2tlbiI=' },
			});
		});

		it('should handle pagination', async () => {
			const lastEvaluatedKey = { pk: 'USER#testAccount', sk: 'DEPOSIT#TS#1234567890' };
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');
			const mockRecords = [createMockDepositRecord(), createMockDepositRecord()];
			const mockMeta = { nextPage: 'someToken' };
			mockDeposit.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			await app.inject({
				method: 'GET',
				url: `/user/testAccount/deposits?page=${encodedToken}`,
			});

			expect(mockDeposit).toHaveBeenCalledWith({
				id: 'testAccount',
				page: lastEvaluatedKey,
			});
		});

		it('should handle errors gracefully', async () => {
			mockDeposit.mockRejectedValue(new Error('Database error'));

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/deposits',
			});

			expect(response.statusCode).toBe(500);
		});
	});

	describe('GET /user/:accountId/deposits/:year/:month', () => {
		it('should return archived deposits for a given account ID, year, and month', async () => {
			const mockResult = {
				success: true,
				records: [createMockDepositRecord(), createMockDepositRecord()],
				meta: {
					records: 2,
					totalRecords: 2,
					totalPages: 1,
					currentPage: 1,
					nextPage: null,
				},
			};
			(fetchArchiveData as jest.Mock).mockResolvedValue(mockResult);

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/deposits/2024/6',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'testAccount',
				year: 2024,
				month: 6,
				page: 1,
				recordType: RecordTypes.DepositRecord,
				getLatestRecords: expect.any(Function),
			});
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						amount: '1000.000000',
						oraclePrice: '1.500000',
						marketDepositBalance: '5000.000000000',
						marketWithdrawBalance: '3000.000000000',
						marketCumulativeDepositInterest: '100.0000000000',
						marketCumulativeBorrowInterest: '50.0000000000',
						totalDepositsAfter: '6000.000000',
						totalWithdrawsAfter: '4000.000000',
						depositRecordId: 'mock-deposit-record-id',
						userAuthority: 'mock-user-authority',
						user: 'mock-user',
						direction: 'deposit',
						explanation: 'Mock deposit record',
						marketIndex: 0,
						symbol: 'USDC',
					},
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						amount: '1000.000000',
						oraclePrice: '1.500000',
						marketDepositBalance: '5000.000000000',
						marketWithdrawBalance: '3000.000000000',
						marketCumulativeDepositInterest: '100.0000000000',
						marketCumulativeBorrowInterest: '50.0000000000',
						totalDepositsAfter: '6000.000000',
						totalWithdrawsAfter: '4000.000000',
						depositRecordId: 'mock-deposit-record-id',
						userAuthority: 'mock-user-authority',
						user: 'mock-user',
						direction: 'deposit',
						explanation: 'Mock deposit record',
						marketIndex: 0,
						symbol: 'USDC',
					},
				],
				meta: {
					records: 2,
					totalRecords: 2,
					currentPage: 1,
					totalPages: 1,
					nextPage: null,
				},
			});
		});

		it('should handle pagination for archived deposits', async () => {
			const mockResult = {
				success: true,
				records: [createMockDepositRecord(), createMockDepositRecord()],
				meta: {
					records: 2,
					totalRecords: 4,
					totalPages: 2,
					currentPage: 2,
					nextPage: null,
				},
			};
			(fetchArchiveData as jest.Mock).mockResolvedValue(mockResult);

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/deposits/2024/6?page=2',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'testAccount',
				year: 2024,
				month: 6,
				page: 2,
				recordType: RecordTypes.DepositRecord,
				getLatestRecords: expect.any(Function),
			});
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						amount: '1000.000000',
						oraclePrice: '1.500000',
						marketDepositBalance: '5000.000000000',
						marketWithdrawBalance: '3000.000000000',
						marketCumulativeDepositInterest: '100.0000000000',
						marketCumulativeBorrowInterest: '50.0000000000',
						totalDepositsAfter: '6000.000000',
						totalWithdrawsAfter: '4000.000000',
						depositRecordId: 'mock-deposit-record-id',
						userAuthority: 'mock-user-authority',
						user: 'mock-user',
						direction: 'deposit',
						explanation: 'Mock deposit record',
						marketIndex: 0,
						symbol: 'USDC',
					},
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						amount: '1000.000000',
						oraclePrice: '1.500000',
						marketDepositBalance: '5000.000000000',
						marketWithdrawBalance: '3000.000000000',
						marketCumulativeDepositInterest: '100.0000000000',
						marketCumulativeBorrowInterest: '50.0000000000',
						totalDepositsAfter: '6000.000000',
						totalWithdrawsAfter: '4000.000000',
						depositRecordId: 'mock-deposit-record-id',
						userAuthority: 'mock-user-authority',
						user: 'mock-user',
						direction: 'deposit',
						explanation: 'Mock deposit record',
						marketIndex: 0,
						symbol: 'USDC',
					},
				],
				meta: {
					records: 2,
					totalRecords: 4,
					currentPage: 2,
					totalPages: 2,
					nextPage: null,
				},
			});
		});

		it('should validate year and month parameters', async () => {
			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/deposits/2025/13',
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);
			expect(payload.error).toBe('ValidationError');
		});

		it('should handle future dates', async () => {
			const futureYear = new Date().getFullYear() + 1;
			const response = await app.inject({
				method: 'GET',
				url: `/user/testAccount/deposits/${futureYear}/1`,
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);
			expect(payload.error).toBe('ValidationError');
			expect(payload.message).toContain('cannot be in the future');
		});

		it('should handle errors from fetchArchiveData', async () => {
			(fetchArchiveData as jest.Mock).mockRejectedValue(new Error('Archive error'));

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/deposits/2024/6',
			});

			expect(response.statusCode).toBe(500);
		});
	});

	describe('GET /user/:accountId/rewards', () => {
		it('should return rewards for a given account ID', async () => {
			const mockRecords = [
				createMockDepositRecord({
					user: 'testuser',
					amount: 100,
				}),
				createMockDepositRecord({
					user: 'testuser',
					amount: 200,
				}),
			];

			const mockMeta = { nextPage: 'someToken' };
			mockReward.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/rewards',
			});

			expect(response.statusCode).toBe(200);
			expect(mockReward).toHaveBeenCalledWith({ id: 'testAccount', page: undefined });
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						amount: '100.000000',
						oraclePrice: '1.500000',
						marketDepositBalance: '5000.000000000',
						marketWithdrawBalance: '3000.000000000',
						marketCumulativeDepositInterest: '100.0000000000',
						marketCumulativeBorrowInterest: '50.0000000000',
						totalDepositsAfter: '6000.000000',
						totalWithdrawsAfter: '4000.000000',
						depositRecordId: 'mock-deposit-record-id',
						userAuthority: 'mock-user-authority',
						user: 'testuser',
						direction: 'deposit',
						explanation: 'Mock deposit record',
						marketIndex: 0,
						symbol: 'USDC',
					},
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						amount: '200.000000',
						oraclePrice: '1.500000',
						marketDepositBalance: '5000.000000000',
						marketWithdrawBalance: '3000.000000000',
						marketCumulativeDepositInterest: '100.0000000000',
						marketCumulativeBorrowInterest: '50.0000000000',
						totalDepositsAfter: '6000.000000',
						totalWithdrawsAfter: '4000.000000',
						depositRecordId: 'mock-deposit-record-id',
						userAuthority: 'mock-user-authority',
						user: 'testuser',
						direction: 'deposit',
						explanation: 'Mock deposit record',
						marketIndex: 0,
						symbol: 'USDC',
					},
				],
				meta: { nextPage: 'InNvbWVUb2tlbiI=' },
			});
		});

		it('should handle pagination for rewards', async () => {
			const lastEvaluatedKey = { pk: 'USER#testAccount', sk: 'REWARD#TS#1234567890' };
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');
			const mockRecords = [createMockDepositRecord()];
			const mockMeta = { nextPage: 'someToken' };
			mockReward.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			await app.inject({
				method: 'GET',
				url: `/user/testAccount/rewards?page=${encodedToken}`,
			});

			expect(mockReward).toHaveBeenCalledWith({
				id: 'testAccount',
				page: lastEvaluatedKey,
			});
		});

		it('should handle errors gracefully', async () => {
			mockReward.mockRejectedValue(new Error('Database error'));

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/rewards',
			});

			expect(response.statusCode).toBe(500);
		});
	});

	describe('GET /user/:accountId/rewards/:year/:month', () => {
		it('should return archived rewards for a given account ID, year, and month', async () => {
			const mockResult = {
				success: true,
				records: [
					createMockDepositRecord({
						user: 'testuser',
						amount: 100,
					}),
					createMockDepositRecord({
						user: 'testuser',
						amount: 200,
					}),
				],
				meta: {
					records: 2,
					totalRecords: 2,
					totalPages: 1,
					currentPage: 1,
					nextPage: null,
				},
			};
			(fetchArchiveData as jest.Mock).mockResolvedValue(mockResult);

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/rewards/2024/6',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'testAccount',
				year: 2024,
				month: 6,
				page: 1,
				recordType: RecordTypes.RewardRecord,
				getLatestRecords: mockRewardTimestamp,
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						amount: '100.000000',
						oraclePrice: '1.500000',
						marketDepositBalance: '5000.000000000',
						marketWithdrawBalance: '3000.000000000',
						marketCumulativeDepositInterest: '100.0000000000',
						marketCumulativeBorrowInterest: '50.0000000000',
						totalDepositsAfter: '6000.000000',
						totalWithdrawsAfter: '4000.000000',
						depositRecordId: 'mock-deposit-record-id',
						userAuthority: 'mock-user-authority',
						user: 'testuser',
						direction: 'deposit',
						explanation: 'Mock deposit record',
						marketIndex: 0,
						symbol: 'USDC',
					},
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						amount: '200.000000',
						oraclePrice: '1.500000',
						marketDepositBalance: '5000.000000000',
						marketWithdrawBalance: '3000.000000000',
						marketCumulativeDepositInterest: '100.0000000000',
						marketCumulativeBorrowInterest: '50.0000000000',
						totalDepositsAfter: '6000.000000',
						totalWithdrawsAfter: '4000.000000',
						depositRecordId: 'mock-deposit-record-id',
						userAuthority: 'mock-user-authority',
						user: 'testuser',
						direction: 'deposit',
						explanation: 'Mock deposit record',
						marketIndex: 0,
						symbol: 'USDC',
					},
				],
				meta: {
					records: 2,
					totalRecords: 2,
					currentPage: 1,
					totalPages: 1,
					nextPage: null,
				},
			});
		});
	});

	describe('GET /user/:accountId/settlePnl', () => {
		it('should return settle PNL records for a given account ID', async () => {
			const mockRecords = [createMockSettlePnlRecord(), createMockSettlePnlRecord()];

			const mockMeta = { nextPage: 'someToken' };
			mockSettlePnl.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/settlePnl',
			});

			expect(response.statusCode).toBe(200);
			expect(mockSettlePnl).toHaveBeenCalledWith({ id: 'testAccount', page: undefined });
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						pnl: '1000.000000',
						user: 'mock-user',
						baseAssetAmount: '100.000000000',
						quoteAssetAmountAfter: '1000.000000',
						quoteEntryAmount: '900.000000',
						settlePrice: '150.000000',
						marketIndex: 0,
						explanation: 'PNL settled',
					},
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						pnl: '1000.000000',
						user: 'mock-user',
						baseAssetAmount: '100.000000000',
						quoteAssetAmountAfter: '1000.000000',
						quoteEntryAmount: '900.000000',
						settlePrice: '150.000000',
						marketIndex: 0,
						explanation: 'PNL settled',
					},
				],
				meta: expect.objectContaining({
					nextPage: expect.any(String),
				}),
			});
		});

		it('should handle pagination for settle PNL records', async () => {
			const lastEvaluatedKey = { pk: 'USER#testAccount', sk: 'SETTLE_PNL#TS#1234567890' };
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');
			const mockRecords = [createMockSettlePnlRecord(), createMockSettlePnlRecord()];
			const mockMeta = { nextPage: 'someToken' };
			mockSettlePnl.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			await app.inject({
				method: 'GET',
				url: `/user/testAccount/settlePnl?page=${encodedToken}`,
			});

			expect(mockSettlePnl).toHaveBeenCalledWith({
				id: 'testAccount',
				page: lastEvaluatedKey,
			});
		});
	});

	describe('GET /user/:accountId/settlePnl/:year/:month', () => {
		it('should return archived settle PNL records for a given account ID, year, and month', async () => {
			const mockResult = {
				success: true,
				records: [createMockSettlePnlRecord(), createMockSettlePnlRecord()],
				meta: {
					records: 2,
					totalRecords: 2,
					totalPages: 1,
					currentPage: 1,
					nextPage: null,
				},
			};
			(fetchArchiveData as jest.Mock).mockResolvedValue(mockResult);

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/settlePnl/2024/6',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'testAccount',
				year: 2024,
				month: 6,
				page: 1,
				recordType: RecordTypes.SettlePnlRecord,
				getLatestRecords: expect.any(Function),
			});
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						pnl: '1000.000000',
						user: 'mock-user',
						baseAssetAmount: '100.000000000',
						quoteAssetAmountAfter: '1000.000000',
						quoteEntryAmount: '900.000000',
						settlePrice: '150.000000',
						marketIndex: 0,
						explanation: 'PNL settled',
					},
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						pnl: '1000.000000',
						user: 'mock-user',
						baseAssetAmount: '100.000000000',
						quoteAssetAmountAfter: '1000.000000',
						quoteEntryAmount: '900.000000',
						settlePrice: '150.000000',
						marketIndex: 0,
						explanation: 'PNL settled',
					},
				],
				meta: {
					records: 2,
					totalRecords: 2,
					currentPage: 1,
					totalPages: 1,
					nextPage: null,
				},
			});
		});
	});

	describe('GET /user/:accountId/fundingPayments', () => {
		it('should return funding payment records for a given account ID', async () => {
			const mockRecords = [
				createMockFundingPaymentRecord(),
				createMockFundingPaymentRecord(),
			];

			const mockMeta = { nextPage: 'someToken' };
			mockFundingPayment.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/fundingPayments',
			});

			expect(response.statusCode).toBe(200);
			expect(mockFundingPayment).toHaveBeenCalledWith({ id: 'testAccount', page: undefined });
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						userAuthority: 'mock-user-authority',
						user: 'mock-user',
						marketIndex: 0,
						fundingPayment: '100.000000',
						baseAssetAmount: '1000.000000000',
						userLastCumulativeFunding: '500.000000000',
						ammCumulativeFundingLong: '600.000000000',
						ammCumulativeFundingShort: '400.000000000',
					},
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						userAuthority: 'mock-user-authority',
						user: 'mock-user',
						marketIndex: 0,
						fundingPayment: '100.000000',
						baseAssetAmount: '1000.000000000',
						userLastCumulativeFunding: '500.000000000',
						ammCumulativeFundingLong: '600.000000000',
						ammCumulativeFundingShort: '400.000000000',
					},
				],
				meta: expect.objectContaining({
					nextPage: expect.any(String),
				}),
			});
		});

		it('should handle pagination for funding payment records', async () => {
			const lastEvaluatedKey = {
				pk: 'USER#testAccount',
				sk: 'FUNDING_PAYMENT#TS#1234567890',
			};
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');
			const mockRecords = [
				createMockFundingPaymentRecord(),
				createMockFundingPaymentRecord(),
			];
			const mockMeta = { nextPage: 'someToken' };
			mockFundingPayment.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			await app.inject({
				method: 'GET',
				url: `/user/testAccount/fundingPayments?page=${encodedToken}`,
			});

			expect(mockFundingPayment).toHaveBeenCalledWith({
				id: 'testAccount',
				page: lastEvaluatedKey,
			});
		});
	});

	describe('GET /user/:accountId/fundingPayments/:year/:month', () => {
		it('should return archived funding payment records for a given account ID, year, and month', async () => {
			const mockResult = {
				success: true,
				records: [createMockFundingPaymentRecord(), createMockFundingPaymentRecord()],
				meta: {
					records: 2,
					totalRecords: 2,
					totalPages: 1,
					currentPage: 1,
					nextPage: null,
				},
			};
			(fetchArchiveData as jest.Mock).mockResolvedValue(mockResult);

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/fundingPayments/2024/6',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'testAccount',
				year: 2024,
				month: 6,
				page: 1,
				recordType: RecordTypes.FundingPaymentRecord,
				getLatestRecords: expect.any(Function),
			});
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						userAuthority: 'mock-user-authority',
						user: 'mock-user',
						marketIndex: 0,
						fundingPayment: '100.000000',
						baseAssetAmount: '1000.000000000',
						userLastCumulativeFunding: '500.000000000',
						ammCumulativeFundingLong: '600.000000000',
						ammCumulativeFundingShort: '400.000000000',
					},
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						userAuthority: 'mock-user-authority',
						user: 'mock-user',
						marketIndex: 0,
						fundingPayment: '100.000000',
						baseAssetAmount: '1000.000000000',
						userLastCumulativeFunding: '500.000000000',
						ammCumulativeFundingLong: '600.000000000',
						ammCumulativeFundingShort: '400.000000000',
					},
				],
				meta: {
					records: 2,
					totalRecords: 2,
					currentPage: 1,
					totalPages: 1,
					nextPage: null,
				},
			});
		});
	});

	describe('GET /user/:accountId/liquidations', () => {
		it('should return liquidation records for a given account ID', async () => {
			const mockRecords = [createMockLiquidationRecord(), createMockLiquidationRecord()];

			const mockMeta = { nextPage: 'someToken' };
			mockLiquidation.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/liquidations',
			});

			expect(response.statusCode).toBe(200);
			expect(mockLiquidation).toHaveBeenCalledWith({ id: 'testAccount', page: undefined });
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						liquidationType: 'partial',
						user: 'mock-user',
						liquidator: 'mock-liquidator',
						marginRequirement: '1000.000000',
						totalCollateral: '900.000000',
						marginFreed: '100.000000',
						liquidationId: 'mock-liquidation-id',
						bankrupt: false,
						canceledOrderIds: ['order-1', 'order-2'],
						liquidatePerp_marketIndex: 0,
						liquidatePerp_oraclePrice: '150.000000',
						liquidatePerp_baseAssetAmount: '100.000000000',
						liquidatePerp_quoteAssetAmount: '15000.000000',
						liquidatePerp_lpShares: '0.000000000',
						liquidatePerp_fillRecordId: 'fill-record-id',
						liquidatePerp_userOrderId: 'user-order-id',
						liquidatePerp_liquidatorOrderId: 'liquidator-order-id',
						liquidatePerp_liquidatorFee: '50.000000',
						liquidatePerp_ifFee: '25.000000',
						liquidateSpot_assetMarketIndex: 1,
						liquidateSpot_assetPrice: '1.500000',
						liquidateSpot_assetTransfer: '1000.000000000',
						liquidateSpot_liabilityMarketIndex: 2,
						liquidateSpot_liabilityPrice: '1.000000',
						liquidateSpot_liabilityTransfer: '1500.000000000',
						liquidateSpot_ifFee: '10.000000000',
						liquidateBorrowForPerpPnl_perpMarketIndex: 3,
						liquidateBorrowForPerpPnl_marketOraclePrice: '200.000000',
						liquidateBorrowForPerpPnl_pnlTransfer: '2000.000000',
						liquidateBorrowForPerpPnl_liabilityMarketIndex: 4,
						liquidateBorrowForPerpPnl_liabilityPrice: '1.200000',
						liquidateBorrowForPerpPnl_liabilityTransfer: '2400.000000',
						liquidatePerpPnlForDeposit_perpMarketIndex: 5,
						liquidatePerpPnlForDeposit_marketOraclePrice: '250.000000',
						liquidatePerpPnlForDeposit_pnlTransfer: '2500.000000',
						liquidatePerpPnlForDeposit_assetMarketIndex: 0,
						liquidatePerpPnlForDeposit_assetPrice: '1.800000',
						liquidatePerpPnlForDeposit_assetTransfer: '1389.000000',
						perpBankruptcy_marketIndex: 7,
						perpBankruptcy_pnl: '-5000.000000',
						perpBankruptcy_ifPayment: '4000.000000',
						perpBankruptcy_clawbackUser: 'clawback-user',
						perpBankruptcy_clawbackUserPayment: '1000.000000',
						perpBankruptcy_cumulativeFundingRateDelta: '0.001000000',
						spotBankruptcy_marketIndex: 8,
						spotBankruptcy_borrowAmount: '3000.000000000',
						spotBankruptcy_ifPayment: '2800.000000000',
						spotBankruptcy_cumulativeDepositInterestDelta: '0.0050000000',
					},
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						liquidationType: 'partial',
						user: 'mock-user',
						liquidator: 'mock-liquidator',
						marginRequirement: '1000.000000',
						totalCollateral: '900.000000',
						marginFreed: '100.000000',
						liquidationId: 'mock-liquidation-id',
						bankrupt: false,
						canceledOrderIds: ['order-1', 'order-2'],
						liquidatePerp_marketIndex: 0,
						liquidatePerp_oraclePrice: '150.000000',
						liquidatePerp_baseAssetAmount: '100.000000000',
						liquidatePerp_quoteAssetAmount: '15000.000000',
						liquidatePerp_lpShares: '0.000000000',
						liquidatePerp_fillRecordId: 'fill-record-id',
						liquidatePerp_userOrderId: 'user-order-id',
						liquidatePerp_liquidatorOrderId: 'liquidator-order-id',
						liquidatePerp_liquidatorFee: '50.000000',
						liquidatePerp_ifFee: '25.000000',
						liquidateSpot_assetMarketIndex: 1,
						liquidateSpot_assetPrice: '1.500000',
						liquidateSpot_assetTransfer: '1000.000000000',
						liquidateSpot_liabilityMarketIndex: 2,
						liquidateSpot_liabilityPrice: '1.000000',
						liquidateSpot_liabilityTransfer: '1500.000000000',
						liquidateSpot_ifFee: '10.000000000',
						liquidateBorrowForPerpPnl_perpMarketIndex: 3,
						liquidateBorrowForPerpPnl_marketOraclePrice: '200.000000',
						liquidateBorrowForPerpPnl_pnlTransfer: '2000.000000',
						liquidateBorrowForPerpPnl_liabilityMarketIndex: 4,
						liquidateBorrowForPerpPnl_liabilityPrice: '1.200000',
						liquidateBorrowForPerpPnl_liabilityTransfer: '2400.000000',
						liquidatePerpPnlForDeposit_perpMarketIndex: 5,
						liquidatePerpPnlForDeposit_marketOraclePrice: '250.000000',
						liquidatePerpPnlForDeposit_pnlTransfer: '2500.000000',
						liquidatePerpPnlForDeposit_assetMarketIndex: 0,
						liquidatePerpPnlForDeposit_assetPrice: '1.800000',
						liquidatePerpPnlForDeposit_assetTransfer: '1389.000000',
						perpBankruptcy_marketIndex: 7,
						perpBankruptcy_pnl: '-5000.000000',
						perpBankruptcy_ifPayment: '4000.000000',
						perpBankruptcy_clawbackUser: 'clawback-user',
						perpBankruptcy_clawbackUserPayment: '1000.000000',
						perpBankruptcy_cumulativeFundingRateDelta: '0.001000000',
						spotBankruptcy_marketIndex: 8,
						spotBankruptcy_borrowAmount: '3000.000000000',
						spotBankruptcy_ifPayment: '2800.000000000',
						spotBankruptcy_cumulativeDepositInterestDelta: '0.0050000000',
					},
				],
				meta: { nextPage: 'InNvbWVUb2tlbiI=' },
			});
		});

		it('should handle pagination for liquidation records', async () => {
			const lastEvaluatedKey = { pk: 'USER#testAccount', sk: 'LIQUIDATION#TS#1234567890' };
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');
			const mockRecords = [createMockLiquidationRecord(), createMockLiquidationRecord()];
			const mockMeta = { nextPage: 'someToken' };
			mockLiquidation.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			await app.inject({
				method: 'GET',
				url: `/user/testAccount/liquidations?page=${encodedToken}`,
			});

			expect(mockLiquidation).toHaveBeenCalledWith({
				id: 'testAccount',
				page: lastEvaluatedKey,
			});
		});
	});

	describe('GET /user/:accountId/liquidations/:year/:month', () => {
		it('should return archived liquidation records for a given account ID, year, and month', async () => {
			const mockResult = {
				success: true,
				records: [createMockLiquidationRecord(), createMockLiquidationRecord()],
				meta: {
					records: 2,
					totalRecords: 2,
					totalPages: 1,
					currentPage: 1,
					nextPage: null,
				},
			};
			(fetchArchiveData as jest.Mock).mockResolvedValue(mockResult);

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/liquidations/2024/6',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'testAccount',
				year: 2024,
				month: 6,
				page: 1,
				recordType: RecordTypes.LiquidationRecord,
				getLatestRecords: expect.any(Function),
			});
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						liquidationType: 'partial',
						user: 'mock-user',
						liquidator: 'mock-liquidator',
						marginRequirement: '1000.000000',
						totalCollateral: '900.000000',
						marginFreed: '100.000000',
						liquidationId: 'mock-liquidation-id',
						bankrupt: false,
						canceledOrderIds: ['order-1', 'order-2'],
						liquidatePerp_marketIndex: 0,
						liquidatePerp_oraclePrice: '150.000000',
						liquidatePerp_baseAssetAmount: '100.000000000',
						liquidatePerp_quoteAssetAmount: '15000.000000',
						liquidatePerp_lpShares: '0.000000000',
						liquidatePerp_fillRecordId: 'fill-record-id',
						liquidatePerp_userOrderId: 'user-order-id',
						liquidatePerp_liquidatorOrderId: 'liquidator-order-id',
						liquidatePerp_liquidatorFee: '50.000000',
						liquidatePerp_ifFee: '25.000000',
						liquidateSpot_assetMarketIndex: 1,
						liquidateSpot_assetPrice: '1.500000',
						liquidateSpot_assetTransfer: '1000.000000000',
						liquidateSpot_liabilityMarketIndex: 2,
						liquidateSpot_liabilityPrice: '1.000000',
						liquidateSpot_liabilityTransfer: '1500.000000000',
						liquidateSpot_ifFee: '10.000000000',
						liquidateBorrowForPerpPnl_perpMarketIndex: 3,
						liquidateBorrowForPerpPnl_marketOraclePrice: '200.000000',
						liquidateBorrowForPerpPnl_pnlTransfer: '2000.000000',
						liquidateBorrowForPerpPnl_liabilityMarketIndex: 4,
						liquidateBorrowForPerpPnl_liabilityPrice: '1.200000',
						liquidateBorrowForPerpPnl_liabilityTransfer: '2400.000000',
						liquidatePerpPnlForDeposit_perpMarketIndex: 5,
						liquidatePerpPnlForDeposit_marketOraclePrice: '250.000000',
						liquidatePerpPnlForDeposit_pnlTransfer: '2500.000000',
						liquidatePerpPnlForDeposit_assetMarketIndex: 0,
						liquidatePerpPnlForDeposit_assetPrice: '1.800000',
						liquidatePerpPnlForDeposit_assetTransfer: '1389.000000',
						perpBankruptcy_marketIndex: 7,
						perpBankruptcy_pnl: '-5000.000000',
						perpBankruptcy_ifPayment: '4000.000000',
						perpBankruptcy_clawbackUser: 'clawback-user',
						perpBankruptcy_clawbackUserPayment: '1000.000000',
						perpBankruptcy_cumulativeFundingRateDelta: '0.001000000',
						spotBankruptcy_marketIndex: 8,
						spotBankruptcy_borrowAmount: '3000.000000000',
						spotBankruptcy_ifPayment: '2800.000000000',
						spotBankruptcy_cumulativeDepositInterestDelta: '0.0050000000',
					},
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						liquidationType: 'partial',
						user: 'mock-user',
						liquidator: 'mock-liquidator',
						marginRequirement: '1000.000000',
						totalCollateral: '900.000000',
						marginFreed: '100.000000',
						liquidationId: 'mock-liquidation-id',
						bankrupt: false,
						canceledOrderIds: ['order-1', 'order-2'],
						liquidatePerp_marketIndex: 0,
						liquidatePerp_oraclePrice: '150.000000',
						liquidatePerp_baseAssetAmount: '100.000000000',
						liquidatePerp_quoteAssetAmount: '15000.000000',
						liquidatePerp_lpShares: '0.000000000',
						liquidatePerp_fillRecordId: 'fill-record-id',
						liquidatePerp_userOrderId: 'user-order-id',
						liquidatePerp_liquidatorOrderId: 'liquidator-order-id',
						liquidatePerp_liquidatorFee: '50.000000',
						liquidatePerp_ifFee: '25.000000',
						liquidateSpot_assetMarketIndex: 1,
						liquidateSpot_assetPrice: '1.500000',
						liquidateSpot_assetTransfer: '1000.000000000',
						liquidateSpot_liabilityMarketIndex: 2,
						liquidateSpot_liabilityPrice: '1.000000',
						liquidateSpot_liabilityTransfer: '1500.000000000',
						liquidateSpot_ifFee: '10.000000000',
						liquidateBorrowForPerpPnl_perpMarketIndex: 3,
						liquidateBorrowForPerpPnl_marketOraclePrice: '200.000000',
						liquidateBorrowForPerpPnl_pnlTransfer: '2000.000000',
						liquidateBorrowForPerpPnl_liabilityMarketIndex: 4,
						liquidateBorrowForPerpPnl_liabilityPrice: '1.200000',
						liquidateBorrowForPerpPnl_liabilityTransfer: '2400.000000',
						liquidatePerpPnlForDeposit_perpMarketIndex: 5,
						liquidatePerpPnlForDeposit_marketOraclePrice: '250.000000',
						liquidatePerpPnlForDeposit_pnlTransfer: '2500.000000',
						liquidatePerpPnlForDeposit_assetMarketIndex: 0,
						liquidatePerpPnlForDeposit_assetPrice: '1.800000',
						liquidatePerpPnlForDeposit_assetTransfer: '1389.000000',
						perpBankruptcy_marketIndex: 7,
						perpBankruptcy_pnl: '-5000.000000',
						perpBankruptcy_ifPayment: '4000.000000',
						perpBankruptcy_clawbackUser: 'clawback-user',
						perpBankruptcy_clawbackUserPayment: '1000.000000',
						perpBankruptcy_cumulativeFundingRateDelta: '0.001000000',
						spotBankruptcy_marketIndex: 8,
						spotBankruptcy_borrowAmount: '3000.000000000',
						spotBankruptcy_ifPayment: '2800.000000000',
						spotBankruptcy_cumulativeDepositInterestDelta: '0.0050000000',
					},
				],
				meta: {
					records: 2,
					totalRecords: 2,
					currentPage: 1,
					totalPages: 1,
					nextPage: null,
				},
			});
		});

		it('should handle pagination for archived liquidation records', async () => {
			const mockResult = {
				success: true,
				records: [createMockLiquidationRecord()],
				meta: {
					records: 1,
					totalRecords: 3,
					totalPages: 3,
					currentPage: 2,
					nextPage: 3,
				},
			};
			(fetchArchiveData as jest.Mock).mockResolvedValue(mockResult);

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/liquidations/2024/6?page=2',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'testAccount',
				year: 2024,
				month: 6,
				page: 2,
				recordType: RecordTypes.LiquidationRecord,
				getLatestRecords: expect.any(Function),
			});
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						liquidationType: 'partial',
						user: 'mock-user',
						liquidator: 'mock-liquidator',
						marginRequirement: '1000.000000',
						totalCollateral: '900.000000',
						marginFreed: '100.000000',
						liquidationId: 'mock-liquidation-id',
						bankrupt: false,
						canceledOrderIds: ['order-1', 'order-2'],
						liquidatePerp_marketIndex: 0,
						liquidatePerp_oraclePrice: '150.000000',
						liquidatePerp_baseAssetAmount: '100.000000000',
						liquidatePerp_quoteAssetAmount: '15000.000000',
						liquidatePerp_lpShares: '0.000000000',
						liquidatePerp_fillRecordId: 'fill-record-id',
						liquidatePerp_userOrderId: 'user-order-id',
						liquidatePerp_liquidatorOrderId: 'liquidator-order-id',
						liquidatePerp_liquidatorFee: '50.000000',
						liquidatePerp_ifFee: '25.000000',
						liquidateSpot_assetMarketIndex: 1,
						liquidateSpot_assetPrice: '1.500000',
						liquidateSpot_assetTransfer: '1000.000000000',
						liquidateSpot_liabilityMarketIndex: 2,
						liquidateSpot_liabilityPrice: '1.000000',
						liquidateSpot_liabilityTransfer: '1500.000000000',
						liquidateSpot_ifFee: '10.000000000',
						liquidateBorrowForPerpPnl_perpMarketIndex: 3,
						liquidateBorrowForPerpPnl_marketOraclePrice: '200.000000',
						liquidateBorrowForPerpPnl_pnlTransfer: '2000.000000',
						liquidateBorrowForPerpPnl_liabilityMarketIndex: 4,
						liquidateBorrowForPerpPnl_liabilityPrice: '1.200000',
						liquidateBorrowForPerpPnl_liabilityTransfer: '2400.000000',
						liquidatePerpPnlForDeposit_perpMarketIndex: 5,
						liquidatePerpPnlForDeposit_marketOraclePrice: '250.000000',
						liquidatePerpPnlForDeposit_pnlTransfer: '2500.000000',
						liquidatePerpPnlForDeposit_assetMarketIndex: 0,
						liquidatePerpPnlForDeposit_assetPrice: '1.800000',
						liquidatePerpPnlForDeposit_assetTransfer: '1389.000000',
						perpBankruptcy_marketIndex: 7,
						perpBankruptcy_pnl: '-5000.000000',
						perpBankruptcy_ifPayment: '4000.000000',
						perpBankruptcy_clawbackUser: 'clawback-user',
						perpBankruptcy_clawbackUserPayment: '1000.000000',
						perpBankruptcy_cumulativeFundingRateDelta: '0.001000000',
						spotBankruptcy_marketIndex: 8,
						spotBankruptcy_borrowAmount: '3000.000000000',
						spotBankruptcy_ifPayment: '2800.000000000',
						spotBankruptcy_cumulativeDepositInterestDelta: '0.0050000000',
					},
				],
				meta: { records: 1, totalRecords: 3, currentPage: 2, totalPages: 3, nextPage: 3 },
			});
		});
	});

	describe('GET /user/:accountId/lp', () => {
		it('should return LP records for a given account ID', async () => {
			const mockRecords = [createMockLPRecord(), createMockLPRecord()];

			const mockMeta = { nextPage: 'someToken' };
			mockLP.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/lp',
			});

			expect(response.statusCode).toBe(200);
			expect(mockLP).toHaveBeenCalledWith({ id: 'testAccount', page: undefined });
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						user: 'mock-user',
						action: 'add',
						marketIndex: 0,
						nShares: '100.000000000',
						deltaBaseAssetAmount: '1000.000000000',
						deltaQuoteAssetAmount: '150000.000000',
						pnl: '500.000000',
					},
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						user: 'mock-user',
						action: 'add',
						marketIndex: 0,
						nShares: '100.000000000',
						deltaBaseAssetAmount: '1000.000000000',
						deltaQuoteAssetAmount: '150000.000000',
						pnl: '500.000000',
					},
				],
				meta: expect.objectContaining({
					nextPage: expect.any(String),
				}),
			});
		});

		it('should handle pagination for LP records', async () => {
			const lastEvaluatedKey = { pk: 'USER#testAccount', sk: 'LP#TS#1234567890' };
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');
			const mockRecords = [createMockLPRecord(), createMockLPRecord()];
			const mockMeta = { nextPage: 'someToken' };
			mockLP.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			await app.inject({
				method: 'GET',
				url: `/user/testAccount/lp?page=${encodedToken}`,
			});

			expect(mockLP).toHaveBeenCalledWith({
				id: 'testAccount',
				page: lastEvaluatedKey,
			});
		});
	});

	describe('GET /user/:accountId/lp/:year/:month', () => {
		it('should return archived LP records for a given account ID, year, and month', async () => {
			const mockResult = {
				success: true,
				records: [createMockLPRecord(), createMockLPRecord()],
				meta: {
					records: 2,
					totalRecords: 2,
					totalPages: 1,
					currentPage: 1,
					nextPage: null,
				},
			};
			(fetchArchiveData as jest.Mock).mockResolvedValue(mockResult);

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/lp/2024/6',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'testAccount',
				year: 2024,
				month: 6,
				page: 1,
				recordType: RecordTypes.LPRecord,
				getLatestRecords: expect.any(Function),
			});
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						user: 'mock-user',
						action: 'add',
						marketIndex: 0,
						nShares: '100.000000000',
						deltaBaseAssetAmount: '1000.000000000',
						deltaQuoteAssetAmount: '150000.000000',
						pnl: '500.000000',
					},
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						user: 'mock-user',
						action: 'add',
						marketIndex: 0,
						nShares: '100.000000000',
						deltaBaseAssetAmount: '1000.000000000',
						deltaQuoteAssetAmount: '150000.000000',
						pnl: '500.000000',
					},
				],
				meta: {
					records: 2,
					totalRecords: 2,
					currentPage: 1,
					totalPages: 1,
					nextPage: null,
				},
			});
		});

		it('should handle pagination for archived LP records', async () => {
			const mockResult = {
				success: true,
				records: [createMockLPRecord()],
				meta: {
					records: 1,
					totalRecords: 3,
					totalPages: 3,
					currentPage: 2,
					nextPage: 3,
				},
			};
			(fetchArchiveData as jest.Mock).mockResolvedValue(mockResult);

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/lp/2024/6?page=2',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'testAccount',
				year: 2024,
				month: 6,
				page: 2,
				recordType: RecordTypes.LPRecord,
				getLatestRecords: expect.any(Function),
			});
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						user: 'mock-user',
						action: 'add',
						marketIndex: 0,
						nShares: '100.000000000',
						deltaBaseAssetAmount: '1000.000000000',
						deltaQuoteAssetAmount: '150000.000000',
						pnl: '500.000000',
					},
				],
				meta: { records: 1, totalRecords: 3, currentPage: 2, totalPages: 3, nextPage: 3 },
			});
		});
	});

	describe('GET /user/:accountId/snapshots/trading', () => {
		it('should return trading snapshots', async () => {
			const mockSnapshots = [
				createMockTradingSnapshotRecord(),
				createMockTradingSnapshotRecord({ unrealizedPnl: 12391.23123 }),
			];

			mockGetUserVolumeAndFees.mockResolvedValue({
				cumulativeMakerVolume: 1,
				cumulativeTakerVolume: 2,
				cumulativeFeePaid: 1,
				cumulativeFeeRebate: 2,
			});

			mockGetSnapshotsBetweenTimestamps.mockResolvedValueOnce(mockSnapshots);

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/snapshots/trading',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenNthCalledWith(1, {
				entity: EntityTypes.User,
				id: 'testAccount',
				recordType: RecordTypes.TradeSnapshotRecord,
				startTs: getTimestampDay({ days: -7 }),
				endTs: fixedTimestamp,
				frequency: 'daily',
			});

			expect(mockGetUserVolumeAndFees).toHaveBeenCalledWith({ user: 'testAccount' });

			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				snapshots: [
					{ ts: 1234567890, unrealizedPnl: '123.120000' },
					{ ts: 1234567890, unrealizedPnl: '12391.231230' },
				],
				metrics: {
					cumulativeMakerVolume: '1.000000',
					cumulativeTakerVolume: '2.000000',
					cumulativeFeePaid: '1.000000',
					cumulativeFeeRebate: '2.000000',
				},
			});
		});

		it('should return houly trading snapshots for days=1', async () => {
			const mockSnapshots = [
				createMockTradingSnapshotRecord(),
				createMockTradingSnapshotRecord({ unrealizedPnl: 12391.23123 }),
			];

			mockGetUserVolumeAndFees.mockResolvedValue({
				cumulativeMakerVolume: 1,
				cumulativeTakerVolume: 2,
				cumulativeFeePaid: 1,
				cumulativeFeeRebate: 2,
			});

			mockGetSnapshotsBetweenTimestamps.mockResolvedValueOnce(mockSnapshots);

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/snapshots/trading?days=1',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenNthCalledWith(1, {
				entity: EntityTypes.User,
				id: 'testAccount',
				recordType: RecordTypes.TradeSnapshotRecord,
				startTs: getTimestampDay({ days: -1 }),
				endTs: fixedTimestamp,
				frequency: 'hourly',
			});

			expect(mockGetUserVolumeAndFees).toHaveBeenCalledWith({ user: 'testAccount' });

			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				snapshots: [
					{ ts: 1234567890, unrealizedPnl: '123.120000' },
					{ ts: 1234567890, unrealizedPnl: '12391.231230' },
				],
				metrics: {
					cumulativeMakerVolume: '1.000000',
					cumulativeTakerVolume: '2.000000',
					cumulativeFeePaid: '1.000000',
					cumulativeFeeRebate: '2.000000',
				},
			});
		});

		it('should handle empty snapshots', async () => {
			mockGetSnapshotsBetweenTimestamps.mockResolvedValue([]);
			mockGetPreviousSnapshot.mockResolvedValue(null);
			mockGetUserVolumeAndFees.mockResolvedValue({
				cumulativeTakerVolume: 0,
				cumulativeMakerVolume: 0,
			});

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/snapshots/trading',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenCalledWith({
				entity: EntityTypes.User,
				id: 'testAccount',
				recordType: RecordTypes.TradeSnapshotRecord,
				startTs: getTimestampDay({ days: -7 }),
				endTs: fixedTimestamp,
				frequency: 'daily',
			});

			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				snapshots: [],
				metrics: {
					cumulativeMakerVolume: '0.000000',
					cumulativeTakerVolume: '0.000000',
				},
			});
		});

		it('should handle errors from snapshot repository', async () => {
			mockGetSnapshotsBetweenTimestamps.mockRejectedValue(new Error('Database error'));

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/snapshots/trading',
			});

			expect(response.statusCode).toBe(500);
		});
	});

	describe('GET /user/:accountId/snapshots/earn', () => {
		it('should return earn snapshots with daily change', async () => {
			const mockSnapshots = [
				createMockEarnSnapshotRecord(),
				createMockEarnSnapshotRecord({ totalAccountValue: 2000 }),
			];

			mockGetSnapshotsBetweenTimestamps.mockResolvedValueOnce(mockSnapshots);

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/snapshots/earn',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenCalledWith({
				entity: EntityTypes.User,
				id: 'testAccount',
				recordType: RecordTypes.EarnSnapshotRecord,
				startTs: getTimestampDay({ days: -7 }),
				endTs: fixedTimestamp,
				frequency: 'daily',
			});

			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				snapshots: [
					{
						ts: 1234567890,
						assets: [
							{
								balance: '0.000000',
								deposits: '0.000000',
								interestBaseValue: '0.000000',
								interestQuoteValue: '0.000000',
								marketIndex: 0,
								oraclePrice: '0.000000',
								pnl: '0.000000',
								withdrawals: '0.000000',
							},
							{
								balance: '1090.000000',
								deposits: '0.000000',
								interestBaseValue: '0.000000',
								interestQuoteValue: '0.000000',
								marketIndex: 0,
								oraclePrice: '0.000000',
								pnl: '0.000000',
								withdrawals: '10.000000',
							},
						],
					},
					{
						ts: 1234567890,
						assets: [
							{
								balance: '0.000000',
								deposits: '0.000000',
								interestBaseValue: '0.000000',
								interestQuoteValue: '0.000000',
								marketIndex: 0,
								oraclePrice: '0.000000',
								pnl: '0.000000',
								withdrawals: '0.000000',
							},
							{
								balance: '1090.000000',
								deposits: '0.000000',
								interestBaseValue: '0.000000',
								interestQuoteValue: '0.000000',
								marketIndex: 0,
								oraclePrice: '0.000000',
								pnl: '0.000000',
								withdrawals: '10.000000',
							},
						],
					},
				],
				meta: { flagged: 0 },
			});
		});

		it('should handle empty snapshots', async () => {
			mockGetSnapshotsBetweenTimestamps.mockResolvedValue([]);

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/snapshots/earn',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenCalledWith({
				entity: EntityTypes.User,
				id: 'testAccount',
				recordType: RecordTypes.EarnSnapshotRecord,
				startTs: getTimestampDay({ days: -7 }),
				endTs: fixedTimestamp,
				frequency: 'daily',
			});

			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				snapshots: [],
				meta: { flagged: 0 },
			});
		});

		it('should handle errors from snapshot repository', async () => {
			mockGetSnapshotsBetweenTimestamps.mockRejectedValue(new Error('Database error'));

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/snapshots/earn',
			});

			expect(response.statusCode).toBe(500);
		});
	});

	describe('GET /user/:accountId/snapshots/vaults', () => {
		it('should return vault snapshots with daily change', async () => {
			const mockSnapshots = [
				createMockVaultDepositorSnapshotRecord({
					totalAccountValue: 1000,
				}),
				createMockVaultDepositorSnapshotRecord({
					totalAccountValue: 2000,
				}),
			];

			mockGetSnapshotsBetweenTimestamps.mockResolvedValueOnce(mockSnapshots);

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/snapshots/vaults',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenCalledWith({
				entity: EntityTypes.User,
				id: 'testAccount',
				recordType: RecordTypes.VaultDepositorSnapshotRecord,
				startTs: getTimestampDay({ days: -7 }),
				endTs: fixedTimestamp,
				frequency: 'daily',
			});

			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				snapshots: [
					{
						ts: 1234567890,
						vault: 'vault',
						totalAccountValue: '1000.000000',
						totalAccountBaseValue: '10.000000',
						marketIndex: 0,
					},
					{
						ts: 1234567890,
						vault: 'vault',
						totalAccountValue: '2000.000000',
						totalAccountBaseValue: '10.000000',
						marketIndex: 0,
					},
				],
			});
		});

		it('should handle empty snapshots', async () => {
			mockGetSnapshotsBetweenTimestamps.mockResolvedValue([]);

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/snapshots/vaults',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenCalledWith({
				entity: EntityTypes.User,
				id: 'testAccount',
				recordType: RecordTypes.VaultDepositorSnapshotRecord,
				startTs: getTimestampDay({ days: -7 }),
				endTs: fixedTimestamp,
				frequency: 'daily',
			});

			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				snapshots: [],
			});
		});

		it('should handle errors from snapshot repository', async () => {
			mockGetSnapshotsBetweenTimestamps.mockRejectedValue(new Error('Database error'));

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/snapshots/vaults',
			});

			expect(response.statusCode).toBe(500);
		});
	});

	// Any custom days parameter should be respected
	describe('GET /user/:accountId/snapshots with custom days parameter', () => {
		it('should use custom days parameter for all endpoints', async () => {
			mockGetSnapshotsBetweenTimestamps.mockResolvedValue([]);
			mockGetPreviousSnapshot.mockResolvedValue(null);

			// Test trading endpoint with custom days
			await app.inject({
				method: 'GET',
				url: '/user/testAccount/snapshots/trading?days=30',
			});

			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenCalledWith({
				entity: EntityTypes.User,
				id: 'testAccount',
				recordType: RecordTypes.TradeSnapshotRecord,
				startTs: getTimestampDay({ days: -30 }),
				endTs: fixedTimestamp,
				frequency: 'daily',
			});

			// Test earn endpoint with custom days
			await app.inject({
				method: 'GET',
				url: '/user/testAccount/snapshots/earn?days=14',
			});

			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenCalledWith({
				entity: EntityTypes.User,
				id: 'testAccount',
				recordType: RecordTypes.EarnSnapshotRecord,
				startTs: getTimestampDay({ days: -14 }),
				endTs: fixedTimestamp,
				frequency: 'daily',
			});

			// Test vaults endpoint with custom days
			await app.inject({
				method: 'GET',
				url: '/user/testAccount/snapshots/vaults?days=90',
			});

			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenCalledWith({
				entity: EntityTypes.User,
				id: 'testAccount',
				recordType: RecordTypes.VaultDepositorSnapshotRecord,
				startTs: getTimestampDay({ days: -90 }),
				endTs: fixedTimestamp,
				frequency: 'daily',
			});
		});
	});

	describe('GET /user/:accountId/positions', () => {
		it('should return positions for a given account ID with single trade', async () => {
			const mockRecords = [createMockPositionRecord()];
			const mockMeta = { nextPage: 'someToken' };
			mockPosition.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/positions',
			});

			expect(response.statusCode).toBe(200);
			expect(mockPosition).toHaveBeenCalledWith({
				id: 'testAccount',
				page: undefined,
			});
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						user: 'maker-pubkey-789',
						userFee: '1.500000',
						slot: 100000,
						fillerReward: '0.100000',
						baseAssetAmountFilled: '1.500000000',
						baseClosedForPnl: '1.500000000',
						quoteAssetAmountFilled: '1500.000000',
						makerRebate: '0.020000',
						referrerReward: '0.010000',
						quoteAssetAmountSurplus: '0.000000',
						takerOrderBaseAssetAmount: '2.000000000',
						takerOrderCumulativeBaseAssetAmountFilled: '1.500000000',
						takerOrderCumulativeQuoteAssetAmountFilled: '45000.000000',
						makerOrderBaseAssetAmount: '5.000000000',
						makerOrderCumulativeBaseAssetAmountFilled: '3.000000000',
						makerOrderCumulativeQuoteAssetAmountFilled: '90000.000000',
						oraclePrice: '30000.000000',
						userExistingBaseAssetAmount: '1.500000000',
						userExistingQuoteEntryAmount: '1500.000000',
						makerExistingBaseAssetAmount: '1.500000000',
						makerExistingQuoteEntryAmount: '1500.000000',
						makerFee: '0.750000',
						action: 'fill',
						takerExistingBaseAssetAmount: '1.500000000',
						takerExistingQuoteEntryAmount: '1500.000000',
						takerFee: '1.500000',
						bitFlags: 0,
						actionExplanation: 'Order filled',
						marketIndex: 0,
						marketType: 'perp',
						marketFilter: 'perp',
						filler: 'filler-pubkey-123',
						fillRecordId: 'fill-record-123',
						taker: 'taker-pubkey-456',
						takerOrderId: 'taker-order-789',
						takerOrderDirection: 'long',
						maker: 'maker-pubkey-789',
						makerOrderId: 'maker-order-012',
						makerOrderDirection: 'short',
						spotFulfillmentMethodFee: '0.000000',
						symbol: 'SOL',
					},
				],
				meta: expect.objectContaining({
					nextPage: expect.any(String),
				}),
			});
		});

		it('should return multiple positions for a given account successfully', async () => {
			const mockRecords = [
				createMockPositionRecord(),
				createMockPositionRecord(),
				createMockPositionRecord(),
			];
			const mockMeta = { nextPage: 'someToken' };
			mockPosition.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/positions',
			});

			expect(response.statusCode).toBe(200);
			expect(mockPosition).toHaveBeenCalledWith({
				id: 'testAccount',
				page: undefined,
			});
			const payload = JSON.parse(response.payload);
			expect(payload.success).toBe(true);
			expect(payload.records).toHaveLength(3);
			expect(payload.records[0]).toEqual(
				expect.objectContaining({
					ts: expect.any(Number),
					txSig: expect.any(String),
					marketType: 'perp',
					symbol: expect.any(String),
				})
			);
			expect(payload.meta).toEqual(
				expect.objectContaining({
					nextPage: expect.any(String),
				})
			);
		});

		it('should handle errors gracefully', async () => {
			mockPosition.mockRejectedValue(new Error('Database error'));

			const response = await app.inject({
				method: 'GET',
				url: '/user/testAccount/positions',
			});

			expect(response.statusCode).toBe(500);
			const payload = JSON.parse(response.payload);
			expect(payload.success).toBe(undefined);
		});
	});
});
