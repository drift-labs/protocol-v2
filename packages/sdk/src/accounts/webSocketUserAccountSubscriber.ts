import {
	DataAndSlot,
	AccountSubscriber,
	NotSubscribedError,
	UserAccountEvents,
	UserAccountSubscriber,
	ResubOpts,
} from './types';
import { VelocityProgram } from '../config';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { Commitment, PublicKey } from '@solana/web3.js';
import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';
import { UserAccount } from '../types';

/**
 * Default `UserAccountSubscriber` implementation: wraps a single `WebSocketAccountSubscriber`
 * for the `UserAccount`. `userDataAccountSubscriber` throws if accessed before `subscribe()` has
 * run (it is created there, not in the constructor).
 */
export class WebSocketUserAccountSubscriber implements UserAccountSubscriber {
	isSubscribed: boolean;
	resubOpts?: ResubOpts;
	commitment?: Commitment;
	program: VelocityProgram;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	userAccountPublicKey: PublicKey;

	private _userDataAccountSubscriber?: AccountSubscriber<UserAccount>;
	get userDataAccountSubscriber(): AccountSubscriber<UserAccount> {
		if (!this._userDataAccountSubscriber) {
			throw new Error('userDataAccountSubscriber accessed before subscribe()');
		}
		return this._userDataAccountSubscriber;
	}
	set userDataAccountSubscriber(subscriber: AccountSubscriber<UserAccount>) {
		this._userDataAccountSubscriber = subscriber;
	}

	/**
	 * @param program Anchor program providing the connection and coder.
	 * @param userAccountPublicKey Address of the `UserAccount` to track.
	 * @param resubOpts Resubscription watchdog options passed through to the underlying `WebSocketAccountSubscriber`.
	 * @param commitment Commitment for the underlying subscription; defaults to the provider's configured commitment.
	 */
	public constructor(
		program: VelocityProgram,
		userAccountPublicKey: PublicKey,
		resubOpts?: ResubOpts,
		commitment?: Commitment
	) {
		this.isSubscribed = false;
		this.program = program;
		this.resubOpts = resubOpts;
		this.userAccountPublicKey = userAccountPublicKey;
		this.eventEmitter = new EventEmitter();
		this.commitment = commitment;
	}

	/**
	 * Creates the underlying `WebSocketAccountSubscriber` and subscribes it. Idempotent: a no-op
	 * (returns `true`) if already subscribed.
	 * @param userAccount Optional pre-fetched account data to seed the subscriber with, skipping the initial RPC fetch.
	 */
	async subscribe(userAccount?: UserAccount): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		this.userDataAccountSubscriber = new WebSocketAccountSubscriber(
			'user',
			this.program,
			this.userAccountPublicKey,
			undefined,
			this.resubOpts,
			this.commitment
		);

		if (userAccount) {
			this.userDataAccountSubscriber.setData(userAccount);
		}

		await this.userDataAccountSubscriber.subscribe((data: UserAccount) => {
			this.eventEmitter.emit('userAccountUpdate', data);
			this.eventEmitter.emit('update');
		});

		this.eventEmitter.emit('update');
		this.isSubscribed = true;
		return true;
	}

	/** Fetches the account once via the underlying `WebSocketAccountSubscriber`. */
	async fetch(): Promise<void> {
		await Promise.all([this.userDataAccountSubscriber.fetch()]);
	}

	/** Tears down the underlying WebSocket subscription. A no-op if not subscribed. */
	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		await Promise.all([this.userDataAccountSubscriber.unsubscribe()]);

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
		return this.userDataAccountSubscriber.dataAndSlot;
	}

	/**
	 * Applies an externally-obtained account update if `slot` is not older than the currently
	 * cached slot.
	 * @param userAccount Decoded account data to apply.
	 * @param slot Slot the data was observed at.
	 */
	public updateData(userAccount: UserAccount, slot: number) {
		const currentDataSlot =
			this.userDataAccountSubscriber.dataAndSlot?.slot || 0;
		if (currentDataSlot <= slot) {
			this.userDataAccountSubscriber.setData(userAccount, slot);
			this.eventEmitter.emit('userAccountUpdate', userAccount);
			this.eventEmitter.emit('update');
		}
	}
}
