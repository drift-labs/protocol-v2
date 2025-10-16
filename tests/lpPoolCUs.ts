import * as anchor from '@coral-xyz/anchor';
import { expect, assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import {
	AccountInfo,
	AddressLookupTableProgram,
	ComputeBudgetProgram,
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
	SystemProgram,
	Transaction,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';
import {
	createInitializeMint2Instruction,
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
	OracleSource,
	SPOT_MARKET_WEIGHT_PRECISION,
	SPOT_MARKET_RATE_PRECISION,
	getAmmCachePublicKey,
	AmmCache,
	ZERO,
	getConstituentPublicKey,
	ConstituentAccount,
	PositionDirection,
	PYTH_LAZER_STORAGE_ACCOUNT_KEY,
	PTYH_LAZER_PROGRAM_ID,
	BASE_PRECISION,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockAtaTokenAccountForMint,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccountWithAuthority,
	overwriteConstituentAccount,
	sleep,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import dotenv from 'dotenv';
import { PYTH_STORAGE_DATA } from './pythLazerData';
import {
	CustomBorshAccountsCoder,
	CustomBorshCoder,
} from '../sdk/src/decode/customCoder';
dotenv.config();

const NUMBER_OF_CONSTITUENTS = 10;
const NUMBER_OF_PERP_MARKETS = 60;
const NUMBER_OF_USERS = Math.ceil(NUMBER_OF_PERP_MARKETS / 8);

const PERP_MARKET_INDEXES = Array.from(
	{ length: NUMBER_OF_PERP_MARKETS },
	(_, i) => i
);
const SPOT_MARKET_INDEXES = Array.from(
	{ length: NUMBER_OF_CONSTITUENTS + 2 },
	(_, i) => i
);
const CONSTITUENT_INDEXES = Array.from(
	{ length: NUMBER_OF_CONSTITUENTS },
	(_, i) => i
);

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

	let _userLpTokenAccount: PublicKey;
	let adminClient: TestClient;
	let usdcMint: Keypair;
	let spotTokenMint: Keypair;
	let spotMarketOracle2: PublicKey;

	let adminKeypair: Keypair;

	let lutAddress: PublicKey;

	const userClients: TestClient[] = [];

	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(100 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(100 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	let solUsd: PublicKey;

	const lpPoolName = 'test pool 1';
	const tokenDecimals = 6;
	const lpPoolKey = getLpPoolPublicKey(
		program.programId,
		encodeName(lpPoolName)
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
		spotMarketOracle2 = await mockOracleNoProgram(bankrunContextWrapper, 200);

		const keypair = new Keypair();
		adminKeypair = keypair;
		await bankrunContextWrapper.fundKeypair(keypair, 10 ** 12);

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

		await adminClient.initializePythLazerOracle(6);

		await adminClient.updatePerpAuctionDuration(new BN(0));

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
	});

	after(async () => {
		await adminClient.unsubscribe();
		for (const userClient of userClients) {
			await userClient.unsubscribe();
		}
	});

	it('can create a new LP Pool', async () => {
		await adminClient.initializeLpPool(
			lpPoolName,
			ZERO,
			new BN(1_000_000_000_000).mul(QUOTE_PRECISION),
			new BN(1_000_000).mul(QUOTE_PRECISION),
			new Keypair()
		);
		await adminClient.updateFeatureBitFlagsMintRedeemLpPool(true);

		// check LpPool created
		const lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;

		_userLpTokenAccount = await mockAtaTokenAccountForMint(
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
		// USDC Constituent
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

		for (let i = 0; i < NUMBER_OF_CONSTITUENTS; i++) {
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
			await sleep(50);
		}
		await adminClient.unsubscribe();
		adminClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(adminKeypair),
			programID: program.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			subAccountIds: [],
			perpMarketIndexes: [0, 1],
			spotMarketIndexes: SPOT_MARKET_INDEXES,
			oracleInfos: [{ publicKey: solUsd, source: OracleSource.PYTH }],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
			coder: new CustomBorshCoder(program.idl),
		});
		await adminClient.subscribe();
		await sleep(50);

		const correlations = [ZERO];
		for (let i = 1; i < NUMBER_OF_CONSTITUENTS; i++) {
			await adminClient.initializeConstituent(encodeName(lpPoolName), {
				spotMarketIndex: i,
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
				volatility: PERCENTAGE_PRECISION.muln(
					Math.floor(Math.random() * 10)
				).divn(100),
				constituentCorrelations: correlations,
			});
			const constituentTargetBasePublicKey = getConstituentTargetBasePublicKey(
				program.programId,
				lpPoolKey
			);

			const constituent = (await adminClient.program.account.constituent.fetch(
				getConstituentPublicKey(program.programId, lpPoolKey, i)
			)) as ConstituentAccount;

			await adminClient.updateConstituentOracleInfo(constituent);

			const constituentTargetBase =
				(await adminClient.program.account.constituentTargetBase.fetch(
					constituentTargetBasePublicKey
				)) as ConstituentTargetBaseAccount;

			const lpPool = (await adminClient.program.account.lpPool.fetch(
				lpPoolKey
			)) as LPPoolAccount;

			assert(lpPool.constituents == i + 1);

			expect(constituentTargetBase).to.not.be.null;
			assert(constituentTargetBase.targets.length == i + 1);

			correlations.push(new BN(Math.floor(Math.random() * 100)).divn(100));
		}
	});

	it('can initialize many perp markets and given some inventory', async () => {
		for (let i = 0; i < NUMBER_OF_PERP_MARKETS; i++) {
			await adminClient.initializePerpMarket(
				i,
				solUsd,
				ammInitialBaseAssetReserve,
				ammInitialQuoteAssetReserve,
				new BN(0),
				new BN(200 * PEG_PRECISION.toNumber())
			);
			await adminClient.updatePerpMarketLpPoolStatus(i, 1);
			await sleep(50);
		}

		await adminClient.unsubscribe();
		adminClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(adminKeypair),
			programID: program.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			subAccountIds: [],
			perpMarketIndexes: PERP_MARKET_INDEXES,
			spotMarketIndexes: SPOT_MARKET_INDEXES,
			oracleInfos: [{ publicKey: solUsd, source: OracleSource.PYTH }],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
			coder: new CustomBorshCoder(program.idl),
		});
		await adminClient.subscribe();
	});

	it('can initialize all the different extra users', async () => {
		for (let i = 0; i < NUMBER_OF_USERS; i++) {
			const keypair = new Keypair();
			await bankrunContextWrapper.fundKeypair(keypair, 10 ** 9);
			await sleep(100);
			const userClient = new TestClient({
				connection: bankrunContextWrapper.connection.toConnection(),
				wallet: new anchor.Wallet(keypair),
				programID: program.programId,
				opts: {
					commitment: 'confirmed',
				},
				activeSubAccountId: 0,
				subAccountIds: [],
				perpMarketIndexes: PERP_MARKET_INDEXES,
				spotMarketIndexes: SPOT_MARKET_INDEXES,
				oracleInfos: [{ publicKey: solUsd, source: OracleSource.PYTH }],
				accountSubscription: {
					type: 'polling',
					accountLoader: bulkAccountLoader,
				},
				coder: new CustomBorshCoder(program.idl),
			});
			await userClient.subscribe();
			await sleep(100);

			const userUSDCAccount = await mockUserUSDCAccountWithAuthority(
				usdcMint,
				new BN(100_000_000).mul(QUOTE_PRECISION),
				bankrunContextWrapper,
				keypair
			);
			await sleep(100);

			await userClient.initializeUserAccountAndDepositCollateral(
				new BN(10_000_000).mul(QUOTE_PRECISION),
				userUSDCAccount
			);
			await sleep(100);
			userClients.push(userClient);
		}

		let userIndex = 0;
		for (let i = 0; i < NUMBER_OF_PERP_MARKETS; i++) {
			// Give the vamm some inventory
			const userClient = userClients[userIndex];
			await userClient.openPosition(PositionDirection.LONG, BASE_PRECISION, i);
			await sleep(50);
			if (
				userClient
					.getUser()
					.getActivePerpPositions()
					.filter((x) => !x.baseAssetAmount.eq(ZERO)).length == 8
			) {
				userIndex++;
			}
		}
	});

	it('can add lots of mapping data', async () => {
		// Assume that constituent 0 is USDC
		for (let i = 0; i < NUMBER_OF_PERP_MARKETS; i++) {
			for (let j = 1; j <= 3; j++) {
				await adminClient.addAmmConstituentMappingData(encodeName(lpPoolName), [
					{
						perpMarketIndex: i,
						constituentIndex: j,
						weight: PERCENTAGE_PRECISION.divn(3),
					},
				]);
				await sleep(50);
			}
		}
	});

	it('can add all addresses to lookup tables', async () => {
		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);

		const [lookupTableInst, lookupTableAddress] =
			AddressLookupTableProgram.createLookupTable({
				authority: adminClient.wallet.publicKey,
				payer: adminClient.wallet.publicKey,
				recentSlot: slot.toNumber() - 10,
			});

		const extendInstruction = AddressLookupTableProgram.extendLookupTable({
			payer: adminClient.wallet.publicKey,
			authority: adminClient.wallet.publicKey,
			lookupTable: lookupTableAddress,
			addresses: CONSTITUENT_INDEXES.map((i) =>
				getConstituentPublicKey(program.programId, lpPoolKey, i)
			),
		});

		const tx = new Transaction().add(lookupTableInst).add(extendInstruction);
		await adminClient.sendTransaction(tx);
		lutAddress = lookupTableAddress;

		const chunkies = chunks(
			adminClient.getPerpMarketAccounts().map((account) => account.pubkey),
			20
		);
		for (const chunk of chunkies) {
			const extendTx = new Transaction();
			const extendInstruction = AddressLookupTableProgram.extendLookupTable({
				payer: adminClient.wallet.publicKey,
				authority: adminClient.wallet.publicKey,
				lookupTable: lookupTableAddress,
				addresses: chunk,
			});
			extendTx.add(extendInstruction);
			await adminClient.sendTransaction(extendTx);
		}
	});

	it('can crank amm info into the cache', async () => {
		let ammCache = (await adminClient.program.account.ammCache.fetch(
			getAmmCachePublicKey(program.programId)
		)) as AmmCache;

		for (const chunk of chunks(PERP_MARKET_INDEXES, 20)) {
			const txSig = await adminClient.updateAmmCache(chunk);
			const cus =
				bankrunContextWrapper.connection.findComputeUnitConsumption(txSig);
			console.log(cus);
			assert(cus < 200_000);
		}

		ammCache = (await adminClient.program.account.ammCache.fetch(
			getAmmCachePublicKey(program.programId)
		)) as AmmCache;
		expect(ammCache).to.not.be.null;
		assert(ammCache.cache.length == NUMBER_OF_PERP_MARKETS);
	});

	it('can update target balances', async () => {
		for (let i = 0; i < NUMBER_OF_CONSTITUENTS; i++) {
			const constituent = (await adminClient.program.account.constituent.fetch(
				getConstituentPublicKey(program.programId, lpPoolKey, i)
			)) as ConstituentAccount;

			await adminClient.updateConstituentOracleInfo(constituent);
		}

		const cuIx = ComputeBudgetProgram.setComputeUnitLimit({
			units: 1_400_000,
		});
		const ammCacheIxs = await Promise.all(
			chunks(PERP_MARKET_INDEXES, 50).map(
				async (chunk) => await adminClient.getUpdateAmmCacheIx(chunk)
			)
		);
		const updateBaseIx = await adminClient.getUpdateLpConstituentTargetBaseIx(
			encodeName(lpPoolName),
			[getConstituentPublicKey(program.programId, lpPoolKey, 1)]
		);

		const txMessage = new TransactionMessage({
			payerKey: adminClient.wallet.publicKey,
			recentBlockhash: (await adminClient.connection.getLatestBlockhash())
				.blockhash,
			instructions: [cuIx, ...ammCacheIxs, updateBaseIx],
		});

		const lookupTableAccount = (
			await bankrunContextWrapper.connection.getAddressLookupTable(lutAddress)
		).value;
		const message = txMessage.compileToV0Message([lookupTableAccount]);

		const txSig = await adminClient.connection.sendTransaction(
			new VersionedTransaction(message)
		);

		const cus = Number(
			bankrunContextWrapper.connection.findComputeUnitConsumption(txSig)
		);
		console.log(cus);

		// assert(+cus.toString() < 100_000);
	});

	it('can update AUM with high balances', async () => {
		const lpPool = (await adminClient.program.account.lpPool.fetch(
			lpPoolKey
		)) as LPPoolAccount;

		for (let i = 0; i < NUMBER_OF_CONSTITUENTS; i++) {
			await overwriteConstituentAccount(
				bankrunContextWrapper,
				adminClient.program,
				getConstituentPublicKey(program.programId, lpPoolKey, i),
				[['vaultTokenBalance', QUOTE_PRECISION.muln(1000)]]
			);
		}

		const tx = new Transaction();
		tx.add(
			await adminClient.getUpdateLpPoolAumIxs(lpPool, CONSTITUENT_INDEXES)
		);
		const txSig = await adminClient.sendTransaction(tx);
		const cus = Number(
			bankrunContextWrapper.connection.findComputeUnitConsumption(txSig.txSig)
		);
		console.log(cus);
	});
});

const chunks = <T>(array: readonly T[], size: number): T[][] => {
	return new Array(Math.ceil(array.length / size))
		.fill(null)
		.map((_, index) => index * size)
		.map((begin) => array.slice(begin, begin + size));
};
