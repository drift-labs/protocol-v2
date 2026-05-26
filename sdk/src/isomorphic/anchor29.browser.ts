// eslint-disable-next-line no-restricted-imports -- browser stub: minimal BN without pulling full Anchor
import BNJS from 'bn.js';
import * as web3 from '@solana/web3.js';

export class BN extends BNJS {}
export { web3 };

export class AnchorProvider {
	constructor() {
		throw new Error(
			'Anchor (0.29) is not supported in the browser build. Use `VelocityCore` instead of `VelocityClient`.'
		);
	}
}

export class Program<_T = any> {
	constructor() {
		throw new Error(
			'Anchor (0.29) Program is not supported in the browser build. Use `VelocityCore` instead of `VelocityClient`.'
		);
	}
}

export type IdlAccounts<_T = any> = any;
