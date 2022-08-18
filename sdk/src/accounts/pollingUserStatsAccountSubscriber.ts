import {
	DataAndSlot,
	AccountToPoll,
	NotSubscribedError,
	UserStatsAccountSubscriber,
	UserStatsAccountEvents,
} from './types';
import { Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { UserStatsAccount } from '../types';
import { BulkAccountLoader } from './bulkAccountLoader';
import { capitalize } from './utils';

export class PollingUserStatsAccountSubscriber
	implements UserStatsAccountSubscriber
{
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, UserStatsAccountEvents>;
	userStatsAccountPublicKey: PublicKey;

	accountLoader: BulkAccountLoader;
	accountsToPoll = new Map<string, AccountToPoll>();
	errorCallbackId?: string;

	userStats?: DataAndSlot<UserStatsAccount>;

	public constructor(
		program: Program,
		userStatsAccountPublicKey: PublicKey,
		accountLoader: BulkAccountLoader
	) {
		this.isSubscribed = false;
		this.program = program;
		this.accountLoader = accountLoader;
		this.eventEmitter = new EventEmitter();
		this.userStatsAccountPublicKey = userStatsAccountPublicKey;
	}

	async subscribe(): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		await this.addToAccountLoader();

		let subscriptionSucceeded = false;
		let retries = 0;
		while (!subscriptionSucceeded && retries < 5) {
			await this.fetchIfUnloaded();
			subscriptionSucceeded = this.didSubscriptionSucceed();
			retries++;
		}

		if (subscriptionSucceeded) {
			this.eventEmitter.emit('update');
		}

		this.isSubscribed = subscriptionSucceeded;
		return subscriptionSucceeded;
	}

	async addToAccountLoader(): Promise<void> {
		if (this.accountsToPoll.size > 0) {
			return;
		}

		this.accountsToPoll.set(this.userStatsAccountPublicKey.toString(), {
			key: 'userStats',
			publicKey: this.userStatsAccountPublicKey,
			eventType: 'userStatsAccountUpdate',
		});

		for (const [_, accountToPoll] of this.accountsToPoll) {
			accountToPoll.callbackId = this.accountLoader.addAccount(
				accountToPoll.publicKey,
				(buffer, slot) => {
					if (!buffer) {
						return;
					}

					const account = this.program.account[
						accountToPoll.key
					].coder.accounts.decode(capitalize(accountToPoll.key), buffer);
					this[accountToPoll.key] = { data: account, slot };
					// @ts-ignore
					this.eventEmitter.emit(accountToPoll.eventType, account);
					this.eventEmitter.emit('update');
				}
			);
		}

		this.errorCallbackId = this.accountLoader.addErrorCallbacks((error) => {
			this.eventEmitter.emit('error', error);
		});
	}

	async fetchIfUnloaded(): Promise<void> {
		let shouldFetch = false;
		for (const [_, accountToPoll] of this.accountsToPoll) {
			if (this[accountToPoll.key] === undefined) {
				shouldFetch = true;
				break;
			}
		}

		if (shouldFetch) {
			await this.fetch();
		}
	}

	async fetch(): Promise<void> {
		await this.accountLoader.load();
		for (const [_, accountToPoll] of this.accountsToPoll) {
			const { buffer, slot } = this.accountLoader.getBufferAndSlot(
				accountToPoll.publicKey
			);
			if (buffer) {
				const account = this.program.account[
					accountToPoll.key
				].coder.accounts.decode(capitalize(accountToPoll.key), buffer);
				this[accountToPoll.key] = { data: account, slot };
			}
		}
	}

	didSubscriptionSucceed(): boolean {
		let success = true;
		for (const [_, accountToPoll] of this.accountsToPoll) {
			if (!this[accountToPoll.key]) {
				success = false;
				break;
			}
		}
		return success;
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		for (const [_, accountToPoll] of this.accountsToPoll) {
			this.accountLoader.removeAccount(
				accountToPoll.publicKey,
				accountToPoll.callbackId
			);
		}

		this.accountLoader.removeErrorCallbacks(this.errorCallbackId);
		this.errorCallbackId = undefined;

		this.accountsToPoll.clear();

		this.isSubscribed = false;
	}

	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	public getUserStatsAccountAndSlot(): DataAndSlot<UserStatsAccount> {
		this.assertIsSubscribed();
		return this.userStats;
	}
}
