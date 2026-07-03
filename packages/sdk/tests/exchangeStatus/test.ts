import {
	depositPaused,
	withdrawPaused,
	ExchangeStatus,
	SpotOperation,
} from '../../src';
import { mockStateAccount, mockSpotMarkets } from '../dlob/helpers';
import * as _ from 'lodash';

import { assert } from '../../src/assert/assert';

describe('Exchange Status Tests', () => {
	it('depositPaused mirrors the global ExchangeStatus bit and the per-market SpotOperation bit', () => {
		const state = _.cloneDeep(mockStateAccount);
		const spotMarket = _.cloneDeep(mockSpotMarkets[0]);

		assert(depositPaused(state, spotMarket) === false);

		state.exchangeStatus = ExchangeStatus.DEPOSIT_PAUSED;
		assert(depositPaused(state, spotMarket) === true);

		state.exchangeStatus = ExchangeStatus.ACTIVE;
		spotMarket.pausedOperations = SpotOperation.DEPOSIT;
		assert(depositPaused(state, spotMarket) === true);
	});

	it('withdrawPaused mirrors the global ExchangeStatus bit and the per-market SpotOperation bit', () => {
		const state = _.cloneDeep(mockStateAccount);
		const spotMarket = _.cloneDeep(mockSpotMarkets[0]);

		assert(withdrawPaused(state, spotMarket) === false);

		state.exchangeStatus = ExchangeStatus.WITHDRAW_PAUSED;
		assert(withdrawPaused(state, spotMarket) === true);

		state.exchangeStatus = ExchangeStatus.ACTIVE;
		spotMarket.pausedOperations = SpotOperation.WITHDRAW;
		assert(withdrawPaused(state, spotMarket) === true);

		// unrelated pause bits must not trip either predicate
		spotMarket.pausedOperations = SpotOperation.FILL;
		assert(withdrawPaused(state, spotMarket) === false);
		assert(depositPaused(state, spotMarket) === false);
	});
});
