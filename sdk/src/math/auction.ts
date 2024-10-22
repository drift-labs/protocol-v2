import { isOneOfVariant, isVariant, Order, PositionDirection } from '../types';
import { BN, getVariant, ONE, ZERO } from '../.';

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

	return new BN(slot).sub(order.slot).gt(new BN(minAuctionDuration));
}

export function getAuctionPrice(
	order: Order,
	slot: number,
	oraclePrice: BN
): BN {
	if (
		isOneOfVariant(order.orderType, ['market', 'triggerMarket', 'triggerLimit'])
	) {
		return getAuctionPriceForFixedAuction(order, slot);
	} else if (isVariant(order.orderType, 'limit')) {
		if (order.oraclePriceOffset !== 0) {
			return getAuctionPriceForOracleOffsetAuction(order, slot, oraclePrice);
		} else {
			return getAuctionPriceForFixedAuction(order, slot);
		}
	} else if (isVariant(order.orderType, 'oracle')) {
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
