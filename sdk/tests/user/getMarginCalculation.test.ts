import {
	BN,
	ZERO,
	User,
	UserAccount,
	PublicKey,
	PerpMarketAccount,
	SpotMarketAccount,
	PRICE_PRECISION,
	OraclePriceData,
	BASE_PRECISION,
	QUOTE_PRECISION,
	SPOT_MARKET_BALANCE_PRECISION,
	SpotBalanceType,
	MARGIN_PRECISION,
	OPEN_ORDER_MARGIN_REQUIREMENT,
} from '../../src';
import { MockUserMap, mockPerpMarkets, mockSpotMarkets } from '../dlob/helpers';
import { assert } from '../../src/assert/assert';
import { mockUserAccount as baseMockUserAccount } from './helpers';
import * as _ from 'lodash';

async function makeMockUser(
	myMockPerpMarkets: Array<PerpMarketAccount>,
	myMockSpotMarkets: Array<SpotMarketAccount>,
	myMockUserAccount: UserAccount,
	perpOraclePriceList: number[],
	spotOraclePriceList: number[]
): Promise<User> {
	const umap = new MockUserMap();
	const mockUser: User = await umap.mustGet('1');
	mockUser._isSubscribed = true;
	mockUser.driftClient._isSubscribed = true;
	mockUser.driftClient.accountSubscriber.isSubscribed = true;

	const oraclePriceMap: Record<string, number> = {};
	for (let i = 0; i < myMockPerpMarkets.length; i++) {
		oraclePriceMap[myMockPerpMarkets[i].amm.oracle.toString()] =
			perpOraclePriceList[i] ?? 1;
	}
	for (let i = 0; i < myMockSpotMarkets.length; i++) {
		oraclePriceMap[myMockSpotMarkets[i].oracle.toString()] =
			spotOraclePriceList[i] ?? 1;
	}

	function getMockUserAccount(): UserAccount {
		return myMockUserAccount;
	}
	function getMockPerpMarket(marketIndex: number): PerpMarketAccount {
		return myMockPerpMarkets[marketIndex];
	}
	function getMockSpotMarket(marketIndex: number): SpotMarketAccount {
		return myMockSpotMarkets[marketIndex];
	}
	function getMockOracle(oracleKey: PublicKey) {
		const data: OraclePriceData = {
			price: new BN(
				(oraclePriceMap[oracleKey.toString()] ?? 1) *
					PRICE_PRECISION.toNumber()
			),
			slot: new BN(0),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};
		return { data, slot: 0 };
	}
	function getOracleDataForPerpMarket(marketIndex: number) {
		const oracle = getMockPerpMarket(marketIndex).amm.oracle;
		return getMockOracle(oracle).data;
	}
	function getOracleDataForSpotMarket(marketIndex: number) {
		const oracle = getMockSpotMarket(marketIndex).oracle;
		return getMockOracle(oracle).data;
	}

	mockUser.getUserAccount = getMockUserAccount;
	mockUser.driftClient.getPerpMarketAccount = getMockPerpMarket as any;
	mockUser.driftClient.getSpotMarketAccount = getMockSpotMarket as any;
	mockUser.driftClient.getOraclePriceDataAndSlot = getMockOracle as any;
	mockUser.driftClient.getOracleDataForPerpMarket = getOracleDataForPerpMarket as any;
	mockUser.driftClient.getOracleDataForSpotMarket = getOracleDataForSpotMarket as any;
	return mockUser;
}

describe('getMarginCalculation snapshot', () => {
	it('empty account returns zeroed snapshot', async () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
		const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);
		const myMockUserAccount = _.cloneDeep(baseMockUserAccount);

		const user: User = await makeMockUser(
			myMockPerpMarkets,
			myMockSpotMarkets,
			myMockUserAccount,
			[1, 1, 1, 1, 1, 1, 1, 1],
			[1, 1, 1, 1, 1, 1, 1, 1]
		);

		const calc = user.getMarginCalculation('Initial');
		assert(calc.totalCollateral.eq(ZERO));
		assert(calc.marginRequirement.eq(ZERO));
		assert(calc.numSpotLiabilities === 0);
		assert(calc.numPerpLiabilities === 0);
	});

	it('quote deposit increases totalCollateral, no requirement', async () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
		const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);
		const myMockUserAccount = _.cloneDeep(baseMockUserAccount);

		myMockUserAccount.spotPositions[0].balanceType = SpotBalanceType.DEPOSIT;
		myMockUserAccount.spotPositions[0].scaledBalance = new BN(
			10000 * SPOT_MARKET_BALANCE_PRECISION.toNumber()
		);

		const user: User = await makeMockUser(
			myMockPerpMarkets,
			myMockSpotMarkets,
			myMockUserAccount,
			[1, 1, 1, 1, 1, 1, 1, 1],
			[1, 1, 1, 1, 1, 1, 1, 1]
		);

		const calc = user.getMarginCalculation('Initial');
		const expected = new BN('10000000000'); // $10k
		assert(calc.totalCollateral.eq(expected));
		assert(calc.marginRequirement.eq(ZERO));
	});

	it('quote borrow increases requirement and buffer applies', async () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
		const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);
		const myMockUserAccount = _.cloneDeep(baseMockUserAccount);

		// Borrow 100 quote
		myMockUserAccount.spotPositions[0].balanceType = SpotBalanceType.BORROW;
		myMockUserAccount.spotPositions[0].scaledBalance = new BN(
			100 * SPOT_MARKET_BALANCE_PRECISION.toNumber()
		);

		const user: User = await makeMockUser(
			myMockPerpMarkets,
			myMockSpotMarkets,
			myMockUserAccount,
			[1, 1, 1, 1, 1, 1, 1, 1],
			[1, 1, 1, 1, 1, 1, 1, 1]
		);

		const tenPercent = MARGIN_PRECISION.divn(10);
		const calc = user.getMarginCalculation('Initial', {
			liquidationBuffer: tenPercent,
		});
		const liability = new BN(100).mul(QUOTE_PRECISION); // $100
		assert(calc.totalCollateral.eq(ZERO));
		assert(calc.marginRequirement.eq(liability));
		assert(
			calc.marginRequirementPlusBuffer.eq(
				liability.mul(tenPercent).div(MARGIN_PRECISION)
			)
		);
		assert(calc.numSpotLiabilities === 1);
	});

	it('non-quote spot open orders add IM', async () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
		const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);
		const myMockUserAccount = _.cloneDeep(baseMockUserAccount);

		// Market 1 (e.g., SOL) with 2 open orders
		myMockUserAccount.spotPositions[1].marketIndex = 1;
		myMockUserAccount.spotPositions[1].openOrders = 2;

		const user: User = await makeMockUser(
			myMockPerpMarkets,
			myMockSpotMarkets,
			myMockUserAccount,
			[1, 1, 1, 1, 1, 1, 1, 1],
			[1, 1, 1, 1, 1, 1, 1, 1]
		);

		const calc = user.getMarginCalculation('Initial');
		const expectedIM = new BN(2).mul(OPEN_ORDER_MARGIN_REQUIREMENT);
		assert(calc.marginRequirement.eq(expectedIM));
	});

	it('perp long liability reflects maintenance requirement', async () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
		const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);
		const myMockUserAccount = _.cloneDeep(baseMockUserAccount);

		// 20 base long, -$10 quote (liability)
		myMockUserAccount.perpPositions[0].baseAssetAmount = new BN(20).mul(
			BASE_PRECISION
		);
		myMockUserAccount.perpPositions[0].quoteAssetAmount = new BN(-10).mul(
			QUOTE_PRECISION
		);

		const user: User = await makeMockUser(
			myMockPerpMarkets,
			myMockSpotMarkets,
			myMockUserAccount,
			[1, 1, 1, 1, 1, 1, 1, 1],
			[1, 1, 1, 1, 1, 1, 1, 1]
		);

		const calc = user.getMarginCalculation('Maintenance');
		// From existing liquidation test expectations: 2_000_000
		assert(calc.marginRequirement.eq(new BN('2000000')));
	});
});


