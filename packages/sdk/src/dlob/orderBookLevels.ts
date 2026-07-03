import { BN } from '../isomorphic/anchor';
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

type liquiditySource = 'vamm' | 'dlob' | 'indicative';

/**
 * A single aggregated price level of an L2 order book: one price with the combined size of all
 * orders resting at (or grouped into) that price, broken down by originating liquidity source.
 */
export type L2Level = {
	/** Level price, PRICE_PRECISION (1e6). */
	price: BN;
	/** Total size resting at this price, BASE_PRECISION (1e9). */
	size: BN;
	/** Size contributed by each liquidity source (`'vamm'`, `'dlob'`, `'indicative'`), BASE_PRECISION (1e9). Sources with no contribution are omitted rather than zero. */
	sources: { [key in liquiditySource]?: BN };
};

/** Aggregated (price, size) view of a market's book, as produced by `DLOB.getL2`. */
export type L2OrderBook = {
	/** Ask levels, ordered from best (lowest price) to worst. */
	asks: L2Level[];
	/** Bid levels, ordered from best (highest price) to worst. */
	bids: L2Level[];
	/** Slot the book was computed at, if the caller supplied one. */
	slot?: number;
};

/** Supplies fallback (non-DLOB) L2 liquidity — e.g. the vAMM — to be merged into `DLOB.getL2`'s output. See `getVammL2Generator`. */
export interface L2OrderBookGenerator {
	/** Yields ask levels best-first (ascending price). */
	getL2Asks(): Generator<L2Level>;
	/** Yields bid levels best-first (descending price). */
	getL2Bids(): Generator<L2Level>;
}

/** A single unaggregated order in an L3 (order-by-order) book view, as produced by `DLOB.getL3`. */
export type L3Level = {
	/** Order's limit price, PRICE_PRECISION (1e6). */
	price: BN;
	/** Order's remaining (unfilled) size, BASE_PRECISION (1e9). */
	size: BN;
	/** Pubkey of the order's owning `User` account. */
	maker: PublicKey;
	/** The order's `orderId` (unique per maker, not globally). */
	orderId: number;
};

/** Unaggregated, order-by-order view of a market's resting liquidity, as produced by `DLOB.getL3`. Does not include fallback (e.g. vAMM) liquidity. */
export type L3OrderBook = {
	/** Individual resting ask orders, ordered from best (lowest price) to worst. */
	asks: L3Level[];
	/** Individual resting bid orders, ordered from best (highest price) to worst. */
	bids: L3Level[];
	/** Slot the book was computed at, if the caller supplied one. */
	slot?: number;
};

/**
 * Default top-of-book quote notional breakpoints ($500/$1000/$2000/$5000, QUOTE_PRECISION 1e6)
 * used by `getVammL2Generator` to produce tighter, more granular vAMM levels near the top of the
 * book for non-major markets before falling back to evenly sized levels for the remaining depth.
 */
export const DEFAULT_TOP_OF_BOOK_QUOTE_AMOUNTS = [
	new BN(500).mul(QUOTE_PRECISION),
	new BN(1000).mul(QUOTE_PRECISION),
	new BN(2000).mul(QUOTE_PRECISION),
	new BN(5000).mul(QUOTE_PRECISION),
];

/**
 * Same as `DEFAULT_TOP_OF_BOOK_QUOTE_AMOUNTS` but sized for deeper/more liquid "majors" markets
 * ($5000/$10000/$20000/$50000, QUOTE_PRECISION 1e6). `DLOBSubscriber.getL2` selects this set for
 * `marketIndex < 3`.
 */
export const MAJORS_TOP_OF_BOOK_QUOTE_AMOUNTS = [
	new BN(5000).mul(QUOTE_PRECISION),
	new BN(10000).mul(QUOTE_PRECISION),
	new BN(20000).mul(QUOTE_PRECISION),
	new BN(50000).mul(QUOTE_PRECISION),
];

const INDICATIVE_QUOTES_PUBKEY = 'inDNdu3ML4vG5LNExqcwuCQtLcCU8KfK5YM2qYV3JJz';

/**
 * Converts a generator of individual `DLOBNode`s (already sorted best-first, e.g. from
 * `DLOB.getRestingLimitAsks`/`getRestingLimitBids`) into a generator of `L2Level`s — one level
 * per node, not yet merged by price (merging/deduping happens in `createL2Levels`). Nodes with
 * no order or with zero remaining size are skipped. A node owned by the well-known indicative
 * quotes pubkey is tagged as `sources.indicative` instead of `sources.dlob`.
 *
 * @param dlobNodes sorted node generator, e.g. `DLOB.getRestingLimitAsks` or `DLOB.getRestingLimitBids`
 * @param oraclePriceData oracle price data used to resolve each node's limit price
 * @param slot current slot, used to resolve each node's limit price
 * @param tickSize market order tick size, PRICE_PRECISION (1e6); passed through to `DLOBNode.getPriceOrThrow`
 * @returns a generator of `L2Level`s, one per DLOB node with remaining size
 * @throws if any yielded node has no resolvable limit price (via `getPriceOrThrow`)
 */
export function* getL2GeneratorFromDLOBNodes(
	dlobNodes: Generator<DLOBNode>,
	oraclePriceData: OraclePriceData,
	slot: number,
	tickSize?: BN
): Generator<L2Level> {
	for (const dlobNode of dlobNodes) {
		if (!dlobNode.order) {
			continue;
		}
		const size = dlobNode.baseAssetAmount.sub(
			dlobNode.order.baseAssetAmountFilled
		) as BN;

		if (size.lte(ZERO)) {
			continue;
		}

		yield {
			size,
			price: dlobNode.getPriceOrThrow(oraclePriceData, slot, tickSize),
			sources:
				dlobNode.userAccount == INDICATIVE_QUOTES_PUBKEY
					? { indicative: size }
					: {
							dlob: size,
					  },
		};
	}
}

/**
 * Merges multiple already-sorted `L2Level` generators (e.g. DLOB liquidity plus one or more
 * fallback sources) into a single sorted generator, using a k-way merge. Does not merge/dedupe
 * levels that land on the same price across generators — see `createL2Levels` for that.
 *
 * @param l2LevelGenerators generators to merge, each already sorted in the desired final order
 * @param compare returns true if `a` should be yielded before `b` (e.g. `a.price.lt(b.price)` for asks)
 * @returns a single generator yielding levels in the order defined by `compare`
 */
export function* mergeL2LevelGenerators(
	l2LevelGenerators: Generator<L2Level>[],
	compare: (a: L2Level, b: L2Level) => boolean
): Generator<L2Level> {
	type GeneratorState = {
		generator: Generator<L2Level>;
		next: IteratorResult<L2Level>;
	};

	const generators: GeneratorState[] = l2LevelGenerators.map((generator) => {
		return {
			generator,
			next: generator.next(),
		};
	});

	let next: GeneratorState | undefined;
	do {
		next = generators.reduce<GeneratorState | undefined>((best, next) => {
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

/**
 * Materializes a sorted `L2Level` generator into an array, merging consecutive levels that share
 * the same price (summing size and per-source sizes) and capping the result at `depth` distinct
 * price levels.
 *
 * @param generator sorted level generator, e.g. output of `mergeL2LevelGenerators`
 * @param depth maximum number of distinct price levels to return
 * @returns up to `depth` merged `L2Level`s
 */
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
			for (const [source, size] of Object.entries(level.sources) as [
				liquiditySource,
				BN,
			][]) {
				const existingSize = currentLevel.sources[source];
				if (existingSize) {
					currentLevel.sources[source] = existingSize.add(size);
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

/**
 * Builds an `L2OrderBookGenerator` that synthesizes vAMM (virtual AMM) liquidity levels for a
 * perp market, for use as fallback liquidity in `DLOB.getL2`. Simulates walking the AMM's
 * spread-adjusted reserves outward from the mid price on each side, standardizing prices to the
 * market's `orderTickSize` and sizes to its `orderStepSize`. Returns zero liquidity on a side
 * entirely if AMM fills are paused (`PerpOperation.AMM_FILL`) or if that side's open liquidity is
 * less than 2x the market's `minOrderSize`.
 *
 * @param marketAccount perp market whose AMM reserves/config drive the simulated levels
 * @param mmOraclePriceData market-maker oracle price data used to reprice the AMM before walking it
 * @param numOrders total number of levels to generate per side (including any top-of-book levels)
 * @param now unix timestamp (seconds) used for spread-reserve calculation; defaults to the current time
 * @param topOfBookQuoteAmounts quote-notional breakpoints (QUOTE_PRECISION, 1e6) used to size the
 *   first levels more granularly near the top of book — see `DEFAULT_TOP_OF_BOOK_QUOTE_AMOUNTS` /
 *   `MAJORS_TOP_OF_BOOK_QUOTE_AMOUNTS`; defaults to `[]` (all levels evenly sized)
 * @param latestSlot most recent known slot, improves spread-reserve accuracy when provided; optional
 * @returns a generator pair (`getL2Bids`/`getL2Asks`) yielding vAMM `L2Level`s, best price first,
 *   each tagged with `sources.vamm`
 */
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
				marketAccount.orderStepSize
		  );

	if (openBids.lt(marketAccount.marketStats.minOrderSize.muln(2)))
		openBids = ZERO;
	if (openAsks.abs().lt(marketAccount.marketStats.minOrderSize.muln(2)))
		openAsks = ZERO;

	const [bidReserves, askReserves] = calculateSpreadReserves(
		updatedAmm,
		marketAccount.marketStats,
		mmOraclePriceData,
		now,
		latestSlot
	);

	const numBaseOrders = Math.max(1, numOrders - topOfBookQuoteAmounts.length);
	const commonOpts = {
		numOrders,
		numBaseOrders,
		mmOraclePriceData,
		orderTickSize: marketAccount.orderTickSize,
		orderStepSize: marketAccount.orderStepSize,
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

/**
 * Re-buckets an `L2OrderBook`'s levels onto a coarser price grid ("grouping"), summing size and
 * per-source sizes of levels that land in the same bucket, and truncating each side to `depth`
 * levels. Bids are standardized down (grouped toward the taker-friendly direction for longs),
 * asks standardized up, matching on-chain price standardization semantics.
 *
 * @param l2 the ungrouped order book, e.g. from `DLOB.getL2`
 * @param grouping price bucket size, PRICE_PRECISION (1e6) — must be a multiple of the market's tick size to produce valid on-chain prices
 * @param depth maximum number of levels to keep per side after grouping
 * @returns a new `L2OrderBook` with grouped bids/asks (does not mutate `l2`)
 */
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
			for (const [source, size] of Object.entries(level.sources) as [
				liquiditySource,
				BN,
			][]) {
				const existingSize = currentLevel.sources[source];
				if (existingSize) {
					currentLevel.sources[source] = existingSize.add(size);
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
		const existing = merged.get(key);
		if (existing) {
			existing.size = existing.size.add(level.size);
			for (const [source, size] of Object.entries(level.sources) as [
				liquiditySource,
				BN,
			][]) {
				const existingSize = existing.sources[source];
				if (existingSize) {
					existing.sources[source] = existingSize.add(size);
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
 * No-ops (returns `bids`/`asks` unchanged) if either side is empty, or if the top of book is
 * already uncrossed (`bids[0].price < asks[0].price`).
 *
 * @param bids bid levels, PRICE_PRECISION (1e6) prices, best (highest) first
 * @param asks ask levels, PRICE_PRECISION (1e6) prices, best (lowest) first
 * @param oraclePrice current oracle price, PRICE_PRECISION (1e6)
 * @param oracleTwap5Min 5-minute oracle price TWAP, PRICE_PRECISION (1e6)
 * @param markTwap5Min 5-minute mark price TWAP, PRICE_PRECISION (1e6); `markTwap5Min - oracleTwap5Min` estimates the market's premium/discount to oracle, used as the reference point crossing liquidity is shifted around
 * @param grouping minimum price gap to enforce between the shifted bid/ask, PRICE_PRECISION (1e6)
 * @param userBids set of bid price strings (`BN.toString()`) belonging to the requesting user, which are left untouched rather than shifted
 * @param userAsks set of ask price strings (`BN.toString()`) belonging to the requesting user, which are left untouched rather than shifted
 * @returns new `bids`/`asks` arrays with crossing levels shifted apart by at least `grouping`; total size per side is preserved
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
			for (const [source, size] of Object.entries(oldLevel.sources) as [
				liquiditySource,
				BN,
			][]) {
				const existingSize = levels[levels.length - 1].sources[source];
				if (existingSize) {
					levels[levels.length - 1].sources = {
						...levels[levels.length - 1].sources,
						[source]: existingSize.add(size),
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
	let maxBid: BN | undefined;
	let minAsk: BN | undefined;

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
