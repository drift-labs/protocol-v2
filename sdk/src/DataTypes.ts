import { PublicKey } from '@solana/web3.js';
import { BN } from '@project-serum/anchor';

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

export type ClearingHouseState = {
	admin: PublicKey;
	adminControlsPrices: boolean;
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
	feeNumerator: BN;
	feeDenominator: BN;
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
			fundingPeriod: BN;
			quoteAssetReserve: BN;
			pegMultiplier: BN;
			cumulativeFundingRateLong: BN;
			cumulativeFundingRateShort: BN;
			cumulativeRepegRebateLong: BN;
			cumulativeRepegRebateShort: BN;
			cumulativeFeeRealized: BN;
			cumulativeFee: BN;
		};
		baseAssetAmount: BN;
		baseAssetAmountLong: BN;
		baseAssetAmountShort: BN;
		initialized: boolean;
		openInterest: BN;
	}[];
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
	marketIndex: BN;
	liquidation: false;
};

export type TradeHistoryAccount = {
	head: BN;
	tradeRecords: TradeRecord[];
};

export type FundingPaymentHistory = {
	head: BN;
	fundingPaymentRecords: FundingPaymentRecord[];
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
	ammCumulativeFunding: BN;
};

export type FundingRateHistory = {
	head: BN;
	fundingRateRecords: FundingRateRecord[];
};

export type FundingRateRecord = {
	ts: BN;
	recordId: BN;
	marketIndex: BN;
	fundingRate: BN;
	cumulativeFundingRate: BN;
	oraclePriceTwap: BN;
	markPriceTwap: BN;
};

export type LiquidationHistory = {
	head: BN;
	liquidationRecords: LiquidationRecord[];
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

export type DepositHistory = {
	head: BN;
	depositRecords: DepositRecord[];
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
