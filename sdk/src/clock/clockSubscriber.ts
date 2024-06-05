import { Commitment, Connection, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types/types/src';
import { BN } from '..';

// eslint-disable-next-line @typescript-eslint/ban-types
type ClockSubscriberConfig = {
	commitment: Commitment;
	resubTimeoutMs?: number;
};

export interface ClockSubscriberEvent {
	clockUpdate: (ts: number) => void;
}

export class ClockSubscriber {
	private _latestSlot: number;
	private _currentTs: number;
	private subscriptionId: number;
	commitment: Commitment;
	eventEmitter: StrictEventEmitter<EventEmitter, ClockSubscriberEvent>;

	public get latestSlot(): number {
		return this._latestSlot;
	}

	public get currentTs(): number {
		return this._currentTs;
	}

	// Reconnection
	private timeoutId?: NodeJS.Timeout;
	private resubTimeoutMs?: number;
	private isUnsubscribing = false;
	private receivingData = false;

	public constructor(
		private connection: Connection,
		config?: ClockSubscriberConfig
	) {
		this.eventEmitter = new EventEmitter();
		this.resubTimeoutMs = config?.resubTimeoutMs;
		this.commitment = config?.commitment || 'confirmed';
		if (this.resubTimeoutMs < 1000) {
			console.log(
				'resubTimeoutMs should be at least 1000ms to avoid spamming resub'
			);
		}
	}

	public async subscribe(): Promise<void> {
		if (this.subscriptionId != null) {
			return;
		}

		this.subscriptionId = this.connection.onAccountChange(
			SYSVAR_CLOCK_PUBKEY,
			(acctInfo, context) => {
				if (!this.latestSlot || this.latestSlot < context.slot) {
					if (this.resubTimeoutMs && !this.isUnsubscribing) {
						this.receivingData = true;
						clearTimeout(this.timeoutId);
						this.setTimeout();
					}
					this._latestSlot = context.slot;
					this._currentTs = new BN(
						acctInfo.data.subarray(32, 39),
						undefined,
						'le'
					).toNumber();
					this.eventEmitter.emit('clockUpdate', this.currentTs);
				}
			},
			this.commitment
		);

		if (this.resubTimeoutMs) {
			this.receivingData = true;
			this.setTimeout();
		}
	}

	private setTimeout(): void {
		this.timeoutId = setTimeout(async () => {
			if (this.isUnsubscribing) {
				// If we are in the process of unsubscribing, do not attempt to resubscribe
				return;
			}

			if (this.receivingData) {
				console.log(
					`No new slot in ${this.resubTimeoutMs}ms, slot subscriber resubscribing`
				);
				await this.unsubscribe(true);
				this.receivingData = false;
				await this.subscribe();
			}
		}, this.resubTimeoutMs);
	}

	public getUnixTs(): number {
		return this.currentTs;
	}

	public async unsubscribe(onResub = false): Promise<void> {
		if (!onResub) {
			this.resubTimeoutMs = undefined;
		}
		this.isUnsubscribing = true;
		clearTimeout(this.timeoutId);
		this.timeoutId = undefined;

		if (this.subscriptionId != null) {
			await this.connection.removeAccountChangeListener(this.subscriptionId);
			this.subscriptionId = undefined;
			this.isUnsubscribing = false;
		} else {
			this.isUnsubscribing = false;
		}
	}
}
