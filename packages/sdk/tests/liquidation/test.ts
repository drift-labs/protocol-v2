import { assert } from 'chai';
import {
	BN,
	BASE_PRECISION,
	QUOTE_PRECISION,
	LIQUIDATION_PCT_PRECISION,
	calculateMaxPctToLiquidate,
	calculatePerpIfFee,
	calculateSpotIfFee,
} from '../../src';

describe('calculateMaxPctToLiquidate', () => {
	it('isolated position override returns 100% regardless of graduated schedule', () => {
		const pct = calculateMaxPctToLiquidate(
			new BN(0), // userLastActiveSlot
			new BN(0), // userLiquidationMarginFreed
			new BN(1_000_000).mul(QUOTE_PRECISION), // huge margin shortage
			new BN(0), // slot === lastActiveSlot, no time elapsed
			new BN(0), // initialPctToLiquidate
			new BN(1000), // liquidationDuration
			true // isIsolatedPosition
		);

		assert.isTrue(pct.eq(LIQUIDATION_PCT_PRECISION));
	});

	it('computes slots elapsed unconditionally, even when no margin has been freed yet', () => {
		// userLiquidationMarginFreed === 0: a prior gate on this value would force
		// slotsElapsed to 0 and the whole schedule to be stuck at initialPctToLiquidate.
		const pct = calculateMaxPctToLiquidate(
			new BN(0), // userLastActiveSlot
			new BN(0), // userLiquidationMarginFreed
			new BN(1000).mul(QUOTE_PRECISION), // margin shortage (above the 50 QUOTE_PRECISION floor)
			new BN(100), // slot
			new BN(0), // initialPctToLiquidate
			new BN(1000) // liquidationDuration
		);

		// slotsElapsed = 100, pctFreeable = 100 * 10000 / 1000 = 1000 (10%)
		assert.isTrue(pct.eq(new BN(1000)));
	});
});

describe('calculatePerpIfFee', () => {
	// marginRatio 5%, liquidator fee 0.5%, quote oracle price != 1.0
	const marginRatio = 500;
	const liquidatorFee = 5000;
	const oraclePrice = new BN(100).mul(new BN(1_000_000));
	const quoteOraclePrice = new BN(1_020_000); // 1.02
	const userBaseAssetAmount = new BN(10).mul(BASE_PRECISION);
	const marginShortage = new BN(1).mul(QUOTE_PRECISION);

	it('returns the implied fee when it is below the combined-rate cap', () => {
		const fee = calculatePerpIfFee(
			marginShortage,
			userBaseAssetAmount,
			marginRatio,
			liquidatorFee,
			oraclePrice,
			quoteOraclePrice,
			50_000 // cap well above the implied fee
		);

		assert.equal(fee, 41_819);
	});

	it('clamps to the combined-rate cap when the implied fee exceeds it', () => {
		const fee = calculatePerpIfFee(
			marginShortage,
			userBaseAssetAmount,
			marginRatio,
			liquidatorFee,
			oraclePrice,
			quoteOraclePrice,
			20_000 // cap below the implied fee
		);

		assert.equal(fee, 20_000);
	});
});

describe('calculateSpotIfFee', () => {
	const assetWeight = 8000;
	const liabilityWeight = 12000;
	const assetLiquidationMultiplier = 1_000_000;
	const liabilityLiquidationMultiplier = 1_000_000;
	const liabilityDecimals = 6;
	const liabilityPrice = new BN(1_050_000); // non-1.0 price
	const tokenAmount = new BN(1000).mul(
		new BN(10).pow(new BN(liabilityDecimals))
	);
	const marginShortage = new BN(10).mul(QUOTE_PRECISION);

	it('returns the implied fee when it is below the combined-rate cap', () => {
		const fee = calculateSpotIfFee(
			marginShortage,
			tokenAmount,
			assetWeight,
			assetLiquidationMultiplier,
			liabilityWeight,
			liabilityLiquidationMultiplier,
			liabilityDecimals,
			liabilityPrice,
			400_000 // cap well above the implied fee
		);

		assert.equal(fee, 325_397);
	});

	it('clamps to the combined-rate cap when the implied fee exceeds it', () => {
		const fee = calculateSpotIfFee(
			marginShortage,
			tokenAmount,
			assetWeight,
			assetLiquidationMultiplier,
			liabilityWeight,
			liabilityLiquidationMultiplier,
			liabilityDecimals,
			liabilityPrice,
			100_000 // cap below the implied fee
		);

		assert.equal(fee, 100_000);
	});
});
