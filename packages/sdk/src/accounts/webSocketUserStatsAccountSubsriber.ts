import {
	DataAndSlot,
	AccountSubscriber,
	NotSubscribedError,
	UserStatsAccountSubscriber,
	UserStatsAccountEvents,
	ResubOpts,
} from './types';
import { VelocityProgram } from '../config';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { Commitment, PublicKey } from '@solana/web3.js';
import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';
import { UserStatsAccount } from '../types';

/**
 * Default `UserStatsAccountSubscriber` implementation: wraps a single `WebSocketAccountSubscriber`
 * for the `UserStatsAccount`, mirroring `WebSocketUserAccountSubscriber`.
 * `userStatsAccountSubscriber` throws if accessed before `subscribe()` has run.
 */
export class WebSocketUserStatsAccountSubscriber
	implements UserStatsAccountSubscriber
{
	isSubscribed: boolean;
	resubOpts?: ResubOpts;
	commitment?: Commitment;
	program: VelocityProgram;
	eventEmitter: StrictEventEmitter<EventEmitter, UserStatsAccountEvents>;
	userStatsAccountPublicKey: PublicKey;

	private _userStatsAccountSubscriber?: AccountSubscriber<UserStatsAccount>;
	get userStatsAccountSubscriber(): AccountSubscriber<UserStatsAccount> {
		if (!this._userStatsAccountSubscriber) {
			throw new Error('userStatsAccountSubscriber accessed before subscribe()');
		}
		return this._userStatsAccountSubscriber;
	}
	set userStatsAccountSubscriber(
		subscriber: AccountSubscriber<UserStatsAccount>
	) {
		this._userStatsAccountSubscriber = subscriber;
	}

	/**
	 * @param program Anchor program providing the connection and coder.
	 * @param userStatsAccountPublicKey Address of the `UserStatsAccount` to track.
	 * @param resubOpts Resubscription watchdog options passed through to the underlying `WebSocketAccountSubscriber`.
	 * @param commitment Commitment for the underlying subscription; defaults to the provider's configured commitment.
	 */
	public constructor(
		program: VelocityProgram,
		userStatsAccountPublicKey: PublicKey,
		resubOpts?: ResubOpts,
		commitment?: Commitment
	) {
		this.isSubscribed = false;
		this.program = program;
		this.userStatsAccountPublicKey = userStatsAccountPublicKey;
		this.eventEmitter = new EventEmitter();
		this.resubOpts = resubOpts;
		this.commitment = commitment;
	}

	/**
	 * Creates the underlying `WebSocketAccountSubscriber` and subscribes it. Idempotent: a no-op
	 * (returns `true`) if already subscribed.
	 * @param userStatsAccount Optional pre-fetched account data to seed the subscriber with, skipping the initial RPC fetch.
	 */
	async subscribe(userStatsAccount?: UserStatsAccount): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		this.userStatsAccountSubscriber = new WebSocketAccountSubscriber(
			'userStats',
			this.program,
			this.userStatsAccountPublicKey,
			undefined,
			this.resubOpts,
			this.commitment
		);

		if (userStatsAccount) {
			this.userStatsAccountSubscriber.setData(userStatsAccount);
		}

		await this.userStatsAccountSubscriber.subscribe(
			(data: UserStatsAccount) => {
				this.eventEmitter.emit('userStatsAccountUpdate', data);
				this.eventEmitter.emit('update');
			}
		);

		this.eventEmitter.emit('update');
		this.isSubscribed = true;
		return true;
	}

	/** Fetches the account once via the underlying `WebSocketAccountSubscriber`. */
	async fetch(): Promise<void> {
		await Promise.all([this.userStatsAccountSubscriber.fetch()]);
	}

	/** Tears down the underlying WebSocket subscription. A no-op if not subscribed. */
	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		await Promise.all([this.userStatsAccountSubscriber.unsubscribe()]);

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
		return this.userStatsAccountSubscriber.dataAndSlot;
	}
}
