import { DLOB } from './DLOB';
import { VelocityClient } from '../velocityClient';

export type DLOBSubscriptionConfig = {
	velocityClient?: VelocityClient;
	/** @deprecated Use `velocityClient` instead. `driftClient` will be removed in a future major. */
	driftClient?: VelocityClient;
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
