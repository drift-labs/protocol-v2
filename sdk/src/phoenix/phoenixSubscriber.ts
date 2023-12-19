import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { BulkAccountLoader } from '../accounts/bulkAccountLoader';
import {
	Client,
	deserializeClockData,
	toNum,
	getMarketUiLadder,
	Market,
	getMarketLadder,
} from '@ellipsis-labs/phoenix-sdk';
import { PRICE_PRECISION } from '../constants/numericConstants';
import { BN } from '@coral-xyz/anchor';
import { L2Level, L2OrderBookGenerator } from '../dlob/orderBookLevels';

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

export class PhoenixSubscriber implements L2OrderBookGenerator {
	connection: Connection;
	client: Client;
	programId: PublicKey;
	marketAddress: PublicKey;
	subscriptionType: 'polling' | 'websocket';
	accountLoader: BulkAccountLoader | undefined;
	market: Market;
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

		this.market = await Market.loadFromAddress({
			connection: this.connection,
			address: this.marketAddress,
		});

		const clock = deserializeClockData(
			(await this.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed'))
				.data
		);
		this.lastUnixTimestamp = toNum(clock.unixTimestamp);

		if (this.subscriptionType === 'websocket') {
			this.marketCallbackId = this.connection.onAccountChange(
				this.marketAddress,
				(accountInfo, _ctx) => {
					try {
						this.market = this.market.reload(accountInfo.data);
					} catch {
						console.error('Failed to reload Phoenix market data');
					}
				}
			);
			this.clockCallbackId = this.connection.onAccountChange(
				SYSVAR_CLOCK_PUBKEY,
				(accountInfo, ctx) => {
					try {
						this.lastSlot = ctx.slot;
						const clock = deserializeClockData(accountInfo.data);
						this.lastUnixTimestamp = toNum(clock.unixTimestamp);
					} catch {
						console.error('Failed to reload clock data');
					}
				}
			);
		} else {
			this.marketCallbackId = await this.accountLoader.addAccount(
				this.marketAddress,
				(buffer, slot) => {
					try {
						this.lastSlot = slot;
						if (buffer) {
							this.market = this.market.reload(buffer);
						}
					} catch {
						console.error('Failed to reload Phoenix market data');
					}
				}
			);
			this.clockCallbackId = await this.accountLoader.addAccount(
				SYSVAR_CLOCK_PUBKEY,
				(buffer, slot) => {
					try {
						this.lastSlot = slot;
						const clock = deserializeClockData(buffer);
						this.lastUnixTimestamp = toNum(clock.unixTimestamp);
					} catch {
						console.error('Failed to reload clock data');
					}
				}
			);
		}

		this.subscribed = true;
	}

	public getBestBid(): BN | undefined {
		const ladder = getMarketUiLadder(
			this.market,
			this.lastSlot,
			this.lastUnixTimestamp,
			1
		);
		const bestBid = ladder.bids[0];
		if (!bestBid) {
			return undefined;
		}
		return new BN(Math.floor(bestBid.price * PRICE_PRECISION.toNumber()));
	}

	public getBestAsk(): BN | undefined {
		const ladder = getMarketUiLadder(
			this.market,
			this.lastSlot,
			this.lastUnixTimestamp,
			1
		);

		const bestAsk = ladder.asks[0];
		if (!bestAsk) {
			return undefined;
		}
		return new BN(Math.floor(bestAsk.price * PRICE_PRECISION.toNumber()));
	}

	public getL2Bids(): Generator<L2Level> {
		return this.getL2Levels('bids');
	}

	public getL2Asks(): Generator<L2Level> {
		return this.getL2Levels('asks');
	}

	*getL2Levels(side: 'bids' | 'asks'): Generator<L2Level> {
		const tickSize = this.market.data.header
			.tickSizeInQuoteAtomsPerBaseUnit as BN;
		const baseLotsToRawBaseUnits = this.market.baseLotsToRawBaseUnits(1);

		const basePrecision = new BN(
			Math.pow(10, this.market.data.header.baseParams.decimals) *
				baseLotsToRawBaseUnits
		);

		const pricePrecision = PRICE_PRECISION.div(tickSize as BN);

		const ladder = getMarketLadder(
			this.market,
			this.lastSlot,
			this.lastUnixTimestamp,
			20
		);

		for (let i = 0; i < ladder[side].length; i++) {
			const { priceInTicks, sizeInBaseLots } = ladder[side][i];
			const size = sizeInBaseLots.mul(basePrecision);
			yield {
				price: priceInTicks.mul(new BN(pricePrecision)),
				size,
				sources: {
					phoenix: size,
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
