import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';

import {
	Keypair,
	Transaction,
	PublicKey,
	SystemProgram,
	TransactionInstruction,
	Connection,
	AccountInfo,
} from '@solana/web3.js';

import {
	createAssociatedTokenAccountInstruction,
	createMintToInstruction,
	getAssociatedTokenAddress,
	NATIVE_MINT,
} from '@solana/spl-token';

import {
	BN,
	TestClient,
	EventSubscriber,
	OracleSource,
	OracleInfo,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockOracleNoProgram,
} from './testHelpers';
import {
	castNumberToSpotPrecision,
	getLimitOrderParams,
	getTokenAmount,
	isVariant,
	PositionDirection,
	PRICE_PRECISION,
	SpotBalanceType,
	Wallet,
} from '../sdk';
import { deserializeMarketData, TokenConfig } from '@ellipsis-labs/phoenix-sdk';
import * as Phoenix from '@ellipsis-labs/phoenix-sdk';
import { assert } from 'chai';
import { startAnchor } from "solana-bankrun";
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrunConnection';
import { BankrunProvider } from 'anchor-bankrun';
import { seatAccountData, marketAccountData, baseVaultAccountData, quoteVaultAccountData } from './phoenixTestAccountData';

const PHOENIX_MARKET: AccountInfo<Buffer> = {
	executable: false,
	lamports: 6066670080,
	owner: new PublicKey("PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY"),
	rentEpoch: 0,
	data: Buffer.from(marketAccountData, "base64"),
};

const PHOENIX_SEAT: AccountInfo<Buffer> = {
	executable: false,
	lamports: 1781760,
	owner: new PublicKey("PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY"),
	rentEpoch: 0,
	data: Buffer.from(seatAccountData, "base64")
};

const PHOENIX_BASE_VAULT: AccountInfo<Buffer> = {
	executable: false,
	lamports: 2039280,
	owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
	rentEpoch: 0,
	data: Buffer.from(baseVaultAccountData, "base64")
};

const PHOENIX_QUOTE_VAULT: AccountInfo<Buffer> = {
	executable: false,
	lamports: 2039280,
	owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
	rentEpoch: 0,
	data: Buffer.from(quoteVaultAccountData, "base64")
};

const USDC_MINT: AccountInfo<Buffer> = {
	executable: false,
	lamports: 1461600,
	owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
	rentEpoch: 157,
	data: Buffer.from("AQAAANuZX+JRadFByrm7upK6oB+fLh7OffTLKsBRkPN/zB+dAAAAAAAAAAAGAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==", "base64")
};

// DO NOT USE THIS PRIVATE KEY IN PRODUCTION
// This key is the market authority as well as the market maker
const god = Keypair.fromSeed(
	new Uint8Array([
		65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65,
		65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65,
	])
);

// Hardcoded market address of SOL/USDC Phoenix market
// This market is loaded at genesis
const solMarketAddress = new PublicKey(
	'HhHRvLFvZid6FD7C96H93F2MkASjYfYAx8Y2P8KMAr6b'
);

const usdcMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

const tokenConfig: TokenConfig[] = [
	{
		name: 'USD Coin',
		symbol: 'USDC',
		mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
		logoUri:
			'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
	},
	{
		name: 'Wrapped SOL',
		symbol: 'SOL',
		mint: 'So11111111111111111111111111111111111111112',
		logoUri:
			'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
	},
];

const createPhoenixClient = async (
	connection: Connection
): Promise<Phoenix.Client> => {
	console.log("Creating Phoenix client");
	const client = await Phoenix.Client.createWithoutConfig(connection, []);
	console.log("Phoenix client created");
	client.tokenConfig = tokenConfig;
	console.log("Token config set");
	await client.addMarket(solMarketAddress.toBase58());
	console.log("Market added");
	return client;
};

const createTokenAccountInstructions = async (
	provider: BankrunProvider,
	tokenMintAddress: PublicKey,
	owner?: PublicKey
): Promise<[PublicKey, TransactionInstruction]> => {
	owner = owner || provider.wallet.publicKey;

	const userTokenAccount = await getAssociatedTokenAddress(
		tokenMintAddress,
		owner
	);

	const createAta = createAssociatedTokenAccountInstruction(
		provider.wallet.publicKey,
		userTokenAccount,
		owner,
		tokenMintAddress
	);

	return [userTokenAccount, createAta];
};

const createWSOLAccount = async (
	context: BankrunContextWrapper,
	mintAmount?: BN,
	owner?: PublicKey
): Promise<PublicKey> => {
	const tx = new Transaction();
	const [userWSOLAccount, createAta] = await createTokenAccountInstructions(
		context.provider,
		NATIVE_MINT,
		owner
	);
	if (mintAmount.gtn(0)) {
		const transferIx = SystemProgram.transfer({
			fromPubkey: context.provider.wallet.publicKey,
			toPubkey: userWSOLAccount,
			lamports: mintAmount.toNumber(),
		});
		tx.add(transferIx);
	}
	tx.add(createAta);

	await context.sendTransaction(tx);
	
	return userWSOLAccount;
};

const createTokenAccountAndMintTokens = async (
	context: BankrunContextWrapper,
	tokenMintAddress: PublicKey,
	mintAmount: BN,
	mintAuthority: Keypair,
	owner?: PublicKey
): Promise<PublicKey> => {
	const tx = new Transaction();

	const [userTokenAccount, createAta] = await createTokenAccountInstructions(
		context.provider,
		tokenMintAddress,
		owner
	);

	tx.add(createAta);

	const mintToUserAccountTx = await createMintToInstruction(
		tokenMintAddress,
		userTokenAccount,
		mintAuthority.publicKey,
		mintAmount.toNumber()
	);
	tx.add(mintToUserAccountTx);

	tx.recentBlockhash = (await context.getLatestBlockhash()).toString();
	tx.feePayer = mintAuthority.publicKey;
	tx.sign(context.provider.wallet.payer, mintAuthority);
	await context.connection.sendTransaction(tx);

	return userTokenAccount;
};

describe('phoenix spot market', () => {
	const driftProgram = anchor.workspace.Drift as Program;

	let phoenixClient: Phoenix.Client;

	let takerUsdcTokenAccount: PublicKey;
	let makerUsdcTokenAccount: PublicKey;

	let takerWrappedSolTokenAccount: PublicKey;
	let makerWrappedSolTokenAccount: PublicKey;

	let makerDriftClient: TestClient;
	let takerDriftClient: TestClient;

	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let solOracle: PublicKey;

	// 200 USDC
	const usdcAmount = new BN(200 * 10 ** 6);
	// 2 SOL
	const solAmount = new BN(2 * 10 ** 9);

	let marketIndexes: number[];
	let spotMarketIndexes: number[];
	let oracleInfos: OracleInfo[];

	const solSpotMarketIndex = 1;

	before(async () => {
		const context = await startAnchor("", [
			{
				name: "phoenix_dex",
				programId: new PublicKey("PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY")
			}
		], [
			{
				address: new PublicKey("HhHRvLFvZid6FD7C96H93F2MkASjYfYAx8Y2P8KMAr6b"),
				info: PHOENIX_MARKET
			},
			{
				address: new PublicKey("GDqLPXfwDHXnqwfqtEJmqovA4KEy9XhoZxkg3MVyFK9N"),
				info: PHOENIX_SEAT
			},
			{
				address: new PublicKey("EyZsJZJWXuix6Zgw34JXb2fAbF4d62nfUgp4tzZBPxhW"),
				info: PHOENIX_BASE_VAULT
			},
			{
				address: new PublicKey("B9SETfVeH1vx7sEJ7v41CRJncJnpMpGxHg4Mztc3sZKX"),
				info: PHOENIX_QUOTE_VAULT
			},
			{
				address: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
				info: USDC_MINT
			}
		]);

		bankrunContextWrapper = new BankrunContextWrapper(context);

        bulkAccountLoader = new TestBulkAccountLoader(bankrunContextWrapper.connection, 'processed', 1);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			driftProgram,
		);

		await eventSubscriber.subscribe();

		console.log('Event subscriber created');

		const val = await bankrunContextWrapper.connection.getAccountInfo(solMarketAddress);

		console.log(val);

		deserializeMarketData(val.data);

		console.log("here");

		phoenixClient = await createPhoenixClient(bankrunContextWrapper.connection.toConnection());

		console.log('Phoenix client created');
	
		const phoenixMarket = phoenixClient.markets.get(
			solMarketAddress.toBase58()
		);
		assert(phoenixMarket.data.header.authority.equals(god.publicKey));
		assert(phoenixMarket.data.traders.has(god.publicKey.toBase58()));

		solOracle = await mockOracleNoProgram(bankrunContextWrapper, 100);
		marketIndexes = [];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solOracle, source: OracleSource.PYTH }];

		// Top-up god key's SOL balance
		await bankrunContextWrapper.fundKeypair(god, 10 * 10 ** 9);

		makerDriftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new Wallet(god),
			programID: driftProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			subAccountIds: [],
			oracleInfos,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await makerDriftClient.initialize(usdcMint, true);
		await makerDriftClient.subscribe();
		await makerDriftClient.initializeUserAccount();

		await initializeQuoteSpotMarket(makerDriftClient, usdcMint);
		await initializeSolSpotMarket(makerDriftClient, solOracle);
		await makerDriftClient.updateSpotMarketStepSizeAndTickSize(
			1,
			new BN(100000000),
			new BN(100)
		);
		await makerDriftClient.updateSpotAuctionDuration(0);

		takerUsdcTokenAccount = await createTokenAccountAndMintTokens(
			bankrunContextWrapper,
			usdcMint,
			usdcAmount,
			god
		);
		makerUsdcTokenAccount = await createTokenAccountAndMintTokens(
			bankrunContextWrapper,
			usdcMint,
			usdcAmount,
			god,
			god.publicKey
		);

		takerWrappedSolTokenAccount = await createWSOLAccount(bankrunContextWrapper, solAmount);
		makerWrappedSolTokenAccount = await createWSOLAccount(
			bankrunContextWrapper,
			solAmount,
			god.publicKey
		);

		console.log("Minted tokens for maker and taker's accounts");
		console.log('taker USDC token account', takerUsdcTokenAccount.toString());
		console.log('maker USDC token account', makerUsdcTokenAccount.toString());
		console.log(
			'taker WSOL token account',
			takerWrappedSolTokenAccount.toString()
		);
		console.log(
			'maker WSOL token account',
			makerWrappedSolTokenAccount.toString()
		);

		takerDriftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: driftProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			subAccountIds: [],
			oracleInfos,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerDriftClient.subscribe();
		await takerDriftClient.initializeUserAccount();

		await takerDriftClient.deposit(usdcAmount, 0, takerUsdcTokenAccount);
	});

	after(async () => {
		await takerDriftClient.unsubscribe();
		await makerDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Add Phoenix Market', async () => {
		await makerDriftClient.initializePhoenixFulfillmentConfig(
			solSpotMarketIndex,
			solMarketAddress
		);
	});
	it('Fill bid', async () => {
		const baseAssetAmount = castNumberToSpotPrecision(
			1,
			makerDriftClient.getSpotMarketAccount(solSpotMarketIndex)
		);

		await takerDriftClient.placeSpotOrder(
			getLimitOrderParams({
				marketIndex: solSpotMarketIndex,
				direction: PositionDirection.LONG,
				baseAssetAmount,
				userOrderId: 1,
				price: new BN(100).mul(PRICE_PRECISION),
			})
		);

		await takerDriftClient.fetchAccounts();

		const spotOrder = takerDriftClient.getOrderByUserId(1);

		assert(isVariant(spotOrder.marketType, 'spot'));
		assert(spotOrder.baseAssetAmount.eq(baseAssetAmount));

		const askOrderPacket: Phoenix.OrderPacket = {
			__kind: 'PostOnly',
			side: Phoenix.Side.Ask,
			priceInTicks: Phoenix.toBN(
				phoenixClient.floatPriceToTicks(100.0, solMarketAddress.toString())
			),
			numBaseLots: Phoenix.toBN(
				phoenixClient.rawBaseUnitsToBaseLotsRoundedDown(
					1,
					solMarketAddress.toString()
				)
			),
			clientOrderId: Phoenix.toBN(2),
			rejectPostOnly: false,
			useOnlyDepositedFunds: false,
			lastValidSlot: null,
			lastValidUnixTimestampInSeconds: null,
		};

		const placeAskInstruction = phoenixClient.createPlaceLimitOrderInstruction(
			askOrderPacket,
			solMarketAddress.toString(),
			god.publicKey
		);

		const tx = new Transaction().add(placeAskInstruction);

		tx.recentBlockhash = (await bankrunContextWrapper.getLatestBlockhash()).toString();
		tx.feePayer = god.publicKey;
		tx.sign(god);
		const placeTxId = await bankrunContextWrapper.connection.sendTransaction(tx);

		bankrunContextWrapper.printTxLogs(placeTxId);

		await phoenixClient.refreshAllMarkets();

		const phoenixFulfillmentConfigAccount =
			await makerDriftClient.getPhoenixV1FulfillmentConfig(solMarketAddress);
		const txSig = await makerDriftClient.fillSpotOrder(
			await takerDriftClient.getUserAccountPublicKey(),
			takerDriftClient.getUserAccount(),
			takerDriftClient.getOrderByUserId(1),
			phoenixFulfillmentConfigAccount
		);

		await eventSubscriber.awaitTx(txSig);

		bankrunContextWrapper.printTxLogs(txSig);

		await takerDriftClient.fetchAccounts();

		const takerQuoteSpotBalance = takerDriftClient.getSpotPosition(0);
		const takerBaseSpotBalance = takerDriftClient.getSpotPosition(1);

		const quoteTokenAmount = getTokenAmount(
			takerQuoteSpotBalance.scaledBalance,
			takerDriftClient.getQuoteSpotMarketAccount(),
			takerQuoteSpotBalance.balanceType
		);
		console.log(quoteTokenAmount.toString());
		assert(quoteTokenAmount.eq(new BN(99899999)));

		const baseTokenAmount = getTokenAmount(
			takerBaseSpotBalance.scaledBalance,
			takerDriftClient.getSpotMarketAccount(1),
			takerBaseSpotBalance.balanceType
		);
		assert(baseTokenAmount.eq(new BN(1000000000)));

		const takerOrder = takerDriftClient.getUserAccount().orders[0];
		assert(isVariant(takerOrder.status, 'init'));

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert(isVariant(orderActionRecord.action, 'fill'));
		assert(orderActionRecord.baseAssetAmountFilled.eq(new BN(1000000000)));
		assert(orderActionRecord.quoteAssetAmountFilled.eq(new BN(100000000)));
		assert(orderActionRecord.takerFee.eq(new BN(100000)));

		await makerDriftClient.fetchAccounts();
		assert(makerDriftClient.getQuoteAssetTokenAmount().eq(new BN(11800)));

		const solSpotMarket =
			takerDriftClient.getSpotMarketAccount(solSpotMarketIndex);
		assert(solSpotMarket.totalSpotFee.eq(new BN(68200)));
		const spotFeePoolAmount = getTokenAmount(
			solSpotMarket.spotFeePool.scaledBalance,
			takerDriftClient.getQuoteSpotMarketAccount(),
			SpotBalanceType.DEPOSIT
		);

		// The spot fee pool at this point should be equal to the taker fee - the keeper fee - the spot fulfillment method fee
		console.log('Spot fee pool balance', spotFeePoolAmount.toNumber() / 1e6);
		assert(
			spotFeePoolAmount.eq(
				new BN(
					orderActionRecord.takerFee.sub(makerDriftClient.getQuoteAssetTokenAmount())
					.sub(orderActionRecord.spotFulfillmentMethodFee)
				)
			)
		);

		const phoenixMarketStart = phoenixClient.markets.get(
			solMarketAddress.toString()
		).data;
		await phoenixClient.refreshAllMarkets();
		const phoenixMarketEnd = phoenixClient.markets.get(
			solMarketAddress.toString()
		).data;

		// Verify that there are no orders on the book after the fill
		assert(phoenixMarketStart.asks.length > 0);
		assert(phoenixMarketEnd.asks.length === 0);

		// Verify that the recorded fee from Drift is the same as Phoenix
		assert(
			phoenixClient.quoteLotsToQuoteAtoms(
				phoenixMarketEnd.unclaimedQuoteLotFees -
					phoenixMarketStart.unclaimedQuoteLotFees,
				solMarketAddress.toBase58()
			) === orderActionRecord.spotFulfillmentMethodFee.toNumber()
		);
	});

	it('Fill ask', async () => {
		const solSpotMarketStart =
			takerDriftClient.getSpotMarketAccount(solSpotMarketIndex);
		const spotFeePoolAmountStart = getTokenAmount(
			solSpotMarketStart.spotFeePool.scaledBalance,
			takerDriftClient.getQuoteSpotMarketAccount(),
			SpotBalanceType.DEPOSIT
		);

		const baseAssetAmount = castNumberToSpotPrecision(
			1,
			makerDriftClient.getSpotMarketAccount(solSpotMarketIndex)
		);

		const makerQuoteTokenAmountStart =
			makerDriftClient.getQuoteAssetTokenAmount();

		await takerDriftClient.placeSpotOrder(
			getLimitOrderParams({
				marketIndex: solSpotMarketIndex,
				direction: PositionDirection.SHORT,
				baseAssetAmount,
				userOrderId: 1,
				price: new BN(100).mul(PRICE_PRECISION),
			})
		);
		await takerDriftClient.fetchAccounts();

		const spotOrder = takerDriftClient.getOrderByUserId(1);

		assert(isVariant(spotOrder.marketType, 'spot'));
		assert(spotOrder.baseAssetAmount.eq(baseAssetAmount));

		await phoenixClient.refreshAllMarkets();

		const askOrderPacket: Phoenix.OrderPacket = {
			__kind: 'PostOnly',
			side: Phoenix.Side.Bid,
			priceInTicks: Phoenix.toBN(
				phoenixClient.floatPriceToTicks(100.0, solMarketAddress.toString())
			),
			numBaseLots: Phoenix.toBN(
				phoenixClient.rawBaseUnitsToBaseLotsRoundedDown(
					1,
					solMarketAddress.toString()
				)
			),
			clientOrderId: Phoenix.toBN(2),
			rejectPostOnly: false,
			useOnlyDepositedFunds: false,
			lastValidSlot: null,
			lastValidUnixTimestampInSeconds: null,
		};

		const placeAskInstruction = phoenixClient.createPlaceLimitOrderInstruction(
			askOrderPacket,
			solMarketAddress.toString(),
			god.publicKey
		);	

		const tx = new Transaction().add(placeAskInstruction);

		tx.recentBlockhash = (await bankrunContextWrapper.getLatestBlockhash()).toString();
		tx.feePayer = god.publicKey;
		tx.sign(god);
		const placeTxId = await bankrunContextWrapper.connection.sendTransaction(tx);

		bankrunContextWrapper.printTxLogs(placeTxId);

		await phoenixClient.refreshAllMarkets();

		const phoenixFulfillmentConfigAccount =
			await makerDriftClient.getPhoenixV1FulfillmentConfig(solMarketAddress);
		const txSig = await makerDriftClient.fillSpotOrder(
			await takerDriftClient.getUserAccountPublicKey(),
			takerDriftClient.getUserAccount(),
			takerDriftClient.getOrderByUserId(1),
			phoenixFulfillmentConfigAccount
		);

		await eventSubscriber.awaitTx(txSig);

		bankrunContextWrapper.printTxLogs(txSig);

		await takerDriftClient.fetchAccounts();

		const takerQuoteSpotBalance = takerDriftClient.getSpotPosition(0);
		const takerBaseSpotBalance = takerDriftClient.getSpotPosition(1);

		const quoteTokenAmount = getTokenAmount(
			takerQuoteSpotBalance.scaledBalance,
			takerDriftClient.getQuoteSpotMarketAccount(),
			takerQuoteSpotBalance.balanceType
		);
		console.log(quoteTokenAmount.toString());
		assert(quoteTokenAmount.eq(new BN(199799999)));

		const baseTokenAmount = getTokenAmount(
			takerBaseSpotBalance.scaledBalance,
			takerDriftClient.getSpotMarketAccount(1),
			takerBaseSpotBalance.balanceType
		);
		assert(baseTokenAmount.eq(new BN(0)));

		const takerOrder = takerDriftClient.getUserAccount().orders[0];
		assert(isVariant(takerOrder.status, 'init'));

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert(isVariant(orderActionRecord.action, 'fill'));
		assert(orderActionRecord.baseAssetAmountFilled.eq(new BN(1000000000)));
		assert(orderActionRecord.quoteAssetAmountFilled.eq(new BN(100000000)));
		assert(orderActionRecord.takerFee.eq(new BN(100000)));

		const keeperFee = new BN(
			makerDriftClient.getQuoteAssetTokenAmount().sub(makerQuoteTokenAmountStart)
		);
		assert(keeperFee.eq(new BN(11800)));

		const solSpotMarket =
			takerDriftClient.getSpotMarketAccount(solSpotMarketIndex);
		assert(solSpotMarket.totalSpotFee.eq(new BN(136400)));
		const spotFeePoolAmount = getTokenAmount(
			solSpotMarket.spotFeePool.scaledBalance,
			takerDriftClient.getQuoteSpotMarketAccount(),
			SpotBalanceType.DEPOSIT
		);

		assert(
			spotFeePoolAmount.eq(
				new BN(spotFeePoolAmountStart).add(
					new BN(
						orderActionRecord.takerFee.sub(keeperFee).sub(orderActionRecord.spotFulfillmentMethodFee)
					)
				)
			)
		);

		const phoenixMarketStart = phoenixClient.markets.get(
			solMarketAddress.toString()
		).data;

		await phoenixClient.refreshAllMarkets();
		const phoenixMarketEnd = phoenixClient.markets.get(
			solMarketAddress.toString()
		).data;

		// Verify that there are no orders on the book after the fill
		assert(phoenixMarketStart.bids.length > 0);
		assert(phoenixMarketEnd.bids.length === 0);

		// Verify that the recorded fee from Drift is the same as Phoenix
		assert(
			phoenixClient.quoteLotsToQuoteAtoms(
				phoenixMarketEnd.unclaimedQuoteLotFees -
					phoenixMarketStart.unclaimedQuoteLotFees,
				solMarketAddress.toBase58()
			) === orderActionRecord.spotFulfillmentMethodFee.toNumber()
		);
	});
});
