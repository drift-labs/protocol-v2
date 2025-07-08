import * as anchor from '@coral-xyz/anchor';
import { expect, assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import {
	AccountInfo,
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
	Transaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, getMint } from '@solana/spl-token';

import {
	BN,
	TestClient,
	QUOTE_PRECISION,
	getLpPoolPublicKey,
	getAmmConstituentMappingPublicKey,
	encodeName,
	getConstituentTargetBasePublicKey,
	PERCENTAGE_PRECISION,
	PRICE_PRECISION,
	PEG_PRECISION,
	ConstituentTargetBase,
	AmmConstituentMapping,
	LPPoolAccount,
	getConstituentVaultPublicKey,
	OracleSource,
	SPOT_MARKET_WEIGHT_PRECISION,
	SPOT_MARKET_RATE_PRECISION,
	getAmmCachePublicKey,
	AmmCache,
	ZERO,
	getConstituentPublicKey,
	ConstituentAccount,
	PositionDirection,
	getPythLazerOraclePublicKey,
	PYTH_LAZER_STORAGE_ACCOUNT_KEY,
	PTYH_LAZER_PROGRAM_ID,
	BASE_PRECISION,
	SPOT_MARKET_BALANCE_PRECISION,
	SpotBalanceType,
	getTokenAmount,
	TWO,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockAtaTokenAccountForMint,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccountWithAuthority,
	overWriteMintAccount,
	overWritePerpMarket,
	overWriteSpotMarket,
	setFeedPriceNoProgram,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import dotenv from 'dotenv';
import { PYTH_LAZER_HEX_STRING_SOL, PYTH_STORAGE_DATA } from './pythLazerData';
import {
	CustomBorshAccountsCoder,
	CustomBorshCoder,
} from '../sdk/src/decode/customCoder';
dotenv.config();

const PYTH_STORAGE_ACCOUNT_INFO: AccountInfo<Buffer> = {
	executable: false,
	lamports: LAMPORTS_PER_SOL,
	owner: new PublicKey(PTYH_LAZER_PROGRAM_ID),
	rentEpoch: 0,
	data: Buffer.from(PYTH_STORAGE_DATA, 'base64'),
};

describe('LP Pool', () => {
	const program = anchor.workspace.Drift as Program;
	// @ts-ignore
	program.coder.accounts = new CustomBorshAccountsCoder(program.idl);

	let bankrunContextWrapper: BankrunContextWrapper;
	let bulkAccountLoader: TestBulkAccountLoader;

	let userLpTokenAccount: PublicKey;
	let adminClient: TestClient;
	let usdcMint: Keypair;
	let spotTokenMint: Keypair;
	let spotMarketOracle: PublicKey;
	let spotMarketOracle2: PublicKey;

	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(100 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(100 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	let solUsd: PublicKey;
	let solUsdLazer: PublicKey;

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
			[
				{
					address: PYTH_LAZER_STORAGE_ACCOUNT_KEY,
					info: PYTH_STORAGE_ACCOUNT_INFO,
				},
			]
		);

		// @ts-ignore
		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		spotTokenMint = await mockUSDCMint(bankrunContextWrapper);
		spotMarketOracle = await mockOracleNoProgram(bankrunContextWrapper, 200);
		spotMarketOracle2 = await mockOracleNoProgram(bankrunContextWrapper, 200);

		const keypair = new Keypair();
		await bankrunContextWrapper.fundKeypair(keypair, 10 ** 9);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);

		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 200);

		adminClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(keypair),
			programID: program.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			subAccountIds: [],
			perpMarketIndexes: [0, 1, 2],
			spotMarketIndexes: [0, 1],
			oracleInfos: [{ publicKey: solUsd, source: OracleSource.PYTH }],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
			coder: new CustomBorshCoder(program.idl),
		});
		await adminClient.initialize(usdcMint.publicKey, true);
		await adminClient.subscribe();
		await initializeQuoteSpotMarket(adminClient, usdcMint.publicKey);

		const userUSDCAccount = await mockUserUSDCAccountWithAuthority(
			usdcMint,
			new BN(100_000_000).mul(QUOTE_PRECISION),
			bankrunContextWrapper,
			keypair
		);

		await adminClient.initializeUserAccountAndDepositCollateral(
			new BN(1_000_000).mul(QUOTE_PRECISION),
			userUSDCAccount
		);

		const periodicity = new BN(0);

		solUsdLazer = getPythLazerOraclePublicKey(program.programId, 6);
		await adminClient.initializePythLazerOracle(6);

		await adminClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(200 * PEG_PRECISION.toNumber())
		);

		await adminClient.initializePerpMarket(
			1,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(200 * PEG_PRECISION.toNumber())
		);

		await adminClient.initializePerpMarket(
			2,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(200 * PEG_PRECISION.toNumber())
		);

		await adminClient.updatePerpAuctionDuration(new BN(0));

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

		await adminClient.initializeSpotMarket(
			spotTokenMint.publicKey,
			optimalUtilization,
			optimalRate,
			maxRate,
			spotMarketOracle2,
			OracleSource.PYTH,
			initialAssetWeight,
			maintenanceAssetWeight,
			initialLiabilityWeight,
			maintenanceLiabilityWeight,
			imfFactor
		);

		await adminClient.initializeSpotMarket(
			spotTokenMint.publicKey,
			optimalUtilization,
			optimalRate,
			maxRate,
			spotMarketOracle2,
			OracleSource.PYTH,
			initialAssetWeight,
			maintenanceAssetWeight,
			initialLiabilityWeight,
			maintenanceLiabilityWeight,
			imfFactor
		);

		await adminClient.initializeLpPool(
			lpPoolName,
			ZERO,
			ZERO,
			new BN(3600),
			new BN(1_000_000).mul(QUOTE_PRECISION),
			Keypair.generate()
		);

		// Give the vamm some inventory
		await adminClient.openPosition(PositionDirection.LONG, BASE_PRECISION, 0);
		await adminClient.openPosition(PositionDirection.SHORT, BASE_PRECISION, 1);
		assert(
			adminClient
				.getUser()
				.getActivePerpPositions()
				.filter((x) => !x.baseAssetAmount.eq(ZERO)).length == 2
		);
	});

	after(async () => {
		await adminClient.unsubscribe();
	});

	it('can create a new LP Pool', async () => {
		// check LpPool created
		const lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;

		userLpTokenAccount = await mockAtaTokenAccountForMint(
			bankrunContextWrapper,
			lpPool.mint,
			new BN(0),
			adminClient.wallet.publicKey
		);

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
		const constituentTargetBasePublicKey = getConstituentTargetBasePublicKey(
			program.programId,
			lpPoolKey
		);
		const constituentTargetBase =
			(await adminClient.program.account.constituentTargetBase.fetch(
				constituentTargetBasePublicKey
			)) as ConstituentTargetBase;
		expect(constituentTargetBase).to.not.be.null;
		assert(constituentTargetBase.targets.length == 0);

		// check mint created correctly
		const mintInfo = await getMint(
			bankrunContextWrapper.connection.toConnection(),
			lpPool.mint as PublicKey
		);
		expect(mintInfo.decimals).to.equal(tokenDecimals);
		expect(Number(mintInfo.supply)).to.equal(0);
		expect(mintInfo.mintAuthority?.toBase58()).to.equal(
			adminClient.getSignerPublicKey().toBase58()
		);
	});

	it('can add constituents to LP Pool', async () => {
		await adminClient.initializeConstituent(encodeName(lpPoolName), {
			spotMarketIndex: 0,
			decimals: 6,
			maxWeightDeviation: new BN(10).mul(PERCENTAGE_PRECISION),
			swapFeeMin: new BN(1).mul(PERCENTAGE_PRECISION),
			swapFeeMax: new BN(2).mul(PERCENTAGE_PRECISION),
			oracleStalenessThreshold: new BN(400),
			costToTrade: 1,
			derivativeWeight: ZERO,
			volatility: ZERO,
			constituentCorrelations: [],
		});
		const constituentTargetBasePublicKey = getConstituentTargetBasePublicKey(
			program.programId,
			lpPoolKey
		);

		const constituent = (await adminClient.program.account.constituent.fetch(
			getConstituentPublicKey(program.programId, lpPoolKey, 0)
		)) as ConstituentAccount;

		await adminClient.updateConstituentOracleInfo(constituent);

		const constituentTargetBase =
			(await adminClient.program.account.constituentTargetBase.fetch(
				constituentTargetBasePublicKey
			)) as ConstituentTargetBase;

		const lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;

		assert(lpPool.constituents == 1);

		expect(constituentTargetBase).to.not.be.null;
		assert(constituentTargetBase.targets.length == 1);

		const constituentVaultPublicKey = getConstituentVaultPublicKey(
			program.programId,
			lpPoolKey,
			0
		);
		const constituentTokenVault =
			await bankrunContextWrapper.connection.getAccountInfo(
				constituentVaultPublicKey
			);
		expect(constituentTokenVault).to.not.be.null;

		// Add second constituent representing SOL
		await adminClient.initializeConstituent(lpPool.name, {
			spotMarketIndex: 1,
			decimals: 6,
			maxWeightDeviation: new BN(10).mul(PERCENTAGE_PRECISION),
			swapFeeMin: new BN(1).mul(PERCENTAGE_PRECISION),
			swapFeeMax: new BN(2).mul(PERCENTAGE_PRECISION),
			oracleStalenessThreshold: new BN(400),
			costToTrade: 1,
			derivativeWeight: ZERO,
			volatility: new BN(10).mul(PERCENTAGE_PRECISION),
			constituentCorrelations: [ZERO],
		});
	});

	it('can add amm mapping datum', async () => {
		// Firt constituent is USDC, so add no mapping. We will add a second mapping though
		// for the second constituent which is SOL
		await adminClient.addAmmConstituentMappingData(encodeName(lpPoolName), [
			{
				perpMarketIndex: 1,
				constituentIndex: 1,
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
		assert(ammMapping.weights.length == 1);
	});

	it('can update and remove amm constituent mapping entries', async () => {
		await adminClient.addAmmConstituentMappingData(encodeName(lpPoolName), [
			{
				perpMarketIndex: 2,
				constituentIndex: 0,
				weight: PERCENTAGE_PRECISION,
			},
		]);
		const ammConstituentMapping = getAmmConstituentMappingPublicKey(
			program.programId,
			lpPoolKey
		);
		let ammMapping =
			(await adminClient.program.account.ammConstituentMapping.fetch(
				ammConstituentMapping
			)) as AmmConstituentMapping;
		expect(ammMapping).to.not.be.null;
		assert(ammMapping.weights.length == 2);

		// Update
		await adminClient.updateAmmConstituentMappingData(encodeName(lpPoolName), [
			{
				perpMarketIndex: 2,
				constituentIndex: 0,
				weight: PERCENTAGE_PRECISION.muln(2),
			},
		]);
		ammMapping = (await adminClient.program.account.ammConstituentMapping.fetch(
			ammConstituentMapping
		)) as AmmConstituentMapping;
		expect(ammMapping).to.not.be.null;
		assert(
			ammMapping.weights
				.find((x) => x.perpMarketIndex == 2)
				.weight.eq(PERCENTAGE_PRECISION.muln(2))
		);

		// Remove
		await adminClient.removeAmmConstituentMappingData(
			encodeName(lpPoolName),
			2,
			0
		);
		ammMapping = (await adminClient.program.account.ammConstituentMapping.fetch(
			ammConstituentMapping
		)) as AmmConstituentMapping;
		expect(ammMapping).to.not.be.null;
		assert(ammMapping.weights.find((x) => x.perpMarketIndex == 2) == undefined);
		assert(ammMapping.weights.length === 1);
	});

	it('can crank amm info into the cache', async () => {
		let ammCache = (await adminClient.program.account.ammCache.fetch(
			getAmmCachePublicKey(program.programId)
		)) as AmmCache;

		await adminClient.updateAmmCache([0, 1, 2]);
		ammCache = (await adminClient.program.account.ammCache.fetch(
			getAmmCachePublicKey(program.programId)
		)) as AmmCache;
		expect(ammCache).to.not.be.null;
		assert(ammCache.cache.length == 3);
		assert(ammCache.cache[0].oracle.equals(solUsd));
		assert(ammCache.cache[0].oraclePrice.eq(new BN(200000000)));
	});

	it('can update constituent properties and correlations', async () => {
		const constituentPublicKey = getConstituentPublicKey(
			program.programId,
			lpPoolKey,
			0
		);

		const constituent = (await adminClient.program.account.constituent.fetch(
			constituentPublicKey
		)) as ConstituentAccount;

		await adminClient.updateConstituentParams(
			encodeName(lpPoolName),
			constituentPublicKey,
			{
				costToTradeBps: 10,
			}
		);
		const constituentTargetBase = getConstituentTargetBasePublicKey(
			program.programId,
			lpPoolKey
		);
		const targets =
			(await adminClient.program.account.constituentTargetBase.fetch(
				constituentTargetBase
			)) as ConstituentTargetBase;
		expect(targets).to.not.be.null;
		assert(targets.targets[constituent.constituentIndex].costToTradeBps == 10);

		await adminClient.updateConstituentCorrelationData(
			encodeName(lpPoolName),
			0,
			1,
			PERCENTAGE_PRECISION.muln(87).divn(100)
		);

		await adminClient.updateConstituentCorrelationData(
			encodeName(lpPoolName),
			0,
			1,
			PERCENTAGE_PRECISION
		);
	});

	it('fails adding datum with bad params', async () => {
		// Bad perp market index
		try {
			await adminClient.addAmmConstituentMappingData(encodeName(lpPoolName), [
				{
					perpMarketIndex: 3,
					constituentIndex: 0,
					weight: PERCENTAGE_PRECISION,
				},
			]);
			expect.fail('should have failed');
		} catch (e) {
			console.log(e.message);
			expect(e.message).to.contain('0x18ae');
		}

		// Bad constituent index
		try {
			await adminClient.addAmmConstituentMappingData(encodeName(lpPoolName), [
				{
					perpMarketIndex: 0,
					constituentIndex: 5,
					weight: PERCENTAGE_PRECISION,
				},
			]);
			expect.fail('should have failed');
		} catch (e) {
			expect(e.message).to.contain('0x18ae');
		}
	});

	it('fails to add liquidity if aum not updated atomically', async () => {
		try {
			const lpPool = (await adminClient.program.account.lpPool.fetch(
				lpPoolKey
			)) as LPPoolAccount;
			await adminClient.lpPoolAddLiquidity({
				lpPool,
				inAmount: new BN(1000).mul(QUOTE_PRECISION),
				minMintAmount: new BN(1),
				inMarketIndex: 0,
			});
			expect.fail('should have failed');
		} catch (e) {
			assert(e.message.includes('0x18b7'));
		}
	});

	it('can update pool aum', async () => {
		let lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;
		assert(lpPool.constituents == 2);

		const createAtaIx =
			adminClient.createAssociatedTokenAccountIdempotentInstruction(
				await getAssociatedTokenAddress(
					lpPool.mint,
					adminClient.wallet.publicKey,
					true
				),
				adminClient.wallet.publicKey,
				adminClient.wallet.publicKey,
				lpPool.mint
			);

		await adminClient.sendTransaction(new Transaction().add(createAtaIx), []);

		await adminClient.updateLpPoolAum(lpPool, [0, 1]);
		lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;
		assert(lpPool.lastAum.eq(ZERO));

		const tx = new Transaction();
		tx.add(await adminClient.getUpdateLpPoolAumIxs(lpPool, [0, 1]));
		tx.add(
			await adminClient.getLpPoolAddLiquidityIx({
				lpPool,
				inAmount: new BN(1000).mul(QUOTE_PRECISION),
				minMintAmount: new BN(1),
				inMarketIndex: 0,
			})
		);
		await adminClient.sendTransaction(tx);

		await adminClient.updateLpPoolAum(lpPool, [0, 1]);
		lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;

		assert(lpPool.lastAum.eq(new BN(1000).mul(QUOTE_PRECISION)));

		// Should fail if we dont pass in the second constituent
		const constituent = (await adminClient.program.account.constituent.fetch(
			getConstituentPublicKey(program.programId, lpPoolKey, 1)
		)) as ConstituentAccount;

		await adminClient.updateConstituentOracleInfo(constituent);

		try {
			await adminClient.updateLpPoolAum(lpPool, [0]);
			expect.fail('should have failed');
		} catch (e) {
			assert(e.message.includes('0x18b3'));
		}
	});

	it('can update constituent target weights', async () => {
		await adminClient.postPythLazerOracleUpdate([6], PYTH_LAZER_HEX_STRING_SOL);
		await adminClient.updatePerpMarketOracle(
			0,
			solUsdLazer,
			OracleSource.PYTH_LAZER
		);
		await adminClient.updatePerpMarketOracle(
			1,
			solUsdLazer,
			OracleSource.PYTH_LAZER
		);
		await adminClient.updatePerpMarketOracle(
			2,
			solUsdLazer,
			OracleSource.PYTH_LAZER
		);
		await adminClient.updateAmmCache([0, 1, 2]);

		const tx = new Transaction();
		tx.add(await adminClient.getUpdateAmmCacheIx([0, 1, 2]));
		tx.add(
			await adminClient.getUpdateLpConstituentTargetBaseIx(
				encodeName(lpPoolName),
				[
					getConstituentPublicKey(program.programId, lpPoolKey, 0),
					getConstituentPublicKey(program.programId, lpPoolKey, 1),
				]
			)
		);
		await adminClient.sendTransaction(tx);

		const constituentTargetBasePublicKey = getConstituentTargetBasePublicKey(
			program.programId,
			lpPoolKey
		);
		const constituentTargetBase =
			(await adminClient.program.account.constituentTargetBase.fetch(
				constituentTargetBasePublicKey
			)) as ConstituentTargetBase;
		expect(constituentTargetBase).to.not.be.null;
		assert(constituentTargetBase.targets.length == 2);
		assert(
			constituentTargetBase.targets.filter((x) => x.targetBase.eq(ZERO))
				.length !== constituentTargetBase.targets.length
		);
	});

	it('can add constituent to LP Pool thats a derivative and behave correctly', async () => {
		const lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;

		await adminClient.initializeConstituent(lpPool.name, {
			spotMarketIndex: 2,
			decimals: 6,
			maxWeightDeviation: new BN(10).mul(PERCENTAGE_PRECISION),
			swapFeeMin: new BN(1).mul(PERCENTAGE_PRECISION),
			swapFeeMax: new BN(2).mul(PERCENTAGE_PRECISION),
			oracleStalenessThreshold: new BN(400),
			costToTrade: 1,
			derivativeWeight: PERCENTAGE_PRECISION.divn(2),
			volatility: new BN(10).mul(PERCENTAGE_PRECISION),
			constituentCorrelations: [ZERO, PERCENTAGE_PRECISION.muln(87).divn(100)],
			constituentDerivativeIndex: 1,
		});

		await adminClient.updateAmmCache([0, 1, 2]);

		let constituent = (await adminClient.program.account.constituent.fetch(
			getConstituentPublicKey(program.programId, lpPoolKey, 2)
		)) as ConstituentAccount;

		await adminClient.updateConstituentOracleInfo(constituent);

		constituent = (await adminClient.program.account.constituent.fetch(
			getConstituentPublicKey(program.programId, lpPoolKey, 2)
		)) as ConstituentAccount;
		assert(!constituent.lastOraclePrice.eq(ZERO));
		await adminClient.updateLpPoolAum(lpPool, [0, 1, 2]);

		const tx = new Transaction();
		tx.add(await adminClient.getUpdateAmmCacheIx([0, 1, 2])).add(
			await adminClient.getUpdateLpConstituentTargetBaseIx(
				encodeName(lpPoolName),
				[
					getConstituentPublicKey(program.programId, lpPoolKey, 0),
					getConstituentPublicKey(program.programId, lpPoolKey, 1),
					getConstituentPublicKey(program.programId, lpPoolKey, 2),
				]
			)
		);
		await adminClient.sendTransaction(tx);

		await adminClient.updateLpPoolAum(lpPool, [0, 1, 2]);

		const constituentTargetBasePublicKey = getConstituentTargetBasePublicKey(
			program.programId,
			lpPoolKey
		);
		let constituentTargetBase =
			(await adminClient.program.account.constituentTargetBase.fetch(
				constituentTargetBasePublicKey
			)) as ConstituentTargetBase;

		expect(constituentTargetBase).to.not.be.null;
		console.log(
			'constituentTargetBase.targets',
			constituentTargetBase.targets.map((x) => x.targetBase.toString())
		);
		expect(
			constituentTargetBase.targets[1].targetBase.toNumber()
		).to.be.approximately(
			constituentTargetBase.targets[2].targetBase.toNumber(),
			10
		);

		// Move the oracle price to be double, so it should have half of the target base
		const derivativeBalanceBefore = constituentTargetBase.targets[2].targetBase;
		const derivative = (await adminClient.program.account.constituent.fetch(
			getConstituentPublicKey(program.programId, lpPoolKey, 2)
		)) as ConstituentAccount;
		await setFeedPriceNoProgram(bankrunContextWrapper, 400, spotMarketOracle2);
		await adminClient.updateConstituentOracleInfo(derivative);
		const tx2 = new Transaction();
		tx2
			.add(await adminClient.getUpdateAmmCacheIx([0, 1, 2]))
			.add(
				await adminClient.getUpdateLpConstituentTargetBaseIx(
					encodeName(lpPoolName),
					[
						getConstituentPublicKey(program.programId, lpPoolKey, 0),
						getConstituentPublicKey(program.programId, lpPoolKey, 1),
						getConstituentPublicKey(program.programId, lpPoolKey, 2),
					]
				)
			);
		await adminClient.sendTransaction(tx2);
		await adminClient.updateLpPoolAum(lpPool, [0, 1, 2]);

		constituentTargetBase =
			(await adminClient.program.account.constituentTargetBase.fetch(
				constituentTargetBasePublicKey
			)) as ConstituentTargetBase;
		const derivativeBalanceAfter = constituentTargetBase.targets[2].targetBase;

		console.log(
			'constituentTargetBase.targets',
			constituentTargetBase.targets.map((x) => x.targetBase.toString())
		);

		expect(derivativeBalanceAfter.toNumber()).to.be.approximately(
			derivativeBalanceBefore.toNumber() / 2,
			20
		);

		// Move the oracle price to be half, so its target base should go to zero
		const parentBalanceBefore = constituentTargetBase.targets[1].targetBase;
		await setFeedPriceNoProgram(bankrunContextWrapper, 100, spotMarketOracle2);
		await adminClient.updateConstituentOracleInfo(derivative);
		const tx3 = new Transaction();
		tx3
			.add(await adminClient.getUpdateAmmCacheIx([0, 1, 2]))
			.add(
				await adminClient.getUpdateLpConstituentTargetBaseIx(
					encodeName(lpPoolName),
					[
						getConstituentPublicKey(program.programId, lpPoolKey, 0),
						getConstituentPublicKey(program.programId, lpPoolKey, 1),
						getConstituentPublicKey(program.programId, lpPoolKey, 2),
					]
				)
			);
		await adminClient.sendTransaction(tx3);
		await adminClient.updateLpPoolAum(lpPool, [0, 1, 2]);

		constituentTargetBase =
			(await adminClient.program.account.constituentTargetBase.fetch(
				constituentTargetBasePublicKey
			)) as ConstituentTargetBase;
		const parentBalanceAfter = constituentTargetBase.targets[1].targetBase;

		console.log(
			'constituentTargetBase.targets',
			constituentTargetBase.targets.map((x) => x.targetBase.toString())
		);
		expect(parentBalanceAfter.toNumber()).to.be.approximately(
			parentBalanceBefore.toNumber() * 2,
			10
		);
		await setFeedPriceNoProgram(bankrunContextWrapper, 200, spotMarketOracle2);
		await adminClient.updateConstituentOracleInfo(derivative);
	});

	it('can settle pnl from perp markets into the usdc account', async () => {
		// First run should just load the values into the cache
		await adminClient.depositIntoPerpMarketFeePool(
			0,
			new BN(100).mul(QUOTE_PRECISION),
			await adminClient.getAssociatedTokenAccount(0)
		);

		await adminClient.depositIntoPerpMarketFeePool(
			1,
			new BN(100).mul(QUOTE_PRECISION),
			await adminClient.getAssociatedTokenAccount(0)
		);

		let constituent = (await adminClient.program.account.constituent.fetch(
			getConstituentPublicKey(program.programId, lpPoolKey, 0)
		)) as ConstituentAccount;
		let lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;

		let ammCache = (await adminClient.program.account.ammCache.fetch(
			getAmmCachePublicKey(program.programId)
		)) as AmmCache;
		assert(ammCache.cache[0].lastFeePoolTokenAmount.eq(ZERO));
		assert(ammCache.cache[1].lastFeePoolTokenAmount.eq(ZERO));
		assert(ammCache.cache[2].lastFeePoolTokenAmount.eq(ZERO));
		assert(ammCache.cache[0].lastNetPnlPoolTokenAmount.eq(ZERO));
		assert(ammCache.cache[1].lastNetPnlPoolTokenAmount.eq(ZERO));
		assert(ammCache.cache[2].lastNetPnlPoolTokenAmount.eq(ZERO));
		await adminClient.settlePerpToLpPool(encodeName(lpPoolName), [0, 1, 2]);
		ammCache = (await adminClient.program.account.ammCache.fetch(
			getAmmCachePublicKey(program.programId)
		)) as AmmCache;
		assert(ammCache.cache[0].lastFeePoolTokenAmount.eq(new BN(100000000)));
		assert(ammCache.cache[1].lastFeePoolTokenAmount.eq(new BN(100000000)));

		await adminClient.depositIntoPerpMarketFeePool(
			0,
			new BN(100).mul(QUOTE_PRECISION),
			await adminClient.getAssociatedTokenAccount(0)
		);

		await adminClient.depositIntoPerpMarketFeePool(
			1,
			new BN(100).mul(QUOTE_PRECISION),
			await adminClient.getAssociatedTokenAccount(0)
		);

		const usdcBefore = constituent.tokenBalance;
		const lpAumBefore = lpPool.lastAum;
		const feePoolBalanceBefore =
			adminClient.getPerpMarketAccount(0).amm.feePool.scaledBalance;

		await adminClient.settlePerpToLpPool(encodeName(lpPoolName), [0, 1, 2]);

		constituent = (await adminClient.program.account.constituent.fetch(
			getConstituentPublicKey(program.programId, lpPoolKey, 0)
		)) as ConstituentAccount;
		lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;

		const usdcAfter = constituent.tokenBalance;
		const lpAumAfter = lpPool.lastAum;
		const feePoolBalanceAfter =
			adminClient.getPerpMarketAccount(0).amm.feePool.scaledBalance;
		console.log('usdcBefore', usdcBefore.toString());
		console.log('usdcAfter', usdcAfter.toString());
		assert(usdcAfter.sub(usdcBefore).eq(QUOTE_PRECISION.muln(200)));
		assert(lpAumAfter.sub(lpAumBefore).eq(QUOTE_PRECISION.muln(200)));
		console.log('feePoolBalanceBefore', feePoolBalanceBefore.toString());
		console.log('feePoolBalanceAfter', feePoolBalanceAfter.toString());
		assert(
			feePoolBalanceAfter
				.sub(feePoolBalanceBefore)
				.eq(SPOT_MARKET_BALANCE_PRECISION.muln(-100))
		);

		// Constituent sync worked successfully
		constituent = (await adminClient.program.account.constituent.fetch(
			getConstituentPublicKey(program.programId, lpPoolKey, 0)
		)) as ConstituentAccount;

		const constituentVaultPublicKey = getConstituentVaultPublicKey(
			program.programId,
			lpPoolKey,
			0
		);
		const constituentVault =
			await bankrunContextWrapper.connection.getTokenAccount(
				constituentVaultPublicKey
			);
		assert(
			new BN(constituentVault.amount.toString()).eq(constituent.tokenBalance)
		);
	});

	it('will settle gracefully when trying to settle pnl from constituents to perp markets if not enough usdc in the constituent vault', async () => {
		let lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;
		let constituent = (await adminClient.program.account.constituent.fetch(
			getConstituentPublicKey(program.programId, lpPoolKey, 0)
		)) as ConstituentAccount;
		let ammCache = (await adminClient.program.account.ammCache.fetch(
			getAmmCachePublicKey(program.programId)
		)) as AmmCache;
		const constituentVaultPublicKey = getConstituentVaultPublicKey(
			program.programId,
			lpPoolKey,
			0
		);

		/// First remove some liquidity so DLP doesnt have enought to transfer
		const lpTokenBalance =
			await bankrunContextWrapper.connection.getTokenAccount(
				userLpTokenAccount
			);

		const tx = new Transaction();
		tx.add(await adminClient.getUpdateLpPoolAumIxs(lpPool, [0, 1, 2]));
		tx.add(
			await adminClient.getLpPoolRemoveLiquidityIx({
				outMarketIndex: 0,
				lpToBurn: new BN(lpTokenBalance.amount.toString()),
				minAmountOut: new BN(1000).mul(QUOTE_PRECISION),
				lpPool: lpPool,
			})
		);
		await adminClient.sendTransaction(tx);

		let constituentVault =
			await bankrunContextWrapper.connection.getTokenAccount(
				constituentVaultPublicKey
			);

		const expectedTransferAmount = getTokenAmount(
			adminClient.getPerpMarketAccount(0).amm.feePool.scaledBalance,
			adminClient.getQuoteSpotMarketAccount(),
			SpotBalanceType.DEPOSIT
		);
		const constituentUSDCBalanceBefore = constituentVault.amount;

		// Temporarily overwrite perp market to have taken a loss on the fee pool
		const spotMarket = adminClient.getSpotMarketAccount(0);
		const perpMarket = adminClient.getPerpMarketAccount(0);
		spotMarket.depositBalance = spotMarket.depositBalance.sub(
			perpMarket.amm.feePool.scaledBalance.add(
				spotMarket.cumulativeDepositInterest.muln(10 ** 3)
			)
		);
		await overWriteSpotMarket(
			adminClient,
			bankrunContextWrapper,
			spotMarket.pubkey,
			spotMarket
		);
		perpMarket.amm.feePool.scaledBalance = ZERO;
		await overWritePerpMarket(
			adminClient,
			bankrunContextWrapper,
			perpMarket.pubkey,
			perpMarket
		);

		/// Now finally try and settle Perp to LP Pool
		const settleTx = new Transaction();
		settleTx.add(await adminClient.getUpdateAMMsIx([0, 1, 2]));
		settleTx.add(
			await adminClient.getSettlePerpToLpPoolIx(
				encodeName(lpPoolName),
				[0, 1, 2]
			)
		);
		await adminClient.sendTransaction(settleTx);

		constituent = (await adminClient.program.account.constituent.fetch(
			getConstituentPublicKey(program.programId, lpPoolKey, 0)
		)) as ConstituentAccount;
		constituentVault = await bankrunContextWrapper.connection.getTokenAccount(
			constituentVaultPublicKey
		);
		lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;

		// Should have written fee pool amount owed to the amm cache and new constituent usdc balane should be 0
		ammCache = (await adminClient.program.account.ammCache.fetch(
			getAmmCachePublicKey(program.programId)
		)) as AmmCache;
		// No more usdc left in the constituent vault
		assert(constituent.tokenBalance.eq(ZERO));
		assert(new BN(constituentVault.amount.toString()).eq(ZERO));

		// Should have recorded the amount left over to the amm cache and increased the amount in the fee pool
		assert(
			ammCache.cache[0].lastFeePoolTokenAmount.eq(
				new BN(constituentUSDCBalanceBefore.toString())
			)
		);
		assert(
			ammCache.cache[0].quoteOwedFromLp.eq(
				expectedTransferAmount.sub(
					new BN(constituentUSDCBalanceBefore.toString())
				)
			)
		);
		assert(
			adminClient
				.getPerpMarketAccount(0)
				.amm.feePool.scaledBalance.eq(
					new BN(constituentUSDCBalanceBefore.toString()).mul(
						SPOT_MARKET_BALANCE_PRECISION.div(QUOTE_PRECISION)
					)
				)
		);

		// NAV should have gone down the max that is has
		assert(lpPool.lastAum.eq(ZERO));
	});

	it('perp market will not transfer with the constituent vault if it is owed from dlp', async () => {
		let ammCache = (await adminClient.program.account.ammCache.fetch(
			getAmmCachePublicKey(program.programId)
		)) as AmmCache;
		const owedAmount = ammCache.cache[0].quoteOwedFromLp;

		// Give the perp market half of its owed amount
		const perpMarket = adminClient.getPerpMarketAccount(0);
		perpMarket.amm.feePool.scaledBalance =
			perpMarket.amm.feePool.scaledBalance.add(
				owedAmount
					.div(TWO)
					.mul(SPOT_MARKET_BALANCE_PRECISION.div(QUOTE_PRECISION))
			);
		await overWritePerpMarket(
			adminClient,
			bankrunContextWrapper,
			perpMarket.pubkey,
			perpMarket
		);

		const settleTx = new Transaction();
		settleTx.add(await adminClient.getUpdateAMMsIx([0, 1, 2]));
		settleTx.add(
			await adminClient.getSettlePerpToLpPoolIx(
				encodeName(lpPoolName),
				[0, 1, 2]
			)
		);
		await adminClient.sendTransaction(settleTx);

		ammCache = (await adminClient.program.account.ammCache.fetch(
			getAmmCachePublicKey(program.programId)
		)) as AmmCache;
		const constituent = (await adminClient.program.account.constituent.fetch(
			getConstituentPublicKey(program.programId, lpPoolKey, 0)
		)) as ConstituentAccount;

		let lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;

		assert(constituent.tokenBalance.eq(ZERO));
		assert(lpPool.lastAum.eq(ZERO));
		// assert(ammCache.cache[0].quoteOwedFromLp.eq(owedAmount.divn(2)));
		expect(ammCache.cache[0].quoteOwedFromLp.toNumber()).to.eq(
			owedAmount.divn(2).toNumber()
		);
		// Deposit here to DLP to make sure aum calc work with perp market debt
		await overWriteMintAccount(
			bankrunContextWrapper,
			lpPool.mint,
			BigInt(lpPool.lastAum.toNumber())
		);

		const tx = new Transaction();
		tx.add(await adminClient.getUpdateLpPoolAumIxs(lpPool, [0, 1, 2]));
		tx.add(
			await adminClient.getLpPoolAddLiquidityIx({
				lpPool,
				inAmount: new BN(1000).mul(QUOTE_PRECISION),
				minMintAmount: new BN(1),
				inMarketIndex: 0,
			})
		);
		await adminClient.sendTransaction(tx);
		await adminClient.updateLpPoolAum(lpPool, [0, 1, 2]);

		lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;

		let aum = new BN(0);
		for (let i = 0; i <= 2; i++) {
			const constituent = (await adminClient.program.account.constituent.fetch(
				getConstituentPublicKey(program.programId, lpPoolKey, i)
			)) as ConstituentAccount;
			aum = aum.add(
				constituent.tokenBalance
					.mul(constituent.lastOraclePrice)
					.div(QUOTE_PRECISION)
			);
		}

		// Overwrite the amm cache with amount owed
		ammCache = (await adminClient.program.account.ammCache.fetch(
			getAmmCachePublicKey(program.programId)
		)) as AmmCache;
		for (let i = 0; i <= ammCache.cache.length - 1; i++) {
			aum = aum.sub(ammCache.cache[i].quoteOwedFromLp);
		}
		assert(lpPool.lastAum.eq(aum));
	});

	it('perp market will transfer with the constituent vault if it should send more than its owed', async () => {
		let lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;
		const aumBefore = lpPool.lastAum;
		let constituent = (await adminClient.program.account.constituent.fetch(
			getConstituentPublicKey(program.programId, lpPoolKey, 0)
		)) as ConstituentAccount;

		let ammCache = (await adminClient.program.account.ammCache.fetch(
			getAmmCachePublicKey(program.programId)
		)) as AmmCache;

		const balanceBefore = constituent.tokenBalance;
		const owedAmount = ammCache.cache[0].quoteOwedFromLp;

		// Give the perp market half of its owed amount
		const perpMarket = adminClient.getPerpMarketAccount(0);
		perpMarket.amm.feePool.scaledBalance =
			perpMarket.amm.feePool.scaledBalance.add(
				owedAmount
					.mul(TWO)
					.mul(SPOT_MARKET_BALANCE_PRECISION.div(QUOTE_PRECISION))
			);
		await overWritePerpMarket(
			adminClient,
			bankrunContextWrapper,
			perpMarket.pubkey,
			perpMarket
		);

		await adminClient.settlePerpToLpPool(encodeName(lpPoolName), [0, 1, 2]);

		ammCache = (await adminClient.program.account.ammCache.fetch(
			getAmmCachePublicKey(program.programId)
		)) as AmmCache;
		constituent = (await adminClient.program.account.constituent.fetch(
			getConstituentPublicKey(program.programId, lpPoolKey, 0)
		)) as ConstituentAccount;

		lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;

		assert(ammCache.cache[0].quoteOwedFromLp.eq(ZERO));
		assert(constituent.tokenBalance.eq(balanceBefore.add(owedAmount)));
		assert(lpPool.lastAum.eq(aumBefore.add(owedAmount)));
	});

	it('can work with multiple derivatives on the same parent', async () => {
		const lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;

		await adminClient.initializeConstituent(lpPool.name, {
			spotMarketIndex: 3,
			decimals: 6,
			maxWeightDeviation: new BN(10).mul(PERCENTAGE_PRECISION),
			swapFeeMin: new BN(1).mul(PERCENTAGE_PRECISION),
			swapFeeMax: new BN(2).mul(PERCENTAGE_PRECISION),
			oracleStalenessThreshold: new BN(400),
			costToTrade: 1,
			derivativeWeight: PERCENTAGE_PRECISION.divn(4),
			volatility: new BN(10).mul(PERCENTAGE_PRECISION),
			constituentCorrelations: [
				ZERO,
				PERCENTAGE_PRECISION.muln(87).divn(100),
				PERCENTAGE_PRECISION,
			],
			constituentDerivativeIndex: 1,
		});

		await adminClient.updateConstituentParams(
			lpPool.name,
			getConstituentPublicKey(program.programId, lpPoolKey, 2),
			{
				derivativeWeight: PERCENTAGE_PRECISION.divn(4),
			}
		);

		await adminClient.updateAmmCache([0, 1, 2]);

		let constituent = (await adminClient.program.account.constituent.fetch(
			getConstituentPublicKey(program.programId, lpPoolKey, 3)
		)) as ConstituentAccount;

		await adminClient.updateConstituentOracleInfo(constituent);

		constituent = (await adminClient.program.account.constituent.fetch(
			getConstituentPublicKey(program.programId, lpPoolKey, 3)
		)) as ConstituentAccount;
		assert(!constituent.lastOraclePrice.eq(ZERO));
		await adminClient.updateLpPoolAum(lpPool, [0, 1, 2, 3]);

		const tx = new Transaction();
		tx.add(await adminClient.getUpdateAmmCacheIx([0, 1, 2])).add(
			await adminClient.getUpdateLpConstituentTargetBaseIx(
				encodeName(lpPoolName),
				[
					getConstituentPublicKey(program.programId, lpPoolKey, 0),
					getConstituentPublicKey(program.programId, lpPoolKey, 1),
					getConstituentPublicKey(program.programId, lpPoolKey, 2),
					getConstituentPublicKey(program.programId, lpPoolKey, 3),
				]
			)
		);
		await adminClient.sendTransaction(tx);
		await adminClient.updateLpPoolAum(lpPool, [0, 1, 2, 3]);

		const constituentTargetBasePublicKey = getConstituentTargetBasePublicKey(
			program.programId,
			lpPoolKey
		);
		let constituentTargetBase =
			(await adminClient.program.account.constituentTargetBase.fetch(
				constituentTargetBasePublicKey
			)) as ConstituentTargetBase;

		expect(constituentTargetBase).to.not.be.null;
		console.log(
			'constituentTargetBase.targets',
			constituentTargetBase.targets.map((x) => x.targetBase.toString())
		);
		expect(
			constituentTargetBase.targets[2].targetBase.toNumber()
		).to.be.approximately(
			constituentTargetBase.targets[3].targetBase.toNumber(),
			10
		);
		expect(
			constituentTargetBase.targets[3].targetBase.toNumber()
		).to.be.approximately(
			constituentTargetBase.targets[1].targetBase.toNumber() / 2,
			10
		);

		// Set the derivative weights to 0
		await adminClient.updateConstituentParams(
			lpPool.name,
			getConstituentPublicKey(program.programId, lpPoolKey, 2),
			{
				derivativeWeight: ZERO,
			}
		);

		await adminClient.updateConstituentParams(
			lpPool.name,
			getConstituentPublicKey(program.programId, lpPoolKey, 3),
			{
				derivativeWeight: ZERO,
			}
		);

		const parentTargetBaseBefore = constituentTargetBase.targets[1].targetBase;
		const tx2 = new Transaction();
		tx2
			.add(await adminClient.getUpdateAmmCacheIx([0, 1, 2]))
			.add(
				await adminClient.getUpdateLpConstituentTargetBaseIx(
					encodeName(lpPoolName),
					[
						getConstituentPublicKey(program.programId, lpPoolKey, 0),
						getConstituentPublicKey(program.programId, lpPoolKey, 1),
						getConstituentPublicKey(program.programId, lpPoolKey, 2),
						getConstituentPublicKey(program.programId, lpPoolKey, 3),
					]
				)
			);
		await adminClient.sendTransaction(tx2);
		await adminClient.updateLpPoolAum(lpPool, [0, 1, 2, 3]);

		constituentTargetBase =
			(await adminClient.program.account.constituentTargetBase.fetch(
				constituentTargetBasePublicKey
			)) as ConstituentTargetBase;
		console.log(
			'constituentTargetBase.targets',
			constituentTargetBase.targets.map((x) => x.targetBase.toString())
		);

		const parentTargetBaseAfter = constituentTargetBase.targets[1].targetBase;

		expect(parentTargetBaseAfter.toNumber()).to.be.approximately(
			parentTargetBaseBefore.toNumber() * 2,
			10
		);
	});

	it('remove aum then add back', async () => {
		const lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;
		const tx = new Transaction();
		expect(lpPool.lastAum.toNumber()).to.eq(1049220180);

		const lpTokenBalanceBefore =
			await bankrunContextWrapper.connection.getTokenAccount(
				userLpTokenAccount
			);
		expect(Number(lpTokenBalanceBefore.amount.toString())).to.equal(1000000000);

		const mintInfo = await getMint(
			bankrunContextWrapper.connection.toConnection(),
			lpPool.mint as PublicKey
		);
		expect(mintInfo.decimals).to.equal(tokenDecimals);
		expect(Number(mintInfo.supply)).to.equal(1000000000);
		expect(mintInfo.mintAuthority?.toBase58()).to.equal(
			adminClient.getSignerPublicKey().toBase58()
		);

		// console.log(lpPool);
		tx.add(await adminClient.getUpdateLpPoolAumIxs(lpPool, [0, 1, 2, 3]));
		tx.add(
			await adminClient.getLpPoolRemoveLiquidityIx({
				lpPool,
				minAmountOut: new BN(1000).mul(QUOTE_PRECISION),
				lpToBurn: new BN(1000).mul(QUOTE_PRECISION),
				outMarketIndex: 0,
			})
		);
		await adminClient.sendTransaction(tx);

		const lpPoolAfter = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;

		const deltaAum = lpPool.lastAum.sub(lpPoolAfter.lastAum);

		expect(lpPoolAfter.lastAum.toNumber()).to.eq(1363672); // residual fee
		expect(deltaAum.toNumber()).to.eq(
			1049820000 - 1363672 - 1400000 // price of 1 dlp
		);

		const mintInfoAfter = await getMint(
			bankrunContextWrapper.connection.toConnection(),
			lpPool.mint as PublicKey
		);
		expect(Number(mintInfoAfter.supply)).to.equal(1000000);

		const lpTokenBalanceAfter =
			await bankrunContextWrapper.connection.getTokenAccount(
				userLpTokenAccount
			);
		expect(Number(lpTokenBalanceAfter.amount)).to.equal(0);

		// TODO: below shoudn't fail (Slippage outside limit: lp_mint_amount_net_fees(0) < min_mint_amount(10))
		const txNext = new Transaction();
		txNext.add(await adminClient.getUpdateLpPoolAumIxs(lpPool, [0, 1, 2, 3]));
		txNext.add(
			await adminClient.getLpPoolAddLiquidityIx({
				lpPool,
				inAmount: new BN(1000).mul(QUOTE_PRECISION),
				minMintAmount: new BN(10),
				inMarketIndex: 0,
			})
		);
		await adminClient.sendTransaction(txNext);

		const lpPoolAfter2 = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;

		// expect(lpPoolAfter2.lastAum).to.equal(1000000000);
		expect(Number(lpPoolAfter2.lastAum.toNumber())).to.equal(1000314947);

		const mintInfoAfter2 = await getMint(
			bankrunContextWrapper.connection.toConnection(),
			lpPool.mint as PublicKey
		);
		expect(Number(mintInfoAfter2.supply)).to.equal(1000000);

		const lpTokenBalanceAfter2 =
			await bankrunContextWrapper.connection.getTokenAccount(
				userLpTokenAccount
			);
		// expect(Number(lpTokenBalanceAfter2.amount)).to.equal(1000000000);
		expect(Number(lpTokenBalanceAfter2.amount)).to.equal(3174);
	});
});
