import { Connection, PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from '../accounts/bulkAccountLoader';
import { Market, Orderbook } from '@project-serum/serum';
import { SerumMarketSubscriberConfig } from './types';
import { BN } from '@project-serum/anchor';
import { PRICE_PRECISION } from '../constants/numericConstants';

export class SerumSubscriber {
	connection: Connection;
	programId: PublicKey;
	marketAddress: PublicKey;
	accountLoader: BulkAccountLoader;
	market: Market;

	subscribed: boolean;

	asksAddress: PublicKey;
	asks: Orderbook;
	asksCallbackId: string;
	lastAsksSlot: number;

	bidsAddress: PublicKey;
	bids: Orderbook;
	bidsCallbackId: string;
	lastBidsSlot: number;

	public constructor(config: SerumMarketSubscriberConfig) {
		this.connection = config.connection;
		this.programId = config.programId;
		this.marketAddress = config.marketAddress;
		this.accountLoader = config.accountSubscription.accountLoader;
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

		this.asksCallbackId = this.accountLoader.addAccount(
			this.asksAddress,
			(buffer, slot) => {
				this.lastAsksSlot = slot;
				this.asks = Orderbook.decode(this.market, buffer);
			}
		);

		this.bidsAddress = this.market.bidsAddress;
		this.bids = await this.market.loadBids(this.connection);

		this.bidsCallbackId = this.accountLoader.addAccount(
			this.bidsAddress,
			(buffer, slot) => {
				this.lastBidsSlot = slot;
				this.bids = Orderbook.decode(this.market, buffer);
			}
		);

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

	public async unsubscribe(): Promise<void> {
		if (!this.subscribed) {
			return;
		}

		this.accountLoader.removeAccount(this.asksAddress, this.asksCallbackId);
		this.accountLoader.removeAccount(this.bidsAddress, this.bidsCallbackId);

		this.subscribed = false;
	}
}
