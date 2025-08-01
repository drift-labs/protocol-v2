import * as anchor from '@coral-xyz/anchor';
import { AnchorProvider, Program, Provider } from '@coral-xyz/anchor';
import {
	AccountLayout,
	MintLayout,
	NATIVE_MINT,
	TOKEN_PROGRAM_ID,
	createInitializeMintInstruction,
	createInitializeAccountInstruction,
	createMintToInstruction,
	getAssociatedTokenAddressSync,
	createAssociatedTokenAccountIdempotentInstruction,
	ACCOUNT_SIZE,
	createSyncNativeInstruction,
	createInitializePermanentDelegateInstruction,
	getMintLen,
	ExtensionType,
	unpackAccount,
	RawAccount,
	AccountState,
	unpackMint,
	RawMint,
} from '@solana/spl-token';
import {
	AccountInfo,
	Connection,
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
	sendAndConfirmTransaction,
	SystemProgram,
	Transaction,
	TransactionSignature,
} from '@solana/web3.js';
import { assert } from 'chai';
import buffer from 'buffer';
import {
	BN,
	Wallet,
	OraclePriceData,
	OracleInfo,
	PerpMarketAccount,
	PositionDirection,
	DriftClient,
	OrderType,
} from '../sdk';
import {
	TestClient,
	SPOT_MARKET_RATE_PRECISION,
	SPOT_MARKET_WEIGHT_PRECISION,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	User,
	OracleSource,
} from '../sdk/src';
import {
	BankrunContextWrapper,
	BankrunConnection,
} from '../sdk/src/bankrun/bankrunConnection';
import pythIDL from '../sdk/src/idl/pyth.json';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';

export async function mockOracle(
	price: number = 50 * 10e7,
	expo = -7,
	confidence?: number
): Promise<PublicKey> {
	// default: create a $50 coin oracle
	const program = anchor.workspace.Pyth;

	anchor.setProvider(
		anchor.AnchorProvider.local(undefined, {
			commitment: 'confirmed',
			preflightCommitment: 'confirmed',
		})
	);
	const priceFeedAddress = await createPriceFeed({
		oracleProgram: program,
		initPrice: price,
		expo: expo,
		confidence,
	});

	const feedData = await getFeedData(program, priceFeedAddress);
	if (feedData.price !== price) {
		console.log('mockOracle precision error:', feedData.price, '!=', price);
	}
	assert.ok(Math.abs(feedData.price - price) < 1e-10);

	return priceFeedAddress;
}

export async function mockOracleNoProgram(
	context: BankrunContextWrapper,
	price: number = 50 * 10e7,
	expo = -7,
	confidence?: number
): Promise<PublicKey> {
	const provider = new AnchorProvider(
		context.connection.toConnection(),
		context.provider.wallet,
		{
			commitment: 'processed',
		}
	);

	const program = new Program(
		pythIDL as anchor.Idl,
		new PublicKey('FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH'),
		provider
	);

	const priceFeedAddress = await createPriceFeedBankrun({
		oracleProgram: program,
		context: context,
		initPrice: price,
		expo: expo,
		confidence,
	});

	// @ts-ignore
	const feedData = await getFeedDataNoProgram(
		context.connection,
		priceFeedAddress
	);
	if (feedData.price !== price) {
		console.log('mockOracle precision error:', feedData.price, '!=', price);
	}
	assert.ok(Math.abs(feedData.price - price) < 1e-10);

	return priceFeedAddress;
}

export async function mockUSDCMint(
	context: BankrunContextWrapper,
	tokenProgram = TOKEN_PROGRAM_ID,
	permanentDelegate?: boolean
): Promise<Keypair> {
	const fakeUSDCMint = anchor.web3.Keypair.generate();

	let space = MintLayout.span;
	if (permanentDelegate) {
		space = getMintLen([ExtensionType.PermanentDelegate]);
	}

	const createUSDCMintAccountIx = SystemProgram.createAccount({
		fromPubkey: context.provider.wallet.publicKey,
		newAccountPubkey: fakeUSDCMint.publicKey,
		lamports: 10_000_000_000,
		space: space,
		programId: tokenProgram,
	});

	const initCollateralMintIx = createInitializeMintInstruction(
		fakeUSDCMint.publicKey,
		6,
		// @ts-ignore
		context.provider.wallet.publicKey,
		// @ts-ignore
		context.provider.wallet.publicKey,
		tokenProgram
	);

	const fakeUSDCTx = new Transaction();
	fakeUSDCTx.add(createUSDCMintAccountIx);

	if (permanentDelegate) {
		fakeUSDCTx.add(
			createInitializePermanentDelegateInstruction(
				fakeUSDCMint.publicKey,
				// @ts-ignore
				context.provider.wallet.publicKey,
				tokenProgram
			)
		);
	}

	fakeUSDCTx.add(initCollateralMintIx);

	await context.sendTransaction(fakeUSDCTx, [fakeUSDCMint]);
	return fakeUSDCMint;
}

export async function mockUserUSDCAccount(
	fakeUSDCMint: Keypair,
	usdcMintAmount: BN,
	context: BankrunContextWrapper,
	owner?: PublicKey
): Promise<Keypair> {
	const userUSDCAccount = anchor.web3.Keypair.generate();
	const fakeUSDCTx = new Transaction();

	if (owner === undefined) {
		owner = context.context.payer.publicKey;
	}

	const tokenProgram = (
		await context.connection.getAccountInfo(fakeUSDCMint.publicKey)
	).owner;

	const createUSDCTokenAccountIx = SystemProgram.createAccount({
		fromPubkey: context.context.payer.publicKey,
		newAccountPubkey: userUSDCAccount.publicKey,
		lamports: 100_000_000,
		space: AccountLayout.span,
		programId: tokenProgram,
	});
	fakeUSDCTx.add(createUSDCTokenAccountIx);

	const initUSDCTokenAccountIx = createInitializeAccountInstruction(
		userUSDCAccount.publicKey,
		fakeUSDCMint.publicKey,
		owner,
		tokenProgram
	);
	fakeUSDCTx.add(initUSDCTokenAccountIx);

	const mintToUserAccountTx = createMintToInstruction(
		fakeUSDCMint.publicKey,
		userUSDCAccount.publicKey,
		// @ts-ignore
		context.context.payer.publicKey,
		usdcMintAmount.toNumber(),
		undefined,
		tokenProgram
	);
	fakeUSDCTx.add(mintToUserAccountTx);

	await context.sendTransaction(fakeUSDCTx, [userUSDCAccount]);

	return userUSDCAccount;
}

export async function mockUserUSDCAccountWithAuthority(
	fakeUSDCMint: Keypair,
	usdcMintAmount: BN,
	context: BankrunContextWrapper,
	authority: Keypair
): Promise<PublicKey> {
	const userUSDCAccount = getAssociatedTokenAddressSync(
		fakeUSDCMint.publicKey,
		authority.publicKey
	);
	const fakeUSDCTx = new Transaction();

	const tokenProgram = (
		await context.connection.getAccountInfo(fakeUSDCMint.publicKey)
	).owner;

	const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
		context.context.payer.publicKey,
		userUSDCAccount,
		authority.publicKey,
		fakeUSDCMint.publicKey,
		tokenProgram
	);
	fakeUSDCTx.add(createAtaIx);

	const mintToUserAccountTx = createMintToInstruction(
		fakeUSDCMint.publicKey,
		userUSDCAccount,
		// @ts-ignore
		context.context.payer.publicKey,
		usdcMintAmount.toNumber(),
		undefined,
		tokenProgram
	);
	fakeUSDCTx.add(mintToUserAccountTx);

	await context.sendTransaction(fakeUSDCTx, [fakeUSDCMint]);

	return userUSDCAccount;
}

export async function mockAtaTokenAccountForMint(
	context: BankrunContextWrapper,
	tokenMint: PublicKey,
	amount: BN,
	owner: PublicKey
): Promise<PublicKey> {
	const userTokenAccount = getAssociatedTokenAddressSync(tokenMint, owner);
	const newTx = new Transaction();

	const tokenProgram = (await context.connection.getAccountInfo(tokenMint))
		.owner;

	newTx.add(
		createAssociatedTokenAccountIdempotentInstruction(
			context.context.payer.publicKey,
			userTokenAccount,
			owner,
			tokenMint,
			tokenProgram
		)
	);

	await context.sendTransaction(newTx, [context.context.payer]);

	await overWriteTokenAccountBalance(
		context,
		userTokenAccount,
		BigInt(amount.toString())
	);

	return userTokenAccount;
}

export function getMockUserUsdcAccountInfo(
	fakeUSDCMint: Keypair,
	usdcMintAmount: BN,
	context: BankrunContextWrapper,
	owner?: PublicKey
): [PublicKey, AccountInfo<Buffer>] {
	if (owner === undefined) {
		owner = context.context.payer.publicKey;
	}

	const ata = getAssociatedTokenAddressSync(fakeUSDCMint.publicKey, owner);
	const tokenAccData = Buffer.alloc(ACCOUNT_SIZE);

	AccountLayout.encode(
		{
			mint: fakeUSDCMint.publicKey,
			owner,
			amount: BigInt(usdcMintAmount.toNumber()),
			delegateOption: 0,
			delegate: PublicKey.default,
			delegatedAmount: BigInt(0),
			state: 1,
			isNativeOption: 0,
			isNative: BigInt(0),
			closeAuthorityOption: 0,
			closeAuthority: PublicKey.default,
		},
		tokenAccData
	);

	const accountInfo: AccountInfo<Buffer> = {
		data: tokenAccData,
		executable: false,
		lamports: 100_000_000,
		owner,
		rentEpoch: 0,
	};

	return [ata, accountInfo];
}

export async function mintUSDCToUser(
	fakeUSDCMint: Keypair,
	userUSDCAccount: PublicKey,
	usdcMintAmount: BN,
	context: BankrunContextWrapper
): Promise<void> {
	const tx = new Transaction();
	const tokenProgram = (
		await context.connection.getAccountInfo(fakeUSDCMint.publicKey)
	).owner;

	const mintToUserAccountTx = await createMintToInstruction(
		fakeUSDCMint.publicKey,
		userUSDCAccount,
		// @ts-ignore
		context.provider.wallet.payer.publicKey,
		usdcMintAmount.toNumber(),
		undefined,
		tokenProgram
	);
	tx.add(mintToUserAccountTx);

	await context.sendTransaction(tx);
}

export async function createFundedKeyPair(
	context: BankrunContextWrapper
): Promise<Keypair> {
	const keypair = Keypair.generate();
	await context.fundKeypair(keypair, BigInt(100 * LAMPORTS_PER_SOL));
	return keypair;
}

export async function createUSDCAccountForUser(
	context: BankrunContextWrapper,
	userKeyPair: Keypair,
	usdcMint: Keypair,
	usdcAmount: BN
): Promise<PublicKey> {
	const userUSDCAccount = await mockUserUSDCAccount(
		usdcMint,
		usdcAmount,
		context,
		userKeyPair.publicKey
	);
	return userUSDCAccount.publicKey;
}

export async function initializeAndSubscribeDriftClient(
	connection: Connection,
	program: Program,
	userKeyPair: Keypair,
	marketIndexes: number[],
	bankIndexes: number[],
	oracleInfos: OracleInfo[] = [],
	accountLoader?: TestBulkAccountLoader
): Promise<TestClient> {
	const driftClient = new TestClient({
		connection,
		wallet: new Wallet(userKeyPair),
		programID: program.programId,
		opts: {
			commitment: 'confirmed',
		},
		// activeSubAccountId: 0,
		perpMarketIndexes: marketIndexes,
		spotMarketIndexes: bankIndexes,
		oracleInfos,
		subAccountIds: [],
		userStats: false,
		accountSubscription: accountLoader
			? {
					type: 'polling',
					accountLoader,
			  }
			: {
					type: 'websocket',
			  },
	});
	await driftClient.subscribe();
	await driftClient.initializeUserAccount();
	return driftClient;
}

export async function createUserWithUSDCAccount(
	context: BankrunContextWrapper,
	usdcMint: Keypair,
	chProgram: Program,
	usdcAmount: BN,
	marketIndexes: number[],
	bankIndexes: number[],
	oracleInfos: OracleInfo[] = [],
	accountLoader?: TestBulkAccountLoader
): Promise<[TestClient, PublicKey, Keypair]> {
	const userKeyPair = await createFundedKeyPair(context);
	const usdcAccount = await createUSDCAccountForUser(
		context,
		userKeyPair,
		usdcMint,
		usdcAmount
	);
	const driftClient = await initializeAndSubscribeDriftClient(
		context.connection.toConnection(),
		chProgram,
		userKeyPair,
		marketIndexes,
		bankIndexes,
		oracleInfos,
		accountLoader
	);

	return [driftClient, usdcAccount, userKeyPair];
}

export async function createWSolTokenAccountForUser(
	context: BankrunContextWrapper,
	userKeypair: Keypair | Wallet,
	amount: BN
): Promise<PublicKey> {
	// @ts-ignore
	await context.fundKeypair(userKeypair, amount.toNumber());
	const addr = getAssociatedTokenAddressSync(
		NATIVE_MINT,
		userKeypair.publicKey
	);
	const ix = createAssociatedTokenAccountIdempotentInstruction(
		context.context.payer.publicKey,
		addr,
		userKeypair.publicKey,
		NATIVE_MINT
	);
	const ixs = [
		SystemProgram.transfer({
			fromPubkey: context.context.payer.publicKey,
			toPubkey: addr,
			lamports: amount.toNumber(),
		}),
		createSyncNativeInstruction(addr),
	];
	const tx = new Transaction().add(ix).add(...ixs);
	await context.sendTransaction(tx);
	return addr;
}

export async function fundWsolTokenAccountForUser(
	context: BankrunContextWrapper,
	userKeypair: Keypair | Wallet,
	amount: BN
): Promise<void> {
	// @ts-ignore
	await context.fundKeypair(userKeypair, amount.toNumber() * 5);
	const addr = getAssociatedTokenAddressSync(
		NATIVE_MINT,
		userKeypair.publicKey
	);
	const ixs = [
		SystemProgram.transfer({
			fromPubkey: context.context.payer.publicKey,
			toPubkey: addr,
			lamports: amount.toNumber(),
		}),
		createSyncNativeInstruction(addr),
	];
	const tx = new Transaction().add(...ixs);
	await context.sendTransaction(tx);
}

export async function createUserWithUSDCAndWSOLAccount(
	context: BankrunContextWrapper,
	usdcMint: Keypair,
	chProgram: Program,
	solAmount: BN,
	usdcAmount: BN,
	marketIndexes: number[],
	bankIndexes: number[],
	oracleInfos: OracleInfo[] = [],
	accountLoader?: TestBulkAccountLoader
): Promise<[TestClient, PublicKey, PublicKey, Keypair]> {
	const keypair = Keypair.generate();
	await context.fundKeypair(keypair, BigInt(LAMPORTS_PER_SOL));
	const solAccount = await createWSolTokenAccountForUser(
		context,
		keypair,
		solAmount
	);
	const usdcAccount = await createUSDCAccountForUser(
		context,
		keypair,
		usdcMint,
		usdcAmount
	);
	const driftClient = await initializeAndSubscribeDriftClient(
		context.connection.toConnection(),
		chProgram,
		keypair,
		marketIndexes,
		bankIndexes,
		oracleInfos,
		accountLoader
	);

	return [driftClient, solAccount, usdcAccount, keypair];
}

export async function printTxLogs(
	connection: Connection,
	txSig: TransactionSignature
): Promise<string[]> {
	const tx = await connection.getTransaction(txSig, {
		commitment: 'confirmed',
	});
	console.log('tx logs', tx.meta.logMessages);
	return tx.meta.logMessages;
}

export async function mintToInsuranceFund(
	chInsuranceAccountPubkey: PublicKey,
	fakeUSDCMint: Keypair,
	amount: BN,
	provider: Provider
): Promise<TransactionSignature> {
	const mintToUserAccountTx = await createMintToInstruction(
		fakeUSDCMint.publicKey,
		chInsuranceAccountPubkey,
		// @ts-ignore
		provider.wallet.publicKey,
		amount.toNumber()
	);

	const fakeUSDCTx = new Transaction();
	fakeUSDCTx.add(mintToUserAccountTx);

	return await sendAndConfirmTransaction(
		provider.connection,
		fakeUSDCTx,
		// @ts-ignore
		[provider.wallet.payer],
		{
			skipPreflight: false,
			commitment: 'recent',
			preflightCommitment: 'recent',
		}
	);
}

export async function initUserAccounts(
	NUM_USERS: number,
	usdcMint: Keypair,
	usdcAmount: BN,
	context: BankrunContextWrapper,
	marketIndexes: number[],
	bankIndexes: number[],
	oracleInfos: OracleInfo[],
	accountLoader?: TestBulkAccountLoader
) {
	const user_keys = [];
	const userUSDCAccounts = [];
	const driftClients = [];
	const userAccountInfos = [];

	let userAccountPublicKey: PublicKey;

	for (let i = 0; i < NUM_USERS; i++) {
		console.log('user', i, 'initialize');

		const owner = anchor.web3.Keypair.generate();
		const ownerWallet = new anchor.Wallet(owner);
		await context.fundKeypair(owner, BigInt(100 * LAMPORTS_PER_SOL));

		const newUserAcct = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			context,
			ownerWallet.publicKey
		);

		const chProgram = anchor.workspace.Drift as anchor.Program; // this.program-ify

		const driftClient1 = new TestClient({
			connection: context.connection.toConnection(),
			//@ts-ignore
			wallet: ownerWallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: bankIndexes,
			oracleInfos,
			subAccountIds: [],
			accountSubscription: accountLoader
				? {
						type: 'polling',
						accountLoader,
				  }
				: {
						type: 'websocket',
				  },
		});

		// await driftClient1.initialize(usdcMint.publicKey, false);
		await driftClient1.subscribe();

		userUSDCAccounts.push(newUserAcct);
		driftClients.push(driftClient1);
		// var last_idx = userUSDCAccounts.length - 1;

		// try {
		[, userAccountPublicKey] =
			await driftClient1.initializeUserAccountAndDepositCollateral(
				// marketPublicKey,
				usdcAmount,
				newUserAcct.publicKey
			);

		// const userAccount = 0;
		const userAccount = new User({
			driftClient: driftClient1,
			userAccountPublicKey: await driftClient1.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: accountLoader,
			},
		});
		await userAccount.subscribe();

		userAccountInfos.push(userAccount);

		// } catch (e) {
		// 	assert(true);
		// }

		user_keys.push(userAccountPublicKey);
	}
	return [userUSDCAccounts, user_keys, driftClients, userAccountInfos];
}

const empty32Buffer = buffer.Buffer.alloc(32);
const PKorNull = (data) =>
	data.equals(empty32Buffer) ? null : new anchor.web3.PublicKey(data);
export const createPriceFeed = async ({
	oracleProgram,
	initPrice,
	confidence = undefined,
	expo = -4,
}: {
	oracleProgram: Program;
	initPrice: number;
	confidence?: number;
	expo?: number;
}): Promise<PublicKey> => {
	const conf = new BN(confidence) || new BN((initPrice / 10) * 10 ** -expo);
	const collateralTokenFeed = new anchor.web3.Account();
	const txid = await oracleProgram.rpc.initialize(
		new BN(initPrice * 10 ** -expo),
		expo,
		conf,
		{
			accounts: { price: collateralTokenFeed.publicKey },
			signers: [collateralTokenFeed],
			instructions: [
				anchor.web3.SystemProgram.createAccount({
					// @ts-ignore
					fromPubkey: oracleProgram.provider.wallet.publicKey,
					newAccountPubkey: collateralTokenFeed.publicKey,
					space: 3312,
					lamports:
						await oracleProgram.provider.connection.getMinimumBalanceForRentExemption(
							3312
						),
					programId: oracleProgram.programId,
				}),
			],
		}
	);
	console.log(txid);
	return collateralTokenFeed.publicKey;
};

export const createPriceFeedBankrun = async ({
	oracleProgram,
	context,
	initPrice,
	confidence = undefined,
	expo = -4,
}: {
	oracleProgram: Program;
	context: BankrunContextWrapper;
	initPrice: number;
	confidence?: number;
	expo?: number;
}): Promise<PublicKey> => {
	const conf = new BN(confidence) || new BN((initPrice / 10) * 10 ** -expo);
	const collateralTokenFeed = new anchor.web3.Account();
	const createAccountIx = anchor.web3.SystemProgram.createAccount({
		fromPubkey: context.context.payer.publicKey,
		newAccountPubkey: collateralTokenFeed.publicKey,
		space: 3312,
		lamports: LAMPORTS_PER_SOL / 20, // just hardcode based on mainnet
		programId: oracleProgram.programId,
	});
	const ix = oracleProgram.instruction.initialize(
		new BN(initPrice * 10 ** -expo),
		expo,
		conf,
		{
			accounts: { price: collateralTokenFeed.publicKey },
		}
	);
	const tx = new Transaction().add(createAccountIx).add(ix);
	tx.feePayer = context.context.payer.publicKey;
	tx.recentBlockhash = context.context.lastBlockhash;
	tx.sign(...[collateralTokenFeed, context.context.payer]);
	await context.connection.sendTransaction(tx);
	return collateralTokenFeed.publicKey;
};
export const setFeedPrice = async (
	oracleProgram: Program,
	newPrice: number,
	priceFeed: PublicKey
) => {
	const info = await oracleProgram.provider.connection.getAccountInfo(
		priceFeed
	);
	const data = parsePriceData(info.data);
	await oracleProgram.rpc.setPrice(new BN(newPrice * 10 ** -data.exponent), {
		accounts: { price: priceFeed },
	});
};

export const setFeedPriceNoProgram = async (
	context: BankrunContextWrapper,
	newPrice: number,
	priceFeed: PublicKey
) => {
	const info = await context.connection.getAccountInfo(priceFeed);
	const data = parsePriceData(info.data);

	const provider = new AnchorProvider(
		context.connection.toConnection(),
		context.provider.wallet,
		{
			commitment: 'processed',
		}
	);

	const program = new Program(
		pythIDL as anchor.Idl,
		new PublicKey('FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH'),
		provider
	);

	const ix = program.instruction.setPrice(
		new BN(newPrice * 10 ** -data.exponent),
		{
			accounts: { price: priceFeed },
		}
	);

	const tx = new Transaction().add(ix);
	tx.feePayer = context.context.payer.publicKey;
	tx.recentBlockhash = (await context.getLatestBlockhash()).toString();
	tx.sign(...[context.context.payer]);
	await context.connection.sendTransaction(tx);
};

export const setFeedTwap = async (
	oracleProgram: Program,
	newTwap: number,
	priceFeed: PublicKey
) => {
	const info = await oracleProgram.provider.connection.getAccountInfo(
		priceFeed
	);
	const data = parsePriceData(info.data);
	await oracleProgram.rpc.setTwap(new BN(newTwap * 10 ** -data.exponent), {
		accounts: { price: priceFeed },
	});
};
export const getFeedData = async (
	oracleProgram: Program,
	priceFeed: PublicKey
) => {
	const info = await oracleProgram.provider.connection.getAccountInfo(
		priceFeed
	);
	return parsePriceData(info.data);
};

export const getFeedDataNoProgram = async (
	connection: BankrunConnection,
	priceFeed: PublicKey
) => {
	// @ts-ignore
	const info = await connection.getAccountInfoAndContext(priceFeed);
	return parsePriceData(info.value.data);
};

export const getOraclePriceData = async (
	oracleProgram: Program,
	priceFeed: PublicKey
): Promise<OraclePriceData> => {
	const info = await oracleProgram.provider.connection.getAccountInfo(
		priceFeed
	);
	const interData = parsePriceData(info.data);
	const oraclePriceData: OraclePriceData = {
		price: new BN(interData.price * PRICE_PRECISION.toNumber()),
		slot: new BN(interData.currentSlot.toString()),
		confidence: new BN(interData.confidence * PRICE_PRECISION.toNumber()),
		hasSufficientNumberOfDataPoints: true,
	};

	return oraclePriceData;
};

// https://github.com/nodejs/node/blob/v14.17.0/lib/internal/errors.js#L758
const ERR_BUFFER_OUT_OF_BOUNDS = () =>
	new Error('Attempt to access memory outside buffer bounds');
// https://github.com/nodejs/node/blob/v14.17.0/lib/internal/errors.js#L968
const ERR_INVALID_ARG_TYPE = (name, expected, actual) =>
	new Error(
		`The "${name}" argument must be of type ${expected}. Received ${actual}`
	);
// https://github.com/nodejs/node/blob/v14.17.0/lib/internal/errors.js#L1262
const ERR_OUT_OF_RANGE = (str, range, received) =>
	new Error(
		`The value of "${str} is out of range. It must be ${range}. Received ${received}`
	);
// https://github.com/nodejs/node/blob/v14.17.0/lib/internal/validators.js#L127-L130
function validateNumber(value, name) {
	if (typeof value !== 'number')
		throw ERR_INVALID_ARG_TYPE(name, 'number', value);
}
// https://github.com/nodejs/node/blob/v14.17.0/lib/internal/buffer.js#L68-L80
function boundsError(value, length) {
	if (Math.floor(value) !== value) {
		validateNumber(value, 'offset');
		throw ERR_OUT_OF_RANGE('offset', 'an integer', value);
	}
	if (length < 0) throw ERR_BUFFER_OUT_OF_BOUNDS();
	throw ERR_OUT_OF_RANGE('offset', `>= 0 and <= ${length}`, value);
}
function readBigInt64LE(buffer, offset = 0) {
	validateNumber(offset, 'offset');
	const first = buffer[offset];
	const last = buffer[offset + 7];
	if (first === undefined || last === undefined)
		boundsError(offset, buffer.length - 8);
	const val =
		buffer[offset + 4] +
		buffer[offset + 5] * 2 ** 8 +
		buffer[offset + 6] * 2 ** 16 +
		(last << 24); // Overflow
	return (
		(BigInt(val) << BigInt(32)) +
		BigInt(
			first +
				buffer[++offset] * 2 ** 8 +
				buffer[++offset] * 2 ** 16 +
				buffer[++offset] * 2 ** 24
		)
	);
}
// https://github.com/nodejs/node/blob/v14.17.0/lib/internal/buffer.js#L89-L107
function readBigUInt64LE(buffer, offset = 0) {
	validateNumber(offset, 'offset');
	const first = buffer[offset];
	const last = buffer[offset + 7];
	if (first === undefined || last === undefined)
		boundsError(offset, buffer.length - 8);
	const lo =
		first +
		buffer[++offset] * 2 ** 8 +
		buffer[++offset] * 2 ** 16 +
		buffer[++offset] * 2 ** 24;
	const hi =
		buffer[++offset] +
		buffer[++offset] * 2 ** 8 +
		buffer[++offset] * 2 ** 16 +
		last * 2 ** 24;
	return BigInt(lo) + (BigInt(hi) << BigInt(32)); // tslint:disable-line:no-bitwise
}

const parsePriceData = (data) => {
	// Pyth magic number.
	const magic = data.readUInt32LE(0);
	// Program version.
	const version = data.readUInt32LE(4);
	// Account type.
	const type = data.readUInt32LE(8);
	// Price account size.
	const size = data.readUInt32LE(12);
	// Price or calculation type.
	const priceType = data.readUInt32LE(16);
	// Price exponent.
	const exponent = data.readInt32LE(20);
	// Number of component prices.
	const numComponentPrices = data.readUInt32LE(24);
	// unused
	// const unused = accountInfo.data.readUInt32LE(28)
	// Currently accumulating price slot.
	const currentSlot = readBigUInt64LE(data, 32);
	// Valid on-chain slot of aggregate price.
	const validSlot = readBigUInt64LE(data, 40);
	// Time-weighted average price.
	const twapComponent = readBigInt64LE(data, 48);
	const twap = Number(twapComponent) * 10 ** exponent;
	// Annualized price volatility.
	const avolComponent = readBigUInt64LE(data, 56);
	const avol = Number(avolComponent) * 10 ** exponent;
	// Space for future derived values.
	const drv0Component = readBigInt64LE(data, 64);
	const drv0 = Number(drv0Component) * 10 ** exponent;
	const drv1Component = readBigInt64LE(data, 72);
	const drv1 = Number(drv1Component) * 10 ** exponent;
	const drv2Component = readBigInt64LE(data, 80);
	const drv2 = Number(drv2Component) * 10 ** exponent;
	const drv3Component = readBigInt64LE(data, 88);
	const drv3 = Number(drv3Component) * 10 ** exponent;
	const drv4Component = readBigInt64LE(data, 96);
	const drv4 = Number(drv4Component) * 10 ** exponent;
	const drv5Component = readBigInt64LE(data, 104);
	const drv5 = Number(drv5Component) * 10 ** exponent;
	// Product id / reference account.
	const productAccountKey = new anchor.web3.PublicKey(data.slice(112, 144));
	// Next price account in list.
	const nextPriceAccountKey = PKorNull(data.slice(144, 176));
	// Aggregate price updater.
	const aggregatePriceUpdaterAccountKey = new anchor.web3.PublicKey(
		data.slice(176, 208)
	);
	const aggregatePriceInfo = parsePriceInfo(data.slice(208, 240), exponent);
	// Price components - up to 32.
	const priceComponents = [];
	let offset = 240;
	let shouldContinue = true;
	while (offset < data.length && shouldContinue) {
		const publisher = PKorNull(data.slice(offset, offset + 32));
		offset += 32;
		if (publisher) {
			const aggregate = parsePriceInfo(
				data.slice(offset, offset + 32),
				exponent
			);
			offset += 32;
			const latest = parsePriceInfo(data.slice(offset, offset + 32), exponent);
			offset += 32;
			priceComponents.push({ publisher, aggregate, latest });
		} else {
			shouldContinue = false;
		}
	}
	return Object.assign(
		Object.assign(
			{
				magic,
				version,
				type,
				size,
				priceType,
				exponent,
				numComponentPrices,
				currentSlot,
				validSlot,
				twapComponent,
				twap,
				avolComponent,
				avol,
				drv0Component,
				drv0,
				drv1Component,
				drv1,
				drv2Component,
				drv2,
				drv3Component,
				drv3,
				drv4Component,
				drv4,
				drv5Component,
				drv5,
				productAccountKey,
				nextPriceAccountKey,
				aggregatePriceUpdaterAccountKey,
			},
			aggregatePriceInfo
		),
		{ priceComponents }
	);
};
const _parseProductData = (data) => {
	// Pyth magic number.
	const magic = data.readUInt32LE(0);
	// Program version.
	const version = data.readUInt32LE(4);
	// Account type.
	const type = data.readUInt32LE(8);
	// Price account size.
	const size = data.readUInt32LE(12);
	// First price account in list.
	const priceAccountBytes = data.slice(16, 48);
	const priceAccountKey = new anchor.web3.PublicKey(priceAccountBytes);
	const product = {};
	let idx = 48;
	while (idx < data.length) {
		const keyLength = data[idx];
		idx++;
		if (keyLength) {
			const key = data.slice(idx, idx + keyLength).toString();
			idx += keyLength;
			const valueLength = data[idx];
			idx++;
			const value = data.slice(idx, idx + valueLength).toString();
			idx += valueLength;
			product[key] = value;
		}
	}
	return { magic, version, type, size, priceAccountKey, product };
};

const parsePriceInfo = (data, exponent) => {
	// Aggregate price.
	const priceComponent = data.readBigUInt64LE(0);
	const price = Number(priceComponent) * 10 ** exponent;
	// Aggregate confidence.
	const confidenceComponent = data.readBigUInt64LE(8);
	const confidence = Number(confidenceComponent) * 10 ** exponent;
	// Aggregate status.
	const status = data.readUInt32LE(16);
	// Aggregate corporate action.
	const corporateAction = data.readUInt32LE(20);
	// Aggregate publish slot.
	const publishSlot = data.readBigUInt64LE(24);
	return {
		priceComponent,
		price,
		confidenceComponent,
		confidence,
		status,
		corporateAction,
		publishSlot,
	};
};

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getTokenAmountAsBN(
	connection: Connection,
	tokenAccount: PublicKey
): Promise<BN> {
	return new BN(
		(await connection.getTokenAccountBalance(tokenAccount)).value.amount
	);
}

export async function initializeQuoteSpotMarket(
	admin: TestClient,
	usdcMint: PublicKey
): Promise<void> {
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
	const marketIndex = admin.getStateAccount().numberOfSpotMarkets;

	await admin.initializeSpotMarket(
		usdcMint,
		optimalUtilization,
		optimalRate,
		maxRate,
		PublicKey.default,
		OracleSource.QUOTE_ASSET,
		initialAssetWeight,
		maintenanceAssetWeight,
		initialLiabilityWeight,
		maintenanceLiabilityWeight,
		imfFactor
	);

	// @ts-ignore
	admin.accountSubscriber.spotOracleMap.set(0, PublicKey.default);

	await admin.updateWithdrawGuardThreshold(
		marketIndex,
		new BN(10 ** 10).mul(QUOTE_PRECISION)
	);
}

export async function initializeSolSpotMarket(
	admin: TestClient,
	solOracle: PublicKey,
	solMint = NATIVE_MINT,
	oracleSource: OracleSource = OracleSource.PYTH
): Promise<string> {
	const optimalUtilization = SPOT_MARKET_RATE_PRECISION.div(
		new BN(2)
	).toNumber(); // 50% utilization
	const optimalRate = SPOT_MARKET_RATE_PRECISION.mul(new BN(20)).toNumber(); // 2000% APR
	const maxRate = SPOT_MARKET_RATE_PRECISION.mul(new BN(50)).toNumber(); // 5000% APR
	const initialAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.mul(new BN(8))
		.div(new BN(10))
		.toNumber();
	const maintenanceAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.mul(new BN(9))
		.div(new BN(10))
		.toNumber();
	const initialLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.mul(new BN(12))
		.div(new BN(10))
		.toNumber();
	const maintenanceLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.mul(
		new BN(11)
	)
		.div(new BN(10))
		.toNumber();
	const marketIndex = admin.getStateAccount().numberOfSpotMarkets;

	const txSig = await admin.initializeSpotMarket(
		solMint,
		optimalUtilization,
		optimalRate,
		maxRate,
		solOracle,
		oracleSource,
		initialAssetWeight,
		maintenanceAssetWeight,
		initialLiabilityWeight,
		maintenanceLiabilityWeight
	);
	await admin.updateWithdrawGuardThreshold(
		marketIndex,
		new BN(10 ** 10).mul(QUOTE_PRECISION)
	);
	return txSig;
}

export async function overWritePerpMarket(
	driftClient: TestClient,
	bankrunContextWrapper: BankrunContextWrapper,
	perpMarketKey: PublicKey,
	perpMarket: PerpMarketAccount
) {
	bankrunContextWrapper.context.setAccount(perpMarketKey, {
		executable: false,
		owner: driftClient.program.programId,
		lamports: LAMPORTS_PER_SOL,
		data: await driftClient.program.account.perpMarket.coder.accounts.encode(
			'PerpMarket',
			perpMarket
		),
	});
}

export async function getPerpMarketDecoded(
	driftClient: TestClient,
	bankrunContextWrapper: BankrunContextWrapper,
	perpMarketPublicKey: PublicKey
): Promise<PerpMarketAccount> {
	const accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
		perpMarketPublicKey
	);
	const perpMarketAccount: PerpMarketAccount =
		driftClient.program.coder.accounts.decode('PerpMarket', accountInfo!.data);
	return perpMarketAccount;
}

export async function overWriteTokenAccountBalance(
	bankrunContextWrapper: BankrunContextWrapper,
	tokenAccount: PublicKey,
	newBalance: bigint
) {
	const info = await bankrunContextWrapper.connection.getAccountInfo(
		tokenAccount
	);
	const account = unpackAccount(tokenAccount, info, info.owner);
	account.amount = newBalance;
	const data = Buffer.alloc(AccountLayout.span);
	const rawAccount: RawAccount = {
		mint: account.mint,
		owner: account.owner,
		amount: account.amount,
		delegateOption: account.delegate ? 1 : 0,
		delegate: account.delegate || PublicKey.default,
		state: account.isFrozen ? AccountState.Frozen : AccountState.Initialized,
		isNativeOption: account.isNative ? 1 : 0,
		isNative: account.rentExemptReserve || BigInt(0),
		delegatedAmount: account.delegatedAmount,
		closeAuthorityOption: account.closeAuthority ? 1 : 0,
		closeAuthority: account.closeAuthority || PublicKey.default,
	};
	AccountLayout.encode(rawAccount, data);
	bankrunContextWrapper.context.setAccount(tokenAccount, {
		executable: info.executable,
		owner: info.owner,
		lamports: info.lamports,
		data: data,
		rentEpoch: info.rentEpoch,
	});
}

export async function overWriteMintAccount(
	bankrunContextWrapper: BankrunContextWrapper,
	mintAccount: PublicKey,
	newSupply: bigint
) {
	const info = await bankrunContextWrapper.connection.getAccountInfo(
		mintAccount
	);
	const mint = unpackMint(mintAccount, info, info.owner);
	mint.supply = newSupply;
	const data = Buffer.alloc(MintLayout.span);
	const rawMint: RawMint = {
		mintAuthorityOption: mint.mintAuthority ? 1 : 0,
		mintAuthority: mint.mintAuthority || PublicKey.default,
		supply: mint.supply,
		decimals: mint.decimals,
		isInitialized: mint.isInitialized,
		freezeAuthorityOption: mint.freezeAuthority ? 1 : 0,
		freezeAuthority: mint.freezeAuthority || PublicKey.default,
	};
	MintLayout.encode(rawMint, data);
	bankrunContextWrapper.context.setAccount(mintAccount, {
		executable: info.executable,
		owner: info.owner,
		lamports: info.lamports,
		data: data,
		rentEpoch: info.rentEpoch,
	});
}

export type placeAndFillVammTradeParams = {
	bankrunContextWrapper: BankrunContextWrapper;
	orderClient: TestClient;
	fillerClient: DriftClient;
	marketIndex: number;
	baseAssetAmount: BN;
	auctionStartPrice: BN;
	auctionEndPrice: BN;
	orderPrice: BN;
	auctionDuration: number;
	direction: PositionDirection;
	maxTs: BN;
	dumpTxLogs?: boolean;
};

export async function placeAndFillVammTrade({
	bankrunContextWrapper,
	orderClient,
	fillerClient,
	marketIndex,
	baseAssetAmount,
	auctionStartPrice,
	auctionEndPrice,
	auctionDuration,
	orderPrice = auctionEndPrice,
	direction,
	maxTs,
	dumpTxLogs = true,
}: placeAndFillVammTradeParams): Promise<TransactionSignature> {
	let tx: TransactionSignature | null = null;
	try {
		tx = await orderClient.placePerpOrder({
			orderType: OrderType.LIMIT,
			marketIndex,
			baseAssetAmount,
			direction,
			auctionDuration,
			auctionStartPrice,
			auctionEndPrice,
			price: orderPrice,
			maxTs,
		});
	} catch (e) {
		console.log('place order failed!');
		console.log(e);
	}
	if (dumpTxLogs) {
		await printTxLogs(bankrunContextWrapper.connection.toConnection(), tx);
	}

	await bankrunContextWrapper.moveTimeForward(30);
	await orderClient.fetchAccounts();

	const openOrders = orderClient.getUser(0).getOpenOrders();
	const order = openOrders.length > 0 ? openOrders[0] : null;
	if (!order) {
		throw new Error('No open orders found');
	}

	const orderUser = orderClient.getUser(0);
	const orderUserAcc = await orderClient.getUserAccountPublicKey();

	try {
		tx = await fillerClient.fillPerpOrder(
			orderUserAcc,
			orderUser.getUserAccount(),
			order
		);
		if (dumpTxLogs) {
			await printTxLogs(bankrunContextWrapper.connection.toConnection(), tx);
		}
		return tx;
	} catch (e) {
		console.log('fill failed!');
		console.error(e);
	}
}
