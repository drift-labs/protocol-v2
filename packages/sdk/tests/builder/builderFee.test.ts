import { BN, QUOTE_PRECISION, calculateBuilderFee } from '../../src';
import { assert } from '../../src/assert/assert';

// Pins the exact denominator/rounding from
// `programs/velocity/src/math/fees.rs`:
//   builder_fee = quote_asset_amount * builder_fee_tenth_bps / 100_000
describe('calculateBuilderFee', () => {
	it('matches the program formula for a round tenth-bps value', () => {
		const quoteAssetAmount = new BN(1_000).mul(QUOTE_PRECISION);
		const builderFeeTenthBps = 10; // 10 tenth-bps == 1 bp == 0.01%

		const builderFee = calculateBuilderFee(
			quoteAssetAmount,
			builderFeeTenthBps
		);

		// 1000 * 1e6 * 10 / 100_000 = 100_000 (= 0.1 * 1e6, i.e. $0.10)
		assert(builderFee.eq(new BN(100_000)));
	});

	it('floors (integer division), matching safe_div', () => {
		// quote * bps not evenly divisible by 100_000
		const quoteAssetAmount = new BN(333);
		const builderFeeTenthBps = 7;

		const builderFee = calculateBuilderFee(
			quoteAssetAmount,
			builderFeeTenthBps
		);

		// 333 * 7 = 2331; 2331 / 100_000 = 0 (floored)
		assert(builderFee.eq(new BN(0)));
	});

	it('scales linearly with quoteAssetAmount', () => {
		const builderFeeTenthBps = 250; // 25 bps
		const small = calculateBuilderFee(new BN(1_000_000), builderFeeTenthBps);
		const large = calculateBuilderFee(new BN(10_000_000), builderFeeTenthBps);

		assert(large.eq(small.muln(10)));
	});
});
