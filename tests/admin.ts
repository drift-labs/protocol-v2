import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import BN from 'bn.js';
import { assert } from 'chai';

import {
	Admin,
	MARK_PRICE_PRECISION,
	FeeStructure,
	OracleGuardRails,
} from '../sdk/src';
import { OracleSource } from '../sdk';

import { mockOracle, mockUSDCMint } from './testHelpers';
import { PublicKey } from '@solana/web3.js';
import { Markets } from '../sdk/src/constants/markets';

describe('admin', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;

	let usdcMint;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);

		clearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId
		);

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();
	});

	it('Update Margin Ratio', async () => {
		const marginRatioInitial = new BN(1);
		const marginRatioPartial = new BN(1);
		const marginRatioMaintenance = new BN(1);

		await clearingHouse.updateMarginRatio(
			marginRatioInitial,
			marginRatioPartial,
			marginRatioMaintenance
		);

		const state = clearingHouse.getStateAccount();

		assert(state.marginRatioInitial.eq(marginRatioInitial));
		assert(state.marginRatioPartial.eq(marginRatioPartial));
		assert(state.marginRatioMaintenance.eq(marginRatioMaintenance));
	});

	it('Update Partial Liquidation Close Percentages', async () => {
		const numerator = new BN(1);
		const denominator = new BN(10);

		await clearingHouse.updatePartialLiquidationClosePercentage(
			numerator,
			denominator
		);

		const state = clearingHouse.getStateAccount();

		assert(state.partialLiquidationClosePercentageNumerator.eq(numerator));
		assert(state.partialLiquidationClosePercentageDenominator.eq(denominator));
	});

	it('Update Partial Liquidation Penalty Percentages', async () => {
		const numerator = new BN(1);
		const denominator = new BN(10);

		await clearingHouse.updatePartialLiquidationPenaltyPercentage(
			numerator,
			denominator
		);

		const state = clearingHouse.getStateAccount();

		assert(state.partialLiquidationPenaltyPercentageNumerator.eq(numerator));
		assert(
			state.partialLiquidationPenaltyPercentageDenominator.eq(denominator)
		);
	});

	it('Update Full Liquidation Penalty Percentages', async () => {
		const numerator = new BN(1);
		const denominator = new BN(10);

		await clearingHouse.updateFullLiquidationPenaltyPercentage(
			numerator,
			denominator
		);

		const state = clearingHouse.getStateAccount();

		assert(state.fullLiquidationPenaltyPercentageNumerator.eq(numerator));
		assert(state.fullLiquidationPenaltyPercentageDenominator.eq(denominator));
	});

	it('Update Partial Liquidation Share Denominator', async () => {
		const denominator = new BN(10);

		await clearingHouse.updatePartialLiquidationShareDenominator(denominator);

		const state = clearingHouse.getStateAccount();

		assert(state.partialLiquidationLiquidatorShareDenominator.eq(denominator));
	});

	it('Update Full Liquidation Share Denominator', async () => {
		const denominator = new BN(10);

		await clearingHouse.updateFullLiquidationShareDenominator(denominator);

		const state = clearingHouse.getStateAccount();

		assert(state.fullLiquidationLiquidatorShareDenominator.eq(denominator));
	});

	it('Update fee', async () => {
		const newFeeStructure: FeeStructure = {
			feeNumerator: new BN(10),
			feeDenominator: new BN(10),
			discountTokenTiers: {
				firstTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
				secondTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
				thirdTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
				fourthTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
			},
			referralDiscount: {
				referrerRewardNumerator: new BN(1),
				referrerRewardDenominator: new BN(1),
				refereeDiscountNumerator: new BN(1),
				refereeDiscountDenominator: new BN(1),
			},
		};

		await clearingHouse.updateFee(newFeeStructure);

		const state = clearingHouse.getStateAccount();

		assert(
			JSON.stringify(newFeeStructure) === JSON.stringify(state.feeStructure)
		);
	});

	it('Update oracle guard rails', async () => {
		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOracleDivergenceNumerator: new BN(1),
				markOracleDivergenceDenominator: new BN(1),
			},
			validity: {
				slotsBeforeStale: new BN(1),
				confidenceIntervalMaxSize: new BN(1),
				tooVolatileRatio: new BN(1),
			},
			useForLiquidations: false,
		};

		await clearingHouse.updateOracleGuardRails(oracleGuardRails);

		const state = clearingHouse.getStateAccount();

		assert(
			JSON.stringify(oracleGuardRails) ===
				JSON.stringify(state.oracleGuardRails)
		);
	});

	it('Update protocol mint', async () => {
		const mint = new PublicKey('2fvh6hkCYfpNqke9N48x6HcrW92uZVU3QSiXZX4A5L27');

		await clearingHouse.updateDiscountMint(mint);

		const state = clearingHouse.getStateAccount();

		assert(state.discountMint.equals(mint));
	});

	it('Update max deposit', async () => {
		const maxDeposit = new BN(10);

		await clearingHouse.updateMaxDeposit(maxDeposit);

		const state = clearingHouse.getStateAccount();

		assert(state.maxDeposit.eq(maxDeposit));
	});

	it('Update market oracle', async () => {
		const solUsd = await mockOracle(1);
		const periodicity = new BN(60 * 60); // 1 HOUR
		const mantissaSqrtScale = new BN(
			Math.sqrt(MARK_PRICE_PRECISION.toNumber())
		);
		const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
			mantissaSqrtScale
		);
		const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
			mantissaSqrtScale
		);

		await clearingHouse.initializeMarket(
			Markets[0].marketIndex,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		const newOracle = PublicKey.default;
		const newOracleSource = OracleSource.SWITCHBOARD;

		await clearingHouse.updateMarketOracle(
			Markets[0].marketIndex,
			newOracle,
			newOracleSource
		);

		const market =
			clearingHouse.getMarketsAccount().markets[
				Markets[0].marketIndex.toNumber()
			];
		assert(market.amm.oracle.equals(PublicKey.default));
		assert(
			JSON.stringify(market.amm.oracleSource) ===
				JSON.stringify(newOracleSource)
		);
	});

	it('Update market minimum trade size', async () => {
		const minimumTradeSize = new BN(1);

		await clearingHouse.updateMarketMinimumTradeSize(
			Markets[0].marketIndex,
			minimumTradeSize
		);

		const market =
			clearingHouse.getMarketsAccount().markets[
				Markets[0].marketIndex.toNumber()
			];
		assert(market.amm.minimumTradeSize.eq(minimumTradeSize));
	});

	it('Pause funding', async () => {
		await clearingHouse.updateFundingPaused(true);
		const state = clearingHouse.getStateAccount();
		assert(state.fundingPaused);
	});

	it('Disable admin controls prices', async () => {
		let state = clearingHouse.getStateAccount();
		assert(state.adminControlsPrices);
		await clearingHouse.disableAdminControlsPrices();
		state = clearingHouse.getStateAccount();
		assert(!state.adminControlsPrices);
	});

	it('Update admin', async () => {
		const newAdminKey = PublicKey.default;

		await clearingHouse.updateAdmin(newAdminKey);

		const state = clearingHouse.getStateAccount();

		assert(state.admin.equals(newAdminKey));
	});

	after(async () => {
		await clearingHouse.unsubscribe();
	});
});
