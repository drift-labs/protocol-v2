// eslint-disable-next-line no-restricted-imports -- browser stub: minimal BN without pulling full Anchor
import BNJS from 'bn.js';
import * as web3 from '@solana/web3.js';

export class BN extends BNJS {}

export {
	BorshAccountsCoder,
	BorshEventCoder,
	BorshInstructionCoder,
	BorshCoder,
} from '@anchor-lang/core';

export const utils = {
	bytes: {
		utf8: {
			encode: (s: string) => new TextEncoder().encode(s),
		},
	},
};

export { web3 };

export class AnchorProvider {
	constructor() {
		throw new Error(
			'AnchorProvider is not supported in the browser build. Use `VelocityCore` (pure builders/decoders/PDAs) instead of `VelocityClient`.'
		);
	}
}

export class Program<_T = any> {
	constructor() {
		throw new Error(
			'Program is not supported in the browser build. Use `VelocityCore` (pure builders/decoders/PDAs) instead of `VelocityClient`.'
		);
	}
}

export type Idl = any;
export type Coder = any;
export type ProgramAccount = any;
export type Event = any;
export type Wallet = any;
