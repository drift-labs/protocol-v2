import {
	AMM_MANTISSA,
	Candle,
	CandleResolution,
	QUOTE_BASE_PRECISION_DIFF,
	Trade,
	TradeHistoryAccount,
	TradeRecord,
	TradeSide,
	ZERO,
} from '@moet/sdk';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { stripBaseAssetPrecision, stripMantissa } from './misc';

const priceMantissa = AMM_MANTISSA;

export const calculatePriceForTradeRecord = (
	quoteAssetAmount: BN,
	baseAssetAmount: BN
): number => {
	const priceWithMantissa = quoteAssetAmount
		.mul(QUOTE_BASE_PRECISION_DIFF)
		.mul(priceMantissa)
		.div(baseAssetAmount);

	return (
		priceWithMantissa.div(priceMantissa).toNumber() +
		priceWithMantissa.mod(priceMantissa).toNumber() / priceMantissa.toNumber()
	);
};

export const convertTradesToCandle = (
	trades: Trade[],
	from?: number,
	to?: number
): Candle => {
	let min = trades[0].ts;
	let max = trades[0].ts;

	const batchTrades = trades
		.filter((t) => {
			if (t.ts < min) min = t.ts;
			if (t.ts > max) max = t.ts;

			if (from && t.ts < from) return false;
			if (to && t.ts >= to) return false;
			return true;
		})
		.sort((a, b) => a.chainTs - b.chainTs);

	if (batchTrades.length == 0) {
		return undefined;
	} else {
		const t0 = batchTrades[0];
		const c = {
			open: t0.beforePrice,
			close: t0.afterPrice,
			high: Math.max(t0.beforePrice, t0.afterPrice),
			low: Math.min(t0.beforePrice, t0.afterPrice),
			volume: t0.size,
			start: from ?? min,
			end: to ?? max,
		};

		batchTrades.slice(1).forEach((t) => {
			c.close = t.afterPrice;
			c.high = Math.max(c.high, t.beforePrice, t.afterPrice);
			c.low = Math.min(c.low, t.beforePrice, t.afterPrice);
			c.volume += t.size;
		});

		return c;
	}
};

export const tradeRecordToUITrade = (tradeRecord: TradeRecord): Trade => {
	return {
		price: calculatePriceForTradeRecord(
			tradeRecord.quoteAssetAmount,
			tradeRecord.baseAssetAmount
		),
		beforePrice: stripMantissa(tradeRecord.markPriceBefore),
		afterPrice: stripMantissa(tradeRecord.markPriceAfter),
		side: tradeRecord.direction.long ? TradeSide.Buy : TradeSide.Sell,
		ts: Date.now(),
		chainTs: tradeRecord.ts.toNumber(),
		size: stripBaseAssetPrecision(tradeRecord.baseAssetAmount),
		marketIndex: tradeRecord.marketIndex.toNumber(),
	};
};

const defaultPublicKey = new PublicKey('11111111111111111111111111111111');

export const getNewTrades = (
	lastSeenTrade: number,
	tradingHistoryHead: number,
	tradeHistory: TradeHistoryAccount
): {
	newTrades: { trade: Trade; userAccount: PublicKey }[];
	newLastSeenTrade: number;
} => {
	// last seen head is 1+lastSeenTrade because the head is always 1 ahead of the actual seen trade
	let lastSeenHead = lastSeenTrade + 1;

	const tradingHistorySize = tradeHistory.tradeRecords.length;

	const tradesToProcess = Math.abs(tradingHistoryHead - lastSeenTrade);

	if (tradesToProcess <= 0) {
		return {
			newTrades: [],
			newLastSeenTrade: lastSeenTrade,
		};
	}

	const newTrades: { trade: Trade; userAccount: PublicKey }[] = [];

	while (lastSeenHead != tradingHistoryHead) {
		const tradeRecord = tradeHistory.tradeRecords[lastSeenHead];
		//Skip blank trades which are created when clearingHouse initialized
		if (
			defaultPublicKey.equals(tradeRecord.userAuthority) ||
			tradeRecord.baseAssetAmount.eq(ZERO)
		) {
			lastSeenHead = (lastSeenHead + 1) % tradingHistorySize;
			continue;
		}

		const newTrade = tradeRecordToUITrade(tradeRecord);

		newTrades.push({
			trade: newTrade,
			userAccount: tradeRecord.user,
		});

		lastSeenHead = (lastSeenHead + 1) % tradingHistorySize;
	}

	return {
		newTrades,
		newLastSeenTrade: (lastSeenHead - 1) % tradingHistorySize,
	};
};

export const resolutionStringToCandleLengthMs = (
	resolutionString: CandleResolution
) => {
	switch (resolutionString) {
		case '1':
			return 1 * 60 * 1000;
		case '5':
			return 5 * 60 * 1000;
		case '15':
			return 15 * 60 * 1000;
		case '60':
			return 60 * 60 * 1000;
		case '240':
			return 240 * 60 * 1000;
		case 'D':
			return 24 * 60 * 60 * 1000;
		case 'W':
			return 7 * 24 * 60 * 60 * 1000;
		case 'M':
			return 30 * 24 * 60 * 60 * 1000;
	}
};

// This Type is copied from tradingview charting_library
type Bar = {
	time: number;
	open: number;
	high: number;
	low: number;
	close: number;
	volume?: number;
};

export const candleToTvBar = (candle: Candle): Bar => {
	return {
		// time: candle.start + new Date().getTimezoneOffset() * 60 * 1000 * -1,
		time: candle.start,
		open: candle.open,
		close: candle.close,
		low: candle.low,
		high: candle.high,
		volume: candle.volume,
	};
};

/**
 * This method handles the candles that come back from the exchange history server and converts them into Bars for the TradingView Chart.
 * @param candles
 * @returns
 */
export const candlesToTvBars = (candles: Candle[]): Bar[] => {
	return candles.map((candle) => candleToTvBar(candle));
};
