import {
	DataAndSlot,
	NotSubscribedError,
	UserStatsAccountSubscriber,
	UserStatsAccountEvents,
} from './types';
import { VelocityProgram } from '../config';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { UserStatsAccount } from '../types';
import { BulkAccountLoader } from './bulkAccountLoader';

/**
 * `UserStatsAccountSubscriber` backed by a shared `BulkAccountLoader` instead of a dedicated
 * WebSocket subscription, mirroring `PollingUserAccountSubscriber` for `UserStatsAccount`.
 */
export class PollingUserStatsAccountSubscriber
	implements UserStatsAccountSubscriber
{
	isSubscribed: boolean;
	program: VelocityProgram;
	eventEmitter: StrictEventEmitter<EventEmitter, UserStatsAccountEvents>;
	userStatsAccountPublicKey: PublicKey;

	accountLoader: BulkAccountLoader;
	callbackId?: string;
	errorCallbackId?: string;

	userStats?: DataAndSlot<UserStatsAccount>;

	/**
	 * @param program Anchor program used for the one-off `fetch()` fallback and account decoding.
	 * @param userStatsAccountPublicKey Address of the `UserStatsAccount` to track.
	 * @param accountLoader Shared `BulkAccountLoader` this subscriber registers its callback with.
	 */
	public constructor(
		program: VelocityProgram,
		userStatsAccountPublicKey: PublicKey,
		accountLoader: BulkAccountLoader
	) {
		this.isSubscribed = false;
		this.program = program;
		this.accountLoader = accountLoader;
		this.eventEmitter = new EventEmitter();
		this.userStatsAccountPublicKey = userStatsAccountPublicKey;
	}

	/**
	 * Registers this account with the shared `BulkAccountLoader` and, if no data has loaded yet
	 * (from a prior fetch or the optional `userStatsAccount` seed), performs a one-off `fetch()`
	 * so the subscriber has data before returning. Idempotent: a no-op if already subscribed.
	 * @param userStatsAccount Optional pre-fetched account data to seed with (at slot 0) instead of an immediate fetch.
	 */
	async subscribe(userStatsAccount?: UserStatsAccount): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		if (userStatsAccount) {
			// `slot: 0` keeps {data, slot} atomic: a seeded account always carries a
			// slot (0 = oldest-possible sentinel, overwritten by the first real fetch).
			this.userStats = { data: userStatsAccount, slot: 0 };
		}

		await this.addToAccountLoader();

		await this.fetchIfUnloaded();

		if (this.doesAccountExist()) {
			this.eventEmitter.emit('update');
		}

		this.isSubscribed = true;
		return true;
	}

	/** Registers this user stats account and an error callback with the `BulkAccountLoader`. A no-op if already registered. */
	async addToAccountLoader(): Promise<void> {
		if (this.callbackId !== undefined) {
			return;
		}

		this.callbackId = await this.accountLoader.addAccount(
			this.userStatsAccountPublicKey,
			(buffer, slot: number) => {
				if (!buffer) {
					return;
				}

				if (this.userStats && this.userStats.slot > slot) {
					return;
				}

				const account = this.program.coder.accounts.decodeUnchecked(
					'userStats',
					buffer
				);
				this.userStats = { data: account, slot };
				this.eventEmitter.emit('userStatsAccountUpdate', account);
				this.eventEmitter.emit('update');
			}
		);

		this.errorCallbackId = this.accountLoader.addErrorCallbacks((error) => {
			this.eventEmitter.emit('error', error);
		});
	}

	/** Fetches via `fetch()` only if no data is cached yet; otherwise a no-op. */
	async fetchIfUnloaded(): Promise<void> {
		if (!this.doesAccountExist()) {
			await this.fetch();
		}
	}

	/** Fetches the account once directly via `program.account.userStats.fetchAndContext` (independent of the account loader's poll cycle), applying it only if the response's slot is newer than what's cached. Logs and swallows errors rather than throwing. */
	async fetch(): Promise<void> {
		try {
			const dataAndContext = await (
				this.program.account as any
			).userStats.fetchAndContext(
				this.userStatsAccountPublicKey,
				this.accountLoader.commitment
			);
			if (dataAndContext.context.slot > (this.userStats?.slot ?? 0)) {
				this.userStats = {
					data: dataAndContext.data as unknown as UserStatsAccount,
					slot: dataAndContext.context.slot,
				};
			}
		} catch (e) {
			console.log(
				`PollingUserStatsAccountSubscriber.fetch() UserStatsAccount does not exist: ${
					e instanceof Error ? e.message : String(e)
				}`
			);
		}
	}

	/** Type predicate: true once `userStats` has loaded, narrowing `this.userStats` to non-undefined. */
	doesAccountExist(): this is { userStats: DataAndSlot<UserStatsAccount> } {
		return this.userStats !== undefined;
	}

	/** Unregisters this account (and its error callback) from the `BulkAccountLoader`. A no-op if not subscribed. */
	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		this.accountLoader.removeAccount(
			this.userStatsAccountPublicKey,
			this.callbackId
		);
		this.callbackId = undefined;

		this.accountLoader.removeErrorCallbacks(this.errorCallbackId);
		this.errorCallbackId = undefined;

		this.isSubscribed = false;
	}

	/** Throws `NotSubscribedError` if `subscribe()` has not been called. */
	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	/** Throws `NotSubscribedError` if not subscribed. Returns undefined only if subscribed but no data has loaded yet. */
	public getUserStatsAccountAndSlot():
		| DataAndSlot<UserStatsAccount>
		| undefined {
		this.assertIsSubscribed();
		return this.userStats;
	}
}
