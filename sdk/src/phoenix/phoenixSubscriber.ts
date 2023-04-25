import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { BulkAccountLoader } from '../accounts/bulkAccountLoader';
import {
	MarketData,
	Client,
	deserializeMarketData,
	deserializeClockData,
	toNum,
	getMarketUiLadder,
} from '@ellipsis-labs/phoenix-sdk';
import { PRICE_PRECISION } from '../constants/numericConstants';
import { BN } from '@coral-xyz/anchor';

export type PhoenixMarketSubscriberConfig = {
	connection: Connection;
	programId: PublicKey;
	marketAddress: PublicKey;
	accountSubscription:
		| {
				// enables use to add web sockets in the future
				type: 'polling';
				accountLoader: BulkAccountLoader;
		  }
		| {
				type: 'websocket';
		  };
};

export class PhoenixSubscriber {
	connection: Connection;
	client: Client;
	programId: PublicKey;
	marketAddress: PublicKey;
	subscriptionType: 'polling' | 'websocket';
	accountLoader: BulkAccountLoader | undefined;
	market: MarketData;
	marketCallbackId: string | number;
	clockCallbackId: string | number;

	subscribed: boolean;
	lastSlot: number;
	lastUnixTimestamp: number;

	public constructor(config: PhoenixMarketSubscriberConfig) {
		this.connection = config.connection;
		this.programId = config.programId;
		this.marketAddress = config.marketAddress;
		if (config.accountSubscription.type === 'polling') {
			this.subscriptionType = 'polling';
			this.accountLoader = config.accountSubscription.accountLoader;
		} else {
			this.subscriptionType = 'websocket';
		}
		this.lastSlot = 0;
		this.lastUnixTimestamp = 0;
	}

	public async subscribe(): Promise<void> {
		if (this.subscribed) {
			return;
		}

		this.market = deserializeMarketData(
			(await this.connection.getAccountInfo(this.marketAddress, 'confirmed'))
				.data
		);

		const clock = deserializeClockData(
			(await this.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed'))
				.data
		);
		this.lastUnixTimestamp = toNum(clock.unixTimestamp);

		if (this.subscriptionType === 'websocket') {
			this.marketCallbackId = this.connection.onAccountChange(
				this.marketAddress,
				(accountInfo, _ctx) => {
					this.market = deserializeMarketData(accountInfo.data);
				}
			);
			this.clockCallbackId = this.connection.onAccountChange(
				SYSVAR_CLOCK_PUBKEY,
				(accountInfo, ctx) => {
					this.lastSlot = ctx.slot;
					const clock = deserializeClockData(accountInfo.data);
					this.lastUnixTimestamp = toNum(clock.unixTimestamp);
				}
			);
		} else {
			this.marketCallbackId = await this.accountLoader.addAccount(
				this.marketAddress,
				(buffer, slot) => {
					this.lastSlot = slot;
					this.market = deserializeMarketData(buffer);
				}
			);
			this.clockCallbackId = await this.accountLoader.addAccount(
				SYSVAR_CLOCK_PUBKEY,
				(buffer, slot) => {
					this.lastSlot = slot;
					const clock = deserializeClockData(buffer);
					this.lastUnixTimestamp = toNum(clock.unixTimestamp);
				}
			);
		}

		this.subscribed = true;
	}

	public getBestBid(): BN {
		const ladder = getMarketUiLadder(
			this.market,
			this.lastSlot,
			this.lastUnixTimestamp,
			1
		);
		return new BN(Math.floor(ladder.bids[0][0] * PRICE_PRECISION));
	}

	public getBestAsk(): BN {
		const ladder = getMarketUiLadder(
			this.market,
			this.lastSlot,
			this.lastUnixTimestamp,
			1
		);
		return new BN(Math.floor(ladder.asks[0][0] * PRICE_PRECISION));
	}

	public async unsubscribe(): Promise<void> {
		if (!this.subscribed) {
			return;
		}

		// remove listeners
		if (this.subscriptionType === 'websocket') {
			await this.connection.removeAccountChangeListener(
				this.marketCallbackId as number
			);
			await this.connection.removeAccountChangeListener(
				this.clockCallbackId as number
			);
		} else {
			this.accountLoader.removeAccount(
				this.marketAddress,
				this.marketCallbackId as string
			);
			this.accountLoader.removeAccount(
				SYSVAR_CLOCK_PUBKEY,
				this.clockCallbackId as string
			);
		}

		this.subscribed = false;
	}
}
