import {
	DataAndSlot,
	NotSubscribedError,
	UserAccountEvents,
	UserAccountSubscriber,
} from './types';
import { Connection } from '../bankrun/bankrunConnection';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { UserAccount } from '../types';
import { BulkAccountLoader } from './bulkAccountLoader';

/**
 * `UserAccountSubscriber` backed by a shared `BulkAccountLoader` instead of a dedicated
 * WebSocket subscription. Registers a callback for the user's `UserAccount` and relies on the
 * loader's periodic batched `getMultipleAccounts` polling to detect changes. Prefer this over
 * `WebSocketUserAccountSubscriber` when tracking many users concurrently (e.g. a keeper watching
 * the whole DLOB) to keep the RPC/WS connection count bounded.
 */
export class PollingUserAccountSubscriber implements UserAccountSubscriber {
	isSubscribed: boolean;
	connection: Connection;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	userAccountPublicKey: PublicKey;

	accountLoader: BulkAccountLoader;
	callbackId?: string;
	errorCallbackId?: string;

	decode: (name: string, buffer: Buffer) => UserAccount;

	user?: DataAndSlot<UserAccount>;

	/**
	 * @param connection Connection (or bankrun-compatible shim) used for the one-off `fetch()` fallback.
	 * @param userAccountPublicKey Address of the `UserAccount` to track.
	 * @param accountLoader Shared `BulkAccountLoader` this subscriber registers its callback with.
	 * @param decode Decode function for the raw account buffer (typically the program's Anchor coder).
	 */
	public constructor(
		connection: Connection,
		userAccountPublicKey: PublicKey,
		accountLoader: BulkAccountLoader,
		decode: (name: string, buffer: Buffer) => UserAccount
	) {
		this.isSubscribed = false;
		this.connection = connection;
		this.accountLoader = accountLoader;
		this.eventEmitter = new EventEmitter();
		this.userAccountPublicKey = userAccountPublicKey;
		this.decode = decode;
	}

	/**
	 * Registers this account with the shared `BulkAccountLoader` and, if no data has loaded yet
	 * (from a prior fetch or the optional `userAccount` seed), performs a one-off `fetch()` so the
	 * subscriber has data before returning. Idempotent: a no-op if already subscribed.
	 * @param userAccount Optional pre-fetched account data to seed with (at slot 0) instead of an immediate fetch.
	 */
	async subscribe(userAccount?: UserAccount): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		if (userAccount) {
			// `slot: 0` keeps {data, slot} atomic: a seeded account always carries a
			// slot (0 = oldest-possible sentinel, overwritten by the first real fetch).
			this.user = { data: userAccount, slot: 0 };
		}

		await this.addToAccountLoader();

		await this.fetchIfUnloaded();
		if (this.doesAccountExist()) {
			this.eventEmitter.emit('update');
		}

		this.isSubscribed = true;
		return true;
	}

	/** Registers this user's account and an error callback with the `BulkAccountLoader`. A no-op if already registered. */
	async addToAccountLoader(): Promise<void> {
		if (this.callbackId) {
			return;
		}

		this.callbackId = await this.accountLoader.addAccount(
			this.userAccountPublicKey,
			(buffer, slot: number) => {
				if (!buffer) {
					return;
				}

				if (this.user && this.user.slot > slot) {
					return;
				}

				const account = this.decode('user', buffer);
				this.user = { data: account, slot };
				this.eventEmitter.emit('userAccountUpdate', account);
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

	/** Fetches the account once directly via RPC (independent of the account loader's poll cycle), applying it only if the response's slot is newer than what's cached. Logs and swallows errors (e.g. account not yet initialized) rather than throwing. */
	async fetch(): Promise<void> {
		try {
			const dataAndContext = await this.connection.getAccountInfoAndContext(
				this.userAccountPublicKey,
				this.accountLoader.commitment
			);
			if (
				dataAndContext.value !== null &&
				dataAndContext.context.slot > (this.user?.slot ?? 0)
			) {
				this.user = {
					data: this.decode('user', dataAndContext.value.data),
					slot: dataAndContext.context.slot,
				};
			}
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e));
			console.log(
				`PollingUserAccountSubscriber.fetch() UserAccount does not exist: ${err.message}-${err.stack}`
			);
		}
	}

	/** Type predicate: true once `user` has loaded, narrowing `this.user` to non-undefined for callers that check it first. */
	doesAccountExist(): this is { user: DataAndSlot<UserAccount> } {
		return this.user !== undefined;
	}

	/** Unregisters this account (and its error callback) from the `BulkAccountLoader`. A no-op if not subscribed. */
	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		if (this.callbackId) {
			this.accountLoader.removeAccount(
				this.userAccountPublicKey,
				this.callbackId
			);
			this.callbackId = undefined;
		}

		if (this.errorCallbackId) {
			this.accountLoader.removeErrorCallbacks(this.errorCallbackId);
			this.errorCallbackId = undefined;
		}

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
	public getUserAccountAndSlot(): DataAndSlot<UserAccount> | undefined {
		this.assertIsSubscribed();
		return this.user;
	}

	/**
	 * Applies an externally-obtained account update (e.g. relayed by the SDK's `User` wrapper) if
	 * `slot` is strictly newer than the currently cached slot (equal-slot updates are ignored).
	 * @param userAccount Decoded account data to apply.
	 * @param slot Slot the data was observed at.
	 */
	public updateData(userAccount: UserAccount, slot: number): void {
		if (!this.user || this.user.slot < slot) {
			this.user = { data: userAccount, slot };
			this.eventEmitter.emit('userAccountUpdate', userAccount);
			this.eventEmitter.emit('update');
		}
	}
}
