import { Commitment } from '@solana/web3.js';

/** Last-known chain progress at a given commitment level: block height, slot, and unix timestamp (seconds). Any field may be absent if never observed. */
export type ChainClockProgress = {
	blockHeight?: number;
	slot?: number;
	ts?: number;
};

/** A `ChainClockProgress` update tagged with the commitment level it was observed at. */
export type ChainClockUpdateProps = {
	commitment: Commitment;
} & ChainClockProgress;

/** Internal state map: one `ChainClockProgress` per `Commitment` level. */
export type ChainClockState = Map<Commitment, ChainClockProgress>;

/** Initial per-commitment progress values to seed a `ChainClock` with. */
export type ChainClickInitialisationProps = ChainClockUpdateProps[];

/**
 * Tracks the most recently observed block height/slot/timestamp per commitment level, so callers
 * (e.g. tx senders deciding whether a blockhash has expired) can read the latest known chain
 * progress without an RPC round-trip.
 */
export class ChainClock {
	private _state: ChainClockState;

	/**
	 * @param props - Initial progress values, one entry per commitment level to track.
	 */
	constructor(props: ChainClickInitialisationProps) {
		this._state = new Map<Commitment, ChainClockUpdateProps>();
		props.forEach((prop) => {
			this._state.set(prop.commitment, prop);
		});
	}

	/**
	 * Merges a new observation into the tracked state for `props.commitment`. Only fields present
	 * on `props` are updated (falsy/omitted `blockHeight`/`slot`/`ts` leave the existing stored
	 * value untouched, including `0` being treated as absent); the commitment level is created if
	 * not already tracked.
	 * @param props - New progress observation, tagged with its commitment level.
	 */
	update(props: ChainClockUpdateProps): void {
		const state = this._state.get(props.commitment);
		if (state) {
			if (props.blockHeight) state.blockHeight = props.blockHeight;
			if (props.slot) state.slot = props.slot;
			if (props.ts) state.ts = props.ts;
		} else {
			this._state.set(props.commitment, props);
		}
	}

	/**
	 * Reads the last-known progress at a commitment level.
	 * @param commitment - Commitment level to read.
	 * @returns The tracked `ChainClockProgress`, or `undefined` if nothing has been observed yet at that level.
	 */
	public getState(commitment: Commitment): ChainClockProgress | undefined {
		return this._state.get(commitment);
	}
}
