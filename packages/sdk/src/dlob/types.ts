import { DLOB } from './DLOB';
import { VelocityClient } from '../velocityClient';

/** Configuration for constructing a `DLOBSubscriber`. */
export type DLOBSubscriptionConfig = {
	/** Client used to resolve market accounts/oracle data for `getL2`/`getL3`. Required — the constructor throws if omitted. */
	velocityClient?: VelocityClient;
	/** Provides the `DLOB` snapshot to poll, e.g. built from a `UserMap`. */
	dlobSource: DLOBSource;
	/** Provides the current slot used both to request the next `DLOB` snapshot and to price orders when serving `getL2`/`getL3`. */
	slotSource: SlotSource;
	/** Polling interval in milliseconds between calls to `dlobSource.getDLOB`. */
	updateFrequency: number;
};

/** Events emitted by `DLOBSubscriber`'s `eventEmitter`. */
export interface DLOBSubscriberEvents {
	/** Fired after each successful periodic `DLOB` refresh, with the newly fetched `DLOB`. */
	update: (dlob: DLOB) => void;
	/** Fired if a periodic refresh's `dlobSource.getDLOB` call throws. */
	error: (e: Error) => void;
}

/** Supplies a fresh `DLOB` snapshot on demand, e.g. built from a `UserMap` of on-chain user accounts. */
export interface DLOBSource {
	/**
	 * @param slot slot to build/tag the returned `DLOB` snapshot at
	 * @returns a promise resolving to a populated `DLOB`
	 */
	getDLOB(slot: number): Promise<DLOB>;
}

/** Supplies the current slot, e.g. backed by a `SlotSubscriber`. */
export interface SlotSource {
	/** @returns the most recently observed slot. */
	getSlot(): number;
}
