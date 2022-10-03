import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { Keypair } from '@solana/web3.js';

import {
	AdminClient,
	BN,
	PRICE_PRECISION,
	DriftClient,
	PositionDirection,
	DriftUser,
	Wallet,
	OrderTriggerCondition,
	getTriggerMarketOrderParams,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
} from './testHelpers';
import { BASE_PRECISION, OracleSource } from '../sdk';

describe('trigger orders', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const driftProgram = anchor.workspace.Drift as Program;

	let fillerDriftClient: AdminClient;
	let fillerDriftUser: DriftUser;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	let solUsd;

	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(1);
		marketIndexes = [0];
		spotMarketIndexes = [0, 1];
		oracleInfos = [
			{
				publicKey: solUsd,
				source: OracleSource.PYTH,
			},
		];

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
		await initializeSolSpotMarket(fillerDriftClient, solUsd);
		await fillerDriftClient.updateSpotAuctionDuration(0);

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

	it('trigger order with below condition', async () => {
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
			wallet: wallet,
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

		const marketIndex = 1;
		const baseAssetAmount = BASE_PRECISION;

		const stopOrderParams = getTriggerMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			triggerPrice: PRICE_PRECISION.div(new BN(2)),
			triggerCondition: OrderTriggerCondition.BELOW,
			userOrderId: 1,
		});
		await driftClient.placeSpotOrder(stopOrderParams);

		await driftUser.fetchAccounts();
		let order = driftUser.getOrderByUserOrderId(1);

		const newOraclePrice = 0.49;
		await setFeedPrice(anchor.workspace.Pyth, newOraclePrice, solUsd);

		await fillerDriftClient.triggerOrder(
			await driftUser.getUserAccountPublicKey(),
			driftUser.getUserAccount(),
			order
		);

		await driftUser.fetchAccounts();
		await fillerDriftClient.fetchAccounts();

		order = driftUser.getOrderByUserOrderId(1);
		assert(order.triggered);

		const userQuoteTokenAmount = driftClient.getQuoteAssetTokenAmount();
		assert(userQuoteTokenAmount.eq(new BN(9990000)));
		const fillerQuoteTokenAmount = fillerDriftClient.getQuoteAssetTokenAmount();
		assert(fillerQuoteTokenAmount.eq(new BN(10010000)));

		await driftClient.unsubscribe();
		await driftUser.unsubscribe();
	});

	it('trigger order with above condition', async () => {
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
			wallet: wallet,
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

		const marketIndex = 1;
		const baseAssetAmount = BASE_PRECISION;

		const stopOrderParams = getTriggerMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			triggerPrice: PRICE_PRECISION.mul(new BN(2)),
			triggerCondition: OrderTriggerCondition.ABOVE,
			userOrderId: 1,
		});
		await driftClient.placeSpotOrder(stopOrderParams);

		await driftUser.fetchAccounts();
		let order = driftUser.getOrderByUserOrderId(1);

		const newOraclePrice = 2.01;
		await setFeedPrice(anchor.workspace.Pyth, newOraclePrice, solUsd);

		await fillerDriftClient.triggerOrder(
			await driftUser.getUserAccountPublicKey(),
			driftUser.getUserAccount(),
			order
		);

		await driftUser.fetchAccounts();
		await fillerDriftClient.fetchAccounts();

		order = driftUser.getOrderByUserOrderId(1);
		assert(order.triggered);

		const userQuoteTokenAmount = driftClient.getQuoteAssetTokenAmount();
		assert(userQuoteTokenAmount.eq(new BN(9990000)));
		const fillerQuoteTokenAmount = fillerDriftClient.getQuoteAssetTokenAmount();
		assert(fillerQuoteTokenAmount.eq(new BN(10020000)));

		await driftClient.unsubscribe();
		await driftUser.unsubscribe();
	});
});
