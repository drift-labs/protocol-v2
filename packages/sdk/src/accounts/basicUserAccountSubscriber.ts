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

	/**
	 * @param userAccountPublicKey Address of the `UserAccount` this subscriber represents (not fetched — used only for identity).
	 * @param data Optional decoded account data to seed with; if omitted, `getUserAccountAndSlot()` returns undefined until `updateData` is called.
	 * @param slot Slot `data` was observed at; defaults to 0 (the seeded sentinel) if omitted.
	 */
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

	/** No-op; this subscriber never performs network I/O. Always resolves `true` since `isSubscribed` is already `true` from construction. */
	async subscribe(_userAccount?: UserAccount): Promise<boolean> {
		return true;
	}

	async addToAccountLoader(): Promise<void> {}

	/** No-op; this subscriber never fetches. Data only changes via `updateData`. */
	async fetch(): Promise<void> {}

	/** Type predicate: true once `user` has been seeded or set via `updateData`, narrowing `this.user` to non-undefined. */
	doesAccountExist(): this is { user: DataAndSlot<UserAccount> } {
		return this.user !== undefined;
	}

	/** No-op; there is no live subscription to tear down. */
	async unsubscribe(): Promise<void> {}

	/** No-op; this subscriber is always considered subscribed and never throws `NotSubscribedError`. */
	assertIsSubscribed(): void {}

	/** Returns the currently cached data/slot, or undefined if never seeded/updated. Never throws (unlike other implementations, this subscriber has no "not subscribed" state). */
	public getUserAccountAndSlot(): DataAndSlot<UserAccount> | undefined {
		return this.user;
	}

	/**
	 * Applies an externally-obtained account update if `slot` is not older than the currently
	 * cached slot, emitting `userAccountUpdate`/`update` on acceptance. This is the only way this
	 * subscriber's data changes after construction.
	 * @param userAccount Decoded account data to apply.
	 * @param slot Slot the data was observed at.
	 */
	public updateData(userAccount: UserAccount, slot: number): void {
		if (!this.user || slot >= this.user.slot) {
			this.user = { data: userAccount, slot };
			this.eventEmitter.emit('userAccountUpdate', userAccount);
			this.eventEmitter.emit('update');
		}
	}
}
