import {
	DataAndSlot,
	AccountSubscriber,
	NotSubscribedError,
	InsuranceFundStakeAccountEvents,
	InsuranceFundStakeAccountSubscriber,
} from './types';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { Commitment, PublicKey } from '@solana/web3.js';
import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';
import { InsuranceFundStake } from '../types';
import { VelocityProgram } from '../config';

/**
 * Default `InsuranceFundStakeAccountSubscriber` implementation: wraps a single
 * `WebSocketAccountSubscriber` for the `InsuranceFundStake` account, mirroring
 * `WebSocketUserAccountSubscriber`. `insuranceFundStakeDataAccountSubscriber` throws if accessed
 * before `subscribe()` has run.
 */
export class WebSocketInsuranceFundStakeAccountSubscriber
	implements InsuranceFundStakeAccountSubscriber
{
	isSubscribed: boolean;
	resubTimeoutMs?: number;
	commitment?: Commitment;
	program: VelocityProgram;
	eventEmitter: StrictEventEmitter<
		EventEmitter,
		InsuranceFundStakeAccountEvents
	>;
	insuranceFundStakeAccountPublicKey: PublicKey;

	private _insuranceFundStakeDataAccountSubscriber?: AccountSubscriber<InsuranceFundStake>;
	get insuranceFundStakeDataAccountSubscriber(): AccountSubscriber<InsuranceFundStake> {
		if (!this._insuranceFundStakeDataAccountSubscriber) {
			throw new Error(
				'insuranceFundStakeDataAccountSubscriber accessed before subscribe()'
			);
		}
		return this._insuranceFundStakeDataAccountSubscriber;
	}
	set insuranceFundStakeDataAccountSubscriber(
		subscriber: AccountSubscriber<InsuranceFundStake>
	) {
		this._insuranceFundStakeDataAccountSubscriber = subscriber;
	}

	/**
	 * @param program Anchor program providing the connection and coder.
	 * @param insuranceFundStakeAccountPublicKey Address of the `InsuranceFundStake` account to track.
	 * @param resubTimeoutMs Resub watchdog timeout (ms) passed through as `ResubOpts.resubTimeoutMs` to the underlying `WebSocketAccountSubscriber`. Unlike other subscribers here, only this single option is exposed (not the full `ResubOpts` shape).
	 * @param commitment Commitment for the underlying subscription; defaults to the provider's configured commitment.
	 */
	public constructor(
		program: VelocityProgram,
		insuranceFundStakeAccountPublicKey: PublicKey,
		resubTimeoutMs?: number,
		commitment?: Commitment
	) {
		this.isSubscribed = false;
		this.program = program;
		this.insuranceFundStakeAccountPublicKey =
			insuranceFundStakeAccountPublicKey;
		this.eventEmitter = new EventEmitter();
		this.resubTimeoutMs = resubTimeoutMs;
		this.commitment = commitment;
	}

	/**
	 * Creates the underlying `WebSocketAccountSubscriber` and subscribes it. Idempotent: a no-op
	 * (returns `true`) if already subscribed.
	 * @param insuranceFundStakeAccount Optional pre-fetched account data to seed the subscriber with, skipping the initial RPC fetch.
	 */
	async subscribe(
		insuranceFundStakeAccount?: InsuranceFundStake
	): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		this.insuranceFundStakeDataAccountSubscriber =
			new WebSocketAccountSubscriber(
				'insuranceFundStake',
				this.program,
				this.insuranceFundStakeAccountPublicKey,
				undefined,
				{
					resubTimeoutMs: this.resubTimeoutMs,
				},
				this.commitment
			);

		if (insuranceFundStakeAccount) {
			this.insuranceFundStakeDataAccountSubscriber.setData(
				insuranceFundStakeAccount
			);
		}

		await this.insuranceFundStakeDataAccountSubscriber.subscribe(
			(data: InsuranceFundStake) => {
				this.eventEmitter.emit('insuranceFundStakeAccountUpdate', data);
				this.eventEmitter.emit('update');
			}
		);

		this.eventEmitter.emit('update');
		this.isSubscribed = true;
		return true;
	}

	/** Fetches the account once via the underlying `WebSocketAccountSubscriber`. */
	async fetch(): Promise<void> {
		await Promise.all([this.insuranceFundStakeDataAccountSubscriber.fetch()]);
	}

	/** Tears down the underlying WebSocket subscription. A no-op if not subscribed. */
	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		await Promise.all([
			this.insuranceFundStakeDataAccountSubscriber.unsubscribe(),
		]);

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
	public getInsuranceFundStakeAccountAndSlot():
		| DataAndSlot<InsuranceFundStake>
		| undefined {
		this.assertIsSubscribed();
		return this.insuranceFundStakeDataAccountSubscriber.dataAndSlot;
	}

	/**
	 * Applies an externally-obtained account update if `slot` is not older than the currently
	 * cached slot.
	 * @param insuranceFundStake Decoded account data to apply.
	 * @param slot Slot the data was observed at.
	 */
	public updateData(
		insuranceFundStake: InsuranceFundStake,
		slot: number
	): void {
		const currentDataSlot =
			this.insuranceFundStakeDataAccountSubscriber.dataAndSlot?.slot || 0;
		if (currentDataSlot <= slot) {
			this.insuranceFundStakeDataAccountSubscriber.setData(
				insuranceFundStake,
				slot
			);
			this.eventEmitter.emit(
				'insuranceFundStakeAccountUpdate',
				insuranceFundStake
			);
			this.eventEmitter.emit('update');
		}
	}
}
