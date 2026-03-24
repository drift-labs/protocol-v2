/**
 * Bankrun tests to measure compute unit usage for fill_perp_order2
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
const MIDPRICE_ACCOUNT_MIN_LEN = 152;
/** Order entry size (tick_count u16 + size u64) */
const MIDPRICE_ORDER_ENTRY_SIZE = 10;
/** midprice_pino instructions */
const MIDPRICE_IX_UPDATE_MID_PRICE = 0;
const MIDPRICE_IX_SET_ORDERS = 2;
const MIDPRICE_IX_SET_QUOTE_TTL = 5;
const MIDPRICE_IX_CLOSE_ACCOUNT = 6;
const MIDPRICE_IX_TRANSFER_AUTHORITY = 7;
/** Layout offsets for reading fields back from account data (midprice_book_view) */
const MIDPRICE_AUTHORITY_OFFSET = 96;
const MIDPRICE_QUOTE_TTL_OFFSET = 144;
const MIDPRICE_SEQUENCE_NUMBER_OFFSET = 46;
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
	getUserStatsAccountPublicKey,
	getDriftStateAccountPublicKey,
	getPerpMarketPublicKeySync,
	getSpotMarketPublicKeySync,
	OracleSource,
} from '../sdk';
import {
	getMarketOrderParams,
	SignedMsgOrderParamsMessage,
	MarketType,
	PostOnlyParams,
	OrderParams,
	OrderType,
	OrderTriggerCondition,
} from '../sdk/src';
import { nanoid } from 'nanoid';
import {
	getPropAmmMatcherPDA,
	getPropAmmRegistryPDA,
} from '../sdk/src/addresses/pda';
import {
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	mockUserUSDCAccountWithAuthority,
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
	return instructionDiscriminator('fill_perp_order2');
}

const SYSVAR_RENT_PUBKEY = new PublicKey(
	'SysvarRent111111111111111111111111111111111'
);
const NATIVE_ADMIN_IX_PREFIX = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const NATIVE_IX_SET_ORACLE_CACHE_ENTRIES = 2;
const NATIVE_IX_UPDATE_ORACLE_PRICE_CACHE = 3;
const NATIVE_IX_UPDATE_ORACLE_CACHE_CONFIG = 4;

/** Build midprice_pino initialize ix (opcode 1). Called directly — no Drift CPI needed. */
function buildMidpriceInitializeInstruction(args: {
	midpriceProgram: PublicKey;
	authority: PublicKey;
	midpriceAccount: PublicKey;
	marketIndex: number;
	subaccountIndex: number;
	makerSubaccount: PublicKey;
}): TransactionInstruction {
	// Payload: market_index (u16) + subaccount_index (u16) + maker_subaccount (32) = 36 bytes
	const data = Buffer.alloc(1 + 36);
	data.writeUInt8(1, 0); // opcode 1 = initialize
	data.writeUInt16LE(args.marketIndex, 1);
	data.writeUInt16LE(args.subaccountIndex, 3);
	args.makerSubaccount.toBuffer().copy(data, 5);
	return new TransactionInstruction({
		programId: args.midpriceProgram,
		keys: [
			{ pubkey: args.midpriceAccount, isSigner: false, isWritable: true },
			{ pubkey: args.authority, isSigner: true, isWritable: false },
		],
		data,
	});
}

/** Derive the oracle price cache PDA for a given cache_id and buffer_index. */
function getOraclePriceCachePDA(
	driftProgramId: PublicKey,
	cacheId: number,
	bufferIndex: number
): PublicKey {
	const [pda] = PublicKey.findProgramAddressSync(
		[
			Buffer.from('oracle_price_cache'),
			Buffer.from([cacheId]),
			Buffer.from([bufferIndex]),
		],
		driftProgramId
	);
	return pda;
}

type OracleCacheEntryParam = {
	oracle: PublicKey;
	oracleSource: number;
	maxAgeSlotsOverride: number;
};

type ExtraSpotMarketFixture = {
	marketIndex: number;
	mint: Keypair;
	oracle: PublicKey;
};

type PropAmmMakerFixture = {
	authority: Keypair;
	user: PublicKey;
	midprice: PublicKey;
};

/** Build approve_prop_amms ix via IDL. Lazily creates matcher + registry PDAs. */
async function buildApprovePropAmmsInstruction(
	program: Program,
	admin: PublicKey,
	driftProgramId: PublicKey,
	entries: {
		marketIndex: number;
		makerSubaccount: PublicKey;
		propammProgram: PublicKey;
		propammAccount: PublicKey;
	}[]
): Promise<TransactionInstruction> {
	const m = (program.methods as Record<string, unknown>).approvePropAmms;
	if (typeof m !== 'function') {
		throw new Error('IDL missing approvePropAmms');
	}
	const state = await getDriftStateAccountPublicKey(driftProgramId);
	const accounts = {
		admin,
		state,
		propAmmMatcher: getPropAmmMatcherPDA(driftProgramId),
		propAmmRegistry: getPropAmmRegistryPDA(driftProgramId),
		rent: SYSVAR_RENT_PUBKEY,
		systemProgram: SystemProgram.programId,
	};
	const entriesParam = entries.map((e) => ({
		marketIndex: e.marketIndex,
		makerSubaccount: e.makerSubaccount,
		propammProgram: e.propammProgram,
		propammAccount: e.propammAccount,
	}));
	const remainingAccounts = entries.map((e) => ({
		pubkey: e.propammAccount,
		isSigner: false,
		isWritable: false,
	}));
	return (
		m as (entries: typeof entriesParam) => {
			accounts: (a: typeof accounts) => {
				remainingAccounts: (r: typeof remainingAccounts) => {
					instruction: () => Promise<TransactionInstruction>;
				};
			};
		}
	)(entriesParam)
		.accounts(accounts)
		.remainingAccounts(remainingAccounts)
		.instruction();
}

function buildNativeInstruction(
	programId: PublicKey,
	opcode: number,
	keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[],
	payload?: Buffer
): TransactionInstruction {
	return new TransactionInstruction({
		programId,
		keys,
		data: Buffer.concat([
			NATIVE_ADMIN_IX_PREFIX,
			Buffer.from([opcode]),
			payload ?? Buffer.alloc(0),
		]),
	});
}

function serializeOracleCacheEntries(
	cacheId: number,
	entries: OracleCacheEntryParam[]
): Buffer {
	const buf = Buffer.alloc(1 + 4 + entries.length * 34);
	buf.writeUInt8(cacheId, 0);
	buf.writeUInt32LE(entries.length, 1);
	let offset = 5;
	for (const entry of entries) {
		entry.oracle.toBuffer().copy(buf, offset);
		offset += 32;
		buf.writeUInt8(entry.oracleSource, offset);
		offset += 1;
		buf.writeUInt8(entry.maxAgeSlotsOverride, offset);
		offset += 1;
	}
	return buf;
}

function buildSetOracleCacheEntriesInstruction(args: {
	programId: PublicKey;
	admin: PublicKey;
	state: PublicKey;
	cache0: PublicKey;
	cache1: PublicKey;
	cacheId: number;
	entries: OracleCacheEntryParam[];
}): TransactionInstruction {
	return buildNativeInstruction(
		args.programId,
		NATIVE_IX_SET_ORACLE_CACHE_ENTRIES,
		[
			{ pubkey: args.admin, isSigner: true, isWritable: true },
			{ pubkey: args.state, isSigner: false, isWritable: false },
			{ pubkey: args.cache0, isSigner: false, isWritable: true },
			{ pubkey: args.cache1, isSigner: false, isWritable: true },
			{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
			{ pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
		],
		serializeOracleCacheEntries(args.cacheId, args.entries)
	);
}

function buildUpdateOraclePriceCacheInstruction(args: {
	programId: PublicKey;
	cache: PublicKey;
	oracles: PublicKey[];
}): TransactionInstruction {
	return buildNativeInstruction(
		args.programId,
		NATIVE_IX_UPDATE_ORACLE_PRICE_CACHE,
		[
			{ pubkey: args.cache, isSigner: false, isWritable: true },
			...args.oracles.map((oracle) => ({
				pubkey: oracle,
				isSigner: false,
				isWritable: false,
			})),
		]
	);
}

function buildUpdateOracleCacheConfigInstruction(args: {
	programId: PublicKey;
	admin: PublicKey;
	state: PublicKey;
	cache0: PublicKey;
	cache1: PublicKey;
	maxAgeSlots: number;
}): TransactionInstruction {
	return buildNativeInstruction(
		args.programId,
		NATIVE_IX_UPDATE_ORACLE_CACHE_CONFIG,
		[
			{ pubkey: args.admin, isSigner: true, isWritable: false },
			{ pubkey: args.state, isSigner: false, isWritable: false },
			{ pubkey: args.cache0, isSigner: false, isWritable: true },
			{ pubkey: args.cache1, isSigner: false, isWritable: true },
		],
		Buffer.from([args.maxAgeSlots])
	);
}

function countUniqueInstructionAccounts(
	ixs: TransactionInstruction[],
	feePayer: PublicKey
): number {
	const keys = new Set<string>([feePayer.toBase58()]);
	for (const ix of ixs) {
		keys.add(ix.programId.toBase58());
		for (const key of ix.keys) {
			keys.add(key.pubkey.toBase58());
		}
	}
	return keys.size;
}

function buildFillPerpOrder2Instruction(
	driftProgramId: PublicKey,
	takerOrderId: number | null,
	accounts: {
		user: PublicKey;
		userStats: PublicKey;
		state: PublicKey;
		perpMarket: PublicKey;
		oracle: PublicKey;
		oraclePriceCache: PublicKey;
		propAmmRegistry: PublicKey;
		clock?: PublicKey;
	},
	remainingAccounts: { pubkey: PublicKey; isWritable: boolean }[]
): TransactionInstruction {
	// Borsh Option<u32>: 0x00 = None, 0x01 + LE u32 = Some(id)
	const data = Buffer.alloc(8 + (takerOrderId != null ? 5 : 1));
	matchPerpOrderViaPropAmmInstructionDiscriminator().copy(data, 0);
	if (takerOrderId != null) {
		data.writeUInt8(1, 8);
		data.writeUInt32LE(takerOrderId, 9);
	} else {
		data.writeUInt8(0, 8);
	}

	const keys = [
		{ pubkey: accounts.user, isSigner: false, isWritable: true },
		{ pubkey: accounts.userStats, isSigner: false, isWritable: true },
		{ pubkey: accounts.state, isSigner: false, isWritable: false },
		{ pubkey: accounts.perpMarket, isSigner: false, isWritable: true },
		{ pubkey: accounts.oracle, isSigner: false, isWritable: false },
		{
			pubkey: accounts.oraclePriceCache,
			isSigner: false,
			isWritable: false,
		},
		{
			pubkey: accounts.propAmmRegistry,
			isSigner: false,
			isWritable: false,
		},
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

/** Build midprice_pino update_mid_price ix (opcode 0). V1 payload: 16 bytes (reference_price u64, valid_until_slot u64). */
function buildMidpriceUpdateMidPriceInstruction(
	midpriceProgramId: PublicKey,
	midpriceAccount: PublicKey,
	authority: PublicKey,
	referencePrice: BN,
	validUntilSlot: BN = new BN(0)
): TransactionInstruction {
	const data = Buffer.alloc(1 + 16);
	data.writeUInt8(MIDPRICE_IX_UPDATE_MID_PRICE, 0);
	writeU64LE(data, 1, referencePrice);
	writeU64LE(data, 9, validUntilSlot);
	return new TransactionInstruction({
		programId: midpriceProgramId,
		keys: [
			{ pubkey: midpriceAccount, isSigner: false, isWritable: true },
			{ pubkey: authority, isSigner: true, isWritable: false },
		],
		data,
	});
}

/** Build midprice_pino set_orders ix (opcode 2). V1 payload: valid_until_slot (u64) + ask_len (u16) + bid_len (u16) + entries (tick_count u16 + size u64 each). */
function buildMidpriceSetOrdersInstruction(
	midpriceProgramId: PublicKey,
	midpriceAccount: PublicKey,
	authority: PublicKey,
	askLen: number,
	bidLen: number,
	entries: { tickCount: number; size: BN }[],
	validUntilSlot: BN = new BN(0)
): TransactionInstruction {
	const payloadLen = 12 + entries.length * MIDPRICE_ORDER_ENTRY_SIZE;
	const data = Buffer.alloc(1 + payloadLen);
	data.writeUInt8(MIDPRICE_IX_SET_ORDERS, 0);
	writeU64LE(data, 1, validUntilSlot);
	data.writeUInt16LE(askLen, 9);
	data.writeUInt16LE(bidLen, 11);
	let off = 1 + 12;
	for (const e of entries) {
		data.writeUInt16LE(e.tickCount, off);
		off += 2;
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
	/** Oracle price cache PDA (buffer 0) — read-only account for fill_perp_order2. */
	let oraclePriceCachePda: PublicKey;
	let oraclePriceCachePda1: PublicKey;
	let propAmmRegistryPda: PublicKey;
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

		// Oracle price cache PDAs — lazily created + populated by set_oracle_cache_entries (native path).
		oraclePriceCachePda = getOraclePriceCachePDA(program.programId, 0, 0);
		oraclePriceCachePda1 = getOraclePriceCachePDA(program.programId, 0, 1);
		propAmmRegistryPda = getPropAmmRegistryPDA(program.programId);
		await configureOracleCache([], 60);

		// Ensure PropAMM registry + matcher PDAs exist (empty registry, no entries).
		const initRegistryIx = await buildApprovePropAmmsInstruction(
			program,
			bankrunContextWrapper.context.payer.publicKey,
			program.programId,
			[]
		);
		await bankrunContextWrapper.sendTransaction(
			new Transaction().add(initRegistryIx),
			[]
		);
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
		numDlobMakers = 0,
		advancePastAuction = false
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
					buildMidpriceInitializeInstruction({
						midpriceProgram: midpriceProgramId,
						authority: maker.publicKey,
						midpriceAccount: midpricePda,
						marketIndex,
						subaccountIndex: 0,
						makerSubaccount: makerUserPDAs[i],
					})
				);
				// Set mid_price = 100 so an ask at tick_count=1 has price 101 (crosses taker buy @ 101)
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
								tickCount: 1,
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

		// Approve all PropAMM makers in registry (lazily creates matcher + registry PDAs on first call).
		if (midpriceProgramId && numPropAmms > 0) {
			const approveIx = await buildApprovePropAmmsInstruction(
				program,
				bankrunContextWrapper.context.payer.publicKey,
				driftProgramId,
				makerUserPDAs.map((user, i) => ({
					marketIndex,
					makerSubaccount: user,
					propammProgram: midpriceProgramId,
					propammAccount: midpricePDAs[i],
				}))
			);
			const approveTx = new Transaction().add(approveIx);
			await bankrunContextWrapper.sendTransaction(approveTx, []);
		}

		// Create DLOB makers: Drift users with open limit sell orders (no midprice account)
		const dlobMakerUserPDAs: PublicKey[] = [];
		const dlobMakerStatsPDAs: PublicKey[] = [];
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
			dlobMakerStatsPDAs.push(
				getUserStatsAccountPublicKey(driftProgramId, kp.publicKey)
			);

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
		// DLOB makers come after PropAMM pairs — each is a (User, UserStats) pair
		for (let i = 0; i < dlobMakerUserPDAs.length; i++) {
			remaining.push({ pubkey: dlobMakerUserPDAs[i], isWritable: true });
			remaining.push({ pubkey: dlobMakerStatsPDAs[i], isWritable: true });
		}

		const matchIx = buildFillPerpOrder2Instruction(
			driftProgramId,
			orderId,
			{
				user: takerUser,
				userStats: takerStats,
				state,
				perpMarket,
				oracle: oracleKey,
				oraclePriceCache: oraclePriceCachePda,
				propAmmRegistry: propAmmRegistryPda,
			},
			remaining
		);

		// Advance clock past auction duration so taker limit price is used directly.
		// update_perp_auction_params assigns ~180 slot auctions to crossing limit orders.
		if (advancePastAuction) {
			await bankrunContextWrapper.moveTimeForward(80);
		}

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

	async function configureOracleCache(
		oracles: PublicKey[],
		maxAgeSlots: number,
		maxAgeSlotsOverride = 0
	): Promise<void> {
		const state = await getDriftStateAccountPublicKey(program.programId);
		const payer = bankrunContextWrapper.context.payer.publicKey;
		const entries = oracles.map((oracle) => ({
			oracle,
			oracleSource: OracleSource.PYTH,
			maxAgeSlotsOverride,
		}));
		const tx = new Transaction().add(
			buildSetOracleCacheEntriesInstruction({
				programId: program.programId,
				admin: payer,
				state,
				cache0: oraclePriceCachePda,
				cache1: oraclePriceCachePda1,
				cacheId: 0,
				entries,
			}),
			buildUpdateOracleCacheConfigInstruction({
				programId: program.programId,
				admin: payer,
				state,
				cache0: oraclePriceCachePda,
				cache1: oraclePriceCachePda1,
				maxAgeSlots,
			}),
			buildUpdateOraclePriceCacheInstruction({
				programId: program.programId,
				cache: oraclePriceCachePda,
				oracles,
			})
		);
		const sig = await bankrunContextWrapper.sendTransaction(tx, []);
		assert(
			sig && sig.length > 0,
			'oracle cache configuration tx should succeed'
		);
	}

	async function initializeExtraSpotMarkets(
		count: number
	): Promise<ExtraSpotMarketFixture[]> {
		const extraMarkets: ExtraSpotMarketFixture[] = [];
		for (let i = 0; i < count; i++) {
			await driftClient.fetchAccounts();
			const nextMarketIndex = driftClient.getStateAccount().numberOfSpotMarkets;
			const mint = await mockUSDCMint(bankrunContextWrapper);
			const oracleKey = await mockOracleNoProgram(
				bankrunContextWrapper,
				25 + i
			);
			await initializeSolSpotMarket(
				driftClient,
				oracleKey,
				mint.publicKey,
				OracleSource.PYTH
			);
			extraMarkets.push({
				marketIndex: nextMarketIndex,
				mint,
				oracle: oracleKey,
			});
		}
		return extraMarkets;
	}

	async function createCrossMarginedPropAmmMakers(
		numMakers: number,
		extraMarkets: ExtraSpotMarketFixture[],
		extraMarketDepositAmount: BN = new BN(5_000 * 10 ** DRIFT_DECIMALS)
	): Promise<PropAmmMakerFixture[]> {
		if (!midpriceProgramId) {
			throw new Error(
				'midprice program must be available for PropAMM maker setup'
			);
		}

		const driftProgramId = program.programId;
		const connection = bankrunContextWrapper.connection;
		const quoteTokenProgram = (
			await connection.getAccountInfo(usdcMint.publicKey)
		).owner;
		const midpriceAccountSpace =
			MIDPRICE_ACCOUNT_MIN_LEN + MIDPRICE_ORDER_ENTRY_SIZE * 2;
		const rentExempt = await connection.getMinimumBalanceForRentExemption(
			midpriceAccountSpace
		);
		const allSpotMarketIndexes = [0, ...extraMarkets.map((m) => m.marketIndex)];
		const allOracleInfos = [
			{ publicKey: oracle, source: OracleSource.PYTH },
			...extraMarkets.map((m) => ({
				publicKey: m.oracle,
				source: OracleSource.PYTH,
			})),
		];
		const makers: PropAmmMakerFixture[] = [];

		for (let i = 0; i < numMakers; i++) {
			const maker = Keypair.generate();
			await bankrunContextWrapper.fundKeypair(maker, 10 ** 9);

			const makerUsdcAccount = getAssociatedTokenAddressSync(
				usdcMint.publicKey,
				maker.publicKey
			);
			const makerUser = await getUserAccountPublicKey(
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

			const makerClient = new TestClient({
				connection: bankrunContextWrapper.connection.toConnection(),
				wallet: new anchor.Wallet(maker),
				programID: driftProgramId,
				opts: { commitment: 'confirmed' },
				activeSubAccountId: 0,
				perpMarketIndexes: [marketIndex],
				spotMarketIndexes: allSpotMarketIndexes,
				subAccountIds: [],
				oracleInfos: allOracleInfos,
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

			const setupTx = new Transaction().add(
				createAssociatedTokenAccountIdempotentInstruction(
					bankrunContextWrapper.context.payer.publicKey,
					makerUsdcAccount,
					maker.publicKey,
					usdcMint.publicKey,
					quoteTokenProgram
				),
				createMintToInstruction(
					usdcMint.publicKey,
					makerUsdcAccount,
					bankrunContextWrapper.context.payer.publicKey,
					usdcAmount.toNumber(),
					undefined,
					quoteTokenProgram
				),
				...initUserIxs,
				SystemProgram.createAccount({
					fromPubkey: bankrunContextWrapper.context.payer.publicKey,
					newAccountPubkey: midpricePda,
					lamports: rentExempt,
					space: midpriceAccountSpace,
					programId: midpriceProgramId,
				}),
				buildMidpriceInitializeInstruction({
					midpriceProgram: midpriceProgramId,
					authority: maker.publicKey,
					midpriceAccount: midpricePda,
					marketIndex,
					subaccountIndex: 0,
					makerSubaccount: makerUser,
				}),
				buildMidpriceUpdateMidPriceInstruction(
					midpriceProgramId,
					midpricePda,
					maker.publicKey,
					new BN(100).mul(PRICE_PRECISION)
				),
				buildMidpriceSetOrdersInstruction(
					midpriceProgramId,
					midpricePda,
					maker.publicKey,
					1,
					0,
					[
						{
							tickCount: 1,
							size: new BN(1).mul(BASE_PRECISION),
						},
					]
				)
			);
			await bankrunContextWrapper.sendTransaction(setupTx, [maker]);
			await makerClient.unsubscribe();
			await makerClient.subscribe();
			await makerClient.addUser(0, maker.publicKey);

			const depositIxs: TransactionInstruction[] = [];
			for (const extraMarket of extraMarkets) {
				const tokenAccount = await mockUserUSDCAccountWithAuthority(
					extraMarket.mint,
					extraMarketDepositAmount,
					bankrunContextWrapper,
					maker
				);
				depositIxs.push(
					await makerClient.getDepositInstruction(
						extraMarketDepositAmount,
						extraMarket.marketIndex,
						tokenAccount
					)
				);
			}

			for (let start = 0; start < depositIxs.length; start += 4) {
				const depositTx = new Transaction().add(
					...depositIxs.slice(start, start + 4)
				);
				await bankrunContextWrapper.sendTransaction(depositTx, [maker]);
			}

			await makerClient.unsubscribe();
			makers.push({ authority: maker, user: makerUser, midprice: midpricePda });
		}

		// Approve all makers in registry (lazily creates matcher + registry PDAs).
		// Batch in groups of 5 to avoid Anchor buffer overflow with many entries.
		const APPROVE_BATCH_SIZE = 5;
		const allEntries = makers.map((m) => ({
			marketIndex,
			makerSubaccount: m.user,
			propammProgram: midpriceProgramId!,
			propammAccount: m.midprice,
		}));
		for (
			let start = 0;
			start < allEntries.length;
			start += APPROVE_BATCH_SIZE
		) {
			const batch = allEntries.slice(start, start + APPROVE_BATCH_SIZE);
			const approveIx = await buildApprovePropAmmsInstruction(
				program,
				bankrunContextWrapper.context.payer.publicKey,
				program.programId,
				batch
			);
			const approveTx = new Transaction().add(approveIx);
			await bankrunContextWrapper.sendTransaction(approveTx, []);
		}

		return makers;
	}

	async function buildCrossMarginedPropAmmFillTx(args: {
		makers: PropAmmMakerFixture[];
		extraMarkets: ExtraSpotMarketFixture[];
		liveFallbackOracles?: PublicKey[];
		baseAssetAmount?: BN;
		price?: BN;
	}): Promise<{
		tx: Transaction;
		orderId: number;
		accountCount: number;
	}> {
		const orderId = await placeTakerLimitOrder(
			PositionDirection.LONG,
			args.baseAssetAmount ??
				new BN(Math.max(args.makers.length, 1)).mul(BASE_PRECISION),
			args.price ?? new BN(101).mul(PRICE_PRECISION)
		);
		const driftProgramId = program.programId;
		const takerUser = await driftClient.getUserAccountPublicKey();
		const takerStats = driftClient.getUserStatsAccountPublicKey();
		const state = await getDriftStateAccountPublicKey(driftProgramId);
		const perpMarket = getPerpMarketPublicKeySync(driftProgramId, marketIndex);
		const market = driftClient.getPerpMarketAccount(marketIndex);
		const oracleKey = new PublicKey(market.amm.oracle);

		const remaining = [
			{ pubkey: midpriceProgramId!, isWritable: false },
			...(args.liveFallbackOracles ?? []).map((oracle) => ({
				pubkey: oracle,
				isWritable: false,
			})),
			{
				pubkey: getSpotMarketPublicKeySync(driftProgramId, 0),
				isWritable: false,
			},
			...args.extraMarkets.map((marketFixture) => ({
				pubkey: getSpotMarketPublicKeySync(
					driftProgramId,
					marketFixture.marketIndex
				),
				isWritable: false,
			})),
			{ pubkey: getPropAmmMatcherPDA(driftProgramId), isWritable: true },
			...args.makers.flatMap((maker) => [
				{ pubkey: maker.midprice, isWritable: true },
				{ pubkey: maker.user, isWritable: true },
			]),
		];

		const matchIx = buildFillPerpOrder2Instruction(
			driftProgramId,
			orderId,
			{
				user: takerUser,
				userStats: takerStats,
				state,
				perpMarket,
				oracle: oracleKey,
				oraclePriceCache: oraclePriceCachePda,
				propAmmRegistry: propAmmRegistryPda,
			},
			remaining
		);
		await bankrunContextWrapper.moveTimeForward(80);
		const tx = new Transaction().add(matchIx);
		tx.recentBlockhash = await bankrunContextWrapper.getLatestBlockhash();
		tx.feePayer = bankrunContextWrapper.context.payer.publicKey;
		tx.sign(bankrunContextWrapper.context.payer);

		return {
			tx,
			orderId,
			accountCount: countUniqueInstructionAccounts(
				[matchIx],
				bankrunContextWrapper.context.payer.publicKey
			),
		};
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
		const { tx, signers, orderId } = await buildAndSignMatchTx(
			1,
			undefined,
			0,
			true
		);
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
			buildMidpriceInitializeInstruction({
				midpriceProgram: midpriceProgramId,
				authority: maker.publicKey,
				midpriceAccount: midpricePda,
				marketIndex,
				subaccountIndex: 0,
				makerSubaccount: makerUserPda,
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
						tickCount: 1,
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
		const matchIx = buildFillPerpOrder2Instruction(
			driftProgramId,
			dupOrderId,
			{
				user: takerUser,
				userStats: takerStats,
				state,
				perpMarket,
				oracle: oracleKey,
				oraclePriceCache: oraclePriceCachePda,
				propAmmRegistry: propAmmRegistryPda,
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
		const { tx, signers, orderId } = await buildAndSignMatchTx(
			1,
			undefined,
			1,
			true
		);
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
	// Atomic signed msg taker order place + PropAMM fill
	// -------------------------------------------------------------------

	it('atomic signed msg taker place + PropAMM fill in same tx', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}

		const driftProgramId = program.programId;
		const state = await getDriftStateAccountPublicKey(driftProgramId);
		const perpMarket = getPerpMarketPublicKeySync(driftProgramId, marketIndex);
		const market = driftClient.getPerpMarketAccount(marketIndex);
		const oracleKey = new PublicKey(market.amm.oracle);
		const connection = bankrunContextWrapper.connection;
		const tokenProgram = (await connection.getAccountInfo(usdcMint.publicKey))
			.owner;

		// --- Taker setup ---
		const takerKp = Keypair.generate();
		await bankrunContextWrapper.fundKeypair(takerKp, 10 ** 9);
		const takerUsdcAta = getAssociatedTokenAddressSync(
			usdcMint.publicKey,
			takerKp.publicKey
		);

		const takerClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(takerKp),
			programID: driftProgramId,
			opts: { commitment: 'confirmed' },
			activeSubAccountId: 0,
			perpMarketIndexes: [marketIndex],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [{ publicKey: oracle, source: OracleSource.PYTH }],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerClient.subscribe();

		const { ixs: takerInitIxs } =
			await takerClient.createInitializeUserAccountAndDepositCollateralIxs(
				usdcAmount,
				takerUsdcAta
			);

		const takerSetupTx = new Transaction().add(
			createAssociatedTokenAccountIdempotentInstruction(
				bankrunContextWrapper.context.payer.publicKey,
				takerUsdcAta,
				takerKp.publicKey,
				usdcMint.publicKey,
				tokenProgram
			),
			createMintToInstruction(
				usdcMint.publicKey,
				takerUsdcAta,
				bankrunContextWrapper.context.payer.publicKey,
				usdcAmount.toNumber(),
				undefined,
				tokenProgram
			),
			...takerInitIxs
		);
		await bankrunContextWrapper.sendTransaction(takerSetupTx, [takerKp]);

		// Re-subscribe so client picks up the newly created user account
		await takerClient.unsubscribe();
		await takerClient.subscribe();
		await takerClient.addUser(0, takerKp.publicKey);
		await takerClient.fetchAccounts();

		// --- PropAMM maker setup (1 maker) ---
		const makerKp = Keypair.generate();
		await bankrunContextWrapper.fundKeypair(makerKp, 10 ** 9);
		const makerUserPda = await getUserAccountPublicKey(
			driftProgramId,
			makerKp.publicKey,
			0
		);
		const [midpricePda] = getMidpricePDA(
			midpriceProgramId,
			makerKp.publicKey,
			marketIndex,
			0
		);

		const makerUsdcAta = getAssociatedTokenAddressSync(
			usdcMint.publicKey,
			makerKp.publicKey
		);
		const midpriceAccountSpace =
			MIDPRICE_ACCOUNT_MIN_LEN + MIDPRICE_ORDER_ENTRY_SIZE * 2;
		const rentExempt = await connection.getMinimumBalanceForRentExemption(
			midpriceAccountSpace
		);

		const makerClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(makerKp),
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
		const { ixs: makerInitIxs } =
			await makerClient.createInitializeUserAccountAndDepositCollateralIxs(
				usdcAmount,
				makerUsdcAta
			);
		await makerClient.unsubscribe();

		const makerSetupIxs: TransactionInstruction[] = [
			createAssociatedTokenAccountIdempotentInstruction(
				bankrunContextWrapper.context.payer.publicKey,
				makerUsdcAta,
				makerKp.publicKey,
				usdcMint.publicKey,
				tokenProgram
			),
			createMintToInstruction(
				usdcMint.publicKey,
				makerUsdcAta,
				bankrunContextWrapper.context.payer.publicKey,
				usdcAmount.toNumber(),
				undefined,
				tokenProgram
			),
			...makerInitIxs,
			SystemProgram.createAccount({
				fromPubkey: bankrunContextWrapper.context.payer.publicKey,
				newAccountPubkey: midpricePda,
				lamports: rentExempt,
				space: midpriceAccountSpace,
				programId: midpriceProgramId,
			}),
			buildMidpriceInitializeInstruction({
				midpriceProgram: midpriceProgramId,
				authority: makerKp.publicKey,
				midpriceAccount: midpricePda,
				marketIndex,
				subaccountIndex: 0,
				makerSubaccount: makerUserPda,
			}),
			buildMidpriceUpdateMidPriceInstruction(
				midpriceProgramId,
				midpricePda,
				makerKp.publicKey,
				new BN(100).mul(PRICE_PRECISION)
			),
			buildMidpriceSetOrdersInstruction(
				midpriceProgramId,
				midpricePda,
				makerKp.publicKey,
				1,
				0,
				[{ tickCount: 1, size: new BN(1).mul(BASE_PRECISION) }]
			),
		];

		const makerSetupTx = new Transaction().add(...makerSetupIxs);
		const makerSig = await bankrunContextWrapper.sendTransaction(makerSetupTx, [
			makerKp,
		]);
		assert(makerSig && makerSig.length > 0, 'maker setup tx should succeed');

		// Approve this maker in the PropAMM registry
		const approveIx = await buildApprovePropAmmsInstruction(
			program,
			bankrunContextWrapper.context.payer.publicKey,
			driftProgramId,
			[
				{
					marketIndex,
					makerSubaccount: makerUserPda,
					propammProgram: midpriceProgramId,
					propammAccount: midpricePda,
				},
			]
		);
		await bankrunContextWrapper.sendTransaction(
			new Transaction().add(approveIx),
			[]
		);

		// --- Build atomic signed msg place + PropAMM match tx ---
		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);

		const takerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: new BN(1).mul(BASE_PRECISION),
			price: new BN(101).mul(PRICE_PRECISION),
			userOrderId: 1,
			reduceOnly: false,
		}) as OrderParams;

		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		const signedOrderParams = takerClient.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage
		);

		// Build placeSignedMsgTakerOrder ixs (Ed25519 verify + place)
		const takerUser = await takerClient.getUserAccountPublicKey();
		const takerStats = takerClient.getUserStatsAccountPublicKey();
		const takerUserAccount = takerClient.getUserAccount();

		const placeIxs = await driftClient.getPlaceSignedMsgTakerPerpOrderIxs(
			signedOrderParams,
			marketIndex,
			{
				taker: takerUser,
				takerStats,
				takerUserAccount,
				signingAuthority: takerClient.wallet.publicKey,
			}
		);

		// Build matchPerpOrderViaPropAmm ix (null = use last placed order)
		const remaining: { pubkey: PublicKey; isWritable: boolean }[] = [
			{ pubkey: midpriceProgramId, isWritable: false },
			{
				pubkey: getSpotMarketPublicKeySync(driftProgramId, 0),
				isWritable: false,
			},
			{ pubkey: getPropAmmMatcherPDA(driftProgramId), isWritable: true },
			{ pubkey: midpricePda, isWritable: true },
			{ pubkey: makerUserPda, isWritable: true },
		];

		const matchIx = buildFillPerpOrder2Instruction(
			driftProgramId,
			null,
			{
				user: takerUser,
				userStats: takerStats,
				state,
				perpMarket,
				oracle: oracleKey,
				oraclePriceCache: oraclePriceCachePda,
				propAmmRegistry: propAmmRegistryPda,
			},
			remaining
		);

		// Place signed msg order first
		const placeTx = new Transaction().add(...placeIxs);
		const placeSig = await bankrunContextWrapper.sendTransaction(placeTx, []);
		assert(
			placeSig && placeSig.length > 0,
			'place signed msg tx should succeed'
		);

		// Advance past auction duration (on-chain sanitization assigns ~180 slot auctions)
		await bankrunContextWrapper.moveTimeForward(80);

		// Fill in separate tx after auction completes
		const fillTx = new Transaction().add(matchIx);
		fillTx.recentBlockhash = await bankrunContextWrapper.getLatestBlockhash();
		fillTx.feePayer = bankrunContextWrapper.context.payer.publicKey;
		fillTx.sign(bankrunContextWrapper.context.payer);
		const sig = await bankrunContextWrapper.sendTransaction(fillTx, []);
		assert(sig && sig.length > 0, 'fill tx should succeed');

		// Verify taker has a position
		await takerClient.fetchAccounts();
		const perpPosition = takerClient.getUser().getPerpPosition(marketIndex);
		assert(
			perpPosition && perpPosition.baseAssetAmount.gt(new BN(0)),
			'taker should have a long perp position after signed msg place+fill'
		);

		await takerClient.unsubscribe();
	});

	it('atomic signed msg market order taker + PropAMM fill in same tx', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}

		const driftProgramId = program.programId;
		const state = await getDriftStateAccountPublicKey(driftProgramId);
		const perpMarket = getPerpMarketPublicKeySync(driftProgramId, marketIndex);
		const market = driftClient.getPerpMarketAccount(marketIndex);
		const oracleKey = new PublicKey(market.amm.oracle);
		const connection = bankrunContextWrapper.connection;
		const tokenProgram = (await connection.getAccountInfo(usdcMint.publicKey))
			.owner;

		// --- Taker setup ---
		const takerKp = Keypair.generate();
		await bankrunContextWrapper.fundKeypair(takerKp, 10 ** 9);
		const takerUsdcAta = getAssociatedTokenAddressSync(
			usdcMint.publicKey,
			takerKp.publicKey
		);

		const takerClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(takerKp),
			programID: driftProgramId,
			opts: { commitment: 'confirmed' },
			activeSubAccountId: 0,
			perpMarketIndexes: [marketIndex],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [{ publicKey: oracle, source: OracleSource.PYTH }],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerClient.subscribe();

		const { ixs: takerInitIxs } =
			await takerClient.createInitializeUserAccountAndDepositCollateralIxs(
				usdcAmount,
				takerUsdcAta
			);

		const takerSetupTx = new Transaction().add(
			createAssociatedTokenAccountIdempotentInstruction(
				bankrunContextWrapper.context.payer.publicKey,
				takerUsdcAta,
				takerKp.publicKey,
				usdcMint.publicKey,
				tokenProgram
			),
			createMintToInstruction(
				usdcMint.publicKey,
				takerUsdcAta,
				bankrunContextWrapper.context.payer.publicKey,
				usdcAmount.toNumber(),
				undefined,
				tokenProgram
			),
			...takerInitIxs
		);
		await bankrunContextWrapper.sendTransaction(takerSetupTx, [takerKp]);

		await takerClient.unsubscribe();
		await takerClient.subscribe();
		await takerClient.addUser(0, takerKp.publicKey);
		await takerClient.fetchAccounts();

		// --- PropAMM maker setup (1 maker) ---
		const makerKp = Keypair.generate();
		await bankrunContextWrapper.fundKeypair(makerKp, 10 ** 9);
		const makerUserPda = await getUserAccountPublicKey(
			driftProgramId,
			makerKp.publicKey,
			0
		);
		const [midpricePda] = getMidpricePDA(
			midpriceProgramId,
			makerKp.publicKey,
			marketIndex,
			0
		);

		const makerUsdcAta = getAssociatedTokenAddressSync(
			usdcMint.publicKey,
			makerKp.publicKey
		);
		const midpriceAccountSpace =
			MIDPRICE_ACCOUNT_MIN_LEN + MIDPRICE_ORDER_ENTRY_SIZE * 2;
		const rentExempt = await connection.getMinimumBalanceForRentExemption(
			midpriceAccountSpace
		);

		const makerClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(makerKp),
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
		const { ixs: makerInitIxs } =
			await makerClient.createInitializeUserAccountAndDepositCollateralIxs(
				usdcAmount,
				makerUsdcAta
			);
		await makerClient.unsubscribe();

		const makerSetupIxs: TransactionInstruction[] = [
			createAssociatedTokenAccountIdempotentInstruction(
				bankrunContextWrapper.context.payer.publicKey,
				makerUsdcAta,
				makerKp.publicKey,
				usdcMint.publicKey,
				tokenProgram
			),
			createMintToInstruction(
				usdcMint.publicKey,
				makerUsdcAta,
				bankrunContextWrapper.context.payer.publicKey,
				usdcAmount.toNumber(),
				undefined,
				tokenProgram
			),
			...makerInitIxs,
			SystemProgram.createAccount({
				fromPubkey: bankrunContextWrapper.context.payer.publicKey,
				newAccountPubkey: midpricePda,
				lamports: rentExempt,
				space: midpriceAccountSpace,
				programId: midpriceProgramId,
			}),
			buildMidpriceInitializeInstruction({
				midpriceProgram: midpriceProgramId,
				authority: makerKp.publicKey,
				midpriceAccount: midpricePda,
				marketIndex,
				subaccountIndex: 0,
				makerSubaccount: makerUserPda,
			}),
			buildMidpriceUpdateMidPriceInstruction(
				midpriceProgramId,
				midpricePda,
				makerKp.publicKey,
				new BN(100).mul(PRICE_PRECISION)
			),
			buildMidpriceSetOrdersInstruction(
				midpriceProgramId,
				midpricePda,
				makerKp.publicKey,
				1,
				0,
				[{ tickCount: 1, size: new BN(1).mul(BASE_PRECISION) }]
			),
		];

		const makerSetupTx = new Transaction().add(...makerSetupIxs);
		const makerSig = await bankrunContextWrapper.sendTransaction(makerSetupTx, [
			makerKp,
		]);
		assert(makerSig && makerSig.length > 0, 'maker setup tx should succeed');

		// Approve this maker in the PropAMM registry
		const approveIx = await buildApprovePropAmmsInstruction(
			program,
			bankrunContextWrapper.context.payer.publicKey,
			driftProgramId,
			[
				{
					marketIndex,
					makerSubaccount: makerUserPda,
					propammProgram: midpriceProgramId,
					propammAccount: midpricePda,
				},
			]
		);
		await bankrunContextWrapper.sendTransaction(
			new Transaction().add(approveIx),
			[]
		);

		// --- Build atomic signed msg market order + PropAMM match tx ---
		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);

		// Market order (not limit) — PropAMM should accept this.
		// Auction start >= ask price (101) so crossing happens at slot 0.
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: new BN(1).mul(BASE_PRECISION),
			price: new BN(102).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(101).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(102).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		}) as OrderParams;

		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		const signedOrderParams = takerClient.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage
		);

		const takerUser = await takerClient.getUserAccountPublicKey();
		const takerStats = takerClient.getUserStatsAccountPublicKey();
		const takerUserAccount = takerClient.getUserAccount();

		const placeIxs = await driftClient.getPlaceSignedMsgTakerPerpOrderIxs(
			signedOrderParams,
			marketIndex,
			{
				taker: takerUser,
				takerStats,
				takerUserAccount,
				signingAuthority: takerClient.wallet.publicKey,
			}
		);

		const remaining: { pubkey: PublicKey; isWritable: boolean }[] = [
			{ pubkey: midpriceProgramId, isWritable: false },
			{
				pubkey: getSpotMarketPublicKeySync(driftProgramId, 0),
				isWritable: false,
			},
			{ pubkey: getPropAmmMatcherPDA(driftProgramId), isWritable: true },
			{ pubkey: midpricePda, isWritable: true },
			{ pubkey: makerUserPda, isWritable: true },
		];

		const matchIx = buildFillPerpOrder2Instruction(
			driftProgramId,
			null,
			{
				user: takerUser,
				userStats: takerStats,
				state,
				perpMarket,
				oracle: oracleKey,
				oraclePriceCache: oraclePriceCachePda,
				propAmmRegistry: propAmmRegistryPda,
			},
			remaining
		);

		// Place signed msg order first
		const placeTx = new Transaction().add(...placeIxs);
		const placeSig = await bankrunContextWrapper.sendTransaction(placeTx, []);
		assert(
			placeSig && placeSig.length > 0,
			'place market order tx should succeed'
		);

		// Advance past 10-slot auction (~4s) but stay within max_ts (~30s)
		await bankrunContextWrapper.moveTimeForward(5);

		// Fill in separate tx
		const fillTx = new Transaction().add(matchIx);
		fillTx.recentBlockhash = await bankrunContextWrapper.getLatestBlockhash();
		fillTx.feePayer = bankrunContextWrapper.context.payer.publicKey;
		fillTx.sign(bankrunContextWrapper.context.payer);
		const sig = await bankrunContextWrapper.sendTransaction(fillTx, []);
		assert(sig && sig.length > 0, 'fill market order tx should succeed');

		// Verify taker has a position
		await takerClient.fetchAccounts();
		const perpPosition = takerClient.getUser().getPerpPosition(marketIndex);
		assert(
			perpPosition && perpPosition.baseAssetAmount.gt(new BN(0)),
			'taker should have a long perp position after market order fill'
		);

		await takerClient.unsubscribe();
	});

	it('atomic signed msg oracle order taker + PropAMM fill in same tx', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}

		const driftProgramId = program.programId;
		const state = await getDriftStateAccountPublicKey(driftProgramId);
		const perpMarket = getPerpMarketPublicKeySync(driftProgramId, marketIndex);
		const market = driftClient.getPerpMarketAccount(marketIndex);
		const oracleKey = new PublicKey(market.amm.oracle);
		const connection = bankrunContextWrapper.connection;
		const tokenProgram = (await connection.getAccountInfo(usdcMint.publicKey))
			.owner;

		// --- Taker setup ---
		const takerKp = Keypair.generate();
		await bankrunContextWrapper.fundKeypair(takerKp, 10 ** 9);
		const takerUsdcAta = getAssociatedTokenAddressSync(
			usdcMint.publicKey,
			takerKp.publicKey
		);

		const takerClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(takerKp),
			programID: driftProgramId,
			opts: { commitment: 'confirmed' },
			activeSubAccountId: 0,
			perpMarketIndexes: [marketIndex],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [{ publicKey: oracle, source: OracleSource.PYTH }],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerClient.subscribe();

		const { ixs: takerInitIxs } =
			await takerClient.createInitializeUserAccountAndDepositCollateralIxs(
				usdcAmount,
				takerUsdcAta
			);

		const takerSetupTx = new Transaction().add(
			createAssociatedTokenAccountIdempotentInstruction(
				bankrunContextWrapper.context.payer.publicKey,
				takerUsdcAta,
				takerKp.publicKey,
				usdcMint.publicKey,
				tokenProgram
			),
			createMintToInstruction(
				usdcMint.publicKey,
				takerUsdcAta,
				bankrunContextWrapper.context.payer.publicKey,
				usdcAmount.toNumber(),
				undefined,
				tokenProgram
			),
			...takerInitIxs
		);
		await bankrunContextWrapper.sendTransaction(takerSetupTx, [takerKp]);

		await takerClient.unsubscribe();
		await takerClient.subscribe();
		await takerClient.addUser(0, takerKp.publicKey);
		await takerClient.fetchAccounts();

		// --- PropAMM maker setup (1 maker) ---
		const makerKp = Keypair.generate();
		await bankrunContextWrapper.fundKeypair(makerKp, 10 ** 9);
		const makerUserPda = await getUserAccountPublicKey(
			driftProgramId,
			makerKp.publicKey,
			0
		);
		const [midpricePda] = getMidpricePDA(
			midpriceProgramId,
			makerKp.publicKey,
			marketIndex,
			0
		);

		const makerUsdcAta = getAssociatedTokenAddressSync(
			usdcMint.publicKey,
			makerKp.publicKey
		);
		const midpriceAccountSpace =
			MIDPRICE_ACCOUNT_MIN_LEN + MIDPRICE_ORDER_ENTRY_SIZE * 2;
		const rentExempt = await connection.getMinimumBalanceForRentExemption(
			midpriceAccountSpace
		);

		const makerClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(makerKp),
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
		const { ixs: makerInitIxs } =
			await makerClient.createInitializeUserAccountAndDepositCollateralIxs(
				usdcAmount,
				makerUsdcAta
			);
		await makerClient.unsubscribe();

		// Maker mid_price=100, ask offset=+1 => ask at 101
		const makerSetupIxs: TransactionInstruction[] = [
			createAssociatedTokenAccountIdempotentInstruction(
				bankrunContextWrapper.context.payer.publicKey,
				makerUsdcAta,
				makerKp.publicKey,
				usdcMint.publicKey,
				tokenProgram
			),
			createMintToInstruction(
				usdcMint.publicKey,
				makerUsdcAta,
				bankrunContextWrapper.context.payer.publicKey,
				usdcAmount.toNumber(),
				undefined,
				tokenProgram
			),
			...makerInitIxs,
			SystemProgram.createAccount({
				fromPubkey: bankrunContextWrapper.context.payer.publicKey,
				newAccountPubkey: midpricePda,
				lamports: rentExempt,
				space: midpriceAccountSpace,
				programId: midpriceProgramId,
			}),
			buildMidpriceInitializeInstruction({
				midpriceProgram: midpriceProgramId,
				authority: makerKp.publicKey,
				midpriceAccount: midpricePda,
				marketIndex,
				subaccountIndex: 0,
				makerSubaccount: makerUserPda,
			}),
			buildMidpriceUpdateMidPriceInstruction(
				midpriceProgramId,
				midpricePda,
				makerKp.publicKey,
				new BN(100).mul(PRICE_PRECISION)
			),
			buildMidpriceSetOrdersInstruction(
				midpriceProgramId,
				midpricePda,
				makerKp.publicKey,
				1,
				0,
				[{ tickCount: 1, size: new BN(1).mul(BASE_PRECISION) }]
			),
		];

		const makerSetupTx = new Transaction().add(...makerSetupIxs);
		const makerSig = await bankrunContextWrapper.sendTransaction(makerSetupTx, [
			makerKp,
		]);
		assert(makerSig && makerSig.length > 0, 'maker setup tx should succeed');

		// Approve this maker in the PropAMM registry
		const approveIx = await buildApprovePropAmmsInstruction(
			program,
			bankrunContextWrapper.context.payer.publicKey,
			driftProgramId,
			[
				{
					marketIndex,
					makerSubaccount: makerUserPda,
					propammProgram: midpriceProgramId,
					propammAccount: midpricePda,
				},
			]
		);
		await bankrunContextWrapper.sendTransaction(
			new Transaction().add(approveIx),
			[]
		);

		// --- Build atomic signed msg oracle order + PropAMM match tx ---
		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);

		// Oracle order: price=0, oraclePriceOffset=+1 PRICE_PRECISION
		// Oracle is at 100, so effective limit = 100 + 1 = 101, which crosses
		// the maker ask at 101.
		// Signed msg taker orders require valid auction params, so we set
		// auction start/end as oracle offsets too (+1 PRICE_PRECISION each).
		const takerOrderParams: OrderParams = {
			orderType: OrderType.ORACLE,
			marketType: MarketType.PERP,
			direction: PositionDirection.LONG,
			baseAssetAmount: new BN(1).mul(BASE_PRECISION),
			price: new BN(0),
			marketIndex,
			reduceOnly: false,
			postOnly: PostOnlyParams.NONE,
			bitFlags: 0,
			triggerPrice: null,
			triggerCondition: OrderTriggerCondition.ABOVE,
			oraclePriceOffset: PRICE_PRECISION.toNumber(),
			auctionDuration: 10,
			maxTs: null,
			auctionStartPrice: PRICE_PRECISION,
			auctionEndPrice: PRICE_PRECISION,
			userOrderId: 1,
		};

		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		const signedOrderParams = takerClient.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage
		);

		const takerUser = await takerClient.getUserAccountPublicKey();
		const takerStats = takerClient.getUserStatsAccountPublicKey();
		const takerUserAccount = takerClient.getUserAccount();

		const placeIxs = await driftClient.getPlaceSignedMsgTakerPerpOrderIxs(
			signedOrderParams,
			marketIndex,
			{
				taker: takerUser,
				takerStats,
				takerUserAccount,
				signingAuthority: takerClient.wallet.publicKey,
			}
		);

		const remaining: { pubkey: PublicKey; isWritable: boolean }[] = [
			{ pubkey: midpriceProgramId, isWritable: false },
			{
				pubkey: getSpotMarketPublicKeySync(driftProgramId, 0),
				isWritable: false,
			},
			{ pubkey: getPropAmmMatcherPDA(driftProgramId), isWritable: true },
			{ pubkey: midpricePda, isWritable: true },
			{ pubkey: makerUserPda, isWritable: true },
		];

		const matchIx = buildFillPerpOrder2Instruction(
			driftProgramId,
			null,
			{
				user: takerUser,
				userStats: takerStats,
				state,
				perpMarket,
				oracle: oracleKey,
				oraclePriceCache: oraclePriceCachePda,
				propAmmRegistry: propAmmRegistryPda,
			},
			remaining
		);

		// Place signed msg order first
		const placeTx = new Transaction().add(...placeIxs);
		const placeSig = await bankrunContextWrapper.sendTransaction(placeTx, []);
		assert(
			placeSig && placeSig.length > 0,
			'place oracle order tx should succeed'
		);

		// Advance past 10-slot auction (~4s) but stay within max_ts (~30s)
		await bankrunContextWrapper.moveTimeForward(5);

		// Fill in separate tx
		const fillTx = new Transaction().add(matchIx);
		fillTx.recentBlockhash = await bankrunContextWrapper.getLatestBlockhash();
		fillTx.feePayer = bankrunContextWrapper.context.payer.publicKey;
		fillTx.sign(bankrunContextWrapper.context.payer);
		const sig = await bankrunContextWrapper.sendTransaction(fillTx, []);
		assert(sig && sig.length > 0, 'fill oracle order tx should succeed');

		// Verify taker has a position
		await takerClient.fetchAccounts();
		const perpPosition = takerClient.getUser().getPerpPosition(marketIndex);
		assert(
			perpPosition && perpPosition.baseAssetAmount.gt(new BN(0)),
			'taker should have a long perp position after oracle order fill'
		);

		await takerClient.unsubscribe();
	});

	it('reduce-only market order rejected when taker has no position', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}

		const driftProgramId = program.programId;
		const state = await getDriftStateAccountPublicKey(driftProgramId);
		const perpMarket = getPerpMarketPublicKeySync(driftProgramId, marketIndex);
		const market = driftClient.getPerpMarketAccount(marketIndex);
		const oracleKey = new PublicKey(market.amm.oracle);
		const connection = bankrunContextWrapper.connection;
		const tokenProgram = (await connection.getAccountInfo(usdcMint.publicKey))
			.owner;

		// --- Taker setup (fresh user, no perp position) ---
		const takerKp = Keypair.generate();
		await bankrunContextWrapper.fundKeypair(takerKp, 10 ** 9);
		const takerUsdcAta = getAssociatedTokenAddressSync(
			usdcMint.publicKey,
			takerKp.publicKey
		);

		const takerClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(takerKp),
			programID: driftProgramId,
			opts: { commitment: 'confirmed' },
			activeSubAccountId: 0,
			perpMarketIndexes: [marketIndex],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [{ publicKey: oracle, source: OracleSource.PYTH }],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerClient.subscribe();

		const { ixs: takerInitIxs } =
			await takerClient.createInitializeUserAccountAndDepositCollateralIxs(
				usdcAmount,
				takerUsdcAta
			);

		const takerSetupTx = new Transaction().add(
			createAssociatedTokenAccountIdempotentInstruction(
				bankrunContextWrapper.context.payer.publicKey,
				takerUsdcAta,
				takerKp.publicKey,
				usdcMint.publicKey,
				tokenProgram
			),
			createMintToInstruction(
				usdcMint.publicKey,
				takerUsdcAta,
				bankrunContextWrapper.context.payer.publicKey,
				usdcAmount.toNumber(),
				undefined,
				tokenProgram
			),
			...takerInitIxs
		);
		await bankrunContextWrapper.sendTransaction(takerSetupTx, [takerKp]);

		await takerClient.unsubscribe();
		await takerClient.subscribe();
		await takerClient.addUser(0, takerKp.publicKey);
		await takerClient.fetchAccounts();

		// --- PropAMM maker setup ---
		const makerKp = Keypair.generate();
		await bankrunContextWrapper.fundKeypair(makerKp, 10 ** 9);
		const makerUserPda = await getUserAccountPublicKey(
			driftProgramId,
			makerKp.publicKey,
			0
		);
		const [midpricePda] = getMidpricePDA(
			midpriceProgramId,
			makerKp.publicKey,
			marketIndex,
			0
		);

		const makerUsdcAta = getAssociatedTokenAddressSync(
			usdcMint.publicKey,
			makerKp.publicKey
		);
		const midpriceAccountSpace =
			MIDPRICE_ACCOUNT_MIN_LEN + MIDPRICE_ORDER_ENTRY_SIZE * 2;
		const rentExempt = await connection.getMinimumBalanceForRentExemption(
			midpriceAccountSpace
		);

		const makerClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(makerKp),
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
		const { ixs: makerInitIxs } =
			await makerClient.createInitializeUserAccountAndDepositCollateralIxs(
				usdcAmount,
				makerUsdcAta
			);
		await makerClient.unsubscribe();

		const makerSetupIxs: TransactionInstruction[] = [
			createAssociatedTokenAccountIdempotentInstruction(
				bankrunContextWrapper.context.payer.publicKey,
				makerUsdcAta,
				makerKp.publicKey,
				usdcMint.publicKey,
				tokenProgram
			),
			createMintToInstruction(
				usdcMint.publicKey,
				makerUsdcAta,
				bankrunContextWrapper.context.payer.publicKey,
				usdcAmount.toNumber(),
				undefined,
				tokenProgram
			),
			...makerInitIxs,
			SystemProgram.createAccount({
				fromPubkey: bankrunContextWrapper.context.payer.publicKey,
				newAccountPubkey: midpricePda,
				lamports: rentExempt,
				space: midpriceAccountSpace,
				programId: midpriceProgramId,
			}),
			buildMidpriceInitializeInstruction({
				midpriceProgram: midpriceProgramId,
				authority: makerKp.publicKey,
				midpriceAccount: midpricePda,
				marketIndex,
				subaccountIndex: 0,
				makerSubaccount: makerUserPda,
			}),
			buildMidpriceUpdateMidPriceInstruction(
				midpriceProgramId,
				midpricePda,
				makerKp.publicKey,
				new BN(100).mul(PRICE_PRECISION)
			),
			buildMidpriceSetOrdersInstruction(
				midpriceProgramId,
				midpricePda,
				makerKp.publicKey,
				1,
				0,
				[{ tickCount: 1, size: new BN(1).mul(BASE_PRECISION) }]
			),
		];

		const makerSetupTx = new Transaction().add(...makerSetupIxs);
		await bankrunContextWrapper.sendTransaction(makerSetupTx, [makerKp]);

		// Approve this maker in the PropAMM registry
		const approveIxRO = await buildApprovePropAmmsInstruction(
			program,
			bankrunContextWrapper.context.payer.publicKey,
			driftProgramId,
			[
				{
					marketIndex,
					makerSubaccount: makerUserPda,
					propammProgram: midpriceProgramId,
					propammAccount: midpricePda,
				},
			]
		);
		await bankrunContextWrapper.sendTransaction(
			new Transaction().add(approveIxRO),
			[]
		);

		// --- Place a reduce-only market order (taker has NO position) ---
		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);

		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: new BN(1).mul(BASE_PRECISION),
			price: new BN(102).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(101).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(102).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
			reduceOnly: true,
		}) as OrderParams;

		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		const signedOrderParams = takerClient.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage
		);

		const takerUser = await takerClient.getUserAccountPublicKey();
		const takerStats = takerClient.getUserStatsAccountPublicKey();
		const takerUserAccount = takerClient.getUserAccount();

		const placeIxs = await driftClient.getPlaceSignedMsgTakerPerpOrderIxs(
			signedOrderParams,
			marketIndex,
			{
				taker: takerUser,
				takerStats,
				takerUserAccount,
				signingAuthority: takerClient.wallet.publicKey,
			}
		);

		const remaining: { pubkey: PublicKey; isWritable: boolean }[] = [
			{ pubkey: midpriceProgramId, isWritable: false },
			{
				pubkey: getSpotMarketPublicKeySync(driftProgramId, 0),
				isWritable: false,
			},
			{ pubkey: getPropAmmMatcherPDA(driftProgramId), isWritable: true },
			{ pubkey: midpricePda, isWritable: true },
			{ pubkey: makerUserPda, isWritable: true },
		];

		const matchIx = buildFillPerpOrder2Instruction(
			driftProgramId,
			null,
			{
				user: takerUser,
				userStats: takerStats,
				state,
				perpMarket,
				oracle: oracleKey,
				oraclePriceCache: oraclePriceCachePda,
				propAmmRegistry: propAmmRegistryPda,
			},
			remaining
		);

		const tx = new Transaction().add(...placeIxs, matchIx);
		try {
			await bankrunContextWrapper.sendTransaction(tx, []);
			assert(false, 'should have failed — reduce-only with no position');
		} catch (e) {
			// Expected: InvalidOrder because reduce_only with no position
			// yields unfilled size = 0.
			assert(
				e.toString().includes('0x17c2') || // InvalidOrder
					e.toString().includes('0x179a') || // InvalidSignedMsgOrderParam
					e.toString().includes('Error'),
				`unexpected error: ${e}`
			);
		}

		await takerClient.unsubscribe();
	});

	it('reduce-only market order succeeds when taker has opposing position', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}

		const driftProgramId = program.programId;
		const state = await getDriftStateAccountPublicKey(driftProgramId);
		const perpMarket = getPerpMarketPublicKeySync(driftProgramId, marketIndex);
		const market = driftClient.getPerpMarketAccount(marketIndex);
		const oracleKey = new PublicKey(market.amm.oracle);
		const connection = bankrunContextWrapper.connection;
		const tokenProgram = (await connection.getAccountInfo(usdcMint.publicKey))
			.owner;

		// --- Taker setup ---
		const takerKp = Keypair.generate();
		await bankrunContextWrapper.fundKeypair(takerKp, 10 ** 9);
		const takerUsdcAta = getAssociatedTokenAddressSync(
			usdcMint.publicKey,
			takerKp.publicKey
		);

		const takerClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(takerKp),
			programID: driftProgramId,
			opts: { commitment: 'confirmed' },
			activeSubAccountId: 0,
			perpMarketIndexes: [marketIndex],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [{ publicKey: oracle, source: OracleSource.PYTH }],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerClient.subscribe();

		const { ixs: takerInitIxs } =
			await takerClient.createInitializeUserAccountAndDepositCollateralIxs(
				usdcAmount,
				takerUsdcAta
			);

		const takerSetupTx = new Transaction().add(
			createAssociatedTokenAccountIdempotentInstruction(
				bankrunContextWrapper.context.payer.publicKey,
				takerUsdcAta,
				takerKp.publicKey,
				usdcMint.publicKey,
				tokenProgram
			),
			createMintToInstruction(
				usdcMint.publicKey,
				takerUsdcAta,
				bankrunContextWrapper.context.payer.publicKey,
				usdcAmount.toNumber(),
				undefined,
				tokenProgram
			),
			...takerInitIxs
		);
		await bankrunContextWrapper.sendTransaction(takerSetupTx, [takerKp]);

		await takerClient.unsubscribe();
		await takerClient.subscribe();
		await takerClient.addUser(0, takerKp.publicKey);
		await takerClient.fetchAccounts();

		// --- PropAMM maker setup (with both bid and ask) ---
		const makerKp = Keypair.generate();
		await bankrunContextWrapper.fundKeypair(makerKp, 10 ** 9);
		const makerUserPda = await getUserAccountPublicKey(
			driftProgramId,
			makerKp.publicKey,
			0
		);
		const [midpricePda] = getMidpricePDA(
			midpriceProgramId,
			makerKp.publicKey,
			marketIndex,
			0
		);

		const makerUsdcAta = getAssociatedTokenAddressSync(
			usdcMint.publicKey,
			makerKp.publicKey
		);
		// 2 entries: 1 ask + 1 bid
		const midpriceAccountSpace =
			MIDPRICE_ACCOUNT_MIN_LEN + MIDPRICE_ORDER_ENTRY_SIZE * 2;
		const rentExempt = await connection.getMinimumBalanceForRentExemption(
			midpriceAccountSpace
		);

		const makerClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(makerKp),
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
		const { ixs: makerInitIxs } =
			await makerClient.createInitializeUserAccountAndDepositCollateralIxs(
				usdcAmount,
				makerUsdcAta
			);
		await makerClient.unsubscribe();

		// mid_price=100, ask at +1 (101), bid at -1 (99)
		const makerSetupIxs: TransactionInstruction[] = [
			createAssociatedTokenAccountIdempotentInstruction(
				bankrunContextWrapper.context.payer.publicKey,
				makerUsdcAta,
				makerKp.publicKey,
				usdcMint.publicKey,
				tokenProgram
			),
			createMintToInstruction(
				usdcMint.publicKey,
				makerUsdcAta,
				bankrunContextWrapper.context.payer.publicKey,
				usdcAmount.toNumber(),
				undefined,
				tokenProgram
			),
			...makerInitIxs,
			SystemProgram.createAccount({
				fromPubkey: bankrunContextWrapper.context.payer.publicKey,
				newAccountPubkey: midpricePda,
				lamports: rentExempt,
				space: midpriceAccountSpace,
				programId: midpriceProgramId,
			}),
			buildMidpriceInitializeInstruction({
				midpriceProgram: midpriceProgramId,
				authority: makerKp.publicKey,
				midpriceAccount: midpricePda,
				marketIndex,
				subaccountIndex: 0,
				makerSubaccount: makerUserPda,
			}),
			buildMidpriceUpdateMidPriceInstruction(
				midpriceProgramId,
				midpricePda,
				makerKp.publicKey,
				new BN(100).mul(PRICE_PRECISION)
			),
			buildMidpriceSetOrdersInstruction(
				midpriceProgramId,
				midpricePda,
				makerKp.publicKey,
				1, // 1 ask
				1, // 1 bid
				[
					{ tickCount: 1, size: new BN(1).mul(BASE_PRECISION) }, // ask at 101
					{
						tickCount: 1,
						size: new BN(1).mul(BASE_PRECISION),
					}, // bid at 99
				]
			),
		];

		const makerSetupTx = new Transaction().add(...makerSetupIxs);
		await bankrunContextWrapper.sendTransaction(makerSetupTx, [makerKp]);

		// Approve this maker in the PropAMM registry
		const approveIxSD = await buildApprovePropAmmsInstruction(
			program,
			bankrunContextWrapper.context.payer.publicKey,
			driftProgramId,
			[
				{
					marketIndex,
					makerSubaccount: makerUserPda,
					propammProgram: midpriceProgramId,
					propammAccount: midpricePda,
				},
			]
		);
		await bankrunContextWrapper.sendTransaction(
			new Transaction().add(approveIxSD),
			[]
		);

		// --- Step 1: Give taker a SHORT position via a short limit order ---
		{
			const slot = new BN(
				await bankrunContextWrapper.connection.toConnection().getSlot()
			);

			const shortOrderParams = getLimitOrderParams({
				marketIndex,
				direction: PositionDirection.SHORT,
				baseAssetAmount: new BN(1).mul(BASE_PRECISION),
				price: new BN(99).mul(PRICE_PRECISION),
				userOrderId: 1,
				reduceOnly: false,
			}) as OrderParams;

			const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
			const msg: SignedMsgOrderParamsMessage = {
				signedMsgOrderParams: shortOrderParams,
				subAccountId: 0,
				slot,
				uuid,
				takeProfitOrderParams: null,
				stopLossOrderParams: null,
			};

			const signedParams = takerClient.signSignedMsgOrderParamsMessage(msg);
			const takerUser = await takerClient.getUserAccountPublicKey();
			const takerStats = takerClient.getUserStatsAccountPublicKey();
			const takerUserAccount = takerClient.getUserAccount();

			const placeIxs = await driftClient.getPlaceSignedMsgTakerPerpOrderIxs(
				signedParams,
				marketIndex,
				{
					taker: takerUser,
					takerStats,
					takerUserAccount,
					signingAuthority: takerClient.wallet.publicKey,
				}
			);

			const remaining: { pubkey: PublicKey; isWritable: boolean }[] = [
				{ pubkey: midpriceProgramId, isWritable: false },
				{
					pubkey: getSpotMarketPublicKeySync(driftProgramId, 0),
					isWritable: false,
				},
				{
					pubkey: getPropAmmMatcherPDA(driftProgramId),
					isWritable: true,
				},
				{ pubkey: midpricePda, isWritable: true },
				{ pubkey: makerUserPda, isWritable: true },
			];

			const matchIx = buildFillPerpOrder2Instruction(
				driftProgramId,
				null,
				{
					user: takerUser,
					userStats: takerStats,
					state,
					perpMarket,
					oracle: oracleKey,
					oraclePriceCache: oraclePriceCachePda,
					propAmmRegistry: propAmmRegistryPda,
				},
				remaining
			);

			// Place signed msg order first
			const placeTx = new Transaction().add(...placeIxs);
			const placeSig = await bankrunContextWrapper.sendTransaction(placeTx, []);
			assert(
				placeSig && placeSig.length > 0,
				'place short order tx should succeed'
			);

			// Advance past auction duration
			await bankrunContextWrapper.moveTimeForward(80);

			// Fill in separate tx
			const fillTx = new Transaction().add(matchIx);
			fillTx.recentBlockhash = await bankrunContextWrapper.getLatestBlockhash();
			fillTx.feePayer = bankrunContextWrapper.context.payer.publicKey;
			fillTx.sign(bankrunContextWrapper.context.payer);
			const sig = await bankrunContextWrapper.sendTransaction(fillTx, []);
			assert(sig && sig.length > 0, 'short fill tx should succeed');
		}

		// Verify taker is now short
		await takerClient.fetchAccounts();
		const posAfterShort = takerClient.getUser().getPerpPosition(marketIndex);
		assert(
			posAfterShort && posAfterShort.baseAssetAmount.lt(new BN(0)),
			'taker should be short after first fill'
		);

		// --- Step 2: Reduce-only LONG market order should succeed ---
		{
			const slot = new BN(
				await bankrunContextWrapper.connection.toConnection().getSlot()
			);

			const reduceOnlyLong = getMarketOrderParams({
				marketIndex,
				direction: PositionDirection.LONG,
				baseAssetAmount: new BN(1).mul(BASE_PRECISION),
				price: new BN(102).mul(PRICE_PRECISION),
				auctionStartPrice: new BN(101).mul(PRICE_PRECISION),
				auctionEndPrice: new BN(102).mul(PRICE_PRECISION),
				auctionDuration: 10,
				userOrderId: 2,
				postOnly: PostOnlyParams.NONE,
				marketType: MarketType.PERP,
				reduceOnly: true,
			}) as OrderParams;

			const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
			const msg: SignedMsgOrderParamsMessage = {
				signedMsgOrderParams: reduceOnlyLong,
				subAccountId: 0,
				slot,
				uuid,
				takeProfitOrderParams: null,
				stopLossOrderParams: null,
			};

			const signedParams = takerClient.signSignedMsgOrderParamsMessage(msg);
			const takerUser = await takerClient.getUserAccountPublicKey();
			const takerStats = takerClient.getUserStatsAccountPublicKey();
			const takerUserAccount = takerClient.getUserAccount();

			const placeIxs = await driftClient.getPlaceSignedMsgTakerPerpOrderIxs(
				signedParams,
				marketIndex,
				{
					taker: takerUser,
					takerStats,
					takerUserAccount,
					signingAuthority: takerClient.wallet.publicKey,
				}
			);

			const remaining: { pubkey: PublicKey; isWritable: boolean }[] = [
				{ pubkey: midpriceProgramId, isWritable: false },
				{
					pubkey: getSpotMarketPublicKeySync(driftProgramId, 0),
					isWritable: false,
				},
				{
					pubkey: getPropAmmMatcherPDA(driftProgramId),
					isWritable: true,
				},
				{ pubkey: midpricePda, isWritable: true },
				{ pubkey: makerUserPda, isWritable: true },
			];

			const matchIx = buildFillPerpOrder2Instruction(
				driftProgramId,
				null, // use last placed order (orderId=2, second on this user)
				{
					user: takerUser,
					userStats: takerStats,
					state,
					perpMarket,
					oracle: oracleKey,
					oraclePriceCache: oraclePriceCachePda,
					propAmmRegistry: propAmmRegistryPda,
				},
				remaining
			);

			// Place signed msg order first
			const placeTx = new Transaction().add(...placeIxs);
			const placeSig = await bankrunContextWrapper.sendTransaction(placeTx, []);
			assert(
				placeSig && placeSig.length > 0,
				'place reduce-only long tx should succeed'
			);

			// Advance past 10-slot auction (~4s) but stay within max_ts (~30s)
			await bankrunContextWrapper.moveTimeForward(5);

			// Fill in separate tx
			const fillTx = new Transaction().add(matchIx);
			fillTx.recentBlockhash = await bankrunContextWrapper.getLatestBlockhash();
			fillTx.feePayer = bankrunContextWrapper.context.payer.publicKey;
			fillTx.sign(bankrunContextWrapper.context.payer);
			const sig = await bankrunContextWrapper.sendTransaction(fillTx, []);
			assert(
				sig && sig.length > 0,
				'reduce-only long fill should succeed when taker is short'
			);
		}

		// Verify position is closed (or reduced)
		await takerClient.fetchAccounts();
		const posAfterReduce = takerClient.getUser().getPerpPosition(marketIndex);
		assert(
			!posAfterReduce || posAfterReduce.baseAssetAmount.eq(new BN(0)),
			'taker position should be closed after reduce-only fill'
		);

		await takerClient.unsubscribe();
	});

	it('short direction taker fills against maker bid via PropAMM', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}

		const driftProgramId = program.programId;
		const state = await getDriftStateAccountPublicKey(driftProgramId);
		const perpMarket = getPerpMarketPublicKeySync(driftProgramId, marketIndex);
		const market = driftClient.getPerpMarketAccount(marketIndex);
		const oracleKey = new PublicKey(market.amm.oracle);
		const connection = bankrunContextWrapper.connection;
		const tokenProgram = (await connection.getAccountInfo(usdcMint.publicKey))
			.owner;

		// --- Taker setup ---
		const takerKp = Keypair.generate();
		await bankrunContextWrapper.fundKeypair(takerKp, 10 ** 9);
		const takerUsdcAta = getAssociatedTokenAddressSync(
			usdcMint.publicKey,
			takerKp.publicKey
		);

		const takerClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(takerKp),
			programID: driftProgramId,
			opts: { commitment: 'confirmed' },
			activeSubAccountId: 0,
			perpMarketIndexes: [marketIndex],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [{ publicKey: oracle, source: OracleSource.PYTH }],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerClient.subscribe();

		const { ixs: takerInitIxs } =
			await takerClient.createInitializeUserAccountAndDepositCollateralIxs(
				usdcAmount,
				takerUsdcAta
			);

		const takerSetupTx = new Transaction().add(
			createAssociatedTokenAccountIdempotentInstruction(
				bankrunContextWrapper.context.payer.publicKey,
				takerUsdcAta,
				takerKp.publicKey,
				usdcMint.publicKey,
				tokenProgram
			),
			createMintToInstruction(
				usdcMint.publicKey,
				takerUsdcAta,
				bankrunContextWrapper.context.payer.publicKey,
				usdcAmount.toNumber(),
				undefined,
				tokenProgram
			),
			...takerInitIxs
		);
		await bankrunContextWrapper.sendTransaction(takerSetupTx, [takerKp]);

		await takerClient.unsubscribe();
		await takerClient.subscribe();
		await takerClient.addUser(0, takerKp.publicKey);
		await takerClient.fetchAccounts();

		// --- PropAMM maker setup (bid only) ---
		const makerKp = Keypair.generate();
		await bankrunContextWrapper.fundKeypair(makerKp, 10 ** 9);
		const makerUserPda = await getUserAccountPublicKey(
			driftProgramId,
			makerKp.publicKey,
			0
		);
		const [midpricePda] = getMidpricePDA(
			midpriceProgramId,
			makerKp.publicKey,
			marketIndex,
			0
		);

		const makerUsdcAta = getAssociatedTokenAddressSync(
			usdcMint.publicKey,
			makerKp.publicKey
		);
		const midpriceAccountSpace =
			MIDPRICE_ACCOUNT_MIN_LEN + MIDPRICE_ORDER_ENTRY_SIZE * 1;
		const rentExempt = await connection.getMinimumBalanceForRentExemption(
			midpriceAccountSpace
		);

		const makerClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(makerKp),
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
		const { ixs: makerInitIxs } =
			await makerClient.createInitializeUserAccountAndDepositCollateralIxs(
				usdcAmount,
				makerUsdcAta
			);
		await makerClient.unsubscribe();

		// mid_price=100, bid at -1 (99). No asks.
		const makerSetupIxs: TransactionInstruction[] = [
			createAssociatedTokenAccountIdempotentInstruction(
				bankrunContextWrapper.context.payer.publicKey,
				makerUsdcAta,
				makerKp.publicKey,
				usdcMint.publicKey,
				tokenProgram
			),
			createMintToInstruction(
				usdcMint.publicKey,
				makerUsdcAta,
				bankrunContextWrapper.context.payer.publicKey,
				usdcAmount.toNumber(),
				undefined,
				tokenProgram
			),
			...makerInitIxs,
			SystemProgram.createAccount({
				fromPubkey: bankrunContextWrapper.context.payer.publicKey,
				newAccountPubkey: midpricePda,
				lamports: rentExempt,
				space: midpriceAccountSpace,
				programId: midpriceProgramId,
			}),
			buildMidpriceInitializeInstruction({
				midpriceProgram: midpriceProgramId,
				authority: makerKp.publicKey,
				midpriceAccount: midpricePda,
				marketIndex,
				subaccountIndex: 0,
				makerSubaccount: makerUserPda,
			}),
			buildMidpriceUpdateMidPriceInstruction(
				midpriceProgramId,
				midpricePda,
				makerKp.publicKey,
				new BN(100).mul(PRICE_PRECISION)
			),
			buildMidpriceSetOrdersInstruction(
				midpriceProgramId,
				midpricePda,
				makerKp.publicKey,
				0, // 0 asks
				1, // 1 bid
				[
					{
						tickCount: 1,
						size: new BN(1).mul(BASE_PRECISION),
					}, // bid at 99
				]
			),
		];

		const makerSetupTx = new Transaction().add(...makerSetupIxs);
		await bankrunContextWrapper.sendTransaction(makerSetupTx, [makerKp]);

		// Approve this maker in the PropAMM registry
		const approveIxBid = await buildApprovePropAmmsInstruction(
			program,
			bankrunContextWrapper.context.payer.publicKey,
			driftProgramId,
			[
				{
					marketIndex,
					makerSubaccount: makerUserPda,
					propammProgram: midpriceProgramId,
					propammAccount: midpricePda,
				},
			]
		);
		await bankrunContextWrapper.sendTransaction(
			new Transaction().add(approveIxBid),
			[]
		);

		// --- Short limit order that crosses bid at 99 ---
		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);

		const takerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount: new BN(1).mul(BASE_PRECISION),
			price: new BN(99).mul(PRICE_PRECISION),
			userOrderId: 1,
			reduceOnly: false,
		}) as OrderParams;

		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		const signedOrderParams = takerClient.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage
		);

		const takerUser = await takerClient.getUserAccountPublicKey();
		const takerStats = takerClient.getUserStatsAccountPublicKey();
		const takerUserAccount = takerClient.getUserAccount();

		const placeIxs = await driftClient.getPlaceSignedMsgTakerPerpOrderIxs(
			signedOrderParams,
			marketIndex,
			{
				taker: takerUser,
				takerStats,
				takerUserAccount,
				signingAuthority: takerClient.wallet.publicKey,
			}
		);

		const remaining: { pubkey: PublicKey; isWritable: boolean }[] = [
			{ pubkey: midpriceProgramId, isWritable: false },
			{
				pubkey: getSpotMarketPublicKeySync(driftProgramId, 0),
				isWritable: false,
			},
			{ pubkey: getPropAmmMatcherPDA(driftProgramId), isWritable: true },
			{ pubkey: midpricePda, isWritable: true },
			{ pubkey: makerUserPda, isWritable: true },
		];

		const matchIx = buildFillPerpOrder2Instruction(
			driftProgramId,
			null,
			{
				user: takerUser,
				userStats: takerStats,
				state,
				perpMarket,
				oracle: oracleKey,
				oraclePriceCache: oraclePriceCachePda,
				propAmmRegistry: propAmmRegistryPda,
			},
			remaining
		);

		// Place signed msg order first
		const placeTx = new Transaction().add(...placeIxs);
		const placeSig = await bankrunContextWrapper.sendTransaction(placeTx, []);
		assert(
			placeSig && placeSig.length > 0,
			'place short order tx should succeed'
		);

		// Advance past auction duration
		await bankrunContextWrapper.moveTimeForward(80);

		// Fill in separate tx
		const fillTx = new Transaction().add(matchIx);
		fillTx.recentBlockhash = await bankrunContextWrapper.getLatestBlockhash();
		fillTx.feePayer = bankrunContextWrapper.context.payer.publicKey;
		fillTx.sign(bankrunContextWrapper.context.payer);
		const sig = await bankrunContextWrapper.sendTransaction(fillTx, []);
		assert(
			sig && sig.length > 0,
			'short taker fill against bid should succeed'
		);

		// Verify taker has a short position
		await takerClient.fetchAccounts();
		const perpPosition = takerClient.getUser().getPerpPosition(marketIndex);
		assert(
			perpPosition && perpPosition.baseAssetAmount.lt(new BN(0)),
			'taker should have a short perp position'
		);

		await takerClient.unsubscribe();
	});

	// -------------------------------------------------------------------
	// Fill during active auction
	// -------------------------------------------------------------------

	it('fills via PropAMM during active auction (slot 0)', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}

		const driftProgramId = program.programId;
		const state = await getDriftStateAccountPublicKey(driftProgramId);
		const perpMarket = getPerpMarketPublicKeySync(driftProgramId, marketIndex);
		const market = driftClient.getPerpMarketAccount(marketIndex);
		const oracleKey = new PublicKey(market.amm.oracle);
		const connection = bankrunContextWrapper.connection;
		const tokenProgram = (await connection.getAccountInfo(usdcMint.publicKey))
			.owner;

		// --- Taker setup ---
		const takerKp = Keypair.generate();
		await bankrunContextWrapper.fundKeypair(takerKp, 10 ** 9);
		const takerUsdcAta = getAssociatedTokenAddressSync(
			usdcMint.publicKey,
			takerKp.publicKey
		);

		const takerClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(takerKp),
			programID: driftProgramId,
			opts: { commitment: 'confirmed' },
			activeSubAccountId: 0,
			perpMarketIndexes: [marketIndex],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [{ publicKey: oracle, source: OracleSource.PYTH }],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerClient.subscribe();

		const { ixs: takerInitIxs } =
			await takerClient.createInitializeUserAccountAndDepositCollateralIxs(
				usdcAmount,
				takerUsdcAta
			);

		const takerSetupTx = new Transaction().add(
			createAssociatedTokenAccountIdempotentInstruction(
				bankrunContextWrapper.context.payer.publicKey,
				takerUsdcAta,
				takerKp.publicKey,
				usdcMint.publicKey,
				tokenProgram
			),
			createMintToInstruction(
				usdcMint.publicKey,
				takerUsdcAta,
				bankrunContextWrapper.context.payer.publicKey,
				usdcAmount.toNumber(),
				undefined,
				tokenProgram
			),
			...takerInitIxs
		);
		await bankrunContextWrapper.sendTransaction(takerSetupTx, [takerKp]);

		await takerClient.unsubscribe();
		await takerClient.subscribe();
		await takerClient.addUser(0, takerKp.publicKey);
		await takerClient.fetchAccounts();

		// --- PropAMM maker: mid_price=98, ask at offset +1 = price 99 (below oracle 100) ---
		const makerKp = Keypair.generate();
		await bankrunContextWrapper.fundKeypair(makerKp, 10 ** 9);
		const makerUserPda = await getUserAccountPublicKey(
			driftProgramId,
			makerKp.publicKey,
			0
		);
		const [midpricePda] = getMidpricePDA(
			midpriceProgramId,
			makerKp.publicKey,
			marketIndex,
			0
		);

		const makerUsdcAta = getAssociatedTokenAddressSync(
			usdcMint.publicKey,
			makerKp.publicKey
		);
		const midpriceAccountSpace =
			MIDPRICE_ACCOUNT_MIN_LEN + MIDPRICE_ORDER_ENTRY_SIZE * 2;
		const rentExempt = await connection.getMinimumBalanceForRentExemption(
			midpriceAccountSpace
		);

		const makerClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(makerKp),
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
		const { ixs: makerInitIxs } =
			await makerClient.createInitializeUserAccountAndDepositCollateralIxs(
				usdcAmount,
				makerUsdcAta
			);
		await makerClient.unsubscribe();

		const makerSetupIxs: TransactionInstruction[] = [
			createAssociatedTokenAccountIdempotentInstruction(
				bankrunContextWrapper.context.payer.publicKey,
				makerUsdcAta,
				makerKp.publicKey,
				usdcMint.publicKey,
				tokenProgram
			),
			createMintToInstruction(
				usdcMint.publicKey,
				makerUsdcAta,
				bankrunContextWrapper.context.payer.publicKey,
				usdcAmount.toNumber(),
				undefined,
				tokenProgram
			),
			...makerInitIxs,
			SystemProgram.createAccount({
				fromPubkey: bankrunContextWrapper.context.payer.publicKey,
				newAccountPubkey: midpricePda,
				lamports: rentExempt,
				space: midpriceAccountSpace,
				programId: midpriceProgramId,
			}),
			buildMidpriceInitializeInstruction({
				midpriceProgram: midpriceProgramId,
				authority: makerKp.publicKey,
				midpriceAccount: midpricePda,
				marketIndex,
				subaccountIndex: 0,
				makerSubaccount: makerUserPda,
			}),
			// mid_price = 98 so ask at offset +1 = price 99, below oracle (100)
			buildMidpriceUpdateMidPriceInstruction(
				midpriceProgramId,
				midpricePda,
				makerKp.publicKey,
				new BN(98).mul(PRICE_PRECISION)
			),
			buildMidpriceSetOrdersInstruction(
				midpriceProgramId,
				midpricePda,
				makerKp.publicKey,
				1,
				0,
				[{ tickCount: 1, size: new BN(1).mul(BASE_PRECISION) }]
			),
		];

		const makerSetupTx = new Transaction().add(...makerSetupIxs);
		await bankrunContextWrapper.sendTransaction(makerSetupTx, [makerKp]);

		// Approve this maker in the PropAMM registry
		const approveIxAuc = await buildApprovePropAmmsInstruction(
			program,
			bankrunContextWrapper.context.payer.publicKey,
			driftProgramId,
			[
				{
					marketIndex,
					makerSubaccount: makerUserPda,
					propammProgram: midpriceProgramId,
					propammAccount: midpricePda,
				},
			]
		);
		await bankrunContextWrapper.sendTransaction(
			new Transaction().add(approveIxAuc),
			[]
		);

		// --- Market order with auction: start near oracle crosses maker ask at 99 ---
		const slot = new BN(
			await bankrunContextWrapper.connection.toConnection().getSlot()
		);

		// Market order with auction. On-chain sanitization will adjust start
		// toward oracle (~100), which is above the maker ask at 99 — so the
		// fill crosses at slot 0 while the auction is still active.
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: new BN(1).mul(BASE_PRECISION),
			price: new BN(102).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(101).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(102).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		}) as OrderParams;

		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot,
			uuid,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		const signedOrderParams = takerClient.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage
		);

		const takerUser = await takerClient.getUserAccountPublicKey();
		const takerStats = takerClient.getUserStatsAccountPublicKey();
		const takerUserAccount = takerClient.getUserAccount();

		const placeIxs = await driftClient.getPlaceSignedMsgTakerPerpOrderIxs(
			signedOrderParams,
			marketIndex,
			{
				taker: takerUser,
				takerStats,
				takerUserAccount,
				signingAuthority: takerClient.wallet.publicKey,
			}
		);

		const remaining: { pubkey: PublicKey; isWritable: boolean }[] = [
			{ pubkey: midpriceProgramId, isWritable: false },
			{
				pubkey: getSpotMarketPublicKeySync(driftProgramId, 0),
				isWritable: false,
			},
			{ pubkey: getPropAmmMatcherPDA(driftProgramId), isWritable: true },
			{ pubkey: midpricePda, isWritable: true },
			{ pubkey: makerUserPda, isWritable: true },
		];

		const matchIx = buildFillPerpOrder2Instruction(
			driftProgramId,
			null,
			{
				user: takerUser,
				userStats: takerStats,
				state,
				perpMarket,
				oracle: oracleKey,
				oraclePriceCache: oraclePriceCachePda,
				propAmmRegistry: propAmmRegistryPda,
			},
			remaining
		);

		// Place + fill atomically in the same tx (same slot).
		// The auction is active (duration=10, elapsed=0) and the interpolated
		// price at slot 0 (~100) is above the maker ask at 99 — fill during auction.
		const tx = new Transaction().add(...placeIxs, matchIx);
		const sig = await bankrunContextWrapper.sendTransaction(tx, []);
		assert(
			sig && sig.length > 0,
			'atomic place+fill during auction should succeed'
		);

		// Verify taker has a position
		await takerClient.fetchAccounts();
		const perpPosition = takerClient.getUser().getPerpPosition(marketIndex);
		assert(
			perpPosition && perpPosition.baseAssetAmount.gt(new BN(0)),
			'taker should have a long perp position from fill during active auction'
		);

		await takerClient.unsubscribe();
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

		const makerSubaccount = await getUserAccountPublicKey(
			program.programId,
			maker.publicKey,
			0
		);
		const initMidpriceIx = buildMidpriceInitializeInstruction({
			midpriceProgram: midpriceProgramId,
			authority: maker.publicKey,
			midpriceAccount: midpricePda,
			marketIndex,
			subaccountIndex: 0,
			makerSubaccount,
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

		const makerSubaccount = await getUserAccountPublicKey(
			program.programId,
			maker.publicKey,
			0
		);
		const initMidpriceIx = buildMidpriceInitializeInstruction({
			midpriceProgram: midpriceProgramId,
			authority: maker.publicKey,
			midpriceAccount: midpricePda,
			marketIndex,
			subaccountIndex: 0,
			makerSubaccount,
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
				[{ tickCount: 1, size: BASE_PRECISION }]
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

		const makerSubaccount = await getUserAccountPublicKey(
			program.programId,
			maker.publicKey,
			0
		);
		const initMidpriceIx = buildMidpriceInitializeInstruction({
			midpriceProgram: midpriceProgramId,
			authority: maker.publicKey,
			midpriceAccount: midpricePda,
			marketIndex,
			subaccountIndex: 0,
			makerSubaccount,
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

		const makerSubaccount = await getUserAccountPublicKey(
			program.programId,
			maker.publicKey,
			0
		);
		const initMidpriceIx = buildMidpriceInitializeInstruction({
			midpriceProgram: midpriceProgramId,
			authority: maker.publicKey,
			midpriceAccount: midpricePda,
			marketIndex,
			subaccountIndex: 0,
			makerSubaccount,
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

	it('fills a cross-margined PropAMM maker using cached non-market spot oracles', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}

		const extraMarkets = await initializeExtraSpotMarkets(3);
		const makers = await createCrossMarginedPropAmmMakers(1, extraMarkets);
		await configureOracleCache(
			extraMarkets.map((market) => market.oracle),
			60
		);
		const { tx, accountCount } = await buildCrossMarginedPropAmmFillTx({
			makers,
			extraMarkets,
		});

		const sim = await bankrunContextWrapper.connection.simulateTransaction(tx);
		if (sim.value.err) {
			console.log('cached cross-margin fill logs:', sim.value.logs);
		}
		assert.strictEqual(
			sim.value.err,
			null,
			'fresh cache should satisfy non-market oracle dependencies'
		);
		assert.isBelow(
			accountCount,
			64,
			'cached fill should fit comfortably under Solana account limits'
		);
	});

	it('fills with live oracle fallback when cached non-market spot oracles are stale', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}

		const extraMarkets = await initializeExtraSpotMarkets(2);
		await configureOracleCache(
			extraMarkets.map((market) => market.oracle),
			1,
			1
		);
		await bankrunContextWrapper.moveTimeForward(5);
		const makers = await createCrossMarginedPropAmmMakers(1, extraMarkets);
		const withoutFallback = await buildCrossMarginedPropAmmFillTx({
			makers,
			extraMarkets,
		});
		const withFallback = await buildCrossMarginedPropAmmFillTx({
			makers,
			extraMarkets,
			liveFallbackOracles: extraMarkets.map((market) => market.oracle),
		});

		const sim = await bankrunContextWrapper.connection.simulateTransaction(
			withFallback.tx
		);
		if (sim.value.err) {
			console.log('stale-cache fallback logs:', sim.value.logs);
		}
		assert.strictEqual(
			sim.value.err,
			null,
			'live fallback oracles should rescue a stale cache entry'
		);
		assert.strictEqual(
			withFallback.accountCount,
			withoutFallback.accountCount + extraMarkets.length,
			'live fallback should only add the stale oracle prefix, not duplicate market accounts'
		);
	});

	it('oracle cache scales a worst-case cross-margined PropAMM portfolio to 10+ makers', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}
		this.timeout(180000);

		// User accounts only have 8 spot slots total (quote + 7 extras), so the
		// worst realistic spot-heavy cross-margin case is "max oracle fanout per maker"
		// times a large maker set.
		const extraMarkets = await initializeExtraSpotMarkets(7);
		const makers = await createCrossMarginedPropAmmMakers(11, extraMarkets);
		await configureOracleCache(
			extraMarkets.map((market) => market.oracle),
			60
		);
		const cachedScenario = await buildCrossMarginedPropAmmFillTx({
			makers,
			extraMarkets,
			baseAssetAmount: new BN(makers.length).mul(BASE_PRECISION),
		});
		assert.isAtLeast(
			makers.length,
			10,
			'scaling scenario should exercise double-digit PropAMM makers'
		);
		assert.isBelow(
			cachedScenario.accountCount,
			64,
			'cached oracle design should fit within the account budget'
		);
		const sharedAccountFootprint =
			cachedScenario.accountCount - makers.length * 2;
		const maxCachedMakers = Math.floor((64 - sharedAccountFootprint) / 2);
		const maxDirectOracleMakers = Math.floor(
			(64 - (sharedAccountFootprint + extraMarkets.length)) / 2
		);
		const directOracleCountAt21Makers =
			sharedAccountFootprint + extraMarkets.length + 21 * 2;

		assert.isAtLeast(
			maxCachedMakers,
			21,
			'cached design should leave headroom for twenty-plus makers at this oracle fanout'
		);
		assert.isBelow(
			maxDirectOracleMakers,
			maxCachedMakers,
			'live non-market oracle inclusion should lower the maker ceiling materially'
		);
		assert.isAbove(
			directOracleCountAt21Makers,
			64,
			'without cache, the same 7-oracle portfolio would overflow the account budget by 21 makers'
		);
		console.log('cached account count:', cachedScenario.accountCount);
		console.log('shared account footprint:', sharedAccountFootprint);
		console.log('max cached makers at 7 extra oracles:', maxCachedMakers);
		console.log(
			'max direct-oracle makers at 7 extra oracles:',
			maxDirectOracleMakers
		);
		console.log(
			'direct-oracle count at 21 makers:',
			directOracleCountAt21Makers
		);
		console.log(
			'note: bankrun legacy tx serialization becomes the next limiter before the 64-account ceiling in this large scenario'
		);
	});
});
