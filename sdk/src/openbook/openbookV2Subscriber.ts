import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from '../accounts/bulkAccountLoader';
import { PRICE_PRECISION } from '../constants/numericConstants';
import { AnchorProvider, BN, Idl, Program, Wallet } from '@coral-xyz/anchor';
import { L2Level, L2OrderBookGenerator } from '../dlob/orderBookLevels';
import { Market, OpenBookV2Client } from '@openbook-dex/openbook-v2';
import openbookV2Idl from '../idl/openbook.json';

export type OpenbookV2SubscriberConfig = {
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

export class OpenbookV2Subscriber implements L2OrderBookGenerator {
	connection: Connection;
	programId: PublicKey;
	marketAddress: PublicKey;
	subscriptionType: 'polling' | 'websocket';
	accountLoader: BulkAccountLoader | undefined;
	subscribed: boolean;
	market: Market;
	marketCallbackId: string | number;
	client: OpenBookV2Client;

	public constructor(config: OpenbookV2SubscriberConfig) {
		this.connection = config.connection;
		this.programId = config.programId;
		this.marketAddress = config.marketAddress;
		this.subscribed = false;
		if (config.accountSubscription.type === 'polling') {
			this.subscriptionType = 'polling';
			this.accountLoader = config.accountSubscription.accountLoader;
		} else {
			this.subscriptionType = 'websocket';
		}
	}

	public async subscribe(): Promise<void> {
		if (this.subscribed === true) {
			return;
		}

		const anchorProvider = new AnchorProvider(
			this.connection,
			new Wallet(Keypair.generate()),
			{}
		);
		const openbookV2Program = new Program(
			openbookV2Idl as Idl,
			this.programId,
			anchorProvider
		);
		this.client = new OpenBookV2Client(anchorProvider);
		const market = await Market.load(this.client, this.marketAddress);
		this.market = await market.loadOrderBook();

		if (this.subscriptionType === 'websocket') {
			this.marketCallbackId = this.connection.onAccountChange(
				this.marketAddress,
				async (accountInfo, _) => {
					const marketRaw = openbookV2Program.coder.accounts.decode(
						'Market',
						accountInfo.data
					);
					const market = new Market(this.client, this.marketAddress, marketRaw);
					await market.loadOrderBook();
					this.market = market;
				}
			);
		} else {
			this.marketCallbackId = await this.accountLoader.addAccount(
				this.marketAddress,
				async (buffer, _) => {
					const marketRaw = openbookV2Program.coder.accounts.decode(
						'Market',
						buffer
					);
					const market = new Market(this.client, this.marketAddress, marketRaw);
					await market.loadOrderBook();
					this.market = market;
				}
			);
		}

		this.subscribed = true;
	}

	public getBestBid(): BN | undefined {
		const bestBid = this.market.bids?.best();

		if (bestBid === undefined) {
			return undefined;
		}

		return new BN(Math.floor(bestBid.price * PRICE_PRECISION.toNumber()));
	}

	public getBestAsk(): BN | undefined {
		const bestAsk = this.market.asks?.best();

		if (bestAsk === undefined) {
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
		const basePrecision = Math.ceil(
			1 / this.market.baseNativeFactor.toNumber()
		);
		const pricePrecision = PRICE_PRECISION.toNumber();

		const levels = side === 'bids' ? this.market.bids : this.market.asks;

		for (const order of levels?.items()) {
			const size = new BN(order.size * basePrecision);
			const price = new BN(order.price * pricePrecision);
			yield {
				price,
				size,
				sources: {
					openbook: size,
				},
			};
		}
	}

	public async unsubscribe(): Promise<void> {
		if (!this.subscribed) {
			return;
		}

		if (this.subscriptionType === 'websocket') {
			await this.connection.removeAccountChangeListener(
				this.marketCallbackId as number
			);
		} else {
			this.accountLoader.removeAccount(
				this.marketAddress,
				this.marketCallbackId as string
			);
		}

		this.subscribed = false;
	}
}
