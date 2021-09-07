import { PublicKey } from '@solana/web3.js';
import { BN } from '@project-serum/anchor';

export type UserPosition = {
	baseAssetAmount: BN;
	lastCumFunding: BN;
	marketIndex: BN;
	quoteAssetNotionalAmount: BN;
};

export type UserPositionData = {
	positions: UserPosition[];
	userAccount: PublicKey;
};

export type UserAccountData = {
	authority: PublicKey;
	collateral: BN;
	creationTs: BN;
	initialPurchase: BN;
	positions: PublicKey;
	totalPotentualFee: BN;
};

export type ClearingHouseState = {
	admin: PublicKey;
	adminControlsPrices: boolean;
	collateralAccount: PublicKey;
	collateralAccountAuthority: PublicKey;
	collateralAccountNonce: number;
	insuranceAccount: PublicKey;
	insuranceAccountAuthority: PublicKey;
	insuranceAccountNonce: number;
	marginRatioInitial: BN;
	marginRatioMaintenence: BN;
	marginRatioPartial: BN;
	marketsAccount: PublicKey;
	fundingRateHistory: PublicKey;
	tradeHistoryAccount: PublicKey;
};

export type ClearingHouseMarketsAccountData = {
	accountIndex: BN;
	markets: {
		amm: {
			baseAssetAmount: BN;
			baseAssetAmountI: BN;
			cumFundingRate: BN;
			fundingRate: BN;
			fundingRateTs: BN;
			markTwap: BN;
			markTwapTs: BN;
			oracle: PublicKey;
			periodicity: BN;
			quoteAssetAmount: BN;
			spreadThreshold: BN;
			volume1: BN;
			volume2: BN;
			pegMultiplier: BN;
			k: BN;
			cumLongFundingRate: BN;
			cumShortFundingRate: BN;
			cumLongRepegProfit: BN;
			cumShortRepegProfit: BN;
			cumSlippageProfit: BN;
			cumSlippage: BN;
		};
		baseAssetAmount: BN;
		baseAssetAmountLong: BN;
		baseAssetAmountShort: BN;
		creationTs: BN;
		initialized: boolean;
		openInterest: BN;
		quoteAssetNotionalAmount: BN;
		baseAssetVolume: BN;
		pegQuoteAssetVolume: BN;
		volumeArb: BN;
	}[];
};

export type TradeRecord = {
	ts: BN;
	recordId: BN;
	userPublicKey: PublicKey;
	userClearingHousePublicKey: PublicKey;
	direction: {
		long?: any;
		short?: any;
	};
	baseAssetAmount: BN;
	quoteAssetNotionalAmount: BN;
	baseAssetPriceWithMantissaBefore: BN;
	baseAssetPriceWithMantissaAfter: BN;
	marketIndex: BN;
};

export type TradeHistoryAccount = {
	head: BN;
	tradeRecords: TradeRecord[];
};

export type FundingRateRecord = {
	ts: BN;
	recordId: BN;
	userPublicKey: PublicKey;
	userClearingHousePublicKey: PublicKey;
	marketIndex: BN;
	fundingRatePayment: BN;
	baseAssetAmount: BN;
	userLastCumulativeFunding: BN;
	ammCumulativeFunding: BN;
};

export type FundingHistoryAccountData = {
	head: BN;
	fundingRateRecords: FundingRateRecord[];
};
