import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { Keypair } from '@solana/web3.js';

import {
	Admin,
	BN,
	PRICE_PRECISION,
	ClearingHouse,
	PositionDirection,
	ClearingHouseUser,
	Wallet,
	EventSubscriber,
	MarketStatus,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
} from './testHelpers';
import {
	BASE_PRECISION,
	calculateReservePrice,
	getLimitOrderParams,
	isVariant,
	OracleSource,
	ZERO,
} from '../sdk';

describe('post only', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let fillerClearingHouse: Admin;
	let fillerClearingHouseUser: ClearingHouseUser;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(100000);
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
		spotMarketIndexes = [0];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		fillerClearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await fillerClearingHouse.initialize(usdcMint.publicKey, true);
		await fillerClearingHouse.subscribe();
		await initializeQuoteSpotMarket(fillerClearingHouse, usdcMint.publicKey);
		await fillerClearingHouse.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await fillerClearingHouse.initializePerpMarket(
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);
		await fillerClearingHouse.updatePerpMarketStatus(0, MarketStatus.ACTIVE);

		await fillerClearingHouse.updatePerpMarketBaseSpread(0, 500);

		await fillerClearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		fillerClearingHouseUser = new ClearingHouseUser({
			clearingHouse: fillerClearingHouse,
			userAccountPublicKey: await fillerClearingHouse.getUserAccountPublicKey(),
		});
		await fillerClearingHouseUser.subscribe();
	});

	beforeEach(async () => {
		await fillerClearingHouse.moveAmmPrice(
			0,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve
		);
		await setFeedPrice(anchor.workspace.Pyth, 1, solUsd);
	});

	after(async () => {
		await fillerClearingHouse.unsubscribe();
		await fillerClearingHouseUser.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('long', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const clearingHouse = new ClearingHouse({
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
		});
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const reservePrice = calculateReservePrice(
			clearingHouse.getPerpMarketAccount(marketIndex),
			undefined
		);
		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: reservePrice,
			userOrderId: 1,
			postOnly: true,
		});
		await clearingHouse.placePerpOrder(makerOrderParams);
		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		assert(order.postOnly);
		const newOraclePrice = 0.98;
		setFeedPrice(anchor.workspace.Pyth, newOraclePrice, solUsd);
		await fillerClearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(newOraclePrice * PRICE_PRECISION.toNumber())
		);

		await fillerClearingHouse.fillPerpOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		const position = clearingHouseUser.getUserPosition(marketIndex);
		assert(position.baseAssetAmount.eq(baseAssetAmount));
		console.log(position.quoteEntryAmount.toString());
		assert(clearingHouse.getQuoteAssetTokenAmount().eq(usdcAmount));
		assert(
			clearingHouse.getUserStats().getAccount().fees.totalFeePaid.eq(ZERO)
		);

		await fillerClearingHouse.fetchAccounts();
		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert(isVariant(orderRecord.action, 'fill'));
		assert(orderRecord.takerFee.eq(ZERO));
		assert(orderRecord.quoteAssetAmountSurplus.eq(new BN(19507)));

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('short', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const clearingHouse = new ClearingHouse({
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
		});
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const reservePrice = calculateReservePrice(
			clearingHouse.getPerpMarketAccount(marketIndex),
			undefined
		);
		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: reservePrice,
			userOrderId: 1,
			postOnly: true,
		});
		await clearingHouse.placePerpOrder(makerOrderParams);
		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		assert(order.postOnly);

		const newOraclePrice = 1.02;
		setFeedPrice(anchor.workspace.Pyth, newOraclePrice, solUsd);
		await fillerClearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(newOraclePrice * PRICE_PRECISION.toNumber())
		);

		await fillerClearingHouse.fillPerpOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		const position = clearingHouseUser.getUserPosition(marketIndex);
		assert(position.baseAssetAmount.abs().eq(baseAssetAmount));
		assert(position.quoteEntryAmount.eq(new BN(1000000)));
		assert(clearingHouse.getQuoteAssetTokenAmount().eq(usdcAmount));
		assert(
			clearingHouse.getUserStats().getAccount().fees.totalFeePaid.eq(ZERO)
		);

		await fillerClearingHouse.fetchAccounts();
		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert(isVariant(orderRecord.action, 'fill'));
		assert(orderRecord.takerFee.eq(new BN(0)));
		assert(orderRecord.quoteAssetAmountSurplus.eq(new BN(19492)));

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});
});
