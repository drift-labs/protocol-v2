import { PublicKey } from '@solana/web3.js';
import { getPerpMarketPublicKey } from './pda';

const CACHE = new Map<string, PublicKey>();
/**
 * Derives (and memoizes) a `PerpMarket` account's PDA. Thin wrapper over
 * `getPerpMarketPublicKey` that caches results in a module-level `Map` keyed by
 * `${programId}-${marketIndex}` so repeated calls for the same market avoid redoing the
 * `findProgramAddress` computation. The cache is process-lifetime and never invalidated/evicted —
 * safe because a market's PDA for a given `programId`/`marketIndex` never changes.
 * @param programId - Deployed velocity program id.
 * @param marketIndex - Perp market index.
 * @returns The `PerpMarket` account's public key.
 */
export async function getMarketAddress(
	programId: PublicKey,
	marketIndex: number
): Promise<PublicKey> {
	const cacheKey = `${programId.toString()}-${marketIndex.toString()}`;
	const cached = CACHE.get(cacheKey);
	if (cached !== undefined) {
		return cached;
	}

	const publicKey = await getPerpMarketPublicKey(programId, marketIndex);
	CACHE.set(cacheKey, publicKey);
	return publicKey;
}
