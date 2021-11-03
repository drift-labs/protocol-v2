import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import {
	AMM_MANTISSA,
	PEG_SCALAR,
	QUOTE_BASE_PRECISION_DIFF,
	ZERO,
} from '../constants/numericConstants';
import {
	Candle,
	Trade,
	TradeSide,
	CandleResolution,
	TradeHistoryAccount,
	TradeRecord,
} from '../types';
import { Liquidation, LiquidationRecord } from '../types';

const defaultPublicKey = new PublicKey('11111111111111111111111111111111');
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

export const stripMantissa = (bigNumber: BN, precision: BN = AMM_MANTISSA) => {
	if (!bigNumber) return 0;
	return (
		bigNumber.div(precision).toNumber() +
		bigNumber.mod(precision).toNumber() / precision.toNumber()
	);
};

export const stripBaseAssetPrecision = (baseAssetAmount: BN) => {
	return stripMantissa(baseAssetAmount, AMM_MANTISSA.mul(PEG_SCALAR));
};

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

export const convertTradesToCandles = (
	trades: Trade[],
	resolution: number,
	from: number,
	to: number
): Candle[] => {
	const candles: Candle[] = [];

	if (trades.length === 0) return [];

	let candleCounter = 0;

	while (from + resolution <= to) {
		const candle = convertTradesToCandle(trades, from, from + resolution);

		if (candle) {
			if (candleCounter > 0) {
				candle.open = candles[candleCounter - 1].close;
			}

			candles.push(candle);
			candleCounter++;
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

export const liquidationRecordToUILiquidation = (
	liquidationRecord: LiquidationRecord
): Liquidation => {
	return {
		ts: Date.now(),
		chainTs: liquidationRecord.ts.toNumber(),
		recordId: stripMantissa(liquidationRecord.recordId),
		userAuthority: liquidationRecord.userAuthority,
		user: liquidationRecord.user,
		partial: liquidationRecord.partial,
		baseAssetValue: stripMantissa(liquidationRecord.baseAssetValue),
		baseAssetValueClosed: stripMantissa(liquidationRecord.baseAssetValueClosed),
		liquidationFee: stripMantissa(liquidationRecord.liquidationFee),
		feeToLiquidator: stripMantissa(liquidationRecord.feeToLiquidator),
		feeToInsuranceFund: stripMantissa(liquidationRecord.feeToInsuranceFund),
		liquidator: liquidationRecord.liquidator,
		totalCollateral: stripMantissa(liquidationRecord.totalCollateral),
		collateral: stripMantissa(liquidationRecord.collateral),
		unrealizedPnl: stripMantissa(liquidationRecord.unrealizedPnl),
		marginRatio: stripMantissa(liquidationRecord.marginRatio),
	};
};
