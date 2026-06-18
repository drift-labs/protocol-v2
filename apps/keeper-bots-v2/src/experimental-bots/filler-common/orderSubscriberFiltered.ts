import {
	OrderSubscriber,
	OrderSubscriberConfig,
	loadKeypair,
	UserAccount,
	MarketType,
	isVariant,
	getVariant,
	getUserFilter,
	getUserWithOrderFilter,
	Wallet,
	BN,
} from '@drift-labs/sdk';
import { Connection, PublicKey, RpcResponseAndContext } from '@solana/web3.js';
import dotenv from 'dotenv';
import { logger } from '../../logger';
import parseArgs from 'minimist';
import { getDriftClientFromArgs } from './utils';

const logPrefix = '[OrderSubscriberFiltered]';

export type UserAccountUpdate = {
	type: string;
	userAccount: string;
	pubkey: string;
	marketIndex: number;
};

export interface UserMarkets {
	[key: string]: Set<number>;
}

class OrderSubscriberFiltered extends OrderSubscriber {
	private readonly marketIndexes: number[];
	private readonly marketTypeStr: string;

	// To keep track of where the user has open orders in the markets we care about
	private readonly userMarkets: UserMarkets = {};

	constructor(
		config: OrderSubscriberConfig,
		marketIndexes: number[],
		marketType: MarketType
	) {
		super(config);
		this.marketIndexes = marketIndexes;
		this.marketTypeStr = getVariant(marketType);
	}

	override tryUpdateUserAccount(
		key: string,
		dataType: 'raw' | 'decoded' | 'buffer',
		data: UserAccount | string[] | Buffer,
		slot: number
	): void {
		if (!this.mostRecentSlot || slot > this.mostRecentSlot) {
			this.mostRecentSlot = slot;
		}

		const slotAndUserAccount = this.usersAccounts.get(key);
		if (slotAndUserAccount && slotAndUserAccount.slot > slot) {
			return;
		}

		let buffer: Buffer;
		if (dataType === 'raw') {
			// @ts-ignore
			buffer = Buffer.from(data[0], data[1]);
		} else if (dataType === 'buffer') {
			buffer = data as Buffer;
		} else {
			logger.warn('Received unexpected decoded data type for order subscriber');
			return;
		}

		const lastActiveSlot = slotAndUserAccount?.userAccount.lastActiveSlot;
		const newLastActiveSlot = new BN(
			buffer.subarray(4328, 4328 + 8),
			undefined,
			'le'
		);

		if (lastActiveSlot && lastActiveSlot.gt(newLastActiveSlot)) {
			return;
		}

		const userAccount = this.decodeFn('User', buffer) as UserAccount;
		const userMarkets = new Set<number>();

		userAccount.orders.forEach((order) => {
			if (
				this.marketIndexes.includes(order.marketIndex) &&
				isVariant(order.marketType, this.marketTypeStr)
			) {
				userMarkets.add(order.marketIndex);
			}
		});

		this.updateUserMarkets(key, buffer, userMarkets);
		this.usersAccounts.set(key, { slot, userAccount });
	}

	override async fetch(): Promise<void> {
		if (this.fetchPromise) {
			return this.fetchPromise;
		}

		this.fetchPromise = new Promise((resolver) => {
			this.fetchPromiseResolver = resolver;
		});

		try {
			const rpcRequestArgs = [
				this.driftClient.program.programId.toBase58(),
				{
					commitment: this.commitment,
					filters: [getUserFilter(), getUserWithOrderFilter()],
					encoding: 'base64',
					withContext: true,
				},
			];

			const rpcJSONResponse: any =
				// @ts-ignore
				await this.driftClient.connection._rpcRequest(
					'getProgramAccounts',
					rpcRequestArgs
				);

			const rpcResponseAndContext: RpcResponseAndContext<
				Array<{
					pubkey: PublicKey;
					account: {
						data: [string, string];
					};
				}>
			> = rpcJSONResponse.result;

			const slot: number = rpcResponseAndContext.context.slot;

			const programAccountSet = new Set<string>();
			for (const programAccount of rpcResponseAndContext.value) {
				const key = programAccount.pubkey.toString();
				programAccountSet.add(key);
				this.tryUpdateUserAccount(
					key,
					'raw',
					programAccount.account.data,
					slot
				);
				// give event loop a chance to breathe
				await new Promise((resolve) => setTimeout(resolve, 0));
			}

			for (const key of this.usersAccounts.keys()) {
				if (!programAccountSet.has(key)) {
					this.usersAccounts.delete(key);
					this.userMarkets[key].forEach((marketIndex) => {
						this.sendUserAccountUpdateMessage(
							Buffer.from([]),
							key,
							'delete',
							marketIndex
						);
					});
					delete this.userMarkets[key];
				}
				// give event loop a chance to breathe
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		} catch (e) {
			console.error(e);
		} finally {
			this.fetchPromiseResolver();
			this.fetchPromise = undefined;
		}
	}

	sendUserAccountUpdateMessage(
		buffer: Buffer,
		key: string,
		msgType: 'update' | 'delete',
		marketIndex: number
	) {
		const userAccountUpdate: UserAccountUpdate = {
			type: msgType,
			userAccount: buffer.toString('base64'),
			pubkey: key,
			marketIndex,
		};
		if (typeof process.send === 'function') {
			process.send({
				type: 'userAccountUpdate',
				data: userAccountUpdate,
			});
		}
	}

	sendLivenessCheck(health: boolean) {
		if (typeof process.send === 'function') {
			process.send({
				type: 'health',
				data: {
					healthy: health,
				},
			});
		}
	}

	private updateUserMarkets(
		userId: string,
		buffer: Buffer,
		currentMarkets: Set<number>
	): void {
		const previousMarkets = this.userMarkets[userId] || new Set<number>();

		const removedMarkets = new Set<number>();
		previousMarkets.forEach((marketIndex) => {
			if (!currentMarkets.has(marketIndex)) {
				removedMarkets.add(marketIndex);
			}
		});

		this.userMarkets[userId] = currentMarkets;

		for (const marketIndex of currentMarkets) {
			this.sendUserAccountUpdateMessage(buffer, userId, 'update', marketIndex);
		}

		for (const marketIndex of removedMarkets) {
			this.sendUserAccountUpdateMessage(buffer, userId, 'delete', marketIndex);
		}
	}
}

const main = async () => {
	// kill this process if the parent dies
	process.on('disconnect', () => process.exit());

	dotenv.config();

	const args = parseArgs(process.argv.slice(2));
	const driftEnv = args['drift-env'] ?? 'devnet';
	const marketIndexesStr = String(args['market-indexes']);
	const marketIndexes = marketIndexesStr.split(',').map(Number);
	const marketTypeStr = args['market-type'] as string;
	if (marketTypeStr !== 'perp' && marketTypeStr !== 'spot') {
		throw new Error("market-type must be either 'perp' or 'spot'");
	}

	let marketType: MarketType;
	switch (marketTypeStr) {
		case 'perp':
			marketType = MarketType.PERP;
			break;
		case 'spot':
			marketType = MarketType.SPOT;
			break;
		default:
			console.error('Error: Unsupported market type provided.');
			process.exit(1);
	}

	const endpoint = process.env.ENDPOINT;
	const privateKey = process.env.KEEPER_PRIVATE_KEY;

	if (!endpoint || !privateKey) {
		throw new Error('ENDPOINT and KEEPER_PRIVATE_KEY must be provided');
	}

	const wallet = new Wallet(loadKeypair(privateKey));
	const connection = new Connection(endpoint, 'processed');

	const driftClient = getDriftClientFromArgs({
		connection,
		wallet,
		marketIndexes,
		marketTypeStr,
		env: driftEnv,
	});
	await driftClient.subscribe();

	const orderSubscriberConfig: OrderSubscriberConfig = {
		driftClient: driftClient,
		subscriptionConfig: {
			type: 'websocket',
			skipInitialLoad: false,
			resubTimeoutMs: 5000,
			resyncIntervalMs: 60000,
			commitment: 'processed',
		},
		fastDecode: true,
		decodeData: false,
	};

	const orderSubscriberFiltered = new OrderSubscriberFiltered(
		orderSubscriberConfig,
		marketIndexes,
		marketType
	);

	await orderSubscriberFiltered.subscribe();

	orderSubscriberFiltered.sendLivenessCheck(true);
	setInterval(() => {
		orderSubscriberFiltered.sendLivenessCheck(true);
	}, 10_000);

	logger.info(`${logPrefix} OrderSubscriberFiltered started`);
};

main();
