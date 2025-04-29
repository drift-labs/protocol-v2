import * as anchor from '@coral-xyz/anchor';
import { expect, assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

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
	LPPool,
} from '../sdk/src';

import {
	getPerpMarketDecoded,
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
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
	let usdcMint;

	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(10 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(10 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	let solUsd: PublicKey;

	const lpPoolName = 'test pool 1';
	const tokenDecimals = 6;
	const lpPoolKey = getLpPoolPublicKey(
		program.programId,
		encodeName(lpPoolName)
	);

	before(async () => {
		const context = await startAnchor(
			'',
			[
				{
					name: 'token_2022',
					programId: new PublicKey(
						'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
					),
				},
			],
			[]
		);

		// @ts-ignore
		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);

		const keypair = new Keypair();
		await bankrunContextWrapper.fundKeypair(keypair, 10 ** 9);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);

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
			spotMarketIndexes: [0],
			oracleInfos: [],
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

		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 224.3);
		const periodicity = new BN(0);

		await adminClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(224 * PEG_PRECISION.toNumber())
		);

		await adminClient.initializePerpMarket(
			1,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(224 * PEG_PRECISION.toNumber())
		);

		await adminClient.initializeLpPool(
			lpPoolName,
			new BN(100_000_000).mul(QUOTE_PRECISION),
			Keypair.generate()
		);
	});

	after(async () => {
		await adminClient.unsubscribe();
	});

	it('can create a new LP Pool', async () => {
		// check LpPool created
		const lpPool = await adminClient.program.account.lpPool.fetch(lpPoolKey);

		// Check amm constituent map exists
		const ammConstituentMapPublicKey = getAmmConstituentMappingPublicKey(
			program.programId,
			lpPoolKey
		);
		const ammConstituentMap =
			(await adminClient.program.account.ammConstituentMapping.fetch(
				ammConstituentMapPublicKey
			)) as AmmConstituentMapping;
		expect(ammConstituentMap).to.not.be.null;
		assert(ammConstituentMap.weights.length == 0);

		// check constituent target weights exists
		const constituentTargetWeightsPublicKey =
			getConstituentTargetWeightsPublicKey(program.programId, lpPoolKey);
		const constituentTargetWeights =
			(await adminClient.program.account.constituentTargetWeights.fetch(
				constituentTargetWeightsPublicKey
			)) as ConstituentTargetWeights;
		expect(constituentTargetWeights).to.not.be.null;
		assert(constituentTargetWeights.weights.length == 0);

		// check mint created correctly
		const mintInfo = await getMint(
			bankrunContextWrapper.connection.toConnection(),
			lpPool.mint as PublicKey
		);
		expect(mintInfo.decimals).to.equal(tokenDecimals);
		expect(Number(mintInfo.supply)).to.equal(0);
		expect(mintInfo.mintAuthority!.toBase58()).to.equal(lpPoolKey.toBase58());
	});

	it('can add constituent to LP Pool', async () => {
		await adminClient.initializeConstituent(
			encodeName(lpPoolName),
			0,
			6,
			new BN(10).mul(PERCENTAGE_PRECISION),
			new BN(1).mul(PERCENTAGE_PRECISION),
			new BN(2).mul(PERCENTAGE_PRECISION)
		);
		const constituentTargetWeightsPublicKey =
			getConstituentTargetWeightsPublicKey(program.programId, lpPoolKey);
		const constituentTargetWeights =
			(await adminClient.program.account.constituentTargetWeights.fetch(
				constituentTargetWeightsPublicKey
			)) as ConstituentTargetWeights;

		const lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPool;

		assert(lpPool.constituents == 1);

		expect(constituentTargetWeights).to.not.be.null;
		assert(constituentTargetWeights.weights.length == 1);
	});

	it('can add amm mapping datum', async () => {
		await adminClient.addInitAmmConstituentMappingData(encodeName(lpPoolName), [
			{
				perpMarketIndex: 0,
				constituentIndex: 0,
				weight: PERCENTAGE_PRECISION,
			},
			{
				perpMarketIndex: 1,
				constituentIndex: 0,
				weight: PERCENTAGE_PRECISION,
			},
		]);
		const ammConstituentMapping = getAmmConstituentMappingPublicKey(
			program.programId,
			lpPoolKey
		);
		const ammMapping =
			(await adminClient.program.account.ammConstituentMapping.fetch(
				ammConstituentMapping
			)) as AmmConstituentMapping;
		expect(ammMapping).to.not.be.null;
		assert(ammMapping.weights.length == 2);
	});

	it('fails adding datum with bad params', async () => {
		// Bad perp market index
		try {
			await adminClient.addInitAmmConstituentMappingData(
				encodeName(lpPoolName),
				[
					{
						perpMarketIndex: 2,
						constituentIndex: 0,
						weight: PERCENTAGE_PRECISION,
					},
				]
			);
			expect.fail('should have failed');
		} catch (e) {
			expect(e.message).to.contain('0x18ab');
		}

		// Bad constituent index
		try {
			await adminClient.addInitAmmConstituentMappingData(
				encodeName(lpPoolName),
				[
					{
						perpMarketIndex: 0,
						constituentIndex: 1,
						weight: PERCENTAGE_PRECISION,
					},
				]
			);
			expect.fail('should have failed');
		} catch (e) {
			expect(e.message).to.contain('0x18ab');
		}
	});

	it('can update constituent target weights', async () => {
		// Override AMM to have a balance
		const perpMarket = adminClient.getPerpMarketAccount(0);
		const raw = await bankrunContextWrapper.connection.getAccountInfo(
			perpMarket.pubkey
		);
		const buf = raw.data;

		buf.writeBigInt64LE(BigInt(1000000000), 304);

		bankrunContextWrapper.context.setAccount(perpMarket.pubkey, {
			executable: raw.executable,
			owner: raw.owner,
			lamports: raw.lamports,
			rentEpoch: raw.rentEpoch,
			data: buf,
		});

		const perpMarketAccountAfter = await getPerpMarketDecoded(
			adminClient,
			bankrunContextWrapper,
			perpMarket.pubkey
		);
		assert(!perpMarketAccountAfter.amm.baseAssetAmountLong.isZero());

		// Override LP pool to have some aum
		const lpraw = await bankrunContextWrapper.connection.getAccountInfo(
			lpPoolKey
		);
		const lpbuf = lpraw.data;

		buf.writeBigInt64LE(BigInt(1000000000), 152);

		bankrunContextWrapper.context.setAccount(lpPoolKey, {
			executable: lpraw.executable,
			owner: lpraw.owner,
			lamports: lpraw.lamports,
			rentEpoch: lpraw.rentEpoch,
			data: lpbuf,
		});

		const ammConstituentMappingPublicKey = getAmmConstituentMappingPublicKey(
			program.programId,
			lpPoolKey
		);

		const ammMapping =
			(await adminClient.program.account.ammConstituentMapping.fetch(
				ammConstituentMappingPublicKey
			)) as AmmConstituentMapping;

		await adminClient.updateDlpConstituentTargetWeights(
			encodeName(lpPoolName),
			[0],
			ammMapping
		);
		const constituentTargetWeightsPublicKey =
			getConstituentTargetWeightsPublicKey(program.programId, lpPoolKey);
		const constituentTargetWeights =
			(await adminClient.program.account.constituentTargetWeights.fetch(
				constituentTargetWeightsPublicKey
			)) as ConstituentTargetWeights;
		expect(constituentTargetWeights).to.not.be.null;
		assert(constituentTargetWeights.weights.length == 1);
	});

	it('can update pool aum', async () => {
		const lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPool;
		assert(lpPool.constituents == 1);

		await adminClient.updateDlpPoolAum(lpPool, [0]);

		// Should fail if we initialize a second constituent and dont pass it in
		await adminClient.initializeConstituent(
			lpPool.name,
			1,
			6,
			new BN(10).mul(PERCENTAGE_PRECISION),
			new BN(1).mul(PERCENTAGE_PRECISION),
			new BN(2).mul(PERCENTAGE_PRECISION)
		);

		try {
			await adminClient.updateDlpPoolAum(lpPool, [0]);
			expect.fail('should have failed');
		} catch (e) {
			assert(e.message.includes('0x18b0'));
		}
	});
});
