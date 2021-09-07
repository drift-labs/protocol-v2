import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { ZERO } from './constants/numericConstants';
import { TradeHistoryAccount, TradeRecord } from './DataTypes';
import { Candle, Trade, TradeSide } from './types';

const defaultPublicKey = new PublicKey('11111111111111111111111111111111');
const priceMantissa = new BN(10 ** 3);

const calculatePrice = (quoteAssetAmount: BN, baseAssetAmount: BN): number => {
	const priceWithMantissa = quoteAssetAmount
		.mul(priceMantissa)
		.div(baseAssetAmount);

	return (
		priceWithMantissa.div(priceMantissa).toNumber() +
		priceWithMantissa.mod(priceMantissa).toNumber() / priceMantissa.toNumber()
	);
};

export const getNewTrades = (
	currentHead: number,
	tradingHistoryHead: number,
	tradeHistory: TradeHistoryAccount
): {
	newTrades: { trade: Trade; userAccount: PublicKey }[];
	newHead: number;
} => {
	const tradingHistorySize = tradeHistory.tradeRecords.length;

	const tradesToProcess = Math.abs(tradingHistoryHead - currentHead);
	if (tradesToProcess > 0) {
		console.log(`${tradesToProcess} trades to process`);
	}

	const newTrades: { trade: Trade; userAccount: PublicKey }[] = [];

	let newHead = currentHead;

	while (newHead != tradingHistoryHead) {
		const tradeRecord = tradeHistory.tradeRecords[newHead];

		//Skip blank trades which are created when clearingHouse initialized
		if (
			defaultPublicKey.equals(tradeRecord.userPublicKey) ||
			tradeRecord.baseAssetAmount.eq(ZERO)
		) {
			newHead = (newHead + 1) % tradingHistorySize;
			continue;
		}

		const newTrade = TradeRecordToUITrade(tradeRecord);

		newTrades.push({
			trade: newTrade,
			userAccount: tradeRecord.userClearingHousePublicKey,
		});

		newHead = (newHead + 1) % tradingHistorySize;
	}

	return { newTrades, newHead: newHead };
};

export const convertTradesToCandles = (
	trades: Trade[],
	resolution: number,
	from: number,
	to: number
): Candle[] => {
	const candles: Candle[] = [];

	if (trades.length === 0) return [];

	while (from + resolution <= to) {
		const candle = convertTradesToCandle(trades, from, from + resolution);

		if (candle) {
			candles.push(candle);
		}
		from += resolution;
	}

	return candles;
};

export const convertTradesToCandle = (
	trades: Trade[],
	from?: number,
	to?: number
): Candle => {
	let min = trades[0].ts;
	let max = trades[0].ts;

	const batchTrades = trades.filter((t) => {
		if (t.ts < min) min = t.ts;
		if (t.ts > max) max = t.ts;

		if (from && t.ts < from) return false;
		if (to && t.ts >= to) return false;
		return true;
	});

	if (batchTrades.length == 0) {
		return undefined;
	} else {
		const t0 = batchTrades[0];
		const c = {
			open: t0.price,
			close: t0.price,
			high: t0.price,
			low: t0.price,
			volume: t0.size,
			vwap: t0.price * t0.size,
			start: from ?? min,
			end: to ?? max,
		};

		batchTrades.slice(1).forEach((t) => {
			c.close = t.price;
			c.high = Math.max(c.high, t.price);
			c.low = Math.min(c.low, t.price);
			c.volume += t.size;
			c.vwap += t.price * t.size;
		});

		c.vwap /= c.volume;

		return c;
	}
};

export const TradeRecordToUITrade = (tradeRecord: TradeRecord): Trade => {
	return {
		price: calculatePrice(
			tradeRecord.quoteAssetNotionalAmount,
			tradeRecord.baseAssetAmount
		),
		side: tradeRecord.direction.long ? TradeSide.Buy : TradeSide.Sell,
		ts: Date.now(),
		chainTs: tradeRecord.ts.toNumber(),
		size: tradeRecord.baseAssetAmount.toNumber() / 10 ** 6,
		marketIndex: tradeRecord.marketIndex.toNumber(),
	};
};
