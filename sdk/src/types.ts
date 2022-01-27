import { PublicKey, Transaction } from '@solana/web3.js';
import BN from 'bn.js';

// # Utility Types / Enums / Constants
export class SwapDirection {
	static readonly ADD = { add: {} };
	static readonly REMOVE = { remove: {} };
}
export class PositionDirection {
	static readonly LONG = { long: {} };
	static readonly SHORT = { short: {} };
}

export class OracleSource {
	static readonly PYTH = { pyth: {} };
	static readonly SWITCHBOARD = { switchboard: {} };
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

// # ClearingHouse Account Types
export type TradeHistoryAccount = {
	head: BN;
	tradeRecords: TradeRecord[];
};

export type DepositHistoryAccount = {
	head: BN;
	depositRecords: DepositRecord[];
};

export type ExtendedCurveHistoryAccount = {
	head: BN;
	curveRecords: ExtendedCurveRecord[];
};

export type FundingRateHistoryAccount = {
	head: BN;
	fundingRateRecords: FundingRateRecord[];
};

export type FundingPaymentHistoryAccount = {
	head: BN;
	fundingPaymentRecords: FundingPaymentRecord[];
};

export type LiquidationHistoryAccount = {
	head: BN;
	liquidationRecords: LiquidationRecord[];
};

export type DepositRecord = {
	ts: BN;
	recordId: BN;
	userAuthority: PublicKey;
	user: PublicKey;
	direction: {
		deposit?: any;
		withdraw?: any;
	};
	collateralBefore: BN;
	cumulativeDepositsBefore: BN;
	amount: BN;
};

export type ExtendedCurveRecord = {
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

export type TradeRecord = {
	ts: BN;
	recordId: BN;
	userAuthority: PublicKey;
	user: PublicKey;
	direction: {
		long?: any;
		short?: any;
	};
	baseAssetAmount: BN;
	quoteAssetAmount: BN;
	markPriceBefore: BN;
	markPriceAfter: BN;
	fee: BN;
	referrerReward: BN;
	refereeDiscount: BN;
	tokenDiscount: BN;
	marketIndex: BN;
	liquidation: boolean;
	oraclePrice: BN;
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
	recordId: BN;
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
	recordId: BN;
	userAuthority: PublicKey;
	user: PublicKey;
	partial: boolean;
	baseAssetValue: BN;
	baseAssetValueClosed: BN;
	liquidationFee: BN;
	feeToLiquidator: BN;
	feeToInsuranceFund: BN;
	liquidator: PublicKey;
	totalCollateral: BN;
	collateral: BN;
	unrealizedPnl: BN;
	marginRatio: BN;
};

export type StateAccount = {
	admin: PublicKey;
	fundingPaused: boolean;
	exchangePaused: boolean;
	adminControlsPrices: boolean;
	collateralMint: PublicKey;
	collateralVault: PublicKey;
	collateralVaultAuthority: PublicKey;
	collateralVaultNonce: number;
	insuranceVault: PublicKey;
	insuranceVaultAuthority: PublicKey;
	insuranceVaultNonce: number;
	marginRatioInitial: BN;
	marginRatioMaintenance: BN;
	marginRatioPartial: BN;
	markets: PublicKey;
	curveHistory: PublicKey;
	depositHistory: PublicKey;
	fundingRateHistory: PublicKey;
	fundingPaymentHistory: PublicKey;
	tradeHistory: PublicKey;
	liquidationHistory: PublicKey;
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
	extendedCurveHistory: PublicKey;
};

export type MarketsAccount = {
	accountIndex: BN;
	markets: Market[];
};

export type Market = {
	amm: AMM;
	baseAssetAmount: BN;
	baseAssetAmountLong: BN;
	baseAssetAmountShort: BN;
	initialized: boolean;
	openInterest: BN;
};

export type AMM = {
	baseAssetReserve: BN;
	sqrtK: BN;
	cumulativeFundingRate: BN;
	lastFundingRate: BN;
	lastFundingRateTs: BN;
	lastMarkPriceTwap: BN;
	lastMarkPriceTwapTs: BN;
	lastOraclePriceTwap: BN;
	lastOraclePriceTwapTs: BN;
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
	minimumTradeSize: BN;
};

// # User Account Types
export type UserPosition = {
	baseAssetAmount: BN;
	lastCumulativeFundingRate: BN;
	marketIndex: BN;
	quoteAssetAmount: BN;
};

export type UserPositionsAccount = {
	positions: UserPosition[];
	user: PublicKey;
};

export type UserAccount = {
	authority: PublicKey;
	collateral: BN;
	cumulativeDeposits: BN;
	positions: PublicKey;
	totalFeePaid: BN;
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
