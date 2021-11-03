"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.liquidationRecordToUILiquidation = exports.resolutionStringToCandleLengthMs = exports.tradeRecordToUITrade = exports.convertTradesToCandle = exports.convertTradesToCandles = exports.getNewTrades = exports.stripBaseAssetPrecision = exports.stripMantissa = exports.calculatePriceForTradeRecord = void 0;
const web3_js_1 = require("@solana/web3.js");
const sdk_1 = require("@moet/sdk");
const sdk_2 = require("@moet/sdk");
const defaultPublicKey = new web3_js_1.PublicKey('11111111111111111111111111111111');
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
const stripMantissa = (bigNumber, precision = sdk_1.AMM_MANTISSA) => {
    if (!bigNumber)
        return 0;
    return (bigNumber.div(precision).toNumber() +
        bigNumber.mod(precision).toNumber() / precision.toNumber());
};
exports.stripMantissa = stripMantissa;
const stripBaseAssetPrecision = (baseAssetAmount) => {
    return (0, exports.stripMantissa)(baseAssetAmount, sdk_1.AMM_MANTISSA.mul(sdk_1.PEG_SCALAR));
};
exports.stripBaseAssetPrecision = stripBaseAssetPrecision;
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
const convertTradesToCandles = (trades, resolution, from, to) => {
    const candles = [];
    if (trades.length === 0)
        return [];
    let candleCounter = 0;
    while (from + resolution <= to) {
        const candle = (0, exports.convertTradesToCandle)(trades, from, from + resolution);
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
exports.convertTradesToCandles = convertTradesToCandles;
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
        beforePrice: (0, exports.stripMantissa)(tradeRecord.markPriceBefore),
        afterPrice: (0, exports.stripMantissa)(tradeRecord.markPriceAfter),
        side: tradeRecord.direction.long ? sdk_2.TradeSide.Buy : sdk_2.TradeSide.Sell,
        ts: Date.now(),
        chainTs: tradeRecord.ts.toNumber(),
        size: (0, exports.stripBaseAssetPrecision)(tradeRecord.baseAssetAmount),
        marketIndex: tradeRecord.marketIndex.toNumber(),
    };
};
exports.tradeRecordToUITrade = tradeRecordToUITrade;
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
const liquidationRecordToUILiquidation = (liquidationRecord) => {
    return {
        ts: Date.now(),
        chainTs: liquidationRecord.ts.toNumber(),
        recordId: (0, exports.stripMantissa)(liquidationRecord.recordId),
        userAuthority: liquidationRecord.userAuthority,
        user: liquidationRecord.user,
        partial: liquidationRecord.partial,
        baseAssetValue: (0, exports.stripMantissa)(liquidationRecord.baseAssetValue),
        baseAssetValueClosed: (0, exports.stripMantissa)(liquidationRecord.baseAssetValueClosed),
        liquidationFee: (0, exports.stripMantissa)(liquidationRecord.liquidationFee),
        feeToLiquidator: (0, exports.stripMantissa)(liquidationRecord.feeToLiquidator),
        feeToInsuranceFund: (0, exports.stripMantissa)(liquidationRecord.feeToInsuranceFund),
        liquidator: liquidationRecord.liquidator,
        totalCollateral: (0, exports.stripMantissa)(liquidationRecord.totalCollateral),
        collateral: (0, exports.stripMantissa)(liquidationRecord.collateral),
        unrealizedPnl: (0, exports.stripMantissa)(liquidationRecord.unrealizedPnl),
        marginRatio: (0, exports.stripMantissa)(liquidationRecord.marginRatio),
    };
};
exports.liquidationRecordToUILiquidation = liquidationRecordToUILiquidation;
