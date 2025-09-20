import { isOneOfVariant, isVariant, Order, PositionDirection } from '../types';
import { BN } from '@coral-xyz/anchor';
import {
	ONE,
	ZERO,
	QUOTE_PRECISION,
	PRICE_PRECISION,
} from '../constants/numericConstants';
import { getVariant, OrderBitFlag, PerpMarketAccount } from '../types';
import { getPerpMarketTierNumber } from './tiers';

export function isAuctionComplete(order: Order, slot: number): boolean {
	if (order.auctionDuration === 0) {
		return true;
	}

	return new BN(slot).sub(order.slot).gt(new BN(order.auctionDuration));
}

export function isFallbackAvailableLiquiditySource(
	order: Order,
	minAuctionDuration: number,
	slot: number
): boolean {
	if (minAuctionDuration === 0) {
		return true;
	}

	if ((order.bitFlags & OrderBitFlag.SafeTriggerOrder) !== 0) {
		return true;
	}

	return new BN(slot).sub(order.slot).gt(new BN(minAuctionDuration));
}

/**
 *
 * @param order
 * @param slot
 * @param oraclePrice Use MMOraclePriceData source for perp orders, OraclePriceData for spot
 * @returns BN
 */
export function getAuctionPrice(
	order: Order,
	slot: number,
	oraclePrice: BN
): BN {
	if (
		isOneOfVariant(order.orderType, ['market', 'triggerLimit']) ||
		(isVariant(order.orderType, 'triggerMarket') &&
			(order.bitFlags & OrderBitFlag.OracleTriggerMarket) === 0)
	) {
		return getAuctionPriceForFixedAuction(order, slot);
	} else if (isVariant(order.orderType, 'limit')) {
		if (order.oraclePriceOffset != null && order.oraclePriceOffset !== 0) {
			return getAuctionPriceForOracleOffsetAuction(order, slot, oraclePrice);
		} else {
			return getAuctionPriceForFixedAuction(order, slot);
		}
	} else if (
		isVariant(order.orderType, 'oracle') ||
		(isVariant(order.orderType, 'triggerMarket') &&
			(order.bitFlags & OrderBitFlag.OracleTriggerMarket) !== 0)
	) {
		return getAuctionPriceForOracleOffsetAuction(order, slot, oraclePrice);
	} else {
		throw Error(
			`Cant get auction price for order type ${getVariant(order.orderType)}`
		);
	}
}

export function getAuctionPriceForFixedAuction(order: Order, slot: number): BN {
	const slotsElapsed = new BN(slot).sub(order.slot);

	const deltaDenominator = new BN(order.auctionDuration);
	const deltaNumerator = BN.min(slotsElapsed, deltaDenominator);

	if (deltaDenominator.eq(ZERO)) {
		return order.auctionEndPrice;
	}

	let priceDelta;
	if (isVariant(order.direction, 'long')) {
		priceDelta = order.auctionEndPrice
			.sub(order.auctionStartPrice)
			.mul(deltaNumerator)
			.div(deltaDenominator);
	} else {
		priceDelta = order.auctionStartPrice
			.sub(order.auctionEndPrice)
			.mul(deltaNumerator)
			.div(deltaDenominator);
	}

	let price;
	if (isVariant(order.direction, 'long')) {
		price = order.auctionStartPrice.add(priceDelta);
	} else {
		price = order.auctionStartPrice.sub(priceDelta);
	}

	return price;
}

/**
 *
 * @param order
 * @param slot
 * @param oraclePrice Use MMOraclePriceData source for perp orders, OraclePriceData for spot
 * @returns
 */
export function getAuctionPriceForOracleOffsetAuction(
	order: Order,
	slot: number,
	oraclePrice: BN
): BN {
	const slotsElapsed = new BN(slot).sub(order.slot);

	const deltaDenominator = new BN(order.auctionDuration);
	const deltaNumerator = BN.min(slotsElapsed, deltaDenominator);

	if (deltaDenominator.eq(ZERO)) {
		return BN.max(oraclePrice.add(order.auctionEndPrice), ONE);
	}

	let priceOffsetDelta;
	if (isVariant(order.direction, 'long')) {
		priceOffsetDelta = order.auctionEndPrice
			.sub(order.auctionStartPrice)
			.mul(deltaNumerator)
			.div(deltaDenominator);
	} else {
		priceOffsetDelta = order.auctionStartPrice
			.sub(order.auctionEndPrice)
			.mul(deltaNumerator)
			.div(deltaDenominator);
	}

	let priceOffset;
	if (isVariant(order.direction, 'long')) {
		priceOffset = order.auctionStartPrice.add(priceOffsetDelta);
	} else {
		priceOffset = order.auctionStartPrice.sub(priceOffsetDelta);
	}

	return BN.max(oraclePrice.add(priceOffset), ONE);
}

export function deriveOracleAuctionParams({
	direction,
	oraclePrice,
	auctionStartPrice,
	auctionEndPrice,
	limitPrice,
	auctionPriceCaps,
}: {
	direction: PositionDirection;
	oraclePrice: BN;
	auctionStartPrice: BN;
	auctionEndPrice: BN;
	limitPrice: BN;
	auctionPriceCaps?: {
		min: BN;
		max: BN;
	};
}): { auctionStartPrice: BN; auctionEndPrice: BN; oraclePriceOffset: number } {
	let oraclePriceOffset;

	if (limitPrice.eq(ZERO) || oraclePrice.eq(ZERO)) {
		oraclePriceOffset = ZERO;
	} else {
		oraclePriceOffset = limitPrice.sub(oraclePrice);
	}

	if (oraclePriceOffset.eq(ZERO)) {
		oraclePriceOffset = isVariant(direction, 'long')
			? auctionEndPrice.sub(oraclePrice).add(ONE)
			: auctionEndPrice.sub(oraclePrice).sub(ONE);
	}

	let oraclePriceOffsetNum;
	try {
		oraclePriceOffsetNum = oraclePriceOffset.toNumber();
	} catch (e) {
		oraclePriceOffsetNum = 0;
	}

	if (auctionPriceCaps) {
		auctionStartPrice = BN.min(
			BN.max(auctionStartPrice, auctionPriceCaps.min),
			auctionPriceCaps.max
		);
		auctionEndPrice = BN.min(
			BN.max(auctionEndPrice, auctionPriceCaps.min),
			auctionPriceCaps.max
		);
	}

	return {
		auctionStartPrice: auctionStartPrice.sub(oraclePrice),
		auctionEndPrice: auctionEndPrice.sub(oraclePrice),
		oraclePriceOffset: oraclePriceOffsetNum,
	};
}

/**
 *
 * @param params Use OraclePriceData.price for oraclePrice param
 * @returns
 */
export function getTriggerAuctionStartPrice(params: {
	perpMarket: PerpMarketAccount;
	direction: PositionDirection;
	oraclePrice: BN;
	limitPrice?: BN;
}): BN {
	const { perpMarket, direction, oraclePrice, limitPrice } = params;

	const twapMismatch =
		perpMarket.amm.historicalOracleData.lastOraclePriceTwapTs
			.sub(perpMarket.amm.lastMarkPriceTwapTs)
			.abs()
			.gte(new BN(60)) ||
		perpMarket.amm.volume24H.lte(new BN(100_000).mul(QUOTE_PRECISION));

	let baselineStartOffset: BN;

	if (twapMismatch) {
		const contractTierNumber = getPerpMarketTierNumber(perpMarket);
		const priceDivisor = contractTierNumber <= 1 ? 500 : 100;
		baselineStartOffset = isVariant(direction, 'long')
			? perpMarket.amm.lastBidPriceTwap.divn(priceDivisor)
			: perpMarket.amm.lastAskPriceTwap.divn(priceDivisor).neg();
	} else {
		const markTwapSlow = isVariant(direction, 'long')
			? perpMarket.amm.lastBidPriceTwap
			: perpMarket.amm.lastAskPriceTwap;

		const markTwapFast = perpMarket.amm.lastMarkPriceTwap5Min;
		const oracleTwapSlow =
			perpMarket.amm.historicalOracleData.lastOraclePriceTwap;
		const oracleTwapFast =
			perpMarket.amm.historicalOracleData.lastOraclePriceTwap5Min;

		const offsetSlow = markTwapSlow.sub(oracleTwapSlow);
		const offsetFast = markTwapFast.sub(oracleTwapFast);

		const fracOfLongSpreadInPrice = new BN(perpMarket.amm.longSpread)
			.mul(markTwapSlow)
			.div(PRICE_PRECISION.muln(10)); // divide by 10x for safety

		const fracOfShortSpreadInPrice = new BN(perpMarket.amm.shortSpread)
			.mul(markTwapSlow)
			.div(PRICE_PRECISION.muln(10)); // divide by 10x for safety

		baselineStartOffset = isVariant(direction, 'long')
			? BN.min(
					offsetSlow.add(fracOfLongSpreadInPrice),
					offsetFast.sub(fracOfShortSpreadInPrice)
			  )
			: BN.max(
					offsetSlow.sub(fracOfShortSpreadInPrice),
					offsetFast.add(fracOfLongSpreadInPrice)
			  );
	}

	let startBuffer = -3500;

	if (
		isVariant(perpMarket.contractTier, 'a') ||
		isVariant(perpMarket.contractTier, 'b')
	) {
		startBuffer = -500;
	}

	// Apply start buffer (in BPS)
	const startBufferPrice = oraclePrice
		.mul(new BN(startBuffer))
		.div(new BN(PRICE_PRECISION));

	let auctionStartPrice = isVariant(direction, 'long')
		? oraclePrice.add(baselineStartOffset).sub(startBufferPrice)
		: oraclePrice.add(baselineStartOffset).add(startBufferPrice);

	if (limitPrice) {
		if (isVariant(direction, 'long')) {
			auctionStartPrice = BN.min(auctionStartPrice, limitPrice);
		} else {
			auctionStartPrice = BN.max(auctionStartPrice, limitPrice);
		}
	}

	return auctionStartPrice;
}

/**
 *
 * @param params Use OraclePriceData.price for oraclePrice param and MMOraclePriceData.price for mmOraclePrice
 * @returns
 */
export function getTriggerAuctionStartAndExecutionPrice(params: {
	perpMarket: PerpMarketAccount;
	direction: PositionDirection;
	oraclePrice: BN;
	mmOraclePrice: BN;
	limitPrice?: BN;
}): { startPrice: BN; executionPrice: BN } {
	const { perpMarket, direction, oraclePrice, limitPrice, mmOraclePrice } =
		params;

	const startPrice = getTriggerAuctionStartPrice({
		perpMarket,
		direction,
		oraclePrice,
		limitPrice,
	});

	const offsetPlusBuffer = startPrice.sub(oraclePrice);
	let executionPrice = mmOraclePrice.add(offsetPlusBuffer);

	if (limitPrice) {
		if (isVariant(direction, 'long')) {
			executionPrice = BN.min(executionPrice, limitPrice);
		} else {
			executionPrice = BN.max(executionPrice, limitPrice);
		}
	}

	return { startPrice, executionPrice };
}
