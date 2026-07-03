import {
	DataAndSlot,
	NotSubscribedError,
	OracleEvents,
	OracleAccountSubscriber,
} from './types';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from './bulkAccountLoader';
import { OracleClient, OraclePriceData } from '../oracles/types';

/** Tracks a single oracle account's decoded `OraclePriceData` via a shared `BulkAccountLoader`, decoding raw buffers with the source-appropriate `OracleClient` (Pyth/Switchboard/quote-asset/etc.). */
export class PollingOracleAccountSubscriber implements OracleAccountSubscriber {
	isSubscribed: boolean;
	eventEmitter: StrictEventEmitter<EventEmitter, OracleEvents>;
	publicKey: PublicKey;

	accountLoader: BulkAccountLoader;
	oracleClient: OracleClient;
	callbackId?: string;
	errorCallbackId?: string;

	oraclePriceData?: DataAndSlot<OraclePriceData>;

	/**
	 * @param publicKey Address of the oracle account to track.
	 * @param oracleClient Source-specific decoder (Pyth/Switchboard/quote-asset/etc.) used to parse the raw buffer into `OraclePriceData`.
	 * @param accountLoader Shared `BulkAccountLoader` this subscriber registers its callback with.
	 */
	public constructor(
		publicKey: PublicKey,
		oracleClient: OracleClient,
		accountLoader: BulkAccountLoader
	) {
		this.isSubscribed = false;
		this.publicKey = publicKey;
		this.oracleClient = oracleClient;
		this.accountLoader = accountLoader;
		this.eventEmitter = new EventEmitter();
	}

	/**
	 * Registers this account with the shared `BulkAccountLoader`, then polls up to 5 times
	 * (once per `load()` cycle) until data has loaded, since the oracle account may not have been
	 * fetched by the shared loader on the very first poll. `isSubscribed` is only set `true` if
	 * data loaded within those retries.
	 * @returns `true` if oracle data loaded within the retry budget, `false` otherwise.
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
			(buffer, slot) => {
				const oraclePriceData =
					this.oracleClient.getOraclePriceDataFromBuffer(buffer);
				this.oraclePriceData = { data: oraclePriceData, slot };
				// @ts-ignore
				this.eventEmitter.emit('oracleUpdate', oraclePriceData);
				this.eventEmitter.emit('update');
			}
		);

		this.errorCallbackId = this.accountLoader.addErrorCallbacks((error) => {
			this.eventEmitter.emit('error', error);
		});
	}

	/** Forces the shared `BulkAccountLoader` to load, then decodes this account's buffer from it if present. Does not check slot ordering against the previously cached value (the loader itself already filters out stale/unchanged buffers before invoking callbacks). */
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
		this.oraclePriceData = {
			data: await this.oracleClient.getOraclePriceDataFromBuffer(buffer),
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
	public getOraclePriceData(): DataAndSlot<OraclePriceData> {
		this.assertIsSubscribed();
		return this.oraclePriceData!;
	}

	/** True once oracle data has been loaded, independent of `isSubscribed`. */
	didSubscriptionSucceed(): boolean {
		return !!this.oraclePriceData;
	}
}
