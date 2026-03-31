import {
	BN,
	BASE_PRECISION,
	QUOTE_PRECISION,
	SPOT_MARKET_BALANCE_PRECISION,
	PositionFlag,
	SpotBalanceType,
	ZERO,
} from '../../src';
import { assert } from '../../src/assert/assert';
import { mockPerpMarkets, mockSpotMarkets } from '../dlob/helpers';
import {
	mockUserAccount,
	makeMockUser as makeMockUserFromHelpers,
} from './helpers';
import * as _ from 'lodash';

const DEFAULT_ORACLES = [1, 1, 1, 1, 1, 1, 1, 1];

describe('User margin calculations', () => {
	describe('cross collateral', () => {
		it('getTotalCollateral for USDC-only account matches expected value', async () => {
			const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
			const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);
			const myMockUserAccount = _.cloneDeep(mockUserAccount);

			myMockUserAccount.spotPositions[0].marketIndex = 0;
			myMockUserAccount.spotPositions[0].balanceType = SpotBalanceType.DEPOSIT;
			myMockUserAccount.spotPositions[0].scaledBalance = new BN(10_000).mul(
				SPOT_MARKET_BALANCE_PRECISION
			);

			const mockUser = await makeMockUserFromHelpers(
				myMockPerpMarkets,
				myMockSpotMarkets,
				myMockUserAccount,
				DEFAULT_ORACLES,
				DEFAULT_ORACLES
			);

			const expectedValue = new BN(10_000).mul(QUOTE_PRECISION);
			assert(mockUser.getTotalCollateral('Initial').eq(expectedValue));
			assert(mockUser.getTotalCollateral('Maintenance').eq(expectedValue));
		});

		it('getInitialMarginRequirement is greater than or equal to maintenance', async () => {
			const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
			const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);
			const myMockUserAccount = _.cloneDeep(mockUserAccount);

			myMockUserAccount.spotPositions[0].marketIndex = 0;
			myMockUserAccount.spotPositions[0].balanceType = SpotBalanceType.DEPOSIT;
			myMockUserAccount.spotPositions[0].scaledBalance = new BN(200).mul(
				SPOT_MARKET_BALANCE_PRECISION
			);

			myMockUserAccount.perpPositions[0].marketIndex = 0;
			myMockUserAccount.perpPositions[0].baseAssetAmount = BASE_PRECISION;
			myMockUserAccount.perpPositions[0].quoteAssetAmount =
				QUOTE_PRECISION.neg();
			myMockUserAccount.perpPositions[0].quoteEntryAmount =
				QUOTE_PRECISION.neg();
			myMockUserAccount.perpPositions[0].quoteBreakEvenAmount =
				QUOTE_PRECISION.neg();

			const mockUser = await makeMockUserFromHelpers(
				myMockPerpMarkets,
				myMockSpotMarkets,
				myMockUserAccount,
				DEFAULT_ORACLES,
				DEFAULT_ORACLES
			);

			const initialMarginRequirement = mockUser.getInitialMarginRequirement();
			const maintenanceMarginRequirement =
				mockUser.getMaintenanceMarginRequirement();
			assert(initialMarginRequirement.gte(maintenanceMarginRequirement));
			assert(maintenanceMarginRequirement.gt(ZERO));
		});

		it('getFreeCollateral is positive for solvent cross account', async () => {
			const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
			const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);
			const myMockUserAccount = _.cloneDeep(mockUserAccount);

			myMockUserAccount.spotPositions[0].marketIndex = 0;
			myMockUserAccount.spotPositions[0].balanceType = SpotBalanceType.DEPOSIT;
			myMockUserAccount.spotPositions[0].scaledBalance = new BN(10_000).mul(
				SPOT_MARKET_BALANCE_PRECISION
			);

			const mockUser = await makeMockUserFromHelpers(
				myMockPerpMarkets,
				myMockSpotMarkets,
				myMockUserAccount,
				DEFAULT_ORACLES,
				DEFAULT_ORACLES
			);

			assert(mockUser.getFreeCollateral('Initial').gt(ZERO));
		});

		it('getFreeCollateral is zero for undercollateralized account', async () => {
			const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
			const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);
			const myMockUserAccount = _.cloneDeep(mockUserAccount);

			myMockUserAccount.perpPositions[0].marketIndex = 0;
			myMockUserAccount.perpPositions[0].baseAssetAmount = new BN(20).mul(
				BASE_PRECISION
			);
			myMockUserAccount.perpPositions[0].quoteAssetAmount = new BN(10)
				.mul(QUOTE_PRECISION)
				.neg();

			const mockUser = await makeMockUserFromHelpers(
				myMockPerpMarkets,
				myMockSpotMarkets,
				myMockUserAccount,
				DEFAULT_ORACLES,
				DEFAULT_ORACLES
			);

			assert(mockUser.getFreeCollateral('Initial').eq(ZERO));
		});
	});

	describe('isolated collateral', () => {
		it('cross total collateral excludes isolated deposits', async () => {
			const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
			const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);
			const myMockUserAccount = _.cloneDeep(mockUserAccount);

			myMockUserAccount.spotPositions[0].marketIndex = 0;
			myMockUserAccount.spotPositions[0].balanceType = SpotBalanceType.DEPOSIT;
			myMockUserAccount.spotPositions[0].scaledBalance = new BN(200).mul(
				SPOT_MARKET_BALANCE_PRECISION
			);

			myMockUserAccount.perpPositions[0].marketIndex = 0;
			myMockUserAccount.perpPositions[0].positionFlag =
				PositionFlag.IsolatedPosition;
			myMockUserAccount.perpPositions[0].baseAssetAmount = BASE_PRECISION;
			myMockUserAccount.perpPositions[0].quoteAssetAmount =
				QUOTE_PRECISION.neg();
			myMockUserAccount.perpPositions[0].quoteEntryAmount =
				QUOTE_PRECISION.neg();
			myMockUserAccount.perpPositions[0].quoteBreakEvenAmount =
				QUOTE_PRECISION.neg();
			myMockUserAccount.perpPositions[0].isolatedPositionScaledBalance = new BN(
				100
			).mul(SPOT_MARKET_BALANCE_PRECISION);

			const mockUser = await makeMockUserFromHelpers(
				myMockPerpMarkets,
				myMockSpotMarkets,
				myMockUserAccount,
				DEFAULT_ORACLES,
				DEFAULT_ORACLES
			);

			const crossTotalCollateral = mockUser.getTotalCollateral('Initial');
			assert(crossTotalCollateral.eq(new BN(200).mul(QUOTE_PRECISION)));
		});

		it('getTotalCollateral with perpMarketIndex returns isolated collateral bucket', async () => {
			const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
			const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);
			const myMockUserAccount = _.cloneDeep(mockUserAccount);

			myMockUserAccount.perpPositions[0].marketIndex = 0;
			myMockUserAccount.perpPositions[0].positionFlag =
				PositionFlag.IsolatedPosition;
			myMockUserAccount.perpPositions[0].baseAssetAmount = BASE_PRECISION;
			myMockUserAccount.perpPositions[0].quoteAssetAmount =
				QUOTE_PRECISION.neg();
			myMockUserAccount.perpPositions[0].quoteEntryAmount =
				QUOTE_PRECISION.neg();
			myMockUserAccount.perpPositions[0].quoteBreakEvenAmount =
				QUOTE_PRECISION.neg();
			myMockUserAccount.perpPositions[0].isolatedPositionScaledBalance = new BN(
				100
			).mul(SPOT_MARKET_BALANCE_PRECISION);

			const mockUser = await makeMockUserFromHelpers(
				myMockPerpMarkets,
				myMockSpotMarkets,
				myMockUserAccount,
				DEFAULT_ORACLES,
				DEFAULT_ORACLES
			);

			const isolatedCollateral = mockUser.getTotalCollateral(
				'Maintenance',
				false,
				true,
				undefined,
				0
			);
			assert(isolatedCollateral.eq(new BN(100).mul(QUOTE_PRECISION)));
		});

		it('getFreeCollateral with perpMarketIndex reads isolated free collateral', async () => {
			const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
			const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);
			const myMockUserAccount = _.cloneDeep(mockUserAccount);

			myMockUserAccount.perpPositions[0].marketIndex = 0;
			myMockUserAccount.perpPositions[0].positionFlag =
				PositionFlag.IsolatedPosition;
			myMockUserAccount.perpPositions[0].baseAssetAmount = BASE_PRECISION;
			myMockUserAccount.perpPositions[0].quoteAssetAmount =
				QUOTE_PRECISION.neg();
			myMockUserAccount.perpPositions[0].quoteEntryAmount =
				QUOTE_PRECISION.neg();
			myMockUserAccount.perpPositions[0].quoteBreakEvenAmount =
				QUOTE_PRECISION.neg();
			myMockUserAccount.perpPositions[0].isolatedPositionScaledBalance = new BN(
				100
			).mul(SPOT_MARKET_BALANCE_PRECISION);

			const mockUser = await makeMockUserFromHelpers(
				myMockPerpMarkets,
				myMockSpotMarkets,
				myMockUserAccount,
				DEFAULT_ORACLES,
				DEFAULT_ORACLES
			);

			assert(mockUser.getFreeCollateral('Initial', false, 0).gt(ZERO));
			assert(mockUser.getFreeCollateral('Initial', false, 5).eq(ZERO));
		});
	});

	describe('liquidationPrice', () => {
		it('cross liquidationPrice returns a valid value for active position', async () => {
			const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
			const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);
			const myMockUserAccount = _.cloneDeep(mockUserAccount);
			myMockPerpMarkets[0].amm.orderStepSize = BASE_PRECISION;

			myMockUserAccount.spotPositions[0].marketIndex = 0;
			myMockUserAccount.spotPositions[0].balanceType = SpotBalanceType.DEPOSIT;
			myMockUserAccount.spotPositions[0].scaledBalance = new BN(2).mul(
				SPOT_MARKET_BALANCE_PRECISION
			);

			myMockUserAccount.perpPositions[0].marketIndex = 0;
			myMockUserAccount.perpPositions[0].baseAssetAmount = new BN(10).mul(
				BASE_PRECISION
			);
			myMockUserAccount.perpPositions[0].quoteAssetAmount = new BN(10)
				.mul(QUOTE_PRECISION)
				.neg();
			myMockUserAccount.perpPositions[0].quoteEntryAmount = new BN(10)
				.mul(QUOTE_PRECISION)
				.neg();
			myMockUserAccount.perpPositions[0].quoteBreakEvenAmount = new BN(10)
				.mul(QUOTE_PRECISION)
				.neg();

			const mockUser = await makeMockUserFromHelpers(
				myMockPerpMarkets,
				myMockSpotMarkets,
				myMockUserAccount,
				DEFAULT_ORACLES,
				DEFAULT_ORACLES
			);

			const liqPrice = mockUser.liquidationPrice(0);
			assert(liqPrice.gte(ZERO));
			assert(!liqPrice.eq(new BN(-1)));
		});

		it('isolated liquidationPrice returns a valid value for isolated position', async () => {
			const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
			const myMockSpotMarkets = _.cloneDeep(mockSpotMarkets);
			const myMockUserAccount = _.cloneDeep(mockUserAccount);
			myMockPerpMarkets[0].amm.orderStepSize = BASE_PRECISION;

			myMockUserAccount.perpPositions[0].marketIndex = 0;
			myMockUserAccount.perpPositions[0].positionFlag =
				PositionFlag.IsolatedPosition;
			myMockUserAccount.perpPositions[0].baseAssetAmount = new BN(10).mul(
				BASE_PRECISION
			);
			myMockUserAccount.perpPositions[0].quoteAssetAmount = new BN(10)
				.mul(QUOTE_PRECISION)
				.neg();
			myMockUserAccount.perpPositions[0].quoteEntryAmount = new BN(10)
				.mul(QUOTE_PRECISION)
				.neg();
			myMockUserAccount.perpPositions[0].quoteBreakEvenAmount = new BN(10)
				.mul(QUOTE_PRECISION)
				.neg();
			myMockUserAccount.perpPositions[0].isolatedPositionScaledBalance = new BN(
				2
			).mul(SPOT_MARKET_BALANCE_PRECISION);

			const mockUser = await makeMockUserFromHelpers(
				myMockPerpMarkets,
				myMockSpotMarkets,
				myMockUserAccount,
				DEFAULT_ORACLES,
				DEFAULT_ORACLES
			);

			const liqPrice = mockUser.liquidationPrice(
				0,
				ZERO,
				ZERO,
				'Maintenance',
				false,
				ZERO,
				false,
				'Isolated'
			);
			assert(liqPrice.gte(ZERO));
			assert(!liqPrice.eq(new BN(-1)));
		});
	});
});
