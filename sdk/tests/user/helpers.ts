import { PublicKey } from '@solana/web3.js';

import {
	BN,
	User,
	UserAccount,
	PerpMarketAccount,
	SpotMarketAccount,
	PRICE_PRECISION,
	OraclePriceData,
	SpotPosition,
	SpotBalanceType,
	Order,
	OrderStatus,
	MarketType,
	OrderType,
	PositionDirection,
	OrderTriggerCondition,
	ZERO,
	MarginMode,
	MMOraclePriceData,
} from '../../src';

import { MockUserMap, mockPerpPosition } from '../dlob/helpers';

export const mockOrder: Order = {
	status: OrderStatus.INIT,
	orderType: OrderType.MARKET,
	marketType: MarketType.PERP,
	slot: ZERO,
	orderId: 0,
	userOrderId: 0,
	marketIndex: 0,
	price: ZERO,
	baseAssetAmount: ZERO,
	baseAssetAmountFilled: ZERO,
	quoteAssetAmount: ZERO,
	quoteAssetAmountFilled: ZERO,
	direction: PositionDirection.LONG,
	reduceOnly: false,
	triggerPrice: ZERO,
	triggerCondition: OrderTriggerCondition.ABOVE,
	existingPositionDirection: PositionDirection.LONG,
	postOnly: false,
	immediateOrCancel: false,
	oraclePriceOffset: 0,
	auctionDuration: 0,
	auctionStartPrice: ZERO,
	auctionEndPrice: ZERO,
	maxTs: ZERO,
	bitFlags: 0,
	postedSlotTail: 0,
};

export const mockSpotPosition: SpotPosition = {
	marketIndex: 0,
	balanceType: SpotBalanceType.DEPOSIT,
	scaledBalance: ZERO,
	openOrders: 0,
	openBids: ZERO,
	openAsks: ZERO,
	cumulativeDeposits: ZERO,
};

export const mockUserAccount: UserAccount = {
	authority: PublicKey.default,
	delegate: PublicKey.default,
	name: [1],
	subAccountId: 0,
	spotPositions: Array.from({ length: 8 }, function () {
		return Object.assign({}, mockSpotPosition);
	}),
	perpPositions: Array.from({ length: 8 }, function () {
		return Object.assign({}, mockPerpPosition);
	}),
	orders: Array.from({ length: 8 }, function () {
		return Object.assign({}, mockOrder);
	}),
	status: 0,
	nextLiquidationId: 0,
	nextOrderId: 0,
	maxMarginRatio: 0,
	lastAddPerpLpSharesTs: ZERO,
	settledPerpPnl: ZERO,
	totalDeposits: ZERO,
	totalWithdraws: ZERO,
	totalSocialLoss: ZERO,
	cumulativePerpFunding: ZERO,
	cumulativeSpotFees: ZERO,
	liquidationMarginFreed: ZERO,
	lastActiveSlot: ZERO,
	isMarginTradingEnabled: true,
	idle: false,
	openOrders: 0,
	hasOpenOrder: false,
	openAuctions: 0,
	hasOpenAuction: false,
	lastFuelBonusUpdateTs: 0,
	marginMode: MarginMode.DEFAULT,
	poolId: 0,
};

export async function makeMockUser(
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
	const getStateAccount = () =>
		({
			data: {
				liquidationMarginBufferRatio: 1000,
			},
			slot: 0,
		}) as any;
	mockUser.driftClient.getStateAccount = getStateAccount;

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

	function getMMOracleDataForPerpMarket(
		marketIndex: number
	): MMOraclePriceData {
		const oracle = getMockPerpMarket(marketIndex).amm.oracle;
		return {
			price: getMockOracle(oracle).data.price,
			slot: getMockOracle(oracle).data.slot,
			confidence: getMockOracle(oracle).data.confidence,
			hasSufficientNumberOfDataPoints:
				getMockOracle(oracle).data.hasSufficientNumberOfDataPoints,
			isMMOracleActive: true,
		};
	}

	mockUser.getUserAccount = getMockUserAccount;
	mockUser.driftClient.getPerpMarketAccount = getMockPerpMarket as any;
	mockUser.driftClient.getSpotMarketAccount = getMockSpotMarket as any;
	mockUser.driftClient.getOraclePriceDataAndSlot = getMockOracle as any;
	mockUser.driftClient.getOracleDataForPerpMarket =
		getOracleDataForPerpMarket as any;
	mockUser.driftClient.getOracleDataForSpotMarket =
		getOracleDataForSpotMarket as any;
	mockUser.driftClient.getMMOracleDataForPerpMarket =
		getMMOracleDataForPerpMarket as any;
	return mockUser;
}
