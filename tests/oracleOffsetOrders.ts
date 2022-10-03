import * as anchor from '@project-serum/anchor';

import { Program } from '@project-serum/anchor';

import { Keypair } from '@solana/web3.js';

import { assert } from 'chai';

import {
	AdminClient,
	BN,
	PRICE_PRECISION,
	DriftClient,
	PositionDirection,
	DriftUser,
	Wallet,
	getLimitOrderParams,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	initializeQuoteSpotMarket,
} from './testHelpers';
import {
	AMM_RESERVE_PRECISION,
	calculateEntryPrice,
	OracleSource,
	ZERO,
} from '../sdk';

describe('oracle offset', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const driftProgram = anchor.workspace.Drift as Program;

	let fillerDriftClient: AdminClient;
	let fillerDriftUser: DriftUser;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(100000);
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 9).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 9).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	const marketIndex = 0;
	let solUsd;

	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(1);
		marketIndexes = [0];
		spotMarketIndexes = [0];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		fillerDriftClient = new AdminClient({
			connection,
			wallet: provider.wallet,
			programID: driftProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await fillerDriftClient.initialize(usdcMint.publicKey, true);
		await fillerDriftClient.subscribe();
		await initializeQuoteSpotMarket(fillerDriftClient, usdcMint.publicKey);
		await fillerDriftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await fillerDriftClient.initializeMarket(
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await fillerDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		fillerDriftUser = new DriftUser({
			driftClient: fillerDriftClient,
			userAccountPublicKey: await fillerDriftClient.getUserAccountPublicKey(),
		});
		await fillerDriftUser.subscribe();
	});

	beforeEach(async () => {
		await fillerDriftClient.moveAmmPrice(
			0,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve
		);
		await setFeedPrice(anchor.workspace.Pyth, 1, solUsd);
	});

	after(async () => {
		await fillerDriftClient.unsubscribe();
		await fillerDriftUser.unsubscribe();
	});

	it('long taker', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const driftClient = new DriftClient({
			connection,
			wallet,
			programID: driftProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await driftClient.subscribe();
		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const driftUser = new DriftUser({
			driftClient: driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
		});
		await driftUser.subscribe();

		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = ZERO;
		const reduceOnly = false;
		const priceOffset = PRICE_PRECISION.div(new BN(20)).neg();

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			reduceOnly,
			userOrderId: 1,
			oraclePriceOffset: priceOffset,
		});
		await driftClient.placeOrder(orderParams);

		await fillerDriftClient.moveAmmPrice(
			marketIndex,
			ammInitialBaseAssetReserve.mul(new BN(11)).div(new BN(10)),
			ammInitialQuoteAssetReserve
		);

		await driftUser.fetchAccounts();
		const order = driftUser.getOrderByUserOrderId(1);

		await fillerDriftClient.fillOrder(
			await driftUser.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			order
		);

		await driftUser.fetchAccounts();
		const position = driftUser.getUserPosition(marketIndex);
		const entryPrice = calculateEntryPrice(position);
		assert(entryPrice.eq(new BN(909093)));

		await driftClient.unsubscribe();
		await driftUser.unsubscribe();
	});

	it('long maker', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const driftClient = new DriftClient({
			connection,
			wallet,
			programID: driftProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await driftClient.subscribe();
		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const driftUser = new DriftUser({
			driftClient: driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
		});
		await driftUser.subscribe();

		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const reduceOnly = false;
		const priceOffset = PRICE_PRECISION.div(new BN(20)).neg();

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			reduceOnly,
			userOrderId: 1,
			postOnly: true,
			oraclePriceOffset: priceOffset,
		});

		await driftClient.placeOrder(orderParams);

		await fillerDriftClient.moveAmmPrice(
			marketIndex,
			ammInitialBaseAssetReserve.mul(new BN(11)).div(new BN(10)),
			ammInitialQuoteAssetReserve
		);

		await driftUser.fetchAccounts();
		const order = driftUser.getOrderByUserOrderId(1);

		await fillerDriftClient.fillOrder(
			await driftUser.getUserAccountPublicKey(),
			driftUser.getUserAccount(),
			order
		);

		await driftUser.fetchAccounts();
		const position = driftUser.getUserPosition(marketIndex);
		const entryPrice = calculateEntryPrice(position);
		const expectedEntryPrice = new BN(950001);
		assert(entryPrice.eq(expectedEntryPrice));

		await driftClient.unsubscribe();
		await driftUser.unsubscribe();
	});

	it('short taker', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const driftClient = new DriftClient({
			connection,
			wallet,
			programID: driftProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await driftClient.subscribe();
		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const driftUser = new DriftUser({
			driftClient: driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
		});
		await driftUser.subscribe();

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const reduceOnly = false;
		const priceOffset = PRICE_PRECISION.div(new BN(20));

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			reduceOnly,
			userOrderId: 1,
			oraclePriceOffset: priceOffset,
		});
		await driftClient.placeOrder(orderParams);

		await fillerDriftClient.moveAmmPrice(
			marketIndex,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve.mul(new BN(11)).div(new BN(10))
		);

		await driftUser.fetchAccounts();
		const order = driftUser.getOrderByUserOrderId(1);

		await fillerDriftClient.fillOrder(
			await driftUser.getUserAccountPublicKey(),
			driftUser.getUserAccount(),
			order
		);

		await driftUser.fetchAccounts();
		const position = driftUser.getUserPosition(marketIndex);
		const entryPrice = calculateEntryPrice(position);
		assert(entryPrice.eq(new BN(1099997)));

		await driftClient.unsubscribe();
		await driftUser.unsubscribe();
	});

	it('short maker', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const driftClient = new DriftClient({
			connection,
			wallet,
			programID: driftProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await driftClient.subscribe();
		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const driftUser = new DriftUser({
			driftClient: driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
		});
		await driftUser.subscribe();

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const reduceOnly = false;
		const priceOffset = PRICE_PRECISION.div(new BN(20));

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			reduceOnly,
			userOrderId: 1,
			postOnly: true,
			oraclePriceOffset: priceOffset,
		});
		await driftClient.placeOrder(orderParams);

		await fillerDriftClient.moveAmmPrice(
			marketIndex,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve.mul(new BN(11)).div(new BN(10))
		);

		await driftUser.fetchAccounts();
		const order = driftUser.getOrderByUserOrderId(1);

		await fillerDriftClient.fillOrder(
			await driftUser.getUserAccountPublicKey(),
			driftUser.getUserAccount(),
			order
		);

		await driftUser.fetchAccounts();
		const position = driftUser.getUserPosition(marketIndex);
		const entryPrice = calculateEntryPrice(position);
		const expectedEntryPrice = PRICE_PRECISION.add(priceOffset);
		console.log(entryPrice.toString());
		assert(entryPrice.eq(expectedEntryPrice));

		await driftClient.unsubscribe();
		await driftUser.unsubscribe();
	});

	it('cancel by order id', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const driftClient = new DriftClient({
			connection,
			wallet,
			programID: driftProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await driftClient.subscribe();
		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const driftUser = new DriftUser({
			driftClient: driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
		});
		await driftUser.subscribe();

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const reduceOnly = false;
		const priceOffset = PRICE_PRECISION.div(new BN(20));

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			reduceOnly,
			postOnly: true,
			oraclePriceOffset: priceOffset,
		});
		await driftClient.placeOrder(orderParams);

		await driftUser.fetchAccounts();
		const orderId = driftUser.getUserAccount().orders[0].orderId;
		await driftClient.cancelOrder(orderId);

		await driftClient.unsubscribe();
		await driftUser.unsubscribe();
	});

	it('cancel by user order id', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const driftClient = new DriftClient({
			connection,
			wallet,
			programID: driftProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await driftClient.subscribe();
		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const driftUser = new DriftUser({
			driftClient: driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
		});
		await driftUser.subscribe();

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const reduceOnly = false;
		const priceOffset = PRICE_PRECISION.div(new BN(20));

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			reduceOnly,
			postOnly: true,
			userOrderId: 1,
			oraclePriceOffset: priceOffset,
		});
		await driftClient.placeOrder(orderParams);

		await driftUser.fetchAccounts();
		await driftClient.cancelOrderByUserId(1);

		await driftClient.unsubscribe();
		await driftUser.unsubscribe();
	});
});
