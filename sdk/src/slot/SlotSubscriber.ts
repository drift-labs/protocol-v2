import { Connection } from '@solana/web3.js';

// eslint-disable-next-line @typescript-eslint/ban-types
type SlotSubscriberConfig = {}; // for future customization

export class SlotSubscriber {
	currentSlot: number;
	subscriptionId: number;

	public constructor(
		private connection: Connection,
		_config?: SlotSubscriberConfig
	) {}

	public async subscribe(): Promise<void> {
		this.currentSlot = await this.connection.getSlot('confirmed');

		this.subscriptionId = this.connection.onSlotChange((slotInfo) => {
			this.currentSlot = slotInfo.slot;
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
