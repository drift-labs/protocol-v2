import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { Keypair } from '@solana/web3.js';

import {
	TestClient,
	BN,
	PRICE_PRECISION,
	PositionDirection,
	User,
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
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPriceNoProgram,
	sleep,
} from './testHelpers';
import { convertToNumber, PostOnlyParams } from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('post only maker order w/ amm fulfillments', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let fillerDriftClient: TestClient;
	let fillerDriftClientUser: User;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

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
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram
		);

		await eventSubscriber.subscribe();

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 32.821);

		marketIndexes = [0];
		spotMarketIndexes = [0];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		fillerDriftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
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
		await fillerDriftClient.initialize(usdcMint.publicKey, true);
		await fillerDriftClient.subscribe();
		await initializeQuoteSpotMarket(fillerDriftClient, usdcMint.publicKey);
		await fillerDriftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await fillerDriftClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(32.821 * PEG_PRECISION.toNumber())
		);
		await fillerDriftClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);

		await fillerDriftClient.updatePerpMarketBaseSpread(0, 500);

		await fillerDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		fillerDriftClientUser = new User({
			driftClient: fillerDriftClient,
			userAccountPublicKey: await fillerDriftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await fillerDriftClientUser.subscribe();
	});

	beforeEach(async () => {
		await fillerDriftClient.moveAmmPrice(
			0,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve
		);
		await setFeedPriceNoProgram(bankrunContextWrapper, 32.821, solUsd);
	});

	after(async () => {
		await fillerDriftClient.unsubscribe();
		await fillerDriftClientUser.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('long', async () => {
		const keypair = new Keypair();
		await bankrunContextWrapper.fundKeypair(keypair, 10 ** 9);
		await sleep(1000);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper,
			keypair.publicKey
		);
		const driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			subAccountIds: [],
			oracleInfos,
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClient.subscribe();
		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const driftClientUser = new User({
			driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClientUser.subscribe();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const reservePrice = calculateReservePrice(
			driftClient.getPerpMarketAccount(marketIndex),
			undefined
		);

		const newOraclePrice = 0.98 * 32.821;
		const newOraclePriceBN = new BN(
			newOraclePrice * PRICE_PRECISION.toNumber()
		);
		setFeedPriceNoProgram(bankrunContextWrapper, newOraclePrice, solUsd);
		await fillerDriftClient.moveAmmToPrice(marketIndex, newOraclePriceBN);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();
		await fillerDriftClient.fetchAccounts();

		const reservePrice2 = calculateReservePrice(
			fillerDriftClient.getPerpMarketAccount(marketIndex),
			undefined
		);
		console.log(
			'new amm prices:',
			newOraclePrice,
			'vs',
			reservePrice2.toString()
		);
		assert(reservePrice2.eq(new BN('32172703')));

		const makerOrderParams2 = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount: baseAssetAmount.div(new BN(2)),
			price: reservePrice2.add(
				driftClient.getPerpMarketAccount(marketIndex).amm.orderTickSize
			),
			userOrderId: 1,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
		});
		await fillerDriftClient.placePerpOrder(makerOrderParams2);
		await fillerDriftClient.fetchAccounts();
		const order2 = fillerDriftClient.getOrderByUserId(1);
		assert(order2.postOnly);

		await setFeedPriceNoProgram(
			bankrunContextWrapper,
			convertToNumber(reservePrice),
			solUsd
		);
		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: reservePrice,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		});
		await driftClient.placePerpOrder(makerOrderParams);
		await driftClientUser.fetchAccounts();
		const order = driftClientUser.getOrderByUserOrderId(1);
		assert(!order.postOnly);

		await setFeedPriceNoProgram(bankrunContextWrapper, newOraclePrice, solUsd);

		const makerInfo = {
			maker: await fillerDriftClient.getUserAccountPublicKey(),
			makerStats: fillerDriftClient.getUserStatsAccountPublicKey(),
			makerUserAccount: fillerDriftClient.getUserAccount(),
			order: order2,
		};

		const txSig = await fillerDriftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order,
			makerInfo
		);
		bankrunContextWrapper.printTxLogs(txSig);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();
		const position = driftClientUser.getPerpPosition(marketIndex);
		assert(position.baseAssetAmount.eq(baseAssetAmount));
		console.log(position.quoteAssetAmount.toString());
		console.log(position.quoteBreakEvenAmount.toString());
		console.log(position.quoteEntryAmount.toString());

		assert(position.quoteAssetAmount.eq(new BN(-32208912)));
		assert(position.quoteEntryAmount.eq(new BN(-32176734)));
		assert(position.quoteBreakEvenAmount.eq(new BN(-32208912)));

		console.log(
			'driftClient.getQuoteAssetTokenAmount:',
			driftClient.getQuoteAssetTokenAmount().toString(),
			'vs',
			usdcAmount.toString()
		);
		assert(driftClient.getQuoteAssetTokenAmount().eq(usdcAmount));

		const driftClientUserStats = driftClient.getUserStats().getAccount();
		console.log('user stats:', driftClientUserStats);
		assert(driftClientUserStats.fees.totalFeePaid.eq(new BN(32178)));
		assert(driftClientUserStats.fees.totalFeeRebate.eq(ZERO));

		await fillerDriftClient.fetchAccounts();
		const orderRecords = eventSubscriber.getEventsArray('OrderActionRecord');

		console.log(orderRecords.length, 'orderRecords found.');
		assert(orderRecords.length == 4);

		const orderRecord = orderRecords[0];
		// console.log(orderRecords);
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
		assert(isVariant(orderRecord2.actionExplanation, 'orderFilledWithMatch'));
		// assert(orderRecord2.maker == await fillerDriftClient.getUserAccountPublicKey());
		// assert(orderRecord2.taker == await driftClient.getUserAccountPublicKey());
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

		await fillerDriftClientUser.fetchAccounts();

		const positionMaker = fillerDriftClientUser.getPerpPosition(marketIndex);
		console.log(positionMaker);
		assert(positionMaker.baseAssetAmount.eq(new BN(-500000000)));
		console.log(positionMaker.quoteAssetAmount.toString());
		console.log(positionMaker.quoteBreakEvenAmount.toString());
		assert(positionMaker.quoteAssetAmount.eq(new BN(16089577)));
		assert(positionMaker.quoteEntryAmount.eq(new BN(16086360)));
		assert(positionMaker.quoteBreakEvenAmount.eq(new BN(16089577)));

		await fillerDriftClient.fetchAccounts();
		const perpMarket = fillerDriftClient.getPerpMarketAccount(0);
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

		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
	});
});
