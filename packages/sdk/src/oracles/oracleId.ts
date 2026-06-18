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

export function getOracleSourceFromNum(sourceNum: number): OracleSource {
	if (sourceNum === OracleSourceNum.PYTH) return 'pyth';
	if (sourceNum === OracleSourceNum.PYTH_1K) return 'pyth1K';
	if (sourceNum === OracleSourceNum.PYTH_1M) return 'pyth1M';
	if (sourceNum === OracleSourceNum.PYTH_PULL) return 'pythPull';
	if (sourceNum === OracleSourceNum.PYTH_1K_PULL) return 'pyth1KPull';
	if (sourceNum === OracleSourceNum.PYTH_1M_PULL) return 'pyth1MPull';
	if (sourceNum === OracleSourceNum.SWITCHBOARD) return 'switchboard';
	if (sourceNum === OracleSourceNum.QUOTE_ASSET) return 'quoteAsset';
	if (sourceNum === OracleSourceNum.PYTH_STABLE_COIN) return 'pythStableCoin';
	if (sourceNum === OracleSourceNum.PYTH_STABLE_COIN_PULL)
		return 'pythStableCoinPull';
	if (sourceNum === OracleSourceNum.PRELAUNCH) return 'prelaunch';
	if (sourceNum === OracleSourceNum.SWITCHBOARD_ON_DEMAND)
		return 'switchboardOnDemand';
	if (sourceNum === OracleSourceNum.PYTH_LAZER) return 'pythLazer';
	if (sourceNum === OracleSourceNum.PYTH_LAZER_1K) return 'pythLazer1K';
	if (sourceNum === OracleSourceNum.PYTH_LAZER_1M) return 'pythLazer1M';
	if (sourceNum === OracleSourceNum.PYTH_LAZER_STABLE_COIN)
		return 'pythLazerStableCoin';
	throw new Error('Invalid oracle source');
}

export function getOracleId(
	publicKey: PublicKey,
	source: OracleSource
): string {
	return `${publicKey.toBase58()}-${getOracleSourceNum(source)}`;
}

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
