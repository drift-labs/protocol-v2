import {
	MarketType,
	PerpMarketAccount,
	PositionDirection,
	UserStatsAccount,
} from '../types';
import { BN } from '../isomorphic/anchor';
import { assert } from '../assert/assert';
import {
	PRICE_PRECISION,
	PEG_PRECISION,
	AMM_TO_QUOTE_PRECISION_RATIO,
	ZERO,
	BASE_PRECISION,
	BN_MAX,
} from '../constants/numericConstants';
import {
	calculateBidPrice,
	calculateAskPrice,
	calculateReservePrice,
} from './market';
import {
	calculateAmmReservesAfterSwap,
	calculatePrice,
	getSwapDirection,
	AssetType,
	calculateUpdatedAMMSpreadReserves,
	calculateQuoteAssetAmountSwapped,
	calculateMarketOpenBidAsk,
} from './amm';
import { squareRootBN } from './utils';
import { isVariant } from '../types';
import { MMOraclePriceData } from '../oracles/types';
import { DLOB } from '../dlob/DLOB';
import { PublicKey } from '@solana/web3.js';
import { L2OrderBook } from '../dlob/orderBookLevels';

const MAXPCT = new BN(1000); //percentage units are [0,1000] => [0,1]

/**
 * Enumerates the price-impact-related fields historically produced by trade-slippage helpers.
 * Not currently consumed as a parameter/return type by any function in this file — kept for
 * backward compatibility with callers that reference it as a key type.
 */
export type PriceImpactUnit =
	| 'entryPrice'
	| 'maxPrice'
	| 'priceDelta'
	| 'priceDeltaAsNumber'
	| 'pctAvg'
	| 'pctMax'
	| 'quoteAssetAmount'
	| 'quoteAssetAmountPeg'
	| 'acquiredBaseAssetAmount'
	| 'acquiredQuoteAssetAmount'
	| 'all';

/**
 * Calculates avg/max slippage (price impact) for a hypothetical AMM-only trade.
 *
 * @deprecated Use `calculateEstimatedPerpEntryPrice` instead (this ignores DLOB liquidity and
 *   only swaps against the vAMM).
 *
 * @param {PositionDirection} direction - Taker's trade direction
 * @param {BN} amount - Trade size in `inputAssetType` units (base: BASE_PRECISION (1e9); quote: QUOTE_PRECISION (1e6))
 * @param {PerpMarketAccount} market - The perp market account
 * @param {AssetType} [inputAssetType] - Whether `amount` denominates base or quote; defaults to `'quote'`
 * @param {MMOraclePriceData} mmOraclePriceData - MM oracle price data used for spread reserve calc
 * @param {boolean} [useSpread] - Whether to consider the bid/ask spread when computing slippage; defaults to `true`
 * @param {BN} [latestSlot] - Slot used for spread-reserve staleness/decay calc when `useSpread` is true
 * @return {[BN, BN, BN, BN]} `[pctAvgSlippage, pctMaxSlippage, entryPrice, newPrice]`, all
 *   PRICE_PRECISION (1e6): `pctAvgSlippage` is the percentage change from the pre-trade price to
 *   `entryPrice` (average execution slippage); `pctMaxSlippage` is the percentage change from the
 *   pre-trade price to `newPrice` (worst-case/marginal slippage); `entryPrice` is the trade's
 *   average execution price; `newPrice` is the AMM's price after the trade
 */
export function calculateTradeSlippage(
	direction: PositionDirection,
	amount: BN,
	market: PerpMarketAccount,
	inputAssetType: AssetType = 'quote',
	mmOraclePriceData: MMOraclePriceData,
	useSpread = true,
	latestSlot?: BN
): [BN, BN, BN, BN] {
	let oldPrice: BN;

	if (useSpread && market.amm.baseSpread > 0) {
		if (isVariant(direction, 'long')) {
			oldPrice = calculateAskPrice(market, mmOraclePriceData);
		} else {
			oldPrice = calculateBidPrice(market, mmOraclePriceData);
		}
	} else {
		oldPrice = calculateReservePrice(market, mmOraclePriceData);
	}
	if (amount.eq(ZERO)) {
		return [ZERO, ZERO, oldPrice, oldPrice];
	}
	const [acquiredBaseReserve, acquiredQuoteReserve, acquiredQuoteAssetAmount] =
		calculateTradeAcquiredAmounts(
			direction,
			amount,
			market,
			inputAssetType,
			mmOraclePriceData,
			useSpread
		);

	const entryPrice = acquiredQuoteAssetAmount
		.mul(AMM_TO_QUOTE_PRECISION_RATIO)
		.mul(PRICE_PRECISION)
		.div(acquiredBaseReserve.abs());

	let amm: Parameters<typeof calculateAmmReservesAfterSwap>[0];
	if (useSpread && market.amm.baseSpread > 0) {
		const { baseAssetReserve, quoteAssetReserve, sqrtK, newPeg } =
			calculateUpdatedAMMSpreadReserves(
				market.amm,
				market.marketStats,
				direction,
				mmOraclePriceData,
				latestSlot
			);
		amm = {
			baseAssetReserve,
			quoteAssetReserve,
			sqrtK: sqrtK,
			pegMultiplier: newPeg,
		};
	} else {
		amm = market.amm;
	}

	const newPrice = calculatePrice(
		amm.baseAssetReserve.sub(acquiredBaseReserve),
		amm.quoteAssetReserve.sub(acquiredQuoteReserve),
		amm.pegMultiplier
	);

	if (direction == PositionDirection.SHORT) {
		assert(newPrice.lte(oldPrice));
	} else {
		assert(oldPrice.lte(newPrice));
	}

	const pctMaxSlippage = newPrice
		.sub(oldPrice)
		.mul(PRICE_PRECISION)
		.div(oldPrice)
		.abs();
	const pctAvgSlippage = entryPrice
		.sub(oldPrice)
		.mul(PRICE_PRECISION)
		.div(oldPrice)
		.abs();

	return [pctAvgSlippage, pctMaxSlippage, entryPrice, newPrice];
}

/**
 * Calculates the AMM reserve deltas and resulting quote amount for a hypothetical constant-product
 * swap against the vAMM, without executing anything on-chain.
 *
 * @param {PositionDirection} direction - Taker's trade direction
 * @param {BN} amount - Trade size in `inputAssetType` units (base: BASE_PRECISION (1e9); quote: QUOTE_PRECISION (1e6))
 * @param {PerpMarketAccount} market - The perp market account
 * @param {AssetType} [inputAssetType] - Whether `amount` denominates base or quote; defaults to `'quote'`
 * @param {MMOraclePriceData} mmOraclePriceData - MM oracle price data used for spread reserve calc
 * @param {boolean} [useSpread] - Whether to swap against the spread-adjusted reserves (bid/ask)
 *   rather than the raw reserves; defaults to `true`
 * @param {BN} [latestSlot] - Slot used for spread-reserve staleness/decay calc when `useSpread` is true
 * @return {[BN, BN, BN]} `[acquiredBase, acquiredQuote, acquiredQuoteAssetAmount]` — the change
 *   in the AMM's base and quote reserves (signed, `AMM_RESERVE_PRECISION` (1e9)), and the
 *   resulting user-facing quote amount swapped, `QUOTE_PRECISION` (1e6)
 */
export function calculateTradeAcquiredAmounts(
	direction: PositionDirection,
	amount: BN,
	market: PerpMarketAccount,
	inputAssetType: AssetType = 'quote',
	mmOraclePriceData: MMOraclePriceData,
	useSpread = true,
	latestSlot?: BN
): [BN, BN, BN] {
	if (amount.eq(ZERO)) {
		return [ZERO, ZERO, ZERO];
	}

	const swapDirection = getSwapDirection(inputAssetType, direction);

	let amm: Parameters<typeof calculateAmmReservesAfterSwap>[0];
	if (useSpread && market.amm.baseSpread > 0) {
		const { baseAssetReserve, quoteAssetReserve, sqrtK, newPeg } =
			calculateUpdatedAMMSpreadReserves(
				market.amm,
				market.marketStats,
				direction,
				mmOraclePriceData,
				latestSlot
			);
		amm = {
			baseAssetReserve,
			quoteAssetReserve,
			sqrtK: sqrtK,
			pegMultiplier: newPeg,
		};
	} else {
		amm = market.amm;
	}

	const [newQuoteAssetReserve, newBaseAssetReserve] =
		calculateAmmReservesAfterSwap(amm, inputAssetType, amount, swapDirection);

	const acquiredBase = amm.baseAssetReserve.sub(newBaseAssetReserve);
	const acquiredQuote = amm.quoteAssetReserve.sub(newQuoteAssetReserve);
	const acquiredQuoteAssetAmount = calculateQuoteAssetAmountSwapped(
		acquiredQuote.abs(),
		amm.pegMultiplier,
		swapDirection
	);

	return [acquiredBase, acquiredQuote, acquiredQuoteAssetAmount];
}

/**
 * Calculates the AMM-only trade (direction + size) required to push the market's reserve price
 * to (or `pct` of the way to) `targetPrice` — a simple arbitrage-sizing helper.
 *
 * @deprecated No longer actively maintained; ignores DLOB liquidity.
 *
 * @param {PerpMarketAccount} market - The perp market account
 * @param {BN} targetPrice - The price to arbitrage toward, PRICE_PRECISION (1e6)
 * @param {BN} [pct] - Fraction of the full price gap to close, out of `MAXPCT` (1000 = 100%);
 *   defaults to fully closing the gap
 * @param {AssetType} [outputAssetType] - Whether the returned trade size is denominated in base
 *   or quote; defaults to `'quote'`
 * @param {MMOraclePriceData} [mmOraclePriceData] - MM oracle price data used for spread reserve calc
 * @param {boolean} [useSpread] - Whether to consider the bid/ask spread when sizing the trade;
 *   defaults to `true`. If `targetPrice` already sits within the current bid/ask spread, returns
 *   a zero-size trade
 * @param {BN} [latestSlot] - Slot used for spread-reserve staleness/decay calc when `useSpread` is true
 * @return {[PositionDirection, BN, BN, BN]} `[direction, tradeSize, entryPrice, targetPrice]` —
 *   `direction` required to move price toward `targetPrice`; `tradeSize` in `outputAssetType`
 *   units (base: BASE_PRECISION (1e9); quote: QUOTE_PRECISION (1e6)); `entryPrice`/`targetPrice`
 *   PRICE_PRECISION (1e6)
 */
export function calculateTargetPriceTrade(
	market: PerpMarketAccount,
	targetPrice: BN,
	pct: BN = MAXPCT,
	outputAssetType: AssetType = 'quote',
	mmOraclePriceData?: MMOraclePriceData,
	useSpread = true,
	latestSlot?: BN
): [PositionDirection, BN, BN, BN] {
	assert(market.amm.baseAssetReserve.gt(ZERO));
	assert(targetPrice.gt(ZERO));
	assert(pct.lte(MAXPCT) && pct.gt(ZERO));

	const reservePriceBefore = calculateReservePrice(market, mmOraclePriceData);
	const bidPriceBefore = calculateBidPrice(market, mmOraclePriceData);
	const askPriceBefore = calculateAskPrice(market, mmOraclePriceData);

	let direction;
	if (targetPrice.gt(reservePriceBefore)) {
		const priceGap = targetPrice.sub(reservePriceBefore);
		const priceGapScaled = priceGap.mul(pct).div(MAXPCT);
		targetPrice = reservePriceBefore.add(priceGapScaled);
		direction = PositionDirection.LONG;
	} else {
		const priceGap = reservePriceBefore.sub(targetPrice);
		const priceGapScaled = priceGap.mul(pct).div(MAXPCT);
		targetPrice = reservePriceBefore.sub(priceGapScaled);
		direction = PositionDirection.SHORT;
	}

	let tradeSize;
	let baseSize;

	let baseAssetReserveBefore: BN;
	let quoteAssetReserveBefore: BN;

	let peg = market.amm.pegMultiplier;

	if (useSpread && market.amm.baseSpread > 0) {
		const { baseAssetReserve, quoteAssetReserve, newPeg } =
			calculateUpdatedAMMSpreadReserves(
				market.amm,
				market.marketStats,
				direction,
				mmOraclePriceData,
				latestSlot
			);
		baseAssetReserveBefore = baseAssetReserve;
		quoteAssetReserveBefore = quoteAssetReserve;
		peg = newPeg;
	} else {
		baseAssetReserveBefore = market.amm.baseAssetReserve;
		quoteAssetReserveBefore = market.amm.quoteAssetReserve;
	}

	const invariant = market.amm.sqrtK.mul(market.amm.sqrtK);
	const k = invariant.mul(PRICE_PRECISION);

	let baseAssetReserveAfter;
	let quoteAssetReserveAfter;
	const biasModifier = new BN(1);
	let markPriceAfter;

	if (
		useSpread &&
		targetPrice.lt(askPriceBefore) &&
		targetPrice.gt(bidPriceBefore)
	) {
		// no trade, market is at target
		if (reservePriceBefore.gt(targetPrice)) {
			direction = PositionDirection.SHORT;
		} else {
			direction = PositionDirection.LONG;
		}
		tradeSize = ZERO;
		return [direction, tradeSize, targetPrice, targetPrice];
	} else if (reservePriceBefore.gt(targetPrice)) {
		// overestimate y2
		baseAssetReserveAfter = squareRootBN(
			k.div(targetPrice).mul(peg).div(PEG_PRECISION).sub(biasModifier)
		).sub(new BN(1));
		quoteAssetReserveAfter = k.div(PRICE_PRECISION).div(baseAssetReserveAfter);

		markPriceAfter = calculatePrice(
			baseAssetReserveAfter,
			quoteAssetReserveAfter,
			peg
		);
		direction = PositionDirection.SHORT;
		tradeSize = quoteAssetReserveBefore
			.sub(quoteAssetReserveAfter)
			.mul(peg)
			.div(PEG_PRECISION)
			.div(AMM_TO_QUOTE_PRECISION_RATIO);
		baseSize = baseAssetReserveAfter.sub(baseAssetReserveBefore);
	} else if (reservePriceBefore.lt(targetPrice)) {
		// underestimate y2
		baseAssetReserveAfter = squareRootBN(
			k.div(targetPrice).mul(peg).div(PEG_PRECISION).add(biasModifier)
		).add(new BN(1));
		quoteAssetReserveAfter = k.div(PRICE_PRECISION).div(baseAssetReserveAfter);

		markPriceAfter = calculatePrice(
			baseAssetReserveAfter,
			quoteAssetReserveAfter,
			peg
		);

		direction = PositionDirection.LONG;
		tradeSize = quoteAssetReserveAfter
			.sub(quoteAssetReserveBefore)
			.mul(peg)
			.div(PEG_PRECISION)
			.div(AMM_TO_QUOTE_PRECISION_RATIO);
		baseSize = baseAssetReserveBefore.sub(baseAssetReserveAfter);
	} else {
		// no trade, market is at target
		direction = PositionDirection.LONG;
		tradeSize = ZERO;
		return [direction, tradeSize, targetPrice, targetPrice];
	}

	let tp1 = targetPrice;
	let tp2 = markPriceAfter;
	let originalDiff = targetPrice.sub(reservePriceBefore);

	if (direction == PositionDirection.SHORT) {
		tp1 = markPriceAfter;
		tp2 = targetPrice;
		originalDiff = reservePriceBefore.sub(targetPrice);
	}

	const entryPrice = tradeSize
		.mul(AMM_TO_QUOTE_PRECISION_RATIO)
		.mul(PRICE_PRECISION)
		.div(baseSize.abs());

	assert(tp1.sub(tp2).lte(originalDiff), 'Target Price Calculation incorrect');
	assert(
		tp2.lte(tp1) || tp2.sub(tp1).abs().ltn(100000),
		'Target Price Calculation incorrect' +
			tp2.toString() +
			'>=' +
			tp1.toString() +
			'err: ' +
			tp2.sub(tp1).abs().toString()
	);
	if (outputAssetType == 'quote') {
		return [direction, tradeSize, entryPrice, targetPrice];
	} else {
		return [direction, baseSize, entryPrice, targetPrice];
	}
}

/**
 * Simulates walking the combined DLOB + vAMM liquidity to estimate the entry price and price
 * impact of a hypothetical taker order, filling against resting limit orders and the AMM's
 * spread-adjusted reserves in whichever is cheaper at each step. Price impact is the difference
 * between the estimated entry price and the best available price (top of book/AMM) before any
 * fill.
 *
 * @param {AssetType} assetType - Whether `amount` denominates base or quote
 * @param {BN} amount - Order size, `assetType === 'base'`: BASE_PRECISION (1e9); `'quote'`: QUOTE_PRECISION (1e6)
 * @param {PositionDirection} direction - Taker's trade direction
 * @param {PerpMarketAccount} market - The perp market account
 * @param {MMOraclePriceData} mmOraclePriceData - MM oracle price data used to price both the DLOB
 *   resting orders and the AMM's spread-adjusted reserves
 * @param {DLOB} dlob - The order book to walk for resting limit orders
 * @param {number} slot - Current slot, used to resolve oracle-pegged/auction limit order prices
 * @param {Map<PublicKey, boolean>} [usersToSkip] - Maker user accounts to exclude from the fill
 *   simulation (e.g. the taker's own resting orders); defaults to none
 * @return {{ entryPrice: BN; priceImpact: BN; bestPrice: BN; worstPrice: BN; baseFilled: BN;
 *   quoteFilled: BN }} `entryPrice`/`bestPrice`/`worstPrice` are PRICE_PRECISION (1e6);
 *   `priceImpact` is `|entryPrice - bestPrice| / bestPrice`, also scaled by PRICE_PRECISION
 *   (1e6) but represents a ratio, not a price (e.g. `1e4` = 1% impact); `baseFilled` is
 *   BASE_PRECISION (1e9); `quoteFilled` is QUOTE_PRECISION (1e6). All-zero only if `amount` is
 *   zero; if liquidity runs out before `amount` fully fills, the returned fields reflect the
 *   partial fill
 */
export function calculateEstimatedPerpEntryPrice(
	assetType: AssetType,
	amount: BN,
	direction: PositionDirection,
	market: PerpMarketAccount,
	mmOraclePriceData: MMOraclePriceData,
	dlob: DLOB,
	slot: number,
	usersToSkip = new Map<PublicKey, boolean>()
): {
	entryPrice: BN;
	priceImpact: BN;
	bestPrice: BN;
	worstPrice: BN;
	baseFilled: BN;
	quoteFilled: BN;
} {
	if (amount.eq(ZERO)) {
		return {
			entryPrice: ZERO,
			priceImpact: ZERO,
			bestPrice: ZERO,
			worstPrice: ZERO,
			baseFilled: ZERO,
			quoteFilled: ZERO,
		};
	}

	const takerIsLong = isVariant(direction, 'long');
	const limitOrders = dlob[
		takerIsLong ? 'getRestingLimitAsks' : 'getRestingLimitBids'
	](
		market.marketIndex,
		slot,
		MarketType.PERP,
		mmOraclePriceData,
		undefined,
		market.orderTickSize
	);

	const swapDirection = getSwapDirection(assetType, direction);

	const { baseAssetReserve, quoteAssetReserve, sqrtK, newPeg } =
		calculateUpdatedAMMSpreadReserves(
			market.amm,
			market.marketStats,
			direction,
			mmOraclePriceData,
			new BN(slot)
		);
	const amm = {
		baseAssetReserve,
		quoteAssetReserve,
		sqrtK: sqrtK,
		pegMultiplier: newPeg,
	};

	const [ammBids, ammAsks] = calculateMarketOpenBidAsk(
		market.amm.baseAssetReserve,
		market.amm.minBaseAssetReserve,
		market.amm.maxBaseAssetReserve,
		market.orderStepSize
	);

	let ammLiquidity: BN;
	if (assetType === 'base') {
		ammLiquidity = takerIsLong ? ammAsks.abs() : ammBids;
	} else {
		const [afterSwapQuoteReserves, _] = calculateAmmReservesAfterSwap(
			amm,
			'base',
			takerIsLong ? ammAsks.abs() : ammBids,
			getSwapDirection('base', direction)
		);

		ammLiquidity = calculateQuoteAssetAmountSwapped(
			amm.quoteAssetReserve.sub(afterSwapQuoteReserves).abs(),
			amm.pegMultiplier,
			swapDirection
		);
	}

	const invariant = amm.sqrtK.mul(amm.sqrtK);

	let bestPrice = calculatePrice(
		amm.baseAssetReserve,
		amm.quoteAssetReserve,
		amm.pegMultiplier
	);

	let cumulativeBaseFilled = ZERO;
	let cumulativeQuoteFilled = ZERO;

	let limitOrder = limitOrders.next().value;
	if (limitOrder) {
		const limitOrderPrice = limitOrder.getPriceOrThrow(
			mmOraclePriceData,
			slot,
			market.orderTickSize
		);
		bestPrice = takerIsLong
			? BN.min(limitOrderPrice, bestPrice)
			: BN.max(limitOrderPrice, bestPrice);
	}

	let worstPrice = bestPrice;

	if (assetType === 'base') {
		while (
			!cumulativeBaseFilled.eq(amount) &&
			(ammLiquidity.gt(ZERO) || limitOrder)
		) {
			const limitOrderPrice = limitOrder?.getPrice(
				mmOraclePriceData,
				slot,
				market.orderTickSize
			);

			let maxAmmFill: BN;
			if (limitOrderPrice) {
				const newBaseReserves = squareRootBN(
					invariant
						.mul(PRICE_PRECISION)
						.mul(amm.pegMultiplier)
						.div(limitOrderPrice)
						.div(PEG_PRECISION)
				);

				// will be zero if the limit order price is better than the amm price
				maxAmmFill = takerIsLong
					? amm.baseAssetReserve.sub(newBaseReserves)
					: newBaseReserves.sub(amm.baseAssetReserve);
			} else {
				maxAmmFill = amount.sub(cumulativeBaseFilled);
			}

			maxAmmFill = BN.min(maxAmmFill, ammLiquidity);

			if (maxAmmFill.gt(ZERO)) {
				const baseFilled = BN.min(amount.sub(cumulativeBaseFilled), maxAmmFill);
				const [afterSwapQuoteReserves, afterSwapBaseReserves] =
					calculateAmmReservesAfterSwap(amm, 'base', baseFilled, swapDirection);

				ammLiquidity = ammLiquidity.sub(baseFilled);

				const quoteFilled = calculateQuoteAssetAmountSwapped(
					amm.quoteAssetReserve.sub(afterSwapQuoteReserves).abs(),
					amm.pegMultiplier,
					swapDirection
				);

				cumulativeBaseFilled = cumulativeBaseFilled.add(baseFilled);
				cumulativeQuoteFilled = cumulativeQuoteFilled.add(quoteFilled);

				amm.baseAssetReserve = afterSwapBaseReserves;
				amm.quoteAssetReserve = afterSwapQuoteReserves;

				worstPrice = calculatePrice(
					amm.baseAssetReserve,
					amm.quoteAssetReserve,
					amm.pegMultiplier
				);

				if (cumulativeBaseFilled.eq(amount)) {
					break;
				}
			}

			if (!limitOrder) {
				continue;
			}

			if (usersToSkip.has(limitOrder.userAccount)) {
				continue;
			}

			const baseFilled = BN.min(
				limitOrder.order.baseAssetAmount.sub(
					limitOrder.order.baseAssetAmountFilled
				),
				amount.sub(cumulativeBaseFilled)
			);
			const quoteFilled = baseFilled.mul(limitOrderPrice).div(BASE_PRECISION);

			cumulativeBaseFilled = cumulativeBaseFilled.add(baseFilled);
			cumulativeQuoteFilled = cumulativeQuoteFilled.add(quoteFilled);

			worstPrice = limitOrderPrice;

			if (cumulativeBaseFilled.eq(amount)) {
				break;
			}

			limitOrder = limitOrders.next().value;
		}
	} else {
		while (
			!cumulativeQuoteFilled.eq(amount) &&
			(ammLiquidity.gt(ZERO) || limitOrder)
		) {
			const limitOrderPrice = limitOrder?.getPrice(
				mmOraclePriceData,
				slot,
				market.orderTickSize
			);

			let maxAmmFill: BN;
			if (limitOrderPrice) {
				const newQuoteReserves = squareRootBN(
					invariant
						.mul(PEG_PRECISION)
						.mul(limitOrderPrice)
						.div(amm.pegMultiplier)
						.div(PRICE_PRECISION)
				);

				// will be zero if the limit order price is better than the amm price
				maxAmmFill = takerIsLong
					? newQuoteReserves.sub(amm.quoteAssetReserve)
					: amm.quoteAssetReserve.sub(newQuoteReserves);
			} else {
				maxAmmFill = amount.sub(cumulativeQuoteFilled);
			}

			maxAmmFill = BN.min(maxAmmFill, ammLiquidity);

			if (maxAmmFill.gt(ZERO)) {
				const quoteFilled = BN.min(
					amount.sub(cumulativeQuoteFilled),
					maxAmmFill
				);
				const [afterSwapQuoteReserves, afterSwapBaseReserves] =
					calculateAmmReservesAfterSwap(
						amm,
						'quote',
						quoteFilled,
						swapDirection
					);

				ammLiquidity = ammLiquidity.sub(quoteFilled);

				const baseFilled = afterSwapBaseReserves
					.sub(amm.baseAssetReserve)
					.abs();

				cumulativeBaseFilled = cumulativeBaseFilled.add(baseFilled);
				cumulativeQuoteFilled = cumulativeQuoteFilled.add(quoteFilled);

				amm.baseAssetReserve = afterSwapBaseReserves;
				amm.quoteAssetReserve = afterSwapQuoteReserves;

				worstPrice = calculatePrice(
					amm.baseAssetReserve,
					amm.quoteAssetReserve,
					amm.pegMultiplier
				);

				if (cumulativeQuoteFilled.eq(amount)) {
					break;
				}
			}

			if (!limitOrder) {
				continue;
			}

			if (usersToSkip.has(limitOrder.userAccount)) {
				continue;
			}

			const quoteFilled = BN.min(
				limitOrder.order.baseAssetAmount
					.sub(limitOrder.order.baseAssetAmountFilled)
					.mul(limitOrderPrice)
					.div(BASE_PRECISION),
				amount.sub(cumulativeQuoteFilled)
			);

			const baseFilled = quoteFilled.mul(BASE_PRECISION).div(limitOrderPrice);

			cumulativeBaseFilled = cumulativeBaseFilled.add(baseFilled);
			cumulativeQuoteFilled = cumulativeQuoteFilled.add(quoteFilled);

			worstPrice = limitOrderPrice;

			if (cumulativeQuoteFilled.eq(amount)) {
				break;
			}

			limitOrder = limitOrders.next().value;
		}
	}

	const entryPrice =
		cumulativeBaseFilled && cumulativeBaseFilled.gt(ZERO)
			? cumulativeQuoteFilled.mul(BASE_PRECISION).div(cumulativeBaseFilled)
			: ZERO;

	const priceImpact =
		bestPrice && bestPrice.gt(ZERO)
			? entryPrice.sub(bestPrice).mul(PRICE_PRECISION).div(bestPrice).abs()
			: ZERO;

	return {
		entryPrice,
		priceImpact,
		bestPrice,
		worstPrice,
		baseFilled: cumulativeBaseFilled,
		quoteFilled: cumulativeQuoteFilled,
	};
}

/**
 * Estimates entry price and price impact of a hypothetical taker order by walking a pre-built L2
 * order book snapshot (asks for a long taker, bids for a short taker), rather than the live DLOB.
 * Useful when an L2 snapshot is already available and a fresh DLOB walk isn't needed.
 *
 * @param {AssetType} assetType - Whether `amount` denominates base or quote
 * @param {BN} amount - Order size, `basePrecision` for `'base'`; QUOTE_PRECISION (1e6) for `'quote'`
 * @param {PositionDirection} direction - Taker's trade direction
 * @param {BN} basePrecision - The base precision to use for size/price math (e.g. `BASE_PRECISION`)
 * @param {L2OrderBook} l2 - Pre-computed L2 order book (bids/asks with price + size levels)
 * @return {{ entryPrice: BN; priceImpact: BN; bestPrice: BN; worstPrice: BN; baseFilled: BN;
 *   quoteFilled: BN }} `entryPrice`/`bestPrice`/`worstPrice` are PRICE_PRECISION (1e6);
 *   `priceImpact` is `|entryPrice - bestPrice| / bestPrice` scaled by PRICE_PRECISION (1e6);
 *   `baseFilled` is `basePrecision`-scaled; `quoteFilled` is QUOTE_PRECISION (1e6). If the book
 *   is empty, `bestPrice`/`worstPrice` are `BN_MAX` (long) or `ZERO` (short) and `entryPrice`/
 *   `priceImpact` are `ZERO`
 */
export function calculateEstimatedEntryPriceWithL2(
	assetType: AssetType,
	amount: BN,
	direction: PositionDirection,
	basePrecision: BN,
	l2: L2OrderBook
): {
	entryPrice: BN;
	priceImpact: BN;
	bestPrice: BN;
	worstPrice: BN;
	baseFilled: BN;
	quoteFilled: BN;
} {
	const takerIsLong = isVariant(direction, 'long');

	let cumulativeBaseFilled = ZERO;
	let cumulativeQuoteFilled = ZERO;

	const levels = [...(takerIsLong ? l2.asks : l2.bids)];
	let nextLevel = levels.shift();

	let bestPrice: BN;
	let worstPrice: BN;
	if (nextLevel) {
		bestPrice = nextLevel.price;
		worstPrice = nextLevel.price;
	} else {
		bestPrice = takerIsLong ? BN_MAX : ZERO;
		worstPrice = bestPrice;
	}

	if (assetType === 'base') {
		while (!cumulativeBaseFilled.eq(amount) && nextLevel) {
			const price = nextLevel.price;
			const size = nextLevel.size;

			worstPrice = price;

			const baseFilled = BN.min(size, amount.sub(cumulativeBaseFilled));
			const quoteFilled = baseFilled.mul(price).div(basePrecision);

			cumulativeBaseFilled = cumulativeBaseFilled.add(baseFilled);
			cumulativeQuoteFilled = cumulativeQuoteFilled.add(quoteFilled);

			nextLevel = levels.shift();
		}
	} else {
		while (!cumulativeQuoteFilled.eq(amount) && nextLevel) {
			const price = nextLevel.price;
			const size = nextLevel.size;

			worstPrice = price;

			const quoteFilled = BN.min(
				size.mul(price).div(basePrecision),
				amount.sub(cumulativeQuoteFilled)
			);
			const baseFilled = quoteFilled.mul(basePrecision).div(price);

			cumulativeBaseFilled = cumulativeBaseFilled.add(baseFilled);
			cumulativeQuoteFilled = cumulativeQuoteFilled.add(quoteFilled);

			nextLevel = levels.shift();
		}
	}

	const entryPrice =
		cumulativeBaseFilled && cumulativeBaseFilled.gt(ZERO)
			? cumulativeQuoteFilled.mul(basePrecision).div(cumulativeBaseFilled)
			: ZERO;

	const priceImpact =
		bestPrice && bestPrice.gt(ZERO)
			? entryPrice.sub(bestPrice).mul(PRICE_PRECISION).div(bestPrice).abs()
			: ZERO;

	return {
		entryPrice,
		priceImpact,
		bestPrice,
		worstPrice,
		baseFilled: cumulativeBaseFilled,
		quoteFilled: cumulativeQuoteFilled,
	};
}

/**
 * Estimates a user's trailing-30-day taker + maker volume as of `now`, using the same
 * time-weighted decay shape as the on-chain `update_taker_volume_30d` / `update_maker_volume_30d`
 * (`calculate_rolling_sum`) but without requiring a new fill to trigger the on-chain update —
 * useful for e.g. displaying live fee-tier progress between actual `UserStats` refreshes.
 *
 * @param {UserStatsAccount} userStatsAccount - The user's stats account (`takerVolume30D`,
 *   `makerVolume30D`, and their respective last-update timestamps)
 * @param {BN} [now] - Current unix timestamp (seconds); defaults to `Date.now() / 1000`
 * @return {BN} Estimated combined 30-day taker + maker volume, QUOTE_PRECISION (1e6)
 */
export function getUser30dRollingVolumeEstimate(
	userStatsAccount: UserStatsAccount,
	now?: BN
) {
	now = now || new BN(new Date().getTime() / 1000);
	const sinceLastTaker = BN.max(
		now.sub(userStatsAccount.lastTakerVolume30DTs),
		ZERO
	);
	const sinceLastMaker = BN.max(
		now.sub(userStatsAccount.lastMakerVolume30DTs),
		ZERO
	);
	const thirtyDaysInSeconds = new BN(60 * 60 * 24 * 30);
	const last30dVolume = userStatsAccount.takerVolume30D
		.mul(BN.max(thirtyDaysInSeconds.sub(sinceLastTaker), ZERO))
		.div(thirtyDaysInSeconds)
		.add(
			userStatsAccount.makerVolume30D
				.mul(BN.max(thirtyDaysInSeconds.sub(sinceLastMaker), ZERO))
				.div(thirtyDaysInSeconds)
		);

	return last30dVolume;
}
