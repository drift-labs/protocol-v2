"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.candlesToTvBars = exports.candleToTvBar = exports.resolutionStringToCandleLengthMs = exports.getNewTrades = exports.tradeRecordToUITrade = exports.convertTradesToCandle = exports.calculatePriceForTradeRecord = void 0;
const sdk_1 = require("@moet/sdk");
const web3_js_1 = require("@solana/web3.js");
const misc_1 = require("./misc");
const priceMantissa = sdk_1.AMM_MANTISSA;
const calculatePriceForTradeRecord = (quoteAssetAmount, baseAssetAmount) => {
    const priceWithMantissa = quoteAssetAmount
        .mul(sdk_1.QUOTE_BASE_PRECISION_DIFF)
        .mul(priceMantissa)
        .div(baseAssetAmount);
    return (priceWithMantissa.div(priceMantissa).toNumber() +
        priceWithMantissa.mod(priceMantissa).toNumber() / priceMantissa.toNumber());
};
exports.calculatePriceForTradeRecord = calculatePriceForTradeRecord;
const convertTradesToCandle = (trades, from, to) => {
    let min = trades[0].ts;
    let max = trades[0].ts;
    const batchTrades = trades
        .filter((t) => {
        if (t.ts < min)
            min = t.ts;
        if (t.ts > max)
            max = t.ts;
        if (from && t.ts < from)
            return false;
        if (to && t.ts >= to)
            return false;
        return true;
    })
        .sort((a, b) => a.chainTs - b.chainTs);
    if (batchTrades.length == 0) {
        return undefined;
    }
    else {
        const t0 = batchTrades[0];
        const c = {
            open: t0.beforePrice,
            close: t0.afterPrice,
            high: Math.max(t0.beforePrice, t0.afterPrice),
            low: Math.min(t0.beforePrice, t0.afterPrice),
            volume: t0.size,
            start: from !== null && from !== void 0 ? from : min,
            end: to !== null && to !== void 0 ? to : max,
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
exports.convertTradesToCandle = convertTradesToCandle;
const tradeRecordToUITrade = (tradeRecord) => {
    return {
        price: (0, exports.calculatePriceForTradeRecord)(tradeRecord.quoteAssetAmount, tradeRecord.baseAssetAmount),
        beforePrice: (0, misc_1.stripMantissa)(tradeRecord.markPriceBefore),
        afterPrice: (0, misc_1.stripMantissa)(tradeRecord.markPriceAfter),
        side: tradeRecord.direction.long ? sdk_1.TradeSide.Buy : sdk_1.TradeSide.Sell,
        ts: Date.now(),
        chainTs: tradeRecord.ts.toNumber(),
        size: (0, misc_1.stripBaseAssetPrecision)(tradeRecord.baseAssetAmount),
        marketIndex: tradeRecord.marketIndex.toNumber(),
    };
};
exports.tradeRecordToUITrade = tradeRecordToUITrade;
const defaultPublicKey = new web3_js_1.PublicKey('11111111111111111111111111111111');
const getNewTrades = (lastSeenTrade, tradingHistoryHead, tradeHistory) => {
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
    const newTrades = [];
    while (lastSeenHead != tradingHistoryHead) {
        const tradeRecord = tradeHistory.tradeRecords[lastSeenHead];
        //Skip blank trades which are created when clearingHouse initialized
        if (defaultPublicKey.equals(tradeRecord.userAuthority) ||
            tradeRecord.baseAssetAmount.eq(sdk_1.ZERO)) {
            lastSeenHead = (lastSeenHead + 1) % tradingHistorySize;
            continue;
        }
        const newTrade = (0, exports.tradeRecordToUITrade)(tradeRecord);
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
exports.getNewTrades = getNewTrades;
const resolutionStringToCandleLengthMs = (resolutionString) => {
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
exports.resolutionStringToCandleLengthMs = resolutionStringToCandleLengthMs;
const candleToTvBar = (candle) => {
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
exports.candleToTvBar = candleToTvBar;
/**
 * This method handles the candles that come back from the exchange history server and converts them into Bars for the TradingView Chart.
 * @param candles
 * @returns
 */
const candlesToTvBars = (candles) => {
    return candles.map((candle) => (0, exports.candleToTvBar)(candle));
};
exports.candlesToTvBars = candlesToTvBars;
