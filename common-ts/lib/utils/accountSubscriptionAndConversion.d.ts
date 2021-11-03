import { Candle, CandleResolution, Trade, TradeHistoryAccount, TradeRecord } from '@moet/sdk';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
export declare const calculatePriceForTradeRecord: (quoteAssetAmount: BN, baseAssetAmount: BN) => number;
export declare const convertTradesToCandle: (trades: Trade[], from?: number, to?: number) => Candle;
export declare const tradeRecordToUITrade: (tradeRecord: TradeRecord) => Trade;
export declare const getNewTrades: (lastSeenTrade: number, tradingHistoryHead: number, tradeHistory: TradeHistoryAccount) => {
    newTrades: {
        trade: Trade;
        userAccount: PublicKey;
    }[];
    newLastSeenTrade: number;
};
export declare const resolutionStringToCandleLengthMs: (resolutionString: CandleResolution) => number;
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
