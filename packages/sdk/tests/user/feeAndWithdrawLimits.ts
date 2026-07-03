import {
	BN,
	ZERO,
	User,
	MarketType,
	SpotBalanceType,
	ReferrerStatus,
	UserStatsAccount,
	SPOT_MARKET_BALANCE_PRECISION,
} from '../../src';
import { assert } from '../../src/assert/assert';
import { mockPerpMarkets, mockSpotMarkets } from '../dlob/helpers';
import {
	mockUserAccount as baseMockUserAccount,
	makeMockUser,
} from './helpers';
import * as _ from 'lodash';

const mockFeeTier = {
	feeNumerator: 1,
	feeDenominator: 1000,
	makerRebateNumerator: 0,
	makerRebateDenominator: 1000,
	referrerRewardNumerator: 0,
	referrerRewardDenominator: 100,
	refereeFeeNumerator: 25,
	refereeFeeDenominator: 100,
};

const mockFeeStructure = {
	feeTiers: Array.from({ length: 6 }, () => ({ ...mockFeeTier })),
	fillerRewardStructure: {
		rewardNumerator: 0,
		rewardDenominator: 1,
		timeBasedRewardLowerBound: ZERO,
	},
	flatFillerFee: ZERO,
	ammFeeNumerator: 0,
	ifFeeNumerator: 0,
};

const mockUserStatsAccount: UserStatsAccount = {
	numberOfSubAccounts: 1,
	numberOfSubAccountsCreated: 1,
	makerVolume30D: ZERO,
	takerVolume30D: ZERO,
	fillerVolume30D: ZERO,
	lastMakerVolume30DTs: ZERO,
	lastTakerVolume30DTs: ZERO,
	lastFillerVolume30DTs: ZERO,
	fees: {
		totalFeePaid: ZERO,
		totalFeeRebate: ZERO,
		totalTokenDiscount: ZERO,
		totalRefereeDiscount: ZERO,
	},
	referrer: undefined as any,
	referrerStatus: 0,
	disableUpdatePerpBidAskTwap: 0,
	pausedOperations: 0,
	authority: undefined as any,
	ifStakedQuoteAssetAmount: ZERO,
	delegatePermissions: 0,
};

async function makeFeeMockUser(referrerStatus: number): Promise<User> {
	const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
	const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);
	const myMockUserAccount = _.cloneDeep(baseMockUserAccount);

	const user = await makeMockUser(
		myMockPerpMarkets,
		myMockSpotMarkets,
		myMockUserAccount,
		[1, 1, 1, 1, 1, 1, 1, 1],
		[1, 1, 1, 1, 1, 1, 1, 1]
	);

	user.velocityClient.getStateAccount = () =>
		({
			perpFeeStructure: mockFeeStructure,
			spotFeeStructure: mockFeeStructure,
		}) as any;

	const userStatsAccount = {
		..._.cloneDeep(mockUserStatsAccount),
		referrerStatus,
	};
	user.velocityClient.getUserStatsOrThrow = () =>
		({
			getAccountOrThrow: () => userStatsAccount,
		}) as any;
	// getMarketFees reads referee status via getUserStats()?.getAccount()
	user.velocityClient.getUserStats = () =>
		({
			getAccount: () => userStatsAccount,
		}) as any;
	// getMarketFees(marketIndex) reads the market's feeAdjustment
	user.velocityClient.getPerpMarketAccountOrThrow = () =>
		({
			marketIndex: 0,
			feeAdjustment: 0,
		}) as any;

	return user;
}

describe('User fee calculation', () => {
	it('taker fee for a non-market-index quote amount rounds up (ceil)', async () => {
		const user = await makeFeeMockUser(0);

		// 1_000_007 * 1 / 1000 = 1000.007 -> ceil = 1001, floor would be 1000
		const fee = user.calculatePerpTakerFee(new BN(1_000_007));
		assert(
			fee.eq(new BN(1001)),
			`expected ceil-rounded fee of 1001, got ${fee.toString()}`
		);
	});

	it('referee discount is not applied for a non-referred user', async () => {
		const user = await makeFeeMockUser(0);

		const fee = user.calculatePerpTakerFee(new BN(1_000_000));
		// 1_000_000 * 1 / 1000 = 1000, no referee discount
		assert(
			fee.eq(new BN(1000)),
			`expected undiscounted fee, got ${fee.toString()}`
		);
	});

	it('referee discount is applied when the user stats account marks them as referred', async () => {
		const user = await makeFeeMockUser(ReferrerStatus.IsReferred);

		const fee = user.calculatePerpTakerFee(new BN(1_000_000));
		// base fee = 1000, referee discount = 25% of 1000 = 250 -> fee = 750
		assert(
			fee.eq(new BN(750)),
			`expected 25% referee discount applied, got ${fee.toString()}`
		);
	});

	it('an explicit isReferee override applies the discount regardless of user stats', async () => {
		const user = await makeFeeMockUser(0);

		const fee = user.calculatePerpTakerFee(new BN(1_000_000), undefined, true);
		assert(
			fee.eq(new BN(750)),
			`expected 25% referee discount applied via override, got ${fee.toString()}`
		);
	});

	// M11: getMarketFees (the primary fee-prediction entry point) must apply the
	// referee discount, not just calculatePerpTakerFee's volume-tier branch.
	it('getMarketFees applies the referee discount to the taker fee for a referred user', async () => {
		const referred = await makeFeeMockUser(ReferrerStatus.IsReferred);
		const notReferred = await makeFeeMockUser(0);

		const { takerFee: referredTakerFee } =
			referred.velocityClient.getMarketFees(MarketType.PERP, 0, referred);
		const { takerFee: baseTakerFee } = notReferred.velocityClient.getMarketFees(
			MarketType.PERP,
			0,
			notReferred
		);

		// base taker fee = 1/1000 = 0.001; referee discount = 25% -> 0.00075
		assert(
			Math.abs(baseTakerFee - 0.001) < 1e-12,
			`expected base taker fee 0.001, got ${baseTakerFee}`
		);
		assert(
			Math.abs(referredTakerFee - 0.00075) < 1e-12,
			`expected discounted taker fee 0.00075, got ${referredTakerFee}`
		);
	});

	// M11: the calculatePerpTakerFee marketIndex path (which delegates to
	// getMarketFees) must now also reflect the referee discount.
	it('calculatePerpTakerFee marketIndex path applies the referee discount', async () => {
		const user = await makeFeeMockUser(ReferrerStatus.IsReferred);

		const fee = user.calculatePerpTakerFee(new BN(1_000_000), 0);
		// 1_000_000 * 0.00075 = 750
		assert(
			fee.eq(new BN(750)),
			`expected discounted market-index fee 750, got ${fee.toString()}`
		);
	});

	// M12: builder fee must be added by getMarketFees when orderParams carry a builder code.
	it('getMarketFees adds the builder fee fraction to the taker fee', async () => {
		const user = await makeFeeMockUser(0);

		const { takerFee } = user.velocityClient.getMarketFees(
			MarketType.PERP,
			0,
			user,
			{ builderIdx: 0, builderFeeTenthBps: 10 }
		);
		// base 0.001 + builder 10/100_000 = 0.0001 -> 0.0011
		assert(
			Math.abs(takerFee - 0.0011) < 1e-12,
			`expected taker fee incl. builder 0.0011, got ${takerFee}`
		);
	});

	// M12: builder fee must also be applied by calculatePerpTakerFee on both
	// the volume-tier branch and the marketIndex branch.
	it('calculatePerpTakerFee adds the builder fee on the volume-tier branch', async () => {
		const user = await makeFeeMockUser(0);

		const fee = user.calculatePerpTakerFee(
			new BN(1_000_000),
			undefined,
			false,
			{ builderIdx: 0, builderFeeTenthBps: 10 }
		);
		// base 1000 + builderFee(1_000_000, 10) = 1_000_000*10/100_000 = 100 -> 1100
		assert(
			fee.eq(new BN(1100)),
			`expected fee incl. builder 1100, got ${fee.toString()}`
		);
	});

	it('calculatePerpTakerFee adds the builder fee on the marketIndex branch', async () => {
		const user = await makeFeeMockUser(0);

		const fee = user.calculatePerpTakerFee(new BN(1_000_000), 0, false, {
			builderIdx: 0,
			builderFeeTenthBps: 10,
		});
		// 1_000_000 * (0.001 + 0.0001) = 1100
		assert(
			fee.eq(new BN(1100)),
			`expected market-index fee incl. builder 1100, got ${fee.toString()}`
		);
	});
});

describe('User canBypassWithdrawLimits', () => {
	async function makeWithdrawMockUser(cumulativeDeposits: BN): Promise<User> {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
		const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);
		const myMockUserAccount = _.cloneDeep(baseMockUserAccount);

		// generous withdraw guard threshold so canBypass isn't gated on deposit size
		myMockSpotMarkets[0].withdrawGuardThreshold = new BN(100_000).mul(
			SPOT_MARKET_BALANCE_PRECISION
		);

		myMockUserAccount.totalDeposits = new BN(1000).mul(
			SPOT_MARKET_BALANCE_PRECISION
		);
		myMockUserAccount.totalWithdraws = ZERO;
		myMockUserAccount.spotPositions[0].balanceType = SpotBalanceType.DEPOSIT;
		myMockUserAccount.spotPositions[0].scaledBalance = new BN(100).mul(
			SPOT_MARKET_BALANCE_PRECISION
		);
		myMockUserAccount.spotPositions[0].cumulativeDeposits = cumulativeDeposits;

		return makeMockUser(
			myMockPerpMarkets,
			myMockSpotMarkets,
			myMockUserAccount,
			[1, 1, 1, 1, 1, 1, 1, 1],
			[1, 1, 1, 1, 1, 1, 1, 1]
		);
	}

	it('can bypass when net deposits and cumulative deposits are both non-negative', async () => {
		const user = await makeWithdrawMockUser(new BN(100));
		const { canBypass } = user.canBypassWithdrawLimits(0);
		assert(canBypass, 'expected canBypass to be true');
	});

	it('cannot bypass when cumulative deposits on the position are negative', async () => {
		const user = await makeWithdrawMockUser(new BN(-1));
		const { canBypass } = user.canBypassWithdrawLimits(0);
		assert(
			!canBypass,
			'expected canBypass to be false with negative cumulativeDeposits'
		);
	});
});
