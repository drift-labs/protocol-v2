import { PublicKey } from '@solana/web3.js';
import { OracleSource, OracleSourceNum } from '../types';

/**
 * Maps an `OracleSource` enum-object (e.g. `{ pyth: {} }`) to its stable numeric encoding
 * (`OracleSourceNum`) used as part of an oracle id string. This encoding is SDK-internal — it
 * is not the on-chain Borsh discriminant (see `OracleSourceNum`).
 * @param source - The oracle source variant.
 * @returns The corresponding `OracleSourceNum` value.
 * @throws Error if `source` doesn't match any known variant.
 */
export function getOracleSourceNum(source: OracleSource): number {
	if ('pyth' in source) return OracleSourceNum.PYTH;
	if ('pyth1K' in source) return OracleSourceNum.PYTH_1K;
	if ('pyth1M' in source) return OracleSourceNum.PYTH_1M;
	if ('pythPull' in source) return OracleSourceNum.PYTH_PULL;
	if ('pyth1KPull' in source) return OracleSourceNum.PYTH_1K_PULL;
	if ('pyth1MPull' in source) return OracleSourceNum.PYTH_1M_PULL;
	if ('deprecatedSwitchboard' in source)
		return OracleSourceNum.DEPRECATED_SWITCHBOARD;
	if ('quoteAsset' in source) return OracleSourceNum.QUOTE_ASSET;
	if ('pythStableCoin' in source) return OracleSourceNum.PYTH_STABLE_COIN;
	if ('pythStableCoinPull' in source)
		return OracleSourceNum.PYTH_STABLE_COIN_PULL;
	if ('prelaunch' in source) return OracleSourceNum.PRELAUNCH;
	if ('deprecatedSwitchboardOnDemand' in source)
		return OracleSourceNum.DEPRECATED_SWITCHBOARD_ON_DEMAND;
	if ('pythLazer' in source) return OracleSourceNum.PYTH_LAZER;
	if ('pythLazer1K' in source) return OracleSourceNum.PYTH_LAZER_1K;
	if ('pythLazer1M' in source) return OracleSourceNum.PYTH_LAZER_1M;
	if ('pythLazerStableCoin' in source)
		return OracleSourceNum.PYTH_LAZER_STABLE_COIN;
	throw new Error('Invalid oracle source');
}

/**
 * Inverse of `getOracleSourceNum`: maps a numeric `OracleSourceNum` back to its `OracleSource`
 * enum-object.
 * @param sourceNum - Numeric oracle source encoding.
 * @returns The corresponding `OracleSource` variant.
 * @throws Error if `sourceNum` doesn't match any known `OracleSourceNum` value.
 */
export function getOracleSourceFromNum(sourceNum: number): OracleSource {
	if (sourceNum === OracleSourceNum.PYTH) return 'pyth';
	if (sourceNum === OracleSourceNum.PYTH_1K) return 'pyth1K';
	if (sourceNum === OracleSourceNum.PYTH_1M) return 'pyth1M';
	if (sourceNum === OracleSourceNum.PYTH_PULL) return 'pythPull';
	if (sourceNum === OracleSourceNum.PYTH_1K_PULL) return 'pyth1KPull';
	if (sourceNum === OracleSourceNum.PYTH_1M_PULL) return 'pyth1MPull';
	if (sourceNum === OracleSourceNum.DEPRECATED_SWITCHBOARD)
		return 'deprecatedSwitchboard';
	if (sourceNum === OracleSourceNum.QUOTE_ASSET) return 'quoteAsset';
	if (sourceNum === OracleSourceNum.PYTH_STABLE_COIN) return 'pythStableCoin';
	if (sourceNum === OracleSourceNum.PYTH_STABLE_COIN_PULL)
		return 'pythStableCoinPull';
	if (sourceNum === OracleSourceNum.PRELAUNCH) return 'prelaunch';
	if (sourceNum === OracleSourceNum.DEPRECATED_SWITCHBOARD_ON_DEMAND)
		return 'deprecatedSwitchboardOnDemand';
	if (sourceNum === OracleSourceNum.PYTH_LAZER) return 'pythLazer';
	if (sourceNum === OracleSourceNum.PYTH_LAZER_1K) return 'pythLazer1K';
	if (sourceNum === OracleSourceNum.PYTH_LAZER_1M) return 'pythLazer1M';
	if (sourceNum === OracleSourceNum.PYTH_LAZER_STABLE_COIN)
		return 'pythLazerStableCoin';
	throw new Error('Invalid oracle source');
}

/**
 * Builds a stable string id for an oracle account, uniquely identifying it by both its address
 * and the source/decoding scheme to use — the same pubkey can be interpreted under different
 * `OracleSource`s (e.g. `pyth` vs `pyth1K`) with different results, so the pubkey alone is not a
 * safe cache/map key.
 * @param publicKey - The oracle account's address.
 * @param source - The oracle source variant to decode it as.
 * @returns A string of the form `"<base58 pubkey>-<OracleSourceNum>"`.
 */
export function getOracleId(
	publicKey: PublicKey,
	source: OracleSource
): string {
	return `${publicKey.toBase58()}-${getOracleSourceNum(source)}`;
}

/**
 * Inverse of `getOracleId`: parses an oracle id string back into its pubkey and `OracleSource`.
 * @param oracleId - An id string previously produced by `getOracleId`.
 * @returns The decoded `publicKey` and `source`.
 * @throws Error if the encoded source number doesn't match any known `OracleSourceNum` value, or
 * `PublicKey` construction fails on a malformed id.
 */
export function getPublicKeyAndSourceFromOracleId(oracleId: string): {
	publicKey: PublicKey;
	source: OracleSource;
} {
	const [publicKey, source] = oracleId.split('-');
	return {
		publicKey: new PublicKey(publicKey),
		source: getOracleSourceFromNum(parseInt(source)),
	};
}
