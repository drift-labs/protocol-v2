import { DLOB } from './DLOB';
import { DriftClient } from '../driftClient';

export type DLOBSubscriptionConfig = {
	driftClient: DriftClient;
	dlobSource: DLOBSource;
	slotSource: SlotSource;
	updateFrequency: number;
	protectedMakerView?: boolean;
};

export interface DLOBSubscriberEvents {
	update: (dlob: DLOB) => void;
	error: (e: Error) => void;
}

export interface DLOBSource {
	getDLOB(slot: number, protectedMakerView?: boolean): Promise<DLOB>;
}

export interface SlotSource {
	getSlot(): number;
}
