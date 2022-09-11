import { Connection, PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from '../accounts/bulkAccountLoader';
import { Market, Orderbook } from '@project-serum/serum';
import { SerumMarketSubscriberConfig } from './types';

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
				console.log(this.asks.getL2(3));
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

	public async unsubscribe(): Promise<void> {
		if (!this.subscribed) {
			return;
		}

		this.accountLoader.removeAccount(this.asksAddress, this.asksCallbackId);
		this.accountLoader.removeAccount(this.bidsAddress, this.bidsCallbackId);

		this.subscribed = false;
	}
}
