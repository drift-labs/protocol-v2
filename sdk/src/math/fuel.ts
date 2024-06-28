import { BN } from '@coral-xyz/anchor';
import { SpotMarketAccount, PerpMarketAccount } from '..';
import {
	QUOTE_PRECISION,
	ZERO,
	FUEL_WINDOW,
} from '../constants/numericConstants';

export function calculateSpotFuelBonus(
	spotMarket: SpotMarketAccount,
	signedTokenValue: BN,
	fuelBonusNumerator: BN
): BN {
	let result: BN;

	if (signedTokenValue.abs().lt(new BN(1))) {
		result = ZERO;
	} else if (signedTokenValue.gt(new BN(0))) {
		result = signedTokenValue
			.abs()
			.mul(fuelBonusNumerator)
			.mul(new BN(spotMarket.fuelBoostDeposits))
			.div(FUEL_WINDOW)
			.div(QUOTE_PRECISION.div(new BN(10)));
	} else {
		result = signedTokenValue
			.abs()
			.mul(fuelBonusNumerator)
			.mul(new BN(spotMarket.fuelBoostBorrows))
			.div(FUEL_WINDOW)
			.div(QUOTE_PRECISION.div(new BN(10)));
	}

	return result;
}

export function calculatePerpFuelBonus(
	perpMarket: PerpMarketAccount,
	baseAssetValue: BN,
	fuelBonusNumerator: BN
): BN {
	let result: BN;

	if (baseAssetValue.abs().lte(QUOTE_PRECISION)) {
		result = new BN(0);
	} else {
		result = baseAssetValue
			.abs()
			.mul(fuelBonusNumerator)
			.mul(new BN(perpMarket.fuelBoostPosition))
			.div(FUEL_WINDOW)
			.div(QUOTE_PRECISION.div(new BN(10)));
	}

	return result;
}
