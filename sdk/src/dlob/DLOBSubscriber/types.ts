import { IDriftClient } from '../../driftClient/types';
import { DLOB } from '../DLOB';
import { ProtectMakerParamsMap } from '../types';

export type DLOBSubscriptionConfig = {
	driftClient: IDriftClient;
	dlobSource: DLOBSource;
	slotSource: SlotSource;
	updateFrequency: number;
	protectedMakerView?: boolean;
};

export interface SlotSource {
	getSlot(): number;
}

export interface DLOBSource {
	getDLOB(
		slot: number,
		protectedMakerParamsMap?: ProtectMakerParamsMap
	): Promise<DLOB>;
}

export interface DLOBSubscriberEvents {
	update: (dlob: DLOB) => void;
	error: (e: Error) => void;
}
