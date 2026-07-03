import { Buffer } from 'buffer';
import {
	Idl,
	BorshAccountsCoder,
	BorshEventCoder,
	BorshInstructionCoder,
	BorshCoder,
} from '../isomorphic/anchor';

/**
 * Drop-in replacement for Anchor's `BorshCoder` that swaps in `CustomBorshAccountsCoder` for
 * account (de)serialization while delegating instruction/event/type coding to the stock Anchor
 * coder. Use this as the `coder` passed to `new Program(idl, provider, coder)` wherever an
 * account may be re-encoded (e.g. test fixtures), since the stock coder's `encode()` can
 * under-allocate its buffer for large accounts (see `CustomBorshAccountsCoder.encode`).
 */
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

	/**
	 * Encodes an account struct to its on-chain byte representation (8-byte discriminator +
	 * Borsh-serialized fields). Unlike Anchor's stock `BorshAccountsCoder.encode` — which
	 * allocates a hardcoded 1000-byte scratch buffer and silently truncates/corrupts any account
	 * larger than that (e.g. `User` at ~4.5KB, `PerpMarket`) — this computes the buffer size from
	 * the IDL layout via `this.baseCoder.size(accountName)` (floored at 1000 bytes for small
	 * accounts) so large accounts encode correctly.
	 * @param accountName - IDL account type name (e.g. `"User"`, `"PerpMarket"`).
	 * @param account - The decoded account value to serialize.
	 * @returns The encoded account bytes, discriminator included.
	 * @throws Error if `accountName` is not present in the IDL's account layouts.
	 */
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
	/** Decodes and validates an account's discriminator, delegating to Anchor's `BorshAccountsCoder.decode`. */
	public decode<T = any>(accountName: A, data: Buffer): T {
		return this.baseCoder.decode(accountName, data);
	}

	/** Decodes an account by inspecting its discriminator to determine its type, delegating to Anchor's `BorshAccountsCoder.decodeAny`. */
	public decodeAny<T = any>(data: Buffer): T {
		return this.baseCoder.decodeAny(data);
	}

	/** Decodes an account without discriminator validation, delegating to Anchor's `BorshAccountsCoder.decodeUnchecked`. */
	public decodeUnchecked<T = any>(accountName: A, ix: Buffer): T {
		return this.baseCoder.decodeUnchecked(accountName, ix);
	}

	/** Builds a memcmp filter for `accountName`'s discriminator (optionally with `appendData`), delegating to Anchor's `BorshAccountsCoder.memcmp`. */
	public memcmp(accountName: A, appendData?: Buffer): any {
		return this.baseCoder.memcmp(accountName, appendData);
	}

	/** Returns the fixed on-chain byte size (including discriminator) of `accountName`, delegating to Anchor's `BorshAccountsCoder.size`. */
	public size(accountName: A | string): number {
		return this.baseCoder.size(accountName as A);
	}

	/**
	 * Returns the 8-byte account discriminator for `accountName`, read from the IDL-derived
	 * account layout (Anchor 0.32+ derives discriminators from the IDL rather than a static
	 * `sha256("account:Name")` hash). This is the instance-scoped counterpart to the throwing
	 * static `accountDiscriminator` stub.
	 * @param accountName - IDL account type name (e.g. `"User"`, `"PerpMarket"`).
	 * @throws Error if `accountName` is not present in the IDL's account layouts.
	 */
	public accountDiscriminator(accountName: A): Buffer {
		const layout = (this.baseCoder as any)['accountLayouts'].get(accountName);
		if (!layout) {
			throw new Error(`Unknown account: ${accountName}`);
		}
		return Buffer.from(layout.discriminator);
	}

	/**
	 * Always throws. Anchor 0.32+ derives account discriminators from the IDL rather than a
	 * static `sha256("account:Name")` hash, so no *static* method can compute one without an
	 * IDL instance — this stub exists only to satisfy code written against Anchor's older static
	 * `BorshAccountsCoder.accountDiscriminator(name)` API.
	 * @param _name - Unused.
	 * @throws Error always; use the instance-scoped `accountDiscriminator` on a coder built from an IDL instead.
	 */
	public static accountDiscriminator(_name: string): Buffer {
		// Delegate to an instance method since anchor 0.32 uses IDL discriminators
		throw new Error(
			'accountDiscriminator requires an instance; use coder.accountDiscriminator(name)'
		);
	}
}
