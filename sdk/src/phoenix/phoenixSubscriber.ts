import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { BulkAccountLoader } from '../accounts/bulkAccountLoader';
import {
	Client,
	deserializeClockData,
	toNum,
	Market,
	getMarketLadder,
} from '@ellipsis-labs/phoenix-sdk';
import { PRICE_PRECISION } from '../constants/numericConstants';
import { BN } from '@coral-xyz/anchor';
import { L2Level, L2OrderBookGenerator } from '../dlob/orderBookLevels';
import { fastDecode } from '../decode/phoenix';

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
	fastDecode?: boolean;
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
	// fastDecode omits trader data from the markets for faster decoding process
	fastDecode: boolean;
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
		this.fastDecode = config.fastDecode ?? true;
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
						if (this.fastDecode) {
							this.market.data = fastDecode(accountInfo.data);
						} else {
							this.market = this.market.reload(accountInfo.data);
						}
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
							if (this.fastDecode) {
								this.market.data = fastDecode(buffer);
							} else {
								this.market = this.market.reload(buffer);
							}
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
		const ladder = getMarketLadder(
			this.market,
			this.lastSlot,
			this.lastUnixTimestamp,
			1
		);
		const bestBid = ladder.bids[0];
		if (!bestBid) {
			return undefined;
		}
		return this.convertPriceInTicksToPricePrecision(bestBid.priceInTicks);
	}

	public getBestAsk(): BN | undefined {
		const ladder = getMarketLadder(
			this.market,
			this.lastSlot,
			this.lastUnixTimestamp,
			1
		);

		const bestAsk = ladder.asks[0];
		if (!bestAsk) {
			return undefined;
		}
		return this.convertPriceInTicksToPricePrecision(bestAsk.priceInTicks);
	}

	public convertPriceInTicksToPricePrecision(priceInTicks: BN): BN {
		const quotePrecision = new BN(
			Math.pow(10, this.market.data.header.quoteParams.decimals)
		);
		const denom = quotePrecision.muln(
			this.market.data.header.rawBaseUnitsPerBaseUnit
		);
		const price = priceInTicks
			.muln(this.market.data.quoteLotsPerBaseUnitPerTick)
			.muln(toNum(this.market.data.header.quoteLotSize));
		return price.mul(PRICE_PRECISION).div(denom);
	}

	public convertSizeInBaseLotsToMarketPrecision(sizeInBaseLots: BN): BN {
		return sizeInBaseLots.muln(toNum(this.market.data.header.baseLotSize));
	}

	public getL2Bids(): Generator<L2Level> {
		return this.getL2Levels('bids');
	}

	public getL2Asks(): Generator<L2Level> {
		return this.getL2Levels('asks');
	}

	*getL2Levels(side: 'bids' | 'asks'): Generator<L2Level> {
		const ladder = getMarketLadder(
			this.market,
			this.lastSlot,
			this.lastUnixTimestamp,
			20
		);

		for (let i = 0; i < ladder[side].length; i++) {
			const { priceInTicks, sizeInBaseLots } = ladder[side][i];
			try {
				const size =
					this.convertSizeInBaseLotsToMarketPrecision(sizeInBaseLots);
				const updatedPrice =
					this.convertPriceInTicksToPricePrecision(priceInTicks);
				yield {
					price: updatedPrice,
					size,
					sources: {
						phoenix: size,
					},
				};
			} catch {
				continue;
			}
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
