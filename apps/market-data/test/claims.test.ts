import {
	ACCRUAL_CLAIM_CAMPAIGNS,
	aggregateClaimRows,
	buildOpeningPositionFeesQuery,
	setupClaimTasks,
	syncAccrualClaimCampaign,
} from '../src/tasks/claims';

const mockScheduleTask = jest.fn();
const mockAthenaQuery = jest.fn();
const mockUpsertAccrualClaimProgress = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
const mockIsFeatureEnabled = jest.fn().mockReturnValue(true);

jest.mock('@backend/common', () => ({
	isFeatureEnabled: (...args: any[]) => mockIsFeatureEnabled(...args),
	logger: {
		info: (...args: any[]) => mockLoggerInfo(...args),
		warn: (...args: any[]) => mockLoggerWarn(...args),
		error: (...args: any[]) => mockLoggerError(...args),
	},
}));

jest.mock('@backend/dynamodb', () => ({
	ClaimRepository: () => ({
		upsertAccrualClaimProgress: mockUpsertAccrualClaimProgress,
	}),
}));

jest.mock('@backend/athena', () => ({
	Athena: () => ({
		query: (...args: any[]) => mockAthenaQuery(...args),
	}),
	getTimePartition: jest.requireActual('@backend/athena').getTimePartition,
}));

describe('Claim Tasks', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockIsFeatureEnabled.mockReturnValue(true);
		process.env.CLAIMS_DRY_RUN = 'false';
	});

	it('registers the hardcoded claim sync tasks', () => {
		setupClaimTasks({
			scheduler: { scheduleTask: mockScheduleTask } as any,
		});

		const campaign = ACCRUAL_CLAIM_CAMPAIGNS[0];

		expect(mockScheduleTask).toHaveBeenCalledTimes(ACCRUAL_CLAIM_CAMPAIGNS.length);
		expect(mockScheduleTask).toHaveBeenCalledWith(
			`claim-accrual-sync-${campaign.campaignId}`,
			campaign.schedule,
			expect.any(Function),
			{ runImmediately: true }
		);
	});

	it('does not register claim tasks when the feature flag is disabled', () => {
		mockIsFeatureEnabled.mockReturnValue(false);

		setupClaimTasks({
			scheduler: { scheduleTask: mockScheduleTask } as any,
		});

		expect(mockScheduleTask).not.toHaveBeenCalled();
		expect(mockLoggerInfo).toHaveBeenCalledWith(
			'[CLAIM_SYNC] Claim tasks disabled because flag is not set'
		);
	});

	it('aggregates duplicate authority rows before syncing', () => {
		const aggregated = aggregateClaimRows({
			rows: [
				{ authorityId: 'auth-1', feesPaid: 4 },
				{ authorityId: 'auth-1', feesPaid: 6 },
				{ authorityId: 'auth-2', feesPaid: 1.5 },
			],
			authorityField: 'authorityId',
			feesField: 'feesPaid',
			campaignId: 'fees-rebate-v1',
		});

		expect(Array.from(aggregated.entries())).toEqual([
			['auth-1', 10],
			['auth-2', 1.5],
		]);
	});

	it('trims authority ids and skips malformed rows during aggregation', () => {
		const aggregated = aggregateClaimRows({
			rows: [
				{ authorityId: ' auth-1 ', feesPaid: 4 },
				{ authorityId: '', feesPaid: 4 },
				{ authorityId: 'auth-2', feesPaid: 'bad' },
			],
			authorityField: 'authorityId',
			feesField: 'feesPaid',
			campaignId: 'fees-rebate-v1',
		});

		expect(Array.from(aggregated.entries())).toEqual([['auth-1', 4]]);
		expect(mockLoggerWarn).toHaveBeenCalledTimes(2);
	});

	it('supports custom authority and fees fields during aggregation', () => {
		const aggregated = aggregateClaimRows({
			rows: [{ wallet: 'auth-1', totalFees: 3 }],
			authorityField: 'wallet',
			feesField: 'totalFees',
			campaignId: 'fees-rebate-v1',
		});

		expect(Array.from(aggregated.entries())).toEqual([['auth-1', 3]]);
	});

	it('builds the Athena query for claim fee aggregation from posthog order events', () => {
		const query = buildOpeningPositionFeesQuery({
			campaignStartTs: 1742428800,
			campaignEndTs: 1745107199,
			env: 'devnet',
		});

		expect(query).toContain('FROM "staging-archive".eventtype_posthogevent');
		expect(query).toContain("eventname = 'trade_placed'");
		expect(query).toContain('JOIN analytics_clean_trades_with_authority trades');
		expect(query).not.toContain('opening_new_poistion');
		expect(query).not.toContain('json_extract_scalar(event,');
		expect(query).toContain('$.event.properties.authority');
		expect(query).toContain('$.event.properties.next_order_id');
		expect(query).toContain('AS BIGINT) - 1 AS orderId');
		expect(query).not.toContain('$.properties.nextOrderId');
		expect(query).not.toContain('$.orderId');
		expect(query).not.toContain('$.orderid');
		expect(query).not.toContain('$.order_id');
		expect(query).toContain('$.event.properties.platform');
		expect(query).toContain("= 'web'");
		expect(query).toContain('$.event.properties.env');
		expect(query).toContain("= 'devnet'");
		expect(query).not.toContain('$.properties.is_successful');
		expect(query).toContain('trades.taker_authority = events.authorityId');
		expect(query).not.toContain('trades.maker_authority = events.authorityId');
		expect(query).toContain('GROUP BY authorityId');
	});

	it('uses the analytics clean trades table outside devnet', () => {
		const query = buildOpeningPositionFeesQuery({
			campaignStartTs: 1742428800,
			campaignEndTs: 1745107199,
			env: 'mainnet-beta',
		});

		expect(query).toContain('JOIN analytics_clean_trades_with_authority trades');
		expect(query).not.toContain('JOIN clean_trades_with_authority_devnet trades');
	});

	it('syncs aggregated claim progress from Athena rows', async () => {
		const campaign = ACCRUAL_CLAIM_CAMPAIGNS[0];

		mockAthenaQuery.mockResolvedValue([
			{ authorityId: 'auth-1', feesPaid: '4' },
			{ authorityId: 'auth-1', feesPaid: '6' },
			{ authorityId: 'auth-2', feesPaid: '15' },
		]);

		await syncAccrualClaimCampaign(campaign);

		expect(mockAthenaQuery).toHaveBeenCalledWith(campaign.query);
		expect(mockUpsertAccrualClaimProgress).toHaveBeenNthCalledWith(1, {
			authorityId: 'auth-1',
			campaignId: campaign.campaignId,
			amount: campaign.amount,
			assetSymbol: 'USDC',
			campaignStartTs: campaign.campaignStartTs,
			campaignEndTs: campaign.campaignEndTs,
			progressAmount: 10,
			progressCap: campaign.progressCap,
		});
		expect(mockUpsertAccrualClaimProgress).toHaveBeenNthCalledWith(2, {
			authorityId: 'auth-2',
			campaignId: campaign.campaignId,
			amount: campaign.amount,
			assetSymbol: 'USDC',
			campaignStartTs: campaign.campaignStartTs,
			campaignEndTs: campaign.campaignEndTs,
			progressAmount: 15,
			progressCap: campaign.progressCap,
		});
		expect(mockLoggerInfo).toHaveBeenCalledWith(
			`[CLAIM_SYNC:${campaign.campaignId}] Synced 2 claim records`
		);
	});

	it('does not create claim records when claims dry run is enabled by default', async () => {
		delete process.env.CLAIMS_DRY_RUN;
		mockAthenaQuery.mockResolvedValue([
			{ authorityId: 'auth-1', feesPaid: '4' },
			{ authorityId: 'auth-2', feesPaid: '6' },
		]);

		await syncAccrualClaimCampaign(ACCRUAL_CLAIM_CAMPAIGNS[0]);

		expect(mockAthenaQuery).toHaveBeenCalledWith(ACCRUAL_CLAIM_CAMPAIGNS[0].query);
		expect(mockUpsertAccrualClaimProgress).not.toHaveBeenCalled();
		expect(mockLoggerInfo).toHaveBeenCalledWith(
			`[CLAIM_SYNC:${ACCRUAL_CLAIM_CAMPAIGNS[0].campaignId}] Dry run enabled; would upsert 2 claim records`
		);
		expect(mockLoggerInfo).toHaveBeenCalledWith(
			`[CLAIM_SYNC:${
				ACCRUAL_CLAIM_CAMPAIGNS[0].campaignId
			}] Dry run claim records: ${JSON.stringify([
				{ authorityId: 'auth-1', progressAmount: 4 },
				{ authorityId: 'auth-2', progressAmount: 6 },
			])}`
		);
	});

	it('throws when one or more claim upserts fail', async () => {
		const campaign = ACCRUAL_CLAIM_CAMPAIGNS[0];

		mockAthenaQuery.mockResolvedValue([
			{ authorityId: 'auth-1', feesPaid: '4' },
			{ authorityId: 'auth-2', feesPaid: '6' },
		]);
		mockUpsertAccrualClaimProgress
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('dynamo failed'));

		await expect(syncAccrualClaimCampaign(campaign)).rejects.toThrow(
			`[CLAIM_SYNC:${campaign.campaignId}] Failed 1 of 2 claim upserts`
		);

		expect(mockLoggerError).toHaveBeenCalledWith(
			`[CLAIM_SYNC:${campaign.campaignId}] Failed claim upsert: dynamo failed`
		);
	});

	it('does not upsert anything when the query returns no valid rows', async () => {
		const campaign = ACCRUAL_CLAIM_CAMPAIGNS[0];

		mockAthenaQuery.mockResolvedValue([
			{ authorityId: '', feesPaid: 4 },
			{ authorityId: 'auth-1', feesPaid: 'bad' },
		]);

		await syncAccrualClaimCampaign(campaign);

		expect(mockUpsertAccrualClaimProgress).not.toHaveBeenCalled();
		expect(mockLoggerInfo).toHaveBeenCalledWith(
			`[CLAIM_SYNC:${campaign.campaignId}] Synced 0 claim records`
		);
	});
});
