import { DLOB } from './DLOB';
import { DriftClient } from '../driftClient';
import { MarketType } from '..';

export type DLOBSubscriptionConfig = {
	driftClient: DriftClient;
	dlobSource: DLOBSource;
	slotSource: SlotSource;
	updateFrequency: number;
	marketType?: MarketType;
	marketName?: string;
	marketIndex?: number;
};

export interface DLOBSubscriberEvents {
	update: (dlob: DLOB) => void;
	error: (e: Error) => void;
}

export interface DLOBSource {
	getDLOB({
		slot,
		marketName,
		marketIndex,
		marketType,
	}: {
		slot: number;
		marketName?: string;
		marketIndex?: number;
		marketType?: MarketType;
	}): Promise<DLOB>;
}

export interface SlotSource {
	getSlot(): number;
}
