import { calculateNetUserPnl } from './market';

import {
	PerpMarketAccount,
	SpotMarketAccount,
	SpotBalanceType,
	ConstituentAccount,
	CacheInfo,
	getSignedTokenAmount,
	PRICE_PRECISION,
} from '..';
import { OraclePriceData } from '.././oracles/types';
import { BN } from '@coral-xyz/anchor';
import { getTokenAmount } from './spotBalance';

export function getLpPoolNAVSpotComponent(
	constituent: ConstituentAccount,
	spotMarket: SpotMarketAccount,
	oraclePriceData: OraclePriceData
): BN {
	const tokenPrecision = new BN(Math.pow(10, spotMarket.decimals));

	return constituent.tokenBalance
		.add(
			getSignedTokenAmount(
				getTokenAmount(
					constituent.spotBalance.scaledBalance,
					spotMarket,
					constituent.spotBalance.balanceType
				),
				constituent.spotBalance.balanceType
			)
		)
		.mul(oraclePriceData.price)
		.div(PRICE_PRECISION)
		.div(tokenPrecision);
}

export function getLpPoolNAVPerpComponent(
	ammCacheInfo: CacheInfo,
	perpMarket: PerpMarketAccount,
	spotMarket: SpotMarketAccount,
	oraclePriceData: OraclePriceData
): BN {
	const netUserPnl = calculateNetUserPnl(perpMarket, oraclePriceData);

	const pnlPool = getTokenAmount(
		perpMarket.pnlPool.scaledBalance,
		spotMarket,
		SpotBalanceType.DEPOSIT
	);
	const feePool = getTokenAmount(
		perpMarket.amm.feePool.scaledBalance,
		spotMarket,
		SpotBalanceType.DEPOSIT
	);

	const currentNetPnlPoolTokenAmount = pnlPool.add(feePool).sub(netUserPnl);

	const perpPerformanceDelta = currentNetPnlPoolTokenAmount.sub(
		ammCacheInfo.lastNetPnlPoolTokenAmount
	);

	return perpPerformanceDelta;
}
