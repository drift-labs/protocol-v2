import { MarketType, Order } from '../types';
import { PublicKey } from '@solana/web3.js';

export type DLOBMarketOrders = {
	marketIndex: number;
	marketType: MarketType;
	orders: { user: PublicKey; order: Order }[];
};

export type DLOBOrders = DLOBMarketOrders[];
