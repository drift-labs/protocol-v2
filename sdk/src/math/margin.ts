import { squareRootBN } from './utils';
import {
	SPOT_MARKET_WEIGHT_PRECISION,
	SPOT_MARKET_IMF_PRECISION,
	ZERO,
	BID_ASK_SPREAD_PRECISION,
	AMM_RESERVE_PRECISION,
} from '../constants/numericConstants';
import { BN } from '@coral-xyz/anchor';
import { OraclePriceData } from '../oracles/types';
import { Order, PerpMarketAccount, PerpPosition } from '..';
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

export function calculateBaseAssetValueWithOracle(
	market: PerpMarketAccount,
	perpPosition: PerpPosition,
	oraclePriceData: OraclePriceData,
	includeOpenOrders = false,
	openOrders?: Order[]
): BN {
	let price = oraclePriceData.price;
	if (isVariant(market.status, 'settlement')) {
		price = market.expiryPrice;
	}

	const baseAssetAmount = includeOpenOrders
		? calculateWorstCaseBaseAssetAmount(perpPosition, openOrders)
		: perpPosition.baseAssetAmount;

	return baseAssetAmount.abs().mul(price).div(AMM_RESERVE_PRECISION);
}

/**
 * Calculates the max position size that could be opened on a perp market given the current position and orders.
 * If open orders array is passed, reduce only orders will be subtracted from the max bid/ask size
 * @param perpPosition
 * @param openOrders
 * @returns : BN BASE_PRECISION
 */
export function calculateWorstCaseBaseAssetAmount(
	perpPosition: PerpPosition,
	openOrders?: Order[]
): BN {
	let bidsToAdd = perpPosition.openBids;
	let asksToAdd = perpPosition.openAsks;

	if (openOrders) {
		const reduceOnlyTotalBids = openOrders
			.filter(
				(order) =>
					order.marketIndex === perpPosition.marketIndex &&
					isVariant(order.direction, 'long') &&
					order.reduceOnly
			)
			.reduce((prev, order) => order.baseAssetAmount.add(prev), ZERO);

		bidsToAdd = BN.max(bidsToAdd.sub(reduceOnlyTotalBids), ZERO);

		const reduceOnlyTotalAsks = openOrders
			.filter(
				(order) =>
					order.marketIndex === perpPosition.marketIndex &&
					isVariant(order.direction, 'short') &&
					order.reduceOnly
			)
			.reduce((prev, order) => order.baseAssetAmount.add(prev), ZERO);

		asksToAdd = BN.min(asksToAdd.add(reduceOnlyTotalAsks), ZERO);
	}

	const allBids = perpPosition.baseAssetAmount.add(bidsToAdd);
	const allAsks = perpPosition.baseAssetAmount.add(asksToAdd);

	if (allBids.abs().gt(allAsks.abs())) {
		return allBids;
	} else {
		return allAsks;
	}
}
