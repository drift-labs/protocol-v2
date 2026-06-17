import { EntityTypes, RecordTypes, SerializedMarketFilter } from '@backend/common';
import Fastify, { FastifyInstance } from 'fastify';
import CSV from '../../src/plugins/csv';
import Pagination from '../../src/plugins/pagination';
import RuntimeTransformer from '../../src/plugins/runtime-transformer';
import Market from '../../src/routes/market';
import { fetchArchiveData } from '../../src/utils/fetch-archive-data';
import {
	createMockCandleRecord,
	createMockDepositRecord,
	createMockFundingRateRecord,
	createMockInsuranceFundRecord,
	createMockInsuranceFundStakeRecord,
	createMockOrderActionRecord,
	createMockSwapRecord,
} from '../mockRecords';

const mockGetTradeRecords = jest.fn();
const mockGetTradeRecordsBetweenTimestamps = jest.fn();
const mockGetFundingRateRecords = jest.fn();
const mockGetFundingRateRecordsBetweenTimestamps = jest.fn();
const mockGetInsuranceFundRecords = jest.fn();
const mockGetInsuranceFundRecordsBetweenTimestamps = jest.fn();
const mockPrediction = jest.fn();
const mockPredictionTimestamp = jest.fn();
const mockGetCandlesFromDb = jest.fn();
const mockSwap = jest.fn();
const mockSwapTimestamp = jest.fn();
const mockDeposit = jest.fn();
const mockDepositTimestamp = jest.fn();
const mockReward = jest.fn();
const mockRewardTimestamp = jest.fn();

const mockGetInsuranceFundStakeRecords = jest.fn();
const mockGetInsuranceFundStakeRecordsBetweenTimestamps = jest.fn();

jest.mock('@backend/dynamodb', () => ({
	TradeRepository: jest.fn(() => ({
		getTradeRecords: mockGetTradeRecords,
		getTradeRecordsBetweenTimestamps: mockGetTradeRecordsBetweenTimestamps,
	})),
	FundingRateRepository: jest.fn(() => ({
		getFundingRateRecords: mockGetFundingRateRecords,
		getFundingRateRecordsBetweenTimestamps: mockGetFundingRateRecordsBetweenTimestamps,
	})),
	InsuranceFundRepository: jest.fn(() => ({
		getInsuranceFundRecords: mockGetInsuranceFundRecords,
		getInsuranceFundRecordsBetweenTimestamps: mockGetInsuranceFundRecordsBetweenTimestamps,
	})),
	PredictionRepository: jest.fn(() => ({
		getPredictionRecords: mockPrediction,
		getPredictionRecordsBetweenTimestamps: mockPredictionTimestamp,
	})),
	CandleRepository: jest.fn(() => ({
		getCandlesBetweenTimestampsForResolution: mockGetCandlesFromDb,
	})),
	SwapRepository: jest.fn(() => ({
		getSwapRecords: mockSwap,
		getSwapRecordsBetweenTimestamps: mockSwapTimestamp,
	})),
	DepositRepository: jest.fn(() => ({
		getDepositRecords: mockDeposit,
		getDepositRecordsBetweenTimestamps: mockDepositTimestamp,
	})),
	RewardRepository: jest.fn(() => ({
		getRewardRecords: mockReward,
		getRewardRecordsBetweenTimestamps: mockRewardTimestamp,
	})),
	InsuranceFundStakeRepository: jest.fn(() => ({
		getInsuranceFundStakeRecords: mockGetInsuranceFundStakeRecords,
		getInsuranceFundStakeRecordsBetweenTimestamps:
			mockGetInsuranceFundStakeRecordsBetweenTimestamps,
	})),
}));

const mockGetCandlesFromCache = jest.fn();
const mockGetCandlesBetweenTimestampsFromCache = jest.fn();
jest.mock('@backend/redis', () => ({
	...jest.requireActual('@backend/redis'),
	CandleCacheRepository: jest.fn(() => ({
		getCandlesForResolution: mockGetCandlesFromCache,
		getCandlesBetweenTimestampsForResolution: mockGetCandlesBetweenTimestampsFromCache,
	})),
}));

jest.mock('../../src/utils/fetch-archive-data', () => ({
	fetchArchiveData: jest.fn(),
}));

describe('Market Routes', () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		app = Fastify();
		await app.register(Pagination);
		await app.register(RuntimeTransformer);
		await app.register(CSV);
		await app.register(Market, { prefix: '/market' });
		await app.ready();
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	describe('GET /market/:symbol/trades', () => {
		it('should return trades for a given market symbol', async () => {
			const mockRecords = [createMockOrderActionRecord(), createMockOrderActionRecord()];
			const mockMeta = { nextPage: 'someToken' };
			mockGetTradeRecords.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/market/SOL/trades?limit=23',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetTradeRecords).toHaveBeenCalledWith({
				id: 'SOL',
				entity: EntityTypes.Market,
				page: undefined,
				limit: 23,
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
				meta: { nextPage: 'InNvbWVUb2tlbiI=' },
			});
		});

		it('should handle pagination for trades', async () => {
			const lastEvaluatedKey = { pk: 'USER#testAccount', sk: 'TRADE#TS#1234567890' };
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');
			const mockRecords = [createMockOrderActionRecord()];
			const mockMeta = { nextPage: null };
			mockGetTradeRecords.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: `/market/SOL/trades?page=${encodedToken}`,
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetTradeRecords).toHaveBeenCalledWith({
				id: 'SOL',
				entity: EntityTypes.Market,
				page: lastEvaluatedKey,
				limit: 20,
			});
		});
	});

	describe('GET /market/:symbol/trades/:year/:month/:day', () => {
		it('should return archived trades for a given market symbol, year, month, and day', async () => {
			const mockResult = {
				success: true,
				records: [createMockOrderActionRecord(), createMockOrderActionRecord()],
				meta: {
					records: 1,
					totalRecords: 1,
					totalPages: 1,
					currentPage: 1,
					nextPage: null,
				},
			};
			(fetchArchiveData as jest.Mock).mockResolvedValue(mockResult);

			const response = await app.inject({
				method: 'GET',
				url: '/market/SOL/trades/2024/6/15',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'SOL',
				year: 2024,
				month: 6,
				day: 15,
				page: 1,
				recordType: RecordTypes.TradeRecord,
				entity: EntityTypes.Market,
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
					records: 1,
					totalRecords: 1,
					currentPage: 1,
					totalPages: 1,
					nextPage: null,
				},
			});
		});

		it('should return CSV when format=csv is specified and route allows it', async () => {
			const response = await app.inject({
				method: 'GET',
				url: '/market/SOL/trades/2024/6/15?format=csv',
			});

			expect(response.statusCode).toBe(200);
			expect(response.headers['content-type']).toBe('text/csv');
			expect(response.headers['content-disposition']).toMatch(
				/attachment; filename=market-SOL-trades-2024-6-15\.csv/
			);
			expect(response.payload).toContain(
				`"ts","txSig","txSigIndex","slot","fillerReward","baseAssetAmountFilled","quoteAssetAmountFilled","takerFee","makerRebate","referrerReward","quoteAssetAmountSurplus","takerOrderBaseAssetAmount","takerOrderCumulativeBaseAssetAmountFilled","takerOrderCumulativeQuoteAssetAmountFilled","makerOrderBaseAssetAmount","makerOrderCumulativeBaseAssetAmountFilled","makerOrderCumulativeQuoteAssetAmountFilled","oraclePrice","makerFee","action","actionExplanation","marketIndex","marketType","filler","fillRecordId","taker","takerOrderId","takerOrderDirection","maker","makerOrderId","makerOrderDirection","spotFulfillmentMethodFee","marketFilter","user","symbol"`
			);
		});
	});

	describe('GET /market/:symbol/predictions', () => {
		it('should return predictions for a given market symbol', async () => {
			const mockRecords = [
				createMockOrderActionRecord({
					symbol: 'TRUMP-WIN-2024-BET',
					marketFilter: SerializedMarketFilter.PREDICTION,
				}),
				createMockOrderActionRecord({
					symbol: 'TRUMP-WIN-2024-BET',
					marketFilter: SerializedMarketFilter.PREDICTION,
				}),
			];
			const mockMeta = { nextPage: 'someToken' };
			mockPrediction.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/market/TRUMP-WIN-2024-BET/predictions',
			});

			expect(response.statusCode).toBe(200);
			expect(mockPrediction).toHaveBeenCalledWith({
				id: 'TRUMP-WIN-2024-BET',
				entity: EntityTypes.Market,
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
						symbol: 'TRUMP-WIN-2024-BET',
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
						symbol: 'TRUMP-WIN-2024-BET',
					},
				],
				meta: expect.objectContaining({
					nextPage: expect.any(String),
				}),
			});
		});

		it('should handle pagination for predictions', async () => {
			const lastEvaluatedKey = {
				pk: 'MARKET#TRUMP-WIN-2024-BET',
				sk: 'PREDICTION#TS#1234567890',
			};
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');
			const mockRecords = [createMockOrderActionRecord()];
			const mockMeta = { nextPage: null };
			mockPrediction.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			await app.inject({
				method: 'GET',
				url: `/market/TRUMP-WIN-2024-BET/predictions?page=${encodedToken}`,
			});

			expect(mockPrediction).toHaveBeenCalledWith({
				id: 'TRUMP-WIN-2024-BET',
				entity: EntityTypes.Market,
				page: lastEvaluatedKey,
			});
		});

		it('should validate prediction market symbols', async () => {
			const response = await app.inject({
				method: 'GET',
				url: '/market/SOL/predictions', // Non-prediction market
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);
			expect(payload.error).toBeDefined();
		});

		it('should handle repository errors for predictions', async () => {
			mockPrediction.mockRejectedValue(new Error('Database error'));

			const response = await app.inject({
				method: 'GET',
				url: '/market/TRUMP-WIN-2024-BET/predictions',
			});

			expect(response.statusCode).toBe(500);
		});
	});

	describe('GET /market/:symbol/predictions/:year/:month/:day', () => {
		it('should return archived predictions for a given market symbol and date', async () => {
			const mockResult = {
				success: true,
				records: [
					createMockOrderActionRecord({
						symbol: 'TRUMP-WIN-2024-BET',
						marketFilter: SerializedMarketFilter.PREDICTION,
					}),
					createMockOrderActionRecord({
						symbol: 'TRUMP-WIN-2024-BET',
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
				url: '/market/TRUMP-WIN-2024-BET/predictions/2024/6/15',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'TRUMP-WIN-2024-BET',
				year: 2024,
				month: 6,
				day: 15,
				page: 1,
				recordType: RecordTypes.PredictionRecord,
				entity: EntityTypes.Market,
				getLatestRecords: expect.any(Function),
			});

			expect(JSON.parse(response.payload)).toEqual({
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
						symbol: 'TRUMP-WIN-2024-BET',
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
						symbol: 'TRUMP-WIN-2024-BET',
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
				records: [createMockOrderActionRecord()],
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
				url: '/market/TRUMP-WIN-2024-BET/predictions/2024/6/15?page=2',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'TRUMP-WIN-2024-BET',
				year: 2024,
				month: 6,
				day: 15,
				page: 2,
				recordType: RecordTypes.PredictionRecord,
				entity: EntityTypes.Market,
				getLatestRecords: expect.any(Function),
			});
		});

		it('should validate date parameters for predictions', async () => {
			const response = await app.inject({
				method: 'GET',
				url: '/market/TRUMP-WIN-2024-BET/predictions/2024/13/32',
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);
			expect(payload.error).toBeDefined();
		});

		it('should handle archive service errors', async () => {
			(fetchArchiveData as jest.Mock).mockRejectedValue(new Error('Archive service error'));

			const response = await app.inject({
				method: 'GET',
				url: '/market/TRUMP-WIN-2024-BET/predictions/2024/6/15',
			});

			expect(response.statusCode).toBe(500);
		});
	});

	describe('GET /market/:symbol/fundingRates', () => {
		it('should return funding rates for a given perp market symbol', async () => {
			const mockRecords = [
				createMockFundingRateRecord({ symbol: 'SOL-PERP' }),
				createMockFundingRateRecord({ symbol: 'SOL-PERP', fundingRate: 0.0002 }),
			];
			const mockMeta = { nextPage: 'someToken' };
			mockGetFundingRateRecords.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/market/SOL-PERP/fundingRates',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetFundingRateRecords).toHaveBeenCalledWith({
				id: 'SOL-PERP',
				page: undefined,
				limit: 20,
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
						recordId: 'funding-rate-record-id',
						marketIndex: 0,
						symbol: 'SOL-PERP',
						fundingRate: '0.000100000',
						fundingRateLong: '0.000100000',
						fundingRateShort: '-0.000100000',
						cumulativeFundingRateLong: '0.010000000',
						cumulativeFundingRateShort: '-0.010000000',
						oraclePriceTwap: '30000.000000',
						markPriceTwap: '30010.000000',
						periodRevenue: '1000.000000',
						baseAssetAmountWithAmm: '100000.000000000',
						baseAssetAmountWithUnsettledLp: '10000.000000000',
					},
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						recordId: 'funding-rate-record-id',
						marketIndex: 0,
						symbol: 'SOL-PERP',
						fundingRate: '0.000200000',
						fundingRateLong: '0.000100000',
						fundingRateShort: '-0.000100000',
						cumulativeFundingRateLong: '0.010000000',
						cumulativeFundingRateShort: '-0.010000000',
						oraclePriceTwap: '30000.000000',
						markPriceTwap: '30010.000000',
						periodRevenue: '1000.000000',
						baseAssetAmountWithAmm: '100000.000000000',
						baseAssetAmountWithUnsettledLp: '10000.000000000',
					},
				],
				meta: expect.objectContaining({
					nextPage: expect.any(String),
				}),
			});
		});

		it('should handle pagination for funding rates', async () => {
			const lastEvaluatedKey = { pk: 'USER#testAccount', sk: 'DEPOSIT#TS#1234567890' };
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');
			const mockRecords = [
				createMockFundingRateRecord({ symbol: 'SOL-PERP', fundingRate: 0.0003 }),
			];
			const mockMeta = { nextPage: null };
			mockGetFundingRateRecords.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: `/market/SOL-PERP/fundingRates?page=${encodedToken}`,
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetFundingRateRecords).toHaveBeenCalledWith({
				id: 'SOL-PERP',
				page: expect.any(Object),
				limit: 20,
			});
		});
	});

	describe('GET /market/:symbol/fundingRates/:year/:month/:day', () => {
		it('should return archived funding rates for a given perp market symbol, year, month, and day', async () => {
			const mockResult = {
				success: true,
				records: [createMockFundingRateRecord({ symbol: 'SOL-PERP' })],
				meta: {
					records: 1,
					totalRecords: 1,
					totalPages: 1,
					currentPage: 1,
					nextPage: null,
				},
			};
			(fetchArchiveData as jest.Mock).mockResolvedValue(mockResult);

			const response = await app.inject({
				method: 'GET',
				url: '/market/SOL-PERP/fundingRates/2024/6/15',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'SOL-PERP',
				year: 2024,
				month: 6,
				day: 15,
				page: 1,
				entity: EntityTypes.Market,
				recordType: RecordTypes.FundingRateRecord,
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
						recordId: 'funding-rate-record-id',
						marketIndex: 0,
						symbol: 'SOL-PERP',
						fundingRate: '0.000100000',
						fundingRateLong: '0.000100000',
						fundingRateShort: '-0.000100000',
						cumulativeFundingRateLong: '0.010000000',
						cumulativeFundingRateShort: '-0.010000000',
						oraclePriceTwap: '30000.000000',
						markPriceTwap: '30010.000000',
						periodRevenue: '1000.000000',
						baseAssetAmountWithAmm: '100000.000000000',
						baseAssetAmountWithUnsettledLp: '10000.000000000',
					},
				],
				meta: {
					records: 1,
					totalRecords: 1,
					currentPage: 1,
					totalPages: 1,
					nextPage: null,
				},
			});
		});
	});

	describe('GET /market/:symbol/insuranceFund', () => {
		it('should return insurance fund records for a given spot market symbol', async () => {
			const mockRecords = [
				createMockInsuranceFundRecord({ symbol: 'SOL' }),
				createMockInsuranceFundRecord({ symbol: 'SOL', amount: 2000 }),
			];
			const mockMeta = { nextPage: 'someToken' };
			mockGetInsuranceFundRecords.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/market/SOL/insuranceFund',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetInsuranceFundRecords).toHaveBeenCalledWith({
				id: 'SOL',
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
						slot: 100000,
						spotMarketIndex: 0,
						perpMarketIndex: 1,
						userIfFactor: 0.1,
						totalIfFactor: 1,
						symbol: 'SOL',
						vaultAmountBefore: '100000.000000',
						insuranceVaultAmountBefore: '10000.000000',
						totalIfSharesBefore: '1000.000000',
						totalIfSharesAfter: '1100.000000',
						amount: '1000.000000',
					},
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						spotMarketIndex: 0,
						perpMarketIndex: 1,
						userIfFactor: 0.1,
						totalIfFactor: 1,
						symbol: 'SOL',
						vaultAmountBefore: '100000.000000',
						insuranceVaultAmountBefore: '10000.000000',
						totalIfSharesBefore: '1000.000000',
						totalIfSharesAfter: '1100.000000',
						amount: '2000.000000',
					},
				],
				meta: expect.objectContaining({
					nextPage: expect.any(String),
				}),
			});
		});

		it('should handle pagination for insurance fund records', async () => {
			const lastEvaluatedKey = { pk: 'USER#testAccount', sk: 'INSURANCE_FUND#TS#1234567890' };
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');
			const mockRecords = [createMockInsuranceFundRecord({ symbol: 'SOL', amount: 3000 })];
			const mockMeta = { nextPage: null };
			mockGetInsuranceFundRecords.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: `/market/SOL/insuranceFund?page=${encodedToken}`,
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetInsuranceFundRecords).toHaveBeenCalledWith({
				id: 'SOL',
				page: expect.any(Object),
			});
		});
	});

	describe('GET /market/:symbol/insuranceFund/:year/:month/:day', () => {
		it('should return archived insurance fund records for a given spot market symbol, year, month, and day', async () => {
			const mockRecords = [createMockInsuranceFundRecord({ symbol: 'SOL-PERP' })];
			const mockResult = {
				success: true,
				records: mockRecords.map((record) => {
					const { pk, sk, entity, source, ...rest } = record;
					return rest;
				}),
				meta: {
					records: 1,
					totalRecords: 1,
					totalPages: 1,
					currentPage: 1,
					nextPage: null,
				},
			};
			(fetchArchiveData as jest.Mock).mockResolvedValue(mockResult);

			const response = await app.inject({
				method: 'GET',
				url: '/market/SOL/insuranceFund/2024/6/15',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'SOL',
				year: 2024,
				month: 6,
				day: 15,
				page: 1,
				entity: EntityTypes.Market,
				recordType: RecordTypes.InsuranceFundRecord,
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
						spotMarketIndex: 0,
						perpMarketIndex: 1,
						userIfFactor: 0.1,
						totalIfFactor: 1,
						symbol: 'SOL-PERP',
						vaultAmountBefore: '100000.000000',
						insuranceVaultAmountBefore: '10000.000000',
						totalIfSharesBefore: '1000.000000',
						totalIfSharesAfter: '1100.000000',
						amount: '1000.000000',
					},
				],
				meta: {
					records: 1,
					totalRecords: 1,
					currentPage: 1,
					totalPages: 1,
					nextPage: null,
				},
			});
		});
	});

	describe('GET /market/:symbol/candles/:resolution', () => {
		it('should return candles for a given market symbol and resolution', async () => {
			const mockCandles = [
				createMockCandleRecord({ ts: 1000 }),
				createMockCandleRecord({ ts: 2000 }),
			];
			mockGetCandlesFromCache.mockResolvedValue(mockCandles);

			const response = await app.inject({
				method: 'GET',
				url: '/market/SOL-PERP/candles/1',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetCandlesFromCache).toHaveBeenCalledWith({
				symbol: 'SOL-PERP',
				resolution: '1',
				limit: 100,
			});
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: mockCandles.map((record) => {
					const { pk, sk, symbol, resolution, ...rest } = record;
					return rest;
				}),
			});
		});

		it('should handle custom limit parameter', async () => {
			mockGetCandlesFromCache.mockResolvedValue([createMockCandleRecord({ ts: 1000 })]);

			const response = await app.inject({
				method: 'GET',
				url: '/market/SOL-PERP/candles/1?limit=50',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetCandlesFromCache).toHaveBeenCalledWith({
				symbol: 'SOL-PERP',
				resolution: '1',
				limit: 50,
			});
		});

		it('should validate resolution parameter', async () => {
			const response = await app.inject({
				method: 'GET',
				url: '/market/SOL-PERP/candles/invalid',
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);
			expect(payload.error).toBeDefined();
		});

		it('should fetch candles between timestamps from cache and db if needed', async () => {
			const startTs = 1700000000;
			const endTs = 1699999000;
			const cacheCandles = [createMockCandleRecord({ ts: startTs - 100 })];
			const dbCandles = [createMockCandleRecord({ ts: endTs + 100 })];

			mockGetCandlesBetweenTimestampsFromCache.mockResolvedValue(cacheCandles);
			mockGetCandlesFromDb.mockResolvedValue(dbCandles);

			const response = await app.inject({
				method: 'GET',
				url: `/market/SOL-PERP/candles/1?startTs=${startTs}&endTs=${endTs}&limit=100`,
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetCandlesBetweenTimestampsFromCache).toHaveBeenCalledWith({
				symbol: 'SOL-PERP',
				resolution: '1',
				limit: 100,
				startTs,
				endTs,
			});
			expect(mockGetCandlesFromDb).toHaveBeenCalledWith({
				symbol: 'SOL-PERP',
				resolution: '1',
				startTs: startTs - 101,
				endTs,
				limit: 99,
			});

			const payload = JSON.parse(response.payload);

			// DB candles will be pushed onto the cached candles object
			const expectedResult = [
				...cacheCandles.map((record) => {
					const { pk, sk, symbol, resolution, ...rest } = record;
					return rest;
				}),
			];

			expect(payload).toEqual({
				success: true,
				records: expectedResult,
			});
		});

		it('should validate timestamp parameters', async () => {
			const response = await app.inject({
				method: 'GET',
				url: `/market/SOL-PERP/candles/1?startTs=invalid&endTs=invalid`,
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);
			expect(payload.error).toBeDefined();
		});

		it('should validate startTs is after endTs', async () => {
			const startTs = 1699999000;
			const endTs = 1700000000;

			const response = await app.inject({
				method: 'GET',
				url: `/market/SOL-PERP/candles/1?startTs=${startTs}&endTs=${endTs}`,
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);
			expect(payload.error).toBe('ValidationError');
			expect(payload.message).toBe('Start timestamp must be after end timestamp');
		});

		it('should handle errors from cache repository', async () => {
			mockGetCandlesFromCache.mockRejectedValue(new Error('Cache error'));

			const response = await app.inject({
				method: 'GET',
				url: '/market/SOL-PERP/candles/1',
			});

			expect(response.statusCode).toBe(500);
		});

		it('should validate limit parameter constraints', async () => {
			const response = await app.inject({
				method: 'GET',
				url: '/market/SOL-PERP/candles/1?limit=1001',
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);
			expect(payload.error).toBeDefined();
		});
	});

	describe('GET /market/:symbol/deposits', () => {
		it('should return deposit records for a given spot market symbol', async () => {
			const mockRecords = [
				createMockDepositRecord({ symbol: 'SOL' }),
				createMockDepositRecord({ symbol: 'SOL', amount: 2000 }),
			];
			const mockMeta = { nextPage: 'someToken' };
			mockDeposit.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/market/SOL/deposits',
			});

			expect(response.statusCode).toBe(200);
			expect(mockDeposit).toHaveBeenCalledWith({
				id: 'SOL',
				entity: 'market',
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
						symbol: 'SOL',
					},
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						amount: '2000.000000',
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
						symbol: 'SOL',
					},
				],
				meta: expect.objectContaining({
					nextPage: expect.any(String),
				}),
			});
		});

		it('should handle pagination for insurance fund records', async () => {
			const lastEvaluatedKey = { pk: 'USER#testAccount', sk: 'DEPOSIT#TS#1234567890' };
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');
			const mockRecords = [createMockDepositRecord({ symbol: 'SOL', amount: 3000 })];
			const mockMeta = { nextPage: null };
			mockDeposit.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: `/market/SOL/deposits?page=${encodedToken}`,
			});

			expect(response.statusCode).toBe(200);
			expect(mockDeposit).toHaveBeenCalledWith({
				id: 'SOL',
				entity: 'market',
				page: expect.any(Object),
			});
		});
	});

	describe('GET /market/:symbol/deposits/:year/:month/:day', () => {
		it('should return archived deposit records for a given spot market symbol, year, month, and day', async () => {
			const mockRecords = [createMockDepositRecord({ symbol: 'SOL' })];
			const mockResult = {
				success: true,
				records: mockRecords.map((record) => {
					const { pk, sk, entity, source, ...rest } = record;
					return rest;
				}),
				meta: {
					records: 1,
					totalRecords: 1,
					totalPages: 1,
					currentPage: 1,
					nextPage: null,
				},
			};
			(fetchArchiveData as jest.Mock).mockResolvedValue(mockResult);

			const response = await app.inject({
				method: 'GET',
				url: '/market/SOL/deposits/2024/6/15',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'SOL',
				year: 2024,
				month: 6,
				day: 15,
				page: 1,
				entity: EntityTypes.Market,
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
						symbol: 'SOL',
					},
				],
				meta: {
					records: 1,
					totalRecords: 1,
					currentPage: 1,
					totalPages: 1,
					nextPage: null,
				},
			});
		});
	});

	describe('GET /market/:symbol/rewards', () => {
		it('should return reward records for a given spot market symbol', async () => {
			const mockRecords = [
				createMockDepositRecord({ symbol: 'SOL' }),
				createMockDepositRecord({ symbol: 'SOL', amount: 200 }),
			];
			const mockMeta = { nextPage: 'someToken' };
			mockReward.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/market/SOL/rewards',
			});

			expect(response.statusCode).toBe(200);
			expect(mockReward).toHaveBeenCalledWith({
				id: 'SOL',
				entity: EntityTypes.Market,
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
						symbol: 'SOL',
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
						user: 'mock-user',
						direction: 'deposit',
						explanation: 'Mock deposit record',
						marketIndex: 0,
						symbol: 'SOL',
					},
				],
				meta: { nextPage: 'InNvbWVUb2tlbiI=' },
			});
		});

		it('should handle pagination for reward records', async () => {
			const lastEvaluatedKey = { pk: 'MARKET#SOL', sk: 'REWARD#TS#1234567890' };
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');
			const mockRecords = [createMockDepositRecord({ symbol: 'SOL', amount: 300 })];
			const mockMeta = { nextPage: null };
			mockReward.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: `/market/SOL/rewards?page=${encodedToken}`,
			});

			expect(response.statusCode).toBe(200);
			expect(mockReward).toHaveBeenCalledWith({
				id: 'SOL',
				entity: EntityTypes.Market,
				page: lastEvaluatedKey,
			});
		});
	});

	describe('GET /market/:symbol/rewards/:year/:month/:day', () => {
		it('should return archived reward records for a given market symbol, year, month, and day', async () => {
			const mockRecords = [createMockDepositRecord({ symbol: 'SOL' })];
			const mockResult = {
				success: true,
				records: mockRecords.map((record) => {
					const { pk, sk, entity, source, ...rest } = record;
					return rest;
				}),
				meta: {
					records: 1,
					totalRecords: 1,
					totalPages: 1,
					currentPage: 1,
					nextPage: null,
				},
			};
			(fetchArchiveData as jest.Mock).mockResolvedValue(mockResult);

			const response = await app.inject({
				method: 'GET',
				url: '/market/SOL/rewards/2024/6/15',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'SOL',
				year: 2024,
				month: 6,
				day: 15,
				page: 1,
				entity: EntityTypes.Market,
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
						symbol: 'SOL',
					},
				],
				meta: {
					records: 1,
					totalRecords: 1,
					currentPage: 1,
					totalPages: 1,
					nextPage: null,
				},
			});
		});
	});

	describe('GET /market/:symbol/swaps', () => {
		it('should return swap records for a given spot market symbol', async () => {
			const mockRecords = [createMockSwapRecord(), createMockSwapRecord()];
			const mockMeta = { nextPage: 'someToken' };
			mockSwap.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: '/market/SOL/swaps',
			});

			expect(response.statusCode).toBe(200);
			expect(mockSwap).toHaveBeenCalledWith({
				id: 'SOL',
				entity: 'market',
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

		it('should handle pagination for swap records', async () => {
			const lastEvaluatedKey = { pk: 'USER#testAccount', sk: 'SWAP#TS#1234567890' };
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');
			const mockRecords = [createMockSwapRecord()];
			const mockMeta = { nextPage: null };
			mockSwap.mockResolvedValue({ records: mockRecords, meta: mockMeta });

			const response = await app.inject({
				method: 'GET',
				url: `/market/SOL/swaps?page=${encodedToken}`,
			});

			expect(response.statusCode).toBe(200);
			expect(mockSwap).toHaveBeenCalledWith({
				id: 'SOL',
				entity: 'market',
				page: expect.any(Object),
			});
		});
	});

	describe('GET /market/:symbol/swaps/:year/:month/:day', () => {
		it('should return archived swap records for a given spot market symbol, year, month, and day', async () => {
			const mockRecords = [createMockSwapRecord()];
			const mockResult = {
				success: true,
				records: mockRecords.map((record) => {
					const { pk, sk, entity, source, ...rest } = record;
					return rest;
				}),
				meta: {
					records: 1,
					totalRecords: 1,
					totalPages: 1,
					currentPage: 1,
					nextPage: null,
				},
			};
			(fetchArchiveData as jest.Mock).mockResolvedValue(mockResult);

			const response = await app.inject({
				method: 'GET',
				url: '/market/SOL/swaps/2024/6/15',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'SOL',
				year: 2024,
				month: 6,
				day: 15,
				page: 1,
				entity: EntityTypes.Market,
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
				meta: {
					records: 1,
					totalRecords: 1,
					currentPage: 1,
					totalPages: 1,
					nextPage: null,
				},
			});
		});
	});

	describe('GET /market/:symbol/insuranceFundStake', () => {
		it('should return insurance fund stake records for a given spot market symbol', async () => {
			const mockRecords = [
				createMockInsuranceFundStakeRecord({ symbol: 'SOL' }),
				createMockInsuranceFundStakeRecord({ symbol: 'SOL', amount: 2000 }),
			];
			const mockMeta = { nextPage: 'someToken' };
			mockGetInsuranceFundStakeRecords.mockResolvedValue({
				records: mockRecords,
				meta: mockMeta,
			});

			const response = await app.inject({
				method: 'GET',
				url: '/market/SOL/insuranceFundStake',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetInsuranceFundStakeRecords).toHaveBeenCalledWith({
				id: 'SOL',
				entity: 'market',
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
						slot: 100000,
						amount: '1000.000000',
						userAuthority: 'mock-user-authority',
						action: 'stake',
						marketIndex: 0,
						ifSharesBefore: '500.000000',
						ifSharesAfter: '600.000000',
						userIfSharesBefore: '100.000000',
						userIfSharesAfter: '200.000000',
						totalIfSharesBefore: '1000.000000',
						totalIfSharesAfter: '1100.000000',
						insuranceVaultAmountBefore: '10000.000000',
						symbol: 'SOL',
					},
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						amount: '2000.000000',
						userAuthority: 'mock-user-authority',
						action: 'stake',
						marketIndex: 0,
						ifSharesBefore: '500.000000',
						ifSharesAfter: '600.000000',
						userIfSharesBefore: '100.000000',
						userIfSharesAfter: '200.000000',
						totalIfSharesBefore: '1000.000000',
						totalIfSharesAfter: '1100.000000',
						insuranceVaultAmountBefore: '10000.000000',
						symbol: 'SOL',
					},
				],
				meta: expect.objectContaining({
					nextPage: expect.any(String),
				}),
			});
		});

		it('should handle pagination for insurance fund records', async () => {
			const lastEvaluatedKey = {
				pk: 'USER#testAccount',
				sk: 'INSURANCE_FUND_STAKE#TS#1234567890',
			};
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');
			const mockRecords = [
				createMockInsuranceFundStakeRecord({ symbol: 'SOL', amount: 3000 }),
			];
			const mockMeta = { nextPage: null };
			mockGetInsuranceFundStakeRecords.mockResolvedValue({
				records: mockRecords,
				meta: mockMeta,
			});

			const response = await app.inject({
				method: 'GET',
				url: `/market/SOL/insuranceFundStake?page=${encodedToken}`,
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetInsuranceFundStakeRecords).toHaveBeenCalledWith({
				id: 'SOL',
				entity: 'market',
				page: expect.any(Object),
			});
		});
	});

	describe('GET /market/:symbol/insuranceFundStake/:year/:month/:day', () => {
		it('should return archived insurance fund stake records for a given spot market symbol, year, month, and day', async () => {
			const mockRecords = [createMockInsuranceFundStakeRecord({ symbol: 'SOL' })];
			const mockResult = {
				success: true,
				records: mockRecords.map((record) => {
					const { pk, sk, entity, source, ...rest } = record;
					return rest;
				}),
				meta: {
					records: 1,
					totalRecords: 1,
					totalPages: 1,
					currentPage: 1,
					nextPage: null,
				},
			};
			(fetchArchiveData as jest.Mock).mockResolvedValue(mockResult);

			const response = await app.inject({
				method: 'GET',
				url: '/market/SOL/insuranceFundStake/2024/6/15',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'SOL',
				year: 2024,
				month: 6,
				day: 15,
				page: 1,
				entity: EntityTypes.Market,
				recordType: RecordTypes.InsuranceFundStakeRecord,
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
						userAuthority: 'mock-user-authority',
						action: 'stake',
						marketIndex: 0,
						ifSharesBefore: '500.000000',
						ifSharesAfter: '600.000000',
						userIfSharesBefore: '100.000000',
						userIfSharesAfter: '200.000000',
						totalIfSharesBefore: '1000.000000',
						totalIfSharesAfter: '1100.000000',
						insuranceVaultAmountBefore: '10000.000000',
						symbol: 'SOL',
					},
				],
				meta: {
					records: 1,
					totalRecords: 1,
					currentPage: 1,
					totalPages: 1,
					nextPage: null,
				},
			});
		});
	});
});
