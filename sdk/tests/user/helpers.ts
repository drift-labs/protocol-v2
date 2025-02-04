import { PublicKey } from '@solana/web3.js';

import {
	SpotPosition,
	SpotBalanceType,
	Order,
	OrderStatus,
	MarketType,
	OrderType,
	PositionDirection,
	OrderTriggerCondition,
	UserAccount,
	ZERO,
	MarginMode,
} from '../../src';

import { mockPerpPosition } from '../dlob/helpers';

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
