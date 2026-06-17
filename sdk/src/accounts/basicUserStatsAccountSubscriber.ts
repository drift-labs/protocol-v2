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

	async subscribe(_userStatsAccount?: UserStatsAccount): Promise<boolean> {
		return true;
	}

	async addToAccountLoader(): Promise<void> {}

	async fetch(): Promise<void> {}

	doesAccountExist(): this is { userStats: DataAndSlot<UserStatsAccount> } {
		return this.userStats !== undefined;
	}

	async unsubscribe(): Promise<void> {}

	assertIsSubscribed(): void {}

	public getUserStatsAccountAndSlot():
		| DataAndSlot<UserStatsAccount>
		| undefined {
		return this.userStats;
	}

	public updateData(userStatsAccount: UserStatsAccount, slot: number): void {
		if (!this.userStats || slot >= this.userStats.slot) {
			this.userStats = { data: userStatsAccount, slot };
			this.eventEmitter.emit('userStatsAccountUpdate', userStatsAccount);
			this.eventEmitter.emit('update');
		}
	}
}
