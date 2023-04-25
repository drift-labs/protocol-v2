import { BN } from '..';
import { PerpMarketAccount, SwapDirection } from '../types';
import {
	calculateAmmReservesAfterSwap,
	calculateMarketOpenBidAsk,
	calculateQuoteAssetAmountSwapped,
	calculateSpreadReserves,
	calculateUpdatedAMM,
} from '../math/amm';
import { OraclePriceData } from '../oracles/types';
import { BASE_PRECISION } from '../constants/numericConstants';

export interface FallbackOrders {
	getBids(): Generator<{ price: BN; size: BN; source: string }>;
	getAsks(): Generator<{ price: BN; size: BN; source: string }>;
}

export function getVammOrders({
	marketAccount,
	oraclePriceData,
	numOrders,
	now,
}: {
	marketAccount: PerpMarketAccount;
	oraclePriceData: OraclePriceData;
	numOrders: number;
	now?: BN;
}) {
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
	const getBids = function* () {
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
				source: 'vAMM',
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
	const getAsks = function* () {
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
				source: 'vAMM',
			};

			numAsks++;
		}
	};

	return {
		getBids,
		getAsks,
	};
}
