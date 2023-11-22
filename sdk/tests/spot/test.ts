import {
	BN,
	ZERO,
	calculateSpotMarketBorrowCapacity,
	SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION,
	calculateSizePremiumLiabilityWeight,
	calculateBorrowRate,
	calculateDepositRate,
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
});
