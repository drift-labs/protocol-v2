import { Connection } from '@solana/web3.js';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types/types/src';

// eslint-disable-next-line @typescript-eslint/ban-types
type SlotSubscriberConfig = {
	resubTimeoutMs?: number;
}; // for future customization

export interface SlotSubscriberEvents {
	newSlot: (newSlot: number) => void;
}

export class SlotSubscriber {
	currentSlot: number;
	subscriptionId: number;
	eventEmitter: StrictEventEmitter<EventEmitter, SlotSubscriberEvents>;

	// Reconnection
	timeoutId?: NodeJS.Timeout;
	resubTimeoutMs?: number;
	isUnsubscribing = false;
	receivingData = false;

	public constructor(
		private connection: Connection,
		config?: SlotSubscriberConfig
	) {
		this.eventEmitter = new EventEmitter();
		this.resubTimeoutMs = config?.resubTimeoutMs;
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

		this.currentSlot = await this.connection.getSlot('confirmed');

		this.subscriptionId = this.connection.onSlotChange((slotInfo) => {
			if (!this.currentSlot || this.currentSlot < slotInfo.slot) {
				if (this.resubTimeoutMs && !this.isUnsubscribing) {
					this.receivingData = true;
					clearTimeout(this.timeoutId);
					this.setTimeout();
				}
				this.currentSlot = slotInfo.slot;
				this.eventEmitter.emit('newSlot', slotInfo.slot);
			}
		});

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

	public getSlot(): number {
		return this.currentSlot;
	}

	public async unsubscribe(onResub = false): Promise<void> {
		if (!onResub) {
			this.resubTimeoutMs = undefined;
		}
		this.isUnsubscribing = true;
		clearTimeout(this.timeoutId);
		this.timeoutId = undefined;

		if (this.subscriptionId != null) {
			await this.connection.removeSlotChangeListener(this.subscriptionId);
			this.subscriptionId = undefined;
			this.isUnsubscribing = false;
		} else {
			this.isUnsubscribing = false;
		}
	}
}
