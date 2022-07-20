import {
	isVariant,
	MarketAccount,
	Order,
	PositionDirection,
	UserAccount,
	UserPosition,
} from './types';
import { BN, standardizeBaseAssetAmount } from '.';
import { calculateNewMarketAfterTrade } from './math/market';
import {
	AMM_TO_QUOTE_PRECISION_RATIO,
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
	market: MarketAccount,
	order: Order
): [UserAccount, UserPosition, MarketAccount] | null {
	if (isVariant(order.status, 'init')) {
		return null;
	}

	const baseAssetAmountToTrade = calculateBaseAssetAmountMarketCanExecute(
		market,
		order
	);
	if (baseAssetAmountToTrade.lt(market.amm.baseAssetAmountStepSize)) {
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
	marketBefore: MarketAccount,
	marketAfter: MarketAccount
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
	market: MarketAccount,
	order: Order,
	oraclePriceData?: OraclePriceData
): BN {
	if (isVariant(order.orderType, 'limit')) {
		return calculateAmountToTradeForLimit(market, order, oraclePriceData);
	} else if (isVariant(order.orderType, 'triggerLimit')) {
		return calculateAmountToTradeForTriggerLimit(market, order);
	} else if (isVariant(order.orderType, 'market')) {
		return ZERO;
	} else {
		return calculateAmountToTradeForTriggerMarket(market, order);
	}
}

export function calculateAmountToTradeForLimit(
	market: MarketAccount,
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
		const floatingPrice = oraclePriceData.price.add(order.oraclePriceOffset);
		if (order.postOnly) {
			limitPrice = isVariant(order.direction, 'long')
				? BN.min(order.price, floatingPrice)
				: BN.max(order.price, floatingPrice);
		} else {
			limitPrice = floatingPrice;
		}
	}

	const [maxAmountToTrade, direction] = calculateMaxBaseAssetAmountToTrade(
		market.amm,
		limitPrice,
		order.direction
	);

	const baseAssetAmount = standardizeBaseAssetAmount(
		maxAmountToTrade,
		market.amm.baseAssetAmountStepSize
	);

	// Check that directions are the same
	const sameDirection = isSameDirection(direction, order.direction);
	if (!sameDirection) {
		return ZERO;
	}

	return baseAssetAmount.gt(order.baseAssetAmount)
		? order.baseAssetAmount
		: baseAssetAmount;
}

export function calculateAmountToTradeForTriggerLimit(
	market: MarketAccount,
	order: Order
): BN {
	if (!order.triggered) {
		return ZERO;
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
	market: MarketAccount,
	order: Order
): BN {
	if (!order.triggered) {
		return ZERO;
	}

	return order.baseAssetAmount;
}
