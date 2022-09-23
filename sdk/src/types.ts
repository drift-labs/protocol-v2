import { PublicKey, Transaction } from '@solana/web3.js';
import { BN, ZERO } from '.';

// # Utility Types / Enums / Constants

export class MarketStatus {
	static readonly INITIALIZED = { initialized: {} };
	static readonly REDUCEONLY = { reduceonly: {} };
	static readonly SETTLEMENT = { settlement: {} };
	static readonly DELISTED = { delisted: {} };
}

export class ContractType {
	static readonly PERPETUAL = { perpetual: {} };
	static readonly FUTURE = { future: {} };
}

export class SwapDirection {
	static readonly ADD = { add: {} };
	static readonly REMOVE = { remove: {} };
}

export class SpotBalanceType {
	static readonly DEPOSIT = { deposit: {} };
	static readonly BORROW = { borrow: {} };
}

export class PositionDirection {
	static readonly LONG = { long: {} };
	static readonly SHORT = { short: {} };
}

export class DepositDirection {
	static readonly DEPOSIT = { deposit: {} };
	static readonly WITHDRAW = { withdraw: {} };
}

export class OracleSource {
	static readonly PYTH = { pyth: {} };
	static readonly SWITCHBOARD = { switchboard: {} };
	static readonly QUOTE_ASSET = { quoteAsset: {} };
}

export class OrderType {
	static readonly LIMIT = { limit: {} };
	static readonly TRIGGER_MARKET = { triggerMarket: {} };
	static readonly TRIGGER_LIMIT = { triggerLimit: {} };
	static readonly MARKET = { market: {} };
}

export declare type MarketTypeStr = 'perp' | 'spot';
export class MarketType {
	static readonly SPOT = { spot: {} };
	static readonly PERP = { perp: {} };
}

export class OrderStatus {
	static readonly INIT = { init: {} };
	static readonly OPEN = { open: {} };
}

export class OrderDiscountTier {
	static readonly NONE = { none: {} };
	static readonly FIRST = { first: {} };
	static readonly SECOND = { second: {} };
	static readonly THIRD = { third: {} };
	static readonly FOURTH = { fourth: {} };
}

export class OrderAction {
	static readonly PLACE = { place: {} };
	static readonly CANCEL = { cancel: {} };
	static readonly EXPIRE = { expire: {} };
	static readonly FILL = { fill: {} };
	static readonly TRIGGER = { trigger: {} };
}

export class OrderActionExplanation {
	static readonly NONE = { none: {} };
	static readonly ORACLE_PRICE_BREACHED_LIMIT_PRICE = {
		oraclePriceBreachedLimitPrice: {},
	};
	static readonly MARKET_ORDER_FILLED_TO_LIMIT_PRICE = {
		marketOrderFilledToLimitPrice: {},
	};
	static readonly CANCELED_FOR_LIQUIDATION = {
		canceledForLiquidation: {},
	};
	static readonly MARKET_ORDER_AUCTION_EXPIRED = {
		marketOrderAuctionExpired: {},
	};
}

export class OrderTriggerCondition {
	static readonly ABOVE = { above: {} };
	static readonly BELOW = { below: {} };
}

export class SpotFulfillmentType {
	static readonly SERUM_v3 = { serumV3: {} };
}

export class SpotFulfillmentStatus {
	static readonly ENABLED = { enabled: {} };
	static readonly DISABLED = { disabled: {} };
}

export function isVariant(object: unknown, type: string) {
	return object.hasOwnProperty(type);
}

export function isOneOfVariant(object: unknown, types: string[]) {
	return types.reduce((result, type) => {
		return result || object.hasOwnProperty(type);
	}, false);
}

export function getVariant(object: unknown): string {
	return Object.keys(object)[0];
}

export enum TradeSide {
	None = 0,
	Buy = 1,
	Sell = 2,
}

export type CandleResolution =
	| '1'
	| '5'
	| '15'
	| '60'
	| '240'
	| 'D'
	| 'W'
	| 'M';

export type NewUserRecord = {
	ts: BN;
	userAuthority: PublicKey;
	user: PublicKey;
	userId: number;
	name: number[];
	referrer: PublicKey;
};

export type DepositRecord = {
	ts: BN;
	userAuthority: PublicKey;
	user: PublicKey;
	direction: {
		deposit?: any;
		withdraw?: any;
	};
	marketIndex: BN;
	amount: BN;
	oraclePrice: BN;
	referrer: PublicKey;
	from?: PublicKey;
	to?: PublicKey;
};

export type CurveRecord = {
	ts: BN;
	recordId: BN;
	marketIndex: BN;
	pegMultiplierBefore: BN;
	baseAssetReserveBefore: BN;
	quoteAssetReserveBefore: BN;
	sqrtKBefore: BN;
	pegMultiplierAfter: BN;
	baseAssetReserveAfter: BN;
	quoteAssetReserveAfter: BN;
	sqrtKAfter: BN;
	baseAssetAmountLong: BN;
	baseAssetAmountShort: BN;
	baseAssetAmount: BN;
	openInterest: BN;
	oraclePrice: BN;
	tradeId: BN;
};

export declare type InsuranceFundRecord = {
	ts: BN;
	bankIndex: BN;
	marketIndex: BN;
	userIfFactor: BN;
	totalIfFactor: BN;
	vaultAmountBefore: BN;
	insuranceVaultAmountBefore: BN;
	amount: BN;
	totalIfSharesBefore: BN;
	totalIfSharesAfter: BN;
};

export type LPRecord = {
	ts: BN;
	user: PublicKey;
	action: LPAction;
	nShares: BN;
	marketIndex: BN;
	deltaBaseAssetAmount: BN;
	deltaQuoteAssetAmount: BN;
	pnl: BN;
};

export class LPAction {
	static readonly ADD_LIQUIDITY = { addLiquidity: {} };
	static readonly REMOVE_LIQUIDITY = { removeLiquidity: {} };
	static readonly SETTLE_LIQUIDITY = { settleLiquidity: {} };
}

export type FundingRateRecord = {
	ts: BN;
	recordId: BN;
	marketIndex: BN;
	fundingRate: BN;
	fundingRateLong: BN;
	fundingRateShort: BN;
	cumulativeFundingRateLong: BN;
	cumulativeFundingRateShort: BN;
	oraclePriceTwap: BN;
	markPriceTwap: BN;
	periodRevenue: BN;
	netBaseAssetAmount: BN;
	netUnsettledLpBaseAssetAmount: BN;
};

export type FundingPaymentRecord = {
	ts: BN;
	userAuthority: PublicKey;
	user: PublicKey;
	marketIndex: BN;
	fundingPayment: BN;
	baseAssetAmount: BN;
	userLastCumulativeFunding: BN;
	userLastFundingRateTs: BN;
	ammCumulativeFundingLong: BN;
	ammCumulativeFundingShort: BN;
};

export type LiquidationRecord = {
	ts: BN;
	user: PublicKey;
	liquidator: PublicKey;
	liquidationType: LiquidationType;
	marginRequirement: BN;
	totalCollateral: BN;
	liquidationId: number;
	canceledOrderIds: BN[];
	liquidatePerp: LiquidatePerpRecord;
	liquidateBorrow: LiquidateBorrowRecord;
	liquidateBorrowForPerpPnl: LiquidateBorrowForPerpPnlRecord;
	liquidatePerpPnlForDeposit: LiquidatePerpPnlForDepositRecord;
	perpBankruptcy: PerpBankruptcyRecord;
	borrowBankruptcy: BorrowBankruptcyRecord;
};

export class LiquidationType {
	static readonly LIQUIDATE_PERP = { liquidatePerp: {} };
	static readonly LIQUIDATE_BORROW = { liquidateBorrow: {} };
	static readonly LIQUIDATE_BORROW_FOR_PERP_PNL = {
		liquidateBorrowForPerpPnl: {},
	};
	static readonly LIQUIDATE_PERP_PNL_FOR_DEPOSIT = {
		liquidatePerpPnlForDeposit: {},
	};
	static readonly PERP_BANKRUPTCY = {
		perpBankruptcy: {},
	};
	static readonly BORROW_BANKRUPTCY = {
		borrowBankruptcy: {},
	};
}

export type LiquidatePerpRecord = {
	marketIndex: BN;
	oraclePrice: BN;
	baseAssetAmount: BN;
	quoteAssetAmount: BN;
	lpShares: BN;
	userPnl: BN;
	liquidatorPnl: BN;
	userOrderId: BN;
	liquidatorOrderId: BN;
	fillRecordId: BN;
	ifFee: BN;
};

export type LiquidateBorrowRecord = {
	assetMarketIndex: BN;
	assetPrice: BN;
	assetTransfer: BN;
	liabilityMarketIndex: BN;
	liabilityPrice: BN;
	liabilityTransfer: BN;
	ifFee: BN;
};

export type LiquidateBorrowForPerpPnlRecord = {
	perpMarketIndex: BN;
	marketOraclePrice: BN;
	pnlTransfer: BN;
	liabilityMarketIndex: BN;
	liabilityPrice: BN;
	liabilityTransfer: BN;
};

export type LiquidatePerpPnlForDepositRecord = {
	perpMarketIndex: BN;
	marketOraclePrice: BN;
	pnlTransfer: BN;
	assetMarketIndex: BN;
	assetPrice: BN;
	assetTransfer: BN;
};

export type PerpBankruptcyRecord = {
	marketIndex: BN;
	pnl: BN;
	cumulativeFundingRateDelta: BN;
};

export type BorrowBankruptcyRecord = {
	marketIndex: BN;
	borrowAmount: BN;
	cumulativeDepositInterestDelta: BN;
};

export type SettlePnlRecord = {
	ts: BN;
	user: PublicKey;
	marketIndex: BN;
	pnl: BN;
	baseAssetAmount: BN;
	quoteAssetAmountAfter: BN;
	quoteEntryAmount: BN;
	settlePrice: BN;
};

export type OrderRecord = {
	ts: BN;
	user: PublicKey;
	order: Order;
};

export type OrderActionRecord = {
	ts: BN;
	action: OrderAction;
	actionExplanation: OrderActionExplanation;
	marketIndex: BN;
	filler: PublicKey | null;
	fillerReward: BN | null;
	fillRecordId: BN | null;
	referrer: PublicKey | null;
	baseAssetAmountFilled: BN | null;
	quoteAssetAmountFilled: BN | null;
	takerPnl: BN | null;
	makerPnl: BN | null;
	takerFee: BN | null;
	makerRebate: BN | null;
	referrerReward: BN | null;
	refereeDiscount: BN | null;
	quoteAssetAmountSurplus: BN | null;
	taker: PublicKey | null;
	takerOrderId: BN | null;
	takerOrderDirection: PositionDirection | null;
	takerOrderBaseAssetAmount: BN | null;
	takerOrderBaseAssetAmountFilled: BN | null;
	takerOrderQuoteAssetAmountFilled: BN | null;
	takerOrderFee: BN | null;
	maker: PublicKey | null;
	makerOrderId: BN | null;
	makerOrderDirection: PositionDirection | null;
	makerOrderBaseAssetAmount: BN | null;
	makerOrderBaseAssetAmountFilled: BN | null;
	makerOrderQuoteAssetAmountFilled: BN | null;
	makerOrderFee: BN | null;
	oraclePrice: BN;
};

export type StateAccount = {
	admin: PublicKey;
	fundingPaused: boolean;
	exchangePaused: boolean;
	adminControlsPrices: boolean;
	insuranceVault: PublicKey;
	totalFee: BN;
	totalFeeWithdrawn: BN;
	whitelistMint: PublicKey;
	discountMint: PublicKey;
	oracleGuardRails: OracleGuardRails;
	maxDeposit: BN;
	numberOfMarkets: BN;
	numberOfSpotMarkets: BN;
	minOrderQuoteAssetAmount: BN;
	signer: PublicKey;
	signerNonce: number;
	defaultMarketOrderTimeInForce: number;
	minPerpAuctionDuration: number;
	defaultSpotAuctionDuration: number;
	liquidationMarginBufferRatio: number;
	perpFeeStructure: FeeStructure;
	spotFeeStructure: FeeStructure;
};

export type PerpMarketAccount = {
	status: MarketStatus;
	contractType: ContractType;
	expiryTs: BN;
	settlementPrice: BN;
	marketIndex: BN;
	pubkey: PublicKey;
	amm: AMM;
	baseAssetAmount: BN;
	baseAssetAmountLong: BN;
	baseAssetAmountShort: BN;
	openInterest: BN;
	marginRatioInitial: number;
	marginRatioMaintenance: number;
	nextFillRecordId: BN;
	pnlPool: PoolBalance;
	liquidatorFee: BN;
	ifLiquidationFee: BN;
	imfFactor: BN;
	unrealizedImfFactor: BN;
	unrealizedMaxImbalance: BN;
	unrealizedInitialAssetWeight: number;
	unrealizedMaintenanceAssetWeight: number;
	revenueWithdrawSinceLastSettle: BN;
	maxRevenueWithdrawPerPeriod: BN;
	lastRevenueWithdrawTs: BN;
	quoteSettledInsurance: BN;
	quoteMaxInsurance: BN;
};

export type SpotMarketAccount = {
	marketIndex: BN;
	pubkey: PublicKey;
	mint: PublicKey;
	vault: PublicKey;

	insuranceFundVault: PublicKey;
	insuranceWithdrawEscrowPeriod: BN;
	revenuePool: PoolBalance;

	totalIfShares: BN;
	userIfShares: BN;

	userIfFactor: BN;
	totalIfFactor: BN;
	ifLiquidationFee: BN;

	decimals: number;
	optimalUtilization: BN;
	optimalBorrowRate: BN;
	maxBorrowRate: BN;
	cumulativeDepositInterest: BN;
	cumulativeBorrowInterest: BN;
	depositBalance: BN;
	borrowBalance: BN;
	lastInterestTs: BN;
	lastTwapTs: BN;
	oracle: PublicKey;
	initialAssetWeight: BN;
	maintenanceAssetWeight: BN;
	initialLiabilityWeight: BN;
	maintenanceLiabilityWeight: BN;
	liquidatorFee: BN;
	imfFactor: BN;

	withdrawGuardThreshold: BN;
	depositTokenTwap: BN;
	borrowTokenTwap: BN;
	utilizationTwap: BN;

	orderStepSize: BN;
	nextFillRecordId: BN;
	spotFeePool: {
		balance: BN;
	};
	totalSpotFee: BN;
};

export type PoolBalance = {
	balance: BN;
};

export type AMM = {
	baseAssetReserve: BN;
	sqrtK: BN;
	cumulativeFundingRate: BN;
	lastFundingRate: BN;
	lastFundingRateTs: BN;
	lastMarkPriceTwap: BN;
	lastMarkPriceTwap5min: BN;
	lastMarkPriceTwapTs: BN;
	lastOraclePriceTwap: BN;
	lastOraclePriceTwap5min: BN;
	lastOraclePriceTwapTs: BN;
	lastOracleMarkSpreadPct: BN;
	lastOracleConfPct: BN;
	oracle: PublicKey;
	oracleSource: OracleSource;
	fundingPeriod: BN;
	quoteAssetReserve: BN;
	pegMultiplier: BN;
	cumulativeFundingRateLong: BN;
	cumulativeFundingRateShort: BN;
	cumulativeFundingRateLp: BN;
	cumulativeRepegRebateLong: BN;
	cumulativeRepegRebateShort: BN;
	totalFeeMinusDistributions: BN;
	totalFeeWithdrawn: BN;
	totalFee: BN;
	cumulativeFundingPaymentPerLp: BN;
	cumulativeFeePerLp: BN;
	cumulativeNetBaseAssetAmountPerLp: BN;
	userLpShares: BN;
	netUnsettledLpBaseAssetAmount: BN;
	minimumQuoteAssetTradeSize: BN;
	baseAssetAmountStepSize: BN;
	maxBaseAssetAmountRatio: number;
	maxSlippageRatio: number;
	lastOraclePrice: BN;
	baseSpread: number;
	curveUpdateIntensity: number;
	netBaseAssetAmount: BN;
	quoteAssetAmountLong: BN;
	quoteAssetAmountShort: BN;
	terminalQuoteAssetReserve: BN;
	feePool: PoolBalance;
	totalExchangeFee: BN;
	totalMmFee: BN;
	netRevenueSinceLastFunding: BN;
	lastUpdateSlot: BN;
	lastOracleValid: boolean;
	lastBidPriceTwap: BN;
	lastAskPriceTwap: BN;
	longSpread: BN;
	shortSpread: BN;
	maxSpread: number;
	marketPosition: PerpPosition;
	marketPositionPerLp: PerpPosition;
	ammJitIntensity: number;
	maxBaseAssetReserve: BN;
	minBaseAssetReserve: BN;
	cumulativeSocialLoss: BN;
};

// # User Account Types
export type PerpPosition = {
	baseAssetAmount: BN;
	remainderBaseAssetAmount: BN;
	lastCumulativeFundingRate: BN;
	marketIndex: BN;
	quoteAssetAmount: BN;
	quoteEntryAmount: BN;
	openOrders: BN;
	openBids: BN;
	openAsks: BN;
	settledPnl: BN;
	lpShares: BN;
	lastFeePerLp: BN;
	lastNetBaseAssetAmountPerLp: BN;
	lastNetQuoteAssetAmountPerLp: BN;
};

export type UserStatsAccount = {
	numberOfUsers: number;
	makerVolume30D: BN;
	takerVolume30D: BN;
	fillerVolume30D: BN;
	lastMakerVolume30DTs: BN;
	lastTakerVolume30DTs: BN;
	lastFillerVolume30DTs: BN;
	fees: {
		totalFeePaid: BN;
		totalFeeRebate: BN;
		totalTokenDiscount: BN;
		totalRefereeDiscount: BN;
	};
	referrer: PublicKey;
	isReferrer: boolean;
	totalReferrerReward: BN;
	authority: PublicKey;
	stakedQuoteAssetAmount: BN;
};

export type UserAccount = {
	authority: PublicKey;
	delegate: PublicKey;
	name: number[];
	userId: number;
	spotPositions: SpotPosition[];
	perpPositions: PerpPosition[];
	orders: Order[];
	beingLiquidated: boolean;
	bankrupt: boolean;
	nextLiquidationId: number;
	nextOrderId: BN;
	customMarginRatio: number;
};

export type SpotPosition = {
	marketIndex: BN;
	balanceType: SpotBalanceType;
	balance: BN;
	openOrders: number;
	openBids: BN;
	openAsks: BN;
	cumulativeDeposits: BN;
};

export type Order = {
	status: OrderStatus;
	orderType: OrderType;
	marketType: MarketType;
	ts: BN;
	slot: BN;
	orderId: BN;
	userOrderId: number;
	marketIndex: BN;
	price: BN;
	baseAssetAmount: BN;
	baseAssetAmountFilled: BN;
	quoteAssetAmount: BN;
	quoteAssetAmountFilled: BN;
	fee: BN;
	direction: PositionDirection;
	reduceOnly: boolean;
	triggerPrice: BN;
	triggerCondition: OrderTriggerCondition;
	triggered: boolean;
	existingPositionDirection: PositionDirection;
	postOnly: boolean;
	immediateOrCancel: boolean;
	oraclePriceOffset: BN;
	auctionDuration: number;
	auctionStartPrice: BN;
	auctionEndPrice: BN;
	timeInForce: number;
};

export type OrderParams = {
	orderType: OrderType;
	marketType: MarketType;
	userOrderId: number;
	direction: PositionDirection;
	baseAssetAmount: BN;
	price: BN;
	marketIndex: BN;
	reduceOnly: boolean;
	postOnly: boolean;
	immediateOrCancel: boolean;
	triggerPrice: BN;
	triggerCondition: OrderTriggerCondition;
	positionLimit: BN;
	oraclePriceOffset: BN;
	auctionDuration: number | null;
	timeInForce: number | null;
	auctionStartPrice: BN | null;
};

export type NecessaryOrderParams = {
	orderType: OrderType;
	marketIndex: BN;
	baseAssetAmount: BN;
	direction: PositionDirection;
};

export type OptionalOrderParams = {
	[Property in keyof OrderParams]?: OrderParams[Property];
} & NecessaryOrderParams;

export const DefaultOrderParams = {
	orderType: OrderType.MARKET,
	marketType: MarketType.PERP,
	userOrderId: 0,
	direction: PositionDirection.LONG,
	baseAssetAmount: ZERO,
	price: ZERO,
	marketIndex: ZERO,
	reduceOnly: false,
	postOnly: false,
	immediateOrCancel: false,
	triggerPrice: ZERO,
	triggerCondition: OrderTriggerCondition.ABOVE,
	positionLimit: ZERO,
	oraclePriceOffset: ZERO,
	auctionDuration: null,
	timeInForce: null,
	auctionStartPrice: null,
};

export type MakerInfo = {
	maker: PublicKey;
	makerStats: PublicKey;
	order: Order;
};

export type TakerInfo = {
	taker: PublicKey;
	takerStats: PublicKey;
	takerUserAccount: UserAccount;
	order: Order;
};

export type ReferrerInfo = {
	referrer: PublicKey;
	referrerStats: PublicKey;
};

// # Misc Types
export interface IWallet {
	signTransaction(tx: Transaction): Promise<Transaction>;
	signAllTransactions(txs: Transaction[]): Promise<Transaction[]>;
	publicKey: PublicKey;
}

export type FeeStructure = {
	feeTiers: FeeTier[];
	makerRebateNumerator: BN;
	makerRebateDenominator: BN;
	fillerRewardStructure: OrderFillerRewardStructure;
	flatFillerFee: BN;
	referrerRewardEpochUpperBound: BN;
};

export type FeeTier = {
	feeNumerator: number;
	feeDenominator: number;
	makerRebateNumerator: number;
	makerRebateDenominator: number;
	referrerRewardNumerator: number;
	referrerRewardDenominator: number;
	refereeFeeNumerator: number;
	refereeFeeDenominator: number;
};

export type OrderFillerRewardStructure = {
	rewardNumerator: BN;
	rewardDenominator: BN;
	timeBasedRewardLowerBound: BN;
};

export type OracleGuardRails = {
	priceDivergence: {
		markOracleDivergenceNumerator: BN;
		markOracleDivergenceDenominator: BN;
	};
	validity: {
		slotsBeforeStale: BN;
		confidenceIntervalMaxSize: BN;
		tooVolatileRatio: BN;
	};
	useForLiquidations: boolean;
};

export type MarginCategory = 'Initial' | 'Maintenance';

export type InsuranceFundStake = {
	marketIndex: BN;
	authority: PublicKey;

	ifShares: BN;
	ifBase: BN;

	lastWithdrawRequestShares: BN;
	lastWithdrawRequestValue: BN;
	lastWithdrawRequestTs: BN;
};

export type SerumV3FulfillmentConfigAccount = {
	fulfillmentType: SpotFulfillmentType;
	status: SpotFulfillmentStatus;
	pubkey: PublicKey;
	marketIndex: BN;
	serumProgramId: PublicKey;
	serumMarket: PublicKey;
	serumRequestQueue: PublicKey;
	serumEventQueue: PublicKey;
	serumBids: PublicKey;
	serumAsks: PublicKey;
	serumBaseVault: PublicKey;
	serumQuoteVault: PublicKey;
	serumOpenOrders: PublicKey;
	serumSignerNonce: BN;
};
