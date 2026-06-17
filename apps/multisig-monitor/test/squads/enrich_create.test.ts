import { enrichVaultTransactionCreate } from '../../src/squads/enrich_create';

describe('enrichVaultTransactionCreate', () => {
	/**
	 * Real exploit payload: the vault_transaction_create from
	 * 2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H
	 * (the first of two pre-signed transactions in the Apr 1 2026 admin takeover).
	 * Contains a single Drift::update_admin instruction.
	 */
	const EXPLOIT_DATA_B58 =
		'3D2K8UDavGr7baSVArjiAmpgZUdcwjRd4rA5q7c89MstKYqsSt4JXxeoiuu8NPUuy1yhypfsQtyDDUnx1AiKprXiB3oYa75x162x5GoUowLdBwTwXHRcX6iMRZsoTbd3ASYj8ShxiPtTARjMSSgvH5oRmYzBMfcrrZJJ2vV5pYAYwW59wiZJYgVFa7ShfbPKBFV1SUFN6sMUsDPuhz8d94P7LCnvs6X';

	const DRIFT = 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH';
	const VAULT = 'AiLGdNitMjv8n5HMS7HAdV2kaeJZZFd4jdfn5xp1PKrW';
	const STATE = '5zpq7DvB6UdFFvpmBPspGPNfUGoBRRCE2HHg5u3gxcsN';

	// sha256("global:update_admin")[0..8]
	const UPDATE_ADMIN_DISC = 'a1b028d53cb8b3e4';
	// The new admin pubkey embedded in the exploit's update_admin args.
	const NEW_ADMIN_HEX = 'ef5e27e0961546aad46749acc092e03c1a8c7c1187e887cc245db9cf2bca9a99';

	it('decodes the real Drift exploit payload', () => {
		const result = enrichVaultTransactionCreate(EXPLOIT_DATA_B58);
		expect(result).not.toBeNull();
		expect(result!.innerCpis).toHaveLength(1);

		const cpi = result!.innerCpis[0]!;
		expect(cpi.programId).toBe(DRIFT);
		expect(cpi.accounts).toEqual([VAULT, STATE]);
		expect(cpi.instructionName).toBeNull();
		expect(cpi.programLogs).toEqual([]);
	});

	it('preserves the embedded instruction data so layer-2 IDL decoding can run', () => {
		const result = enrichVaultTransactionCreate(EXPLOIT_DATA_B58);
		const cpi = result!.innerCpis[0]!;

		// dataB58 must round-trip to the discriminator + new_admin pubkey.
		// We don't import bs58 here — check the data is non-empty and the
		// hex form starts with the update_admin discriminator.
		const buf = Buffer.from(decodeBase58(cpi.dataB58)!);
		const hex = buf.toString('hex');
		expect(hex.slice(0, 16)).toBe(UPDATE_ADMIN_DISC);
		expect(hex.slice(16, 16 + 64)).toBe(NEW_ADMIN_HEX);
	});

	it('returns null on malformed base58', () => {
		expect(enrichVaultTransactionCreate('not-base58!@#$')).toBeNull();
	});

	it('returns null on truncated data', () => {
		expect(enrichVaultTransactionCreate('11')).toBeNull();
	});
});

// Minimal base58 decoder for the test (avoids importing bs58 just to verify hex).
function decodeBase58(s: string): Uint8Array | null {
	const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
	const map = new Map<string, number>();
	for (let i = 0; i < ALPHABET.length; i++) map.set(ALPHABET[i]!, i);

	let n = 0n;
	for (const c of s) {
		const v = map.get(c);
		if (v === undefined) return null;
		n = n * 58n + BigInt(v);
	}

	let leadingZeros = 0;
	for (const c of s) {
		if (c === '1') leadingZeros++;
		else break;
	}

	const bytes: number[] = [];
	while (n > 0n) {
		bytes.unshift(Number(n & 0xffn));
		n >>= 8n;
	}
	for (let i = 0; i < leadingZeros; i++) bytes.unshift(0);
	return new Uint8Array(bytes);
}
