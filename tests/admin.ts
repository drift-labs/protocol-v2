import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import { assert } from 'chai';

import {
	Admin,
	ExchangeStatus,
	OracleGuardRails,
	OracleSource,
	isVariant,
	BN,
} from '../sdk/src';

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
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();
		await clearingHouse.fetchAccounts();

		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
		await clearingHouse.updatePerpAuctionDuration(new BN(0));
		await clearingHouse.fetchAccounts();

		const solUsd = await mockOracle(1);
		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializePerpMarket(
			solUsd,
			new BN(1000),
			new BN(1000),
			periodicity
		);
	});

	it('Update lp cooldown time', async () => {
		await clearingHouse.updatePerpMarketLpCooldownTime(new BN(420));
		await clearingHouse.fetchAccounts();
		assert(clearingHouse.getStateAccount().lpCooldownTime.eq(new BN(420)));
	});

	it('Update Amm Jit', async () => {
		await clearingHouse.fetchAccounts();
		assert(clearingHouse.getPerpMarketAccount(0).amm.ammJitIntensity == 0);

		await clearingHouse.updateAmmJitIntensity(0, 100);
		await clearingHouse.fetchAccounts();
		assert(clearingHouse.getPerpMarketAccount(0).amm.ammJitIntensity == 100);

		await clearingHouse.updateAmmJitIntensity(0, 50);
		await clearingHouse.fetchAccounts();
		assert(clearingHouse.getPerpMarketAccount(0).amm.ammJitIntensity == 50);
	});

	it('Update Margin Ratio', async () => {
		const marginRatioInitial = 3000;
		const marginRatioMaintenance = 1000;

		await clearingHouse.updatePerpMarketMarginRatio(
			0,
			marginRatioInitial,
			marginRatioMaintenance
		);

		await clearingHouse.fetchAccounts();
		const market = clearingHouse.getPerpMarketAccount(0);

		assert(market.marginRatioInitial === marginRatioInitial);
		assert(market.marginRatioMaintenance === marginRatioMaintenance);
	});

	it('Update perp fee structure', async () => {
		const newFeeStructure = clearingHouse.getStateAccount().perpFeeStructure;
		newFeeStructure.flatFillerFee = new BN(0);

		await clearingHouse.updatePerpFeeStructure(newFeeStructure);

		await clearingHouse.fetchAccounts();
		const state = clearingHouse.getStateAccount();

		assert(
			JSON.stringify(newFeeStructure) === JSON.stringify(state.perpFeeStructure)
		);
	});

	it('Update spot fee structure', async () => {
		const newFeeStructure = clearingHouse.getStateAccount().spotFeeStructure;
		newFeeStructure.flatFillerFee = new BN(1);

		await clearingHouse.updateSpotFeeStructure(newFeeStructure);

		await clearingHouse.fetchAccounts();
		const state = clearingHouse.getStateAccount();

		assert(
			JSON.stringify(newFeeStructure) === JSON.stringify(state.spotFeeStructure)
		);
	});

	it('Update oracle guard rails', async () => {
		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOracleDivergenceNumerator: new BN(1),
				markOracleDivergenceDenominator: new BN(1),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(1),
				slotsBeforeStaleForMargin: new BN(1),
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

		await clearingHouse.updatePerpMarketOracle(0, newOracle, newOracleSource);

		await clearingHouse.fetchAccounts();
		const market = clearingHouse.getPerpMarketAccount(0);
		assert(market.amm.oracle.equals(PublicKey.default));
		assert(
			JSON.stringify(market.amm.oracleSource) ===
				JSON.stringify(newOracleSource)
		);
	});

	it('Update market base asset step size', async () => {
		const stepSize = new BN(2);
		const tickSize = new BN(2);

		await clearingHouse.updatePerpMarketStepSizeAndTickSize(
			0,
			stepSize,
			tickSize
		);

		await clearingHouse.fetchAccounts();
		const market = clearingHouse.getPerpMarketAccount(0);
		assert(market.amm.orderStepSize.eq(stepSize));
		assert(market.amm.orderTickSize.eq(tickSize));
	});

	it('Pause liq', async () => {
		await clearingHouse.updateExchangeStatus(ExchangeStatus.LIQPAUSED);
		await clearingHouse.fetchAccounts();
		const state = clearingHouse.getStateAccount();
		assert(isVariant(state.exchangeStatus, 'liqPaused'));

		console.log('paused liq!');
		// unpause
		await clearingHouse.updateExchangeStatus(ExchangeStatus.ACTIVE);
		await clearingHouse.fetchAccounts();
		const state2 = clearingHouse.getStateAccount();
		assert(isVariant(state2.exchangeStatus, 'active'));
		console.log('unpaused liq!');
	});

	it('Pause amm', async () => {
		await clearingHouse.updateExchangeStatus(ExchangeStatus.AMMPAUSED);
		await clearingHouse.fetchAccounts();
		const state = clearingHouse.getStateAccount();
		assert(isVariant(state.exchangeStatus, 'ammPaused'));

		console.log('paused amm!');
		// unpause
		await clearingHouse.updateExchangeStatus(ExchangeStatus.ACTIVE);
		await clearingHouse.fetchAccounts();
		const state2 = clearingHouse.getStateAccount();
		assert(isVariant(state2.exchangeStatus, 'active'));
		console.log('unpaused amm!');
	});

	it('Pause funding', async () => {
		await clearingHouse.updateExchangeStatus(ExchangeStatus.FUNDINGPAUSED);
		await clearingHouse.fetchAccounts();
		const state = clearingHouse.getStateAccount();
		assert(isVariant(state.exchangeStatus, 'fundingPaused'));

		console.log('paused funding!');
		// unpause
		await clearingHouse.updateExchangeStatus(ExchangeStatus.ACTIVE);
		await clearingHouse.fetchAccounts();
		const state2 = clearingHouse.getStateAccount();
		assert(isVariant(state2.exchangeStatus, 'active'));
		console.log('unpaused funding!');
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
