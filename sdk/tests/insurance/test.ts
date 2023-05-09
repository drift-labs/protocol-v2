import { BN, ZERO, timeRemainingUntilUpdate, ONE } from '../../src';
// import { mockPerpMarkets } from '../dlob/helpers';

import { assert } from '../../src/assert/assert';

describe('Insurance Tests', () => {
	it('time remaining updates', () => {
		const now = new BN(1683576852);
		const lastUpdate = new BN(1683576000);
		const period = new BN(3600); //hourly

		let tr;
		// console.log(now.sub(lastUpdate).toString());

		tr = timeRemainingUntilUpdate(now, lastUpdate, period);
		// console.log(tr.toString());
		assert(tr.eq(new BN('2748')));

		tr = timeRemainingUntilUpdate(now, lastUpdate.sub(period), period);
		// console.log(tr.toString());
		assert(tr.eq(ZERO));

		const tooLateUpdate = lastUpdate.sub(period.div(new BN(3)).add(ONE));
		tr = timeRemainingUntilUpdate(
			tooLateUpdate.add(ONE),
			tooLateUpdate,
			period
		);
		// console.log(tr.toString());
		assert(tr.eq(new BN('4800')));

		tr = timeRemainingUntilUpdate(now, lastUpdate.add(ONE), period);
		// console.log(tr.toString());
		assert(tr.eq(new BN('2748')));

		tr = timeRemainingUntilUpdate(now, lastUpdate.sub(ONE), period);
		// console.log(tr.toString());
		assert(tr.eq(new BN('2748')));
	});
});
