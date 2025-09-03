import { BN } from '@coral-xyz/anchor';
import {
	BASE_PRECISION,
	QUOTE_PRECISION,
	ZERO,
	PRICE_PRECISION,
	AMM_TO_QUOTE_PRECISION_RATIO,
} from '../constants/numericConstants';
import {
	calculateAmmReservesAfterSwap,
	calculateMarketOpenBidAsk,
	calculateQuoteAssetAmountSwapped,
	calculateSpreadReserves,
	calculateUpdatedAMM,
} from '../math/amm';
import { DLOBNode } from './DLOBNode';
import { isOperationPaused } from '../math/exchangeStatus';
import {
	isVariant,
	PerpMarketAccount,
	PerpOperation,
	PositionDirection,
	SwapDirection,
} from '../types';
import { MMOraclePriceData, OraclePriceData } from '../oracles/types';
import { PublicKey } from '@solana/web3.js';
import { standardizeBaseAssetAmount, standardizePrice } from '../math/orders';

type liquiditySource =
	| 'serum'
	| 'vamm'
	| 'dlob'
	| 'phoenix'
	| 'openbook'
	| 'indicative';

export type L2Level = {
	price: BN;
	size: BN;
	sources: { [key in liquiditySource]?: BN };
};

export type L2OrderBook = {
	asks: L2Level[];
	bids: L2Level[];
	slot?: number;
};

export interface L2OrderBookGenerator {
	getL2Asks(): Generator<L2Level>;
	getL2Bids(): Generator<L2Level>;
}

export type L3Level = {
	price: BN;
	size: BN;
	maker: PublicKey;
	orderId: number;
};

export type L3OrderBook = {
	asks: L3Level[];
	bids: L3Level[];
	slot?: number;
};

export const DEFAULT_TOP_OF_BOOK_QUOTE_AMOUNTS = [
	new BN(500).mul(QUOTE_PRECISION),
	new BN(1000).mul(QUOTE_PRECISION),
	new BN(2000).mul(QUOTE_PRECISION),
	new BN(5000).mul(QUOTE_PRECISION),
];

export const MAJORS_TOP_OF_BOOK_QUOTE_AMOUNTS = [
	new BN(5000).mul(QUOTE_PRECISION),
	new BN(10000).mul(QUOTE_PRECISION),
	new BN(20000).mul(QUOTE_PRECISION),
	new BN(50000).mul(QUOTE_PRECISION),
];

const INDICATIVE_QUOTES_PUBKEY = 'inDNdu3ML4vG5LNExqcwuCQtLcCU8KfK5YM2qYV3JJz';

/**
 * Get an {@link Generator<L2Level>} generator from a {@link Generator<DLOBNode>}
 * @param dlobNodes e.g. {@link DLOB#getRestingLimitAsks} or {@link DLOB#getRestingLimitBids}
 * @param oraclePriceData
 * @param slot
 */
export function* getL2GeneratorFromDLOBNodes(
	dlobNodes: Generator<DLOBNode>,
	oraclePriceData: OraclePriceData,
	slot: number
): Generator<L2Level> {
	for (const dlobNode of dlobNodes) {
		const size = dlobNode.baseAssetAmount.sub(
			dlobNode.order.baseAssetAmountFilled
		) as BN;

		if (size.lte(ZERO)) {
			continue;
		}

		yield {
			size,
			price: dlobNode.getPrice(oraclePriceData, slot),
			sources:
				dlobNode.userAccount == INDICATIVE_QUOTES_PUBKEY
					? { indicative: size }
					: {
							dlob: size,
					  },
		};
	}
}

export function* mergeL2LevelGenerators(
	l2LevelGenerators: Generator<L2Level>[],
	compare: (a: L2Level, b: L2Level) => boolean
): Generator<L2Level> {
	const generators = l2LevelGenerators.map((generator) => {
		return {
			generator,
			next: generator.next(),
		};
	});

	let next;
	do {
		next = generators.reduce((best, next) => {
			if (next.next.done) {
				return best;
			}

			if (!best) {
				return next;
			}

			if (compare(next.next.value, best.next.value)) {
				return next;
			} else {
				return best;
			}
		}, undefined);

		if (next) {
			yield next.next.value;
			next.next = next.generator.next();
		}
	} while (next !== undefined);
}

export function createL2Levels(
	generator: Generator<L2Level>,
	depth: number
): L2Level[] {
	const levels = [];
	for (const level of generator) {
		const price = level.price;
		const size = level.size;
		if (levels.length > 0 && levels[levels.length - 1].price.eq(price)) {
			const currentLevel = levels[levels.length - 1];
			currentLevel.size = currentLevel.size.add(size);
			for (const [source, size] of Object.entries(level.sources)) {
				if (currentLevel.sources[source]) {
					currentLevel.sources[source] = currentLevel.sources[source].add(size);
				} else {
					currentLevel.sources[source] = size;
				}
			}
		} else if (levels.length === depth) {
			break;
		} else {
			levels.push(level);
		}
	}
	return levels;
}

export function getVammL2Generator({
	marketAccount,
	mmOraclePriceData,
	numOrders,
	now = new BN(Math.floor(Date.now() / 1000)),
	topOfBookQuoteAmounts = [],
	latestSlot,
}: {
	marketAccount: PerpMarketAccount;
	mmOraclePriceData: MMOraclePriceData;
	numOrders: number;
	now?: BN;
	topOfBookQuoteAmounts?: BN[];
	latestSlot?: BN;
}): L2OrderBookGenerator {
	const updatedAmm = calculateUpdatedAMM(marketAccount.amm, mmOraclePriceData);
	const paused = isOperationPaused(
		marketAccount.pausedOperations,
		PerpOperation.AMM_FILL
	);
	let [openBids, openAsks] = paused
		? [ZERO, ZERO]
		: calculateMarketOpenBidAsk(
				updatedAmm.baseAssetReserve,
				updatedAmm.minBaseAssetReserve,
				updatedAmm.maxBaseAssetReserve,
				updatedAmm.orderStepSize
		  );

	if (openBids.lt(marketAccount.amm.minOrderSize.muln(2))) openBids = ZERO;
	if (openAsks.abs().lt(marketAccount.amm.minOrderSize.muln(2)))
		openAsks = ZERO;

	const [bidReserves, askReserves] = calculateSpreadReserves(
		updatedAmm,
		mmOraclePriceData,
		now,
		isVariant(marketAccount.contractType, 'prediction'),
		latestSlot
	);

	const numBaseOrders = Math.max(1, numOrders - topOfBookQuoteAmounts.length);
	const commonOpts = {
		numOrders,
		numBaseOrders,
		mmOraclePriceData,
		orderTickSize: marketAccount.amm.orderTickSize,
		orderStepSize: marketAccount.amm.orderStepSize,
		pegMultiplier: updatedAmm.pegMultiplier,
		sqrtK: updatedAmm.sqrtK,
		topOfBookQuoteAmounts,
	};

	const makeL2Gen = ({
		openLiquidity,
		startReserves,
		swapDir,
		positionDir,
	}: {
		openLiquidity: BN;
		startReserves: { baseAssetReserve: BN; quoteAssetReserve: BN };
		swapDir: SwapDirection;
		positionDir: PositionDirection;
	}) => {
		return function* () {
			let count = 0;
			let topSize = ZERO;
			let size = openLiquidity.abs().divn(commonOpts.numBaseOrders);
			const amm = {
				...startReserves,
				sqrtK: commonOpts.sqrtK,
				pegMultiplier: commonOpts.pegMultiplier,
			};

			while (count < commonOpts.numOrders && size.gt(ZERO)) {
				let baseSwap = size;
				if (count < commonOpts.topOfBookQuoteAmounts.length) {
					const raw = commonOpts.topOfBookQuoteAmounts[count]
						.mul(AMM_TO_QUOTE_PRECISION_RATIO)
						.mul(PRICE_PRECISION)
						.div(commonOpts.mmOraclePriceData.price);
					baseSwap = standardizeBaseAssetAmount(raw, commonOpts.orderStepSize);
					const remaining = openLiquidity.abs().sub(topSize);
					if (remaining.lt(baseSwap)) baseSwap = remaining;
				}
				if (baseSwap.isZero()) return;

				const [newQuoteRes, newBaseRes] = calculateAmmReservesAfterSwap(
					amm,
					'base',
					baseSwap,
					swapDir
				);
				const quoteSwapped = calculateQuoteAssetAmountSwapped(
					amm.quoteAssetReserve.sub(newQuoteRes).abs(),
					amm.pegMultiplier,
					swapDir
				);
				const price = standardizePrice(
					quoteSwapped.mul(BASE_PRECISION).div(baseSwap),
					commonOpts.orderTickSize,
					positionDir
				);

				amm.baseAssetReserve = newBaseRes;
				amm.quoteAssetReserve = newQuoteRes;

				if (count < commonOpts.topOfBookQuoteAmounts.length) {
					topSize = topSize.add(baseSwap);
					size = openLiquidity
						.abs()
						.sub(topSize)
						.divn(commonOpts.numBaseOrders);
				}

				yield { price, size: baseSwap, sources: { vamm: baseSwap } };
				count++;
			}
		};
	};

	return {
		getL2Bids: makeL2Gen({
			openLiquidity: openBids,
			startReserves: bidReserves,
			swapDir: SwapDirection.ADD,
			positionDir: PositionDirection.LONG,
		}),
		getL2Asks: makeL2Gen({
			openLiquidity: openAsks,
			startReserves: askReserves,
			swapDir: SwapDirection.REMOVE,
			positionDir: PositionDirection.SHORT,
		}),
	};
}

export function groupL2(
	l2: L2OrderBook,
	grouping: BN,
	depth: number
): L2OrderBook {
	return {
		bids: groupL2Levels(l2.bids, grouping, PositionDirection.LONG, depth),
		asks: groupL2Levels(l2.asks, grouping, PositionDirection.SHORT, depth),
		slot: l2.slot,
	};
}

function cloneL2Level(level: L2Level): L2Level {
	if (!level) return level;

	return {
		price: level.price,
		size: level.size,
		sources: { ...level.sources },
	};
}

function groupL2Levels(
	levels: L2Level[],
	grouping: BN,
	direction: PositionDirection,
	depth: number
): L2Level[] {
	const groupedLevels: L2Level[] = [];
	for (const level of levels) {
		const price = standardizePrice(level.price, grouping, direction);
		const size = level.size;
		if (
			groupedLevels.length > 0 &&
			groupedLevels[groupedLevels.length - 1].price.eq(price)
		) {
			// Clones things so we don't mutate the original
			const currentLevel = cloneL2Level(
				groupedLevels[groupedLevels.length - 1]
			);

			currentLevel.size = currentLevel.size.add(size);
			for (const [source, size] of Object.entries(level.sources)) {
				if (currentLevel.sources[source]) {
					currentLevel.sources[source] = currentLevel.sources[source].add(size);
				} else {
					currentLevel.sources[source] = size;
				}
			}

			groupedLevels[groupedLevels.length - 1] = currentLevel;
		} else {
			const groupedLevel = {
				price: price,
				size,
				sources: level.sources,
			};
			groupedLevels.push(groupedLevel);
		}

		if (groupedLevels.length === depth) {
			break;
		}
	}
	return groupedLevels;
}

/**
 * Method to merge bids or asks by price
 */
const mergeByPrice = (bidsOrAsks: L2Level[]) => {
	const merged = new Map<string, L2Level>();
	for (const level of bidsOrAsks) {
		const key = level.price.toString();
		if (merged.has(key)) {
			const existing = merged.get(key);
			existing.size = existing.size.add(level.size);
			for (const [source, size] of Object.entries(level.sources)) {
				if (existing.sources[source]) {
					existing.sources[source] = existing.sources[source].add(size);
				} else {
					existing.sources[source] = size;
				}
			}
		} else {
			merged.set(key, cloneL2Level(level));
		}
	}
	return Array.from(merged.values());
};

/**
 * The purpose of this function is uncross the L2 orderbook by modifying the bid/ask price at the top of the book
 * This will make the liquidity look worse but more intuitive (users familiar with clob get confused w temporarily
 * crossing book)
 *
 * Things to note about how it works:
 * - it will not uncross the user's liquidity
 * - it does the uncrossing by "shifting" the crossing liquidity to the nearest uncrossed levels. Thus the output liquidity maintains the same total size.
 *
 * @param bids
 * @param asks
 * @param oraclePrice
 * @param oracleTwap5Min
 * @param markTwap5Min
 * @param grouping
 * @param userBids
 * @param userAsks
 */
export function uncrossL2(
	bids: L2Level[],
	asks: L2Level[],
	oraclePrice: BN,
	oracleTwap5Min: BN,
	markTwap5Min: BN,
	grouping: BN,
	userBids: Set<string>,
	userAsks: Set<string>
): { bids: L2Level[]; asks: L2Level[] } {
	// If there are no bids or asks, there is nothing to center
	if (bids.length === 0 || asks.length === 0) {
		return { bids, asks };
	}

	// If the top of the book is already centered, there is nothing to do
	if (bids[0].price.lt(asks[0].price)) {
		return { bids, asks };
	}

	const newBids: L2Level[] = [];
	const newAsks: L2Level[] = [];

	const updateLevels = (newPrice: BN, oldLevel: L2Level, levels: L2Level[]) => {
		if (levels.length > 0 && levels[levels.length - 1].price.eq(newPrice)) {
			levels[levels.length - 1].size = levels[levels.length - 1].size.add(
				oldLevel.size
			);
			for (const [source, size] of Object.entries(oldLevel.sources)) {
				if (levels[levels.length - 1].sources[source]) {
					levels[levels.length - 1].sources = {
						...levels[levels.length - 1].sources,
						[source]: levels[levels.length - 1].sources[source].add(size),
					};
				} else {
					levels[levels.length - 1].sources[source] = size;
				}
			}
		} else {
			levels.push({
				price: newPrice,
				size: oldLevel.size,
				sources: oldLevel.sources,
			});
		}
	};

	// This is the best estimate of the premium in the market vs oracle to filter crossing around
	const referencePrice = oraclePrice.add(markTwap5Min.sub(oracleTwap5Min));

	let bidIndex = 0;
	let askIndex = 0;
	let maxBid: BN;
	let minAsk: BN;

	const getPriceAndSetBound = (newPrice: BN, direction: PositionDirection) => {
		if (isVariant(direction, 'long')) {
			maxBid = maxBid ? BN.min(maxBid, newPrice) : newPrice;
			return maxBid;
		} else {
			minAsk = minAsk ? BN.max(minAsk, newPrice) : newPrice;
			return minAsk;
		}
	};

	while (bidIndex < bids.length || askIndex < asks.length) {
		const nextBid = cloneL2Level(bids[bidIndex]);
		const nextAsk = cloneL2Level(asks[askIndex]);

		if (!nextBid) {
			newAsks.push(nextAsk);
			askIndex++;
			continue;
		}

		if (!nextAsk) {
			newBids.push(nextBid);
			bidIndex++;
			continue;
		}

		if (userBids.has(nextBid.price.toString())) {
			newBids.push(nextBid);
			bidIndex++;
			continue;
		}

		if (userAsks.has(nextAsk.price.toString())) {
			newAsks.push(nextAsk);
			askIndex++;
			continue;
		}

		if (nextBid.price.gte(nextAsk.price)) {
			if (
				nextBid.price.gt(referencePrice) &&
				nextAsk.price.gt(referencePrice)
			) {
				let newBidPrice = nextAsk.price.sub(grouping);
				newBidPrice = getPriceAndSetBound(newBidPrice, PositionDirection.LONG);
				updateLevels(newBidPrice, nextBid, newBids);
				bidIndex++;
			} else if (
				nextAsk.price.lt(referencePrice) &&
				nextBid.price.lt(referencePrice)
			) {
				let newAskPrice = nextBid.price.add(grouping);
				newAskPrice = getPriceAndSetBound(newAskPrice, PositionDirection.SHORT);
				updateLevels(newAskPrice, nextAsk, newAsks);
				askIndex++;
			} else {
				let newBidPrice = referencePrice.sub(grouping);
				let newAskPrice = referencePrice.add(grouping);

				newBidPrice = getPriceAndSetBound(newBidPrice, PositionDirection.LONG);
				newAskPrice = getPriceAndSetBound(newAskPrice, PositionDirection.SHORT);

				updateLevels(newBidPrice, nextBid, newBids);
				updateLevels(newAskPrice, nextAsk, newAsks);
				bidIndex++;
				askIndex++;
			}
		} else {
			if (minAsk && nextAsk.price.lte(minAsk)) {
				const newAskPrice = getPriceAndSetBound(
					nextAsk.price,
					PositionDirection.SHORT
				);
				updateLevels(newAskPrice, nextAsk, newAsks);
			} else {
				newAsks.push(nextAsk);
			}
			askIndex++;

			if (maxBid && nextBid.price.gte(maxBid)) {
				const newBidPrice = getPriceAndSetBound(
					nextBid.price,
					PositionDirection.LONG
				);
				updateLevels(newBidPrice, nextBid, newBids);
			} else {
				newBids.push(nextBid);
			}
			bidIndex++;
		}
	}

	newBids.sort((a, b) => b.price.cmp(a.price));
	newAsks.sort((a, b) => a.price.cmp(b.price));

	const finalNewBids = mergeByPrice(newBids);
	const finalNewAsks = mergeByPrice(newAsks);

	return {
		bids: finalNewBids,
		asks: finalNewAsks,
	};
}
