import { DataAndSlot, UserAccountEvents, UserAccountSubscriber } from './types';
import { PublicKey } from '@solana/web3.js';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { UserAccount } from '../types';

/**
 * Basic implementation of UserAccountSubscriber. It will only take in UserAccount
 * data during initialization and will not fetch or subscribe to updates.
 */
export class BasicUserAccountSubscriber implements UserAccountSubscriber {
	isSubscribed: boolean;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	userAccountPublicKey: PublicKey;

	callbackId?: string;
	errorCallbackId?: string;

	user?: DataAndSlot<UserAccount>;

	public constructor(
		userAccountPublicKey: PublicKey,
		data?: UserAccount,
		slot?: number
	) {
		this.isSubscribed = true;
		this.eventEmitter = new EventEmitter();
		this.userAccountPublicKey = userAccountPublicKey;
		// `slot ?? 0` keeps {data, slot} atomic: a seeded account always carries a
		// slot (0 = oldest-possible sentinel, overwritten by the first real fetch).
		this.user = data ? { data, slot: slot ?? 0 } : undefined;
	}

	async subscribe(_userAccount?: UserAccount): Promise<boolean> {
		return true;
	}

	async addToAccountLoader(): Promise<void> {}

	async fetch(): Promise<void> {}

	doesAccountExist(): this is { user: DataAndSlot<UserAccount> } {
		return this.user !== undefined;
	}

	async unsubscribe(): Promise<void> {}

	assertIsSubscribed(): void {}

	public getUserAccountAndSlot(): DataAndSlot<UserAccount> | undefined {
		return this.user;
	}

	public updateData(userAccount: UserAccount, slot: number): void {
		if (!this.user || slot >= this.user.slot) {
			this.user = { data: userAccount, slot };
			this.eventEmitter.emit('userAccountUpdate', userAccount);
			this.eventEmitter.emit('update');
		}
	}
}
