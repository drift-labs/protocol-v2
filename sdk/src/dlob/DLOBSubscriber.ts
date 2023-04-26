import { DLOB } from './DLOB';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import {
	DLOBSource,
	DLOBSubscriberEvents,
	DLOBSubscriptionConfig,
	SlotSource,
} from './types';

export class DLOBSubscriber {
	dlobSource: DLOBSource;
	slotSource: SlotSource;
	updateFrequency: number;
	intervalId?: NodeJS.Timeout;
	dlob = new DLOB();
	public eventEmitter: StrictEventEmitter<EventEmitter, DLOBSubscriberEvents>;

	constructor(config: DLOBSubscriptionConfig) {
		this.dlobSource = config.dlobSource;
		this.slotSource = config.slotSource;
		this.updateFrequency = config.updateFrequency;
		this.eventEmitter = new EventEmitter();
	}

	public async subscribe(): Promise<void> {
		if (this.intervalId) {
			return;
		}

		await this.updateDLOB();

		this.intervalId = setInterval(async () => {
			try {
				await this.updateDLOB();
				this.eventEmitter.emit('update', this.dlob);
			} catch (e) {
				this.eventEmitter.emit('error', e);
			}
		}, this.updateFrequency);
	}

	async updateDLOB(): Promise<void> {
		this.dlob = await this.dlobSource.getDLOB(this.slotSource.getSlot());
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
