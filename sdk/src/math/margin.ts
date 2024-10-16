import { squareRootBN } from './utils';
import {
	SPOT_MARKET_WEIGHT_PRECISION,
	SPOT_MARKET_IMF_PRECISION,
	ZERO,
	BID_ASK_SPREAD_PRECISION,
	AMM_RESERVE_PRECISION,
	MAX_PREDICTION_PRICE,
	BASE_PRECISION,
	MARGIN_PRECISION,
	PRICE_PRECISION,
	QUOTE_PRECISION,
} from '../constants/numericConstants';
import { BN } from '@coral-xyz/anchor';
import { OraclePriceData } from '../oracles/types';
import {
	calculateMarketMarginRatio,
	calculateScaledInitialAssetWeight,
	DriftClient,
	PerpMarketAccount,
	PerpPosition,
} from '..';
import { isVariant } from '../types';
import { assert } from '../assert/assert';

export function calculateSizePremiumLiabilityWeight(
	size: BN, // AMM_RESERVE_PRECISION
	imfFactor: BN,
	liabilityWeight: BN,
	precision: BN
): BN {
	if (imfFactor.eq(ZERO)) {
		return liabilityWeight;
	}

	const sizeSqrt = squareRootBN(size.abs().mul(new BN(10)).add(new BN(1))); //1e9 -> 1e10 -> 1e5

	const liabilityWeightNumerator = liabilityWeight.sub(
		liabilityWeight.div(new BN(5))
	);

	const denom = new BN(100_000).mul(SPOT_MARKET_IMF_PRECISION).div(precision);
	assert(denom.gt(ZERO));

	const sizePremiumLiabilityWeight = liabilityWeightNumerator.add(
		sizeSqrt // 1e5
			.mul(imfFactor)
			.div(denom) // 1e5
	);

	const maxLiabilityWeight = BN.max(
		liabilityWeight,
		sizePremiumLiabilityWeight
	);
	return maxLiabilityWeight;
}

export function calculateSizeDiscountAssetWeight(
	size: BN, // AMM_RESERVE_PRECISION
	imfFactor: BN,
	assetWeight: BN
): BN {
	if (imfFactor.eq(ZERO)) {
		return assetWeight;
	}

	const sizeSqrt = squareRootBN(size.abs().mul(new BN(10)).add(new BN(1))); //1e9 -> 1e10 -> 1e5
	const imfNumerator = SPOT_MARKET_IMF_PRECISION.add(
		SPOT_MARKET_IMF_PRECISION.div(new BN(10))
	);

	const sizeDiscountAssetWeight = imfNumerator
		.mul(SPOT_MARKET_WEIGHT_PRECISION)
		.div(
			SPOT_MARKET_IMF_PRECISION.add(
				sizeSqrt // 1e5
					.mul(imfFactor)
					.div(new BN(100_000)) // 1e5
			)
		);

	const minAssetWeight = BN.min(assetWeight, sizeDiscountAssetWeight);

	return minAssetWeight;
}

export function calculateOraclePriceForPerpMargin(
	perpPosition: PerpPosition,
	market: PerpMarketAccount,
	oraclePriceData: OraclePriceData
): BN {
	const oraclePriceOffset = BN.min(
		new BN(market.amm.maxSpread)
			.mul(oraclePriceData.price)
			.div(BID_ASK_SPREAD_PRECISION),
		oraclePriceData.confidence.add(
			new BN(market.amm.baseSpread)
				.mul(oraclePriceData.price)
				.div(BID_ASK_SPREAD_PRECISION)
		)
	);

	let marginPrice: BN;
	if (perpPosition.baseAssetAmount.gt(ZERO)) {
		marginPrice = oraclePriceData.price.sub(oraclePriceOffset);
	} else {
		marginPrice = oraclePriceData.price.add(oraclePriceOffset);
	}

	return marginPrice;
}

/**
 * This is _not_ the same as liability value as for prediction markets, the liability for the short in prediction market is (1 - oracle price) * base
 * See {@link calculatePerpLiabilityValue} to get the liabiltiy value
 * @param market
 * @param perpPosition
 * @param oraclePriceData
 * @param includeOpenOrders
 */
export function calculateBaseAssetValueWithOracle(
	market: PerpMarketAccount,
	perpPosition: PerpPosition,
	oraclePriceData: OraclePriceData,
	includeOpenOrders = false
): BN {
	let price = oraclePriceData.price;
	if (isVariant(market.status, 'settlement')) {
		price = market.expiryPrice;
	}

	const baseAssetAmount = includeOpenOrders
		? calculateWorstCaseBaseAssetAmount(
				perpPosition,
				market,
				oraclePriceData.price
		  )
		: perpPosition.baseAssetAmount;

	return baseAssetAmount.abs().mul(price).div(AMM_RESERVE_PRECISION);
}

export function calculateWorstCaseBaseAssetAmount(
	perpPosition: PerpPosition,
	perpMarket: PerpMarketAccount,
	oraclePrice: BN
): BN {
	return calculateWorstCasePerpLiabilityValue(
		perpPosition,
		perpMarket,
		oraclePrice
	).worstCaseBaseAssetAmount;
}

export function calculateWorstCasePerpLiabilityValue(
	perpPosition: PerpPosition,
	perpMarket: PerpMarketAccount,
	oraclePrice: BN
): { worstCaseBaseAssetAmount: BN; worstCaseLiabilityValue: BN } {
	const allBids = perpPosition.baseAssetAmount.add(perpPosition.openBids);
	const allAsks = perpPosition.baseAssetAmount.add(perpPosition.openAsks);

	const isPredictionMarket = isVariant(perpMarket.contractType, 'prediction');
	const allBidsLiabilityValue = calculatePerpLiabilityValue(
		allBids,
		oraclePrice,
		isPredictionMarket
	);
	const allAsksLiabilityValue = calculatePerpLiabilityValue(
		allAsks,
		oraclePrice,
		isPredictionMarket
	);

	if (allAsksLiabilityValue.gte(allBidsLiabilityValue)) {
		return {
			worstCaseBaseAssetAmount: allAsks,
			worstCaseLiabilityValue: allAsksLiabilityValue,
		};
	} else {
		return {
			worstCaseBaseAssetAmount: allBids,
			worstCaseLiabilityValue: allBidsLiabilityValue,
		};
	}
}

export function calculatePerpLiabilityValue(
	baseAssetAmount: BN,
	price: BN,
	isPredictionMarket: boolean
): BN {
	if (isPredictionMarket) {
		if (baseAssetAmount.gt(ZERO)) {
			return baseAssetAmount.mul(price).div(BASE_PRECISION);
		} else {
			return baseAssetAmount
				.abs()
				.mul(MAX_PREDICTION_PRICE.sub(price))
				.div(BASE_PRECISION);
		}
	} else {
		return baseAssetAmount.abs().mul(price).div(BASE_PRECISION);
	}
}

/**
 * Calculates the margin required to open a trade, in quote amount. Only accounts for the trade size as a scalar value, does not account for the trade direction or current open positions and whether the trade would _actually_ be risk-increasing and use any extra collateral.
 * @param targetMarketIndex
 * @param baseSize
 * @returns
 */
export function calculateMarginUSDCRequiredForTrade(
	driftClient: DriftClient,
	targetMarketIndex: number,
	baseSize: BN,
	userMaxMarginRatio?: number,
	userHighLeverageMode?: boolean,
	entryPrice?: BN
): BN {
	const targetMarket = driftClient.getPerpMarketAccount(targetMarketIndex);

	const price =
		entryPrice ??
		driftClient.getOracleDataForPerpMarket(targetMarket.marketIndex).price;

	const perpLiabilityValue = calculatePerpLiabilityValue(
		baseSize,
		price,
		isVariant(targetMarket.contractType, 'prediction')
	);

	const marginRequired = new BN(
		calculateMarketMarginRatio(
			targetMarket,
			baseSize.abs(),
			'Initial',
			userMaxMarginRatio,
			userHighLeverageMode
		)
	)
		.mul(perpLiabilityValue)
		.div(MARGIN_PRECISION);

	return marginRequired;
}

/**
 * Similar to calculatetMarginUSDCRequiredForTrade, but calculates how much of a given collateral is required to cover the margin requirements for a given trade. Basically does the same thing as getMarginUSDCRequiredForTrade but also accounts for asset weight of the selected collateral.
 *
 * Returns collateral required in the precision of the target collateral market.
 */
export function calculateCollateralDepositRequiredForTrade(
	driftClient: DriftClient,
	targetMarketIndex: number,
	baseSize: BN,
	collateralIndex: number,
	userMaxMarginRatio?: number,
	userHighLeverageMode?: boolean,
	estEntryPrice?: BN
): BN {
	const marginRequiredUsdc = calculateMarginUSDCRequiredForTrade(
		driftClient,
		targetMarketIndex,
		baseSize,
		userMaxMarginRatio,
		userHighLeverageMode,
		estEntryPrice
	);

	const collateralMarket = driftClient.getSpotMarketAccount(collateralIndex);

	const collateralOracleData =
		driftClient.getOracleDataForSpotMarket(collateralIndex);

	const scaledAssetWeight = calculateScaledInitialAssetWeight(
		collateralMarket,
		collateralOracleData.price
	);

	// Base amount required to deposit = (marginRequiredUsdc / priceOfAsset) / assetWeight .. (E.g. $100 required / $10000 price / 0.5 weight)
	const baseAmountRequired = driftClient
		.convertToSpotPrecision(collateralIndex, marginRequiredUsdc)
		.mul(PRICE_PRECISION) // adjust for division by oracle price
		.mul(SPOT_MARKET_WEIGHT_PRECISION) // adjust for division by scaled asset weight
		.div(collateralOracleData.price)
		.div(scaledAssetWeight)
		.div(QUOTE_PRECISION); // adjust for marginRequiredUsdc value's QUOTE_PRECISION

	// TODO : Round by step size?

	return baseAmountRequired;
}

export function calculateCollateralValueOfDeposit(
	driftClient: DriftClient,
	collateralIndex: number,
	baseSize: BN
): BN {
	const collateralMarket = driftClient.getSpotMarketAccount(collateralIndex);

	const collateralOracleData =
		driftClient.getOracleDataForSpotMarket(collateralIndex);

	const scaledAssetWeight = calculateScaledInitialAssetWeight(
		collateralMarket,
		collateralOracleData.price
	);

	// CollateralBaseValue = oracle price * collateral base amount (and shift to QUOTE_PRECISION)
	const collateralBaseValue = collateralOracleData.price
		.mul(baseSize)
		.mul(QUOTE_PRECISION)
		.div(PRICE_PRECISION)
		.div(new BN(10).pow(new BN(collateralMarket.decimals)));

	const depositCollateralValue = collateralBaseValue
		.mul(scaledAssetWeight)
		.div(SPOT_MARKET_WEIGHT_PRECISION);

	return depositCollateralValue;
}

export function calculateLiquidationPrice(
	freeCollateral: BN,
	freeCollateralDelta: BN,
	oraclePrice: BN
): BN {
	const liqPriceDelta = freeCollateral
		.mul(QUOTE_PRECISION)
		.div(freeCollateralDelta);

	const liqPrice = oraclePrice.sub(liqPriceDelta);

	if (liqPrice.lt(ZERO)) {
		return new BN(-1);
	}

	return liqPrice;
}
