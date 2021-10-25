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

export type DepositHistory = {
	head: BN;
	depositRecords: DepositRecord[];
};

export type CurveHistory = {
	head: BN;
	depositRecords: CurveRecord[];
};

export type FundingRateHistory = {
	head: BN;
	fundingRateRecords: FundingRateRecord[];
};

export type FundingPaymentHistory = {
	head: BN;
	fundingPaymentRecords: FundingPaymentRecord[];
};

export type LiquidationHistory = {
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

export type ClearingHouseState = {
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
};

export type ClearingHouseMarketsAccountData = {
	accountIndex: BN;
	markets: {
		amm: {
			baseAssetReserve: BN;
			sqrtK: BN;
			cumulativeFundingRate: BN;
			lastFundingRate: BN;
			lastFundingRateTs: BN;
			lastMarkPriceTwap: BN;
			lastMarkPriceTwapTs: BN;
			oracle: PublicKey;
			oracleSource: OracleSource;
			fundingPeriod: BN;
			quoteAssetReserve: BN;
			pegMultiplier: BN;
			cumulativeFundingRateLong: BN;
			cumulativeFundingRateShort: BN;
			cumulativeRepegRebateLong: BN;
			cumulativeRepegRebateShort: BN;
			cumulativeFee: BN;
			totalFee: BN;
			minimumTradeSize: BN;
		};
		baseAssetAmount: BN;
		baseAssetAmountLong: BN;
		baseAssetAmountShort: BN;
		initialized: boolean;
		openInterest: BN;
	}[];
};

// # User Account Types
export type UserPosition = {
	baseAssetAmount: BN;
	lastCumulativeFundingRate: BN;
	marketIndex: BN;
	quoteAssetAmount: BN;
};

export type UserPositionData = {
	positions: UserPosition[];
	user: PublicKey;
};

export type UserAccountData = {
	authority: PublicKey;
	collateral: BN;
	cumulativeDeposits: BN;
	positions: PublicKey;
	totalFeePaid: BN;
};

// # UI ↔ History Server Data Types
export interface Trade {
	price: number;
	beforePrice: number;
	afterPrice: number;
	side: TradeSide;
	size: number;
	ts: number;
	marketIndex: number;
	chainTs: number;
}

export type Liquidation = {
	ts: number;
	chainTs: number;
	recordId: number;
	userAuthority: PublicKey;
	user: PublicKey;
	partial: boolean;
	baseAssetValue: number;
	baseAssetValueClosed: number;
	liquidationFee: number;
	feeToLiquidator: number;
	feeToInsuranceFund: number;
	liquidator: PublicKey;
	totalCollateral: number;
	collateral: number;
	unrealizedPnl: number;
	marginRatio: number;
};

export type Candle = {
	open: number;
	close: number;
	high: number;
	low: number;
	volume: number;
	start: number;
	end: number;
};
export interface FundingPayment {
	userPublicKey: string;
	ts: number;
	marketIndex: number;
	amount: string;
}

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
		markOracleDivergenceNumerator: BN,
		markOracleDivergenceDenominator: BN,
	},
	validity: {
		slotsBeforeStale: BN,
		confidenceIntervalMaxSize: BN,
		tooVolatileRatio: BN,
	},
	useForLiquidations: boolean,
};
