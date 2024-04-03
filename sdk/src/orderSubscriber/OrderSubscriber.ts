import { DriftClient } from '../driftClient';
import { UserAccount } from '../types';
import { getUserFilter, getUserWithOrderFilter } from '../memcmp';
import { Commitment, PublicKey, RpcResponseAndContext } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { DLOB } from '../dlob/DLOB';
import { OrderSubscriberConfig, OrderSubscriberEvents } from './types';
import { PollingSubscription } from './PollingSubscription';
import { WebsocketSubscription } from './WebsocketSubscription';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { BN } from '../index';
import { decodeUser } from '../decode/user';

export class OrderSubscriber {
	driftClient: DriftClient;
	usersAccounts = new Map<string, { slot: number; userAccount: UserAccount }>();
	subscription: PollingSubscription | WebsocketSubscription;
	commitment: Commitment;
	eventEmitter: StrictEventEmitter<EventEmitter, OrderSubscriberEvents>;

	fetchPromise?: Promise<void>;
	fetchPromiseResolver: () => void;

	mostRecentSlot: number;
	decodeFn: (name: string, data: Buffer) => UserAccount;
	decodeData?: boolean;

	constructor(config: OrderSubscriberConfig) {
		this.driftClient = config.driftClient;
		this.commitment = config.subscriptionConfig.commitment || 'processed';
		if (config.subscriptionConfig.type === 'polling') {
			this.subscription = new PollingSubscription({
				orderSubscriber: this,
				frequency: config.subscriptionConfig.frequency,
			});
		} else {
			this.subscription = new WebsocketSubscription({
				orderSubscriber: this,
				commitment: this.commitment,
				skipInitialLoad: config.subscriptionConfig.skipInitialLoad,
				resubTimeoutMs: config.subscriptionConfig.resubTimeoutMs,
				resyncIntervalMs: config.subscriptionConfig.resyncIntervalMs,
				decoded: config.decodeData,
			});
		}
		if (config.fastDecode ?? true) {
			this.decodeFn = (name, data) => decodeUser(data);
		} else {
			this.decodeFn =
				this.driftClient.program.account.user.coder.accounts.decodeUnchecked.bind(
					this.driftClient.program.account.user.coder.accounts
				);
		}
		this.eventEmitter = new EventEmitter();
	}

	public async subscribe(): Promise<void> {
		await this.subscription.subscribe();
	}

	async fetch(): Promise<void> {
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

	tryUpdateUserAccount(
		key: string,
		dataType: 'raw' | 'decoded' | 'buffer',
		data: string[] | UserAccount | Buffer,
		slot: number
	): void {
		if (!this.mostRecentSlot || slot > this.mostRecentSlot) {
			this.mostRecentSlot = slot;
		}

		this.eventEmitter.emit(
			'updateReceived',
			new PublicKey(key),
			slot,
			dataType
		);

		const slotAndUserAccount = this.usersAccounts.get(key);
		if (!slotAndUserAccount || slotAndUserAccount.slot <= slot) {
			let userAccount: UserAccount;
			// Polling leads to a lot of redundant decoding, so we only decode if data is from a fresh slot
			if (dataType === 'raw') {
				// @ts-ignore
				const buffer = Buffer.from(data[0], data[1]);

				const newLastActiveSlot = new BN(
					buffer.subarray(4328, 4328 + 8),
					undefined,
					'le'
				);
				if (
					slotAndUserAccount &&
					slotAndUserAccount.userAccount.lastActiveSlot.gt(newLastActiveSlot)
				) {
					return;
				}

				userAccount = this.decodeFn('User', buffer) as UserAccount;
			} else if (dataType === 'buffer') {
				const buffer: Buffer = data as Buffer;
				const newLastActiveSlot = new BN(
					buffer.subarray(4328, 4328 + 8),
					undefined,
					'le'
				);
				if (
					slotAndUserAccount &&
					slotAndUserAccount.userAccount.lastActiveSlot.gt(newLastActiveSlot)
				) {
					return;
				}

				userAccount = this.decodeFn('User', data as Buffer) as UserAccount;
			} else {
				userAccount = data as UserAccount;
			}

			this.eventEmitter.emit(
				'userUpdated',
				userAccount,
				new PublicKey(key),
				slot,
				dataType
			);

			const newOrders = userAccount.orders.filter(
				(order) =>
					order.slot.toNumber() > (slotAndUserAccount?.slot ?? 0) &&
					order.slot.toNumber() <= slot
			);
			if (newOrders.length > 0) {
				this.eventEmitter.emit(
					'orderCreated',
					userAccount,
					newOrders,
					new PublicKey(key),
					slot,
					dataType
				);
			}
			if (userAccount.hasOpenOrder) {
				this.usersAccounts.set(key, { slot, userAccount });
			} else {
				this.usersAccounts.delete(key);
			}
		}
	}

	public async getDLOB(slot: number): Promise<DLOB> {
		const dlob = new DLOB();
		for (const [key, { userAccount }] of this.usersAccounts.entries()) {
			for (const order of userAccount.orders) {
				dlob.insertOrder(order, key, slot);
			}
		}
		return dlob;
	}

	public getSlot(): number {
		return this.mostRecentSlot ?? 0;
	}

	public async unsubscribe(): Promise<void> {
		await this.subscription.unsubscribe();
	}
}
