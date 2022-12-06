import { isOneOfVariant, isVariant, Order } from '../types';
import { BN, ZERO } from '../.';

export function isAuctionComplete(order: Order, slot: number): boolean {
	if (order.auctionDuration === 0) {
		return true;
	}

	return new BN(slot).sub(order.slot).gt(new BN(order.auctionDuration));
}

export function getAuctionPrice(
	order: Order,
	slot: number,
	oraclePrice: BN
): BN {
	if (isOneOfVariant(order.orderType, ['market', 'triggerMarket'])) {
		return getAuctionPriceForFixedAuction(order, slot);
	} else if (isOneOfVariant(order.orderType, ['oracle', 'liquidation'])) {
		return getAuctionPriceForOracleOffsetAuction(order, slot, oraclePrice);
	} else {
		throw Error(`Cant get auction price for order type ${order.orderType}`);
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
		return order.auctionEndPrice.add(order.auctionEndPrice);
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

	return oraclePrice.add(priceOffset);
}
