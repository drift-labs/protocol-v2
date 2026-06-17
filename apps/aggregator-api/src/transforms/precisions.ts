import { SerializedMarketFilter, TradeRecord } from '@backend/common';
import {
	AMM_RESERVE_PRECISION,
	BASE_PRECISION,
	FUNDING_RATE_PRECISION,
	PERCENTAGE_PRECISION,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	SPOT_MARKET_BALANCE_PRECISION,
	SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION,
	initialize,
} from '../sdk';
import { TransformConfig } from '../types';

const { SPOT_MARKETS } = initialize({ env: process.env.ENV ?? 'mainnet-beta' });

const needsPrecisionFix = (value: any): boolean => {
	if (typeof value !== 'number') return false;
	return true;
};

const getPrecision = (field: keyof typeof PRECISION_MAP, record: any): number | undefined => {
	const precisionValue = PRECISION_MAP[field];
	if (typeof precisionValue === 'function') {
		return precisionValue(record);
	}
	return precisionValue;
};

const formatWithPrecision = (value: number, precision: number) => {
	return Number(value).toFixed(precision);
};

const getPrecisionExp = (precision: any) => {
	return Math.log10(precision.toNumber());
};

const processFieldWithPrecision = (value: any, field: keyof typeof PRECISION_MAP, record: any) => {
	if (!needsPrecisionFix(value)) return value;
	const precision = getPrecision(field, record);
	if (precision) return formatWithPrecision(value, precision);
	return value;
};

const processObjectFields = (obj: any) => {
	const result = { ...obj };
	for (const key in obj) {
		const field = key as keyof typeof PRECISION_MAP;
		if (PRECISION_MAP[field] === undefined) continue;
		const value = obj[key];
		result[key] = processFieldWithPrecision(value, field, obj);
	}
	return result;
};

export const PRECISION_MAP = {
	// Common Fields
	amount: (record: any) => {
		if (record.spotMarketIndex !== undefined) {
			const precision =
				SPOT_MARKETS.find((x) => x.marketIndex === Number(record.spotMarketIndex))
					?.precision ?? BASE_PRECISION;
			return getPrecisionExp(precision);
		}

		const precision =
			SPOT_MARKETS.find((x) => x.marketIndex === Number(record.marketIndex))?.precision ??
			BASE_PRECISION;
		return getPrecisionExp(precision);
	},

	baseAssetAmount: (record: any) => {
		if (record.marketType === SerializedMarketFilter.SPOT) {
			const precision =
				SPOT_MARKETS.find((x) => x.marketIndex === Number(record.marketIndex))?.precision ??
				BASE_PRECISION;
			return getPrecisionExp(precision);
		}
		return getPrecisionExp(BASE_PRECISION);
	},
	baseClosedForPnl: (record: any) => {
		if (record.marketType === SerializedMarketFilter.SPOT) {
			const precision =
				SPOT_MARKETS.find((x) => x.marketIndex === Number(record.marketIndex))?.precision ??
				BASE_PRECISION;
			return getPrecisionExp(precision);
		}
		return getPrecisionExp(BASE_PRECISION);
	},
	baseAssetAmountFilled: (record: any) => {
		if (record.marketType === SerializedMarketFilter.SPOT) {
			const precision =
				SPOT_MARKETS.find((x) => x.marketIndex === Number(record.marketIndex))?.precision ??
				BASE_PRECISION;
			return getPrecisionExp(precision);
		}
		return getPrecisionExp(BASE_PRECISION);
	},
	fee: (record: any) => {
		if (record.lpPool) {
			return getPrecisionExp(QUOTE_PRECISION);
		}

		const precision =
			SPOT_MARKETS.find((x) => x.marketIndex === Number(record.outMarketIndex))?.precision ??
			BASE_PRECISION;
		return getPrecisionExp(precision);
	},
	quoteAssetAmountFilled: getPrecisionExp(QUOTE_PRECISION),
	oraclePrice: getPrecisionExp(PRICE_PRECISION),
	settledPnl: getPrecisionExp(QUOTE_PRECISION),
	liquidationPrice: getPrecisionExp(QUOTE_PRECISION),
	feesAndFunding: getPrecisionExp(QUOTE_PRECISION),

	// Order Record Fields
	price: getPrecisionExp(PRICE_PRECISION),
	quoteAssetAmount: getPrecisionExp(QUOTE_PRECISION),
	triggerPrice: getPrecisionExp(PRICE_PRECISION),
	oraclePriceOffset: getPrecisionExp(PRICE_PRECISION),
	auctionStartPrice: getPrecisionExp(PRICE_PRECISION),
	auctionEndPrice: getPrecisionExp(PRICE_PRECISION),
	cumulativeFee: getPrecisionExp(QUOTE_PRECISION),

	// Order Action/Trade Record Fields
	fillerReward: getPrecisionExp(QUOTE_PRECISION),
	quoteAssetAmountSurplus: getPrecisionExp(QUOTE_PRECISION),
	takerFee: getPrecisionExp(QUOTE_PRECISION),
	makerFee: getPrecisionExp(QUOTE_PRECISION),
	userFee: getPrecisionExp(QUOTE_PRECISION),
	makerRebate: getPrecisionExp(QUOTE_PRECISION),
	referrerReward: getPrecisionExp(QUOTE_PRECISION),
	takerOrderBaseAssetAmount: (record: TradeRecord) => {
		if (record.marketType === SerializedMarketFilter.SPOT) {
			const precision =
				SPOT_MARKETS.find((x) => x.marketIndex === Number(record.marketIndex))?.precision ??
				BASE_PRECISION;
			return getPrecisionExp(precision);
		}
		return getPrecisionExp(BASE_PRECISION);
	},
	takerOrderCumulativeBaseAssetAmountFilled: (record: TradeRecord) => {
		if (record.marketType === SerializedMarketFilter.SPOT) {
			const precision =
				SPOT_MARKETS.find((x) => x.marketIndex === Number(record.marketIndex))?.precision ??
				BASE_PRECISION;
			return getPrecisionExp(precision);
		}
		return getPrecisionExp(BASE_PRECISION);
	},
	takerOrderCumulativeQuoteAssetAmountFilled: getPrecisionExp(QUOTE_PRECISION),
	makerOrderBaseAssetAmount: (record: TradeRecord) => {
		if (record.marketType === SerializedMarketFilter.SPOT) {
			const precision =
				SPOT_MARKETS.find((x) => x.marketIndex === Number(record.marketIndex))?.precision ??
				BASE_PRECISION;
			return getPrecisionExp(precision);
		}
		return getPrecisionExp(BASE_PRECISION);
	},
	makerOrderCumulativeBaseAssetAmountFilled: (record: TradeRecord) => {
		if (record.marketType === SerializedMarketFilter.SPOT) {
			const precision =
				SPOT_MARKETS.find((x) => x.marketIndex === Number(record.marketIndex))?.precision ??
				BASE_PRECISION;
			return getPrecisionExp(precision);
		}
		return getPrecisionExp(BASE_PRECISION);
	},
	makerOrderCumulativeQuoteAssetAmountFilled: getPrecisionExp(QUOTE_PRECISION),
	spotFulfillmentMethodFee: getPrecisionExp(QUOTE_PRECISION),

	// Swap Record Fields
	amountIn: (record: any) => {
		const precision =
			SPOT_MARKETS.find((x) => x.marketIndex === Number(record.inMarketIndex))?.precision ??
			BASE_PRECISION;
		return getPrecisionExp(precision);
	},
	amountOut: (record: any) => {
		const precision =
			SPOT_MARKETS.find((x) => x.marketIndex === Number(record.outMarketIndex))?.precision ??
			BASE_PRECISION;
		return getPrecisionExp(precision);
	},
	outOraclePrice: getPrecisionExp(PRICE_PRECISION),
	inOraclePrice: getPrecisionExp(PRICE_PRECISION),

	// Settle PNL Record Fields
	pnl: getPrecisionExp(QUOTE_PRECISION),
	quoteAssetAmountAfter: getPrecisionExp(QUOTE_PRECISION),
	quoteEntryAmount: getPrecisionExp(QUOTE_PRECISION),
	userExistingQuoteEntryAmount: getPrecisionExp(QUOTE_PRECISION),
	takerExistingQuoteEntryAmount: getPrecisionExp(QUOTE_PRECISION),
	makerExistingQuoteEntryAmount: getPrecisionExp(QUOTE_PRECISION),
	settlePrice: getPrecisionExp(QUOTE_PRECISION),

	// Deposit Record Fields
	marketDepositBalance: getPrecisionExp(SPOT_MARKET_BALANCE_PRECISION),
	marketWithdrawBalance: getPrecisionExp(SPOT_MARKET_BALANCE_PRECISION),
	marketCumulativeDepositInterest: getPrecisionExp(SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION),
	marketCumulativeBorrowInterest: getPrecisionExp(SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION),
	totalDepositsAfter: getPrecisionExp(QUOTE_PRECISION),
	totalWithdrawsAfter: getPrecisionExp(QUOTE_PRECISION),

	// LP Record Fields
	nShares: getPrecisionExp(AMM_RESERVE_PRECISION),
	lpShares: getPrecisionExp(AMM_RESERVE_PRECISION),
	deltaBaseAssetAmount: getPrecisionExp(BASE_PRECISION),
	deltaQuoteAssetAmount: getPrecisionExp(QUOTE_PRECISION),

	// Funding Rate Fields
	fundingRate: getPrecisionExp(FUNDING_RATE_PRECISION),
	fundingRateLong: getPrecisionExp(FUNDING_RATE_PRECISION),
	fundingRateShort: getPrecisionExp(FUNDING_RATE_PRECISION),
	cumulativeFundingRateLong: getPrecisionExp(FUNDING_RATE_PRECISION),
	cumulativeFundingRateShort: getPrecisionExp(FUNDING_RATE_PRECISION),
	oraclePriceTwap: getPrecisionExp(PRICE_PRECISION),
	markPriceTwap: getPrecisionExp(PRICE_PRECISION),
	periodRevenue: getPrecisionExp(QUOTE_PRECISION),
	baseAssetAmountWithAmm: getPrecisionExp(BASE_PRECISION),
	baseAssetAmountWithUnsettledLp: getPrecisionExp(BASE_PRECISION),

	// Funding Payment Fields
	fundingPayment: getPrecisionExp(QUOTE_PRECISION),
	userLastCumulativeFunding: getPrecisionExp(FUNDING_RATE_PRECISION),
	ammCumulativeFundingLong: getPrecisionExp(FUNDING_RATE_PRECISION),
	ammCumulativeFundingShort: getPrecisionExp(FUNDING_RATE_PRECISION),

	// Insurance Fund Fields
	ifSharesBefore: getPrecisionExp(QUOTE_PRECISION),
	ifSharesAfter: getPrecisionExp(QUOTE_PRECISION),
	userIfSharesBefore: getPrecisionExp(QUOTE_PRECISION),
	userIfSharesAfter: getPrecisionExp(QUOTE_PRECISION),
	totalIfSharesBefore: getPrecisionExp(QUOTE_PRECISION),
	totalIfSharesAfter: getPrecisionExp(QUOTE_PRECISION),
	insuranceVaultAmountBefore: (record: any) => {
		const precision =
			SPOT_MARKETS.find((x) => x.marketIndex === Number(record.marketIndex))?.precision ??
			QUOTE_PRECISION;
		return getPrecisionExp(precision);
	},
	vaultAmountBefore: (record: any) => {
		const precision =
			SPOT_MARKETS.find((x) => x.marketIndex === Number(record.spotMarketIndex))?.precision ??
			QUOTE_PRECISION;
		return getPrecisionExp(precision);
	},

	// Liquidation Fields
	marginRequirement: getPrecisionExp(QUOTE_PRECISION),
	totalCollateral: getPrecisionExp(QUOTE_PRECISION),

	marginFreed: getPrecisionExp(QUOTE_PRECISION),
	liquidatePerp_baseAssetAmount: getPrecisionExp(BASE_PRECISION),
	liquidatePerp_quoteAssetAmount: getPrecisionExp(QUOTE_PRECISION),
	liquidatePerp_oraclePrice: getPrecisionExp(PRICE_PRECISION),
	liquidatePerp_liquidatorFee: getPrecisionExp(QUOTE_PRECISION),
	liquidatePerp_ifFee: getPrecisionExp(QUOTE_PRECISION),
	liquidatePerp_lpShares: getPrecisionExp(AMM_RESERVE_PRECISION),
	liquidateSpot_assetPrice: getPrecisionExp(PRICE_PRECISION),
	liquidateSpot_liabilityPrice: getPrecisionExp(PRICE_PRECISION),
	liquidateSpot_liabilityTransfer: (record: any) => {
		const precision =
			SPOT_MARKETS.find(
				(x) => x.marketIndex === Number(record.liquidateSpot_liabilityMarketIndex)
			)?.precision ?? BASE_PRECISION;
		return getPrecisionExp(precision);
	},
	liquidateSpot_ifFee: getPrecisionExp(BASE_PRECISION),
	liquidateSpot_assetTransfer: (record: any) => {
		const precision =
			SPOT_MARKETS.find(
				(x) => x.marketIndex === Number(record.liquidateSpot_assetMarketIndex)
			)?.precision ?? BASE_PRECISION;
		return getPrecisionExp(precision);
	},
	liquidateBorrowForPerpPnl_marketOraclePrice: getPrecisionExp(PRICE_PRECISION),
	liquidateBorrowForPerpPnl_pnlTransfer: getPrecisionExp(QUOTE_PRECISION),
	liquidateBorrowForPerpPnl_liabilityTransfer: getPrecisionExp(QUOTE_PRECISION),
	liquidateBorrowForPerpPnl_liabilityPrice: getPrecisionExp(PRICE_PRECISION),
	liquidatePerpPnlForDeposit_marketOraclePrice: getPrecisionExp(PRICE_PRECISION),
	liquidatePerpPnlForDeposit_pnlTransfer: getPrecisionExp(QUOTE_PRECISION),
	liquidatePerpPnlForDeposit_assetPrice: getPrecisionExp(PRICE_PRECISION),
	liquidatePerpPnlForDeposit_assetTransfer: (record: any) => {
		const precision =
			SPOT_MARKETS.find(
				(x) => x.marketIndex === Number(record.liquidatePerpPnlForDeposit_assetMarketIndex)
			)?.precision ?? BASE_PRECISION;
		return getPrecisionExp(precision);
	},

	// Bankruptcy Fields
	perpBankruptcy_pnl: getPrecisionExp(QUOTE_PRECISION),
	perpBankruptcy_ifPayment: getPrecisionExp(QUOTE_PRECISION),
	perpBankruptcy_clawbackUserPayment: getPrecisionExp(QUOTE_PRECISION),
	perpBankruptcy_cumulativeFundingRateDelta: getPrecisionExp(FUNDING_RATE_PRECISION),
	spotBankruptcy_borrowAmount: (record: any) => {
		const precision =
			SPOT_MARKETS.find((x) => x.marketIndex === Number(record.spotBankruptcy_marketIndex))
				?.precision ?? BASE_PRECISION;
		return getPrecisionExp(precision);
	},
	spotBankruptcy_ifPayment: (record: any) => {
		const precision =
			SPOT_MARKETS.find((x) => x.marketIndex === Number(record.spotBankruptcy_marketIndex))
				?.precision ?? BASE_PRECISION;
		return getPrecisionExp(precision);
	},
	spotBankruptcy_cumulativeDepositInterestDelta: getPrecisionExp(
		SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION
	),

	userExistingBaseAssetAmount: (record: any) => {
		if (record.marketType === SerializedMarketFilter.SPOT) {
			const precision =
				SPOT_MARKETS.find((x) => x.marketIndex === Number(record.marketIndex))?.precision ??
				BASE_PRECISION;
			return getPrecisionExp(precision);
		}
		return getPrecisionExp(BASE_PRECISION);
	},
	takerExistingBaseAssetAmount: (record: any) => {
		if (record.marketType === SerializedMarketFilter.SPOT) {
			const precision =
				SPOT_MARKETS.find((x) => x.marketIndex === Number(record.marketIndex))?.precision ??
				BASE_PRECISION;
			return getPrecisionExp(precision);
		}
		return getPrecisionExp(BASE_PRECISION);
	},
	makerExistingBaseAssetAmount: (record: any) => {
		if (record.marketType === SerializedMarketFilter.SPOT) {
			const precision =
				SPOT_MARKETS.find((x) => x.marketIndex === Number(record.marketIndex))?.precision ??
				BASE_PRECISION;
			return getPrecisionExp(precision);
		}
		return getPrecisionExp(BASE_PRECISION);
	},

	accountBalance: getPrecisionExp(QUOTE_PRECISION),
	unrealizedPnl: getPrecisionExp(QUOTE_PRECISION),
	unsettledPnl: getPrecisionExp(QUOTE_PRECISION),
	cumulativeRealizedPnl: getPrecisionExp(QUOTE_PRECISION),
	cumulativeSettledPnl: getPrecisionExp(QUOTE_PRECISION),
	cumulativeFunding: getPrecisionExp(QUOTE_PRECISION),
	cumulativeFeePaid: getPrecisionExp(QUOTE_PRECISION),
	cumulativeFeeRebate: getPrecisionExp(QUOTE_PRECISION),
	cumulativeMakerVolume: getPrecisionExp(QUOTE_PRECISION),
	cumulativeTakerVolume: getPrecisionExp(QUOTE_PRECISION),

	balance: getPrecisionExp(QUOTE_PRECISION),
	deposits: getPrecisionExp(QUOTE_PRECISION),
	rewards: getPrecisionExp(QUOTE_PRECISION),
	withdrawals: getPrecisionExp(QUOTE_PRECISION),
	interestQuoteValue: getPrecisionExp(QUOTE_PRECISION),
	interestBaseValue: (record: any) => {
		const precision =
			SPOT_MARKETS.find((x) => x.marketIndex === Number(record.marketIndex))?.precision ??
			BASE_PRECISION;
		return getPrecisionExp(precision);
	},

	totalAccountValue: getPrecisionExp(QUOTE_PRECISION),
	totalAccountBaseValue: (record: any) => {
		const precision =
			SPOT_MARKETS.find((x) => x.marketIndex === Number(record.marketIndex))?.precision ??
			BASE_PRECISION;
		return getPrecisionExp(precision);
	},

	referralRewards: getPrecisionExp(QUOTE_PRECISION),
	referredVolume30D: getPrecisionExp(QUOTE_PRECISION),

	// LPMintRedeem
	lpAmount: getPrecisionExp(AMM_RESERVE_PRECISION),
	lpFee: getPrecisionExp(QUOTE_PRECISION),
	lpPrice: getPrecisionExp(PRICE_PRECISION),
	lastAum: getPrecisionExp(QUOTE_PRECISION),
	inMarketCurrentWeight: getPrecisionExp(PERCENTAGE_PRECISION),
	inMarketTargetWeight: getPrecisionExp(PERCENTAGE_PRECISION),

	// Onchain
	freeCollateral: getPrecisionExp(QUOTE_PRECISION),
	initialMargin: getPrecisionExp(QUOTE_PRECISION),
	maintenanceMargin: getPrecisionExp(QUOTE_PRECISION),
	totalBuilderRewards: getPrecisionExp(QUOTE_PRECISION),
} as const;

export const precisionTransform: TransformConfig = {
	name: 'precision-fix',
	description: 'Precision for historical data',
	rules: [
		{
			condition: () => {
				return true;
			},
			transform: (value, record) => {
				if (Array.isArray(value)) {
					return value.map((item) => processObjectFields(item));
				}
				return processFieldWithPrecision(value, record.field, record);
			},
			fields: Object.keys(PRECISION_MAP),
		},
	],
};
