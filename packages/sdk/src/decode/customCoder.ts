import { Buffer } from 'buffer';
import {
	Idl,
	BorshAccountsCoder,
	BorshEventCoder,
	BorshInstructionCoder,
	BorshCoder,
} from '../isomorphic/anchor';

export class CustomBorshCoder<
	A extends string = string,
	_T extends string = string,
> {
	readonly idl: Idl;

	/**
	 * Instruction coder.
	 */
	readonly instruction: BorshInstructionCoder;

	/**
	 * Account coder.
	 */
	readonly accounts: CustomBorshAccountsCoder<A>;

	/**
	 * Coder for events.
	 */
	readonly events: BorshEventCoder;

	/**
	 * Coder for user-defined types.
	 */
	readonly types: any;

	constructor(idl: Idl) {
		const baseCoder = new BorshCoder(idl);
		this.instruction = baseCoder.instruction as BorshInstructionCoder;
		this.accounts = new CustomBorshAccountsCoder(idl);
		this.events = baseCoder.events as BorshEventCoder;
		this.types = baseCoder.types;
		this.idl = idl;
	}
}

/**
 * Custom accounts coder that wraps BorshAccountsCoder to fix encode buffer sizing.
 */
export class CustomBorshAccountsCoder<A extends string = string> {
	private baseCoder: BorshAccountsCoder<A>;
	private idl: Idl;

	public constructor(idl: Idl) {
		this.baseCoder = new BorshAccountsCoder<A>(idl);
		this.idl = idl;
	}

	public async encode<T = any>(accountName: A, account: T): Promise<Buffer> {
		const layout = (this.baseCoder as any)['accountLayouts'].get(accountName);
		if (!layout) {
			throw new Error(`Unknown account: ${accountName}`);
		}

		// Fix: compute proper buffer size instead of the hardcoded 1000 bytes
		const size = this.baseCoder.size(accountName);
		const buffer = Buffer.alloc(Math.max(size, 1000));
		const len = layout.layout.encode(account, buffer);
		const accountData = buffer.slice(0, len);
		const discriminator = Buffer.from(layout.discriminator);
		return Buffer.concat([discriminator, accountData]);
	}

	// Delegate all other methods to the base coder
	public decode<T = any>(accountName: A, data: Buffer): T {
		return this.baseCoder.decode(accountName, data);
	}

	public decodeAny<T = any>(data: Buffer): T {
		return this.baseCoder.decodeAny(data);
	}

	public decodeUnchecked<T = any>(accountName: A, ix: Buffer): T {
		return this.baseCoder.decodeUnchecked(accountName, ix);
	}

	public memcmp(accountName: A, appendData?: Buffer): any {
		return this.baseCoder.memcmp(accountName, appendData);
	}

	public size(accountName: A | string): number {
		return this.baseCoder.size(accountName as A);
	}

	/**
	 * Calculates and returns a unique 8 byte discriminator prepended to all anchor accounts.
	 *
	 * @param name The name of the account to get the discriminator of.
	 */
	public static accountDiscriminator(_name: string): Buffer {
		// Delegate to an instance method since anchor 0.32 uses IDL discriminators
		throw new Error(
			'accountDiscriminator requires an instance; use coder.accountDiscriminator(name)'
		);
	}
}
