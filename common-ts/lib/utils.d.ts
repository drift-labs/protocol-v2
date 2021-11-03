import { Candle } from '@moet/sdk';
declare type Bar = {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
};
export declare const candleToTvBar: (candle: Candle) => Bar;
/**
 * This method handles the candles that come back from the exchange history server and converts them into Bars for the TradingView Chart.
 * @param candles
 * @returns
 */
export declare const candlesToTvBars: (candles: Candle[]) => Bar[];
export {};
