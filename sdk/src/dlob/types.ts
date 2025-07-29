import { DLOB } from './DLOB';
import { DriftClient } from '../driftClient';
import { ProtectedMakerParams } from '../types';
import { MarketTypeStr } from '../types';

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
	getDLOB(
		slot: number,
		protectedMakerParamsMap?: ProtectMakerParamsMap
	): Promise<DLOB>;
}

export interface SlotSource {
	getSlot(): number;
}

export type ProtectMakerParamsMap = {
	[marketType in MarketTypeStr]: Map<number, ProtectedMakerParams>;
};
