import {
	DataAndSlot,
	AccountToPoll,
	NotSubscribedError,
	UserAccountEvents,
	UserAccountSubscriber,
	UserPublicKeys,
} from './types';
import { Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { getUserAccountPublicKey } from '../addresses/pda';
import { UserAccount } from '../types';
import { BulkAccountLoader } from './bulkAccountLoader';
import { capitalize } from './utils';
import { ClearingHouseConfigType } from '../factory/clearingHouse';

export class PollingUserAccountSubscriber implements UserAccountSubscriber {
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	authority: PublicKey;
	userId: number;

	accountLoader: BulkAccountLoader;
	accountsToPoll = new Map<string, AccountToPoll>();
	errorCallbackId?: string;

	user?: DataAndSlot<UserAccount>;

	type: ClearingHouseConfigType = 'polling';

	public constructor(
		program: Program,
		authority: PublicKey,
		accountLoader: BulkAccountLoader,
		userId: number
	) {
		this.isSubscribed = false;
		this.program = program;
		this.authority = authority;
		this.accountLoader = accountLoader;
		this.eventEmitter = new EventEmitter();
		this.userId = userId;
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

	async addToAccountLoader(userPublicKeys?: UserPublicKeys): Promise<void> {
		if (this.accountsToPoll.size > 0) {
			return;
		}

		if (!userPublicKeys) {
			const userPublicKey = await getUserAccountPublicKey(
				this.program.programId,
				this.authority,
				this.userId
			);

			this.accountsToPoll.set(userPublicKey.toString(), {
				key: 'user',
				publicKey: userPublicKey,
				eventType: 'userAccountUpdate',
			});
		} else {
			this.accountsToPoll.set(userPublicKeys.user.toString(), {
				key: 'user',
				publicKey: userPublicKeys.user,
				eventType: 'userAccountUpdate',
			});
		}

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
					this[accountToPoll.key] = { account, slot };
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
				this[accountToPoll.key] = { account, slot };
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

	public getUserAccountAndSlot(): DataAndSlot<UserAccount> {
		this.assertIsSubscribed();
		return this.user;
	}
}
