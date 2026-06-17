import {
	EntityTypes,
	getTimestampDay,
	RateHistoryType,
	RecordTypes,
	SerializedMarketFilter,
	UiStatus,
	VolumeInterval,
} from '@backend/common';
import { BN } from '@velocity-exchange/sdk';
import Fastify, { FastifyInstance } from 'fastify';
import Pagination from '../../src/plugins/pagination';
import RuntimeTransformer from '../../src/plugins/runtime-transformer';
import Stats from '../../src/routes/stats/';
import {
	createMockLiquidationRecord,
	createMockPoolSnapshotRecord,
	createMockVault,
} from '../mockRecords';

const mockGetLiquidationRecords = jest.fn();
const mockGetAuctionLatencyStatsForMarket = jest.fn();
const mockGetAuctionLatencyStatsBetweenTimestamps = jest.fn();
const mockGetTriggerOrderFillStatsForMarket = jest.fn();
const mockGetTriggerOrderFillStatsBetweenTimestamps = jest.fn();
const mockGetCandlesBetweenTimestampsForResolution = jest.fn();
const mockGetSnapshotsBetweenTimestamps = jest.fn();

const mockInsuranceFundSwapRecords = [
	{
		ts: 1234567890,
		txSig: 'test_tx_signature',
		txSigIndex: 0,
		slot: 100,
		inMarketIndex: 0,
		outMarketIndex: 1,
		inAmount: '1000000',
		outAmount: '950000',
		inVaultAmountBefore: '10000000',
		outVaultAmountBefore: '20000000',
		inFundVaultAmountAfter: '11000000',
		outFundVaultAmountAfter: '19050000',
		inIfTotalSharesBefore: '5000000',
		outIfTotalSharesBefore: '8000000',
		inIfTotalSharesAfter: '5500000',
		outIfTotalSharesAfter: '7600000',
		inIfUserSharesBefore: '100000',
		outIfUserSharesBefore: '200000',
		inIfUserSharesAfter: '110000',
		outIfUserSharesAfter: '190000',
		outOraclePrice: '1.05',
		outOraclePriceTwap: '1.03',
		rebalanceConfig: 'test_config',
	},
];
const mockGetInsuranceFundSwapRecords = jest.fn(() => ({
	records: mockInsuranceFundSwapRecords,
	meta: {
		nextPage: 'InNvbWVUb2tlbiI=',
	},
}));

jest.mock('@backend/dynamodb', () => ({
	LiquidationRepository: jest.fn(() => ({
		getLiquidationRecords: mockGetLiquidationRecords,
	})),
	AnalyticsRepository: jest.fn(() => ({
		getAuctionLatencyStatsForMarket: mockGetAuctionLatencyStatsForMarket,
		getAuctionLatencyStatsBetweenTimestamps: mockGetAuctionLatencyStatsBetweenTimestamps,
		getTriggerOrderFillStatsForMarket: mockGetTriggerOrderFillStatsForMarket,
		getTriggerOrderFillStatsBetweenTimestamps: mockGetTriggerOrderFillStatsBetweenTimestamps,
	})),
	InsuranceFundSwapRepository: jest.fn(() => ({
		getInsuranceFundSwapRecords: mockGetInsuranceFundSwapRecords,
	})),
	CandleRepository: jest.fn(() => ({
		getCandlesBetweenTimestampsForResolution: mockGetCandlesBetweenTimestampsForResolution,
	})),
	SnapshotRepository: jest.fn(() => ({
		getSnapshotsBetweenTimestamps: mockGetSnapshotsBetweenTimestamps,
	})),
}));

const mockGetLiquidationStats = jest.fn();
const mockGetVaultStats = jest.fn();
const mockGetBankruptcyStats = jest.fn();
const mockGetRateHistory = jest.fn();
const mockGetMarketSummary = jest.fn();
const mockGetMarketsVolume = jest.fn();
const mockGetLeaderboard = jest.fn();
const mockGetLeaderboardRank = jest.fn();
const mockGetCandlesBetweenTimestampsForResolutionFromCache = jest.fn();

jest.mock('@backend/redis', () => ({
	...jest.requireActual('@backend/redis'),
	StatsCacheRepository: jest.fn(() => ({
		getLiquidationStats: mockGetLiquidationStats,
		getBankruptcyStats: mockGetBankruptcyStats,
		getVaultStats: mockGetVaultStats,
		getRateHistory: mockGetRateHistory,
	})),
	MarketCacheRepository: () => ({
		getMarketSummary: mockGetMarketSummary,
		getMarketsVolume: mockGetMarketsVolume,
	}),
	LeaderboardCacheRepository: () => ({
		getLeaderboard: mockGetLeaderboard,
		getLeaderboardRank: mockGetLeaderboardRank,
	}),
	CandleCacheRepository: () => ({
		getCandlesBetweenTimestampsForResolution:
			mockGetCandlesBetweenTimestampsForResolutionFromCache,
	}),
}));

const fixedTimestamp = 1234567890;
jest.mock('@backend/common', () => {
	const actual = jest.requireActual('@backend/common');
	return {
		...actual,
		getSpotMarkets: jest.fn(() => [
			{ symbol: 'SOL/USDC', marketIndex: 0, precisionExp: new BN(6) },
		]),
		getPerpMarkets: jest.fn(() => [{ symbol: 'SOL-PERP', marketIndex: 1 }]),
		getTimestamp: jest.fn(({ days } = {}) =>
			days ? fixedTimestamp + days * 86400 : fixedTimestamp
		),
		getTimestampHour: jest.fn(({ days }) =>
			days ? fixedTimestamp + days * 86400 : fixedTimestamp
		),
		getTimestampDay: jest.fn(({ days }) => fixedTimestamp + days * 86400),
	};
});

describe('Stats Routes', () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		app = Fastify();
		await app.register(Pagination);
		await app.register(RuntimeTransformer);
		await app.register(Stats, { prefix: 'stats' });
		await app.ready();
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	describe('GET /stats/liquidations', () => {
		it('should get liquidations records', async () => {
			const mockRecords = [createMockLiquidationRecord(), createMockLiquidationRecord()];
			const mockMeta = { nextPage: 'someToken' };
			const mockStats = {
				'24h': { count: 1, amount: 1 },
				'30d': { count: 1, amount: 1 },
			};

			mockGetLiquidationRecords.mockResolvedValue({ records: mockRecords, meta: mockMeta });
			mockGetLiquidationStats.mockResolvedValue(mockStats);

			const response = await app.inject({
				method: 'GET',
				url: '/stats/liquidations',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetLiquidationRecords).toHaveBeenCalledWith({
				page: undefined,
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				stats: { '24h': { count: 1, amount: 1 }, '30d': { count: 1, amount: 1 } },
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

		it('should handle errors when getting liquidations', async () => {
			mockGetLiquidationRecords.mockRejectedValue(new Error('Database error'));

			const response = await app.inject({
				method: 'GET',
				url: '/stats/liquidations',
			});

			expect(response.statusCode).toBe(500);
		});
	});

	describe('GET /stats/bankruptcies', () => {
		it('should get bankruptcy records', async () => {
			const mockRecords = [createMockLiquidationRecord(), createMockLiquidationRecord()];
			const mockMeta = { nextPage: 'someToken' };
			const mockStats = {
				totalAmount: '15000',
				ifPayment: '6800',
				socialLoss: '8200',
				totalCount: '5',
			};

			mockGetLiquidationRecords.mockResolvedValue({ records: mockRecords, meta: mockMeta });
			mockGetBankruptcyStats.mockResolvedValue(mockStats);

			const response = await app.inject({
				method: 'GET',
				url: '/stats/bankruptcies',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetLiquidationRecords).toHaveBeenCalledWith({
				bankruptcy: true,
				page: undefined,
			});
			expect(mockGetBankruptcyStats).toHaveBeenCalled();

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				stats: {
					totalAmount: '15000',
					ifPayment: '6800',
					socialLoss: '8200',
					totalCount: '5',
				},
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

		it('should handle errors when getting bankruptcy records', async () => {
			mockGetLiquidationRecords.mockRejectedValue(new Error('Database error'));
			const response = await app.inject({
				method: 'GET',
				url: '/stats/bankruptcies',
			});
			expect(response.statusCode).toBe(500);
		});
	});

	describe('GET /stats/vaults', () => {
		it('should get vaults stats', async () => {
			const mockVaults = [
				createMockVault({
					pubkey: 'vault1',
					userShares: 201982974,
					totalShares: 201982974,
				}),
				createMockVault({
					pubkey: 'vault2',
					userShares: 150000000,
					totalShares: 300000000,
				}),
			];

			mockGetVaultStats.mockResolvedValue(mockVaults);

			const response = await app.inject({
				method: 'GET',
				url: '/stats/vaults',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetVaultStats).toHaveBeenCalled();

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				vaults: [
					{
						pubkey: 'vault1',
						manager: 'mock-manager',
						tokenAccount: 'mock-token-account',
						userStats: 'mock-user-stats',
						user: 'mock-user',
						delegate: 'mock-delegate',
						liquidationDelegate: 'mock-liquidation-delegate',
						userShares: '201982974',
						totalShares: '201982974',
						sharesBase: '0',
						lastFeeUpdateTs: 1741660938,
						liquidationStartTs: 0,
						redeemPeriod: 300,
						initTs: 1741606262,
						totalWithdrawRequested: 0,
						maxTokens: '5000',
						netDeposits: '200.989703',
						totalDeposits: '200.989703',
						totalWithdraws: '0',
						managerNetDeposits: '0',
						managerTotalDeposits: '0',
						managerTotalWithdraws: '0',
						managerTotalFee: '0',
						managerTotalProfitShare: '0',
						lastManagerWithdrawRequest: { shares: '0', value: '0', ts: '0' },
						minDepositAmount: '1',
						profitShare: '0',
						managementFee: '0',
						hurdleRate: '0',
						spotMarketIndex: 0,
						permissioned: false,
					},
					{
						pubkey: 'vault2',
						manager: 'mock-manager',
						tokenAccount: 'mock-token-account',
						userStats: 'mock-user-stats',
						user: 'mock-user',
						delegate: 'mock-delegate',
						liquidationDelegate: 'mock-liquidation-delegate',
						userShares: '150000000',
						totalShares: '300000000',
						sharesBase: '0',
						lastFeeUpdateTs: 1741660938,
						liquidationStartTs: 0,
						redeemPeriod: 300,
						initTs: 1741606262,
						totalWithdrawRequested: 0,
						maxTokens: '5000',
						netDeposits: '200.989703',
						totalDeposits: '200.989703',
						totalWithdraws: '0',
						managerNetDeposits: '0',
						managerTotalDeposits: '0',
						managerTotalWithdraws: '0',
						managerTotalFee: '0',
						managerTotalProfitShare: '0',
						lastManagerWithdrawRequest: { shares: '0', value: '0', ts: '0' },
						minDepositAmount: '1',
						profitShare: '0',
						managementFee: '0',
						hurdleRate: '0',
						spotMarketIndex: 0,
						permissioned: false,
					},
				],
			});
		});

		it('should handle errors when getting vaults', async () => {
			mockGetVaultStats.mockRejectedValue(new Error('Cache error'));

			const response = await app.inject({
				method: 'GET',
				url: '/stats/vaults',
			});

			expect(response.statusCode).toBe(500);
		});
	});

	describe('GET /stats/:symbol/rateHistory/:type', () => {
		it('should get rate history data for a symbol and type', async () => {
			const mockRates = [
				[1738637201, '0.065205'],
				[1738647201, '0.062981'],
				[1738657201, '0.064749'],
			];

			mockGetRateHistory.mockResolvedValue(mockRates);

			const response = await app.inject({
				method: 'GET',
				url: '/stats/SOL/rateHistory/deposit',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetRateHistory).toHaveBeenCalledWith({
				symbol: 'SOL',
				type: RateHistoryType.DEPOSIT,
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				rates: [
					[1738637201, '0.065205'],
					[1738647201, '0.062981'],
					[1738657201, '0.064749'],
				],
			});
		});

		it('should handle null rate history data', async () => {
			mockGetRateHistory.mockResolvedValue(null);

			const response = await app.inject({
				method: 'GET',
				url: '/stats/SOL/rateHistory/deposit',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetRateHistory).toHaveBeenCalledWith({
				symbol: 'SOL',
				type: RateHistoryType.DEPOSIT,
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				rates: [],
			});
		});

		it('should handle errors when getting rate history data', async () => {
			mockGetRateHistory.mockRejectedValue(new Error('Cache error'));

			const response = await app.inject({
				method: 'GET',
				url: '/stats/SOL/rateHistory/deposit',
			});

			expect(response.statusCode).toBe(500);
		});

		it('should support different rate history types', async () => {
			const mockRates = [
				[1738637201, '0.072105'],
				[1738647201, '0.073981'],
				[1738657201, '0.071749'],
			];

			mockGetRateHistory.mockResolvedValue(mockRates);

			const response = await app.inject({
				method: 'GET',
				url: '/stats/SOL/rateHistory/borrow',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetRateHistory).toHaveBeenCalledWith({
				symbol: 'SOL',
				type: RateHistoryType.BORROW,
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				rates: mockRates,
			});
		});
	});

	describe('GET /stats/insuranceFundSwaps', () => {
		it('should get insurance fund swaps', async () => {
			mockGetInsuranceFundSwapRecords;
			const response = await app.inject({
				method: 'GET',
				url: '/stats/insuranceFundSwaps',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetInsuranceFundSwapRecords).toHaveBeenCalled();

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: mockGetInsuranceFundSwapRecords().records,
				meta: {
					nextPage: 'IkluTnZiV1ZVYjJ0bGJpST0i',
				},
			});
		});

		it('should support pagination', async () => {
			mockGetInsuranceFundSwapRecords;

			const response = await app.inject({
				method: 'GET',
				url: '/stats/insuranceFundSwaps?page=InNvbWVUb2tlbiI=',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetInsuranceFundSwapRecords).toHaveBeenCalledWith({
				// called with this by internally mocked fastify
				page: 'someToken',
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				meta: {
					nextPage: 'IkluTnZiV1ZVYjJ0bGJpST0i',
				},
				records: mockInsuranceFundSwapRecords,
			});
		});

		it('should handle errors when getting insurance fund swaps', async () => {
			// @ts-ignore
			mockGetInsuranceFundSwapRecords.mockRejectedValue(new Error('Database error'));

			const response = await app.inject({
				method: 'GET',
				url: '/stats/insuranceFundSwaps',
			});

			expect(response.statusCode).toBe(500);
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				error: 'Internal Server Error',
				message: 'Database error',
				statusCode: 500,
			});
		});
	});

	describe('GET /stats/markets', () => {
		it('should get market summary including UI status fields', async () => {
			mockGetMarketSummary.mockResolvedValue([
				{
					symbol: 'BTC-PERP',
					marketIndex: 2,
					marketType: 'perp',
					uiStatus: UiStatus.HIDDEN,
					baseAsset: 'BTC',
					quoteAsset: 'USDC',
				},
				{
					symbol: 'SOL-PERP',
					marketIndex: 1,
					marketType: 'perp',
					uiStatus: UiStatus.SCHEDULED_TO_HIDE,
					uiHideAtTs: 1772625600,
					baseAsset: 'SOL',
					quoteAsset: 'USDC',
				},
				{
					symbol: 'SOL/USDC',
					marketIndex: 0,
					marketType: 'spot',
					uiStatus: UiStatus.VISIBLE,
					baseAsset: 'SOL',
					quoteAsset: 'USDC',
				},
			]);

			const response = await app.inject({
				method: 'GET',
				url: '/stats/markets',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetMarketSummary).toHaveBeenCalled();

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				markets: [
					{
						symbol: 'SOL/USDC',
						marketIndex: 0,
						marketType: 'spot',
						uiStatus: UiStatus.VISIBLE,
						baseAsset: 'SOL',
						quoteAsset: 'USDC',
					},
					{
						symbol: 'SOL-PERP',
						marketIndex: 1,
						marketType: 'perp',
						uiStatus: UiStatus.SCHEDULED_TO_HIDE,
						uiHideAtTs: 1772625600,
						baseAsset: 'SOL',
						quoteAsset: 'USDC',
					},
					{
						symbol: 'BTC-PERP',
						marketIndex: 2,
						marketType: 'perp',
						uiStatus: UiStatus.HIDDEN,
						baseAsset: 'BTC',
						quoteAsset: 'USDC',
					},
				],
			});
		});
	});

	describe('GET /stats/markets/volume/:interval', () => {
		it('should get sorted market volume stats for 24h', async () => {
			const mockMarkets = [
				{
					symbol: 'ETH-PERP',
					quoteVolume: '500000',
					baseVolume: '300',
					marketIndex: 1,
					marketType: 'perp',
				},
				{
					symbol: 'BTC-PERP',
					quoteVolume: '1000000',
					baseVolume: '100',
					marketIndex: 0,
					marketType: 'perp',
				},
			];

			const mockData = {
				markets: mockMarkets,
				total: '1500000.000000',
			};

			const expectedSorted = [...mockMarkets].sort((a, b) => a.marketIndex - b.marketIndex);

			mockGetMarketsVolume.mockResolvedValue(mockData);

			const response = await app.inject({
				method: 'GET',
				url: `/stats/markets/volume/${VolumeInterval.TWENTY_FOUR_HOUR}`,
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetMarketsVolume).toHaveBeenCalledWith({
				interval: VolumeInterval.TWENTY_FOUR_HOUR,
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				total: '1500000.000000',
				markets: expectedSorted,
			});
		});

		it('should get sorted market volume stats for 1h', async () => {
			const mockMarkets = [
				{
					symbol: 'ETH-PERP',
					quoteVolume: '150000',
					baseVolume: '90',
					marketIndex: 1,
					marketType: 'perp',
				},
				{
					symbol: 'BTC-PERP',
					quoteVolume: '300000',
					baseVolume: '30',
					marketIndex: 0,
					marketType: 'perp',
				},
			];

			const mockData = {
				markets: mockMarkets,
				total: '450000.000000',
			};

			const expectedSorted = [...mockMarkets].sort((a, b) => a.marketIndex - b.marketIndex);

			mockGetMarketsVolume.mockResolvedValue(mockData);

			const response = await app.inject({
				method: 'GET',
				url: `/stats/markets/volume/${VolumeInterval.ONE_HOUR}`,
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetMarketsVolume).toHaveBeenCalledWith({
				interval: VolumeInterval.ONE_HOUR,
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				total: '450000.000000',
				markets: expectedSorted,
			});
		});

		it('should handle null response from cache for 24h', async () => {
			mockGetMarketsVolume.mockResolvedValue(null);

			const response = await app.inject({
				method: 'GET',
				url: `/stats/markets/volume/${VolumeInterval.TWENTY_FOUR_HOUR}`,
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetMarketsVolume).toHaveBeenCalledWith({
				interval: VolumeInterval.TWENTY_FOUR_HOUR,
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				total: undefined,
				markets: undefined,
			});
		});

		it('should handle empty markets array for 24h', async () => {
			const mockData = {
				markets: [],
				total: '0.000000',
			};

			mockGetMarketsVolume.mockResolvedValue(mockData);

			const response = await app.inject({
				method: 'GET',
				url: `/stats/markets/volume/${VolumeInterval.TWENTY_FOUR_HOUR}`,
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetMarketsVolume).toHaveBeenCalledWith({
				interval: VolumeInterval.TWENTY_FOUR_HOUR,
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				total: '0.000000',
				markets: [],
			});
		});

		it('should handle errors when getting 24h market volume stats', async () => {
			mockGetMarketsVolume.mockRejectedValue(new Error('Cache proxy error'));

			const response = await app.inject({
				method: 'GET',
				url: `/stats/markets/volume/${VolumeInterval.TWENTY_FOUR_HOUR}`,
			});

			expect(response.statusCode).toBe(500);
			expect(mockGetMarketsVolume).toHaveBeenCalledWith({
				interval: VolumeInterval.TWENTY_FOUR_HOUR,
			});
		});
	});

	describe('GET /volume (historical)', () => {
		it('returns aggregated volume data correctly', async () => {
			// Set up mock candles
			mockGetCandlesBetweenTimestampsForResolution.mockResolvedValue([
				{ baseVolume: '2', quoteVolume: '4.5' },
				{ baseVolume: '1', quoteVolume: '2.0' },
			]);

			const now = Math.floor(Date.now() / 1000);
			const oneHourAgo = now - 3600;

			const response = await app.inject({
				method: 'GET',
				url: `/stats/markets/volume?startTs=${oneHourAgo}&endTs=${now}`,
			});

			expect(response.statusCode).toBe(200);

			const payload = JSON.parse(response.payload);

			expect(payload.success).toBe(true);
			expect(payload.startTs).toBe(Math.floor(oneHourAgo / 3600) * 3600);
			expect(payload.endTs).toBe(Math.floor(now / 3600) * 3600);
			expect(payload.total).toBe('13.000000'); // 4.5 + 2.0 * 2 markets

			expect(payload.markets).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						symbol: 'SOL/USDC',
						marketIndex: 0,
						marketType: SerializedMarketFilter.SPOT,
						baseVolume: '3.000000', // 2 + 1
						quoteVolume: '6.500000', // 4.5 + 2.0
					}),
					expect.objectContaining({
						symbol: 'SOL-PERP',
						marketIndex: 1,
						marketType: SerializedMarketFilter.PERP,
						baseVolume: '3.000000', // same because mock returns same candles
						quoteVolume: '6.500000',
					}),
				])
			);
		});

		it('returns 400 for invalid time range', async () => {
			const now = Math.floor(Date.now() / 1000);

			const response = await app.inject({
				method: 'GET',
				url: `/stats/markets/volume?startTs=${now}&endTs=${now - 1}`,
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);
			expect(payload.success).toBe(false);
			expect(payload.error).toMatch(/startTs must be less than endTs/);
		});

		it('returns 400 for range over 24h', async () => {
			const now = Math.floor(Date.now() / 1000);
			const tooFar = now - 90500;

			const response = await app.inject({
				method: 'GET',
				url: `/stats/markets/volume?startTs=${tooFar}&endTs=${now}`,
			});

			expect(response.statusCode).toBe(400);
			expect(JSON.parse(response.payload).error).toMatch(
				/Time range must be between 1 and 24 hours/
			);
		});
	});

	describe('GET /stats/leaderboard', () => {
		it('should get paginated leaderboard data with default sort', async () => {
			const mockLeaderboard = [
				{ authority: 'auth1', volume: 1000, pnl: 500, rank: 1 },
				{ authority: 'auth2', volume: 800, pnl: 400, rank: 2 },
			];

			mockGetLeaderboard.mockResolvedValue(mockLeaderboard);

			const response = await app.inject({
				method: 'GET',
				url: '/stats/leaderboard',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetLeaderboard).toHaveBeenCalledWith({
				sort: 'pnl',
				page: 1,
				limit: 100,
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				data: {
					leaderboard: mockLeaderboard,
				},
			});
		});

		it('should support pagination and sorting', async () => {
			const mockLeaderboard = [{ authority: 'auth1', volume: 1000, pnl: 500, rank: 1 }];

			mockGetLeaderboard.mockResolvedValue(mockLeaderboard);

			const response = await app.inject({
				method: 'GET',
				url: '/stats/leaderboard?sort=volume&page=2&limit=50',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetLeaderboard).toHaveBeenCalledWith({
				sort: 'volume',
				page: 2,
				limit: 50,
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				data: {
					leaderboard: mockLeaderboard,
				},
			});
		});

		it('should handle errors when getting leaderboard', async () => {
			mockGetLeaderboard.mockRejectedValue(new Error('Leaderboard fetch failed'));

			const response = await app.inject({
				method: 'GET',
				url: '/stats/leaderboard',
			});

			expect(response.statusCode).toBe(500);
		});
	});

	describe('GET /stats/leaderboard/:authority', () => {
		it('should get leaderboard rank for a specific authority', async () => {
			const mockRankData = {
				pnl: 1000,
				volume: 2000,
				rank: {
					pnl: 1,
					volume: 2,
				},
			};

			mockGetLeaderboardRank.mockResolvedValue(mockRankData);

			const response = await app.inject({
				method: 'GET',
				url: '/stats/leaderboard/auth1',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetLeaderboardRank).toHaveBeenCalledWith({ authority: 'auth1' });

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				data: mockRankData,
			});
		});

		it('should handle errors when getting authority rank', async () => {
			mockGetLeaderboardRank.mockRejectedValue(new Error('Rank lookup failed'));

			const response = await app.inject({
				method: 'GET',
				url: '/stats/leaderboard/auth1',
			});

			expect(response.statusCode).toBe(500);
		});
	});

	describe('GET /stats/markets/prices', () => {
		it('should get 24-hour price change data for all markets', async () => {
			mockGetCandlesBetweenTimestampsForResolutionFromCache
				.mockResolvedValueOnce([{ fillClose: 150.5 }]) // SOL-PERP current
				.mockResolvedValueOnce([{ fillClose: 1.002 }]); // SOL/USDC current

			mockGetCandlesBetweenTimestampsForResolution
				.mockResolvedValueOnce([{ fillClose: 145.0 }]) // SOL-PERP 24h ago
				.mockResolvedValueOnce([{ fillClose: 0.998 }]); // SOL/USDC 24h ago

			const response = await app.inject({
				method: 'GET',
				url: '/stats/markets/prices',
			});

			expect(response.statusCode).toBe(200);

			const payload = JSON.parse(response.payload);

			expect(payload.success).toBe(true);
			expect(payload.markets).toHaveLength(2);

			// Check SOL-PERP data
			const solPerpData = payload.markets.find((m: any) => m.symbol === 'SOL-PERP');
			expect(solPerpData).toEqual({
				symbol: 'SOL-PERP',
				currentPrice: '150.5',
				price24hAgo: '145',
				priceChange: '5.500000', // 150.5 - 145.0
				priceChangePercent: '3.79', // ((150.5 - 145.0) / 145.0) * 100
				marketIndex: 1,
				marketType: 'perp',
			});

			const solSpotData = payload.markets.find((m: any) => m.symbol === 'SOL/USDC');
			expect(solSpotData).toEqual({
				symbol: 'SOL/USDC',
				currentPrice: '1.002',
				price24hAgo: '0.998',
				priceChange: '0.004000', // 1.002 - 0.998
				priceChangePercent: '0.40', // ((1.002 - 0.998) / 0.998) * 100
				marketIndex: 0,
				marketType: 'spot',
			});

			expect(mockGetCandlesBetweenTimestampsForResolutionFromCache).toHaveBeenCalledTimes(2);
			expect(mockGetCandlesBetweenTimestampsForResolution).toHaveBeenCalledTimes(2);
		});

		it('should handle missing current price data', async () => {
			mockGetCandlesBetweenTimestampsForResolutionFromCache
				.mockResolvedValueOnce([]) // SOL-PERP current (empty)
				.mockResolvedValueOnce([{ fillClose: 1.002 }]); // SOL/USDC current

			mockGetCandlesBetweenTimestampsForResolution
				.mockResolvedValueOnce([{ fillClose: 145.0 }]) // SOL-PERP 24h ago
				.mockResolvedValueOnce([{ fillClose: 0.998 }]); // SOL/USDC 24h ago

			const response = await app.inject({
				method: 'GET',
				url: '/stats/markets/prices',
			});

			expect(response.statusCode).toBe(200);

			const payload = JSON.parse(response.payload);
			const solPerpData = payload.markets.find((m: any) => m.symbol === 'SOL-PERP');

			expect(solPerpData).toEqual({
				symbol: 'SOL-PERP',
				currentPrice: '',
				price24hAgo: '145',
				priceChange: '',
				priceChangePercent: '',
				marketIndex: 1,
				marketType: 'perp',
			});
		});

		it('should handle missing 24h ago price data', async () => {
			// Mock scenario where 24h ago price is missing
			mockGetCandlesBetweenTimestampsForResolutionFromCache
				.mockResolvedValueOnce([{ fillClose: 150.5 }]) // SOL-PERP current
				.mockResolvedValueOnce([{ fillClose: 1.002 }]); // SOL/USDC current

			mockGetCandlesBetweenTimestampsForResolution
				.mockResolvedValueOnce([]) // SOL-PERP 24h ago (empty)
				.mockResolvedValueOnce([{ fillClose: 0.998 }]); // SOL/USDC 24h ago

			const response = await app.inject({
				method: 'GET',
				url: '/stats/markets/prices',
			});

			expect(response.statusCode).toBe(200);

			const payload = JSON.parse(response.payload);
			const solPerpData = payload.markets.find((m: any) => m.symbol === 'SOL-PERP');

			expect(solPerpData).toEqual({
				symbol: 'SOL-PERP',
				currentPrice: '150.5',
				price24hAgo: '',
				priceChange: '',
				priceChangePercent: '',
				marketIndex: 1,
				marketType: 'perp',
			});
		});

		it('should handle negative price changes', async () => {
			// Mock scenario with price decline
			mockGetCandlesBetweenTimestampsForResolutionFromCache
				.mockResolvedValueOnce([{ fillClose: 140.0 }]) // SOL-PERP current (lower)
				.mockResolvedValueOnce([{ fillClose: 1.002 }]); // SOL/USDC current

			mockGetCandlesBetweenTimestampsForResolution
				.mockResolvedValueOnce([{ fillClose: 150.0 }]) // SOL-PERP 24h ago (higher)
				.mockResolvedValueOnce([{ fillClose: 0.998 }]); // SOL/USDC 24h ago

			const response = await app.inject({
				method: 'GET',
				url: '/stats/markets/prices',
			});

			expect(response.statusCode).toBe(200);

			const payload = JSON.parse(response.payload);
			const solPerpData = payload.markets.find((m: any) => m.symbol === 'SOL-PERP');

			expect(solPerpData).toEqual({
				symbol: 'SOL-PERP',
				currentPrice: '140',
				price24hAgo: '150',
				priceChange: '-10.000000', // 140.0 - 150.0
				priceChangePercent: '-6.67', // ((140.0 - 150.0) / 150.0) * 100
				marketIndex: 1,
				marketType: 'perp',
			});
		});

		it('should handle errors when fetching candle data', async () => {
			mockGetCandlesBetweenTimestampsForResolutionFromCache.mockRejectedValue(
				new Error('Candle fetch failed')
			);

			const response = await app.inject({
				method: 'GET',
				url: '/stats/markets/prices',
			});

			expect(response.statusCode).toBe(500);
		});
	});

	describe('GET /stats/dlp/snapshots', () => {
		it('should return DLP snapshots for default 30 days', async () => {
			const mockSnapshots = [
				createMockPoolSnapshotRecord(),
				createMockPoolSnapshotRecord({
					ts: 1234567891,
					tvl: '2000000.500000',
					price: '1.500000',
				}),
			];

			mockGetSnapshotsBetweenTimestamps.mockResolvedValueOnce(mockSnapshots);

			const response = await app.inject({
				method: 'GET',
				url: '/stats/dlp/snapshots?days=30',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenCalledWith({
				entity: EntityTypes.Pool,
				id: 'ELgW8UwFRAUc7YpRMzJiuVVwSFmPHMW9knY6hBx9vRxa',
				recordType: RecordTypes.PoolSnapshotRecord,
				startTs: getTimestampDay({ days: -30 }),
				endTs: fixedTimestamp,
				frequency: 'daily',
			});

			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				snapshots: [
					{
						ts: 1234567890,
						tvl: '1234567.890000',
						price: '1.234567',
					},
					{
						ts: 1234567891,
						tvl: '2000000.500000',
						price: '1.500000',
					},
				],
			});
		});

		it('should return hourly DLP snapshots for days=1', async () => {
			const mockSnapshots = [
				createMockPoolSnapshotRecord({ isDaily: false }),
				createMockPoolSnapshotRecord({
					ts: 1234570890,
					tvl: '1235000.000000',
					price: '1.235000',
					isDaily: false,
				}),
			];

			mockGetSnapshotsBetweenTimestamps.mockResolvedValueOnce(mockSnapshots);

			const response = await app.inject({
				method: 'GET',
				url: '/stats/dlp/snapshots?days=1',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenCalledWith({
				entity: EntityTypes.Pool,
				id: 'ELgW8UwFRAUc7YpRMzJiuVVwSFmPHMW9knY6hBx9vRxa',
				recordType: RecordTypes.PoolSnapshotRecord,
				startTs: getTimestampDay({ days: -1 }),
				endTs: fixedTimestamp,
				frequency: 'hourly',
			});

			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				snapshots: [
					{
						ts: 1234567890,
						tvl: '1234567.890000',
						price: '1.234567',
					},
					{
						ts: 1234570890,
						tvl: '1235000.000000',
						price: '1.235000',
					},
				],
			});
		});

		it('should handle empty snapshots', async () => {
			mockGetSnapshotsBetweenTimestamps.mockResolvedValue([]);

			const response = await app.inject({
				method: 'GET',
				url: '/stats/dlp/snapshots',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenCalledWith({
				entity: EntityTypes.Pool,
				id: 'ELgW8UwFRAUc7YpRMzJiuVVwSFmPHMW9knY6hBx9vRxa',
				recordType: RecordTypes.PoolSnapshotRecord,
				startTs: getTimestampDay({ days: -7 }),
				endTs: fixedTimestamp,
				frequency: 'hourly',
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
				url: '/stats/dlp/snapshots',
			});

			expect(response.statusCode).toBe(500);
		});
	});
});
