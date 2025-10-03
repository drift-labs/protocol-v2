import * as anchor from '@coral-xyz/anchor';
import { expect, assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import {
	AccountInfo,
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
	SystemProgram,
	Transaction,
} from '@solana/web3.js';
import {
	createAssociatedTokenAccountInstruction,
	createInitializeMint2Instruction,
	createMintToInstruction,
	getAssociatedTokenAddress,
	getAssociatedTokenAddressSync,
	getMint,
	MINT_SIZE,
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

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
	ConstituentTargetBaseAccount,
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
	ConstituentLpOperation,
} from '../sdk/src';

import {
	createWSolTokenAccountForUser,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
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

	let whitelistMint: PublicKey;

	before(async () => {
		const context = await startAnchor(
			'',
			[],
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
		await adminClient.updatePerpMarketLpPoolStatus(0, 1);

		await adminClient.initializePerpMarket(
			1,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(200 * PEG_PRECISION.toNumber())
		);
		await adminClient.updatePerpMarketLpPoolStatus(1, 1);

		await adminClient.initializePerpMarket(
			2,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(200 * PEG_PRECISION.toNumber())
		);
		await adminClient.updatePerpMarketLpPoolStatus(2, 1);

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
		await initializeSolSpotMarket(adminClient, spotMarketOracle2);

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
			new BN(1_000_000_000_000).mul(QUOTE_PRECISION),
			new BN(1_000_000).mul(QUOTE_PRECISION),
			Keypair.generate()
		);

		await adminClient.updateFeatureBitFlagsMintRedeemLpPool(true);

		// Give the vamm some inventory
		await adminClient.openPosition(PositionDirection.LONG, BASE_PRECISION, 0);
		await adminClient.openPosition(PositionDirection.SHORT, BASE_PRECISION, 1);
		assert(
			adminClient
				.getUser()
				.getActivePerpPositions()
				.filter((x) => !x.baseAssetAmount.eq(ZERO)).length == 2
		);

		console.log('create whitelist mint');
		const whitelistKeypair = Keypair.generate();
		const transaction = new Transaction().add(
			SystemProgram.createAccount({
				fromPubkey: bankrunContextWrapper.provider.wallet.publicKey,
				newAccountPubkey: whitelistKeypair.publicKey,
				space: MINT_SIZE,
				lamports: 10_000_000_000,
				programId: TOKEN_PROGRAM_ID,
			}),
			createInitializeMint2Instruction(
				whitelistKeypair.publicKey,
				0,
				bankrunContextWrapper.provider.wallet.publicKey,
				bankrunContextWrapper.provider.wallet.publicKey,
				TOKEN_PROGRAM_ID
			)
		);

		await bankrunContextWrapper.sendTransaction(transaction, [
			whitelistKeypair,
		]);

		const whitelistMintInfo =
			await bankrunContextWrapper.connection.getAccountInfo(
				whitelistKeypair.publicKey
			);
		console.log('whitelistMintInfo', whitelistMintInfo);

		whitelistMint = whitelistKeypair.publicKey;
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
			)) as ConstituentTargetBaseAccount;
		expect(constituentTargetBase).to.not.be.null;
		assert(constituentTargetBase.targets.length == 0);

		// check mint created correctly
		const mintInfo = await getMint(
			bankrunContextWrapper.connection.toConnection(),
			lpPool.mint as PublicKey
		);
		expect(mintInfo.decimals).to.equal(tokenDecimals);
		expect(Number(mintInfo.supply)).to.equal(0);
		expect(mintInfo.mintAuthority?.toBase58()).to.equal(lpPoolKey.toBase58());
	});

	it('can add constituents to LP Pool', async () => {
		await adminClient.initializeConstituent(encodeName(lpPoolName), {
			spotMarketIndex: 0,
			decimals: 6,
			maxWeightDeviation: new BN(10).mul(PERCENTAGE_PRECISION),
			swapFeeMin: new BN(1).mul(PERCENTAGE_PRECISION),
			swapFeeMax: new BN(2).mul(PERCENTAGE_PRECISION),
			maxBorrowTokenAmount: new BN(1_000_000).muln(10 ** 6),
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
			)) as ConstituentTargetBaseAccount;

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
			maxBorrowTokenAmount: new BN(1_000_000).muln(10 ** 6),
			oracleStalenessThreshold: new BN(400),
			costToTrade: 1,
			constituentDerivativeDepegThreshold:
				PERCENTAGE_PRECISION.divn(10).muln(9),
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
			)) as ConstituentTargetBaseAccount;
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
			expect(e.message).to.contain('0x18b6'); // InvalidAmmConstituentMappingArgument
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
			expect(e.message).to.contain('0x18b6'); // InvalidAmmConstituentMappingArgument
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
			assert(e.message.includes('0x18bf')); // LpPoolAumDelayed
		}
	});

	it('fails to add liquidity if a paused operation', async () => {
		await adminClient.updateConstituentPausedOperations(
			getConstituentPublicKey(program.programId, lpPoolKey, 0),
			ConstituentLpOperation.Deposit
		);
		try {
			const lpPool = (await adminClient.program.account.lpPool.fetch(
				lpPoolKey
			)) as LPPoolAccount;
			const tx = new Transaction();
			tx.add(await adminClient.getUpdateLpPoolAumIxs(lpPool, [0, 1]));
			tx.add(
				...(await adminClient.getLpPoolAddLiquidityIx({
					lpPool,
					inAmount: new BN(1000).mul(QUOTE_PRECISION),
					minMintAmount: new BN(1),
					inMarketIndex: 0,
				}))
			);
			await adminClient.sendTransaction(tx);
		} catch (e) {
			console.log(e.message);
			assert(e.message.includes('0x18c8')); // InvalidConstituentOperation
		}
		await adminClient.updateConstituentPausedOperations(
			getConstituentPublicKey(program.programId, lpPoolKey, 0),
			0
		);
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

		const tx = new Transaction();
		tx.add(await adminClient.getUpdateLpPoolAumIxs(lpPool, [0, 1]));
		tx.add(
			...(await adminClient.getLpPoolAddLiquidityIx({
				lpPool,
				inAmount: new BN(1000).mul(QUOTE_PRECISION),
				minMintAmount: new BN(1),
				inMarketIndex: 0,
			}))
		);
		await adminClient.sendTransaction(tx);

		await adminClient.updateLpPoolAum(lpPool, [0, 1]);
		lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;

		console.log(lpPool.lastAum.toString());
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
			assert(e.message.includes('0x18bb')); // WrongNumberOfConstituents
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

		await adminClient.overrideAmmCacheInfo(0, {
			ammPositionScalar: 100,
			ammInventoryLimit: BASE_PRECISION.muln(5000),
		});
		await adminClient.overrideAmmCacheInfo(1, {
			ammPositionScalar: 100,
			ammInventoryLimit: BASE_PRECISION.muln(5000),
		});
		await adminClient.overrideAmmCacheInfo(2, {
			ammPositionScalar: 100,
			ammInventoryLimit: BASE_PRECISION.muln(5000),
		});

		let tx = new Transaction();
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
		let constituentTargetBase =
			(await adminClient.program.account.constituentTargetBase.fetch(
				constituentTargetBasePublicKey
			)) as ConstituentTargetBaseAccount;
		expect(constituentTargetBase).to.not.be.null;
		assert(constituentTargetBase.targets.length == 2);
		assert(
			constituentTargetBase.targets.filter((x) => x.targetBase.eq(ZERO))
				.length !== constituentTargetBase.targets.length
		);

		// Make sure the target base respects the cache scalar
		const cacheValueBefore = constituentTargetBase.targets[1].targetBase;
		await adminClient.overrideAmmCacheInfo(1, {
			ammPositionScalar: 50,
		});
		tx = new Transaction();
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
		constituentTargetBase =
			(await adminClient.program.account.constituentTargetBase.fetch(
				constituentTargetBasePublicKey
			)) as ConstituentTargetBaseAccount;
		console.log(cacheValueBefore.toString());
		expect(
			constituentTargetBase.targets[1].targetBase.toNumber()
		).to.approximately(cacheValueBefore.muln(50).divn(100).toNumber(), 1);

		await adminClient.overrideAmmCacheInfo(1, {
			ammPositionScalar: 100,
		});
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
			maxBorrowTokenAmount: new BN(1_000_000).muln(10 ** 6),
			costToTrade: 1,
			derivativeWeight: PERCENTAGE_PRECISION.divn(2),
			constituentDerivativeDepegThreshold:
				PERCENTAGE_PRECISION.divn(10).muln(9),
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
			)) as ConstituentTargetBaseAccount;

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
			)) as ConstituentTargetBaseAccount;
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
			)) as ConstituentTargetBaseAccount;
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
		await adminClient.updateFeatureBitFlagsSettleLpPool(true);

		let ammCache = (await adminClient.program.account.ammCache.fetch(
			getAmmCachePublicKey(program.programId)
		)) as AmmCache;
		let lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;

		// Exclude 25% of exchange fees, put 100 dollars there to make sure that the
		await adminClient.updatePerpMarketLpPoolFeeTransferScalar(0, 100, 25);
		await adminClient.updatePerpMarketLpPoolFeeTransferScalar(1, 100, 0);
		await adminClient.updatePerpMarketLpPoolFeeTransferScalar(2, 100, 0);

		const perpMarket = adminClient.getPerpMarketAccount(0);
		perpMarket.amm.totalExchangeFee = perpMarket.amm.totalExchangeFee.add(
			QUOTE_PRECISION.muln(100)
		);
		await overWritePerpMarket(
			adminClient,
			bankrunContextWrapper,
			perpMarket.pubkey,
			perpMarket
		);

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

		lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;
		const lpAumAfterDeposit = lpPool.lastAum;

		// Make sure the amount recorded goes into the cache and that the quote amount owed is adjusted
		// for new influx in fees
		const ammCacheBeforeAdjust = ammCache;
		// Test pausing tracking for market 0
		await adminClient.updatePerpMarketLpPoolPausedOperations(0, 1);
		await adminClient.updateAmmCache([0, 1, 2]);
		ammCache = (await adminClient.program.account.ammCache.fetch(
			getAmmCachePublicKey(program.programId)
		)) as AmmCache;

		assert(ammCache.cache[0].lastFeePoolTokenAmount.eq(ZERO));
		assert(
			ammCache.cache[0].quoteOwedFromLpPool.eq(
				ammCacheBeforeAdjust.cache[0].quoteOwedFromLpPool
			)
		);
		assert(ammCache.cache[1].lastFeePoolTokenAmount.eq(new BN(100000000)));
		assert(
			ammCache.cache[1].quoteOwedFromLpPool.eq(
				ammCacheBeforeAdjust.cache[1].quoteOwedFromLpPool.sub(
					new BN(100).mul(QUOTE_PRECISION)
				)
			)
		);

		// Market 0 on the amm cache will update now that tracking is permissioned again
		await adminClient.updatePerpMarketLpPoolPausedOperations(0, 0);
		await adminClient.updateAmmCache([0, 1, 2]);
		ammCache = (await adminClient.program.account.ammCache.fetch(
			getAmmCachePublicKey(program.programId)
		)) as AmmCache;
		assert(ammCache.cache[0].lastFeePoolTokenAmount.eq(new BN(100000000)));
		assert(
			ammCache.cache[0].quoteOwedFromLpPool.eq(
				ammCacheBeforeAdjust.cache[0].quoteOwedFromLpPool.sub(
					new BN(75).mul(QUOTE_PRECISION)
				)
			)
		);

		const usdcBefore = constituent.vaultTokenBalance;
		// Update Amm Cache to update the aum
		await adminClient.updateLpPoolAum(lpPool, [0, 1, 2]);
		lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;
		const lpAumAfterUpdateCacheBeforeSettle = lpPool.lastAum;
		assert(
			lpAumAfterUpdateCacheBeforeSettle.eq(
				lpAumAfterDeposit.add(new BN(175).mul(QUOTE_PRECISION))
			)
		);

		// Calculate the expected transfer amount which is the increase in fee pool - amount owed,
		// but we have to consider the fee pool limitations
		const pnlPoolBalance0 = getTokenAmount(
			adminClient.getPerpMarketAccount(0).pnlPool.scaledBalance,
			adminClient.getQuoteSpotMarketAccount(),
			SpotBalanceType.DEPOSIT
		);
		const feePoolBalance0 = getTokenAmount(
			adminClient.getPerpMarketAccount(0).amm.feePool.scaledBalance,
			adminClient.getQuoteSpotMarketAccount(),
			SpotBalanceType.DEPOSIT
		);

		const pnlPoolBalance1 = getTokenAmount(
			adminClient.getPerpMarketAccount(1).pnlPool.scaledBalance,
			adminClient.getQuoteSpotMarketAccount(),
			SpotBalanceType.DEPOSIT
		);
		const feePoolBalance1 = getTokenAmount(
			adminClient.getPerpMarketAccount(1).amm.feePool.scaledBalance,
			adminClient.getQuoteSpotMarketAccount(),
			SpotBalanceType.DEPOSIT
		);

		// Expected transfers per pool are capital constrained by the actual balances
		const expectedTransfer0 = BN.min(
			ammCache.cache[0].quoteOwedFromLpPool.muln(-1),
			pnlPoolBalance0.add(feePoolBalance0).sub(QUOTE_PRECISION.muln(25))
		);
		const expectedTransfer1 = BN.min(
			ammCache.cache[1].quoteOwedFromLpPool.muln(-1),
			pnlPoolBalance1.add(feePoolBalance1)
		);
		const expectedTransferAmount = expectedTransfer0.add(expectedTransfer1);

		const settleTx = new Transaction();
		settleTx.add(await adminClient.getUpdateAmmCacheIx([0, 1, 2]));
		settleTx.add(
			await adminClient.getSettlePerpToLpPoolIx(
				encodeName(lpPoolName),
				[0, 1, 2]
			)
		);
		settleTx.add(await adminClient.getUpdateLpPoolAumIxs(lpPool, [0, 1, 2]));
		await adminClient.sendTransaction(settleTx);

		lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;
		const lpAumAfterSettle = lpPool.lastAum;
		assert(lpAumAfterSettle.eq(lpAumAfterUpdateCacheBeforeSettle));

		constituent = (await adminClient.program.account.constituent.fetch(
			getConstituentPublicKey(program.programId, lpPoolKey, 0)
		)) as ConstituentAccount;

		const usdcAfter = constituent.vaultTokenBalance;
		const feePoolBalanceAfter = getTokenAmount(
			adminClient.getPerpMarketAccount(0).amm.feePool.scaledBalance,
			adminClient.getQuoteSpotMarketAccount(),
			SpotBalanceType.DEPOSIT
		);
		console.log('usdcBefore', usdcBefore.toString());
		console.log('usdcAfter', usdcAfter.toString());

		// Verify the expected usdc transfer amount
		assert(usdcAfter.sub(usdcBefore).eq(expectedTransferAmount));
		console.log('feePoolBalanceBefore', feePoolBalance0.toString());
		console.log('feePoolBalanceAfter', feePoolBalanceAfter.toString());
		// Fee pool can cover it all in first perp market
		expect(
			feePoolBalance0.sub(feePoolBalanceAfter).toNumber()
		).to.be.approximately(expectedTransfer0.toNumber(), 1);

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
			new BN(constituentVault.amount.toString()).eq(
				constituent.vaultTokenBalance
			)
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
		tx.add(
			...(await adminClient.getAllSettlePerpToLpPoolIxs(lpPool.name, [0, 1, 2]))
		);
		tx.add(await adminClient.getUpdateLpPoolAumIxs(lpPool, [0, 1, 2]));
		tx.add(
			...(await adminClient.getLpPoolRemoveLiquidityIx({
				outMarketIndex: 0,
				lpToBurn: new BN(lpTokenBalance.amount.toString()),
				minAmountOut: new BN(1000).mul(QUOTE_PRECISION),
				lpPool: lpPool,
			}))
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
		await adminClient.updateLpPoolAum(lpPool, [0, 1, 2]);
		lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;
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
		settleTx.add(await adminClient.getUpdateAmmCacheIx([0, 1, 2]));
		settleTx.add(await adminClient.getUpdateLpPoolAumIxs(lpPool, [0, 1, 2]));
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

		// Should have written fee pool amount owed to the amm cache and new constituent usdc balane should just be the quote precision to leave aum > 0
		ammCache = (await adminClient.program.account.ammCache.fetch(
			getAmmCachePublicKey(program.programId)
		)) as AmmCache;
		// No more usdc left in the constituent vault
		assert(constituent.vaultTokenBalance.eq(QUOTE_PRECISION));
		assert(new BN(constituentVault.amount.toString()).eq(QUOTE_PRECISION));

		// Should have recorded the amount left over to the amm cache and increased the amount in the fee pool
		assert(
			ammCache.cache[0].lastFeePoolTokenAmount.eq(
				new BN(constituentUSDCBalanceBefore.toString()).sub(QUOTE_PRECISION)
			)
		);
		expect(
			ammCache.cache[0].quoteOwedFromLpPool.toNumber()
		).to.be.approximately(
			expectedTransferAmount
				.sub(new BN(constituentUSDCBalanceBefore.toString()))
				.add(QUOTE_PRECISION)
				.toNumber(),
			1
		);
		assert(
			adminClient
				.getPerpMarketAccount(0)
				.amm.feePool.scaledBalance.eq(
					new BN(constituentUSDCBalanceBefore.toString())
						.sub(QUOTE_PRECISION)
						.mul(SPOT_MARKET_BALANCE_PRECISION.div(QUOTE_PRECISION))
				)
		);

		// Update the LP pool AUM
		await adminClient.updateLpPoolAum(lpPool, [0, 1, 2]);
		lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;
		assert(lpPool.lastAum.eq(QUOTE_PRECISION));
	});

	it('perp market will not transfer with the constituent vault if it is owed from dlp', async () => {
		let ammCache = (await adminClient.program.account.ammCache.fetch(
			getAmmCachePublicKey(program.programId)
		)) as AmmCache;
		const owedAmount = ammCache.cache[0].quoteOwedFromLpPool;

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
		settleTx.add(await adminClient.getUpdateAmmCacheIx([0, 1, 2]));
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

		expect(
			ammCache.cache[0].quoteOwedFromLpPool.toNumber()
		).to.be.approximately(owedAmount.divn(2).toNumber(), 1);
		assert(constituent.vaultTokenBalance.eq(QUOTE_PRECISION));
		assert(lpPool.lastAum.eq(QUOTE_PRECISION));

		// Deposit here to DLP to make sure aum calc work with perp market debt
		await overWriteMintAccount(
			bankrunContextWrapper,
			lpPool.mint,
			BigInt(lpPool.lastAum.toNumber())
		);

		const tx = new Transaction();
		tx.add(await adminClient.getUpdateLpPoolAumIxs(lpPool, [0, 1, 2]));
		tx.add(
			...(await adminClient.getLpPoolAddLiquidityIx({
				lpPool,
				inAmount: new BN(1000).mul(QUOTE_PRECISION),
				minMintAmount: new BN(1),
				inMarketIndex: 0,
			}))
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
				constituent.vaultTokenBalance
					.mul(constituent.lastOraclePrice)
					.div(QUOTE_PRECISION)
			);
		}

		// Overwrite the amm cache with amount owed
		ammCache = (await adminClient.program.account.ammCache.fetch(
			getAmmCachePublicKey(program.programId)
		)) as AmmCache;
		for (let i = 0; i <= ammCache.cache.length - 1; i++) {
			aum = aum.sub(ammCache.cache[i].quoteOwedFromLpPool);
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

		const balanceBefore = constituent.vaultTokenBalance;
		const owedAmount = ammCache.cache[0].quoteOwedFromLpPool;

		// Give the perp market double of its owed amount
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

		const settleTx = new Transaction();
		settleTx.add(await adminClient.getUpdateAmmCacheIx([0, 1, 2]));
		settleTx.add(
			await adminClient.getSettlePerpToLpPoolIx(
				encodeName(lpPoolName),
				[0, 1, 2]
			)
		);
		settleTx.add(await adminClient.getUpdateLpPoolAumIxs(lpPool, [0, 1, 2]));
		await adminClient.sendTransaction(settleTx);

		ammCache = (await adminClient.program.account.ammCache.fetch(
			getAmmCachePublicKey(program.programId)
		)) as AmmCache;
		constituent = (await adminClient.program.account.constituent.fetch(
			getConstituentPublicKey(program.programId, lpPoolKey, 0)
		)) as ConstituentAccount;

		lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;

		assert(ammCache.cache[0].quoteOwedFromLpPool.eq(ZERO));
		assert(constituent.vaultTokenBalance.eq(balanceBefore.add(owedAmount)));
		assert(lpPool.lastAum.eq(aumBefore.add(owedAmount.muln(2))));
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
			maxBorrowTokenAmount: new BN(1_000_000).muln(10 ** 6),
			oracleStalenessThreshold: new BN(400),
			costToTrade: 1,
			derivativeWeight: PERCENTAGE_PRECISION.divn(4),
			constituentDerivativeDepegThreshold:
				PERCENTAGE_PRECISION.divn(10).muln(9),
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
			)) as ConstituentTargetBaseAccount;

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
			)) as ConstituentTargetBaseAccount;
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

	it('cant withdraw more than constituent limit', async () => {
		await adminClient.updateConstituentParams(
			encodeName(lpPoolName),
			getConstituentPublicKey(program.programId, lpPoolKey, 0),
			{
				maxBorrowTokenAmount: new BN(10).muln(10 ** 6),
			}
		);

		try {
			await adminClient.withdrawFromProgramVault(
				encodeName(lpPoolName),
				0,
				new BN(100).mul(QUOTE_PRECISION)
			);
		} catch (e) {
			console.log(e);
			assert(e.toString().includes('0x18c1')); // invariant failed
		}
	});

	it('cant disable lp pool settling', async () => {
		await adminClient.updateFeatureBitFlagsSettleLpPool(false);

		try {
			await adminClient.settlePerpToLpPool(encodeName(lpPoolName), [0, 1, 2]);
			assert(false, 'Should have thrown');
		} catch (e) {
			assert(e.message.includes('0x18c5')); // SettleLpPoolDisabled
		}

		await adminClient.updateFeatureBitFlagsSettleLpPool(true);
	});

	it('can do spot vault withdraws when there are borrows', async () => {
		// First deposit into wsol account from subaccount 1
		await adminClient.initializeUserAccount(1);
		const pubkey = await createWSolTokenAccountForUser(
			bankrunContextWrapper,
			adminClient.wallet.payer,
			new BN(7_000).mul(new BN(10 ** 9))
		);
		await adminClient.deposit(new BN(1000).mul(new BN(10 ** 9)), 2, pubkey, 1);
		const lpPool = await adminClient.getLpPoolAccount(encodeName(lpPoolName));

		// Deposit into LP pool some balance
		const ixs = [];
		ixs.push(await adminClient.getUpdateLpPoolAumIxs(lpPool, [0, 1, 2, 3]));
		ixs.push(
			...(await adminClient.getLpPoolAddLiquidityIx({
				inMarketIndex: 2,
				minMintAmount: new BN(1),
				lpPool,
				inAmount: new BN(100).mul(new BN(10 ** 9)),
			}))
		);
		await adminClient.sendTransaction(new Transaction().add(...ixs));
		await adminClient.depositToProgramVault(
			lpPool.name,
			2,
			new BN(100).mul(new BN(10 ** 9))
		);

		const spotMarket = adminClient.getSpotMarketAccount(2);
		spotMarket.depositBalance = new BN(1_186_650_830_132);
		spotMarket.borrowBalance = new BN(320_916_317_572);
		spotMarket.cumulativeBorrowInterest = new BN(697_794_836_247_770);
		spotMarket.cumulativeDepositInterest = new BN(188_718_954_233_794);
		await overWriteSpotMarket(
			adminClient,
			bankrunContextWrapper,
			spotMarket.pubkey,
			spotMarket
		);

		// const curClock =
		// 	await bankrunContextWrapper.provider.context.banksClient.getClock();
		// bankrunContextWrapper.provider.context.setClock(
		// 	new Clock(
		// 		curClock.slot,
		// 		curClock.epochStartTimestamp,
		// 		curClock.epoch,
		// 		curClock.leaderScheduleEpoch,
		// 		curClock.unixTimestamp + BigInt(60 * 60 * 24 * 365 * 10)
		// 	)
		// );

		await adminClient.withdrawFromProgramVault(
			encodeName(lpPoolName),
			2,
			new BN(500).mul(new BN(10 ** 9))
		);
	});

	it('whitelist mint', async () => {
		await adminClient.updateLpPoolParams(encodeName(lpPoolName), {
			whitelistMint: whitelistMint,
		});

		const lpPool = await adminClient.getLpPoolAccount(encodeName(lpPoolName));
		assert(lpPool.whitelistMint.equals(whitelistMint));

		console.log('lpPool.whitelistMint', lpPool.whitelistMint.toString());

		const tx = new Transaction();
		tx.add(await adminClient.getUpdateLpPoolAumIxs(lpPool, [0, 1, 2, 3]));
		tx.add(
			...(await adminClient.getLpPoolAddLiquidityIx({
				lpPool,
				inAmount: new BN(1000).mul(QUOTE_PRECISION),
				minMintAmount: new BN(1),
				inMarketIndex: 0,
			}))
		);
		try {
			await adminClient.sendTransaction(tx);
			assert(false, 'Should have thrown');
		} catch (e) {
			assert(e.toString().includes('0x1789')); // invalid whitelist token
		}

		const whitelistMintAta = getAssociatedTokenAddressSync(
			whitelistMint,
			adminClient.wallet.publicKey
		);
		const ix = createAssociatedTokenAccountInstruction(
			bankrunContextWrapper.context.payer.publicKey,
			whitelistMintAta,
			adminClient.wallet.publicKey,
			whitelistMint
		);
		const mintToIx = createMintToInstruction(
			whitelistMint,
			whitelistMintAta,
			bankrunContextWrapper.provider.wallet.publicKey,
			1
		);
		await bankrunContextWrapper.sendTransaction(
			new Transaction().add(ix, mintToIx)
		);

		const txAfter = new Transaction();
		txAfter.add(await adminClient.getUpdateLpPoolAumIxs(lpPool, [0, 1, 2, 3]));
		txAfter.add(
			...(await adminClient.getLpPoolAddLiquidityIx({
				lpPool,
				inAmount: new BN(1000).mul(QUOTE_PRECISION),
				minMintAmount: new BN(1),
				inMarketIndex: 0,
			}))
		);

		// successfully call add liquidity
		await adminClient.sendTransaction(txAfter);
	});
});
