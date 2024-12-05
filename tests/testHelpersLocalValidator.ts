import * as anchor from '@coral-xyz/anchor';
import { AnchorProvider, Program, Provider } from '@coral-xyz/anchor';
import {
	AccountLayout,
	MintLayout,
	NATIVE_MINT,
	TOKEN_PROGRAM_ID,
	getMinimumBalanceForRentExemptMint,
	getMinimumBalanceForRentExemptAccount,
	createInitializeMintInstruction,
	createInitializeAccountInstruction,
	createMintToInstruction,
	createWrappedNativeAccount,
} from '@solana/spl-token';
import {
	Connection,
	Keypair,
	PublicKey,
	sendAndConfirmTransaction,
	SystemProgram,
	Transaction,
	TransactionSignature,
} from '@solana/web3.js';
import { assert } from 'chai';
import {
	BN,
	Wallet,
	OraclePriceData,
	OracleInfo,
	BulkAccountLoader,
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

export async function mockOracle(
	price: number = 50 * 10e7,
	expo = -7,
	confidence?: number
): Promise<PublicKey> {
	// default: create a $50 coin oracle
	const program = anchor.workspace.PythPull;
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
	if (feedData.priceMessage.price !== price) {
		console.log(
			'mockOracle precision error:',
			feedData.priceMessage.price,
			'!=',
			price
		);
	}
	assert.ok(Math.abs(feedData.priceMessage.price - price) < 1e-10);
	return priceFeedAddress;
}

export async function mockUSDCMint(provider: Provider): Promise<Keypair> {
	const fakeUSDCMint = anchor.web3.Keypair.generate();
	const createUSDCMintAccountIx = SystemProgram.createAccount({
		fromPubkey: provider.publicKey,
		newAccountPubkey: fakeUSDCMint.publicKey,
		lamports: await getMinimumBalanceForRentExemptMint(provider.connection),
		space: MintLayout.span,
		programId: TOKEN_PROGRAM_ID,
	});
	const initCollateralMintIx = createInitializeMintInstruction(
		fakeUSDCMint.publicKey,
		6,
		// @ts-ignore
		provider.publicKey,
		// @ts-ignore
		provider.publicKey
	);

	const fakeUSDCTx = new Transaction();
	fakeUSDCTx.add(createUSDCMintAccountIx);
	fakeUSDCTx.add(initCollateralMintIx);

	await sendAndConfirmTransaction(
		provider.connection,
		fakeUSDCTx,
		// @ts-ignore
		[provider.wallet.payer, fakeUSDCMint],
		{
			skipPreflight: false,
			commitment: 'recent',
			preflightCommitment: 'recent',
		}
	);
	return fakeUSDCMint;
}

export async function mockUserUSDCAccount(
	fakeUSDCMint: Keypair,
	usdcMintAmount: BN,
	provider: Provider,
	owner?: PublicKey
): Promise<Keypair> {
	const userUSDCAccount = anchor.web3.Keypair.generate();
	const fakeUSDCTx = new Transaction();

	if (owner === undefined) {
		owner = provider.publicKey;
	}

	const createUSDCTokenAccountIx = SystemProgram.createAccount({
		fromPubkey: provider.publicKey,
		newAccountPubkey: userUSDCAccount.publicKey,
		lamports: await getMinimumBalanceForRentExemptAccount(provider.connection),
		space: AccountLayout.span,
		programId: TOKEN_PROGRAM_ID,
	});
	fakeUSDCTx.add(createUSDCTokenAccountIx);
	const initUSDCTokenAccountIx = createInitializeAccountInstruction(
		userUSDCAccount.publicKey,
		fakeUSDCMint.publicKey,
		owner
	);
	fakeUSDCTx.add(initUSDCTokenAccountIx);

	const mintToUserAccountTx = await createMintToInstruction(
		fakeUSDCMint.publicKey,
		userUSDCAccount.publicKey,
		// @ts-ignore
		provider.publicKey,
		usdcMintAmount.toNumber()
	);
	fakeUSDCTx.add(mintToUserAccountTx);

	const _fakeUSDCTxResult = await sendAndConfirmTransaction(
		provider.connection,
		fakeUSDCTx,
		// @ts-ignore
		[provider.wallet.payer, userUSDCAccount],
		{
			skipPreflight: false,
			commitment: 'recent',
			preflightCommitment: 'recent',
		}
	);
	return userUSDCAccount;
}

export async function mintUSDCToUser(
	fakeUSDCMint: Keypair,
	userUSDCAccount: PublicKey,
	usdcMintAmount: BN,
	provider: Provider
): Promise<void> {
	const tx = new Transaction();
	const mintToUserAccountTx = await createMintToInstruction(
		fakeUSDCMint.publicKey,
		userUSDCAccount,
		// @ts-ignore
		provider.publicKey,
		usdcMintAmount.toNumber()
	);
	tx.add(mintToUserAccountTx);

	await sendAndConfirmTransaction(
		provider.connection,
		tx,
		// @ts-ignore
		[provider.wallet.payer],
		{
			skipPreflight: false,
			commitment: 'recent',
			preflightCommitment: 'recent',
		}
	);
}

export async function createFundedKeyPair(
	connection: Connection
): Promise<Keypair> {
	const userKeyPair = new Keypair();
	await connection.requestAirdrop(userKeyPair.publicKey, 10 ** 9);
	return userKeyPair;
}

export async function createUSDCAccountForUser(
	provider: AnchorProvider,
	userKeyPair: Keypair,
	usdcMint: Keypair,
	usdcAmount: BN
): Promise<PublicKey> {
	const userUSDCAccount = await mockUserUSDCAccount(
		usdcMint,
		usdcAmount,
		provider,
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
	accountLoader?: BulkAccountLoader
): Promise<TestClient> {
	const driftClient = new TestClient({
		connection,
		wallet: new Wallet(userKeyPair),
		programID: program.programId,
		opts: {
			commitment: 'confirmed',
		},
		activeSubAccountId: 0,
		perpMarketIndexes: marketIndexes,
		spotMarketIndexes: bankIndexes,
		oracleInfos,
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
	provider: AnchorProvider,
	usdcMint: Keypair,
	chProgram: Program,
	usdcAmount: BN,
	marketIndexes: number[],
	bankIndexes: number[],
	oracleInfos: OracleInfo[] = [],
	accountLoader?: BulkAccountLoader
): Promise<[TestClient, PublicKey, Keypair]> {
	const userKeyPair = await createFundedKeyPair(provider.connection);
	const usdcAccount = await createUSDCAccountForUser(
		provider,
		userKeyPair,
		usdcMint,
		usdcAmount
	);
	const driftClient = await initializeAndSubscribeDriftClient(
		provider.connection,
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
	provider: AnchorProvider,
	userKeypair: Keypair | Wallet,
	amount: BN
): Promise<PublicKey> {
	await provider.connection.requestAirdrop(
		userKeypair.publicKey,
		amount.toNumber() +
			(await getMinimumBalanceForRentExemptAccount(provider.connection))
	);
	return await createWrappedNativeAccount(
		provider.connection,
		// @ts-ignore
		provider.wallet.payer,
		userKeypair.publicKey,
		amount.toNumber()
	);
}

export async function createUserWithUSDCAndWSOLAccount(
	provider: AnchorProvider,
	usdcMint: Keypair,
	chProgram: Program,
	solAmount: BN,
	usdcAmount: BN,
	marketIndexes: number[],
	bankIndexes: number[],
	oracleInfos: OracleInfo[] = [],
	accountLoader?: BulkAccountLoader
): Promise<[TestClient, PublicKey, PublicKey, Keypair]> {
	const userKeyPair = await createFundedKeyPair(provider.connection);
	const solAccount = await createWSolTokenAccountForUser(
		provider,
		userKeyPair,
		solAmount
	);
	const usdcAccount = await createUSDCAccountForUser(
		provider,
		userKeyPair,
		usdcMint,
		usdcAmount
	);
	const driftClient = await initializeAndSubscribeDriftClient(
		provider.connection,
		chProgram,
		userKeyPair,
		marketIndexes,
		bankIndexes,
		oracleInfos,
		accountLoader
	);

	return [driftClient, solAccount, usdcAccount, userKeyPair];
}

export async function printTxLogs(
	connection: Connection,
	txSig: TransactionSignature
): Promise<void> {
	console.log(
		'tx logs',
		(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
			.logMessages
	);
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
		provider.publicKey,
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
	provider: Provider,
	marketIndexes: number[],
	bankIndexes: number[],
	oracleInfos: OracleInfo[],
	accountLoader?: BulkAccountLoader
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
		await provider.connection.requestAirdrop(ownerWallet.publicKey, 100000000);

		const newUserAcct = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			ownerWallet.publicKey
		);

		const chProgram = anchor.workspace.Drift as anchor.Program; // this.program-ify

		const driftClient1 = new TestClient({
			connection: provider.connection,
			//@ts-ignore
			wallet: ownerWallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: bankIndexes,
			oracleInfos,
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
	await oracleProgram.rpc.initialize(
		new BN(initPrice * 10 ** -expo),
		expo,
		conf,
		{
			accounts: { priceUpdate: collateralTokenFeed.publicKey },
			signers: [collateralTokenFeed],
			instructions: [
				anchor.web3.SystemProgram.createAccount({
					fromPubkey: oracleProgram.provider.publicKey,
					newAccountPubkey: collateralTokenFeed.publicKey,
					space: 136,
					lamports:
						await oracleProgram.provider.connection.getMinimumBalanceForRentExemption(
							136
						),
					programId: oracleProgram.programId,
				}),
			],
		}
	);
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
	const data = parsePriceUpdateV2(info.data);
	await oracleProgram.rpc.setPrice(
		new BN(newPrice * 10 ** -data.priceMessage.exponent),
		{
			accounts: { priceUpdate: priceFeed },
		}
	);
};
export const setFeedTwap = async (
	oracleProgram: Program,
	newTwap: number,
	priceFeed: PublicKey
) => {
	const info = await oracleProgram.provider.connection.getAccountInfo(
		priceFeed
	);
	const data = parsePriceUpdateV2(info.data);
	await oracleProgram.rpc.setTwap(
		new BN(newTwap * 10 ** -data.priceMessage.exponent),
		{
			accounts: { priceUpdate: priceFeed },
		}
	);
};
export const getFeedData = async (
	oracleProgram: Program,
	priceFeed: PublicKey
) => {
	const info = await oracleProgram.provider.connection.getAccountInfo(
		priceFeed
	);
	return parsePriceUpdateV2(info.data);
};

export const getOraclePriceData = async (
	oracleProgram: Program,
	priceFeed: PublicKey
): Promise<OraclePriceData> => {
	const info = await oracleProgram.provider.connection.getAccountInfo(
		priceFeed
	);
	const interData = parsePriceUpdateV2(info.data);
	const oraclePriceData: OraclePriceData = {
		price: new BN(interData.priceMessage.price * PRICE_PRECISION.toNumber()),
		slot: new BN(interData.postedSlot.toString()),
		confidence: new BN(
			interData.priceMessage.conf * PRICE_PRECISION.toNumber()
		),
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
const parsePriceUpdateV2 = (data: Buffer) => {
	// Parse fields
	const writeAuthority = new anchor.web3.PublicKey(data.slice(0, 32)); // Public key (32 bytes)

	const verificationLevel = (() => {
		const levelType = data.readUInt8(32); // First byte determines the type
		if (levelType === 0) {
			const numSignatures = data.readUInt8(33);
			return { type: 'Partial', numSignatures };
		} else if (levelType === 1) {
			return { type: 'Full' };
		} else {
			throw new Error('Unknown verification level type');
		}
	})();

	const feedId = data.slice(34, 66); // FeedId (32 bytes)

	const price = readBigInt64LE(data, 66); // i64 (8 bytes)
	const conf = readBigUInt64LE(data, 74); // u64 (8 bytes)
	const exponent = data.readInt32LE(82); // i32 (4 bytes)

	const publishTime = readBigInt64LE(data, 86); // i64 (8 bytes)
	const prevPublishTime = readBigInt64LE(data, 94); // i64 (8 bytes)

	const emaPrice = readBigInt64LE(data, 102); // i64 (8 bytes)
	const emaConf = readBigUInt64LE(data, 110); // u64 (8 bytes)

	const postedSlot = readBigUInt64LE(data, 118); // u64 (8 bytes)

	// Build result object
	return {
		writeAuthority: writeAuthority.toBase58(),
		verificationLevel,
		priceMessage: {
			feedId: feedId.toString('hex'),
			price: Number(price),
			conf: Number(conf),
			exponent,
			publishTime: Number(publishTime),
			prevPublishTime: Number(prevPublishTime),
			emaPrice: Number(emaPrice),
			emaConf: Number(emaConf),
		},
		postedSlot: Number(postedSlot),
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
	await admin.updateWithdrawGuardThreshold(
		marketIndex,
		new BN(10 ** 10).mul(QUOTE_PRECISION)
	);
}
export async function initializeSolSpotMarket(
	admin: TestClient,
	solOracle: PublicKey,
	solMint = NATIVE_MINT
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
		OracleSource.PYTH,
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
