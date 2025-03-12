import { BN } from '..';
import { PerpMarketAccount, ProtectedMakerParams } from '../types';

export function getProtectedMakerParams(
	perpMarket: PerpMarketAccount
): ProtectedMakerParams {
	let dynamicOffset;
	if (perpMarket.pmmDynamicDivisor > 0) {
		dynamicOffset = BN.max(
			perpMarket.amm.oracleStd,
			perpMarket.amm.markStd
		).divn(perpMarket.pmmDynamicDivisor);
	} else {
		dynamicOffset = 0;
	}

	return {
		tickSize: perpMarket.amm.orderTickSize,
		limitPriceDivisor: perpMarket.pmmLimitPriceDivisor,
		dynamicOffset: dynamicOffset,
	};
}
