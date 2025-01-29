import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import {
	ComputeBudgetProgram,
	Keypair,
	Transaction,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';

import {
	BN,
	PRICE_PRECISION,
	TestClient,
	PositionDirection,
	User,
	Wallet,
	EventSubscriber,
	BASE_PRECISION,
	getLimitOrderParams,
	OracleSource,
	BulkAccountLoader,
	SignedMsgOrderParamsMessage,
	loadKeypair,
	getMarketOrderParams,
	MarketType,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	sleep,
} from './testHelpersLocalValidator';
import { PEG_PRECISION, PostOnlyParams } from '../sdk/src';
import dotenv from 'dotenv';
import { nanoid } from 'nanoid';
dotenv.config();

describe('place and make signedMsg order', () => {
	if (!process.env.ANCHOR_WALLET) {
		throw new Error('ANCHOR_WALLET not set');
	}

	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let makerDriftClient: TestClient;
	let makerDriftClientUser: User;
	//@ts-ignore
	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 0);

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	let usdcMint;
	let userUSDCAccount;

	const usdcAmount = new BN(100 * 10 ** 6);

	let solUsd;
	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	before(async () => {
		const makerWallet = new Wallet(loadKeypair(process.env.ANCHOR_WALLET));
		await provider.connection.requestAirdrop(
			provider.wallet.publicKey,
			10 ** 9
		);
		await provider.connection.requestAirdrop(makerWallet.publicKey, 10 ** 9);

		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(32.821);

		marketIndexes = [0];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		const wallet = new Wallet(loadKeypair(process.env.ANCHOR_WALLET));
		makerDriftClient = new TestClient({
			connection,
			//@ts-ignore
			wallet,
			programID: chProgram.programId,
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
			txVersion: 'legacy',
		});
		await makerDriftClient.initialize(usdcMint.publicKey, true);
		await makerDriftClient.subscribe();
		await initializeQuoteSpotMarket(makerDriftClient, usdcMint.publicKey);

		const periodicity = new BN(0);
		await makerDriftClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(32 * PEG_PRECISION.toNumber())
		);

		await makerDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		makerDriftClientUser = new User({
			driftClient: makerDriftClient,
			userAccountPublicKey: await makerDriftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await makerDriftClientUser.subscribe();
	});

	after(async () => {
		await makerDriftClient.unsubscribe();
		await makerDriftClientUser.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('should succeed on correct sig', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		await sleep(1000);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const takerDriftClient = new TestClient({
			connection,
			wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await takerDriftClient.subscribe();
		await takerDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const takerDriftClientUser = new User({
			driftClient: takerDriftClient,
			userAccountPublicKey: await takerDriftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerDriftClientUser.subscribe();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: baseAssetAmount.muln(2),
			price: new BN(34).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(33).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(34).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		});
		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot: new BN(await connection.getSlot()),
			uuid,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		await takerDriftClientUser.fetchAccounts();

		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount: BASE_PRECISION,
			price: new BN(33).mul(PRICE_PRECISION),
			userOrderId: 1,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			immediateOrCancel: true,
		});

		const signedOrderParams = takerDriftClient.signSignedMsgOrderParamsMessage(
			takerOrderParamsMessage
		);

		const ixs = [
			ComputeBudgetProgram.setComputeUnitLimit({
				units: 10_000_000,
			}),
		];
		ixs.push(
			...(await makerDriftClient.getPlaceAndMakeSignedMsgPerpOrderIxs(
				signedOrderParams,
				uuid,
				{
					taker: await takerDriftClient.getUserAccountPublicKey(),
					takerUserAccount: takerDriftClient.getUserAccount(),
					takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
					signingAuthority: takerDriftClient.authority,
				},
				makerOrderParams,
				undefined,
				undefined,
				ixs
			))
		);

		const message = new TransactionMessage({
			instructions: ixs,
			payerKey: makerDriftClient.wallet.payer.publicKey,
			recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
		}).compileToV0Message();
		const tx = new VersionedTransaction(message);
		const simResult = await provider.connection.simulateTransaction(tx);
		console.log(simResult.value.logs);
		assert(simResult.value.err === null);

		const normalTx = new Transaction();
		normalTx.add(...ixs);
		await makerDriftClient.sendTransaction(normalTx);
	});

	it('should fail on bad order params sig', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		await sleep(1000);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const takerDriftClient = new TestClient({
			connection,
			wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await takerDriftClient.subscribe();
		await takerDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const takerDriftClientUser = new User({
			driftClient: takerDriftClient,
			userAccountPublicKey: await takerDriftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerDriftClientUser.subscribe();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: baseAssetAmount.muln(2),
			price: new BN(34).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(33).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(34).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		});
		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot: new BN(await connection.getSlot()),
			uuid,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		await takerDriftClientUser.fetchAccounts();

		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount: BASE_PRECISION,
			price: new BN(33).mul(PRICE_PRECISION),
			userOrderId: 1,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			immediateOrCancel: true,
		});

		const takerOrderParamsMessageEncoded =
			takerDriftClient.encodeSignedMsgOrderParamsMessage(
				takerOrderParamsMessage
			);
		const takerOrderParamsSig = takerDriftClient.signMessage(
			Buffer.from(takerOrderParamsMessageEncoded.toString('hex')),
			makerDriftClient.wallet.payer
		);

		const ixs = [
			ComputeBudgetProgram.setComputeUnitLimit({
				units: 10_000_000,
			}),
		];
		ixs.push(
			...(await makerDriftClient.getPlaceAndMakeSignedMsgPerpOrderIxs(
				{
					orderParams: Buffer.from(
						takerOrderParamsMessageEncoded.toString('hex')
					),
					signature: takerOrderParamsSig,
				},
				uuid,
				{
					taker: await takerDriftClient.getUserAccountPublicKey(),
					takerUserAccount: takerDriftClient.getUserAccount(),
					takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
					signingAuthority: takerDriftClient.authority,
				},
				makerOrderParams,
				undefined,
				undefined,
				ixs
			))
		);

		try {
			const normalTx = new Transaction();
			normalTx.add(...ixs);
			await makerDriftClient.sendTransaction(normalTx);
			assert.fail('should have thrown');
		} catch (error) {
			assert.equal(
				error.transactionMessage,
				'Transaction precompile verification failure InvalidAccountIndex'
			);
		}
	});

	it('should work with delegates', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		await sleep(1000);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const takerDriftClient = new TestClient({
			connection,
			wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await takerDriftClient.subscribe();
		await takerDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const takerDriftClientUser = new User({
			driftClient: takerDriftClient,
			userAccountPublicKey: await takerDriftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerDriftClientUser.subscribe();
		await takerDriftClient.initializeSignedMsgUserOrders(
			takerDriftClientUser.getUserAccount().authority,
			32
		);

		const delegate = Keypair.generate();
		await takerDriftClient.updateUserDelegate(delegate.publicKey);

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: baseAssetAmount.muln(2),
			price: new BN(34).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(33).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(34).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		});
		const uuid = Uint8Array.from(Buffer.from(nanoid(8)));
		const takerOrderParamsMessage: SignedMsgOrderParamsMessage = {
			signedMsgOrderParams: takerOrderParams,
			subAccountId: 0,
			slot: new BN(await connection.getSlot()),
			uuid,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		await takerDriftClientUser.fetchAccounts();

		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount: BASE_PRECISION,
			price: new BN(33).mul(PRICE_PRECISION),
			userOrderId: 1,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			immediateOrCancel: true,
		});

		const takerOrderParamsMessageEncoded =
			takerDriftClient.encodeSignedMsgOrderParamsMessage(
				takerOrderParamsMessage
			);
		const takerOrderParamsSig = takerDriftClient.signMessage(
			Buffer.from(takerOrderParamsMessageEncoded.toString('hex')),
			makerDriftClient.wallet.payer
		);

		const ixs = [
			ComputeBudgetProgram.setComputeUnitLimit({
				units: 10_000_000,
			}),
		];
		ixs.push(
			...(await makerDriftClient.getPlaceAndMakeSignedMsgPerpOrderIxs(
				{
					orderParams: Buffer.from(
						takerOrderParamsMessageEncoded.toString('hex')
					),
					signature: takerOrderParamsSig,
				},
				uuid,
				{
					taker: await takerDriftClient.getUserAccountPublicKey(),
					takerUserAccount: takerDriftClient.getUserAccount(),
					takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
					signingAuthority: delegate.publicKey,
				},
				makerOrderParams,
				undefined,
				undefined,
				ixs
			))
		);

		try {
			const normalTx = new Transaction();
			normalTx.add(...ixs);
			await makerDriftClient.sendTransaction(normalTx);
			assert.fail('should have thrown');
		} catch (error) {
			assert.equal(
				error.transactionMessage,
				'Transaction precompile verification failure InvalidAccountIndex'
			);
		}
	});
});
