import { Commitment } from '@solana/web3.js';

export type ChainClockProgress = {
	blockHeight?: number;
	slot?: number;
	ts?: number;
};

export type ChainClockUpdateProps = {
	commitment: Commitment;
} & ChainClockProgress;

export type ChainClockState = Map<Commitment, ChainClockProgress>;

export type ChainClickInitialisationProps = ChainClockUpdateProps[];

export class ChainClock {
	private _state: ChainClockState;

	constructor(props: ChainClickInitialisationProps) {
		this._state = new Map<Commitment, ChainClockUpdateProps>();
		props.forEach((prop) => {
			this._state.set(prop.commitment, prop);
		});
	}

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

	public getState(commitment: Commitment): ChainClockProgress {
		return this._state.get(commitment);
	}
}
