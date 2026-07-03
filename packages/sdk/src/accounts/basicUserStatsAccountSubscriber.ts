import {
	DataAndSlot,
	UserStatsAccountEvents,
	UserStatsAccountSubscriber,
} from './types';
import { PublicKey } from '@solana/web3.js';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { UserStatsAccount } from '../types';

/**
 * Basic implementation of UserStatsAccountSubscriber. It will only take in UserStatsAccount
 * data during initialization and will not fetch or subscribe to updates.
 */
export class BasicUserStatsAccountSubscriber
	implements UserStatsAccountSubscriber
{
	isSubscribed: boolean;
	eventEmitter: StrictEventEmitter<EventEmitter, UserStatsAccountEvents>;
	userStatsAccountPublicKey: PublicKey;

	callbackId?: string;
	errorCallbackId?: string;

	userStats?: DataAndSlot<UserStatsAccount>;

	/**
	 * @param userStatsAccountPublicKey Address of the `UserStatsAccount` this subscriber represents (not fetched — used only for identity).
	 * @param data Optional decoded account data to seed with; if omitted, `getUserStatsAccountAndSlot()` returns undefined until `updateData` is called.
	 * @param slot Slot `data` was observed at; defaults to 0 (the seeded sentinel) if omitted.
	 */
	public constructor(
		userStatsAccountPublicKey: PublicKey,
		data?: UserStatsAccount,
		slot?: number
	) {
		this.isSubscribed = true;
		this.eventEmitter = new EventEmitter();
		this.userStatsAccountPublicKey = userStatsAccountPublicKey;
		// `slot ?? 0` keeps {data, slot} atomic: a seeded account always carries a
		// slot (0 = oldest-possible sentinel, overwritten by the first real fetch).
		this.userStats = data ? { data, slot: slot ?? 0 } : undefined;
	}

	/** No-op; this subscriber never performs network I/O. Always resolves `true` since `isSubscribed` is already `true` from construction. */
	async subscribe(_userStatsAccount?: UserStatsAccount): Promise<boolean> {
		return true;
	}

	async addToAccountLoader(): Promise<void> {}

	/** No-op; this subscriber never fetches. Data only changes via `updateData`. */
	async fetch(): Promise<void> {}

	/** Type predicate: true once `userStats` has been seeded or set via `updateData`, narrowing `this.userStats` to non-undefined. */
	doesAccountExist(): this is { userStats: DataAndSlot<UserStatsAccount> } {
		return this.userStats !== undefined;
	}

	/** No-op; there is no live subscription to tear down. */
	async unsubscribe(): Promise<void> {}

	/** No-op; this subscriber is always considered subscribed and never throws `NotSubscribedError`. */
	assertIsSubscribed(): void {}

	/** Returns the currently cached data/slot, or undefined if never seeded/updated. Never throws (unlike other implementations, this subscriber has no "not subscribed" state). */
	public getUserStatsAccountAndSlot():
		| DataAndSlot<UserStatsAccount>
		| undefined {
		return this.userStats;
	}

	/**
	 * Applies an externally-obtained account update if `slot` is not older than the currently
	 * cached slot, emitting `userStatsAccountUpdate`/`update` on acceptance. This is the only way
	 * this subscriber's data changes after construction.
	 * @param userStatsAccount Decoded account data to apply.
	 * @param slot Slot the data was observed at.
	 */
	public updateData(userStatsAccount: UserStatsAccount, slot: number): void {
		if (!this.userStats || slot >= this.userStats.slot) {
			this.userStats = { data: userStatsAccount, slot };
			this.eventEmitter.emit('userStatsAccountUpdate', userStatsAccount);
			this.eventEmitter.emit('update');
		}
	}
}
