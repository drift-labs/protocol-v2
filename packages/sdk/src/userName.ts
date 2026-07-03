/** Maximum length, in characters/bytes, of a `User`/`SpotMarket`/`PerpMarket` name field on-chain. */
export const MAX_NAME_LENGTH = 32;

/** Default name assigned to a user's first sub-account (id 0) when none is supplied. */
export const DEFAULT_USER_NAME = 'Main Account';
/** Default name used for a market when no explicit name is configured. */
export const DEFAULT_MARKET_NAME = 'Default Market Name';

/**
 * Encodes a name into the fixed 32-byte, space-padded on-chain representation used by `User`,
 * `PerpMarket`, and `SpotMarket` name fields.
 * @param name - Name to encode; must be at most `MAX_NAME_LENGTH` (32) characters.
 * @returns A 32-element array of bytes: the UTF-8 encoding of `name` followed by space (`0x20`)
 * padding to fill the remaining length.
 * @throws Error if `name` is longer than `MAX_NAME_LENGTH`.
 */
export function encodeName(name: string): number[] {
	if (name.length > MAX_NAME_LENGTH) {
		throw Error(`Name (${name}) longer than 32 characters`);
	}

	const buffer = Buffer.alloc(32);
	buffer.fill(name);
	buffer.fill(' ', name.length);

	return Array(...buffer);
}

/**
 * Decodes a fixed 32-byte on-chain name field back into a trimmed string, reversing `encodeName`.
 * @param bytes - The raw 32-byte name field as read from an account.
 * @returns The name with trailing (and leading) whitespace padding removed.
 */
export function decodeName(bytes: number[]): string {
	const buffer = Buffer.from(bytes);
	return buffer.toString('utf8').trim();
}
