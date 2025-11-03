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
	OPEN_ORDER_MARGIN_REQUIREMENT,
	SPOT_MARKET_WEIGHT_PRECISION,
	PositionFlag,
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
				(oraclePriceMap[oracleKey.toString()] ?? 1) * PRICE_PRECISION.toNumber()
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
	mockUser.driftClient.getOracleDataForPerpMarket =
		getOracleDataForPerpMarket as any;
	mockUser.driftClient.getOracleDataForSpotMarket =
		getOracleDataForSpotMarket as any;
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

		const tenPercent = new BN(1000);
		const calc = user.getMarginCalculation('Initial', {
			liquidationBuffer: tenPercent,
		});
		const liability = new BN(100).mul(QUOTE_PRECISION); // $100
		assert(calc.totalCollateral.eq(ZERO));
		assert(calc.marginRequirement.eq(liability));
		assert(
			calc.marginRequirementPlusBuffer.eq(
				liability.div(new BN(10)).add(calc.marginRequirement) // 10% of liability + margin requirement
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

	it.only('maker position reducing: collateral equals maintenance requirement', async () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
		const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);
		const myMockUserAccount = _.cloneDeep(baseMockUserAccount);

		myMockUserAccount.perpPositions[0].baseAssetAmount = new BN(200000000).mul(
			BASE_PRECISION
		);
		myMockUserAccount.perpPositions[0].quoteAssetAmount = new BN(
			-180000000
		).mul(QUOTE_PRECISION);

		const user: User = await makeMockUser(
			myMockPerpMarkets,
			myMockSpotMarkets,
			myMockUserAccount,
			[1, 1, 1, 1, 1, 1, 1, 1],
			[1, 1, 1, 1, 1, 1, 1, 1]
		);

		const calc = user.getMarginCalculation('Maintenance');
		console.log('calc.marginRequirement', calc.marginRequirement.toString());
		console.log('calc.totalCollateral', calc.totalCollateral.toString());
		assert(calc.marginRequirement.eq(calc.totalCollateral));
	});

	it('maker reducing after simulated fill: collateral equals maintenance requirement', async () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
		const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);

		// Build maker and taker accounts
		const makerAccount = _.cloneDeep(baseMockUserAccount);
		const takerAccount = _.cloneDeep(baseMockUserAccount);

		// Oracle price = 1 for perp and spot
		const perpOracles = [1, 1, 1, 1, 1, 1, 1, 1];
		const spotOracles = [1, 1, 1, 1, 1, 1, 1, 1];

		// Pre-fill: maker has 21 base long at entry 1 ($21 notional), taker flat
		makerAccount.perpPositions[0].baseAssetAmount = new BN(21).mul(
			BASE_PRECISION
		);
		makerAccount.perpPositions[0].quoteEntryAmount = new BN(-21).mul(
			QUOTE_PRECISION
		);
		makerAccount.perpPositions[0].quoteBreakEvenAmount = new BN(-21).mul(
			QUOTE_PRECISION
		);
		// Provide exactly $2 in quote collateral to equal 10% maintenance of 20 notional post-fill
		makerAccount.spotPositions[0].balanceType = SpotBalanceType.DEPOSIT;
		makerAccount.spotPositions[0].scaledBalance = new BN(2).mul(
			SPOT_MARKET_BALANCE_PRECISION
		);

		// Simulate fill: maker sells 1 base to taker at price = oracle = 1
		// Post-fill maker position: 20 base long with zero unrealized PnL
		const maker: User = await makeMockUser(
			myMockPerpMarkets,
			myMockSpotMarkets,
			makerAccount,
			perpOracles,
			spotOracles
		);
		const taker: User = await makeMockUser(
			myMockPerpMarkets,
			myMockSpotMarkets,
			takerAccount,
			perpOracles,
			spotOracles
		);

		// Apply synthetic trade deltas to both user accounts
		// Maker: base 21 -> 20; taker: base 0 -> 1. Use quote deltas consistent with price 1, fee 0
		maker.getUserAccount().perpPositions[0].baseAssetAmount = new BN(20).mul(
			BASE_PRECISION
		);
		maker.getUserAccount().perpPositions[0].quoteEntryAmount = new BN(-20).mul(
			QUOTE_PRECISION
		);
		maker.getUserAccount().perpPositions[0].quoteBreakEvenAmount = new BN(
			-20
		).mul(QUOTE_PRECISION);
		// Align quoteAssetAmount with base value so unrealized PnL = 0 at price 1
		maker.getUserAccount().perpPositions[0].quoteAssetAmount = new BN(-20).mul(
			QUOTE_PRECISION
		);

		taker.getUserAccount().perpPositions[0].baseAssetAmount = new BN(1).mul(
			BASE_PRECISION
		);
		taker.getUserAccount().perpPositions[0].quoteEntryAmount = new BN(-1).mul(
			QUOTE_PRECISION
		);
		taker.getUserAccount().perpPositions[0].quoteBreakEvenAmount = new BN(
			-1
		).mul(QUOTE_PRECISION);
		// Also set taker's quoteAssetAmount consistently
		taker.getUserAccount().perpPositions[0].quoteAssetAmount = new BN(-1).mul(
			QUOTE_PRECISION
		);

		const makerCalc = maker.getMarginCalculation('Maintenance');
		assert(makerCalc.marginRequirement.eq(makerCalc.totalCollateral));
		assert(makerCalc.marginRequirement.gt(ZERO));
	});

	it('isolated position margin requirement (SDK parity)', async () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
		const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);
		myMockSpotMarkets[0].oracle = new PublicKey(2);
		myMockSpotMarkets[1].oracle = new PublicKey(5);
		myMockPerpMarkets[0].amm.oracle = new PublicKey(5);

		// Configure perp market 0 ratios to match on-chain test
		myMockPerpMarkets[0].marginRatioInitial = 1000; // 10%
		myMockPerpMarkets[0].marginRatioMaintenance = 500; // 5%

		// Configure spot market 1 (e.g., SOL) weights to match on-chain test
		myMockSpotMarkets[1].initialAssetWeight =
			(SPOT_MARKET_WEIGHT_PRECISION.toNumber() * 8) / 10; // 0.8
		myMockSpotMarkets[1].maintenanceAssetWeight =
			(SPOT_MARKET_WEIGHT_PRECISION.toNumber() * 9) / 10; // 0.9
		myMockSpotMarkets[1].initialLiabilityWeight =
			(SPOT_MARKET_WEIGHT_PRECISION.toNumber() * 12) / 10; // 1.2
		myMockSpotMarkets[1].maintenanceLiabilityWeight =
			(SPOT_MARKET_WEIGHT_PRECISION.toNumber() * 11) / 10; // 1.1

		// ---------- Cross margin only (spot positions) ----------
		const crossAccount = _.cloneDeep(baseMockUserAccount);
		// USDC deposit: $20,000
		crossAccount.spotPositions[0].marketIndex = 0;
		crossAccount.spotPositions[0].balanceType = SpotBalanceType.DEPOSIT;
		crossAccount.spotPositions[0].scaledBalance = new BN(20000).mul(
			SPOT_MARKET_BALANCE_PRECISION
		);
		// SOL borrow: 100 units
		crossAccount.spotPositions[1].marketIndex = 1;
		crossAccount.spotPositions[1].balanceType = SpotBalanceType.BORROW;
		crossAccount.spotPositions[1].scaledBalance = new BN(100).mul(
			SPOT_MARKET_BALANCE_PRECISION
		);
		// No perp exposure in cross calc
		crossAccount.perpPositions[0].baseAssetAmount = new BN(
			100 * BASE_PRECISION.toNumber()
		);
		crossAccount.perpPositions[0].quoteAssetAmount = new BN(
			-11000 * QUOTE_PRECISION.toNumber()
		);
		crossAccount.perpPositions[0].positionFlag = PositionFlag.IsolatedPosition;
		crossAccount.perpPositions[0].isolatedPositionScaledBalance = new BN(
			100
		).mul(SPOT_MARKET_BALANCE_PRECISION);

		const userCross: User = await makeMockUser(
			myMockPerpMarkets,
			myMockSpotMarkets,
			crossAccount,
			[100, 1, 1, 1, 1, 1, 1, 1], // perp oracle for market 0 = 100
			[1, 100, 1, 1, 1, 1, 1, 1] // spot oracle: usdc=1, sol=100
		);

		const crossCalc = userCross.getMarginCalculation('Initial');
		const isolatedMarginCalc = crossCalc.isolatedMarginCalculations.get(0);
		// Expect: cross MR from SOL borrow: 100 * $100 = $10,000 * 1.2 = $12,000
		assert(crossCalc.marginRequirement.eq(new BN('12000000000')));
		// Expect: cross total collateral from USDC deposit only = $20,000
		assert(crossCalc.totalCollateral.eq(new BN('20000000000')));
		// Meets cross margin requirement
		assert(crossCalc.marginRequirement.lte(crossCalc.totalCollateral));

		assert(isolatedMarginCalc?.marginRequirement.eq(new BN('1000000000')));
		assert(isolatedMarginCalc?.totalCollateral.eq(new BN('-900000000')));
		// With 10% buffer
		const tenPct = new BN(1000);
		const crossCalcBuf = userCross.getMarginCalculation('Initial', {
			liquidationBuffer: tenPct,
		});
		assert(crossCalcBuf.marginRequirementPlusBuffer.eq(new BN('13000000000'))); // replicate 10% buffer
		const crossTotalPlusBuffer = crossCalcBuf.totalCollateral.add(
			crossCalcBuf.totalCollateralBuffer
		);
		assert(crossTotalPlusBuffer.eq(new BN('20000000000')));

		const isoPosition = crossCalcBuf.isolatedMarginCalculations.get(0);
		assert(isoPosition?.marginRequirementPlusBuffer.eq(new BN('2000000000')));
		assert(
			isoPosition?.totalCollateralBuffer
				.add(isoPosition?.totalCollateral)
				.eq(new BN('-1000000000'))
		);
	});
});
