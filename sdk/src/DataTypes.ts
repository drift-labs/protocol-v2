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
	totalPotentialFee: BN;
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
	fundingPaymentHistory: PublicKey;
	tradeHistory: PublicKey;
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
		quoteAssetNotionalAmount: BN;
		baseAssetVolume: BN;
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
};

export type TradeHistoryAccount = {
	head: BN;
	tradeRecords: TradeRecord[];
};

export type FundingRateRecord = {
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

export type FundingHistoryAccountData = {
	head: BN;
	fundingRateRecords: FundingRateRecord[];
};
