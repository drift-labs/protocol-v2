import fs from 'fs';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

/**
 * Loads a Solana `Keypair` from a private key given in any of the common CLI/env formats.
 * @param privateKey - One of: a filesystem path to a JSON keypair file (checked first via
 * `fs.existsSync`); a JSON array string (e.g. `"[1,2,3,...]"`); a comma-separated list of byte
 * values (e.g. `"1,2,3,..."`); or a base58-encoded secret key string (whitespace is stripped).
 * @returns The decoded `Keypair`.
 * @throws Error (from `Keypair.fromSecretKey`) if the decoded bytes are not a valid 64-byte secret key.
 */
export function loadKeypair(privateKey: string): Keypair {
	// try to load privateKey as a filepath
	let loadedKey: Uint8Array;
	if (fs.existsSync(privateKey)) {
		privateKey = fs.readFileSync(privateKey).toString();
	}

	if (privateKey.includes('[') && privateKey.includes(']')) {
		loadedKey = Uint8Array.from(JSON.parse(privateKey));
	} else if (privateKey.includes(',')) {
		loadedKey = Uint8Array.from(
			privateKey.split(',').map((val) => Number(val))
		);
	} else {
		privateKey = privateKey.replace(/\s/g, '');
		loadedKey = new Uint8Array(bs58.decode(privateKey));
	}

	return Keypair.fromSecretKey(Uint8Array.from(loadedKey));
}
