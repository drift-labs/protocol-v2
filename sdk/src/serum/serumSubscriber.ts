import { Connection, PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from '../accounts/bulkAccountLoader';
import { Market, Orderbook } from '@project-serum/serum';
import { SerumMarketSubscriberConfig } from './types';
import { BN } from '@coral-xyz/anchor';
import { PRICE_PRECISION } from '../constants/numericConstants';
import { L2Level, L2OrderBookGenerator } from '../dlob/orderBookLevels';

export class SerumSubscriber implements L2OrderBookGenerator {
	connection: Connection;
	programId: PublicKey;
	marketAddress: PublicKey;
	subscriptionType: 'polling' | 'websocket';
	accountLoader: BulkAccountLoader | undefined;
	market: Market;

	subscribed: boolean;

	asksAddress: PublicKey;
	asks: Orderbook;
	asksCallbackId: string | number;
	lastAsksSlot: number;

	bidsAddress: PublicKey;
	bids: Orderbook;
	bidsCallbackId: string | number;
	lastBidsSlot: number;

	public constructor(config: SerumMarketSubscriberConfig) {
		this.connection = config.connection;
		this.programId = config.programId;
		this.marketAddress = config.marketAddress;
		if (config.accountSubscription.type === 'polling') {
			this.subscriptionType = 'polling';
			this.accountLoader = config.accountSubscription.accountLoader;
		} else {
			this.subscriptionType = 'websocket';
		}
	}

	public async subscribe(): Promise<void> {
		if (this.subscribed) {
			return;
		}

		this.market = await Market.load(
			this.connection,
			this.marketAddress,
			undefined,
			this.programId
		);

		this.asksAddress = this.market.asksAddress;
		this.asks = await this.market.loadAsks(this.connection);

		if (this.subscriptionType === 'websocket') {
			this.asksCallbackId = this.connection.onAccountChange(
				this.asksAddress,
				(accountInfo, ctx) => {
					this.lastAsksSlot = ctx.slot;
					this.asks = Orderbook.decode(this.market, accountInfo.data);
				}
			);
		} else {
			this.asksCallbackId = await this.accountLoader.addAccount(
				this.asksAddress,
				(buffer, slot) => {
					this.lastAsksSlot = slot;
					this.asks = Orderbook.decode(this.market, buffer);
				}
			);
		}

		this.bidsAddress = this.market.bidsAddress;
		this.bids = await this.market.loadBids(this.connection);

		if (this.subscriptionType === 'websocket') {
			this.bidsCallbackId = this.connection.onAccountChange(
				this.bidsAddress,
				(accountInfo, ctx) => {
					this.lastBidsSlot = ctx.slot;
					this.bids = Orderbook.decode(this.market, accountInfo.data);
				}
			);
		} else {
			this.bidsCallbackId = await this.accountLoader.addAccount(
				this.bidsAddress,
				(buffer, slot) => {
					this.lastBidsSlot = slot;
					this.bids = Orderbook.decode(this.market, buffer);
				}
			);
		}

		this.subscribed = true;
	}

	public getBestBid(): BN | undefined {
		const bestBid = this.bids.getL2(1)[0];
		if (!bestBid) {
			return undefined;
		}

		return new BN(bestBid[0] * PRICE_PRECISION.toNumber());
	}

	public getBestAsk(): BN | undefined {
		const bestAsk = this.asks.getL2(1)[0];
		if (!bestAsk) {
			return undefined;
		}

		return new BN(bestAsk[0] * PRICE_PRECISION.toNumber());
	}

	public getL2Bids(): Generator<L2Level> {
		return this.getL2Levels('bids');
	}

	public getL2Asks(): Generator<L2Level> {
		return this.getL2Levels('asks');
	}

	*getL2Levels(side: 'bids' | 'asks'): Generator<L2Level> {
		// @ts-ignore
		const basePrecision = Math.pow(10, this.market._baseSplTokenDecimals);
		const pricePrecision = PRICE_PRECISION.toNumber();
		for (const { price: priceNum, size: sizeNum } of this[side].items(
			side === 'bids'
		)) {
			const price = new BN(priceNum * pricePrecision);
			const size = new BN(sizeNum * basePrecision);
			yield {
				price,
				size,
				sources: {
					serum: size,
				},
			};
		}
	}

	public async unsubscribe(): Promise<void> {
		if (!this.subscribed) {
			return;
		}

		// remove listeners
		if (this.subscriptionType === 'websocket') {
			await this.connection.removeAccountChangeListener(
				this.asksCallbackId as number
			);
			await this.connection.removeAccountChangeListener(
				this.bidsCallbackId as number
			);
		} else {
			this.accountLoader.removeAccount(
				this.asksAddress,
				this.asksCallbackId as string
			);
			this.accountLoader.removeAccount(
				this.bidsAddress,
				this.bidsCallbackId as string
			);
		}

		this.subscribed = false;
	}
}
