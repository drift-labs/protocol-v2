import * as anchor from '@coral-xyz/anchor';
import { AnchorProvider } from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';

import {
	Keypair,
	Transaction,
	PublicKey,
	SystemProgram,
	sendAndConfirmTransaction,
	TransactionInstruction,
	Connection,
} from '@solana/web3.js';

import {
	ASSOCIATED_TOKEN_PROGRAM_ID,
	NATIVE_MINT,
	Token,
	TOKEN_PROGRAM_ID,
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
	mockOracle,
	printTxLogs,
} from './testHelpers';
import {
	BulkAccountLoader,
	castNumberToSpotPrecision,
	getLimitOrderParams,
	getTokenAmount,
	isVariant,
	PositionDirection,
	PRICE_PRECISION,
	SpotBalanceType,
	Wallet,
} from '../sdk';
import { TokenConfig } from '@ellipsis-labs/phoenix-sdk';
import * as Phoenix from '@ellipsis-labs/phoenix-sdk';
import { assert } from 'chai';

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
	const client = await Phoenix.Client.createWithoutConfig(connection, []);
	client.tokenConfig = tokenConfig;
	await client.addMarket(solMarketAddress.toBase58());
	return client;
};

const createTokenAccountInstructions = async (
	provider: AnchorProvider,
	tokenMintAddress: PublicKey,
	owner?: PublicKey
): Promise<[PublicKey, TransactionInstruction]> => {
	owner = owner || provider.wallet.publicKey;

	const userTokenAccount = await Token.getAssociatedTokenAddress(
		ASSOCIATED_TOKEN_PROGRAM_ID,
		TOKEN_PROGRAM_ID,
		tokenMintAddress,
		owner
	);

	const createAta = Token.createAssociatedTokenAccountInstruction(
		ASSOCIATED_TOKEN_PROGRAM_ID,
		TOKEN_PROGRAM_ID,
		tokenMintAddress,
		userTokenAccount,
		owner,
		provider.wallet.publicKey
	);

	return [userTokenAccount, createAta];
};

const createWSOLAccount = async (
	provider: AnchorProvider,
	mintAmount?: BN,
	owner?: PublicKey
): Promise<PublicKey> => {
	const tx = new Transaction();
	const [userWSOLAccount, createAta] = await createTokenAccountInstructions(
		provider,
		NATIVE_MINT,
		owner
	);
	if (mintAmount > 0) {
		const transferIx = SystemProgram.transfer({
			fromPubkey: provider.wallet.publicKey,
			toPubkey: userWSOLAccount,
			lamports: mintAmount.toNumber(),
		});
		tx.add(transferIx);
	}
	tx.add(createAta);
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
	return userWSOLAccount;
};

const createTokenAccountAndMintTokens = async (
	provider: AnchorProvider,
	tokenMintAddress: PublicKey,
	mintAmount: BN,
	mintAuthority: Keypair,
	owner?: PublicKey
): Promise<PublicKey> => {
	const tx = new Transaction();

	const [userTokenAccount, createAta] = await createTokenAccountInstructions(
		provider,
		tokenMintAddress,
		owner
	);

	tx.add(createAta);

	const mintToUserAccountTx = await Token.createMintToInstruction(
		TOKEN_PROGRAM_ID,
		tokenMintAddress,
		userTokenAccount,
		mintAuthority.publicKey,
		[],
		mintAmount.toNumber()
	);
	tx.add(mintToUserAccountTx);

	await sendAndConfirmTransaction(
		provider.connection,
		tx,
		// @ts-ignore
		[provider.wallet.payer, mintAuthority],
		{
			skipPreflight: false,
			commitment: 'recent',
			preflightCommitment: 'recent',
		}
	);

	return userTokenAccount;
};

describe('phoenix spot market', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		skipPreflight: false,
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const driftProgram = anchor.workspace.Drift as Program;

	let phoenixClient: Phoenix.Client;

	let takerUsdcTokenAccount: PublicKey;
	let makerUsdcTokenAccount: PublicKey;

	let takerWrappedSolTokenAccount: PublicKey;
	let makerWrappedSolTokenAccount: PublicKey;

	let makerDriftClient: TestClient;
	let takerDriftClient: TestClient;

	const eventSubscriber = new EventSubscriber(connection, driftProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

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
		phoenixClient = await createPhoenixClient(connection);
		const phoenixMarket = phoenixClient.markets.get(
			solMarketAddress.toBase58()
		);
		assert(phoenixMarket.data.header.authority.equals(god.publicKey));
		assert(phoenixMarket.data.traders.has(god.publicKey.toBase58()));

		solOracle = await mockOracle(30);
		marketIndexes = [];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solOracle, source: OracleSource.PYTH }];

		// Top-up god key's SOL balance
		await sendAndConfirmTransaction(
			connection,
			new Transaction().add(
				SystemProgram.transfer({
					fromPubkey: provider.wallet.publicKey,
					toPubkey: god.publicKey,
					lamports: 10000000000000,
				})
			),
			// @ts-ignore
			[provider.wallet.payer],
			{ commitment: 'confirmed' }
		);

		makerDriftClient = new TestClient({
			connection,
			wallet: new Wallet(god),
			programID: driftProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
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
			provider,
			usdcMint,
			usdcAmount,
			god
		);
		makerUsdcTokenAccount = await createTokenAccountAndMintTokens(
			provider,
			usdcMint,
			usdcAmount,
			god,
			god.publicKey
		);

		takerWrappedSolTokenAccount = await createWSOLAccount(provider, solAmount);
		makerWrappedSolTokenAccount = await createWSOLAccount(
			provider,
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
			connection,
			wallet: provider.wallet,
			programID: driftProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
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

		const placeTxId = await sendAndConfirmTransaction(
			connection,
			new Transaction().add(placeAskInstruction),
			[god],
			{ skipPreflight: true, commitment: 'confirmed' }
		);

		await printTxLogs(connection, placeTxId);

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

		await printTxLogs(connection, txSig);

		await takerDriftClient.fetchAccounts();

		const takerQuoteSpotBalance = takerDriftClient.getSpotPosition(0);
		const takerBaseSpotBalance = takerDriftClient.getSpotPosition(1);

		const quoteTokenAmount = getTokenAmount(
			takerQuoteSpotBalance.scaledBalance,
			takerDriftClient.getQuoteSpotMarketAccount(),
			takerQuoteSpotBalance.balanceType
		);
		console.log(quoteTokenAmount.toString());
		assert(quoteTokenAmount.eq(new BN(99900000)));

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
					orderActionRecord.takerFee -
						makerDriftClient.getQuoteAssetTokenAmount() -
						orderActionRecord.spotFulfillmentMethodFee
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

		const placeTxId = await sendAndConfirmTransaction(
			connection,
			new Transaction().add(placeAskInstruction),
			[god],
			{ skipPreflight: true, commitment: 'confirmed' }
		);
		await printTxLogs(connection, placeTxId);

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

		await printTxLogs(connection, txSig);

		await takerDriftClient.fetchAccounts();

		const takerQuoteSpotBalance = takerDriftClient.getSpotPosition(0);
		const takerBaseSpotBalance = takerDriftClient.getSpotPosition(1);

		const quoteTokenAmount = getTokenAmount(
			takerQuoteSpotBalance.scaledBalance,
			takerDriftClient.getQuoteSpotMarketAccount(),
			takerQuoteSpotBalance.balanceType
		);
		console.log(quoteTokenAmount.toString());
		assert(quoteTokenAmount.eq(new BN(199800000)));

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
			makerDriftClient.getQuoteAssetTokenAmount() - makerQuoteTokenAmountStart
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
						orderActionRecord.takerFee -
							keeperFee -
							orderActionRecord.spotFulfillmentMethodFee
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
