import { Connection } from '@solana/web3.js';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types/types/src';

// eslint-disable-next-line @typescript-eslint/ban-types
type SlotSubscriberConfig = {
	useWhirligig?: boolean;
}; // for future customization

export interface SlotSubscriberEvents {
	newSlot: (newSlot: number) => void;
}

export class SlotSubscriber {
	currentSlot: number;
	subscriptionId: number;
	eventEmitter: StrictEventEmitter<EventEmitter, SlotSubscriberEvents>;

	wsConnection?: Connection;

	public constructor(
		private connection: Connection,
		config?: SlotSubscriberConfig
	) {
		this.eventEmitter = new EventEmitter();
		if (config?.useWhirligig) {
			this.wsConnection = new Connection(
				this.connection.rpcEndpoint + '/whirligig',
				'confirmed'
			);
		} else {
			this.wsConnection = connection;
		}
	}

	public async subscribe(): Promise<void> {
		if (this.subscriptionId) {
			return;
		}

		this.currentSlot = await this.connection.getSlot('confirmed');

		this.subscriptionId = this.wsConnection.onSlotChange((slotInfo) => {
			this.currentSlot = slotInfo.slot;
			this.eventEmitter.emit('newSlot', slotInfo.slot);
		});
	}

	public getSlot(): number {
		return this.currentSlot;
	}

	public async unsubscribe(): Promise<void> {
		if (this.subscriptionId) {
			await this.wsConnection.removeSlotChangeListener(this.subscriptionId);
		}
	}
}
