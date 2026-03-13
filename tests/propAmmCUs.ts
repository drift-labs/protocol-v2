/**
 * Bankrun tests to measure compute unit usage for match_perp_order_via_prop_amm
 * with 1, 2, and 4 PropAMM (midprice) accounts.
 *
 * Run: npx mocha -r ts-node/register tests/propAmmCUs.ts
 *
 * To use the real midprice_pino: run
 *   ./test-scripts/build-midprice-pino-for-bankrun.sh
 * (builds midprice_pino, copies .so to tests/fixtures, then runs this test).
 * Or build+deploy only: ./test-scripts/build-midprice-pino-for-bankrun.sh --no-test
 *
 * When using midprice, run `anchor build` first so Drift is built with initialize_prop_amm_matcher
 * (otherwise before() fails with InstructionFallbackNotFound 0x65).
 */
import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import { Program } from '@coral-xyz/anchor';
import {
	Keypair,
	PublicKey,
	SYSVAR_CLOCK_PUBKEY,
	SystemProgram,
	Transaction,
	TransactionInstruction,
} from '@solana/web3.js';
import {
	createAssociatedTokenAccountIdempotentInstruction,
	createMintToInstruction,
	getAssociatedTokenAddressSync,
} from '@solana/spl-token';

/** Min size for midprice_pino account (midprice_book_view::ACCOUNT_MIN_LEN) */
const MIDPRICE_ACCOUNT_MIN_LEN = 120;
/** Order entry size (offset i64 + size u64) */
const MIDPRICE_ORDER_ENTRY_SIZE = 16;
/** midprice_pino instructions */
const MIDPRICE_IX_UPDATE_MID_PRICE = 0;
const MIDPRICE_IX_SET_ORDERS = 2;
const MIDPRICE_IX_SET_QUOTE_TTL = 5;
const MIDPRICE_IX_CLOSE_ACCOUNT = 6;
const MIDPRICE_IX_TRANSFER_AUTHORITY = 7;
/** Layout offsets for reading fields back from account data (midprice_book_view) */
const MIDPRICE_AUTHORITY_OFFSET = 12;
const MIDPRICE_QUOTE_TTL_OFFSET = 96;
const MIDPRICE_SEQUENCE_NUMBER_OFFSET = 104;
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
	BN,
	TestClient,
	PRICE_PRECISION,
	BASE_PRECISION,
	getLimitOrderParams,
	PositionDirection,
	getUserAccountPublicKey,
	getDriftStateAccountPublicKey,
	getPerpMarketPublicKeySync,
	getSpotMarketPublicKeySync,
	OracleSource,
} from '../sdk';
import { getPropAmmMatcherPDA } from '../sdk/src/addresses/pda';
import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	sleep,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

const DRIFT_DECIMALS = 6;

function instructionDiscriminator(name: string): Buffer {
	const hash = createHash('sha256').update(`global:${name}`).digest();
	return hash.subarray(0, 8);
}

function matchPerpOrderViaPropAmmInstructionDiscriminator(): Buffer {
	return instructionDiscriminator('match_perp_order_via_prop_amm');
}

const SYSVAR_RENT_PUBKEY = new PublicKey(
	'SysvarRent111111111111111111111111111111111'
);

/** Build Drift initialize_prop_amm_matcher ix via program client (IDL) so discriminator/accounts match deployed program. */
async function buildInitializePropAmmMatcherInstruction(
	program: Program,
	provider: { publicKey: PublicKey },
	driftProgramId: PublicKey
): Promise<TransactionInstruction> {
	const m = (program.methods as Record<string, unknown>)
		.initializePropAmmMatcher;
	if (typeof m !== 'function') {
		throw new Error(
			'IDL missing initializePropAmmMatcher. Run: anchor build, then re-run this test.'
		);
	}
	const accounts = {
		payer: provider.publicKey,
		propAmmMatcher: getPropAmmMatcherPDA(driftProgramId),
		rent: SYSVAR_RENT_PUBKEY,
		systemProgram: SystemProgram.programId,
	};
	return (
		m as () => {
			accounts: (a: typeof accounts) => {
				instruction: () => Promise<TransactionInstruction>;
			};
		}
	)()
		.accounts(accounts)
		.instruction();
}

/** Build Drift initialize_prop_amm_midprice ix (CPI into midprice_pino initialize). */
async function buildInitializePropAmmMidpriceInstruction(args: {
	program: Program;
	authority: PublicKey;
	midpriceAccount: PublicKey;
	perpMarket: PublicKey;
	midpriceProgram: PublicKey;
	driftProgramId: PublicKey;
	subaccountIndex: number;
}): Promise<TransactionInstruction> {
	const m = (args.program.methods as Record<string, unknown>)
		.initializePropAmmMidprice;
	if (typeof m !== 'function') {
		throw new Error(
			'IDL missing initializePropAmmMidprice. Run: anchor build, then re-run this test.'
		);
	}
	const accounts = {
		authority: args.authority,
		midpriceAccount: args.midpriceAccount,
		perpMarket: args.perpMarket,
		midpriceProgram: args.midpriceProgram,
		propAmmMatcher: getPropAmmMatcherPDA(args.driftProgramId),
	};
	return (
		m as (subaccountIndex: number) => {
			accounts: (a: typeof accounts) => {
				instruction: () => Promise<TransactionInstruction>;
			};
		}
	)(args.subaccountIndex)
		.accounts(accounts)
		.instruction();
}

function buildMatchPerpOrderViaPropAmmInstruction(
	driftProgramId: PublicKey,
	takerOrderId: number,
	accounts: {
		user: PublicKey;
		userStats: PublicKey;
		state: PublicKey;
		perpMarket: PublicKey;
		oracle: PublicKey;
		clock?: PublicKey;
	},
	remainingAccounts: { pubkey: PublicKey; isWritable: boolean }[]
): TransactionInstruction {
	const data = Buffer.alloc(8 + 4);
	matchPerpOrderViaPropAmmInstructionDiscriminator().copy(data, 0);
	data.writeUInt32LE(takerOrderId, 8);

	const keys = [
		{ pubkey: accounts.user, isSigner: false, isWritable: true },
		{ pubkey: accounts.userStats, isSigner: false, isWritable: true },
		{ pubkey: accounts.state, isSigner: false, isWritable: false },
		{ pubkey: accounts.perpMarket, isSigner: false, isWritable: true },
		{ pubkey: accounts.oracle, isSigner: false, isWritable: false },
		{
			pubkey: accounts.clock ?? SYSVAR_CLOCK_PUBKEY,
			isSigner: false,
			isWritable: false,
		},
		...remainingAccounts.map((a) => ({
			pubkey: a.pubkey,
			isSigner: false,
			isWritable: a.isWritable,
		})),
	];

	return new TransactionInstruction({
		programId: driftProgramId,
		keys,
		data,
	});
}

/** Derive midprice account PDA: unique per (market_index, authority, subaccount_index). Seeds must match program: [b"midprice", market_index_le, authority_32, subaccount_index_le]. */
function getMidpricePDA(
	midpriceProgramId: PublicKey,
	authority: PublicKey,
	marketIndex: number,
	subaccountIndex: number
): [PublicKey, number] {
	const marketBuf = Buffer.alloc(2);
	marketBuf.writeUInt16LE(marketIndex, 0);
	const subaccountBuf = Buffer.alloc(2);
	subaccountBuf.writeUInt16LE(subaccountIndex, 0);
	return PublicKey.findProgramAddressSync(
		[Buffer.from('midprice'), marketBuf, authority.toBuffer(), subaccountBuf],
		midpriceProgramId
	);
}

// NOTE: midprice_pino `initialize` is CPI-only; tests must call Drift's `initialize_prop_amm_midprice`.

/** Write a BN as unsigned 64-bit little-endian into buf at offset. */
function writeU64LE(buf: Buffer, offset: number, value: BN): void {
	const lo = value.and(new BN(0xffffffff)).toNumber();
	const hi = value.shrn(32).and(new BN(0xffffffff)).toNumber();
	buf.writeUInt32LE(lo, offset);
	buf.writeUInt32LE(hi, offset + 4);
}

/** Build midprice_pino update_mid_price ix (opcode 0). Payload: 24 bytes (mid_price u64, 8 reserved, ref_slot u64). Accounts: [midprice_account, authority]. */
function buildMidpriceUpdateMidPriceInstruction(
	midpriceProgramId: PublicKey,
	midpriceAccount: PublicKey,
	authority: PublicKey,
	midPriceU64: BN,
	refSlot: BN = new BN(0)
): TransactionInstruction {
	const data = Buffer.alloc(1 + 24);
	data.writeUInt8(MIDPRICE_IX_UPDATE_MID_PRICE, 0);
	writeU64LE(data, 1, midPriceU64);
	// bytes 9..17 are reserved (zeroed)
	writeU64LE(data, 17, refSlot);
	return new TransactionInstruction({
		programId: midpriceProgramId,
		keys: [
			{ pubkey: midpriceAccount, isSigner: false, isWritable: true },
			{ pubkey: authority, isSigner: true, isWritable: false },
		],
		data,
	});
}

/** Build midprice_pino set_orders ix (opcode 2). Payload: ref_slot (u64) + ask_len (u16) + bid_len (u16) + entries. Accounts: [midprice_account, authority]. */
function buildMidpriceSetOrdersInstruction(
	midpriceProgramId: PublicKey,
	midpriceAccount: PublicKey,
	authority: PublicKey,
	askLen: number,
	bidLen: number,
	entries: { offset: BN; size: BN }[],
	refSlot: BN = new BN(0)
): TransactionInstruction {
	const payloadLen = 12 + entries.length * MIDPRICE_ORDER_ENTRY_SIZE;
	const data = Buffer.alloc(1 + payloadLen);
	data.writeUInt8(MIDPRICE_IX_SET_ORDERS, 0);
	writeU64LE(data, 1, refSlot);
	data.writeUInt16LE(askLen, 9);
	data.writeUInt16LE(bidLen, 11);
	let off = 1 + 12;
	for (const e of entries) {
		data.writeBigInt64LE(BigInt(e.offset.toString()), off);
		off += 8;
		writeU64LE(data, off, e.size);
		off += 8;
	}
	return new TransactionInstruction({
		programId: midpriceProgramId,
		keys: [
			{ pubkey: midpriceAccount, isSigner: false, isWritable: true },
			{ pubkey: authority, isSigner: true, isWritable: false },
		],
		data,
	});
}

/** Build midprice_pino set_quote_ttl ix (opcode 5). Payload: 8 bytes (u64 LE). Accounts: [midprice_account, authority]. */
function buildMidpriceSetQuoteTtlInstruction(
	midpriceProgramId: PublicKey,
	midpriceAccount: PublicKey,
	authority: PublicKey,
	ttlSlots: bigint
): TransactionInstruction {
	const data = Buffer.alloc(1 + 8);
	data.writeUInt8(MIDPRICE_IX_SET_QUOTE_TTL, 0);
	data.writeBigUInt64LE(ttlSlots, 1);
	return new TransactionInstruction({
		programId: midpriceProgramId,
		keys: [
			{ pubkey: midpriceAccount, isSigner: false, isWritable: true },
			{ pubkey: authority, isSigner: true, isWritable: false },
		],
		data,
	});
}

/** Build midprice_pino close_account ix (opcode 6). Accounts: [midprice_account, authority, destination]. */
function buildMidpriceCloseAccountInstruction(
	midpriceProgramId: PublicKey,
	midpriceAccount: PublicKey,
	authority: PublicKey,
	destination: PublicKey
): TransactionInstruction {
	const data = Buffer.alloc(1);
	data.writeUInt8(MIDPRICE_IX_CLOSE_ACCOUNT, 0);
	return new TransactionInstruction({
		programId: midpriceProgramId,
		keys: [
			{ pubkey: midpriceAccount, isSigner: false, isWritable: true },
			{ pubkey: authority, isSigner: true, isWritable: false },
			{ pubkey: destination, isSigner: false, isWritable: true },
		],
		data,
	});
}

/** Build midprice_pino transfer_authority ix (opcode 7). Payload: 32 bytes (new authority pubkey). */
function buildMidpriceTransferAuthorityInstruction(
	midpriceProgramId: PublicKey,
	midpriceAccount: PublicKey,
	currentAuthority: PublicKey,
	newAuthority: PublicKey
): TransactionInstruction {
	const data = Buffer.alloc(1 + 32);
	data.writeUInt8(MIDPRICE_IX_TRANSFER_AUTHORITY, 0);
	newAuthority.toBuffer().copy(data, 1);
	return new TransactionInstruction({
		programId: midpriceProgramId,
		keys: [
			{ pubkey: midpriceAccount, isSigner: false, isWritable: true },
			{ pubkey: currentAuthority, isSigner: true, isWritable: false },
		],
		data,
	});
}

/** Read a u64 LE from a Buffer at the given offset. */
function readU64LE(buf: Buffer, offset: number): bigint {
	return buf.readBigUInt64LE(offset);
}

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const MIDPRICE_PINO_SO = path.join(FIXTURES_DIR, 'midprice_pino.so');
const MIDPRICE_PINO_KEYPAIR = path.join(
	FIXTURES_DIR,
	'midprice_pino-keypair.json'
);

function loadMidpricePinoProgramId(): PublicKey | null {
	try {
		if (
			!fs.existsSync(MIDPRICE_PINO_SO) ||
			!fs.existsSync(MIDPRICE_PINO_KEYPAIR)
		) {
			return null;
		}
		const keypairBytes = JSON.parse(
			fs.readFileSync(MIDPRICE_PINO_KEYPAIR, 'utf8')
		) as number[];
		const kp = Keypair.fromSecretKey(Uint8Array.from(keypairBytes));
		return kp.publicKey;
	} catch {
		return null;
	}
}

describe('PropAMM CU usage (bankrun)', () => {
	const program = anchor.workspace.Drift as Program;
	let bankrunContextWrapper: BankrunContextWrapper;
	let bulkAccountLoader: TestBulkAccountLoader;
	let driftClient: TestClient;
	let usdcMint: Keypair;
	let oracle: PublicKey;
	/** Set when tests/fixtures has midprice_pino.so + keypair (from build-midprice-pino-for-bankrun.sh) */
	let midpriceProgramId: PublicKey | null = null;
	const marketIndex = 0;
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuote = new BN(10 * 10 ** 13).mul(mantissaSqrtScale);
	const ammInitialBase = new BN(10 * 10 ** 13).mul(mantissaSqrtScale);
	// Taker needs enough collateral to pass margin after a PropAMM fill (margin calc scale; 100M USDC)
	const usdcAmount = new BN(100_000_000 * 10 ** DRIFT_DECIMALS);

	before(async () => {
		midpriceProgramId = loadMidpricePinoProgramId();
		const extraPrograms = midpriceProgramId
			? [{ name: 'midprice_pino', programId: midpriceProgramId }]
			: [];
		const context = await startAnchor('', extraPrograms, []);
		// We create midprice accounts at PDAs; bankrun signature verification would reject PDA "signatures"
		// used by SystemProgram.createAccount in these tests.
		bankrunContextWrapper = new BankrunContextWrapper(context, false);
		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		oracle = await mockOracleNoProgram(bankrunContextWrapper, 100);

		const wallet = bankrunContextWrapper.provider.wallet;
		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet,
			programID: program.programId,
			opts: { commitment: 'confirmed' },
			activeSubAccountId: 0,
			perpMarketIndexes: [marketIndex],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [{ publicKey: oracle, source: OracleSource.PYTH }],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();
		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);
		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const periodicity = new BN(60 * 60);
		await driftClient.initializePerpMarket(
			marketIndex,
			oracle,
			ammInitialBase,
			ammInitialQuote,
			periodicity
		);
		await driftClient.updatePerpMarketStepSizeAndTickSize(
			marketIndex,
			new BN(1000),
			new BN(1)
		);

		// When using real midprice_pino, create global PropAMM matcher PDA so fill CPI accepts it (matcher.owner == Drift).
		// Use program client (IDL) so instruction discriminator and accounts match the deployed program.
		if (midpriceProgramId) {
			const initMatcherIx = await buildInitializePropAmmMatcherInstruction(
				program,
				{ publicKey: bankrunContextWrapper.context.payer.publicKey },
				program.programId
			);
			const initMatcherTx = new Transaction().add(initMatcherIx);
			try {
				await bankrunContextWrapper.sendTransaction(initMatcherTx, []);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				if (
					msg.includes('0x65') ||
					msg.includes('InstructionFallbackNotFound')
				) {
					throw new Error(
						'Drift program missing initialize_prop_amm_matcher. Run: anchor build (or your full build), then re-run this test.'
					);
				}
				throw err;
			}
		}
	});

	after(async () => {
		await driftClient.unsubscribe();
	});

	/** Place a fresh taker limit order and return its order ID. */
	async function placeTakerLimitOrder(
		direction: PositionDirection = PositionDirection.LONG,
		baseAmount: BN = new BN(5).mul(BASE_PRECISION),
		price: BN = new BN(101).mul(PRICE_PRECISION)
	): Promise<number> {
		await driftClient.fetchAccounts();
		const nextId = driftClient.getUser().getUserAccount().nextOrderId;
		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount: baseAmount,
			price,
			reduceOnly: false,
		});
		await driftClient.placePerpOrder(orderParams);
		await driftClient.fetchAccounts();
		return nextId;
	}

	async function buildAndSignMatchTx(
		numPropAmms: number,
		orderId?: number,
		numDlobMakers = 0
	): Promise<{
		tx: Transaction;
		signers: Keypair[];
		orderId: number;
	}> {
		// Place a fresh taker order if none provided
		if (orderId === undefined) {
			orderId = await placeTakerLimitOrder();
		}
		const driftProgramId = program.programId;
		const takerUser = await driftClient.getUserAccountPublicKey();
		const takerStats = driftClient.getUserStatsAccountPublicKey();
		const state = await getDriftStateAccountPublicKey(driftProgramId);
		const perpMarket = getPerpMarketPublicKeySync(driftProgramId, marketIndex);
		const market = driftClient.getPerpMarketAccount(marketIndex);
		const oracleKey = new PublicKey(market.amm.oracle);

		// Create N makers (Drift User accounts + PropAMM books). Midprice accounts are PDAs per (market_index, authority, subaccount_index).
		const makerKeypairs: Keypair[] = [];
		const makerUserPDAs: PublicKey[] = [];
		const midpricePDAs: PublicKey[] = [];
		for (let i = 0; i < numPropAmms; i++) {
			const kp = Keypair.generate();
			await bankrunContextWrapper.fundKeypair(kp, 10 ** 9);
			makerKeypairs.push(kp);
			makerUserPDAs.push(
				await getUserAccountPublicKey(driftProgramId, kp.publicKey, 0)
			);
			const [pda] = getMidpricePDA(
				midpriceProgramId,
				kp.publicKey,
				marketIndex,
				0
			);
			midpricePDAs.push(pda);
		}

		const connection = bankrunContextWrapper.connection;
		const tokenProgram = (await connection.getAccountInfo(usdcMint.publicKey))
			.owner;
		const midpriceAccountSpace =
			MIDPRICE_ACCOUNT_MIN_LEN + MIDPRICE_ORDER_ENTRY_SIZE * 2; // space for 2 orders (128 bytes)
		const rentExempt = midpriceProgramId
			? await connection.getMinimumBalanceForRentExemption(midpriceAccountSpace)
			: 0;

		// Setup: 1 tx per maker (create ATA+mint, init Drift user+deposit, create/init midprice, seed liquidity).
		for (let i = 0; i < numPropAmms; i++) {
			const maker = makerKeypairs[i];
			const makerUsdcAccount = getAssociatedTokenAddressSync(
				usdcMint.publicKey,
				maker.publicKey
			);

			const setupIxs: TransactionInstruction[] = [];
			setupIxs.push(
				createAssociatedTokenAccountIdempotentInstruction(
					bankrunContextWrapper.context.payer.publicKey,
					makerUsdcAccount,
					maker.publicKey,
					usdcMint.publicKey,
					tokenProgram
				)
			);
			setupIxs.push(
				createMintToInstruction(
					usdcMint.publicKey,
					makerUsdcAccount,
					bankrunContextWrapper.context.payer.publicKey,
					usdcAmount.toNumber(),
					undefined,
					tokenProgram
				)
			);

			const makerClient = new TestClient({
				connection: bankrunContextWrapper.connection.toConnection(),
				wallet: new anchor.Wallet(maker),
				programID: driftProgramId,
				opts: { commitment: 'confirmed' },
				activeSubAccountId: 0,
				perpMarketIndexes: [marketIndex],
				spotMarketIndexes: [0],
				subAccountIds: [],
				oracleInfos: [{ publicKey: oracle, source: OracleSource.PYTH }],
				accountSubscription: {
					type: 'polling',
					accountLoader: bulkAccountLoader,
				},
			});
			await makerClient.subscribe();
			const { ixs: initUserIxs } =
				await makerClient.createInitializeUserAccountAndDepositCollateralIxs(
					usdcAmount,
					makerUsdcAccount
				);
			setupIxs.push(...initUserIxs);
			await makerClient.unsubscribe();

			if (midpriceProgramId) {
				const midpricePda = midpricePDAs[i];
				setupIxs.push(
					SystemProgram.createAccount({
						fromPubkey: bankrunContextWrapper.context.payer.publicKey,
						newAccountPubkey: midpricePda,
						lamports: rentExempt,
						space: midpriceAccountSpace,
						programId: midpriceProgramId,
					})
				);
				setupIxs.push(
					await buildInitializePropAmmMidpriceInstruction({
						program,
						authority: maker.publicKey,
						midpriceAccount: midpricePda,
						perpMarket,
						midpriceProgram: midpriceProgramId,
						driftProgramId,
						subaccountIndex: 0,
					})
				);
				// Set mid_price = 100 so an ask at offset PRICE_PRECISION has price 101 (crosses taker buy @ 101)
				setupIxs.push(
					buildMidpriceUpdateMidPriceInstruction(
						midpriceProgramId,
						midpricePda,
						maker.publicKey,
						new BN(100).mul(PRICE_PRECISION)
					)
				);
				// One ask: offset PRICE_PRECISION => price 101 (crosses). Size = 1 base so taker margin passes
				setupIxs.push(
					buildMidpriceSetOrdersInstruction(
						midpriceProgramId,
						midpricePda,
						maker.publicKey,
						1,
						0,
						[
							{
								offset: PRICE_PRECISION,
								size: new BN(1).mul(BASE_PRECISION),
							},
						]
					)
				);
			}

			const setupTx = new Transaction().add(...setupIxs);
			const setupSig = await bankrunContextWrapper.sendTransaction(setupTx, [
				maker,
			]);
			assert(
				setupSig && setupSig.length > 0,
				`setup tx for maker ${i} should succeed`
			);
		}

		// Create DLOB makers: Drift users with open limit sell orders (no midprice account)
		const dlobMakerUserPDAs: PublicKey[] = [];
		for (let i = 0; i < numDlobMakers; i++) {
			const kp = Keypair.generate();
			await bankrunContextWrapper.fundKeypair(kp, 10 ** 9);
			const dlobMakerUsdcAccount = getAssociatedTokenAddressSync(
				usdcMint.publicKey,
				kp.publicKey
			);
			const dlobUserPda = await getUserAccountPublicKey(
				driftProgramId,
				kp.publicKey,
				0
			);
			dlobMakerUserPDAs.push(dlobUserPda);

			const dlobSetupIxs: TransactionInstruction[] = [];
			dlobSetupIxs.push(
				createAssociatedTokenAccountIdempotentInstruction(
					bankrunContextWrapper.context.payer.publicKey,
					dlobMakerUsdcAccount,
					kp.publicKey,
					usdcMint.publicKey,
					tokenProgram
				)
			);
			dlobSetupIxs.push(
				createMintToInstruction(
					usdcMint.publicKey,
					dlobMakerUsdcAccount,
					bankrunContextWrapper.context.payer.publicKey,
					usdcAmount.toNumber(),
					undefined,
					tokenProgram
				)
			);
			const dlobClient = new TestClient({
				connection: bankrunContextWrapper.connection.toConnection(),
				wallet: new anchor.Wallet(kp),
				programID: driftProgramId,
				opts: { commitment: 'confirmed' },
				activeSubAccountId: 0,
				perpMarketIndexes: [marketIndex],
				spotMarketIndexes: [0],
				subAccountIds: [],
				oracleInfos: [{ publicKey: oracle, source: OracleSource.PYTH }],
				accountSubscription: {
					type: 'polling',
					accountLoader: bulkAccountLoader,
				},
			});
			await dlobClient.subscribe();
			const { ixs: dlobInitIxs } =
				await dlobClient.createInitializeUserAccountAndDepositCollateralIxs(
					usdcAmount,
					dlobMakerUsdcAccount
				);
			dlobSetupIxs.push(...dlobInitIxs);

			// Send init+deposit first so user account exists on-chain
			const dlobSetupTx = new Transaction().add(...dlobSetupIxs);
			const dlobSig = await bankrunContextWrapper.sendTransaction(dlobSetupTx, [
				kp,
			]);
			assert(
				dlobSig && dlobSig.length > 0,
				`DLOB maker ${i} setup tx should succeed`
			);
			await dlobClient.unsubscribe();

			// Re-subscribe so it picks up the newly created user account
			await dlobClient.subscribe();
			await dlobClient.addUser(0, kp.publicKey);
			const dlobOrderParams = getLimitOrderParams({
				marketIndex,
				direction: PositionDirection.SHORT,
				baseAssetAmount: new BN(1).mul(BASE_PRECISION),
				price: new BN(101).mul(PRICE_PRECISION),
				reduceOnly: false,
			});
			await dlobClient.placePerpOrder(dlobOrderParams);
			await dlobClient.unsubscribe();
		}

		// Remaining: [midprice_program], [spot_markets...], global PropAMM matcher, then per AMM: (midprice, maker_user), then DLOB makers
		const remaining: { pubkey: PublicKey; isWritable: boolean }[] = [];
		remaining.push({
			pubkey: midpriceProgramId ?? driftProgramId,
			isWritable: false,
		});
		// Collateral spot markets (e.g. USDC index 0) for margin calculation
		remaining.push({
			pubkey: getSpotMarketPublicKeySync(driftProgramId, 0),
			isWritable: false,
		});
		remaining.push({
			pubkey: getPropAmmMatcherPDA(driftProgramId),
			isWritable: true,
		});
		for (let i = 0; i < numPropAmms; i++) {
			remaining.push({
				pubkey: midpricePDAs[i],
				isWritable: true,
			});
			remaining.push({ pubkey: makerUserPDAs[i], isWritable: true });
		}
		// DLOB makers come after PropAMM pairs
		for (const dlobPda of dlobMakerUserPDAs) {
			remaining.push({ pubkey: dlobPda, isWritable: true });
		}

		const matchIx = buildMatchPerpOrderViaPropAmmInstruction(
			driftProgramId,
			orderId,
			{
				user: takerUser,
				userStats: takerStats,
				state,
				perpMarket,
				oracle: oracleKey,
			},
			remaining
		);

		// Final tx: match ix only (setup is done above).
		const tx = new Transaction().add(matchIx);
		tx.recentBlockhash = await bankrunContextWrapper.getLatestBlockhash();
		tx.feePayer = bankrunContextWrapper.context.payer.publicKey;
		tx.sign(bankrunContextWrapper.context.payer);
		return { tx, signers: [], orderId };
	}

	async function measurePropAmmMatchCU(
		numPropAmms: number,
		numDlobMakers = 0
	): Promise<number> {
		const { tx } = await buildAndSignMatchTx(
			numPropAmms,
			undefined,
			numDlobMakers
		);
		const sim = await bankrunContextWrapper.connection.simulateTransaction(tx);
		assert.strictEqual(sim.value.err, null, 'simulation should succeed');
		const cu = Number(sim.value.unitsConsumed ?? 0);
		return cu;
	}

	it('measures CU for 1 PropAMM fill', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}
		const cu = await measurePropAmmMatchCU(1);
		console.log('PropAMM match CU (1 AMM):', cu);
		assert(cu > 0, 'should consume compute units');
	});

	it('fills taker order when midprice has crossing liquidity (1 PropAMM)', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}
		const { tx, signers, orderId } = await buildAndSignMatchTx(1);
		const sig = await bankrunContextWrapper.sendTransaction(tx, signers);
		assert(sig && sig.length > 0, 'match transaction should succeed');
		await driftClient.fetchAccounts();
		const order = driftClient.getOrder(orderId);
		// Order may have been fully filled and removed, or partially filled
		if (order) {
			assert(
				order.baseAssetAmountFilled.gt(new BN(0)),
				'taker order should have been filled (baseAssetAmountFilled > 0)'
			);
		}
		// If order is null it was fully filled — check position instead
		const perpPosition = driftClient.getUser().getPerpPosition(marketIndex);
		assert(
			perpPosition && perpPosition.baseAssetAmount.gt(new BN(0)),
			'taker should have a long perp position after fill'
		);
	});

	it('fails when duplicate (midprice, maker_user) pairs are provided', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}

		const driftProgramId = program.programId;
		const takerUser = await driftClient.getUserAccountPublicKey();
		const takerStats = driftClient.getUserStatsAccountPublicKey();
		const state = await getDriftStateAccountPublicKey(driftProgramId);
		const perpMarket = getPerpMarketPublicKeySync(driftProgramId, marketIndex);
		const market = driftClient.getPerpMarketAccount(marketIndex);
		const oracleKey = new PublicKey(market.amm.oracle);

		const maker = Keypair.generate();
		await bankrunContextWrapper.fundKeypair(maker, 10 ** 9);
		const makerUserPda = await getUserAccountPublicKey(
			driftProgramId,
			maker.publicKey,
			0
		);
		const [midpricePda] = getMidpricePDA(
			midpriceProgramId,
			maker.publicKey,
			marketIndex,
			0
		);

		const connection = bankrunContextWrapper.connection;
		const tokenProgram = (await connection.getAccountInfo(usdcMint.publicKey))
			.owner;
		const makerUsdcAccount = getAssociatedTokenAddressSync(
			usdcMint.publicKey,
			maker.publicKey
		);
		const midpriceAccountSpace =
			MIDPRICE_ACCOUNT_MIN_LEN + MIDPRICE_ORDER_ENTRY_SIZE * 2;
		const rentExempt = await connection.getMinimumBalanceForRentExemption(
			midpriceAccountSpace
		);

		const setupIxs: TransactionInstruction[] = [];
		setupIxs.push(
			createAssociatedTokenAccountIdempotentInstruction(
				bankrunContextWrapper.context.payer.publicKey,
				makerUsdcAccount,
				maker.publicKey,
				usdcMint.publicKey,
				tokenProgram
			)
		);
		setupIxs.push(
			createMintToInstruction(
				usdcMint.publicKey,
				makerUsdcAccount,
				bankrunContextWrapper.context.payer.publicKey,
				usdcAmount.toNumber(),
				undefined,
				tokenProgram
			)
		);

		const makerClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(maker),
			programID: driftProgramId,
			opts: { commitment: 'confirmed' },
			activeSubAccountId: 0,
			perpMarketIndexes: [marketIndex],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [{ publicKey: oracle, source: OracleSource.PYTH }],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await makerClient.subscribe();
		const { ixs: initUserIxs } =
			await makerClient.createInitializeUserAccountAndDepositCollateralIxs(
				usdcAmount,
				makerUsdcAccount
			);
		setupIxs.push(...initUserIxs);
		await makerClient.unsubscribe();

		setupIxs.push(
			SystemProgram.createAccount({
				fromPubkey: bankrunContextWrapper.context.payer.publicKey,
				newAccountPubkey: midpricePda,
				lamports: rentExempt,
				space: midpriceAccountSpace,
				programId: midpriceProgramId,
			})
		);
		setupIxs.push(
			await buildInitializePropAmmMidpriceInstruction({
				program,
				authority: maker.publicKey,
				midpriceAccount: midpricePda,
				perpMarket,
				midpriceProgram: midpriceProgramId,
				driftProgramId,
				subaccountIndex: 0,
			})
		);
		setupIxs.push(
			buildMidpriceUpdateMidPriceInstruction(
				midpriceProgramId,
				midpricePda,
				maker.publicKey,
				new BN(100).mul(PRICE_PRECISION)
			)
		);
		setupIxs.push(
			buildMidpriceSetOrdersInstruction(
				midpriceProgramId,
				midpricePda,
				maker.publicKey,
				1,
				0,
				[
					{
						offset: PRICE_PRECISION,
						size: new BN(1).mul(BASE_PRECISION),
					},
				]
			)
		);

		const setupTx = new Transaction().add(...setupIxs);
		const setupSig = await bankrunContextWrapper.sendTransaction(setupTx, [
			maker,
		]);
		assert(setupSig && setupSig.length > 0, 'setup tx should succeed');

		// Remaining: [midprice_program], [spot_markets...], global matcher, then AMM pairs.
		// Intentionally provide the same (midprice, maker_user) pair twice: should fail.
		const remaining: { pubkey: PublicKey; isWritable: boolean }[] = [];
		remaining.push({ pubkey: midpriceProgramId, isWritable: false });
		remaining.push({
			pubkey: getSpotMarketPublicKeySync(driftProgramId, 0),
			isWritable: false,
		});
		remaining.push({
			pubkey: getPropAmmMatcherPDA(driftProgramId),
			isWritable: true,
		});
		remaining.push({ pubkey: midpricePda, isWritable: true });
		remaining.push({ pubkey: makerUserPda, isWritable: true });
		remaining.push({ pubkey: midpricePda, isWritable: true });
		remaining.push({ pubkey: makerUserPda, isWritable: true });

		const dupOrderId = await placeTakerLimitOrder();
		const matchIx = buildMatchPerpOrderViaPropAmmInstruction(
			driftProgramId,
			dupOrderId,
			{
				user: takerUser,
				userStats: takerStats,
				state,
				perpMarket,
				oracle: oracleKey,
			},
			remaining
		);
		const tx = new Transaction().add(matchIx);
		tx.recentBlockhash = await bankrunContextWrapper.getLatestBlockhash();
		tx.feePayer = bankrunContextWrapper.context.payer.publicKey;
		tx.sign(bankrunContextWrapper.context.payer);

		const sim = await bankrunContextWrapper.connection.simulateTransaction(tx);
		assert.notStrictEqual(sim.value.err, null, 'simulation should fail');
	});

	it('measures CU for 2 PropAMM fills', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}
		const cu = await measurePropAmmMatchCU(2);
		console.log('PropAMM match CU (2 AMMs):', cu);
		assert(cu > 0, 'should consume compute units');
	});

	it('measures CU for 4 PropAMM fills', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}
		const cu = await measurePropAmmMatchCU(4);
		console.log('PropAMM match CU (4 AMMs):', cu);
		assert(cu > 0, 'should consume compute units');
	});

	it('measures CU for 6 PropAMM fills', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}
		const cu = await measurePropAmmMatchCU(6);
		console.log('PropAMM match CU (6 AMMs):', cu);
		assert(cu > 0, 'should consume compute units');
	});

	// -------------------------------------------------------------------
	// Mixed fill source tests (PropAMM + DLOB + vAMM)
	// -------------------------------------------------------------------

	it('fills via vAMM only (no PropAMM makers, no DLOB)', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}
		// Build a match tx with 0 PropAMM makers and 0 DLOB makers.
		// The AMM should fill the taker order since oracle=100 and taker buys at limit 101.
		const { tx } = await buildAndSignMatchTx(0);
		const sim = await bankrunContextWrapper.connection.simulateTransaction(tx);
		assert.strictEqual(
			sim.value.err,
			null,
			'vAMM-only simulation should succeed'
		);
		const cu = Number(sim.value.unitsConsumed ?? 0);
		console.log('vAMM-only match CU:', cu);
		assert(cu > 0, 'should consume compute units');
	});

	it('fills via DLOB only (no PropAMM makers)', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}
		// 0 PropAMM makers, 1 DLOB maker with a limit sell at 101
		const { tx } = await buildAndSignMatchTx(0, undefined, 1);
		const sim = await bankrunContextWrapper.connection.simulateTransaction(tx);
		assert.strictEqual(
			sim.value.err,
			null,
			'DLOB-only simulation should succeed'
		);
		const cu = Number(sim.value.unitsConsumed ?? 0);
		console.log('DLOB-only match CU (1 maker):', cu);
		assert(cu > 0, 'should consume compute units');
	});

	it('fills via mixed PropAMM + DLOB', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}
		// 1 PropAMM maker + 1 DLOB maker, both at price 101
		const { tx } = await buildAndSignMatchTx(1, undefined, 1);
		const sim = await bankrunContextWrapper.connection.simulateTransaction(tx);
		assert.strictEqual(
			sim.value.err,
			null,
			'mixed PropAMM+DLOB simulation should succeed'
		);
		const cu = Number(sim.value.unitsConsumed ?? 0);
		console.log('Mixed PropAMM(1) + DLOB(1) match CU:', cu);
		assert(cu > 0, 'should consume compute units');
	});

	it('fills via mixed PropAMM + DLOB + vAMM (all sources)', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}
		// Taker wants 5 BASE. PropAMM offers 1 BASE at 101, DLOB offers 1 BASE at 101,
		// remainder should fill via vAMM (oracle=100, well within limit 101).
		const { tx, signers, orderId } = await buildAndSignMatchTx(1, undefined, 1);
		const sig = await bankrunContextWrapper.sendTransaction(tx, signers);
		assert(sig && sig.length > 0, 'mixed all-source match tx should succeed');
		await driftClient.fetchAccounts();
		const order = driftClient.getOrder(orderId);
		if (order) {
			// Order may be fully or partially filled
			assert(
				order.baseAssetAmountFilled.gt(new BN(0)),
				'taker should have some base filled from mixed sources'
			);
		}
		// If order is null, it was fully filled and removed — also valid
	});

	it('measures CU for 2 PropAMM + 2 DLOB fills', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}
		const cu = await measurePropAmmMatchCU(2, 2);
		console.log('Mixed PropAMM(2) + DLOB(2) match CU:', cu);
		assert(cu > 0, 'should consume compute units');
	});

	// -------------------------------------------------------------------
	// set_quote_ttl + sequence number integration tests
	// -------------------------------------------------------------------

	it('set_quote_ttl writes TTL and bumps sequence number', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}
		const maker = Keypair.generate();
		await bankrunContextWrapper.fundKeypair(maker, 10 ** 9);
		const perpMarket = getPerpMarketPublicKeySync(
			program.programId,
			marketIndex
		);
		const [midpricePda] = getMidpricePDA(
			midpriceProgramId,
			maker.publicKey,
			marketIndex,
			0
		);
		const space = MIDPRICE_ACCOUNT_MIN_LEN + MIDPRICE_ORDER_ENTRY_SIZE * 2;
		const rentExempt =
			await bankrunContextWrapper.connection.getMinimumBalanceForRentExemption(
				space
			);

		const initMidpriceIx = await buildInitializePropAmmMidpriceInstruction({
			program,
			authority: maker.publicKey,
			midpriceAccount: midpricePda,
			perpMarket,
			midpriceProgram: midpriceProgramId,
			driftProgramId: program.programId,
			subaccountIndex: 0,
		});

		const setupTx = new Transaction().add(
			SystemProgram.createAccount({
				fromPubkey: bankrunContextWrapper.context.payer.publicKey,
				newAccountPubkey: midpricePda,
				lamports: rentExempt,
				space,
				programId: midpriceProgramId,
			}),
			initMidpriceIx
		);
		const setupSig = await bankrunContextWrapper.sendTransaction(setupTx, [
			maker,
		]);
		assert(setupSig && setupSig.length > 0, 'setup tx should succeed');

		// Read account: sequence should be 1 after init, TTL should be 0
		let acctInfo = await bankrunContextWrapper.connection.getAccountInfo(
			midpricePda
		);
		assert(acctInfo, 'midprice account should exist');
		let seq = readU64LE(acctInfo.data, MIDPRICE_SEQUENCE_NUMBER_OFFSET);
		assert.equal(seq, BigInt(1), 'sequence should be 1 after init');
		let ttl = readU64LE(acctInfo.data, MIDPRICE_QUOTE_TTL_OFFSET);
		assert.equal(ttl, BigInt(0), 'TTL should be 0 after init');

		// Set quote TTL to 150
		const ttlValue = BigInt(150);
		const setTtlTx = new Transaction().add(
			buildMidpriceSetQuoteTtlInstruction(
				midpriceProgramId,
				midpricePda,
				maker.publicKey,
				ttlValue
			)
		);
		const ttlSig = await bankrunContextWrapper.sendTransaction(setTtlTx, [
			maker,
		]);
		assert(ttlSig && ttlSig.length > 0, 'set_quote_ttl tx should succeed');

		acctInfo = await bankrunContextWrapper.connection.getAccountInfo(
			midpricePda
		);
		seq = readU64LE(acctInfo.data, MIDPRICE_SEQUENCE_NUMBER_OFFSET);
		assert.equal(seq, BigInt(2), 'sequence should be 2 after set_quote_ttl');
		ttl = readU64LE(acctInfo.data, MIDPRICE_QUOTE_TTL_OFFSET);
		assert.equal(ttl, ttlValue, 'TTL should match set value');
	});

	it('sequence number increments across multiple instructions', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}
		const maker = Keypair.generate();
		await bankrunContextWrapper.fundKeypair(maker, 10 ** 9);
		const perpMarket = getPerpMarketPublicKeySync(
			program.programId,
			marketIndex
		);
		const [midpricePda] = getMidpricePDA(
			midpriceProgramId,
			maker.publicKey,
			marketIndex,
			0
		);
		const space = MIDPRICE_ACCOUNT_MIN_LEN + MIDPRICE_ORDER_ENTRY_SIZE * 2;
		const rentExempt =
			await bankrunContextWrapper.connection.getMinimumBalanceForRentExemption(
				space
			);

		const initMidpriceIx = await buildInitializePropAmmMidpriceInstruction({
			program,
			authority: maker.publicKey,
			midpriceAccount: midpricePda,
			perpMarket,
			midpriceProgram: midpriceProgramId,
			driftProgramId: program.programId,
			subaccountIndex: 0,
		});

		// Init (seq -> 1)
		const setupTx = new Transaction().add(
			SystemProgram.createAccount({
				fromPubkey: bankrunContextWrapper.context.payer.publicKey,
				newAccountPubkey: midpricePda,
				lamports: rentExempt,
				space,
				programId: midpriceProgramId,
			}),
			initMidpriceIx
		);
		let sig = await bankrunContextWrapper.sendTransaction(setupTx, [maker]);
		assert(sig && sig.length > 0, 'init tx should succeed');

		// update_mid_price (seq -> 2)
		const updateTx = new Transaction().add(
			buildMidpriceUpdateMidPriceInstruction(
				midpriceProgramId,
				midpricePda,
				maker.publicKey,
				new BN(100).mul(PRICE_PRECISION)
			)
		);
		sig = await bankrunContextWrapper.sendTransaction(updateTx, [maker]);
		assert(sig && sig.length > 0, 'update_mid_price tx should succeed');

		// set_orders (seq -> 3)
		const ordersTx = new Transaction().add(
			buildMidpriceSetOrdersInstruction(
				midpriceProgramId,
				midpricePda,
				maker.publicKey,
				1,
				0,
				[{ offset: PRICE_PRECISION, size: BASE_PRECISION }]
			)
		);
		sig = await bankrunContextWrapper.sendTransaction(ordersTx, [maker]);
		assert(sig && sig.length > 0, 'set_orders tx should succeed');

		// set_quote_ttl (seq -> 4)
		const ttlTx = new Transaction().add(
			buildMidpriceSetQuoteTtlInstruction(
				midpriceProgramId,
				midpricePda,
				maker.publicKey,
				BigInt(50)
			)
		);
		sig = await bankrunContextWrapper.sendTransaction(ttlTx, [maker]);
		assert(sig && sig.length > 0, 'set_quote_ttl tx should succeed');

		const acctInfo = await bankrunContextWrapper.connection.getAccountInfo(
			midpricePda
		);
		const seq = readU64LE(acctInfo.data, MIDPRICE_SEQUENCE_NUMBER_OFFSET);
		assert.equal(
			seq,
			BigInt(4),
			'sequence should be 4 after init + update + set_orders + set_ttl'
		);
	});

	it('close_account closes the account and returns lamports to destination', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}
		const maker = Keypair.generate();
		const destination = Keypair.generate();
		await bankrunContextWrapper.fundKeypair(maker, 10 ** 9);
		const perpMarket = getPerpMarketPublicKeySync(
			program.programId,
			marketIndex
		);
		const [midpricePda] = getMidpricePDA(
			midpriceProgramId,
			maker.publicKey,
			marketIndex,
			0
		);
		const space = MIDPRICE_ACCOUNT_MIN_LEN;
		const rentExempt =
			await bankrunContextWrapper.connection.getMinimumBalanceForRentExemption(
				space
			);

		const initMidpriceIx = await buildInitializePropAmmMidpriceInstruction({
			program,
			authority: maker.publicKey,
			midpriceAccount: midpricePda,
			perpMarket,
			midpriceProgram: midpriceProgramId,
			driftProgramId: program.programId,
			subaccountIndex: 0,
		});

		const setupTx = new Transaction().add(
			SystemProgram.createAccount({
				fromPubkey: bankrunContextWrapper.context.payer.publicKey,
				newAccountPubkey: midpricePda,
				lamports: rentExempt,
				space,
				programId: midpriceProgramId,
			}),
			initMidpriceIx
		);
		const setupSig = await bankrunContextWrapper.sendTransaction(setupTx, [
			maker,
		]);
		assert(setupSig && setupSig.length > 0, 'setup tx should succeed');

		const closeTx = new Transaction().add(
			buildMidpriceCloseAccountInstruction(
				midpriceProgramId,
				midpricePda,
				maker.publicKey,
				destination.publicKey
			)
		);
		const closeSig = await bankrunContextWrapper.sendTransaction(closeTx, [
			maker,
		]);
		assert(closeSig && closeSig.length > 0, 'close_account tx should succeed');

		const acctInfo = await bankrunContextWrapper.connection.getAccountInfo(
			midpricePda
		);
		assert.equal(
			acctInfo,
			null,
			'account should be closed after close_account'
		);

		const destInfo = await bankrunContextWrapper.connection.getAccountInfo(
			destination.publicKey
		);
		assert(
			destInfo && destInfo.lamports >= rentExempt,
			'destination should have received lamports'
		);
	});

	it('transfer_authority changes the authority stored on the account', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}
		const maker = Keypair.generate();
		const newAuthority = Keypair.generate();
		await bankrunContextWrapper.fundKeypair(maker, 10 ** 9);
		const perpMarket = getPerpMarketPublicKeySync(
			program.programId,
			marketIndex
		);
		const [midpricePda] = getMidpricePDA(
			midpriceProgramId,
			maker.publicKey,
			marketIndex,
			0
		);
		const space = MIDPRICE_ACCOUNT_MIN_LEN;
		const rentExempt =
			await bankrunContextWrapper.connection.getMinimumBalanceForRentExemption(
				space
			);

		const initMidpriceIx = await buildInitializePropAmmMidpriceInstruction({
			program,
			authority: maker.publicKey,
			midpriceAccount: midpricePda,
			perpMarket,
			midpriceProgram: midpriceProgramId,
			driftProgramId: program.programId,
			subaccountIndex: 0,
		});

		const setupTx = new Transaction().add(
			SystemProgram.createAccount({
				fromPubkey: bankrunContextWrapper.context.payer.publicKey,
				newAccountPubkey: midpricePda,
				lamports: rentExempt,
				space,
				programId: midpriceProgramId,
			}),
			initMidpriceIx
		);
		const setupSig = await bankrunContextWrapper.sendTransaction(setupTx, [
			maker,
		]);
		assert(setupSig && setupSig.length > 0, 'setup tx should succeed');

		const transferTx = new Transaction().add(
			buildMidpriceTransferAuthorityInstruction(
				midpriceProgramId,
				midpricePda,
				maker.publicKey,
				newAuthority.publicKey
			)
		);
		const transferSig = await bankrunContextWrapper.sendTransaction(
			transferTx,
			[maker]
		);
		assert(
			transferSig && transferSig.length > 0,
			'transfer_authority tx should succeed'
		);

		const acctInfo = await bankrunContextWrapper.connection.getAccountInfo(
			midpricePda
		);
		assert(acctInfo, 'account should still exist after transfer_authority');
		const authorityBytes = acctInfo.data.slice(
			MIDPRICE_AUTHORITY_OFFSET,
			MIDPRICE_AUTHORITY_OFFSET + 32
		);
		assert.deepEqual(
			Buffer.from(authorityBytes),
			newAuthority.publicKey.toBuffer(),
			'authority field should be updated to new authority'
		);
	});
});
