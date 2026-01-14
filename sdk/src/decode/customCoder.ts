import { Buffer } from 'buffer';
import { Layout } from 'buffer-layout';
import camelcase from 'camelcase';
import { BorshAccountsCoder, BorshCoder, Idl } from '@coral-xyz/anchor';
import { discriminator } from '@coral-xyz/anchor-29/dist/cjs/coder/borsh/discriminator';
import { IdlDiscriminator } from '@coral-xyz/anchor/dist/cjs/idl';

export class CustomBorshCoder<A extends string = string> extends BorshCoder {
	/**
	 * Account coder.
	 */
	override readonly accounts: CustomBorshAccountsCoder<A>;
	constructor(idl: Idl) {
		super(idl);
		// only need to patch the accounts encoder
		// @ts-ignore
		this.accounts = new CustomBorshAccountsCoder(idl);
	}
}

/**
 * Custom accounts coder that wraps BorshAccountsCoder to fix encode buffer sizing.
 */
export class CustomBorshAccountsCoder<
	A extends string = string,
> extends BorshAccountsCoder {
	public constructor(idl: Idl) {
		super(idl);
	}

	public async encode<T = any>(accountName: A, account: T): Promise<Buffer> {
		const buffer = Buffer.alloc(this.size(accountName)); // fix encode issue - use proper size instead of fixed 1000
		const layout = (
			this['accountLayouts'] as Map<
				A,
				{ discriminator: IdlDiscriminator; layout: Layout }
			>
		).get(accountName);
		if (!layout) {
			throw new Error(`Unknown account: ${accountName}`);
		}
		const len = layout.layout.encode(account, buffer);
		const accountData = buffer.slice(0, len);
		const discriminator = this.accountDiscriminator(accountName);
		return Buffer.concat([discriminator, accountData]);
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
