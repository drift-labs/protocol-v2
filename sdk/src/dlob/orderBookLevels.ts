import {
	BASE_PRECISION,
	BN,
	calculateAmmReservesAfterSwap,
	calculateMarketOpenBidAsk,
	calculateQuoteAssetAmountSwapped,
	calculateSpreadReserves,
	calculateUpdatedAMM,
	DLOBNode,
	isOperationPaused,
	isVariant,
	OraclePriceData,
	PerpMarketAccount,
	PerpOperation,
	PositionDirection,
	QUOTE_PRECISION,
	standardizePrice,
	SwapDirection,
	ZERO,
} from '..';
import { PublicKey } from '@solana/web3.js';
import { assert } from '../assert/assert';

type liquiditySource = 'serum' | 'vamm' | 'dlob' | 'phoenix' | 'openbook';

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
		const size = dlobNode.order.baseAssetAmount.sub(
			dlobNode.order.baseAssetAmountFilled
		) as BN;
		yield {
			size,
			price: dlobNode.getPrice(oraclePriceData, slot),
			sources: {
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
	oraclePriceData,
	numOrders,
	now,
	topOfBookQuoteAmounts,
}: {
	marketAccount: PerpMarketAccount;
	oraclePriceData: OraclePriceData;
	numOrders: number;
	now?: BN;
	topOfBookQuoteAmounts?: BN[];
}): L2OrderBookGenerator {
	let numBaseOrders = numOrders;
	if (topOfBookQuoteAmounts) {
		numBaseOrders = numOrders - topOfBookQuoteAmounts.length;
		assert(topOfBookQuoteAmounts.length < numOrders);
	}

	const updatedAmm = calculateUpdatedAMM(marketAccount.amm, oraclePriceData);

	const vammFillsDisabled = isOperationPaused(
		marketAccount.pausedOperations,
		PerpOperation.AMM_FILL
	);

	let [openBids, openAsks] = vammFillsDisabled
		? [ZERO, ZERO]
		: calculateMarketOpenBidAsk(
				updatedAmm.baseAssetReserve,
				updatedAmm.minBaseAssetReserve,
				updatedAmm.maxBaseAssetReserve,
				updatedAmm.orderStepSize
		  );

	const minOrderSize = marketAccount.amm.minOrderSize;
	if (openBids.lt(minOrderSize.muln(2))) {
		openBids = ZERO;
	}

	if (openAsks.abs().lt(minOrderSize.muln(2))) {
		openAsks = ZERO;
	}

	now = now ?? new BN(Date.now() / 1000);
	const [bidReserves, askReserves] = calculateSpreadReserves(
		updatedAmm,
		oraclePriceData,
		now,
		isVariant(marketAccount.contractType, 'prediction')
	);

	let numBids = 0;

	let topOfBookBidSize = ZERO;
	let bidSize = openBids.div(new BN(numBaseOrders));
	const bidAmm = {
		baseAssetReserve: bidReserves.baseAssetReserve,
		quoteAssetReserve: bidReserves.quoteAssetReserve,
		sqrtK: updatedAmm.sqrtK,
		pegMultiplier: updatedAmm.pegMultiplier,
	};

	const getL2Bids = function* () {
		while (numBids < numOrders && bidSize.gt(ZERO)) {
			let quoteSwapped = ZERO;
			let baseSwapped = ZERO;
			let [afterSwapQuoteReserves, afterSwapBaseReserves] = [ZERO, ZERO];

			if (topOfBookQuoteAmounts && numBids < topOfBookQuoteAmounts?.length) {
				const remainingBaseLiquidity = openBids.sub(topOfBookBidSize);
				quoteSwapped = topOfBookQuoteAmounts[numBids];
				[afterSwapQuoteReserves, afterSwapBaseReserves] =
					calculateAmmReservesAfterSwap(
						bidAmm,
						'quote',
						quoteSwapped,
						SwapDirection.REMOVE
					);

				baseSwapped = bidAmm.baseAssetReserve.sub(afterSwapBaseReserves).abs();
				if (baseSwapped.eq(ZERO)) {
					return;
				}
				if (remainingBaseLiquidity.lt(baseSwapped)) {
					baseSwapped = remainingBaseLiquidity;
					[afterSwapQuoteReserves, afterSwapBaseReserves] =
						calculateAmmReservesAfterSwap(
							bidAmm,
							'base',
							baseSwapped,
							SwapDirection.ADD
						);

					quoteSwapped = calculateQuoteAssetAmountSwapped(
						bidAmm.quoteAssetReserve.sub(afterSwapQuoteReserves).abs(),
						bidAmm.pegMultiplier,
						SwapDirection.ADD
					);
				}
				topOfBookBidSize = topOfBookBidSize.add(baseSwapped);
				bidSize = openBids.sub(topOfBookBidSize).div(new BN(numBaseOrders));
			} else {
				baseSwapped = bidSize;
				[afterSwapQuoteReserves, afterSwapBaseReserves] =
					calculateAmmReservesAfterSwap(
						bidAmm,
						'base',
						baseSwapped,
						SwapDirection.ADD
					);

				quoteSwapped = calculateQuoteAssetAmountSwapped(
					bidAmm.quoteAssetReserve.sub(afterSwapQuoteReserves).abs(),
					bidAmm.pegMultiplier,
					SwapDirection.ADD
				);
			}

			const price = quoteSwapped.mul(BASE_PRECISION).div(baseSwapped);

			bidAmm.baseAssetReserve = afterSwapBaseReserves;
			bidAmm.quoteAssetReserve = afterSwapQuoteReserves;

			yield {
				price,
				size: baseSwapped,
				sources: { vamm: baseSwapped },
			};

			numBids++;
		}
	};

	let numAsks = 0;
	let topOfBookAskSize = ZERO;
	let askSize = openAsks.abs().div(new BN(numBaseOrders));
	const askAmm = {
		baseAssetReserve: askReserves.baseAssetReserve,
		quoteAssetReserve: askReserves.quoteAssetReserve,
		sqrtK: updatedAmm.sqrtK,
		pegMultiplier: updatedAmm.pegMultiplier,
	};

	const getL2Asks = function* () {
		while (numAsks < numOrders && askSize.gt(ZERO)) {
			let quoteSwapped: BN = ZERO;
			let baseSwapped: BN = ZERO;
			let [afterSwapQuoteReserves, afterSwapBaseReserves] = [ZERO, ZERO];

			if (topOfBookQuoteAmounts && numAsks < topOfBookQuoteAmounts?.length) {
				const remainingBaseLiquidity = openAsks
					.mul(new BN(-1))
					.sub(topOfBookAskSize);
				quoteSwapped = topOfBookQuoteAmounts[numAsks];
				[afterSwapQuoteReserves, afterSwapBaseReserves] =
					calculateAmmReservesAfterSwap(
						askAmm,
						'quote',
						quoteSwapped,
						SwapDirection.ADD
					);

				baseSwapped = askAmm.baseAssetReserve.sub(afterSwapBaseReserves).abs();
				if (baseSwapped.eq(ZERO)) {
					return;
				}
				if (remainingBaseLiquidity.lt(baseSwapped)) {
					baseSwapped = remainingBaseLiquidity;
					[afterSwapQuoteReserves, afterSwapBaseReserves] =
						calculateAmmReservesAfterSwap(
							askAmm,
							'base',
							baseSwapped,
							SwapDirection.REMOVE
						);

					quoteSwapped = calculateQuoteAssetAmountSwapped(
						askAmm.quoteAssetReserve.sub(afterSwapQuoteReserves).abs(),
						askAmm.pegMultiplier,
						SwapDirection.REMOVE
					);
				}
				topOfBookAskSize = topOfBookAskSize.add(baseSwapped);
				askSize = openAsks
					.abs()
					.sub(topOfBookAskSize)
					.div(new BN(numBaseOrders));
			} else {
				baseSwapped = askSize;
				[afterSwapQuoteReserves, afterSwapBaseReserves] =
					calculateAmmReservesAfterSwap(
						askAmm,
						'base',
						askSize,
						SwapDirection.REMOVE
					);

				quoteSwapped = calculateQuoteAssetAmountSwapped(
					askAmm.quoteAssetReserve.sub(afterSwapQuoteReserves).abs(),
					askAmm.pegMultiplier,
					SwapDirection.REMOVE
				);
			}

			const price = quoteSwapped.mul(BASE_PRECISION).div(baseSwapped);

			askAmm.baseAssetReserve = afterSwapBaseReserves;
			askAmm.quoteAssetReserve = afterSwapQuoteReserves;

			yield {
				price,
				size: baseSwapped,
				sources: { vamm: baseSwapped },
			};

			numAsks++;
		}
	};

	return {
		getL2Bids,
		getL2Asks,
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
