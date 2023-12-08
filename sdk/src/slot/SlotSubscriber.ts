import { Connection } from '@solana/web3.js';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types/types/src';

// eslint-disable-next-line @typescript-eslint/ban-types
type SlotSubscriberConfig = {}; // for future customization

export interface SlotSubscriberEvents {
	newSlot: (newSlot: number) => void;
}

export class SlotSubscriber {
	currentSlot: number;
	subscriptionId: number;
	eventEmitter: StrictEventEmitter<EventEmitter, SlotSubscriberEvents>;

	public constructor(
		private connection: Connection,
		_config?: SlotSubscriberConfig
	) {
		this.eventEmitter = new EventEmitter();
	}

	public async subscribe(): Promise<void> {
		if (this.subscriptionId) {
			return;
		}

		this.currentSlot = await this.connection.getSlot('confirmed');

		this.subscriptionId = this.connection.onSlotChange((slotInfo) => {
			if (!this.currentSlot || this.currentSlot < slotInfo.slot) {
				this.currentSlot = slotInfo.slot;
				this.eventEmitter.emit('newSlot', slotInfo.slot);
			}
		});
	}

	public getSlot(): number {
		return this.currentSlot;
	}

	public async unsubscribe(): Promise<void> {
		if (this.subscriptionId) {
			await this.connection.removeSlotChangeListener(this.subscriptionId);
		}
	}
}
