import { EntityTypes, getTimestampDay, RecordTypes } from '@backend/common';
import Fastify, { FastifyInstance } from 'fastify';
import Pagination from '../../src/plugins/pagination';
import RuntimeTransformer from '../../src/plugins/runtime-transformer';
import Authority from '../../src/routes/authority';
import { fetchArchiveData } from '../../src/utils/fetch-archive-data';
import {
	createMockEarnSnapshotRecord,
	createMockInsuranceFundStakeRecord,
	createMockLPMintRedeemRecord,
	createMockReferralSnapshotRecord,
	createMockTradingSnapshotRecord,
	createMockVaultDepositorSnapshotRecord,
} from '../mockRecords';

const mockGetInsuranceFundStakeRecords = jest.fn();
const mockGetInsuranceFundStakeRecordsBetweenTimestamps = jest.fn();
const mockGetSnapshotsBetweenTimestamps = jest.fn();
const mockGetPreviousSnapshot = jest.fn();
const mockGetLPMintRedeemRecords = jest.fn();
const mockGetLPMintRedeemRecordsBetweenTimestamps = jest.fn();

const fixedTimestamp = 1234567890;
jest.mock('@backend/common', () => ({
	...jest.requireActual('@backend/common'),
	getTimestamp: jest.fn(({ days } = {}) =>
		days ? fixedTimestamp + days * 86400 : fixedTimestamp
	),
	getTimestampDay: jest.fn(({ days }) => fixedTimestamp + days * 86400),
	getTimestampHour: jest.fn(({ days }) =>
		days ? fixedTimestamp + days * 86400 : fixedTimestamp
	),
}));

jest.mock('@backend/dynamodb', () => ({
	InsuranceFundStakeRepository: jest.fn(() => ({
		getInsuranceFundStakeRecords: mockGetInsuranceFundStakeRecords,
		getInsuranceFundStakeRecordsBetweenTimestamps:
			mockGetInsuranceFundStakeRecordsBetweenTimestamps,
	})),
	SnapshotRepository: jest.fn(() => ({
		getSnapshotsBetweenTimestamps: mockGetSnapshotsBetweenTimestamps,
		getPreviousSnapshot: mockGetPreviousSnapshot,
	})),
	PoolRepository: jest.fn(() => ({
		getLPMintRedeemRecords: mockGetLPMintRedeemRecords,
		getLPMintRedeemRecordsBetweenTimestamps: mockGetLPMintRedeemRecordsBetweenTimestamps,
	})),
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

describe('Authority Routes', () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		app = Fastify();
		await app.register(Pagination);
		await app.register(RuntimeTransformer);
		await app.register(Authority, { prefix: '/authority' });
		await app.ready();
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	describe('GET /authority/:authorityId/insuranceFundStake', () => {
		it('should return insurance fund stake records for a given authority ID', async () => {
			const mockRecords = [
				createMockInsuranceFundStakeRecord({ userAuthority: 'auth1' }),
				createMockInsuranceFundStakeRecord({ userAuthority: 'auth1', amount: 2000 }),
			];
			const mockMeta = { nextPage: 'someToken' };
			mockGetInsuranceFundStakeRecords.mockResolvedValue({
				records: mockRecords,
				meta: mockMeta,
			});

			const response = await app.inject({
				method: 'GET',
				url: '/authority/auth1/insuranceFundStake',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetInsuranceFundStakeRecords).toHaveBeenCalledWith({
				id: 'auth1',
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
						userAuthority: 'auth1',
						action: 'stake',
						marketIndex: 0,
						ifSharesBefore: '500.000000',
						ifSharesAfter: '600.000000',
						userIfSharesBefore: '100.000000',
						userIfSharesAfter: '200.000000',
						totalIfSharesBefore: '1000.000000',
						totalIfSharesAfter: '1100.000000',
						symbol: 'SOL-PERP',
						insuranceVaultAmountBefore: '10000.000000',
					},
					{
						ts: 1234567890,
						txSig: 'mock-tx-sig',
						txSigIndex: 1,
						slot: 100000,
						amount: '2000.000000',
						userAuthority: 'auth1',
						action: 'stake',
						marketIndex: 0,
						ifSharesBefore: '500.000000',
						ifSharesAfter: '600.000000',
						userIfSharesBefore: '100.000000',
						userIfSharesAfter: '200.000000',
						totalIfSharesBefore: '1000.000000',
						totalIfSharesAfter: '1100.000000',
						insuranceVaultAmountBefore: '10000.000000',
						symbol: 'SOL-PERP',
					},
				],
				meta: expect.objectContaining({
					nextPage: expect.any(String),
				}),
			});
		});

		it('should handle pagination for insurance fund stake records', async () => {
			const lastEvaluatedKey = { pk: 'USER#testAccount', sk: 'DEPOSIT#TS#1234567890' };
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');
			const mockRecords = [
				createMockInsuranceFundStakeRecord({ userAuthority: 'auth1', amount: 3000 }),
			];
			const mockMeta = { nextPage: null };
			mockGetInsuranceFundStakeRecords.mockResolvedValue({
				records: mockRecords,
				meta: mockMeta,
			});

			const response = await app.inject({
				method: 'GET',
				url: `/authority/auth1/insuranceFundStake?page=${encodedToken}`,
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetInsuranceFundStakeRecords).toHaveBeenCalledWith({
				id: 'auth1',
				page: expect.any(Object),
			});
		});
	});

	describe('GET /authority/:authorityId/insuranceFundStake/:year/:month', () => {
		it('should return archived insurance fund stake records for a given authority ID, year, and month', async () => {
			const mockRecords = [
				createMockInsuranceFundStakeRecord({ userAuthority: 'auth1', amount: 4000 }),
			];
			const mockResult = {
				success: true,
				records: mockRecords,
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
				url: '/authority/auth1/insuranceFundStake/2024/6',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'auth1',
				year: 2024,
				month: 6,
				page: 1,
				entity: EntityTypes.Authority,
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
						amount: '4000.000000',
						userAuthority: 'auth1',
						action: 'stake',
						marketIndex: 0,
						ifSharesBefore: '500.000000',
						ifSharesAfter: '600.000000',
						userIfSharesBefore: '100.000000',
						userIfSharesAfter: '200.000000',
						totalIfSharesBefore: '1000.000000',
						totalIfSharesAfter: '1100.000000',
						insuranceVaultAmountBefore: '10000.000000',
						symbol: 'SOL-PERP',
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

		it('should handle pagination for archived insurance fund stake records', async () => {
			const mockRecords = [
				createMockInsuranceFundStakeRecord({ userAuthority: 'auth1', amount: 4000 }),
			];

			const mockResult = {
				success: true,
				records: mockRecords,
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
				url: '/authority/auth1/insuranceFundStake/2024/6?page=2',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'auth1',
				year: 2024,
				month: 6,
				page: 2,
				entity: EntityTypes.Authority,
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
						amount: '4000.000000',
						userAuthority: 'auth1',
						action: 'stake',
						marketIndex: 0,
						ifSharesBefore: '500.000000',
						ifSharesAfter: '600.000000',
						userIfSharesBefore: '100.000000',
						userIfSharesAfter: '200.000000',
						totalIfSharesBefore: '1000.000000',
						totalIfSharesAfter: '1100.000000',
						insuranceVaultAmountBefore: '10000.000000',
						symbol: 'SOL-PERP',
					},
				],
				meta: { records: 1, totalRecords: 3, currentPage: 2, totalPages: 3, nextPage: 3 },
			});
		});
	});

	describe('GET /authority/:authorityId/lpMintRedeem', () => {
		it('should return LP mint/redeem records for a given authority ID', async () => {
			const mockRecords = [
				createMockLPMintRedeemRecord({ authority: 'auth1' }),
				createMockLPMintRedeemRecord({ authority: 'auth1', amount: 2 }),
			];
			const mockMeta = { nextPage: 'someToken' };
			mockGetLPMintRedeemRecords.mockResolvedValue({
				records: mockRecords,
				meta: mockMeta,
			});

			const response = await app.inject({
				method: 'GET',
				url: '/authority/auth1/lpMintRedeem',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetLPMintRedeemRecords).toHaveBeenCalledWith({
				id: 'auth1',
				page: undefined,
			});
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				records: [
					{
						amount: '1.000000000',
						authority: 'auth1',
						constituentIndex: 1,
						description: 1,
						fee: '0.000090',
						inMarketCurrentWeight: '0.000283',
						inMarketTargetWeight: '-0.000240',
						lastAum: '32.641738',
						lastAumSlot: 379450944,
						lpAmount: '0.000017194',
						lpFee: '0.000005',
						lpPool: 'ELgW8UwFRAUc7YpRMzJiuVVwSFmPHMW9knY6hBx9vRxa',
						lpPrice: '0.000909',
						mint: 'So11111111111111111111111111111111111111112',
						mintRedeemId: '6',
						oraclePrice: '0.156510',
						slot: 379450944,
						spotMarketIndex: 1,
						ts: 1762893737,
						txSig: 'dq1jUnV1fKdnnrM9n4nuXDD6TUirs5FMdsDsH2c6FdmXTBdEugEmmnuxAFf9GGz5zdimPYDNhEu2vtMMhqBCmC6',
						txSigIndex: 1,
					},
					{
						amount: '2.000000000',
						authority: 'auth1',
						constituentIndex: 1,
						description: 1,
						fee: '0.000090',
						inMarketCurrentWeight: '0.000283',
						inMarketTargetWeight: '-0.000240',
						lastAum: '32.641738',
						lastAumSlot: 379450944,
						lpAmount: '0.000017194',
						lpFee: '0.000005',
						lpPool: 'ELgW8UwFRAUc7YpRMzJiuVVwSFmPHMW9knY6hBx9vRxa',
						lpPrice: '0.000909',
						mint: 'So11111111111111111111111111111111111111112',
						mintRedeemId: '6',
						oraclePrice: '0.156510',
						slot: 379450944,
						spotMarketIndex: 1,
						ts: 1762893737,
						txSig: 'dq1jUnV1fKdnnrM9n4nuXDD6TUirs5FMdsDsH2c6FdmXTBdEugEmmnuxAFf9GGz5zdimPYDNhEu2vtMMhqBCmC6',
						txSigIndex: 1,
					},
				],
				meta: expect.objectContaining({
					nextPage: expect.any(String),
				}),
			});
		});

		it('should handle pagination for LP mint/redeem records', async () => {
			const lastEvaluatedKey = {
				pk: 'AUTHORITY#testAuthority',
				sk: 'LP_MINT_REDEEM#TS#1762893737',
			};
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');
			const mockRecords = [createMockLPMintRedeemRecord({ authority: 'auth1', amount: 3 })];
			const mockMeta = { nextPage: null };
			mockGetLPMintRedeemRecords.mockResolvedValue({
				records: mockRecords,
				meta: mockMeta,
			});

			const response = await app.inject({
				method: 'GET',
				url: `/authority/auth1/lpMintRedeem?page=${encodedToken}`,
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetLPMintRedeemRecords).toHaveBeenCalledWith({
				id: 'auth1',
				page: expect.any(Object),
			});
		});
	});

	describe('GET /authority/:authorityId/lpMintRedeem/:year/:month', () => {
		it('should return archived LP mint/redeem records for a given authority ID, year, and month', async () => {
			const mockRecords = [createMockLPMintRedeemRecord({ authority: 'auth1', amount: 4 })];
			const mockResult = {
				success: true,
				records: mockRecords,
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
				url: '/authority/auth1/lpMintRedeem/2024/6',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'auth1',
				year: 2024,
				month: 6,
				page: 1,
				entity: EntityTypes.Authority,
				recordType: RecordTypes.LPMintRedeemRecord,
				getLatestRecords: expect.any(Function),
			});
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						amount: '4.000000000',
						authority: 'auth1',
						constituentIndex: 1,
						description: 1,
						fee: '0.000090',
						inMarketCurrentWeight: '0.000283',
						inMarketTargetWeight: '-0.000240',
						lastAum: '32.641738',
						lastAumSlot: 379450944,
						lpAmount: '0.000017194',
						lpFee: '0.000005',
						lpPool: 'ELgW8UwFRAUc7YpRMzJiuVVwSFmPHMW9knY6hBx9vRxa',
						lpPrice: '0.000909',
						mint: 'So11111111111111111111111111111111111111112',
						mintRedeemId: '6',
						oraclePrice: '0.156510',
						slot: 379450944,
						spotMarketIndex: 1,
						ts: 1762893737,
						txSig: 'dq1jUnV1fKdnnrM9n4nuXDD6TUirs5FMdsDsH2c6FdmXTBdEugEmmnuxAFf9GGz5zdimPYDNhEu2vtMMhqBCmC6',
						txSigIndex: 1,
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

		it('should handle pagination for archived LP mint/redeem records', async () => {
			const mockRecords = [createMockLPMintRedeemRecord({ authority: 'auth1', amount: 4 })];

			const mockResult = {
				success: true,
				records: mockRecords,
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
				url: '/authority/auth1/lpMintRedeem/2024/6?page=2',
			});

			expect(response.statusCode).toBe(200);
			expect(fetchArchiveData).toHaveBeenCalledWith({
				id: 'auth1',
				year: 2024,
				month: 6,
				page: 2,
				entity: EntityTypes.Authority,
				recordType: RecordTypes.LPMintRedeemRecord,
				getLatestRecords: expect.any(Function),
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: [
					{
						amount: '4.000000000',
						authority: 'auth1',
						constituentIndex: 1,
						description: 1,
						fee: '0.000090',
						inMarketCurrentWeight: '0.000283',
						inMarketTargetWeight: '-0.000240',
						lastAum: '32.641738',
						lastAumSlot: 379450944,
						lpAmount: '0.000017194',
						lpFee: '0.000005',
						lpPool: 'ELgW8UwFRAUc7YpRMzJiuVVwSFmPHMW9knY6hBx9vRxa',
						lpPrice: '0.000909',
						mint: 'So11111111111111111111111111111111111111112',
						mintRedeemId: '6',
						oraclePrice: '0.156510',
						slot: 379450944,
						spotMarketIndex: 1,
						ts: 1762893737,
						txSig: 'dq1jUnV1fKdnnrM9n4nuXDD6TUirs5FMdsDsH2c6FdmXTBdEugEmmnuxAFf9GGz5zdimPYDNhEu2vtMMhqBCmC6',
						txSigIndex: 1,
					},
				],
				meta: { records: 1, totalRecords: 3, currentPage: 2, totalPages: 3, nextPage: 3 },
			});
		});
	});

	describe('GET /authority/:authorityId/snapshots/overview', () => {
		it('should return snapshots with daily changes for a given authority ID', async () => {
			const mockTradingSnapshots = [
				createMockTradingSnapshotRecord({
					authority: 'auth1',
				}),
				createMockTradingSnapshotRecord({
					authority: 'auth1',
					user: 'user-2',
				}),
			];
			const mockEarnSnapshots = [
				createMockEarnSnapshotRecord({
					authority: 'auth1',
					totalAccountValue: 1000,
				}),
				createMockEarnSnapshotRecord({
					authority: 'auth1',
					user: 'user-2',
					totalAccountValue: 2000,
				}),
			];
			const mockVaultSnapshots = [
				createMockVaultDepositorSnapshotRecord({
					authority: 'auth1',
					totalAccountValue: 1000,
				}),
				createMockVaultDepositorSnapshotRecord({
					authority: 'auth1',
					user: 'user-2',
					totalAccountValue: 2000,
				}),
			];

			// Setup mock responses
			mockGetSnapshotsBetweenTimestamps
				.mockResolvedValueOnce(mockTradingSnapshots)
				.mockResolvedValueOnce(mockEarnSnapshots)
				.mockResolvedValueOnce(mockVaultSnapshots);

			mockGetUserVolumeAndFees
				.mockResolvedValueOnce({
					cumulativeMakerVolume: 1,
					cumulativeTakerVolume: 2,
					cumulativeFeePaid: 3,
					cumulativeFeeRebate: 4,
				})
				.mockResolvedValueOnce({
					cumulativeMakerVolume: 5,
					cumulativeTakerVolume: 6,
					cumulativeFeePaid: 7,
					cumulativeFeeRebate: 8,
				});

			const response = await app.inject({
				method: 'GET',
				url: '/authority/auth1/snapshots/overview',
			});

			expect(response.statusCode).toBe(200);

			// Check calls to getSnapshotsBetweenTimestamps for main data
			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenNthCalledWith(1, {
				entity: EntityTypes.Authority,
				id: 'auth1',
				recordType: RecordTypes.TradeSnapshotRecord,
				startTs: getTimestampDay({ days: -7 }),
				endTs: fixedTimestamp,
				frequency: 'daily',
			});

			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenNthCalledWith(2, {
				entity: EntityTypes.Authority,
				id: 'auth1',
				recordType: RecordTypes.EarnSnapshotRecord,
				startTs: getTimestampDay({ days: -7 }),
				endTs: fixedTimestamp,
				frequency: 'daily',
			});

			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenNthCalledWith(3, {
				entity: EntityTypes.Authority,
				id: 'auth1',
				recordType: RecordTypes.VaultDepositorSnapshotRecord,
				startTs: getTimestampDay({ days: -7 }),
				endTs: fixedTimestamp,
				frequency: 'daily',
			});

			// Verify payload structure
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				products: {
					trade: [
						{
							accountId: 'mock-user',
							snapshots: [{ ts: 1234567890, unrealizedPnl: '123.120000' }],
							metrics: {
								cumulativeMakerVolume: '1.000000',
								cumulativeTakerVolume: '2.000000',
								cumulativeFeePaid: '3.000000',
								cumulativeFeeRebate: '4.000000',
							},
						},
						{
							accountId: 'user-2',
							snapshots: [{ ts: 1234567890, unrealizedPnl: '123.120000' }],
							metrics: {
								cumulativeMakerVolume: '5.000000',
								cumulativeTakerVolume: '6.000000',
								cumulativeFeePaid: '7.000000',
								cumulativeFeeRebate: '8.000000',
							},
						},
					],
					earn: [
						{
							accountId: 'mock-user',
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
							],
						},
						{
							accountId: 'user-2',
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
							],
						},
					],
					vaults: [
						{
							accountId: 'mock-user',
							snapshots: [
								{
									ts: 1234567890,
									vault: 'vault',
									totalAccountValue: '1000.000000',
									totalAccountBaseValue: '10.000000',
									marketIndex: 0,
								},
							],
						},
						{
							accountId: 'user-2',
							snapshots: [
								{
									ts: 1234567890,
									vault: 'vault',
									totalAccountValue: '2000.000000',
									totalAccountBaseValue: '10.000000',
									marketIndex: 0,
								},
							],
						},
					],
				},
			});
		});

		it('should handle empty snapshots', async () => {
			mockGetSnapshotsBetweenTimestamps.mockResolvedValue(undefined);

			const response = await app.inject({
				method: 'GET',
				url: '/authority/auth1/snapshots/overview',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenCalledTimes(3);

			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				products: {
					trade: [],
					earn: [],
					vaults: [],
				},
			});
		});

		it('should handle errors from snapshot repository', async () => {
			mockGetSnapshotsBetweenTimestamps.mockRejectedValue(new Error('Database error'));

			const response = await app.inject({
				method: 'GET',
				url: '/authority/auth1/snapshots/overview',
			});

			expect(response.statusCode).toBe(500);
		});
	});

	describe('GET /authority/:authorityId/snapshots/trading', () => {
		it('should return trading snapshots with daily changes', async () => {
			const mockSnapshots = [
				createMockTradingSnapshotRecord(),
				createMockTradingSnapshotRecord({ user: 'user-2' }),
			];

			mockGetSnapshotsBetweenTimestamps.mockResolvedValueOnce(mockSnapshots);

			mockGetUserVolumeAndFees
				.mockResolvedValueOnce({
					cumulativeMakerVolume: 1,
					cumulativeTakerVolume: 2,
					cumulativeFeePaid: 3,
					cumulativeFeeRebate: 4,
				})
				.mockResolvedValueOnce({
					cumulativeMakerVolume: 5,
					cumulativeTakerVolume: 6,
					cumulativeFeePaid: 7,
					cumulativeFeeRebate: 8,
				});

			const response = await app.inject({
				method: 'GET',
				url: '/authority/auth1/snapshots/trading',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenNthCalledWith(1, {
				entity: EntityTypes.Authority,
				id: 'auth1',
				recordType: RecordTypes.TradeSnapshotRecord,
				startTs: getTimestampDay({ days: -7 }),
				endTs: fixedTimestamp,
				frequency: 'daily',
			});

			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				accounts: [
					{
						accountId: 'mock-user',
						snapshots: [{ ts: 1234567890, unrealizedPnl: '123.120000' }],
						metrics: {
							cumulativeMakerVolume: '1.000000',
							cumulativeTakerVolume: '2.000000',
							cumulativeFeePaid: '3.000000',
							cumulativeFeeRebate: '4.000000',
						},
					},
					{
						accountId: 'user-2',
						snapshots: [{ ts: 1234567890, unrealizedPnl: '123.120000' }],
						metrics: {
							cumulativeMakerVolume: '5.000000',
							cumulativeTakerVolume: '6.000000',
							cumulativeFeePaid: '7.000000',
							cumulativeFeeRebate: '8.000000',
						},
					},
				],
			});
		});

		it('should handle empty snapshots', async () => {
			mockGetSnapshotsBetweenTimestamps.mockResolvedValue(undefined);

			const response = await app.inject({
				method: 'GET',
				url: '/authority/auth1/snapshots/trading',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenCalledWith({
				entity: EntityTypes.Authority,
				id: 'auth1',
				recordType: RecordTypes.TradeSnapshotRecord,
				startTs: getTimestampDay({ days: -7 }),
				endTs: fixedTimestamp,
				frequency: 'daily',
			});

			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				accounts: [],
			});
		});
	});

	describe('GET /authority/:authorityId/snapshots/earn', () => {
		it('should return earn snapshots with daily changes', async () => {
			const mockSnapshots = [
				createMockEarnSnapshotRecord(),
				createMockEarnSnapshotRecord({ user: 'user-2' }),
			];

			mockGetSnapshotsBetweenTimestamps.mockResolvedValueOnce(mockSnapshots);

			const response = await app.inject({
				method: 'GET',
				url: '/authority/auth1/snapshots/earn',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenCalledWith({
				entity: EntityTypes.Authority,
				id: 'auth1',
				recordType: RecordTypes.EarnSnapshotRecord,
				startTs: getTimestampDay({ days: -7 }),
				endTs: fixedTimestamp,
				frequency: 'daily',
			});

			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				accounts: [
					{
						accountId: 'mock-user',
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
						],
					},
					{
						accountId: 'user-2',
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
						],
					},
				],
			});
		});

		it('should handle empty snapshots', async () => {
			mockGetSnapshotsBetweenTimestamps.mockResolvedValue(undefined);

			const response = await app.inject({
				method: 'GET',
				url: '/authority/auth1/snapshots/earn',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenCalledWith({
				entity: EntityTypes.Authority,
				id: 'auth1',
				recordType: RecordTypes.EarnSnapshotRecord,
				startTs: getTimestampDay({ days: -7 }),
				endTs: fixedTimestamp,
				frequency: 'daily',
			});

			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				accounts: [],
			});
		});
	});

	describe('GET /authority/:authorityId/snapshots/vaults', () => {
		it('should return vault snapshots with daily changes', async () => {
			const mockSnapshots = [
				createMockVaultDepositorSnapshotRecord({
					authority: 'auth1',
					totalAccountValue: 1000,
				}),
				createMockVaultDepositorSnapshotRecord({
					authority: 'auth1',
					user: 'user-2',
					totalAccountValue: 2000,
				}),
			];

			mockGetSnapshotsBetweenTimestamps.mockResolvedValueOnce(mockSnapshots);

			const response = await app.inject({
				method: 'GET',
				url: '/authority/auth1/snapshots/vaults',
			});

			expect(response.statusCode).toBe(200);

			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				accounts: [
					{
						accountId: 'mock-user',
						snapshots: [
							{
								ts: 1234567890,
								vault: 'vault',
								totalAccountValue: '1000.000000',
								totalAccountBaseValue: '10.000000',
								marketIndex: 0,
							},
						],
					},
					{
						accountId: 'user-2',
						snapshots: [
							{
								ts: 1234567890,
								vault: 'vault',
								totalAccountValue: '2000.000000',
								totalAccountBaseValue: '10.000000',
								marketIndex: 0,
							},
						],
					},
				],
			});
		});

		it('should handle empty snapshots', async () => {
			mockGetSnapshotsBetweenTimestamps.mockResolvedValue(undefined);

			const response = await app.inject({
				method: 'GET',
				url: '/authority/auth1/snapshots/vaults',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenCalledWith({
				entity: EntityTypes.Authority,
				id: 'auth1',
				recordType: RecordTypes.VaultDepositorSnapshotRecord,
				startTs: getTimestampDay({ days: -7 }),
				endTs: fixedTimestamp,
				frequency: 'daily',
			});

			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				accounts: [],
			});
		});
	});

	describe('GET /authority/:authorityId/snapshots/referrals', () => {
		it('should return referral snapshots', async () => {
			const mockSnapshots = [createMockReferralSnapshotRecord()];
			mockGetSnapshotsBetweenTimestamps.mockResolvedValueOnce(mockSnapshots);

			const response = await app.inject({
				method: 'GET',
				url: '/authority/auth1/snapshots/referrals',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenCalledWith({
				entity: EntityTypes.Authority,
				id: 'auth1',
				recordType: RecordTypes.ReferralSnapshotRecord,
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
						referralCount: '1',
						referralRewards: '123.123',
						referredVolume30D: '123.123123123',
						referredUsers: ['1233112', '123123'],
					},
				],
			});
		});

		it('should handle empty snapshots', async () => {
			mockGetSnapshotsBetweenTimestamps.mockResolvedValueOnce([]);

			const response = await app.inject({
				method: 'GET',
				url: '/authority/auth1/snapshots/referrals',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetSnapshotsBetweenTimestamps).toHaveBeenCalledWith({
				entity: EntityTypes.Authority,
				id: 'auth1',
				recordType: RecordTypes.ReferralSnapshotRecord,
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
	});
});
