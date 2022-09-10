import { squareRootBN } from './utils';
import {
	SPOT_MARKET_WEIGHT_PRECISION,
	SPOT_MARKET_IMF_PRECISION,
	ZERO,
	BID_ASK_SPREAD_PRECISION,
	AMM_TO_QUOTE_PRECISION_RATIO,
	MARK_PRICE_PRECISION,
} from '../constants/numericConstants';
import { BN } from '@project-serum/anchor';
import { OraclePriceData } from '../oracles/types';
import { PerpMarketAccount, PerpPosition } from '..';

export function calculateSizePremiumLiabilityWeight(
	size: BN, // AMM_RESERVE_PRECISION
	imfFactor: BN,
	liabilityWeight: BN,
	precision: BN
): BN {
	if (imfFactor.eq(ZERO)) {
		return liabilityWeight;
	}

	const sizeSqrt = squareRootBN(size.div(new BN(1000)).add(new BN(1))); //1e13 -> 1e10 -> 1e5
	const liabilityWeightNumerator = liabilityWeight.sub(
		liabilityWeight.div(
			BN.max(new BN(1), SPOT_MARKET_IMF_PRECISION.div(imfFactor))
		)
	);

	const sizePremiumLiabilityWeight = liabilityWeightNumerator.add(
		sizeSqrt // 1e5
			.mul(imfFactor)
			.div(new BN(100_000).mul(SPOT_MARKET_IMF_PRECISION).div(precision)) // 1e5
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

	const sizeSqrt = squareRootBN(size.div(new BN(1000)).add(new BN(1))); //1e13 -> 1e10 -> 1e5
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
	marketPosition: PerpPosition,
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
	if (marketPosition.baseAssetAmount.gt(ZERO)) {
		marginPrice = oraclePriceData.price.sub(oraclePriceOffset);
	} else {
		marginPrice = oraclePriceData.price.add(oraclePriceOffset);
	}

	return marginPrice;
}

export function calculateBaseAssetValueWithOracle(
	market: PerpMarketAccount,
	marketPosition: PerpPosition,
	oraclePriceData: OraclePriceData
): BN {
	return marketPosition.baseAssetAmount
		.abs()
		.mul(oraclePriceData.price)
		.div(AMM_TO_QUOTE_PRECISION_RATIO.mul(MARK_PRICE_PRECISION));
}

export function calculateWorstCaseBaseAssetAmount(
	marketPosition: PerpPosition
): BN {
	const allBids = marketPosition.baseAssetAmount.add(marketPosition.openBids);
	const allAsks = marketPosition.baseAssetAmount.add(marketPosition.openAsks);

	if (allBids.abs().gt(allAsks.abs())) {
		return allBids;
	} else {
		return allAsks;
	}
}
