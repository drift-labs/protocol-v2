import { BN } from '@coral-xyz/anchor';
import { ProtectMakerParamsMap } from '../dlob/types';
import { PerpMarketAccount, ProtectedMakerParams } from '../types';

export function getProtectedMakerParams(
	perpMarket: PerpMarketAccount
): ProtectedMakerParams {
	let dynamicOffset;
	if (perpMarket.protectedMakerDynamicDivisor > 0) {
		dynamicOffset = BN.max(
			perpMarket.amm.oracleStd,
			perpMarket.amm.markStd
		).divn(perpMarket.protectedMakerDynamicDivisor);
	} else {
		dynamicOffset = 0;
	}

	return {
		tickSize: perpMarket.amm.orderTickSize,
		limitPriceDivisor: perpMarket.protectedMakerLimitPriceDivisor,
		dynamicOffset: dynamicOffset,
	};
}

export function getProtectedMakerParamsMap(
	perpMarkets: PerpMarketAccount[]
): ProtectMakerParamsMap {
	const map = {
		perp: new Map<number, ProtectedMakerParams>(),
		spot: new Map<number, ProtectedMakerParams>(),
	};
	for (const perpMarket of perpMarkets) {
		const marketIndex = perpMarket.marketIndex;
		const protectedMakerParams = getProtectedMakerParams(perpMarket);
		map.perp.set(marketIndex, protectedMakerParams);
	}
	return map;
}
