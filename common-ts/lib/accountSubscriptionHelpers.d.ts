import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { Candle, Trade, CandleResolution, TradeHistoryAccount, TradeRecord, Liquidation, LiquidationRecord } from '@moet/sdk';
export declare const calculatePriceForTradeRecord: (quoteAssetAmount: BN, baseAssetAmount: BN) => number;
export declare const stripMantissa: (bigNumber: BN, precision?: BN) => number;
export declare const stripBaseAssetPrecision: (baseAssetAmount: BN) => number;
export declare const getNewTrades: (lastSeenTrade: number, tradingHistoryHead: number, tradeHistory: TradeHistoryAccount) => {
    newTrades: {
        trade: Trade;
        userAccount: PublicKey;
    }[];
    newLastSeenTrade: number;
};
export declare const convertTradesToCandles: (trades: Trade[], resolution: number, from: number, to: number) => Candle[];
export declare const convertTradesToCandle: (trades: Trade[], from?: number, to?: number) => Candle;
export declare const tradeRecordToUITrade: (tradeRecord: TradeRecord) => Trade;
export declare const resolutionStringToCandleLengthMs: (resolutionString: CandleResolution) => number;
export declare const liquidationRecordToUILiquidation: (liquidationRecord: LiquidationRecord) => Liquidation;
