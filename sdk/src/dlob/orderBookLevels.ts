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
	SwapDirection,
} from '..';
import { PublicKey } from '@solana/web3.js';

type liquiditySource = 'serum' | 'vamm' | 'dlob';

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
			currentLevel.size.add(size);
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
}: {
	marketAccount: PerpMarketAccount;
	oraclePriceData: OraclePriceData;
	numOrders: number;
	now?: BN;
}): L2OrderBookGenerator {
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
	const baseSize = openBids.div(new BN(numOrders));
	const bidAmm = {
		baseAssetReserve: bidReserves.baseAssetReserve,
		quoteAssetReserve: bidReserves.quoteAssetReserve,
		sqrtK: updatedAmm.sqrtK,
		pegMultiplier: updatedAmm.pegMultiplier,
	};
	const getL2Bids = function* () {
		while (numBids < numOrders) {
			const [afterSwapQuoteReserves, afterSwapBaseReserves] =
				calculateAmmReservesAfterSwap(
					bidAmm,
					'base',
					baseSize,
					SwapDirection.ADD
				);

			const quoteSwapped = calculateQuoteAssetAmountSwapped(
				bidAmm.quoteAssetReserve.sub(afterSwapQuoteReserves).abs(),
				bidAmm.pegMultiplier,
				SwapDirection.ADD
			);

			const price = quoteSwapped.mul(BASE_PRECISION).div(baseSize);

			bidAmm.baseAssetReserve = afterSwapBaseReserves;
			bidAmm.quoteAssetReserve = afterSwapQuoteReserves;

			yield {
				price,
				size: baseSize,
				sources: { vamm: baseSize },
			};

			numBids++;
		}
	};

	let numAsks = 0;
	const askSize = openAsks.abs().div(new BN(numOrders));
	const askAmm = {
		baseAssetReserve: askReserves.baseAssetReserve,
		quoteAssetReserve: askReserves.quoteAssetReserve,
		sqrtK: updatedAmm.sqrtK,
		pegMultiplier: updatedAmm.pegMultiplier,
	};
	const getL2Asks = function* () {
		while (numAsks < numOrders) {
			const [afterSwapQuoteReserves, afterSwapBaseReserves] =
				calculateAmmReservesAfterSwap(
					askAmm,
					'base',
					askSize,
					SwapDirection.REMOVE
				);

			const quoteSwapped = calculateQuoteAssetAmountSwapped(
				askAmm.quoteAssetReserve.sub(afterSwapQuoteReserves).abs(),
				askAmm.pegMultiplier,
				SwapDirection.REMOVE
			);

			const price = quoteSwapped.mul(BASE_PRECISION).div(askSize);

			askAmm.baseAssetReserve = afterSwapBaseReserves;
			askAmm.quoteAssetReserve = afterSwapQuoteReserves;

			yield {
				price,
				size: askSize,
				sources: { vamm: baseSize },
			};

			numAsks++;
		}
	};

	return {
		getL2Bids,
		getL2Asks,
	};
}
