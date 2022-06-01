import { PublicKey } from '@solana/web3.js';
import { BN } from '@project-serum/anchor';
import { getMarketPublicKey } from './pda';

const CACHE = new Map<string, PublicKey>();
export async function getMarketAddress(
	programId: PublicKey,
	marketIndex: BN
): Promise<PublicKey> {
	const cacheKey = `${programId.toString()}-${marketIndex.toString()}`;
	if (CACHE.has(cacheKey)) {
		return CACHE.get(cacheKey);
	}

	const publicKey = await getMarketPublicKey(programId, marketIndex);
	CACHE.set(cacheKey, publicKey);
	return publicKey;
}
