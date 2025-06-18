import { Buffer } from 'buffer';
import camelcase from 'camelcase';
import { Idl, IdlTypeDef } from '@coral-xyz/anchor/dist/cjs/idl';
import {
	AccountsCoder,
	BorshAccountsCoder,
	BorshEventCoder,
	BorshInstructionCoder,
	Coder,
} from '@coral-xyz/anchor/dist/cjs/coder';
import { BorshTypesCoder } from '@coral-xyz/anchor/dist/cjs/coder/borsh/types';
import { discriminator } from '@coral-xyz/anchor/dist/cjs/coder/borsh/discriminator';

export class CustomBorshCoder<
	A extends string = string,
	T extends string = string,
> implements Coder
{
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
	readonly types: BorshTypesCoder<T>;

	constructor(idl: Idl) {
		this.instruction = new BorshInstructionCoder(idl);
		this.accounts = new CustomBorshAccountsCoder(idl);
		this.events = new BorshEventCoder(idl);
		this.types = new BorshTypesCoder(idl);
		this.idl = idl;
	}
}

/**
 * Custom accounts coder that wraps BorshAccountsCoder to fix encode buffer sizing.
 */
export class CustomBorshAccountsCoder<A extends string = string>
	implements AccountsCoder
{
	private baseCoder: BorshAccountsCoder<A>;
	private idl: Idl;

	public constructor(idl: Idl) {
		this.baseCoder = new BorshAccountsCoder<A>(idl);
		this.idl = idl;
	}

	public async encode<T = any>(accountName: A, account: T): Promise<Buffer> {
		const idlAcc = this.idl.accounts?.find((acc) => acc.name === accountName);
		if (!idlAcc) {
			throw new Error(`Unknown account not found in idl: ${accountName}`);
		}

		const buffer = Buffer.alloc(this.size(idlAcc)); // fix encode issue - use proper size instead of fixed 1000
		const layout = this.baseCoder['accountLayouts'].get(accountName);
		if (!layout) {
			throw new Error(`Unknown account: ${accountName}`);
		}
		const len = layout.encode(account, buffer);
		const accountData = buffer.slice(0, len);
		const discriminator = BorshAccountsCoder.accountDiscriminator(accountName);
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

	public size(idlAccount: IdlTypeDef): number {
		return this.baseCoder.size(idlAccount);
	}

	/**
	 * Calculates and returns a unique 8 byte discriminator prepended to all anchor accounts.
	 *
	 * @param name The name of the account to calculate the discriminator.
	 */
	public static accountDiscriminator(name: string): Buffer {
		const discriminatorPreimage = `account:${camelcase(name, {
			pascalCase: true,
			preserveConsecutiveUppercase: true,
		})}`;
		return discriminator(discriminatorPreimage);
	}
}
