import { IDriftClient } from '../../driftClient/types';
import { IDLOB, ProtectMakerParamsMap } from '../types';

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
	): Promise<IDLOB>;
}

export interface DLOBSubscriberEvents {
	update: (dlob: IDLOB) => void;
	error: (e: Error) => void;
}
