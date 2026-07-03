import {
	DataAndSlot,
	NotSubscribedError,
	TokenAccountEvents,
	TokenAccountSubscriber,
} from './types';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from './bulkAccountLoader';
import { Account } from '@solana/spl-token';
import { parseTokenAccount } from '../token';

/**
 * Tracks an SPL token account's parsed balance/owner via a shared `BulkAccountLoader`. Used for
 * things like a spot market's token vault or a user's wallet token account, where a dedicated
 * WebSocket subscription per account is unnecessary.
 */
export class PollingTokenAccountSubscriber implements TokenAccountSubscriber {
	isSubscribed: boolean;
	eventEmitter: StrictEventEmitter<EventEmitter, TokenAccountEvents>;
	publicKey: PublicKey;

	accountLoader: BulkAccountLoader;
	callbackId?: string;
	errorCallbackId?: string;

	tokenAccountAndSlot?: DataAndSlot<Account>;

	/**
	 * @param publicKey Address of the SPL token account to track.
	 * @param accountLoader Shared `BulkAccountLoader` this subscriber registers its callback with.
	 */
	public constructor(publicKey: PublicKey, accountLoader: BulkAccountLoader) {
		this.isSubscribed = false;
		this.publicKey = publicKey;
		this.accountLoader = accountLoader;
		this.eventEmitter = new EventEmitter();
	}

	/**
	 * Registers this account with the shared `BulkAccountLoader`, then polls up to 5 times
	 * (once per `load()` cycle) until data has loaded, since the token account may not have been
	 * fetched by the shared loader on the very first poll. `isSubscribed` is only set `true` if
	 * data loaded within those retries.
	 * @returns `true` if account data loaded within the retry budget, `false` otherwise.
	 */
	async subscribe(): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		await this.addToAccountLoader();
		let subscriptionSucceeded = false;
		let retries = 0;
		while (!subscriptionSucceeded && retries < 5) {
			await this.fetch();
			subscriptionSucceeded = this.didSubscriptionSucceed();
			retries++;
		}

		if (subscriptionSucceeded) {
			this.eventEmitter.emit('update');
		}

		this.isSubscribed = subscriptionSucceeded;
		return subscriptionSucceeded;
	}

	/** Registers this account and an error callback with the `BulkAccountLoader`. A no-op if already registered. */
	async addToAccountLoader(): Promise<void> {
		if (this.callbackId) {
			return;
		}

		this.callbackId = await this.accountLoader.addAccount(
			this.publicKey,
			(buffer, slot: number) => {
				const tokenAccount = parseTokenAccount(buffer, this.publicKey);
				this.tokenAccountAndSlot = { data: tokenAccount, slot };
				// @ts-ignore
				this.eventEmitter.emit('tokenAccountUpdate', tokenAccount);
				this.eventEmitter.emit('update');
			}
		);

		this.errorCallbackId = this.accountLoader.addErrorCallbacks((error) => {
			this.eventEmitter.emit('error', error);
		});
	}

	/** Forces the shared `BulkAccountLoader` to load, then reads and parses this account's buffer from it if present. Does not check slot ordering against the previously cached value (the loader itself already filters out stale/unchanged buffers before invoking callbacks). */
	async fetch(): Promise<void> {
		await this.accountLoader.load();
		const bufferAndSlot = this.accountLoader.getBufferAndSlot(this.publicKey);
		if (!bufferAndSlot) {
			return;
		}
		const { buffer, slot } = bufferAndSlot;
		if (!buffer) {
			return;
		}
		this.tokenAccountAndSlot = {
			data: parseTokenAccount(buffer, this.publicKey),
			slot,
		};
	}

	/** Unregisters this account (and its error callback) from the `BulkAccountLoader`. A no-op if not subscribed. */
	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		if (this.callbackId) {
			this.accountLoader.removeAccount(this.publicKey, this.callbackId);
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

	/** Throws `NotSubscribedError` if not subscribed. */
	public getTokenAccountAndSlot(): DataAndSlot<Account> {
		this.assertIsSubscribed();
		return this.tokenAccountAndSlot!;
	}

	/** True once account data has been loaded, independent of `isSubscribed`. */
	didSubscriptionSucceed(): boolean {
		return !!this.tokenAccountAndSlot;
	}
}
