import {
	BASE_PRECISION,
	BN,
	calculateAmmReservesAfterSwap,
	calculateMarketOpenBidAsk,
	calculateQuoteAssetAmountSwapped,
	calculateSpreadReserves,
	calculateUpdatedAMM,
	DLOBNode,
	OraclePriceData,
	PerpMarketAccount,
	PositionDirection,
	standardizePrice,
	SwapDirection,
	ZERO,
} from '..';
import { PublicKey } from '@solana/web3.js';
import { assert } from '../assert/assert';

type liquiditySource = 'serum' | 'vamm' | 'dlob' | 'phoenix';

export type L2Level = {
	price: BN;
	size: BN;
	sources: { [key in liquiditySource]?: BN };
};

export type L2OrderBook = {
	asks: L2Level[];
	bids: L2Level[];
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
};

/**
 * Get an {@link Generator<L2Level>} generator from a {@link Generator<DLOBNode>}
 * @param dlobNodes e.g. {@link DLOB#getMakerLimitAsks} or {@link DLOB#getMakerLimitBids}
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
	topofBookQuoteAmounts,
}: {
	marketAccount: PerpMarketAccount;
	oraclePriceData: OraclePriceData;
	numOrders: number;
	now?: BN;
	topofBookQuoteAmounts?: BN[];
}): L2OrderBookGenerator {
	let numBaseOrders = numOrders;
	if (topofBookQuoteAmounts) {
		numBaseOrders = numOrders - topofBookQuoteAmounts.length;
		assert(topofBookQuoteAmounts.length < numOrders);
	}

	const updatedAmm = calculateUpdatedAMM(marketAccount.amm, oraclePriceData);

	const [openBids, openAsks] = calculateMarketOpenBidAsk(
		updatedAmm.baseAssetReserve,
		updatedAmm.minBaseAssetReserve,
		updatedAmm.maxBaseAssetReserve,
		updatedAmm.orderStepSize
	);

	now = now ?? new BN(Date.now() / 1000);
	const [bidReserves, askReserves] = calculateSpreadReserves(
		updatedAmm,
		oraclePriceData,
		now
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

			if (numBids < topofBookQuoteAmounts.length) {
				quoteSwapped = topofBookQuoteAmounts[numBids];
				[afterSwapQuoteReserves, afterSwapBaseReserves] =
					calculateAmmReservesAfterSwap(
						bidAmm,
						'quote',
						quoteSwapped,
						SwapDirection.REMOVE
					);

				baseSwapped = bidAmm.baseAssetReserve.sub(afterSwapBaseReserves).abs();
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

			if (numAsks < topofBookQuoteAmounts.length) {
				quoteSwapped = topofBookQuoteAmounts[numAsks];
				[afterSwapQuoteReserves, afterSwapBaseReserves] =
					calculateAmmReservesAfterSwap(
						askAmm,
						'quote',
						quoteSwapped,
						SwapDirection.ADD
					);

				baseSwapped = askAmm.baseAssetReserve.sub(afterSwapBaseReserves).abs();
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
	};
}

function groupL2Levels(
	levels: L2Level[],
	grouping: BN,
	direction: PositionDirection,
	depth: number
): L2Level[] {
	const groupedLevels = [];
	for (const level of levels) {
		const price = standardizePrice(level.price, grouping, direction);
		const size = level.size;
		if (
			groupedLevels.length > 0 &&
			groupedLevels[groupedLevels.length - 1].price.eq(price)
		) {
			const currentLevel = groupedLevels[groupedLevels.length - 1];
			currentLevel.size = currentLevel.size.add(size);
			for (const [source, size] of Object.entries(level.sources)) {
				if (currentLevel.sources[source]) {
					currentLevel.sources[source] = currentLevel.sources[source].add(size);
				} else {
					currentLevel.sources[source] = size;
				}
			}
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
