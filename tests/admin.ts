import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { assert, expect } from 'chai';
import { startAnchor } from 'solana-bankrun';
import {
	BN,
	ExchangeStatus,
	getPythLazerOraclePublicKey,
	getTokenAmount,
	loadKeypair,
	OracleGuardRails,
	OracleSource,
	SpotBalanceType,
	TestClient,
	Wallet,
} from '../packages/sdk/src';

import { decodeName, DEFAULT_MARKET_NAME } from '../packages/sdk/src/userName';

import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { PublicKey } from '@solana/web3.js';
import {
	BankrunContextWrapper,
	Connection,
} from '../packages/sdk/src/bankrun/bankrunConnection';
import { TestBulkAccountLoader } from '../packages/sdk/src/accounts/testBulkAccountLoader';
import { createTransferCheckedInstruction } from '@solana/spl-token';

describe('admin', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let bulkAccountLoader: TestBulkAccountLoader;

	let velocityClient: TestClient;

	let usdcMint;

	let userUSDCAccount;

	const usdcAmount = new BN(10 * 10 ** 6);

	let bankrunContextWrapper: BankrunContextWrapper;

	before(async () => {
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context as any);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);

		const wallet = new Wallet(loadKeypair(process.env.ANCHOR_WALLET));
		//@ts-ignore
		await bankrunContextWrapper.fundKeypair(wallet, 10 ** 9);

		velocityClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(), // ugh.
			wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			subAccountIds: [],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper,
			velocityClient.wallet.publicKey
		);

		await velocityClient.initialize(usdcMint.publicKey, true);
		await velocityClient.subscribe();
		await velocityClient.initializeUserAccount(0);
		await velocityClient.fetchAccounts();

		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
		await velocityClient.updatePerpAuctionDuration(new BN(0));
		await velocityClient.fetchAccounts();

		const periodicity = new BN(60 * 60); // 1 HOUR

		const solUsd = await mockOracleNoProgram(bankrunContextWrapper, 1);
		await velocityClient.initializePerpMarket(
			0,
			solUsd,
			new BN(1000),
			new BN(1000),
			periodicity
		);

		await velocityClient.initializeAmmCache();
	});

	it('checks market name', async () => {
		const market = velocityClient.getPerpMarketAccount(0);
		const name = decodeName(market.name);
		assert(name == DEFAULT_MARKET_NAME);

		const newName = 'Glory t0 the DAmm';
		await velocityClient.updatePerpMarketName(0, newName);

		await velocityClient.fetchAccounts();
		const newMarket = velocityClient.getPerpMarketAccount(0);
		assert(
			decodeName(newMarket.name) == newName,
			`market name does not match \n actual: ${decodeName(
				newMarket.name
			)} \n expected: ${newName}`
		);
	});

	it('Update Amm Jit', async () => {
		await velocityClient.fetchAccounts();
		assert(
			velocityClient.getPerpMarketAccount(0).amm.ammJitIntensity == 0,
			`amm jit intensity does not match \n actual: ${
				velocityClient.getPerpMarketAccount(0).amm.ammJitIntensity
			} \n expected: 0`
		);

		await velocityClient.updateAmmJitIntensity(0, 100);
		await velocityClient.fetchAccounts();
		assert(
			velocityClient.getPerpMarketAccount(0).amm.ammJitIntensity == 100,
			`amm jit intensity does not match \n actual: ${
				velocityClient.getPerpMarketAccount(0).amm.ammJitIntensity
			} \n expected: 100`
		);

		await velocityClient.updateAmmJitIntensity(0, 50);
		await velocityClient.fetchAccounts();
		assert(
			velocityClient.getPerpMarketAccount(0).amm.ammJitIntensity == 50,
			`amm jit intensity does not match \n actual: ${
				velocityClient.getPerpMarketAccount(0).amm.ammJitIntensity
			} \n expected: 50`
		);
	});

	it('Update Margin Ratio', async () => {
		const marginRatioInitial = 3000;
		const marginRatioMaintenance = 1000;

		await velocityClient.updatePerpMarketMarginRatio(
			0,
			marginRatioInitial,
			marginRatioMaintenance
		);

		await velocityClient.fetchAccounts();
		const market = velocityClient.getPerpMarketAccount(0);

		assert(
			market.marginRatioInitial === marginRatioInitial,
			`margin ratio initial does not match \n actual: ${market.marginRatioInitial} \n expected: ${marginRatioInitial}`
		);
		assert(
			market.marginRatioMaintenance === marginRatioMaintenance,
			`margin ratio maintenance does not match \n actual: ${market.marginRatioMaintenance} \n expected: ${marginRatioMaintenance}`
		);
	});

	it('Update perp fee structure', async () => {
		const newFeeStructure = velocityClient.getStateAccount().perpFeeStructure;
		newFeeStructure.flatFillerFee = new BN(0);

		await velocityClient.updatePerpFeeStructure(newFeeStructure);

		await velocityClient.fetchAccounts();
		const state = velocityClient.getStateAccount();

		assert(
			JSON.stringify(newFeeStructure) ===
				JSON.stringify(state.perpFeeStructure),
			`fee structure does not match \n actual: ${JSON.stringify(
				state.perpFeeStructure
			)} \n expected: ${JSON.stringify(newFeeStructure)}`
		);
	});

	it('Update spot fee structure', async () => {
		const newFeeStructure = velocityClient.getStateAccount().spotFeeStructure;
		newFeeStructure.flatFillerFee = new BN(1);

		await velocityClient.updateSpotFeeStructure(newFeeStructure);

		await velocityClient.fetchAccounts();
		const state = velocityClient.getStateAccount();

		assert(
			JSON.stringify(newFeeStructure) ===
				JSON.stringify(state.spotFeeStructure),
			`fee structure does not match \n actual: ${JSON.stringify(
				state.spotFeeStructure
			)} \n expected: ${JSON.stringify(newFeeStructure)}`
		);
	});

	it('Update oracle guard rails', async () => {
		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOraclePercentDivergence: new BN(1000000),
				oracleTwap5MinPercentDivergence: new BN(1000000),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(1),
				slotsBeforeStaleForMargin: new BN(1),
				confidenceIntervalMaxSize: new BN(1),
				tooVolatileRatio: new BN(1),
			},
		};

		await velocityClient.updateOracleGuardRails(oracleGuardRails);

		await velocityClient.fetchAccounts();
		const state = velocityClient.getStateAccount();

		assert(
			JSON.stringify(oracleGuardRails) ===
				JSON.stringify(state.oracleGuardRails),
			`oracle guard rails does not match \n actual: ${JSON.stringify(
				state.oracleGuardRails
			)} \n expected: ${JSON.stringify(oracleGuardRails)}`
		);
	});

	it('Update protocol mint', async () => {
		const mint = new PublicKey('2fvh6hkCYfpNqke9N48x6HcrW92uZVU3QSiXZX4A5L27');

		await velocityClient.updateDiscountMint(mint);

		await velocityClient.fetchAccounts();
		const state = velocityClient.getStateAccount();

		assert(
			state.discountMint.equals(mint),
			`discount mint does not match \n actual: ${state.discountMint} \n expected: ${mint}`
		);
	});

	// it('Update max deposit', async () => {
	//  const maxDeposit = new BN(10);

	//  await velocityClient.updateMaxDeposit(maxDeposit);

	//  await velocityClient.fetchAccounts();
	//  const state = velocityClient.getStateAccount();

	//  assert(state.maxDeposit.eq(maxDeposit));
	// });

	it('Update market oracle', async () => {
		const newOracle = PublicKey.default;
		const newOracleSource = OracleSource.QUOTE_ASSET;

		await velocityClient.updatePerpMarketOracle(0, newOracle, newOracleSource);

		await velocityClient.fetchAccounts();
		const market = velocityClient.getPerpMarketAccount(0);
		assert(
			market.oracle.equals(PublicKey.default),
			`oracle does not match \n actual: ${market.oracle} \n expected: ${PublicKey.default}`
		);
		assert(
			JSON.stringify(market.oracleSource) === JSON.stringify(newOracleSource),
			`oracle source does not match \n actual: ${JSON.stringify(
				market.oracleSource
			)} \n expected: ${JSON.stringify(newOracleSource)}`
		);
	});

	it('Update market base asset step size', async () => {
		const stepSize = new BN(2);
		const tickSize = new BN(2);

		await velocityClient.updatePerpMarketStepSizeAndTickSize(
			0,
			stepSize,
			tickSize
		);

		await velocityClient.fetchAccounts();
		const market = velocityClient.getPerpMarketAccount(0);
		assert(
			market.orderStepSize.eq(stepSize),
			`step size does not match \n actual: ${market.orderStepSize} \n expected: ${stepSize}`
		);
		assert(
			market.orderTickSize.eq(tickSize),
			`tick size does not match \n actual: ${market.orderTickSize} \n expected: ${tickSize}`
		);
	});

	it('Pause liq', async () => {
		await velocityClient.updateExchangeStatus(ExchangeStatus.LIQ_PAUSED);
		await velocityClient.fetchAccounts();
		const state = velocityClient.getStateAccount();
		assert(
			state.exchangeStatus === ExchangeStatus.LIQ_PAUSED,
			`exchange status does not match \n actual: ${state.exchangeStatus} \n expected: ${ExchangeStatus.LIQ_PAUSED}`
		);

		console.log('paused liq!');
		// unpause
		await velocityClient.updateExchangeStatus(ExchangeStatus.ACTIVE);
		await velocityClient.fetchAccounts();
		const state2 = velocityClient.getStateAccount();
		assert(
			state2.exchangeStatus === ExchangeStatus.ACTIVE,
			`exchange status does not match \n actual: ${state2.exchangeStatus} \n expected: ${ExchangeStatus.ACTIVE}`
		);
		console.log('unpaused liq!');
	});

	it('Pause amm', async () => {
		await velocityClient.updateExchangeStatus(ExchangeStatus.AMM_PAUSED);
		await velocityClient.fetchAccounts();
		const state = velocityClient.getStateAccount();
		assert(
			state.exchangeStatus === ExchangeStatus.AMM_PAUSED,
			`exchange status does not match \n actual: ${state.exchangeStatus} \n expected: ${ExchangeStatus.AMM_PAUSED}`
		);

		console.log('paused amm!');
		// unpause
		await velocityClient.updateExchangeStatus(ExchangeStatus.ACTIVE);
		await velocityClient.fetchAccounts();
		const state2 = velocityClient.getStateAccount();
		assert(
			state2.exchangeStatus === ExchangeStatus.ACTIVE,
			`exchange status does not match \n actual: ${state2.exchangeStatus} \n expected: ${ExchangeStatus.ACTIVE}`
		);
		console.log('unpaused amm!');
	});

	it('Pause funding', async () => {
		await velocityClient.updateExchangeStatus(ExchangeStatus.FUNDING_PAUSED);
		await velocityClient.fetchAccounts();
		const state = velocityClient.getStateAccount();
		assert(
			state.exchangeStatus === ExchangeStatus.FUNDING_PAUSED,
			`exchange status does not match \n actual: ${state.exchangeStatus} \n expected: ${ExchangeStatus.FUNDING_PAUSED}`
		);

		console.log('paused funding!');
		// unpause
		await velocityClient.updateExchangeStatus(ExchangeStatus.ACTIVE);
		await velocityClient.fetchAccounts();
		const state2 = velocityClient.getStateAccount();
		assert(
			state2.exchangeStatus === ExchangeStatus.ACTIVE,
			`exchange status does not match \n actual: ${state2.exchangeStatus} \n expected: ${ExchangeStatus.ACTIVE}`
		);
		console.log('unpaused funding!');
	});

	it('Pause deposts and withdraws', async () => {
		await velocityClient.updateExchangeStatus(
			ExchangeStatus.DEPOSIT_PAUSED | ExchangeStatus.WITHDRAW_PAUSED
		);
		await velocityClient.fetchAccounts();
		const state = velocityClient.getStateAccount();
		assert(
			state.exchangeStatus ===
				(ExchangeStatus.DEPOSIT_PAUSED | ExchangeStatus.WITHDRAW_PAUSED),
			`exchange status does not match \n actual: ${
				state.exchangeStatus
			} \n expected: ${
				ExchangeStatus.DEPOSIT_PAUSED | ExchangeStatus.WITHDRAW_PAUSED
			}`
		);

		console.log('paused deposits and withdraw!');
		// unpause
		await velocityClient.updateExchangeStatus(ExchangeStatus.ACTIVE);
		await velocityClient.fetchAccounts();
		const state2 = velocityClient.getStateAccount();
		assert(
			state2.exchangeStatus === ExchangeStatus.ACTIVE,
			`exchange status does not match \n actual: ${state2.exchangeStatus} \n expected: ${ExchangeStatus.ACTIVE}`
		);
		console.log('unpaused deposits and withdraws!');
	});

	it('Init pyth lazer', async () => {
		await velocityClient.fetchAccounts();
		const tx = await velocityClient.initializePythLazerOracle(0);
		console.log(tx);

		assert(
			await checkIfAccountExists(
				velocityClient.connection,
				getPythLazerOraclePublicKey(velocityClient.program.programId, 0)
			)
		);
	});

	it('update MM oracle native', async () => {
		// Use a realistic baseline in PRICE_PRECISION so the small numeric increments
		// stay well under the 1% step cap enforced by the native handler.
		const oraclePrice = new BN(100_000_000);
		const oracleTS = new BN(Date.now());
		await velocityClient.updateFeatureBitFlagsMMOracle(true);
		await velocityClient.updateMmOracleNative(0, oraclePrice, oracleTS);
		await velocityClient.fetchAccounts();

		let perpMarket = velocityClient.getPerpMarketAccount(0);
		assert(perpMarket.marketStats.mmOraclePrice.eq(oraclePrice));
		const slot = (await bankrunContextWrapper.connection.getSlot()).toString();
		expect(perpMarket.marketStats.mmOracleSlot.toNumber()).to.be.approximately(
			+slot,
			1
		);
		assert(perpMarket.marketStats.mmOracleSequenceId.eq(oracleTS));

		// Doesnt change if id doesnt increase
		await velocityClient.updateMmOracleNative(0, oraclePrice.addn(1), oracleTS);
		assert(perpMarket.marketStats.mmOraclePrice.eq(oraclePrice));

		// Errors if we try and update it with price of zero
		try {
			await velocityClient.updateMmOracleNative(0, new BN(0), oracleTS);
			assert.fail('Should have thrown');
		} catch (e) {
			console.log(e.message);
			assert(e.message.includes('custom program error'));
		}

		// Doesnt update if we flip the admin switch
		await velocityClient.updateFeatureBitFlagsMMOracle(false);
		try {
			await velocityClient.updateMmOracleNative(0, oraclePrice, oracleTS);
			assert.fail('Should have thrown');
		} catch (e) {
			console.log(e.message);
			assert(e.message.includes('Program failed to complete'));
		}

		// Re-enable and update
		await velocityClient.updateFeatureBitFlagsMMOracle(true);
		await velocityClient.updateMmOracleNative(
			0,
			oraclePrice.addn(2),
			oracleTS.addn(1)
		);
		await velocityClient.fetchAccounts();
		perpMarket = velocityClient.getPerpMarketAccount(0);
		assert(perpMarket.marketStats.mmOraclePrice.eq(oraclePrice.addn(2)));
		assert(perpMarket.marketStats.mmOracleSequenceId.eq(oracleTS.addn(1)));
	});

	it('mm oracle step cap rejects too large jump', async () => {
		await velocityClient.fetchAccounts();
		const before = velocityClient.getPerpMarketAccount(0);
		const baselinePrice = before.marketStats.mmOraclePrice;
		const baselineSeqId = before.marketStats.mmOracleSequenceId;

		// 5% jump from the last accepted price exceeds the 1% step cap.
		const tooLargePrice = baselinePrice.muln(105).divn(100);
		const freshSeqId = baselineSeqId.addn(1000);

		// Silent no-op: the tx itself succeeds but state must be unchanged.
		await velocityClient.updateMmOracleNative(0, tooLargePrice, freshSeqId);
		await velocityClient.fetchAccounts();

		const after = velocityClient.getPerpMarketAccount(0);
		assert(
			after.marketStats.mmOraclePrice.eq(baselinePrice),
			'mm oracle price should be unchanged after step-cap reject'
		);
		assert(
			after.marketStats.mmOracleSequenceId.eq(baselineSeqId),
			'mm oracle sequence id should be unchanged after step-cap reject'
		);
	});

	it('update amm adjustment oracle native', async () => {
		const ammSpreadAdjustment = 5;
		await velocityClient.updateAmmSpreadAdjustmentNative(
			0,
			ammSpreadAdjustment
		);
		await velocityClient.fetchAccounts();
		const perpMarket = velocityClient.getPerpMarketAccount(0);
		assert(perpMarket.amm.ammSpreadAdjustment == ammSpreadAdjustment);
	});

	it('update perp market reference offset deadband pct', async () => {
		const referenceOffsetDeadbandPct = 5;
		await velocityClient.updatePerpMarketReferencePriceOffsetDeadbandPct(
			0,
			referenceOffsetDeadbandPct
		);
		const perpMarket = velocityClient.getPerpMarketAccount(0);
		assert(
			perpMarket.amm.referencePriceOffsetDeadbandPct ==
				referenceOffsetDeadbandPct
		);
	});

	it('update pnl pool', async () => {
		const quoteVault = velocityClient.getSpotMarketAccount(0).vault;

		const splTransferIx = createTransferCheckedInstruction(
			userUSDCAccount.publicKey,
			usdcMint.publicKey,
			quoteVault,
			velocityClient.wallet.publicKey,
			usdcAmount.toNumber(),
			6
		);

		const tx = await velocityClient.buildTransaction(splTransferIx);
		// @ts-ignore
		await velocityClient.sendTransaction(tx);

		await velocityClient.updatePerpMarketPnlPool(0, usdcAmount);

		await velocityClient.fetchAccounts();

		const perpMarket = velocityClient.getPerpMarketAccount(0);
		const spotMarket = velocityClient.getSpotMarketAccount(0);

		const tokenAmount = getTokenAmount(
			perpMarket.pnlPool.scaledBalance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);

		assert(tokenAmount.eq(usdcAmount));
	});

	it('Update admin', async () => {
		const newAdminKey = PublicKey.default;

		await velocityClient.updateAdmin(newAdminKey);

		await velocityClient.fetchAccounts();
		const state = velocityClient.getStateAccount();

		assert(
			state.coldAdmin.equals(newAdminKey),
			`admin does not match \n actual: ${state.coldAdmin} \n expected: ${newAdminKey}`
		);
	});

	after(async () => {
		await velocityClient.unsubscribe();
	});
});

async function checkIfAccountExists(
	connection: Connection,
	account: PublicKey
): Promise<boolean> {
	try {
		const accountInfo = await connection.getAccountInfo(account);
		return accountInfo != null;
	} catch (e) {
		// Doesn't already exist
		return false;
	}
}
