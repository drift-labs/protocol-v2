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
	BASE_PRECISION,
	calculateReservePrice,
	getLimitOrderParams,
	isVariant,
	OracleSource,
	PEG_PRECISION,
	ZERO,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	sleep,
} from './testHelpers';

describe('post only maker order w/ amm fulfillments', () => {
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

		solUsd = await mockOracle(32.821);

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
			periodicity,
			new BN(32.821 * PEG_PRECISION.toNumber())
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
		await setFeedPrice(anchor.workspace.Pyth, 32.821, solUsd);
	});

	after(async () => {
		await fillerClearingHouse.unsubscribe();
		await fillerClearingHouseUser.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('long', async () => {
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
			postOnly: false,
		});
		await clearingHouse.placePerpOrder(makerOrderParams);
		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);
		assert(!order.postOnly);

		const newOraclePrice = 0.98 * 32.821;
		const newOraclePriceBN = new BN(
			newOraclePrice * PRICE_PRECISION.toNumber()
		);
		setFeedPrice(anchor.workspace.Pyth, newOraclePrice, solUsd);
		await fillerClearingHouse.moveAmmToPrice(marketIndex, newOraclePriceBN);

		const reservePrice2 = calculateReservePrice(
			clearingHouse.getPerpMarketAccount(marketIndex),
			undefined
		);
		console.log(
			'new amm prices:',
			newOraclePrice,
			'vs',
			reservePrice2.toString()
		);
		const makerOrderParams2 = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount: baseAssetAmount.div(new BN(2)),
			price: reservePrice2.add(
				clearingHouse.getPerpMarketAccount(marketIndex).amm.orderTickSize
			),
			userOrderId: 1,
			postOnly: true,
		});
		await fillerClearingHouse.placePerpOrder(makerOrderParams2);
		await fillerClearingHouse.fetchAccounts();
		const order2 = fillerClearingHouse.getOrderByUserId(1);
		assert(order2.postOnly);

		const makerInfo = {
			maker: await fillerClearingHouse.getUserAccountPublicKey(),
			makerStats: fillerClearingHouse.getUserStatsAccountPublicKey(),
			makerUserAccount: fillerClearingHouse.getUserAccount(),
			order: order2,
		};

		await fillerClearingHouse.fillPerpOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order,
			makerInfo
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		const position = clearingHouseUser.getUserPosition(marketIndex);
		assert(position.baseAssetAmount.eq(baseAssetAmount));
		console.log(position.quoteAssetAmount.toString());
		console.log(position.quoteEntryAmount.toString());

		assert(position.quoteAssetAmount.eq(new BN(-32208912)));
		assert(position.quoteEntryAmount.eq(new BN(-32176734)));

		console.log(
			'clearingHouse.getQuoteAssetTokenAmount:',
			clearingHouse.getQuoteAssetTokenAmount().toString(),
			'vs',
			usdcAmount.toString()
		);
		assert(clearingHouse.getQuoteAssetTokenAmount().eq(usdcAmount));

		const clearingHouseUserStats = clearingHouse.getUserStats().getAccount();
		console.log('user stats:', clearingHouseUserStats);
		assert(clearingHouseUserStats.fees.totalFeePaid.eq(new BN(32178)));
		assert(clearingHouseUserStats.fees.totalFeeRebate.eq(ZERO));

		await fillerClearingHouse.fetchAccounts();
		const orderRecords = eventSubscriber.getEventsArray('OrderActionRecord');

		console.log(orderRecords.length, 'orderRecords found.');
		assert(orderRecords.length == 4);

		const orderRecord = orderRecords[0];
		console.log(orderRecord);
		assert(isVariant(orderRecord.action, 'fill'));
		assert(isVariant(orderRecord.actionExplanation, 'orderFilledWithAmm'));
		assert(orderRecord.takerFee.eq(new BN(16091)));
		assert(orderRecord.fillRecordId.eq(new BN(2)));
		assert(orderRecord.fillerReward.eq(ZERO));
		assert(orderRecord.quoteAssetAmountSurplus.eq(new BN(4022)));
		assert(orderRecord.oraclePrice.eq(new BN(32164580)));
		assert(orderRecord.baseAssetAmountFilled.eq(new BN(1000000000 / 2)));
		assert(orderRecord.quoteAssetAmountFilled.eq(new BN(16090374)));
		assert(orderRecord.maker == null);

		const orderRecord2 = orderRecords[1];
		console.log(orderRecord2);
		assert(isVariant(orderRecord2.action, 'fill'));
		assert(isVariant(orderRecord2.actionExplanation, 'none'));
		// assert(orderRecord2.maker == await fillerClearingHouse.getUserAccountPublicKey());
		// assert(orderRecord2.taker == await clearingHouse.getUserAccountPublicKey());
		assert(orderRecord2.baseAssetAmountFilled.eq(new BN(1000000000 / 2)));
		console.log(orderRecord2.quoteAssetAmountFilled.toString());
		assert(orderRecord2.quoteAssetAmountFilled.eq(new BN(16086360)));
		assert(orderRecord2.quoteAssetAmountSurplus == null);
		assert(orderRecord2.makerFee.eq(new BN(-3217)));
		assert(orderRecord2.takerFee.eq(new BN(16087)));
		assert(orderRecord2.fillerReward.eq(ZERO));

		const orderRecord3 = orderRecords[2];
		console.log(orderRecord3);
		assert(isVariant(orderRecord3.action, 'place'));
		assert(isVariant(orderRecord3.actionExplanation, 'none'));

		const orderRecord4 = orderRecords[3];
		console.log(orderRecord4);
		assert(isVariant(orderRecord4.action, 'place'));
		assert(isVariant(orderRecord4.actionExplanation, 'none'));

		await fillerClearingHouseUser.fetchAccounts();

		const positionMaker = fillerClearingHouseUser.getUserPosition(marketIndex);
		console.log(positionMaker);
		assert(positionMaker.baseAssetAmount.eq(new BN(-500000000)));
		console.log(positionMaker.quoteAssetAmount.toString());
		console.log(positionMaker.quoteEntryAmount.toString());
		assert(positionMaker.quoteAssetAmount.eq(new BN(16089577)));
		assert(positionMaker.quoteEntryAmount.eq(new BN(16086360)));

		await fillerClearingHouse.fetchAccounts();
		const perpMarket = fillerClearingHouse.getPerpMarketAccount(0);
		console.log(perpMarket.amm.totalFee.toString());
		console.log(perpMarket.amm.totalFeeMinusDistributions.toString());
		console.log(perpMarket.amm.totalExchangeFee.toString());
		console.log(perpMarket.amm.totalMmFee.toString());
		console.log(perpMarket.amm.totalFeeWithdrawn.toString());

		assert(perpMarket.amm.totalFee.eq(new BN(32983)));
		assert(perpMarket.amm.totalFeeMinusDistributions.eq(new BN(32983)));
		assert(perpMarket.amm.totalExchangeFee.eq(new BN(28961)));
		assert(perpMarket.amm.totalMmFee.eq(new BN(4022)));
		assert(perpMarket.amm.totalFeeWithdrawn.eq(ZERO));

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});
});
