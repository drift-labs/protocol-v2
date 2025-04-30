import * as anchor from '@coral-xyz/anchor';
import { expect, assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getMint } from '@solana/spl-token';

import {
	BN,
	TestClient,
	QUOTE_PRECISION,
	getLpPoolPublicKey,
	getAmmConstituentMappingPublicKey,
	encodeName,
	getConstituentTargetWeightsPublicKey,
	PERCENTAGE_PRECISION,
	PRICE_PRECISION,
	PEG_PRECISION,
	ConstituentTargetWeights,
	AmmConstituentMapping,
	User,
	OracleSource,
	SPOT_MARKET_RATE_PRECISION,
	SPOT_MARKET_WEIGHT_PRECISION,
	LPPoolAccount,
	DriftClient,
	convertToNumber,
	getConstituentVaultPublicKey,
	getConstituentPublicKey,
	ConstituentAccount,
} from '../sdk/src';

import {
	getPerpMarketDecoded,
	initializeQuoteSpotMarket,
	mockUSDCMint,
	mockUserUSDCAccount,
	mockOracleNoProgram,
	setFeedPriceNoProgram,
	overWriteTokenAccountBalance,
	overwriteConstituentAccount,
	overwritePerpMarketAccount,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import dotenv from 'dotenv';
dotenv.config();

describe('LP Pool', () => {
	const program = anchor.workspace.Drift as Program;
	let bankrunContextWrapper: BankrunContextWrapper;
	let bulkAccountLoader: TestBulkAccountLoader;

	let adminClient: TestClient;
	let usdcMint: Keypair;
	let spotTokenMint: Keypair;
	let spotMarketIndex: number;
	let spotMarketOracle: PublicKey;
	let adminUser: User;

	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(10 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(10 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const lpPoolName = 'test pool 1';
	const tokenDecimals = 6;
	const lpPoolKey = getLpPoolPublicKey(
		program.programId,
		encodeName(lpPoolName)
	);

	before(async () => {
		const context = await startAnchor('', [], []);

		// @ts-ignore
		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		spotTokenMint = await mockUSDCMint(bankrunContextWrapper);
		console.log('try mockOracle');
		spotMarketOracle = await mockOracleNoProgram(bankrunContextWrapper, 200.1);
		console.log('spotMarketOracle', spotMarketOracle);

		const keypair = new Keypair();
		await bankrunContextWrapper.fundKeypair(keypair, 10 ** 9);

		adminClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(keypair),
			programID: program.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			subAccountIds: [],
			perpMarketIndexes: [0, 1],
			spotMarketIndexes: [0, 1],
			oracleInfos: [
				{
					publicKey: spotMarketOracle,
					source: OracleSource.PYTH,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await adminClient.initialize(usdcMint.publicKey, true);
		await adminClient.subscribe();
		await initializeQuoteSpotMarket(adminClient, usdcMint.publicKey);

		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			new BN(10).mul(QUOTE_PRECISION),
			bankrunContextWrapper,
			keypair.publicKey
		);

		await adminClient.initializeUserAccountAndDepositCollateral(
			new BN(10).mul(QUOTE_PRECISION),
			userUSDCAccount.publicKey
		);
		adminUser = new User({
			driftClient: adminClient,
			userAccountPublicKey: await adminClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		const periodicity = new BN(0);

		await adminClient.initializePerpMarket(
			0,
			spotMarketOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(224 * PEG_PRECISION.toNumber())
		);

		await adminClient.initializePerpMarket(
			1,
			spotMarketOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(224 * PEG_PRECISION.toNumber())
		);

		const optimalUtilization = SPOT_MARKET_RATE_PRECISION.div(
			new BN(2)
		).toNumber(); // 50% utilization
		const optimalRate = SPOT_MARKET_RATE_PRECISION.toNumber();
		const maxRate = SPOT_MARKET_RATE_PRECISION.toNumber();
		const initialAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		const maintenanceAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		const initialLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		const maintenanceLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		const imfFactor = 0;
		spotMarketIndex = adminClient.getStateAccount().numberOfSpotMarkets;

		await adminClient.initializeSpotMarket(
			spotTokenMint.publicKey,
			optimalUtilization,
			optimalRate,
			maxRate,
			spotMarketOracle,
			OracleSource.PYTH,
			initialAssetWeight,
			maintenanceAssetWeight,
			initialLiabilityWeight,
			maintenanceLiabilityWeight,
			imfFactor
		);

		await adminClient.initializeLpPool(
			lpPoolName,
			new BN(100_000_000).mul(QUOTE_PRECISION),
			Keypair.generate() // dlp mint
		);
		await adminClient.initializeConstituent(
			encodeName(lpPoolName),
			0,
			6,
			PERCENTAGE_PRECISION.divn(1000),
			PERCENTAGE_PRECISION.divn(10000),
			PERCENTAGE_PRECISION.divn(100)
		);
		await adminClient.initializeConstituent(
			encodeName(lpPoolName),
			1,
			6,
			PERCENTAGE_PRECISION.divn(1000),
			PERCENTAGE_PRECISION.divn(10000),
			PERCENTAGE_PRECISION.divn(100)
		);

		//
	});

	after(async () => {
		await adminClient.unsubscribe();
	});

	it('LP Pool init properly', async () => {
		let lpPool: LPPoolAccount;
		try {
			lpPool = (await adminClient.program.account.lpPool.fetch(
				lpPoolKey
			)) as LPPoolAccount;
			expect(lpPool).to.not.be.null;
		} catch (e) {
			expect.fail('LP Pool should have been created');
		}

		try {
			const constituentTargetWeightsPublicKey =
				getConstituentTargetWeightsPublicKey(program.programId, lpPoolKey);
			const constituentTargetWeights =
				(await adminClient.program.account.constituentTargetWeights.fetch(
					constituentTargetWeightsPublicKey
				)) as ConstituentTargetWeights;
			expect(constituentTargetWeights).to.not.be.null;
			assert(constituentTargetWeights.weights.length == 2);
		} catch (e) {
			expect.fail('Amm constituent map should have been created');
		}
	});

	it('crank aum', async () => {
		let spotOracle = adminClient.getOracleDataForSpotMarket(1);
		console.log(spotOracle);
		const price1 = convertToNumber(spotOracle.price);
		console.log('price', price1);

		await setFeedPriceNoProgram(bankrunContextWrapper, 224.3, spotMarketOracle);

		await adminClient.fetchAccounts();

		spotOracle = adminClient.getOracleDataForSpotMarket(1);
		const price2 = convertToNumber(spotOracle.price);
		assert(price2 > price1);

		const const0TokenAccount = getConstituentVaultPublicKey(
			program.programId,
			lpPoolKey,
			0
		);
		const const1TokenAccount = getConstituentVaultPublicKey(
			program.programId,
			lpPoolKey,
			1
		);

		const const0Key = getConstituentPublicKey(program.programId, lpPoolKey, 0);
		const const1Key = getConstituentPublicKey(program.programId, lpPoolKey, 1);

		// console.log('constituent0TokenAccountInfo', constituent0TokenAccountInfo);

		const oracle0 = adminClient.getOracleDataForSpotMarket(0);
		console.log('oracle0:', convertToNumber(oracle0.price));
		const oracle1 = adminClient.getOracleDataForSpotMarket(1);
		console.log('oracle1:', convertToNumber(oracle1.price));

		const c0TokenBalance = new BN(100_000_000);
		const c1TokenBalance = new BN(100_000_000);

		await overWriteTokenAccountBalance(
			bankrunContextWrapper,
			const0TokenAccount,
			BigInt(c0TokenBalance.toString())
		);
		await overwriteConstituentAccount(
			bankrunContextWrapper,
			adminClient.program,
			const0Key,
			[['tokenBalance', c0TokenBalance]]
		);

		await overWriteTokenAccountBalance(
			bankrunContextWrapper,
			const1TokenAccount,
			BigInt(c1TokenBalance.toString())
		);
		await overwriteConstituentAccount(
			bankrunContextWrapper,
			adminClient.program,
			const1Key,
			[['tokenBalance', c0TokenBalance]]
		);

		// check fields overwritten correctly
		const c0 = (await adminClient.program.account.constituent.fetch(
			const0Key
		)) as ConstituentAccount;
		expect(c0.tokenBalance.toString()).to.equal(c0TokenBalance.toString());

		const c1 = (await adminClient.program.account.constituent.fetch(
			const1Key
		)) as ConstituentAccount;
		expect(c1.tokenBalance.toString()).to.equal(c1TokenBalance.toString());

		const prec = new BN(10).pow(new BN(tokenDecimals));
		console.log(`const0 balance: ${convertToNumber(c0.tokenBalance, prec)}`);
		console.log(`const1 balance: ${convertToNumber(c1.tokenBalance, prec)}`);

		const lpPool1 = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;
		expect(lpPool1.lastAumSlot.toNumber()).to.be.equal(0);

		await adminClient.updateDlpPoolAum(lpPool1, [1, 0]);

		const lpPool2 = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;

		expect(lpPool2.lastAumSlot.toNumber()).to.be.greaterThan(0);
		expect(lpPool2.lastAum.gt(lpPool1.lastAum)).to.be.true;
		console.log(`AUM: ${convertToNumber(lpPool2.lastAum, QUOTE_PRECISION)}`);
	});
});
