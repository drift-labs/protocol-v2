import {
	BulkAccountLoader,
	DataAndSlot,
	NotSubscribedError,
	PublicKey,
} from '@velocity-exchange/sdk';
import { Program } from '@coral-xyz/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { DriftVaults } from '../types/drift_vaults';
import {
	VaultsProgramAccountBaseEvents,
	VaultsProgramAccountSubscriber,
} from '../types/types';

export abstract class PollingVaultsProgramAccountSubscriber<
	Account,
	AccountEvents extends VaultsProgramAccountBaseEvents,
> implements VaultsProgramAccountSubscriber<Account, AccountEvents>
{
	protected program: Program<DriftVaults>;
	protected _isSubscribed: boolean;
	protected pubkey: PublicKey;
	protected account?: DataAndSlot<Account>;

	protected _eventEmitter: StrictEventEmitter<EventEmitter, AccountEvents>;
	protected accountLoader: BulkAccountLoader;
	protected callbackId: string | null = null;
	protected errorCallbackId: string | null = null;

	constructor(
		program: Program<DriftVaults>,
		accountPubkey: PublicKey,
		accountLoader: BulkAccountLoader
	) {
		this.accountLoader = accountLoader;
		this._isSubscribed = false;
		this.pubkey = accountPubkey;
		this.program = program;
		// @ts-ignore
		this._eventEmitter = new EventEmitter();
	}

	get isSubscribed(): boolean {
		return this._isSubscribed;
	}

	get eventEmitter(): StrictEventEmitter<EventEmitter, AccountEvents> {
		return this._eventEmitter;
	}

	async subscribe(): Promise<boolean> {
		if (this._isSubscribed) {
			return true;
		}

		try {
			await this.addToAccountLoader();

			await this.fetchIfUnloaded();
			if (this.account) {
				// @ts-ignore
				this._eventEmitter.emit('update');
			}

			this._isSubscribed = true;
			return true;
		} catch (err) {
			console.error(err);
			this._isSubscribed = false;
			return false;
		}
	}

	async unsubscribe(): Promise<void> {
		if (!this._isSubscribed) {
			return;
		}

		this.accountLoader.removeAccount(this.pubkey, this.callbackId!);
		this.callbackId = null;

		this.accountLoader.removeErrorCallbacks(this.errorCallbackId!);
		this.errorCallbackId = null;

		this._isSubscribed = false;
	}

	async fetchIfUnloaded(): Promise<void> {
		if (this.account === undefined) {
			await this.fetch();
		}
	}

	assertIsSubscribed(): void {
		if (!this._isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	getAccountAndSlot(): DataAndSlot<Account> {
		this.assertIsSubscribed();
		if (!this.account) {
			throw new Error('Account not loaded');
		}
		return this.account;
	}

	abstract addToAccountLoader(): Promise<void>;
	abstract fetch(): Promise<void>;
	abstract updateData(account: Account, slot: number): void;
}
