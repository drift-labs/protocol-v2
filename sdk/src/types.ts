import { PublicKey, Transaction } from '@solana/web3.js';
import { BN, ZERO } from '.';

// # Utility Types / Enums / Constants
export class SwapDirection {
	static readonly ADD = { add: {} };
	static readonly REMOVE = { remove: {} };
}

export class BankBalanceType {
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
	static readonly BREACHED_MARGIN_REQUIREMENT = {
		breachedMarginRequirement: {},
	};
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

export function isVariant(object: unknown, type: string) {
	return object.hasOwnProperty(type);
}

export function isOneOfVariant(object: unknown, types: string[]) {
	return types.reduce((result, type) => {
		return result || object.hasOwnProperty(type);
	}, false);
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

export type DepositRecord = {
	ts: BN;
	userAuthority: PublicKey;
	user: PublicKey;
	direction: {
		deposit?: any;
		withdraw?: any;
	};
	bankIndex: BN;
	amount: BN;
	oraclePrice: BN;
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

export type FundingRateRecord = {
	ts: BN;
	recordId: BN;
	marketIndex: BN;
	fundingRate: BN;
	cumulativeFundingRateLong: BN;
	cumulativeFundingRateShort: BN;
	oraclePriceTwap: BN;
	markPriceTwap: BN;
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
	liquidatePerp: LiquidatePerpRecord;
	liquidateBorrow: LiquidateBorrowRecord;
	liquidateBorrowForPerpPnl: LiquidateBorrowForPerpPnlRecord;
	liquidatePerpPnlForDeposit: LiquidatePerpPnlForDepositRecord;
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
}

export type LiquidatePerpRecord = {
	marketIndex: BN;
	orderIds: BN[];
	oraclePrice: BN;
	baseAssetAmount: BN;
	quoteAssetAmount: BN;
	userPnl: BN;
	liquidatorPnl: BN;
	canceledOrdersFee: BN;
	userOrderId: BN;
	liquidatorOrderId: BN;
	fillRecordId: BN;
};

export type LiquidateBorrowRecord = {
	assetBankIndex: BN;
	assetPrice: BN;
	assetTransfer: BN;
	liabilityBankIndex: BN;
	liabilityPrice: BN;
	liabilityTransfer: BN;
};

export type LiquidateBorrowForPerpPnlRecord = {
	marketIndex: BN;
	marketOraclePrice: BN;
	pnlTransfer: BN;
	liabilityBankIndex: BN;
	liabilityPrice: BN;
	liabilityTransfer: BN;
};

export type LiquidatePerpPnlForDepositRecord = {
	marketIndex: BN;
	marketOraclePrice: BN;
	pnlTransfer: BN;
	assetBankIndex: BN;
	assetPrice: BN;
	assetTransfer: BN;
};

export type SettlePnlRecord = {
	ts: BN;
	marketIndex: BN;
	pnl: BN;
	baseAssetAmount: BN;
	quoteAssetAmountAfter: BN;
	quoteEntryamount: BN;
	oraclePrice: BN;
};

export type OrderRecord = {
	ts: BN;
	taker: PublicKey;
	maker: PublicKey;
	takerOrder: Order;
	makerOrder: Order;
	takerPnl: BN;
	makerPnl: BN;
	action: OrderAction;
	actionExplanation: OrderActionExplanation;
	filler: PublicKey;
	fillRecordId: BN;
	marketIndex: BN;
	baseAssetAmountFilled: BN;
	quoteAssetAmountFilled: BN;
	makerRebate: BN;
	takerFee: BN;
	fillerReward: BN;
	quoteAssetAmountSurplus: BN;
	oraclePrice: BN;
};

export type StateAccount = {
	admin: PublicKey;
	fundingPaused: boolean;
	exchangePaused: boolean;
	adminControlsPrices: boolean;
	insuranceVault: PublicKey;
	insuranceVaultAuthority: PublicKey;
	insuranceVaultNonce: number;
	marginRatioInitial: BN;
	marginRatioMaintenance: BN;
	marginRatioPartial: BN;
	partialLiquidationClosePercentageNumerator: BN;
	partialLiquidationClosePercentageDenominator: BN;
	partialLiquidationPenaltyPercentageNumerator: BN;
	partialLiquidationPenaltyPercentageDenominator: BN;
	fullLiquidationPenaltyPercentageNumerator: BN;
	fullLiquidationPenaltyPercentageDenominator: BN;
	partialLiquidationLiquidatorShareDenominator: BN;
	fullLiquidationLiquidatorShareDenominator: BN;
	feeStructure: FeeStructure;
	totalFee: BN;
	totalFeeWithdrawn: BN;
	whitelistMint: PublicKey;
	discountMint: PublicKey;
	oracleGuardRails: OracleGuardRails;
	maxDeposit: BN;
	numberOfMarkets: BN;
	numberOfBanks: BN;
	minOrderQuoteAssetAmount: BN;
};

export type MarketAccount = {
	initialized: boolean;
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
	liquidationFee: BN;
	imfFactor: BN;
	unsettledImfFactor: BN;
	unsettledInitialAssetWeight: number;
	unsettledMaintenanceAssetWeight: number;
};

export type BankAccount = {
	bankIndex: BN;
	pubkey: PublicKey;
	mint: PublicKey;
	vault: PublicKey;
	vaultAuthority: PublicKey;
	vaultAuthorityNonce: number;
	decimals: number;
	optimalUtilization: BN;
	optimalBorrowRate: BN;
	maxBorrowRate: BN;
	cumulativeDepositInterest: BN;
	cumulativeBorrowInterest: BN;
	depositBalance: BN;
	borrowBalance: BN;
	lastUpdated: BN;
	oracle: PublicKey;
	initialAssetWeight: BN;
	maintenanceAssetWeight: BN;
	initialLiabilityWeight: BN;
	maintenanceLiabilityWeight: BN;
	liquidationFee: BN;
	imfFactor: BN;

	withdrawGuardThreshold: BN;
	depositTokenTwap: BN;
	borrowTokenTwap: BN;
	utilizationTwap: BN;
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
	cumulativeRepegRebateLong: BN;
	cumulativeRepegRebateShort: BN;
	totalFeeMinusDistributions: BN;
	totalFeeWithdrawn: BN;
	totalFee: BN;
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
	lastBidPriceTwap: BN;
	lastAskPriceTwap: BN;
	longSpread: BN;
	shortSpread: BN;
	maxSpread: number;
};

// # User Account Types
export type UserPosition = {
	baseAssetAmount: BN;
	lastCumulativeFundingRate: BN;
	marketIndex: BN;
	quoteAssetAmount: BN;
	quoteEntryAmount: BN;
	openOrders: BN;
	openBids: BN;
	openAsks: BN;
};

export type UserAccount = {
	authority: PublicKey;
	name: number[];
	userId: number;
	bankBalances: UserBankBalance[];
	collateral: BN;
	cumulativeDeposits: BN;
	fees: {
		totalFeePaid: BN;
		totalFeeRebate: BN;
		totalTokenDiscount: BN;
		totalReferralReward: BN;
		totalRefereeDiscount: BN;
	};
	positions: UserPosition[];
	orders: Order[];
	beingLiquidated: boolean;
	nextLiquidationId: number;
};

export type UserBankBalance = {
	bankIndex: BN;
	balanceType: BankBalanceType;
	balance: BN;
};

export type Order = {
	status: OrderStatus;
	orderType: OrderType;
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
	discountTier: OrderDiscountTier;
	existingPositionDirection: PositionDirection;
	referrer: PublicKey;
	postOnly: boolean;
	immediateOrCancel: boolean;
	oraclePriceOffset: BN;
	auctionDuration: number;
	auctionStartPrice: BN;
	auctionEndPrice: BN;
};

export type OrderParams = {
	orderType: OrderType;
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
	padding0: boolean;
	padding1: BN;
	optionalAccounts: {
		discountToken: boolean;
		referrer: boolean;
	};
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
	padding0: ZERO,
	padding1: ZERO,
	optionalAccounts: {
		discountToken: false,
		referrer: false,
	},
};

export type MakerInfo = {
	maker: PublicKey;
	order: Order;
};

export type TakerInfo = {
	taker: PublicKey;
	order: Order;
};

// # Misc Types
export interface IWallet {
	signTransaction(tx: Transaction): Promise<Transaction>;
	signAllTransactions(txs: Transaction[]): Promise<Transaction[]>;
	publicKey: PublicKey;
}

export type FeeStructure = {
	feeNumerator: BN;
	feeDenominator: BN;
	discountTokenTiers: {
		firstTier: {
			minimumBalance: BN;
			discountNumerator: BN;
			discountDenominator: BN;
		};
		secondTier: {
			minimumBalance: BN;
			discountNumerator: BN;
			discountDenominator: BN;
		};
		thirdTier: {
			minimumBalance: BN;
			discountNumerator: BN;
			discountDenominator: BN;
		};
		fourthTier: {
			minimumBalance: BN;
			discountNumerator: BN;
			discountDenominator: BN;
		};
	};
	referralDiscount: {
		referrerRewardNumerator: BN;
		referrerRewardDenominator: BN;
		refereeDiscountNumerator: BN;
		refereeDiscountDenominator: BN;
	};
	makerRebateNumerator: BN;
	makerRebateDenominator: BN;
	fillerRewardStructure: OrderFillerRewardStructure;
	cancelOrderFee: BN;
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

export type OrderFillerRewardStructure = {
	rewardNumerator: BN;
	rewardDenominator: BN;
	timeBasedRewardLowerBound: BN;
};

export type MarginCategory = 'Initial' | 'Maintenance';
