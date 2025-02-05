import { PublicKey } from '@solana/web3.js';
import { OracleSource, OracleSourceNum } from '../types';

export function getOracleSourceNum(source: OracleSource): number {
	if ('pyth' in source) return OracleSourceNum.PYTH;
	if ('pyth1K' in source) return OracleSourceNum.PYTH_1K;
	if ('pyth1M' in source) return OracleSourceNum.PYTH_1M;
	if ('pythPull' in source) return OracleSourceNum.PYTH_PULL;
	if ('pyth1KPull' in source) return OracleSourceNum.PYTH_1K_PULL;
	if ('pyth1MPull' in source) return OracleSourceNum.PYTH_1M_PULL;
	if ('switchboard' in source) return OracleSourceNum.SWITCHBOARD;
	if ('quoteAsset' in source) return OracleSourceNum.QUOTE_ASSET;
	if ('pythStableCoin' in source) return OracleSourceNum.PYTH_STABLE_COIN;
	if ('pythStableCoinPull' in source)
		return OracleSourceNum.PYTH_STABLE_COIN_PULL;
	if ('prelaunch' in source) return OracleSourceNum.PRELAUNCH;
	if ('switchboardOnDemand' in source)
		return OracleSourceNum.SWITCHBOARD_ON_DEMAND;
	if ('pythLazer' in source) return OracleSourceNum.PYTH_LAZER;
	if ('pythLazer1K' in source) return OracleSourceNum.PYTH_LAZER_1K;
	if ('pythLazer1M' in source) return OracleSourceNum.PYTH_LAZER_1M;
	if ('pythLazerStableCoin' in source)
		return OracleSourceNum.PYTH_LAZER_STABLE_COIN;
	throw new Error('Invalid oracle source');
}

export function getOracleId(
	publicKey: PublicKey,
	source: OracleSource
): string {
	return `${publicKey.toBase58()}-${getOracleSourceNum(source)}`;
}
