import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { assert } from 'chai';

import {
	BN,
	ExchangeStatus,
	OracleGuardRails,
	OracleSource,
	TestClient,
} from '../sdk/src';

import { decodeName, DEFAULT_MARKET_NAME } from '../sdk/src/userName';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
} from './testHelpers';
import { PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from '../sdk';

describe('admin', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	let driftClient: TestClient;

	let usdcMint;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);

		driftClient = new TestClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();
		await driftClient.fetchAccounts();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));
		await driftClient.fetchAccounts();

		const solUsd = await mockOracle(1);
		const periodicity = new BN(60 * 60); // 1 HOUR

		await driftClient.initializePerpMarket(
			0,
			solUsd,
			new BN(1000),
			new BN(1000),
			periodicity
		);
	});

	it('checks market name', async () => {
		const market = driftClient.getPerpMarketAccount(0);
		const name = decodeName(market.name);
		assert(name == DEFAULT_MARKET_NAME);

		const newName = 'Glory t0 the DAmm';
		await driftClient.updatePerpMarketName(0, newName);

		await driftClient.fetchAccounts();
		const newMarket = driftClient.getPerpMarketAccount(0);
		assert(decodeName(newMarket.name) == newName);
	});

	it('Update lp cooldown time', async () => {
		await driftClient.updateLpCooldownTime(new BN(420));
		await driftClient.fetchAccounts();
		assert(driftClient.getStateAccount().lpCooldownTime.eq(new BN(420)));
	});

	it('Update Amm Jit', async () => {
		await driftClient.fetchAccounts();
		assert(driftClient.getPerpMarketAccount(0).amm.ammJitIntensity == 0);

		await driftClient.updateAmmJitIntensity(0, 100);
		await driftClient.fetchAccounts();
		assert(driftClient.getPerpMarketAccount(0).amm.ammJitIntensity == 100);

		await driftClient.updateAmmJitIntensity(0, 50);
		await driftClient.fetchAccounts();
		assert(driftClient.getPerpMarketAccount(0).amm.ammJitIntensity == 50);
	});

	it('Update Margin Ratio', async () => {
		const marginRatioInitial = 3000;
		const marginRatioMaintenance = 1000;

		await driftClient.updatePerpMarketMarginRatio(
			0,
			marginRatioInitial,
			marginRatioMaintenance
		);

		await driftClient.fetchAccounts();
		const market = driftClient.getPerpMarketAccount(0);

		assert(market.marginRatioInitial === marginRatioInitial);
		assert(market.marginRatioMaintenance === marginRatioMaintenance);
	});

	it('Update perp fee structure', async () => {
		const newFeeStructure = driftClient.getStateAccount().perpFeeStructure;
		newFeeStructure.flatFillerFee = new BN(0);

		await driftClient.updatePerpFeeStructure(newFeeStructure);

		await driftClient.fetchAccounts();
		const state = driftClient.getStateAccount();

		assert(
			JSON.stringify(newFeeStructure) === JSON.stringify(state.perpFeeStructure)
		);
	});

	it('Update spot fee structure', async () => {
		const newFeeStructure = driftClient.getStateAccount().spotFeeStructure;
		newFeeStructure.flatFillerFee = new BN(1);

		await driftClient.updateSpotFeeStructure(newFeeStructure);

		await driftClient.fetchAccounts();
		const state = driftClient.getStateAccount();

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
		};

		await driftClient.updateOracleGuardRails(oracleGuardRails);

		await driftClient.fetchAccounts();
		const state = driftClient.getStateAccount();

		assert(
			JSON.stringify(oracleGuardRails) ===
				JSON.stringify(state.oracleGuardRails)
		);
	});

	it('Update protocol mint', async () => {
		const mint = new PublicKey('2fvh6hkCYfpNqke9N48x6HcrW92uZVU3QSiXZX4A5L27');

		await driftClient.updateDiscountMint(mint);

		await driftClient.fetchAccounts();
		const state = driftClient.getStateAccount();

		assert(state.discountMint.equals(mint));
	});

	// it('Update max deposit', async () => {
	// 	const maxDeposit = new BN(10);

	// 	await driftClient.updateMaxDeposit(maxDeposit);

	// 	await driftClient.fetchAccounts();
	// 	const state = driftClient.getStateAccount();

	// 	assert(state.maxDeposit.eq(maxDeposit));
	// });

	it('Update market oracle', async () => {
		const newOracle = PublicKey.default;
		const newOracleSource = OracleSource.QUOTE_ASSET;

		await driftClient.updatePerpMarketOracle(0, newOracle, newOracleSource);

		await driftClient.fetchAccounts();
		const market = driftClient.getPerpMarketAccount(0);
		assert(market.amm.oracle.equals(PublicKey.default));
		assert(
			JSON.stringify(market.amm.oracleSource) ===
				JSON.stringify(newOracleSource)
		);
	});

	it('Update market base asset step size', async () => {
		const stepSize = new BN(2);
		const tickSize = new BN(2);

		await driftClient.updatePerpMarketStepSizeAndTickSize(
			0,
			stepSize,
			tickSize
		);

		await driftClient.fetchAccounts();
		const market = driftClient.getPerpMarketAccount(0);
		assert(market.amm.orderStepSize.eq(stepSize));
		assert(market.amm.orderTickSize.eq(tickSize));
	});

	it('Pause liq', async () => {
		await driftClient.updateExchangeStatus(ExchangeStatus.LIQ_PAUSED);
		await driftClient.fetchAccounts();
		const state = driftClient.getStateAccount();
		assert(state.exchangeStatus === ExchangeStatus.LIQ_PAUSED);

		console.log('paused liq!');
		// unpause
		await driftClient.updateExchangeStatus(ExchangeStatus.ACTIVE);
		await driftClient.fetchAccounts();
		const state2 = driftClient.getStateAccount();
		assert(state2.exchangeStatus === ExchangeStatus.ACTIVE);
		console.log('unpaused liq!');
	});

	it('Pause amm', async () => {
		await driftClient.updateExchangeStatus(ExchangeStatus.AMM_PAUSED);
		await driftClient.fetchAccounts();
		const state = driftClient.getStateAccount();
		assert(state.exchangeStatus === ExchangeStatus.AMM_PAUSED);

		console.log('paused amm!');
		// unpause
		await driftClient.updateExchangeStatus(ExchangeStatus.ACTIVE);
		await driftClient.fetchAccounts();
		const state2 = driftClient.getStateAccount();
		assert(state2.exchangeStatus === ExchangeStatus.ACTIVE);
		console.log('unpaused amm!');
	});

	it('Pause funding', async () => {
		await driftClient.updateExchangeStatus(ExchangeStatus.FUNDING_PAUSED);
		await driftClient.fetchAccounts();
		const state = driftClient.getStateAccount();
		assert(state.exchangeStatus === ExchangeStatus.FUNDING_PAUSED);

		console.log('paused funding!');
		// unpause
		await driftClient.updateExchangeStatus(ExchangeStatus.ACTIVE);
		await driftClient.fetchAccounts();
		const state2 = driftClient.getStateAccount();
		assert(state2.exchangeStatus === ExchangeStatus.ACTIVE);
		console.log('unpaused funding!');
	});

	it('Pause deposts and withdraws', async () => {
		await driftClient.updateExchangeStatus(
			ExchangeStatus.DEPOSIT_PAUSED | ExchangeStatus.WITHDRAW_PAUSED
		);
		await driftClient.fetchAccounts();
		const state = driftClient.getStateAccount();
		assert(
			state.exchangeStatus ===
				(ExchangeStatus.DEPOSIT_PAUSED | ExchangeStatus.WITHDRAW_PAUSED)
		);

		console.log('paused deposits and withdraw!');
		// unpause
		await driftClient.updateExchangeStatus(ExchangeStatus.ACTIVE);
		await driftClient.fetchAccounts();
		const state2 = driftClient.getStateAccount();
		assert(state2.exchangeStatus === ExchangeStatus.ACTIVE);
		console.log('unpaused deposits and withdraws!');
	});

	it('Update admin', async () => {
		const newAdminKey = PublicKey.default;

		await driftClient.updateAdmin(newAdminKey);

		await driftClient.fetchAccounts();
		const state = driftClient.getStateAccount();

		assert(state.admin.equals(newAdminKey));
	});

	after(async () => {
		await driftClient.unsubscribe();
	});
});
