import {
	OrderSubscriber,
	OrderSubscriberConfig,
	UserAccount,
} from '@velocity-exchange/sdk';

export class OrderSubscriberFiltered extends OrderSubscriber {
	public ignoreList: string[];

	constructor(
		config: OrderSubscriberConfig & {
			ignoreList?: string[];
		}
	) {
		super(config);
		this.ignoreList = config.ignoreList ?? [];
	}

	override async tryUpdateUserAccount(
		key: string,
		dataType: 'raw' | 'decoded' | 'buffer',
		data: string[] | UserAccount | Buffer,
		slot: number
	) {
		if (!this.mostRecentSlot || slot > this.mostRecentSlot) {
			this.mostRecentSlot = slot;
		}

		if (this.ignoreList.includes(key)) {
			return;
		}

		super.tryUpdateUserAccount(key, dataType, data, slot);
	}
}
