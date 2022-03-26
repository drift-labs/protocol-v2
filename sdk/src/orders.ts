import {
	isVariant,
	Market,
	Order,
	PositionDirection,
	SwapDirection,
	UserAccount,
	UserPosition,
} from './types';
import {
	BN,
	calculateAmmReservesAfterSwap,
	calculateBaseAssetValue,
	ClearingHouseUser,
	isOrderRiskIncreasingInSameDirection,
	TEN_THOUSAND,
} from '.';
import {
	calculateMarkPrice,
	calculateNewMarketAfterTrade,
} from './math/market';
import {
	AMM_TO_QUOTE_PRECISION_RATIO,
	TWO,
	PEG_PRECISION,
	ZERO,
} from './constants/numericConstants';
import { calculateMaxBaseAssetAmountToTrade } from './math/amm';
import {
	findDirectionToClose,
	positionCurrentDirection,
} from './math/position';
import { OraclePriceData } from '.';

export function calculateNewStateAfterOrder(
	userAccount: UserAccount,
	userPosition: UserPosition,
	market: Market,
	order: Order
): [UserAccount, UserPosition, Market] | null {
	if (isVariant(order.status, 'init')) {
		return null;
	}

	const baseAssetAmountToTrade = calculateBaseAssetAmountMarketCanExecute(
		market,
		order
	);
	if (baseAssetAmountToTrade.lt(market.amm.minimumBaseAssetTradeSize)) {
		return null;
	}

	const userAccountAfter = Object.assign({}, userAccount);
	const userPositionAfter = Object.assign({}, userPosition);

	const currentPositionDirection = positionCurrentDirection(userPosition);
	const increasePosition =
		userPosition.baseAssetAmount.eq(ZERO) ||
		isSameDirection(order.direction, currentPositionDirection);

	if (increasePosition) {
		const marketAfter = calculateNewMarketAfterTrade(
			baseAssetAmountToTrade,
			order.direction,
			market
		);

		const { quoteAssetAmountSwapped, baseAssetAmountSwapped } =
			calculateAmountSwapped(market, marketAfter);

		userPositionAfter.baseAssetAmount = userPositionAfter.baseAssetAmount.add(
			baseAssetAmountSwapped
		);
		userPositionAfter.quoteAssetAmount = userPositionAfter.quoteAssetAmount.add(
			quoteAssetAmountSwapped
		);

		return [userAccountAfter, userPositionAfter, marketAfter];
	} else {
		const reversePosition = baseAssetAmountToTrade.gt(
			userPosition.baseAssetAmount.abs()
		);

		if (reversePosition) {
			const intermediateMarket = calculateNewMarketAfterTrade(
				userPosition.baseAssetAmount,
				findDirectionToClose(userPosition),
				market
			);

			const { quoteAssetAmountSwapped: baseAssetValue } =
				calculateAmountSwapped(market, intermediateMarket);

			let pnl;
			if (isVariant(currentPositionDirection, 'long')) {
				pnl = baseAssetValue.sub(userPosition.quoteAssetAmount);
			} else {
				pnl = userPosition.quoteAssetAmount.sub(baseAssetValue);
			}

			userAccountAfter.collateral = userAccountAfter.collateral.add(pnl);

			const baseAssetAmountLeft = baseAssetAmountToTrade.sub(
				userPosition.baseAssetAmount.abs()
			);

			const marketAfter = calculateNewMarketAfterTrade(
				baseAssetAmountLeft,
				order.direction,
				intermediateMarket
			);

			const { quoteAssetAmountSwapped, baseAssetAmountSwapped } =
				calculateAmountSwapped(intermediateMarket, marketAfter);

			userPositionAfter.quoteAssetAmount = quoteAssetAmountSwapped;
			userPositionAfter.baseAssetAmount = baseAssetAmountSwapped;

			return [userAccountAfter, userPositionAfter, marketAfter];
		} else {
			const marketAfter = calculateNewMarketAfterTrade(
				baseAssetAmountToTrade,
				order.direction,
				market
			);

			const {
				quoteAssetAmountSwapped: baseAssetValue,
				baseAssetAmountSwapped,
			} = calculateAmountSwapped(market, marketAfter);

			const costBasisRealized = userPosition.quoteAssetAmount
				.mul(baseAssetAmountSwapped.abs())
				.div(userPosition.baseAssetAmount.abs());

			let pnl;
			if (isVariant(currentPositionDirection, 'long')) {
				pnl = baseAssetValue.sub(costBasisRealized);
			} else {
				pnl = costBasisRealized.sub(baseAssetValue);
			}

			userAccountAfter.collateral = userAccountAfter.collateral.add(pnl);

			userPositionAfter.baseAssetAmount = userPositionAfter.baseAssetAmount.add(
				baseAssetAmountSwapped
			);
			userPositionAfter.quoteAssetAmount =
				userPositionAfter.quoteAssetAmount.sub(costBasisRealized);

			return [userAccountAfter, userPositionAfter, marketAfter];
		}
	}
}

function calculateAmountSwapped(
	marketBefore: Market,
	marketAfter: Market
): { quoteAssetAmountSwapped: BN; baseAssetAmountSwapped: BN } {
	return {
		quoteAssetAmountSwapped: marketBefore.amm.quoteAssetReserve
			.sub(marketAfter.amm.quoteAssetReserve)
			.abs()
			.mul(marketBefore.amm.pegMultiplier)
			.div(PEG_PRECISION)
			.div(AMM_TO_QUOTE_PRECISION_RATIO),
		baseAssetAmountSwapped: marketBefore.amm.baseAssetReserve.sub(
			marketAfter.amm.baseAssetReserve
		),
	};
}

export function calculateBaseAssetAmountMarketCanExecute(
	market: Market,
	order: Order,
	oraclePriceData?: OraclePriceData
): BN {
	if (isVariant(order.orderType, 'limit')) {
		return calculateAmountToTradeForLimit(market, order, oraclePriceData);
	} else if (isVariant(order.orderType, 'triggerLimit')) {
		return calculateAmountToTradeForTriggerLimit(market, order);
	} else if (isVariant(order.orderType, 'market')) {
		// should never be a market order queued
		return ZERO;
	} else {
		return calculateAmountToTradeForTriggerMarket(market, order);
	}
}

export function calculateAmountToTradeForLimit(
	market: Market,
	order: Order,
	oraclePriceData?: OraclePriceData
): BN {
	let limitPrice = order.price;
	if (!order.oraclePriceOffset.eq(ZERO)) {
		if (!oraclePriceData) {
			throw Error(
				'Cant calculate limit price for oracle offset oracle without OraclePriceData'
			);
		}
		limitPrice = oraclePriceData.price.add(order.oraclePriceOffset);
	}

	const [maxAmountToTrade, direction] = calculateMaxBaseAssetAmountToTrade(
		market.amm,
		limitPrice
	);

	// Check that directions are the same
	const sameDirection = isSameDirection(direction, order.direction);
	if (!sameDirection) {
		return ZERO;
	}

	return maxAmountToTrade.gt(order.baseAssetAmount)
		? order.baseAssetAmount
		: maxAmountToTrade;
}

export function calculateAmountToTradeForTriggerLimit(
	market: Market,
	order: Order
): BN {
	if (order.baseAssetAmountFilled.eq(ZERO)) {
		const baseAssetAmount = calculateAmountToTradeForTriggerMarket(
			market,
			order
		);
		if (baseAssetAmount.eq(ZERO)) {
			return ZERO;
		}
	}

	return calculateAmountToTradeForLimit(market, order);
}

function isSameDirection(
	firstDirection: PositionDirection,
	secondDirection: PositionDirection
): boolean {
	return (
		(isVariant(firstDirection, 'long') && isVariant(secondDirection, 'long')) ||
		(isVariant(firstDirection, 'short') && isVariant(secondDirection, 'short'))
	);
}

function calculateAmountToTradeForTriggerMarket(
	market: Market,
	order: Order
): BN {
	return isTriggerConditionSatisfied(market, order)
		? order.baseAssetAmount
		: ZERO;
}

function isTriggerConditionSatisfied(market: Market, order: Order): boolean {
	const markPrice = calculateMarkPrice(market);
	if (isVariant(order.triggerCondition, 'above')) {
		return markPrice.gt(order.triggerPrice);
	} else {
		return markPrice.lt(order.triggerPrice);
	}
}

export function calculateBaseAssetAmountUserCanExecute(
	market: Market,
	order: Order,
	user: ClearingHouseUser
): BN {
	const maxLeverage = user.getMaxLeverage(order.marketIndex, 'Initial');
	const freeCollateral = user.getFreeCollateral();
	let quoteAssetAmount: BN;
	if (isOrderRiskIncreasingInSameDirection(user, order)) {
		quoteAssetAmount = freeCollateral.mul(maxLeverage).div(TEN_THOUSAND);
	} else {
		const position =
			user.getUserPosition(order.marketIndex) ||
			user.getEmptyPosition(order.marketIndex);
		const positionValue = calculateBaseAssetValue(market, position);
		quoteAssetAmount = freeCollateral
			.mul(maxLeverage)
			.div(TEN_THOUSAND)
			.add(positionValue.mul(TWO));
	}

	if (quoteAssetAmount.lte(ZERO)) {
		return ZERO;
	}

	const baseAssetReservesBefore = market.amm.baseAssetReserve;
	const [_, baseAssetReservesAfter] = calculateAmmReservesAfterSwap(
		market.amm,
		'quote',
		quoteAssetAmount,
		isVariant(order.direction, 'long')
			? SwapDirection.ADD
			: SwapDirection.REMOVE
	);

	return baseAssetReservesBefore.sub(baseAssetReservesAfter).abs();
}
