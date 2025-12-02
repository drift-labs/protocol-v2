import { assert } from 'chai';
import _ from 'lodash';
import { SpotBalanceType, PositionFlag } from '../../src/types';
import {
	BASE_PRECISION,
	QUOTE_PRECISION,
	SPOT_MARKET_BALANCE_PRECISION,
} from '../../src/constants/numericConstants';
import { BN } from '../../src';
import { mockPerpMarkets, mockSpotMarkets } from '../dlob/helpers';
import {
	mockUserAccount as baseMockUserAccount,
	makeMockUser,
} from './helpers';

// Helper for easy async test creation
async function makeUserWithAccount(
	account,
	perpOraclePrices: number[],
	spotOraclePrices: number[]
) {
	const user = await makeMockUser(
		_.cloneDeep(mockPerpMarkets),
		_.cloneDeep(mockSpotMarkets),
		account,
		perpOraclePrices,
		spotOraclePrices
	);
	return user;
}

describe('User.getLiquidationStatuses', () => {
	it('isolated account: healthy, then becomes liquidatable on IM', async () => {
		const isoAccount = _.cloneDeep(baseMockUserAccount);

		// put full isolated perp position in the first market (marketIndex 0 = KEN)
		isoAccount.perpPositions[0].baseAssetAmount = new BN(100).mul(
			BASE_PRECISION
		);
		isoAccount.perpPositions[0].quoteAssetAmount = new BN(100).mul(
			QUOTE_PRECISION
		);
		isoAccount.perpPositions[0].positionFlag = PositionFlag.IsolatedPosition;
		isoAccount.perpPositions[0].isolatedPositionScaledBalance = new BN(
			1000
		).mul(SPOT_MARKET_BALANCE_PRECISION);

		// enough deposit for margin
		isoAccount.spotPositions[0].marketIndex = 0;
		isoAccount.spotPositions[0].balanceType = SpotBalanceType.DEPOSIT;
		isoAccount.spotPositions[0].scaledBalance = new BN(10000).mul(
			SPOT_MARKET_BALANCE_PRECISION
		);

		const user = await makeUserWithAccount(
			isoAccount,
			[100, 1, 1, 1, 1, 1, 1, 1],
			[1, 100, 1, 1, 1, 1, 1, 1]
		);

		let statuses = user.getLiquidationStatuses();
		// Isolated position is not liquidatable
		const cross1 = statuses.get('cross');
		const iso0_1 = statuses.get(0);
		assert.equal(iso0_1?.canBeLiquidated, false);
		assert.equal(cross1?.canBeLiquidated, false);

		// Lower spot deposit to make isolated margin not enough for IM (but still above MM)
		isoAccount.perpPositions[0].isolatedPositionScaledBalance = new BN(1).mul(
			SPOT_MARKET_BALANCE_PRECISION
		);

		const underfundedUser = await makeUserWithAccount(
			isoAccount,
			[100, 1, 1, 1, 1, 1, 1, 1],
			[1, 100, 1, 1, 1, 1, 1, 1]
		);

		statuses = underfundedUser.getLiquidationStatuses();
		const cross2 = statuses.get('cross');
		const iso0_2 = statuses.get(0);
		assert.equal(iso0_2?.canBeLiquidated, true);
		assert.equal(cross2?.canBeLiquidated, false);
	});

	it('isolated position becomes fully bankrupt (both margin requirements breached)', async () => {
		const bankruptAccount = _.cloneDeep(baseMockUserAccount);

		bankruptAccount.perpPositions[0].baseAssetAmount = new BN(100).mul(
			BASE_PRECISION
		);
		bankruptAccount.perpPositions[0].quoteAssetAmount = new BN(-14000).mul(
			QUOTE_PRECISION
		);
		bankruptAccount.perpPositions[0].positionFlag =
			PositionFlag.IsolatedPosition;
		bankruptAccount.perpPositions[0].isolatedPositionScaledBalance = new BN(
			100
		).mul(SPOT_MARKET_BALANCE_PRECISION);

		bankruptAccount.spotPositions[0].marketIndex = 0;
		bankruptAccount.spotPositions[0].balanceType = SpotBalanceType.DEPOSIT;
		bankruptAccount.spotPositions[0].scaledBalance = new BN(1000).mul(
			SPOT_MARKET_BALANCE_PRECISION
		);

		const user = await makeUserWithAccount(
			bankruptAccount,
			[100, 1, 1, 1, 1, 1, 1, 1],
			[1, 100, 1, 1, 1, 1, 1, 1]
		);

		const statuses = user.getLiquidationStatuses();
		const cross = statuses.get('cross');
		const iso0 = statuses.get(0);
		assert.equal(
			iso0?.canBeLiquidated,
			true,
			'isolated position 0 should be liquidatable'
		);
		// Breaches maintenance requirement if MR > total collateral
		assert.ok(iso0 && iso0.marginRequirement.gt(iso0.totalCollateral));
		assert.equal(
			cross?.canBeLiquidated,
			false,
			'cross margin should not be liquidatable'
		);
	});
});
