import { UserMap } from '../userMap/userMap';
import { DLOB } from './DLOB';
import { SlotSubscriber } from '../slot/SlotSubscriber';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';

type DLOBSubscriptionConfig = {
	userMap: UserMap;
	slotSubscriber: SlotSubscriber;
	updateFrequency: number;
};

export interface DLOBSubscriberEvents {
	update: (dlob: DLOB) => void;
}

export class DLOBSubscriber {
	userMap: UserMap;
	slotSubscriber: SlotSubscriber;
	updateFrequency: number;
	intervalId?: NodeJS.Timeout;
	dlob = new DLOB();
	public eventEmitter: StrictEventEmitter<EventEmitter, DLOBSubscriberEvents>;

	constructor(config: DLOBSubscriptionConfig) {
		this.userMap = config.userMap;
		this.slotSubscriber = config.slotSubscriber;
		this.updateFrequency = config.updateFrequency;
		this.eventEmitter = new EventEmitter();
	}

	public async subscribe(): Promise<void> {
		if (this.intervalId) {
			return;
		}

		await this.slotSubscriber.subscribe();
		await this.userMap.subscribe();

		await this.updateDLOB();

		this.intervalId = setInterval(async () => {
			await this.updateDLOB();
			this.eventEmitter.emit('update', this.dlob);
		});
	}

	async updateDLOB(): Promise<void> {
		const dlob = new DLOB();
		await dlob.initFromUserMap(this.userMap, this.slotSubscriber.getSlot());
		this.dlob = dlob;
	}

	public getDLOB(): DLOB {
		return this.dlob;
	}

	public async unsubscribe(): Promise<void> {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}
}
