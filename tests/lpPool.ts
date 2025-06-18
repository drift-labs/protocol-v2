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
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccountWithAuthority,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import dotenv from 'dotenv';
import { PYTH_LAZER_HEX_STRING_SOL, PYTH_STORAGE_DATA } from './pythLazerData';
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
	let bankrunContextWrapper: BankrunContextWrapper;
	let bulkAccountLoader: TestBulkAccountLoader;

	let adminClient: TestClient;
	let usdcMint: Keypair;
	let spotTokenMint: Keypair;
	let spotMarketOracle: PublicKey;

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

	it('can add constituent to LP Pool', async () => {
		await adminClient.initializeConstituent(
			encodeName(lpPoolName),
			0,
			6,
			new BN(10).mul(PERCENTAGE_PRECISION),
			new BN(1).mul(PERCENTAGE_PRECISION),
			new BN(2).mul(PERCENTAGE_PRECISION),
			new BN(400),
			1,
			PERCENTAGE_PRECISION
		);
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
		await adminClient.initializeConstituent(
			lpPool.name,
			1,
			6,
			new BN(10).mul(PERCENTAGE_PRECISION),
			new BN(1).mul(PERCENTAGE_PRECISION),
			new BN(2).mul(PERCENTAGE_PRECISION),
			new BN(400),
			1,
			ZERO
		);
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

	it('can update constituent properties', async () => {
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
			expect(e.message).to.contain('0x18ac');
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
			expect(e.message).to.contain('0x18ac');
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

		await adminClient.lpPoolAddLiquidity({
			lpPool,
			inAmount: new BN(1000).mul(QUOTE_PRECISION),
			minMintAmount: new BN(1),
			inMarketIndex: 0,
		});

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
			assert(e.message.includes('0x18b1'));
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

		await adminClient.updateLpConstituentTargetBase(encodeName(lpPoolName), [
			getConstituentPublicKey(program.programId, lpPoolKey, 0),
			getConstituentPublicKey(program.programId, lpPoolKey, 1),
		]);
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

	it('can add constituent to LP Pool thats a derivative and get half of the target weight', async () => {
		const lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;

		await adminClient.initializeConstituent(
			lpPool.name,
			2,
			6,
			new BN(10).mul(PERCENTAGE_PRECISION),
			new BN(1).mul(PERCENTAGE_PRECISION),
			new BN(2).mul(PERCENTAGE_PRECISION),
			new BN(400),
			1,
			PERCENTAGE_PRECISION.divn(2), // 50% weight against SOL
			1
		);

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

		await adminClient.updateLpConstituentTargetBase(encodeName(lpPoolName), [
			getConstituentPublicKey(program.programId, lpPoolKey, 0),
			getConstituentPublicKey(program.programId, lpPoolKey, 1),
			getConstituentPublicKey(program.programId, lpPoolKey, 2),
		]);
		await adminClient.updateLpPoolAum(lpPool, [0, 1, 2]);

		const constituentTargetBasePublicKey = getConstituentTargetBasePublicKey(
			program.programId,
			lpPoolKey
		);
		const constituentTargetBase =
			(await adminClient.program.account.constituentTargetBase.fetch(
				constituentTargetBasePublicKey
			)) as ConstituentTargetBase;

		expect(constituentTargetBase).to.not.be.null;
		console.log(
			'constituentTargetBase.targets',
			constituentTargetBase.targets.map((x) => x.targetBase.toString())
		);
		assert(
			constituentTargetBase.targets[1].targetBase
				.sub(constituentTargetBase.targets[2].targetBase)
				.lt(constituentTargetBase.targets[1].targetBase.divn(1000))
		);
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
		assert(ammCache.cache[0].lastFeePoolBalance.eq(ZERO));
		assert(ammCache.cache[1].lastFeePoolBalance.eq(ZERO));
		assert(ammCache.cache[2].lastFeePoolBalance.eq(ZERO));
		assert(ammCache.cache[0].lastNetPnlPoolBalance.eq(ZERO));
		assert(ammCache.cache[1].lastNetPnlPoolBalance.eq(ZERO));
		assert(ammCache.cache[2].lastNetPnlPoolBalance.eq(ZERO));
		await adminClient.settlePerpToLpPool(encodeName(lpPoolName), [0, 1, 2]);
		ammCache = (await adminClient.program.account.ammCache.fetch(
			getAmmCachePublicKey(program.programId)
		)) as AmmCache;
		assert(ammCache.cache[0].lastFeePoolBalance.eq(new BN(100000000)));
		assert(ammCache.cache[1].lastFeePoolBalance.eq(new BN(100000000)));

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
});
