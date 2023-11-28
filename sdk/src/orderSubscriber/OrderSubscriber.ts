import { DriftClient } from '../driftClient';
import { UserAccount } from '../types';
import { getUserFilter, getUserWithOrderFilter } from '../memcmp';
import { PublicKey, RpcResponseAndContext } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { DLOB } from '../dlob/DLOB';
import { OrderSubscriberConfig, OrderSubscriberEvents } from './types';
import { PollingSubscription } from './PollingSubscription';
import { WebsocketSubscription } from './WebsocketSubscription';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';

export class OrderSubscriber {
	driftClient: DriftClient;
	usersAccounts = new Map<string, { slot: number; userAccount: UserAccount }>();
	subscription: PollingSubscription | WebsocketSubscription;
	eventEmitter: StrictEventEmitter<EventEmitter, OrderSubscriberEvents>;

	fetchPromise?: Promise<void>;
	fetchPromiseResolver: () => void;

	mostRecentSlot: number;

	constructor(config: OrderSubscriberConfig) {
		this.driftClient = config.driftClient;
		if (config.subscriptionConfig.type === 'polling') {
			this.subscription = new PollingSubscription({
				orderSubscriber: this,
				frequency: config.subscriptionConfig.frequency,
			});
		} else {
			this.subscription = new WebsocketSubscription({
				orderSubscriber: this,
				skipInitialLoad: config.subscriptionConfig.skipInitialLoad,
				resubTimeoutMs: config.subscriptionConfig.resubTimeoutMs,
			});
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
					commitment: this.driftClient.opts.commitment,
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
				// @ts-ignore
				const buffer = Buffer.from(
					programAccount.account.data[0],
					programAccount.account.data[1]
				);
				programAccountSet.add(key);
				const userAccount =
					this.driftClient.program.account.user.coder.accounts.decode(
						'User',
						buffer
					) as UserAccount;
				this.tryUpdateUserAccount(key, userAccount, slot);
			}

			for (const key of this.usersAccounts.keys()) {
				if (!programAccountSet.has(key)) {
					this.usersAccounts.delete(key);
				}
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
		userAccount: UserAccount,
		slot: number
	): void {
		if (!this.mostRecentSlot || slot > this.mostRecentSlot) {
			this.mostRecentSlot = slot;
		}

		const slotAndUserAccount = this.usersAccounts.get(key);
		if (!slotAndUserAccount || slotAndUserAccount.slot < slot) {
			const newOrders = userAccount.orders.filter(
				(order) =>
					order.slot.toNumber() > (slotAndUserAccount?.slot ?? 0) &&
					order.slot.toNumber() <= slot
			);
			if (newOrders.length > 0) {
				this.eventEmitter.emit(
					'onUpdate',
					userAccount,
					newOrders,
					new PublicKey(key),
					slot
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
			const userAccountPubkey = new PublicKey(key);
			for (const order of userAccount.orders) {
				dlob.insertOrder(order, userAccountPubkey, slot);
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
