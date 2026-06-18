import { isVariant, PerpMarketAccount, SpotMarketAccount } from '../types';

export function getPerpMarketTierNumber(perpMarket: PerpMarketAccount): number {
	if (isVariant(perpMarket.contractTier, 'a')) {
		return 0;
	} else if (isVariant(perpMarket.contractTier, 'b')) {
		return 1;
	} else if (isVariant(perpMarket.contractTier, 'c')) {
		return 2;
	} else if (isVariant(perpMarket.contractTier, 'speculative')) {
		return 3;
	} else if (isVariant(perpMarket.contractTier, 'highlySpeculative')) {
		return 4;
	} else {
		return 5;
	}
}

export function getSpotMarketTierNumber(spotMarket: SpotMarketAccount): number {
	if (isVariant(spotMarket.assetTier, 'collateral')) {
		return 0;
	} else if (isVariant(spotMarket.assetTier, 'protected')) {
		return 1;
	} else if (isVariant(spotMarket.assetTier, 'cross')) {
		return 2;
	} else if (isVariant(spotMarket.assetTier, 'isolated')) {
		return 3;
	} else if (isVariant(spotMarket.assetTier, 'unlisted')) {
		return 4;
	} else {
		return 5;
	}
}

export function perpTierIsAsSafeAs(
	perpTier: number,
	otherPerpTier: number,
	otherSpotTier: number
): boolean {
	const asSafeAsPerp = perpTier <= otherPerpTier;
	const asSafeAsSpot =
		otherSpotTier === 4 || (otherSpotTier >= 2 && perpTier <= 2);
	return asSafeAsSpot && asSafeAsPerp;
}
