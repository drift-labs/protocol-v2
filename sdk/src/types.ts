import { PublicKey, Transaction } from '@solana/web3.js';

export interface IWallet {
	signTransaction(tx: Transaction): Promise<Transaction>;
	signAllTransactions(txs: Transaction[]): Promise<Transaction[]>;
	publicKey: PublicKey;
}

export class SwapDirection {
	static readonly ADD = { add: {} };
	static readonly REMOVE = { remove: {} };
}

export class PositionDirection {
	static readonly LONG = { long: {} };
	static readonly SHORT = { short: {} };
}

export type SubscriberResult<A, B> = { dataLabel: A; data: B };
export type Subscriber<T> = (props: T) => void;

export enum TradeSide {
	None = 0,
	Buy = 1,
	Sell = 2,
}
export interface Trade {
	price: number;
	beforePrice: number;
	afterPrice: number;
	side: TradeSide;
	size: number;
	ts: number;
	marketIndex: number;
	chainTs: number;
}

export type Candle = {
	open: number;
	close: number;
	high: number;
	low: number;
	volume: number;
	vwap: number;
	start: number;
	end: number;
};
