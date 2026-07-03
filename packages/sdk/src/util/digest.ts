import { createHash } from 'crypto';
import { nanoid } from 'nanoid';

/**
 * Computes the raw SHA-256 digest of arbitrary data.
 * @param data - Bytes to hash.
 * @returns The 32-byte SHA-256 digest.
 */
export function digest(data: Buffer): Buffer {
	const hash = createHash('sha256');
	hash.update(data);
	return hash.digest();
}

/**
 * Computes a base64-encoded SHA-256 digest of a signature, used as a compact, collision-resistant
 * dedup/lookup key for signed messages (e.g. swift/signed-message orders) without storing the full
 * signature.
 * @param signature - Raw signature bytes to hash.
 * @returns The base64-encoded SHA-256 digest.
 */
export function digestSignature(signature: Uint8Array): string {
	return createHash('sha256').update(signature).digest('base64');
}

/**
 * Generates a random 8-character uuid for tagging a signed-message (swift) order, matching the
 * `uuid: Uint8Array` field expected on-chain/by the swift server.
 * @returns 8 raw bytes (the ASCII/UTF-8 encoding of an 8-character nanoid string).
 */
export function generateSignedMsgUuid(): Uint8Array {
	return Uint8Array.from(Buffer.from(nanoid(8)));
}
