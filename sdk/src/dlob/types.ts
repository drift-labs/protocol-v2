import { DLOB } from './DLOB';
import { DriftClient } from '../driftClient';

export type DLOBSubscriptionConfig = {
	driftClient: DriftClient;
	dlobSource: DLOBSource;
	slotSource: SlotSource;
	updateFrequency: number;
};

export interface DLOBSubscriberEvents {
	update: (dlob: DLOB) => void;
	error: (e: Error) => void;
}

export interface DLOBSource {
	getDLOB(slot: number): Promise<DLOB>;
}

export interface SlotSource {
	getSlot(): number;
}
