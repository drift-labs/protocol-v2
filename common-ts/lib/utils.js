"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.candlesToTvBars = exports.candleToTvBar = void 0;
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
