import {
	BN,
	ZERO,
	calculateSpotMarketBorrowCapacity,
	SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION,
	calculateSizePremiumLiabilityWeight,
	calculateBorrowRate,
	calculateDepositRate,
	calculateWithdrawLimit,
	getTokenValue,
	getStrictTokenValue,
	StrictOraclePrice,
} from '../../src';
import { mockSpotMarkets } from '../dlob/helpers';
import * as _ from 'lodash';

import { assert } from '../../src/assert/assert';

describe('Spot Tests', () => {
	it('size premium via imf factor', () => {
		const maintLiabWgt = new BN(1.1 * 1e4);

		const ans0 = calculateSizePremiumLiabilityWeight(
			new BN(200000 * 1e9),
			ZERO,
			maintLiabWgt,
			new BN(1e4)
		);
		assert(ans0.eq(maintLiabWgt));

		const ans = calculateSizePremiumLiabilityWeight(
			new BN(200000 * 1e9),
			new BN(0.00055 * 1e6),
			maintLiabWgt,
			new BN(1e4)
		);
		assert(ans.eq(new BN('11259')));
		assert(ans.gt(maintLiabWgt));

		const ans2 = calculateSizePremiumLiabilityWeight(
			new BN(10000 * 1e9),
			new BN(0.003 * 1e6),
			maintLiabWgt,
			new BN(1e4)
		);
		assert(ans2.eq(new BN('11800')));
		assert(ans.gt(maintLiabWgt));

		const ans3 = calculateSizePremiumLiabilityWeight(
			new BN(100000 * 1e9),
			new BN(0.003 * 1e6),
			maintLiabWgt,
			new BN(1e4)
		);
		assert(ans3.eq(new BN('18286')));
		assert(ans3.gt(maintLiabWgt));
	});

	it('base borrow capacity', () => {
		const mockSpot = _.cloneDeep(mockSpotMarkets[0]);
		mockSpot.maxBorrowRate = 1000000;
		mockSpot.optimalBorrowRate = 100000;
		mockSpot.optimalUtilization = 700000;

		mockSpot.decimals = 9;
		mockSpot.cumulativeDepositInterest =
			SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION;
		mockSpot.cumulativeBorrowInterest =
			SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION;

		const tokenAmount = 100000;
		// no borrows
		mockSpot.depositBalance = new BN(tokenAmount * 1e9);
		mockSpot.borrowBalance = ZERO;

		// todo, should incorp all other spot market constraints?
		const { remainingCapacity: aboveMaxAmount } =
			calculateSpotMarketBorrowCapacity(mockSpot, new BN(2000000));
		assert(aboveMaxAmount.gt(mockSpot.depositBalance));

		const { remainingCapacity: maxAmount } = calculateSpotMarketBorrowCapacity(
			mockSpot,
			new BN(1000000)
		);
		assert(maxAmount.eq(mockSpot.depositBalance));

		const { remainingCapacity: optAmount } = calculateSpotMarketBorrowCapacity(
			mockSpot,
			new BN(100000)
		);
		const ans = new BN((mockSpot.depositBalance.toNumber() * 7) / 10);
		// console.log('optAmount:', optAmount.toNumber(), ans.toNumber());
		assert(optAmount.eq(ans));

		const { remainingCapacity: betweenOptMaxAmount } =
			calculateSpotMarketBorrowCapacity(mockSpot, new BN(810000));
		// console.log('betweenOptMaxAmount:', betweenOptMaxAmount.toNumber());
		assert(betweenOptMaxAmount.lt(mockSpot.depositBalance));
		assert(betweenOptMaxAmount.gt(ans));
		assert(betweenOptMaxAmount.eq(new BN(93666600000000)));

		const { remainingCapacity: belowOptAmount } =
			calculateSpotMarketBorrowCapacity(mockSpot, new BN(50000));
		// console.log('belowOptAmount:', belowOptAmount.toNumber());
		assert(belowOptAmount.eq(ans.div(new BN(2))));

		const { remainingCapacity: belowOptAmount2 } =
			calculateSpotMarketBorrowCapacity(mockSpot, new BN(24900));
		// console.log('belowOptAmount2:', belowOptAmount2.toNumber());
		assert(belowOptAmount2.lt(ans.div(new BN(4))));
		assert(belowOptAmount2.eq(new BN('17430000000000')));

		const { remainingCapacity: belowOptAmount3 } =
			calculateSpotMarketBorrowCapacity(mockSpot, new BN(1));
		// console.log('belowOptAmount3:', belowOptAmount3.toNumber());
		assert(belowOptAmount3.eq(new BN('700000000'))); //0.7
	});

	it('complex borrow capacity', () => {
		const mockSpot = _.cloneDeep(mockSpotMarkets[0]);
		mockSpot.maxBorrowRate = 1000000;
		mockSpot.optimalBorrowRate = 70000;
		mockSpot.optimalUtilization = 700000;

		mockSpot.decimals = 9;
		mockSpot.cumulativeDepositInterest = new BN(
			1.0154217042 * SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION.toNumber()
		);
		mockSpot.cumulativeBorrowInterest = new BN(
			1.0417153549 * SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION.toNumber()
		);

		mockSpot.depositBalance = new BN(88522.734106451 * 1e9);
		mockSpot.borrowBalance = new BN(7089.91675884 * 1e9);

		// todo, should incorp all other spot market constraints?
		const { remainingCapacity: aboveMaxAmount } =
			calculateSpotMarketBorrowCapacity(mockSpot, new BN(2000000));
		assert(aboveMaxAmount.eq(new BN('111498270939007')));

		const { remainingCapacity: maxAmount } = calculateSpotMarketBorrowCapacity(
			mockSpot,
			new BN(1000000)
		);
		assert(maxAmount.eq(new BN('82502230374168')));
		// console.log('aboveMaxAmount:', aboveMaxAmount.toNumber(), 'maxAmount:', maxAmount.toNumber());
		const { remainingCapacity: optAmount } = calculateSpotMarketBorrowCapacity(
			mockSpot,
			new BN(70000)
		);
		// console.log('optAmount:', optAmount.toNumber());
		assert(optAmount.eq(new BN('55535858716123'))); // ~ 55535

		const { remainingCapacity: betweenOptMaxAmount } =
			calculateSpotMarketBorrowCapacity(mockSpot, new BN(810000));
		// console.log('betweenOptMaxAmount:', betweenOptMaxAmount.toNumber());
		assert(betweenOptMaxAmount.lt(maxAmount));
		assert(betweenOptMaxAmount.eq(new BN(76992910756523)));
		assert(betweenOptMaxAmount.gt(optAmount));

		const { remainingCapacity: belowOptAmount } =
			calculateSpotMarketBorrowCapacity(mockSpot, new BN(50000));
		// console.log('belowOptAmount:', belowOptAmount.toNumber());
		assert(belowOptAmount.eq(new BN('37558277610760')));

		const { remainingCapacity: belowOptAmount2 } =
			calculateSpotMarketBorrowCapacity(mockSpot, new BN(24900));
		// console.log('belowOptAmount2:', belowOptAmount2.toNumber());
		assert(belowOptAmount2.eq(new BN('14996413323529')));

		const { remainingCapacity: belowOptAmount3 } =
			calculateSpotMarketBorrowCapacity(mockSpot, new BN(4900));
		// console.log('belowOptAmount2:', belowOptAmount3.toNumber());
		assert(belowOptAmount3.eq(new BN('0')));

		const { remainingCapacity: belowOptAmount4 } =
			calculateSpotMarketBorrowCapacity(mockSpot, new BN(1));
		// console.log('belowOptAmount3:', belowOptAmount4.toNumber());
		assert(belowOptAmount4.eq(new BN('0')));
	});

	it('borrow rates', () => {
		const mockSpot = _.cloneDeep(mockSpotMarkets[0]);
		mockSpot.maxBorrowRate = 1000000;
		mockSpot.optimalBorrowRate = 70000;
		mockSpot.optimalUtilization = 700000;

		mockSpot.decimals = 9;
		mockSpot.cumulativeDepositInterest = new BN(
			1.0154217042 * SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION.toNumber()
		);
		mockSpot.cumulativeBorrowInterest = new BN(
			1.0417153549 * SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION.toNumber()
		);

		mockSpot.depositBalance = new BN(88522.734106451 * 1e9);
		mockSpot.borrowBalance = new BN(17089.91675884 * 1e9);

		const noDeltad = calculateDepositRate(mockSpot);
		// console.log(noDeltad.toNumber());
		assert(noDeltad.eqn(3922));
		const noDelta = calculateBorrowRate(mockSpot);
		// console.log(noDelta.toNumber());
		assert(noDelta.eqn(19805));

		// manually update deposits
		mockSpot.depositBalance = new BN((88522.734106451 + 9848.12512736) * 1e9);
		const noDeltad2 = calculateDepositRate(mockSpot);
		console.log(noDeltad2.toNumber());
		assert(noDeltad2.eqn(3176));
		const noDelta2 = calculateBorrowRate(mockSpot);
		console.log(noDelta2.toNumber());
		assert(noDelta2.eqn(17822));

		mockSpot.depositBalance = new BN(88522.734106451 * 1e9);
		const addDep1d = calculateDepositRate(mockSpot, new BN(10000 * 1e9));
		// console.log(addDep1d.toNumber());
		assert(addDep1d.eqn(3176)); // went down
		const addDep1 = calculateBorrowRate(mockSpot, new BN(10000 * 1e9));
		// console.log(addDep1.toNumber());
		assert(addDep1.eqn(17822)); // went down

		const addBord1 = calculateDepositRate(mockSpot, new BN(-1000 * 1e9));
		// console.log(addBord1.toNumber());
		assert(addBord1.eqn(4375)); // went up
		const addBor1 = calculateBorrowRate(mockSpot, new BN(-1000 * 1e9));
		// console.log(addBor1.toNumber());
		assert(addBor1.eqn(20918)); // went up
	});

	function buildWithdrawLimitMarket(poolId: number) {
		const mockSpot = _.cloneDeep(mockSpotMarkets[0]);
		mockSpot.decimals = 9;
		mockSpot.cumulativeDepositInterest = new BN(10).pow(new BN(10));
		mockSpot.cumulativeBorrowInterest = new BN(10).pow(new BN(10));
		mockSpot.depositBalance = new BN(100000);
		mockSpot.borrowBalance = new BN(10000);
		mockSpot.depositTokenTwap = new BN(70000);
		mockSpot.borrowTokenTwap = new BN(10000);
		mockSpot.lastTwapTs = new BN(0);
		mockSpot.optimalUtilization = 900000;
		mockSpot.utilizationTwap = new BN(0);
		mockSpot.withdrawGuardThreshold = new BN(0);
		mockSpot.maxTokenBorrowsFraction = 0;
		mockSpot.poolId = poolId;
		return mockSpot;
	}

	it('withdraw limit (main pool) uses lesserDepositAmount with /3, /5, /14', () => {
		// depositTokenTwapLive works out to 85000 (< the 100000 raw deposit
		// amount), so this pins both the divisors and that the twap-min'd
		// amount -- not the raw deposit amount -- feeds the first max() term
		const mockSpot = buildWithdrawLimitMarket(0);
		const now = new BN(43200); // half of the 24h twap window since lastTwapTs

		const result = calculateWithdrawLimit(mockSpot, now);
		assert(result.maxBorrowAmount.eq(new BN(28333)));
		assert(result.borrowLimit.eq(new BN(18333)));
	});

	it('withdraw limit (isolated pool) uses lesserDepositAmount with /2, /3, /20', () => {
		const mockSpot = buildWithdrawLimitMarket(1);
		const now = new BN(43200);

		const result = calculateWithdrawLimit(mockSpot, now);
		assert(result.maxBorrowAmount.eq(new BN(42500)));
		assert(result.borrowLimit.eq(new BN(32500)));
	});

	it('getTokenValue floors (rounds toward -infinity) for a negative product', () => {
		// -3 * 5 = -15; -15/10 truncates to -1 but floors to -2
		const value = getTokenValue(new BN(-3), 1, { price: new BN(5) });
		assert(value.eq(new BN(-2)));
	});

	it('getStrictTokenValue floors (rounds toward -infinity) for a negative product', () => {
		const strictPrice = new StrictOraclePrice(new BN(5), new BN(5));
		const value = getStrictTokenValue(new BN(-3), 1, strictPrice);
		assert(value.eq(new BN(-2)));
	});
});
