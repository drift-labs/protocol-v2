import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { Keypair } from '@solana/web3.js';

import {
	Admin,
	BN,
	MARK_PRICE_PRECISION,
	ClearingHouse,
	PositionDirection,
	ClearingHouseUser,
	Wallet,
	EventSubscriber,
} from '../sdk/src';

import {
	initializeQuoteAssetBank,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
} from './testHelpers';
import {
	BASE_PRECISION,
	calculateMarkPrice,
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
	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	let solUsd;
	let marketIndexes;
	let bankIndexes;
	let oracleInfos;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(1);

		marketIndexes = [new BN(0)];
		bankIndexes = [new BN(0)];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		fillerClearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes,
			bankIndexes,
			oracleInfos,
		});
		await fillerClearingHouse.initialize(usdcMint.publicKey, true);
		await fillerClearingHouse.subscribe();
		await initializeQuoteAssetBank(fillerClearingHouse, usdcMint.publicKey);
		await fillerClearingHouse.updateAuctionDuration(new BN(0), new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await fillerClearingHouse.initializeMarket(
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await fillerClearingHouse.updateMarketBaseSpread(new BN(0), 500);

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
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			ZERO
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
			activeUserId: 0,
			marketIndexes,
			bankIndexes,
			oracleInfos,
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

		const marketIndex = new BN(0);
		const baseAssetAmount = BASE_PRECISION;
		const markPrice = calculateMarkPrice(
			clearingHouse.getMarketAccount(marketIndex)
		);
		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: markPrice,
			userOrderId: 1,
			postOnly: true,
		});
		await clearingHouse.placeOrder(makerOrderParams);
		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		assert(order.postOnly);
		await fillerClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve.mul(new BN(2)),
			ammInitialQuoteAssetReserve,
			marketIndex
		);
		await setFeedPrice(anchor.workspace.Pyth, 0.5, solUsd);

		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		const position = clearingHouseUser.getUserPosition(marketIndex);
		assert(position.baseAssetAmount.eq(baseAssetAmount));
		assert(position.quoteEntryAmount.eq(new BN(-1000001)));
		assert(position.quoteAssetAmount.eq(new BN(-1000001)));
		assert(clearingHouse.getQuoteAssetTokenAmount().eq(usdcAmount));
		assert(clearingHouseUser.getUserAccount().fees.totalFeePaid.eq(ZERO));
		assert(clearingHouseUser.getUserAccount().fees.totalFeePaid.eq(ZERO));

		await fillerClearingHouse.fetchAccounts();
		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];

		assert(isVariant(orderRecord.action, 'fill'));
		assert(orderRecord.takerFee.eq(ZERO));
		assert(orderRecord.quoteAssetAmountSurplus.eq(new BN(499875)));

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
			activeUserId: 0,
			marketIndexes,
			bankIndexes,
			oracleInfos,
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

		const marketIndex = new BN(0);
		const baseAssetAmount = BASE_PRECISION;
		const markPrice = calculateMarkPrice(
			clearingHouse.getMarketAccount(marketIndex)
		);
		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: markPrice,
			userOrderId: 1,
			postOnly: true,
		});
		await clearingHouse.placeOrder(makerOrderParams);
		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		assert(order.postOnly);
		await fillerClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve.div(new BN(2)),
			ammInitialQuoteAssetReserve,
			marketIndex
		);

		await setFeedPrice(anchor.workspace.Pyth, 2, solUsd);

		await fillerClearingHouse.fillOrder(
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
		assert(clearingHouseUser.getUserAccount().fees.totalFeePaid.eq(ZERO));
		assert(clearingHouseUser.getUserAccount().fees.totalFeePaid.eq(new BN(0)));

		await fillerClearingHouse.fetchAccounts();
		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];

		assert(isVariant(orderRecord.action, 'fill'));
		assert(orderRecord.takerFee.eq(new BN(0)));
		assert(orderRecord.quoteAssetAmountSurplus.eq(new BN(999492)));

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});
});
