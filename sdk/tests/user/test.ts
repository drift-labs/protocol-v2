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
	calculatePositionPNL,
	SPOT_MARKET_BALANCE_PRECISION,
} from '../../src';
import { MockUserMap, mockPerpMarkets, mockSpotMarkets } from '../dlob/helpers';
import { assert } from '../../src/assert/assert';
import { mockUserAccount } from './helpers';
import * as _ from 'lodash';

async function makeMockUser(
	myMockPerpMarkets,
	myMockSpotMarkets,
	myMockUserAccount,
	perpOraclePriceList,
	spotOraclePriceList
): Promise<User> {
	const umap = new MockUserMap();
	const mockUser: User = await umap.mustGet('1');
	mockUser._isSubscribed = true;
	mockUser.driftClient._isSubscribed = true;
	const oraclePriceMap = {};
	// console.log(perpOraclePriceList, myMockPerpMarkets.length);
	// console.log(spotOraclePriceList, myMockSpotMarkets.length);

	for (let i = 0; i < myMockPerpMarkets.length; i++) {
		oraclePriceMap[myMockPerpMarkets[i].amm.oracle.toString()] =
			perpOraclePriceList[i];
	}
	for (let i = 0; i < myMockSpotMarkets.length; i++) {
		oraclePriceMap[myMockSpotMarkets[i].oracle.toString()] =
			spotOraclePriceList[i];
	}
	// console.log(oraclePriceMap);

	function getMockUserAccount(): UserAccount {
		return myMockUserAccount;
	}
	function getMockPerpMarket(marketIndex): PerpMarketAccount {
		return myMockPerpMarkets[marketIndex];
	}
	function getMockSpotMarket(marketIndex): SpotMarketAccount {
		return myMockSpotMarkets[marketIndex];
	}
	function getMockOracle(oracleKey: PublicKey) {
		// console.log('oracleKey.toString():', oracleKey.toString());
		// console.log(
		// 	'oraclePriceMap[oracleKey.toString()]:',
		// 	oraclePriceMap[oracleKey.toString()]
		// );

		const QUOTE_ORACLE_PRICE_DATA: OraclePriceData = {
			price: new BN(
				oraclePriceMap[oracleKey.toString()] * PRICE_PRECISION.toNumber()
			),
			slot: new BN(0),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		return {
			data: QUOTE_ORACLE_PRICE_DATA,
			slot: 0,
		};
	}

	mockUser.getUserAccount = getMockUserAccount;
	mockUser.driftClient.getPerpMarketAccount = getMockPerpMarket;
	mockUser.driftClient.getSpotMarketAccount = getMockSpotMarket;
	mockUser.driftClient.getOraclePriceDataAndSlot = getMockOracle;
	return mockUser;
}

describe('User Tests', () => {
	it('empty user account', async () => {
		console.log(mockSpotMarkets[0]);
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
		const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);
		const myMockUserAccount = _.cloneDeep(mockUserAccount);
		console.log(
			'spot cumulativeDepositInterest:',
			mockSpotMarkets[0].cumulativeDepositInterest.toString()
		);
		const mockUser: User = await makeMockUser(
			myMockPerpMarkets,
			myMockSpotMarkets,
			myMockUserAccount,
			[1, 1, 1, 1, 1, 1, 1, 1],
			[1, 1, 1, 1, 1, 1, 1, 1]
		);
		const uA = mockUser.getUserAccount();
		assert(uA.idle == false);
		console.log(
			'spot cumulativeDepositInterest:',
			myMockSpotMarkets[0].cumulativeDepositInterest.toString()
		);
		assert(mockUser.getFreeCollateral().eq(ZERO));

		console.log(mockUser.getHealth());
		assert(mockUser.getHealth() == 100);

		console.log(mockUser.getMaxLeverageForPerp(0));
		assert(mockUser.getMaxLeverageForPerp(0).eq(ZERO));
	});

	it('user account unsettled pnl', async () => {
		// no collateral, but positive upnl no liability
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
		const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);
		const myMockUserAccount = _.cloneDeep(mockUserAccount);

		myMockUserAccount.perpPositions[0].baseAssetAmount = new BN(
			0 * BASE_PRECISION.toNumber()
		);
		myMockUserAccount.perpPositions[0].quoteAssetAmount = new BN(
			10 * QUOTE_PRECISION.toNumber()
		);
		assert(
			myMockUserAccount.perpPositions[0].quoteAssetAmount.eq(new BN('10000000'))
		); // $10

		const mockUser: User = await makeMockUser(
			myMockPerpMarkets,
			myMockSpotMarkets,
			myMockUserAccount,
			[1, 1, 1, 1, 1, 1, 1, 1],
			[1, 1, 1, 1, 1, 1, 1, 1]
		);
		const uA = mockUser.getUserAccount();
		assert(uA.idle == false);
		const activePerps = mockUser.getActivePerpPositions();
		assert(activePerps.length == 1);
		assert(uA.perpPositions[0].quoteAssetAmount.eq(new BN('10000000'))); // $10
		assert(mockUser.getFreeCollateral().eq(ZERO));

		const quotePrice = mockUser.driftClient.getOracleDataForSpotMarket(0).price;
		console.log('quotePrice:', quotePrice.toString());
		assert(quotePrice.eq(new BN('1000000')));
		const pnl1 = calculatePositionPNL(
			myMockPerpMarkets[0],
			activePerps[0],
			false,
			mockUser.driftClient.getOracleDataForPerpMarket(0)
		);
		console.log('pnl1:', pnl1.toString());
		assert(pnl1.eq(new BN('10000000')));

		const upnl = mockUser.getUnrealizedPNL(false, undefined, undefined, false);
		console.log('upnl:', upnl.toString());
		assert(upnl.eq(new BN('10000000'))); // $10

		const liqResult = mockUser.canBeLiquidated();
		console.log(liqResult);
		assert(liqResult.canBeLiquidated == false);
		assert(liqResult.marginRequirement.eq(ZERO));
		assert(liqResult.totalCollateral.eq(ZERO));

		console.log(mockUser.getHealth());
		assert(mockUser.getHealth() == 100);

		console.log(mockUser.getMaxLeverageForPerp(0));
		assert(mockUser.getMaxLeverageForPerp(0).eq(ZERO));
	});

	it('liquidatable long user account', async () => {
		// no collateral, but positive upnl w/ liability

		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
		const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);
		const myMockUserAccount = _.cloneDeep(mockUserAccount);
		myMockUserAccount.perpPositions[0].baseAssetAmount = new BN(
			20 * BASE_PRECISION.toNumber()
		);
		myMockUserAccount.perpPositions[0].quoteAssetAmount = new BN(
			-10 * QUOTE_PRECISION.toNumber()
		);

		const mockUser: User = await makeMockUser(
			myMockPerpMarkets,
			myMockSpotMarkets,
			myMockUserAccount,
			[1, 1, 1, 1, 1, 1, 1, 1],
			[1, 1, 1, 1, 1, 1, 1, 1]
		);
		const uA = mockUser.getUserAccount();
		assert(uA.idle == false);

		assert(mockUser.getFreeCollateral().eq(ZERO));
		const upnl = mockUser.getUnrealizedPNL(true, 0, undefined, false);
		console.log('upnl:', upnl.toString());
		assert(upnl.eq(new BN('10000000'))); // $10

		const liqResult = mockUser.canBeLiquidated();
		console.log(liqResult);
		assert(liqResult.canBeLiquidated == true);
		assert(liqResult.marginRequirement.eq(new BN('2000000'))); //10x maint leverage
		assert(liqResult.totalCollateral.eq(ZERO));

		console.log(mockUser.getHealth());
		assert(mockUser.getHealth() == 0);

		console.log(mockUser.getMaxLeverageForPerp(0));
		assert(mockUser.getMaxLeverageForPerp(0).eq(new BN('20000')));
	});

	it('large usdc user account', async () => {
		// no collateral, but positive upnl w/ liability

		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
		const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);
		const myMockUserAccount = _.cloneDeep(mockUserAccount);

		myMockPerpMarkets[0].imfFactor = 550;
		myMockUserAccount.spotPositions[0].scaledBalance = new BN(
			100000 * SPOT_MARKET_BALANCE_PRECISION.toNumber()
		); //100k

		const mockUser: User = await makeMockUser(
			myMockPerpMarkets,
			myMockSpotMarkets,
			myMockUserAccount,
			[1, 1, 1, 1, 1, 1, 1, 1],
			[1, 1, 1, 1, 1, 1, 1, 1]
		);
		const uA = mockUser.getUserAccount();
		assert(uA.idle == false);

		assert(uA.perpPositions[0].baseAssetAmount.eq(ZERO));
		assert(uA.perpPositions[0].quoteAssetAmount.eq(ZERO));
		assert(mockUser.getActivePerpPositions().length == 0);

		assert(
			uA.spotPositions[0].scaledBalance.eq(
				new BN(100000 * SPOT_MARKET_BALANCE_PRECISION.toNumber())
			)
		);
		for (let i = 1; i < 8; i++) {
			assert(uA.spotPositions[i].scaledBalance.eq(ZERO));
		}
		console.log(
			'mockUser.getTokenAmount():',
			mockUser.getTokenAmount(0).toString()
		);
		console.log(
			'spot cumulativeDepositInterest:',
			mockSpotMarkets[0].cumulativeDepositInterest.toString()
		);
		assert(mockUser.getTokenAmount(0).eq(new BN('10000000000')));
		assert(mockUser.getNetSpotMarketValue().eq(new BN('10000000000')));
		assert(
			mockUser
				.getSpotMarketAssetAndLiabilityValue()
				.totalLiabilityValue.eq(ZERO)
		);

		assert(mockUser.getFreeCollateral().eq(ZERO));
		const upnl = mockUser.getUnrealizedPNL(true, 0, undefined, false);
		console.log('upnl:', upnl.toString());
		assert(upnl.eq(new BN('0'))); // $10

		const liqResult = mockUser.canBeLiquidated();
		console.log(liqResult);
		assert(liqResult.canBeLiquidated == false);
		assert(liqResult.marginRequirement.eq(new BN('0'))); //10x maint leverage
		assert(liqResult.totalCollateral.eq(ZERO));

		console.log(mockUser.getHealth());
		assert(mockUser.getHealth() == 100);

		console.log(
			'getMaxLeverageForPerp:',
			mockUser.getMaxLeverageForPerp(0).toString()
		);
		assert(mockUser.getMaxLeverageForPerp(0).eq(new BN('0')));
	});
});
