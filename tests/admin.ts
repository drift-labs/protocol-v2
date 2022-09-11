import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import { BN } from '../sdk';
import { assert } from 'chai';

import {
	Admin,
	FeeStructure,
	OracleGuardRails,
	OrderFillerRewardStructure,
} from '../sdk/src';
import { OracleSource } from '../sdk';

import {
	mockOracle,
	mockUSDCMint,
	initializeQuoteSpotMarket,
} from './testHelpers';
import { PublicKey } from '@solana/web3.js';

describe('admin', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;

	let usdcMint;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: [new BN(0)],
			spotMarketIndexes: [new BN(0)],
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
		await clearingHouse.updateAuctionDuration(new BN(0), new BN(0));

		const solUsd = await mockOracle(1);
		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			solUsd,
			new BN(1000),
			new BN(1000),
			periodicity
		);
	});

	it('Update Amm Jit', async () => {
		await clearingHouse.fetchAccounts();
		assert(clearingHouse.getPerpMarketAccount(0).amm.ammJitIntensity == 0);

		await clearingHouse.updateAmmJitIntensity(new BN(0), 100);
		await clearingHouse.fetchAccounts();
		assert(clearingHouse.getPerpMarketAccount(0).amm.ammJitIntensity == 100);

		await clearingHouse.updateAmmJitIntensity(new BN(0), 50);
		await clearingHouse.fetchAccounts();
		assert(clearingHouse.getPerpMarketAccount(0).amm.ammJitIntensity == 50);
	});

	it('Update Margin Ratio', async () => {
		const marginRatioInitial = 3000;
		const marginRatioMaintenance = 1000;

		await clearingHouse.updateMarginRatio(
			new BN(0),
			marginRatioInitial,
			marginRatioMaintenance
		);

		await clearingHouse.fetchAccounts();
		const market = clearingHouse.getPerpMarketAccount(0);

		assert(market.marginRatioInitial === marginRatioInitial);
		assert(market.marginRatioMaintenance === marginRatioMaintenance);
	});

	it('Update Partial Liquidation Close Percentages', async () => {
		const numerator = new BN(1);
		const denominator = new BN(10);

		await clearingHouse.updatePartialLiquidationClosePercentage(
			numerator,
			denominator
		);

		await clearingHouse.fetchAccounts();
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

		await clearingHouse.fetchAccounts();
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

		await clearingHouse.fetchAccounts();
		const state = clearingHouse.getStateAccount();

		assert(state.fullLiquidationPenaltyPercentageNumerator.eq(numerator));
		assert(state.fullLiquidationPenaltyPercentageDenominator.eq(denominator));
	});

	it('Update Partial Liquidation Share Denominator', async () => {
		const denominator = new BN(10);

		await clearingHouse.updatePartialLiquidationShareDenominator(denominator);

		await clearingHouse.fetchAccounts();
		const state = clearingHouse.getStateAccount();

		assert(state.partialLiquidationLiquidatorShareDenominator.eq(denominator));
	});

	it('Update Full Liquidation Share Denominator', async () => {
		const denominator = new BN(10);

		await clearingHouse.updateFullLiquidationShareDenominator(denominator);

		await clearingHouse.fetchAccounts();
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
			makerRebateNumerator: new BN(1),
			makerRebateDenominator: new BN(1),
			fillerRewardStructure: {
				rewardNumerator: new BN(1),
				rewardDenominator: new BN(1),
				timeBasedRewardLowerBound: new BN(1),
			},
			cancelOrderFee: new BN(0),
		};

		await clearingHouse.updateFee(newFeeStructure);

		await clearingHouse.fetchAccounts();
		const state = clearingHouse.getStateAccount();

		assert(
			JSON.stringify(newFeeStructure) === JSON.stringify(state.perpFeeStructure)
		);
	});

	it('Update order filler reward structure', async () => {
		const newStructure: OrderFillerRewardStructure = {
			rewardNumerator: new BN(1),
			rewardDenominator: new BN(1),
			timeBasedRewardLowerBound: new BN(1),
		};

		await clearingHouse.updateOrderFillerRewardStructure(newStructure);

		await clearingHouse.fetchAccounts();

		assert(
			JSON.stringify(newStructure) ===
				JSON.stringify(
					clearingHouse.getStateAccount().perpFeeStructure.fillerRewardStructure
				)
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

		await clearingHouse.fetchAccounts();
		const state = clearingHouse.getStateAccount();

		assert(
			JSON.stringify(oracleGuardRails) ===
				JSON.stringify(state.oracleGuardRails)
		);
	});

	it('Update protocol mint', async () => {
		const mint = new PublicKey('2fvh6hkCYfpNqke9N48x6HcrW92uZVU3QSiXZX4A5L27');

		await clearingHouse.updateDiscountMint(mint);

		await clearingHouse.fetchAccounts();
		const state = clearingHouse.getStateAccount();

		assert(state.discountMint.equals(mint));
	});

	// it('Update max deposit', async () => {
	// 	const maxDeposit = new BN(10);

	// 	await clearingHouse.updateMaxDeposit(maxDeposit);

	// 	await clearingHouse.fetchAccounts();
	// 	const state = clearingHouse.getStateAccount();

	// 	assert(state.maxDeposit.eq(maxDeposit));
	// });

	it('Update market oracle', async () => {
		const newOracle = PublicKey.default;
		const newOracleSource = OracleSource.SWITCHBOARD;

		await clearingHouse.updateMarketOracle(
			new BN(0),
			newOracle,
			newOracleSource
		);

		await clearingHouse.fetchAccounts();
		const market = clearingHouse.getPerpMarketAccount(0);
		assert(market.amm.oracle.equals(PublicKey.default));
		assert(
			JSON.stringify(market.amm.oracleSource) ===
				JSON.stringify(newOracleSource)
		);
	});

	it('Update market minimum quote asset trade size', async () => {
		const minimumTradeSize = new BN(1);

		await clearingHouse.updateMarketMinimumQuoteAssetTradeSize(
			new BN(0),
			minimumTradeSize
		);

		await clearingHouse.fetchAccounts();
		const market = clearingHouse.getPerpMarketAccount(0);
		assert(market.amm.minimumQuoteAssetTradeSize.eq(minimumTradeSize));
	});

	it('Update market base asset step size', async () => {
		const stepSize = new BN(2);

		await clearingHouse.updateMarketBaseAssetAmountStepSize(
			new BN(0),
			stepSize
		);

		await clearingHouse.fetchAccounts();
		const market = clearingHouse.getPerpMarketAccount(0);
		assert(market.amm.baseAssetAmountStepSize.eq(stepSize));
	});

	it('Pause funding', async () => {
		await clearingHouse.updateFundingPaused(true);
		await clearingHouse.fetchAccounts();
		const state = clearingHouse.getStateAccount();
		assert(state.fundingPaused);
	});

	it('Disable admin controls prices', async () => {
		let state = clearingHouse.getStateAccount();
		assert(state.adminControlsPrices);
		await clearingHouse.disableAdminControlsPrices();
		await clearingHouse.fetchAccounts();
		state = clearingHouse.getStateAccount();
		assert(!state.adminControlsPrices);
	});

	it('Update admin', async () => {
		const newAdminKey = PublicKey.default;

		await clearingHouse.updateAdmin(newAdminKey);

		await clearingHouse.fetchAccounts();
		const state = clearingHouse.getStateAccount();

		assert(state.admin.equals(newAdminKey));
	});

	after(async () => {
		await clearingHouse.unsubscribe();
	});
});
