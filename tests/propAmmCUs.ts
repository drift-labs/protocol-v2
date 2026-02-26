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

/** Min size for midprice_pino account (midprice_book_view::ACCOUNT_MIN_LEN) */
const MIDPRICE_ACCOUNT_MIN_LEN = 106;
/** Order entry size (offset i64 + size u64) */
const MIDPRICE_ORDER_ENTRY_SIZE = 16;
/** midprice_pino instructions */
const MIDPRICE_IX_UPDATE_MID_PRICE = 0;
const MIDPRICE_IX_INITIALIZE = 1;
const MIDPRICE_IX_SET_ORDERS = 2;
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
import { getPropAmmMatcherPDA } from '../sdk/src/addresses/pda';
import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	mockUserUSDCAccountWithAuthority,
	sleep,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

const DRIFT_DECIMALS = 6;

function matchPerpOrderViaPropAmmInstructionDiscriminator(): Buffer {
	// Anchor uses snake_case instruction name for discriminator
	const hash = createHash('sha256')
		.update('global:match_perp_order_via_prop_amm')
		.digest();
	return hash.subarray(0, 8);
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

/** Build midprice_pino initialize_mid_price_account ix (opcode 1). Accounts: [midprice_account, authority (signer)].
 * If authorityToStore is set, it is stored as the fill authority (e.g. Drift User PDA) so apply_fills_batch can use that account; otherwise the signer's address is stored.
 */
function buildMidpriceInitializeInstruction(
	midpriceProgramId: PublicKey,
	midpriceAccount: PublicKey,
	authority: PublicKey,
	authorizedExchangeProgramId: PublicKey,
	marketIndex: number,
	authorityToStore?: PublicKey
): TransactionInstruction {
	const payloadLen = 2 + 32 + (authorityToStore ? 32 : 0);
	const data = Buffer.alloc(1 + payloadLen);
	data.writeUInt8(MIDPRICE_IX_INITIALIZE, 0);
	data.writeUInt16LE(marketIndex, 1);
	authorizedExchangeProgramId.toBuffer().copy(data, 3);
	if (authorityToStore) {
		authorityToStore.toBuffer().copy(data, 3 + 32);
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

/** Build midprice_pino update_mid_price ix (opcode 0). Payload: 16 bytes (mid_price u64 LE + 8 padding). Accounts: [midprice_account, authority]. */
function buildMidpriceUpdateMidPriceInstruction(
	midpriceProgramId: PublicKey,
	midpriceAccount: PublicKey,
	authority: PublicKey,
	midPriceU64: BN
): TransactionInstruction {
	const data = Buffer.alloc(1 + 16);
	data.writeUInt8(MIDPRICE_IX_UPDATE_MID_PRICE, 0);
	// First 8 bytes = mid_price (u64 LE), next 8 = 0
	const lo = midPriceU64.and(new BN(0xffffffff)).toNumber();
	const hi = midPriceU64.shrn(32).and(new BN(0xffffffff)).toNumber();
	data.writeUInt32LE(lo, 1);
	data.writeUInt32LE(hi, 5);
	return new TransactionInstruction({
		programId: midpriceProgramId,
		keys: [
			{ pubkey: midpriceAccount, isSigner: false, isWritable: true },
			{ pubkey: authority, isSigner: true, isWritable: false },
		],
		data,
	});
}

/** Build midprice_pino set_orders ix (opcode 2). Payload: [ask_len:u16, bid_len:u16, ...(offset:i64, size:u64)]. Accounts: [midprice_account, authority]. */
function buildMidpriceSetOrdersInstruction(
	midpriceProgramId: PublicKey,
	midpriceAccount: PublicKey,
	authority: PublicKey,
	askLen: number,
	bidLen: number,
	entries: { offset: BN; size: BN }[]
): TransactionInstruction {
	const payloadLen = 4 + entries.length * MIDPRICE_ORDER_ENTRY_SIZE;
	const data = Buffer.alloc(1 + payloadLen);
	data.writeUInt8(MIDPRICE_IX_SET_ORDERS, 0);
	data.writeUInt16LE(askLen, 1);
	data.writeUInt16LE(bidLen, 3);
	let off = 4;
	for (const e of entries) {
		// offset i64 LE, size u64 LE
		data.writeBigInt64LE(BigInt(e.offset.toString()), off);
		off += 8;
		data.writeBigUInt64LE(BigInt(e.size.toString()), off);
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

function writeU64LE(buf: Buffer, offset: number, n: BN): void {
	const lo = n.and(new BN(0xffffffff)).toNumber();
	const hi = n.shrn(32).and(new BN(0xffffffff)).toNumber();
	buf.writeUInt32LE(lo, offset);
	buf.writeUInt32LE(hi, offset + 4);
}

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const MIDPRICE_PINO_SO = path.join(FIXTURES_DIR, 'midprice_pino.so');
const MIDPRICE_PINO_KEYPAIR = path.join(FIXTURES_DIR, 'midprice_pino-keypair.json');

function loadMidpricePinoProgramId(): PublicKey | null {
	try {
		if (!fs.existsSync(MIDPRICE_PINO_SO) || !fs.existsSync(MIDPRICE_PINO_KEYPAIR)) {
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
		bankrunContextWrapper = new BankrunContextWrapper(context);
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

		// Place a limit order so we have a taker order to match
		const orderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: new BN(5).mul(BASE_PRECISION),
			price: new BN(101).mul(PRICE_PRECISION),
			reduceOnly: false,
		});
		await driftClient.placePerpOrder(orderParams);
		await driftClient.fetchAccounts();
		await sleep(500);
	});

	after(async () => {
		await driftClient.unsubscribe();
	});

	async function buildAndSignMatchTx(numPropAmms: number): Promise<{
		tx: Transaction;
		signers: Keypair[];
	}> {
		const driftProgramId = program.programId;
		const takerUser = await driftClient.getUserAccountPublicKey();
		const takerStats = driftClient.getUserStatsAccountPublicKey();
		const state = await getDriftStateAccountPublicKey(driftProgramId);
		const perpMarket = getPerpMarketPublicKeySync(driftProgramId, marketIndex);
		const market = driftClient.getPerpMarketAccount(marketIndex);
		const oracleKey = new PublicKey(market.amm.oracle);

		// Create N maker users (Drift user + user_stats)
		const makerKeypairs: Keypair[] = [];
		const makerUserPDAs: PublicKey[] = [];
		const makerStatsPDAs: PublicKey[] = [];
		const midpriceKeypairs: Keypair[] = [];
		for (let i = 0; i < numPropAmms; i++) {
			const kp = Keypair.generate();
			await bankrunContextWrapper.fundKeypair(kp, 10 ** 9);
			makerKeypairs.push(kp);
			makerUserPDAs.push(
				await getUserAccountPublicKey(driftProgramId, kp.publicKey, 0)
			);
			makerStatsPDAs.push(
				getUserStatsAccountPublicKey(driftProgramId, kp.publicKey)
			);
			midpriceKeypairs.push(Keypair.generate());
		}

		// Initialize maker Drift users so accounts exist
		for (let i = 0; i < numPropAmms; i++) {
			const makerUsdcAccount = await mockUserUSDCAccountWithAuthority(
				usdcMint,
				usdcAmount,
				bankrunContextWrapper,
				makerKeypairs[i]
			);
			const makerClient = new TestClient({
				connection: bankrunContextWrapper.connection.toConnection(),
				wallet: new anchor.Wallet(makerKeypairs[i]),
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
			await makerClient.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				makerUsdcAccount
			);
			await makerClient.unsubscribe();
		}

		// Remaining: [midprice_program], [spot_markets...], one global PropAMM matcher, then per AMM: midprice, maker_user, maker_user_stats
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
				pubkey: midpriceKeypairs[i].publicKey,
				isWritable: true,
			});
			remaining.push({ pubkey: makerUserPDAs[i], isWritable: true });
			remaining.push({ pubkey: makerStatsPDAs[i], isWritable: true });
		}

		const orderId = 1;
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

		const tx = new Transaction();
		const wallet = bankrunContextWrapper.provider.wallet.publicKey;
		const connection = bankrunContextWrapper.connection;

		// When midprice_pino is loaded: create and initialize midprice accounts, set mid_price and add liquidity so the taker order can match
		// Use extra space so set_orders validate_bounds (ORDERS_DATA_OFFSET + total_orders*16 <= data.len()) passes in-program
		const midpriceAccountSpace =
			MIDPRICE_ACCOUNT_MIN_LEN + MIDPRICE_ORDER_ENTRY_SIZE * 2; // space for 2 orders (128 bytes)
		if (midpriceProgramId) {
			const rentExempt =
				await connection.getMinimumBalanceForRentExemption(
					midpriceAccountSpace
				);
			for (let i = 0; i < numPropAmms; i++) {
				tx.add(
					SystemProgram.createAccount({
						fromPubkey: wallet,
						newAccountPubkey: midpriceKeypairs[i].publicKey,
						lamports: rentExempt,
						space: midpriceAccountSpace,
						programId: midpriceProgramId,
					})
				);
				tx.add(
					buildMidpriceInitializeInstruction(
						midpriceProgramId,
						midpriceKeypairs[i].publicKey,
						makerKeypairs[i].publicKey,
						driftProgramId,
						marketIndex,
						makerUserPDAs[i] // store User PDA as authority so Drift can pass maker_user in CPI
					)
				);
				// Set mid_price = 100 so an ask at offset PRICE_PRECISION has price 101 (crosses taker buy @ 101)
				tx.add(
					buildMidpriceUpdateMidPriceInstruction(
						midpriceProgramId,
						midpriceKeypairs[i].publicKey,
						makerKeypairs[i].publicKey,
						new BN(100).mul(PRICE_PRECISION)
					)
				);
				// One ask: offset PRICE_PRECISION => price 101 (crosses). Size = 1 base so taker margin passes
				const setOrdersData = Buffer.alloc(1 + 4 + 16);
				setOrdersData.writeUInt8(MIDPRICE_IX_SET_ORDERS, 0);
				setOrdersData.writeUInt16LE(1, 1); // ask_len
				setOrdersData.writeUInt16LE(0, 3); // bid_len
				setOrdersData.writeBigInt64LE(BigInt(PRICE_PRECISION.toString()), 5);
				setOrdersData.writeBigUInt64LE(BigInt(new BN(1).mul(BASE_PRECISION).toString()), 13); // 1 base
				tx.add(
					new TransactionInstruction({
						programId: midpriceProgramId,
						keys: [
							{
								pubkey: midpriceKeypairs[i].publicKey,
								isSigner: false,
								isWritable: true,
							},
							{
								pubkey: makerKeypairs[i].publicKey,
								isSigner: true,
								isWritable: false,
							},
						],
						data: setOrdersData,
					})
				);
			}
		}
		tx.add(matchIx);

		const { blockhash } =
			await connection.getLatestBlockhash('confirmed');
		tx.recentBlockhash = blockhash;
		tx.feePayer = wallet;
		// Signer order must match first appearance in the message: fee payer, then per AMM (createAccount newAccount + initialize authority)
		const signers: Keypair[] = [bankrunContextWrapper.provider.wallet.payer];
		if (midpriceProgramId) {
			for (let i = 0; i < numPropAmms; i++) {
				signers.push(midpriceKeypairs[i], makerKeypairs[i]);
			}
		}
		tx.sign(...signers);
		return { tx, signers };
	}

	async function measurePropAmmMatchCU(numPropAmms: number): Promise<number> {
		const { tx } = await buildAndSignMatchTx(numPropAmms);
		const sim = await bankrunContextWrapper.connection.simulateTransaction(
			tx
		);
		const cu = Number(sim.value.unitsConsumed ?? 0);
		return cu;
	}

	it('measures CU for 1 PropAMM fill', async () => {
		const cu = await measurePropAmmMatchCU(1);
		console.log('PropAMM match CU (1 AMM):', cu);
		assert(cu > 0, 'should consume compute units');
	});

	it('fills taker order when midprice has crossing liquidity (1 PropAMM)', async function () {
		if (!midpriceProgramId) {
			this.skip();
		}
		const { tx, signers } = await buildAndSignMatchTx(1);
		await bankrunContextWrapper.sendTransaction(tx, signers);
		await driftClient.fetchAccounts();
		const order = driftClient.getOrder(1);
		assert(order, 'taker order 1 should exist');
		assert(
			order.quoteAssetAmountFilled.gt(new BN(0)),
			'taker order should have been filled (quoteAssetAmountFilled > 0)'
		);
	});

	// it('measures CU for 2 PropAMM fills', async () => {
	// 	const cu = await measurePropAmmMatchCU(2);
	// 	console.log('PropAMM match CU (2 AMMs):', cu);
	// 	assert(cu > 0, 'should consume compute units');
	// });

	// it('measures CU for 4 PropAMM fills', async () => {
	// 	const cu = await measurePropAmmMatchCU(4);
	// 	console.log('PropAMM match CU (4 AMMs):', cu);
	// 	assert(cu > 0, 'should consume compute units');
	// });
});
