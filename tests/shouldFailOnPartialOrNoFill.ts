import * as anchor from '@coral-xyz/anchor';
import { assert, expect } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { Keypair } from '@solana/web3.js';

import {
	OrderActionRecord,
	BN,
	PRICE_PRECISION,
	TestClient,
	PositionDirection,
	User,
	Wallet,
	getMarketOrderParams,
	EventSubscriber,
} from '../sdk/src';

import {
	createUserWithUSDCAccount,
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import {
	OrderType,
	AMM_RESERVE_PRECISION,
	OracleSource,
	Order,
} from '../sdk/lib';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('new shouldFailOnPartialOrNoFill field on placeAndTakePerpOrder', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	let driftClientUser: User;
	let eventSubscriber: EventSubscriber;
	let bulkAccountLoader: TestBulkAccountLoader;
	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint;
	let userUSDCAccount;

	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	const ammInitialQuoteAssetReserve = new BN(5000).mul(AMM_RESERVE_PRECISION);
	const ammInitialBaseAssetReserve = new BN(5000).mul(AMM_RESERVE_PRECISION);
	const usdcAmount = new BN(100).mul(AMM_RESERVE_PRECISION);

	const fillerKeyPair = new Keypair();
	let fillerUSDCAccount: Keypair;
	let fillerDriftClient: TestClient;
	let fillerUser: User;
	let solUsd;

	before(async () => {
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram
		);
		await eventSubscriber.subscribe();

		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 40);

		marketIndexes = [0, 1];
		spotMarketIndexes = [0];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		driftClient = new TestClient({
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
		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();
		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await driftClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		driftClientUser = new User({
			driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClientUser.subscribe();

		bankrunContextWrapper.fundKeypair(fillerKeyPair, 10 ** 9);
		fillerUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper,
			fillerKeyPair.publicKey
		);
		fillerDriftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new Wallet(fillerKeyPair),
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
		await fillerDriftClient.subscribe();

		await fillerDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			fillerUSDCAccount.publicKey
		);

		fillerUser = new User({
			driftClient: fillerDriftClient,
			userAccountPublicKey: await fillerDriftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await fillerUser.subscribe();
	});

	after(async () => {
		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
		await fillerUser.unsubscribe();
		await fillerDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Partial fill market long order by maker and AMM', async () => {
		const [makerDriftClient, makerUSDCAccount] =
			await createUserWithUSDCAccount(
				bankrunContextWrapper,
				usdcMint,
				chProgram,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);

		const makerUsers = makerDriftClient.getUsers();

		for (let index = 0; index < makerUsers.length; index++) {
			const user = makerUsers[index];
			console.log(
				`maker index: ${index} address: ${user
					.getUserAccountPublicKey()
					.toBase58()}`
			);
		}

		await makerDriftClient.deposit(usdcAmount, 0, makerUSDCAccount);

		await makerDriftClient.placePerpOrder({
			marketIndex: 0,
			direction: PositionDirection.SHORT,
			price: new BN(40).mul(PRICE_PRECISION), // 10 ** 6
			orderType: OrderType.LIMIT,
			baseAssetAmount: new BN(500).mul(AMM_RESERVE_PRECISION), //10 ** 9
		});

		const makerOrder = makerDriftClient.getUserAccount().orders[0];

		console.log('makerOrder:');
		printOrder(makerOrder);
		const makerOrderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];
		console.log('makerOrderActionRecord:');
		printOrderActionRecord(makerOrderActionRecord);

		const driftClientUsers = driftClient.getUsers();
		for (let index = 0; index < driftClientUsers.length; index++) {
			const user = driftClientUsers[index];
			console.log(
				`taker index: ${index} address: ${user
					.getUserAccountPublicKey()
					.toBase58()}`
			);
		}
		const driftClientUserPk = driftClientUser
			.getUserAccountPublicKey()
			.toBase58();
		const fillerUserPk = fillerUser.getUserAccountPublicKey().toBase58();

		console.log('Taker:UserAccountPublicKey:', driftClientUserPk);
		console.log('Filler:UserAccountPublicKey:', fillerUserPk);

		const orderParams = getMarketOrderParams({
			marketIndex: 0,
			direction: PositionDirection.LONG,
			baseAssetAmount: new BN(1000).mul(AMM_RESERVE_PRECISION),
			price: new BN(40).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(40).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(40).mul(PRICE_PRECISION),
			auctionDuration: 0,
		});

		const makerInfo = [
			{
				maker: await makerDriftClient.getUserAccountPublicKey(),
				makerUserAccount: makerDriftClient.getUserAccount(),
				makerStats: await makerDriftClient.getUserStatsAccountPublicKey(),
			},
		];

		// Should report PartialFillError
		try {
			await driftClient.placeAndTakePerpOrder(orderParams, true, makerInfo);
		} catch (e) {
			console.log(e);
			expect(e.message).to.equal(
				'Error processing Instruction 1: custom program error: 0x188d'
			);
		}

		const takerOrder = driftClient.getUserAccount().orders[0];
		console.log('takeOrder:');
		printOrder(takerOrder);

		assert(takerOrder.baseAssetAmount.eq(new BN(0)));
		assert(takerOrder.price.eq(new BN(0)));
		assert(takerOrder.marketIndex === 0);

		const takerPosition = driftClientUser.getUserAccount().perpPositions[0];
		console.log(
			'takerPosition.baseAssetAmount',
			takerPosition.baseAssetAmount.toString()
		);
		console.log(
			'takerPosition.quoteEntryAmount ',
			takerPosition.quoteEntryAmount.toString()
		);
		console.log(
			'takerPosition.quoteBreakEvenAmount',
			takerPosition.quoteBreakEvenAmount.toString()
		);
		console.log(
			'takerPosition.quoteAssetAmount',
			takerPosition.quoteAssetAmount.toString()
		);

		assert(takerPosition.baseAssetAmount.eq(new BN(0)));
		assert(takerPosition.quoteEntryAmount.eq(new BN(0)));
		assert(takerPosition.quoteBreakEvenAmount.eq(new BN(0)));
		assert(takerPosition.quoteAssetAmount.eq(new BN(0)));
	});
});

function printOrderActionRecord(orderActionRecord: OrderActionRecord): void {
	console.log('=== OrderActionRecord ===');
	console.log(
		`orderActionRecord.ts: ${
			orderActionRecord.ts ? orderActionRecord.ts.toString() : 'null'
		}`
	);
	console.log(
		`orderActionRecord.action: ${
			orderActionRecord.action
				? JSON.stringify(orderActionRecord.action)
				: 'null'
		}`
	);
	console.log(
		`orderActionRecord.actionExplanation: ${
			orderActionRecord.actionExplanation
				? JSON.stringify(orderActionRecord.actionExplanation)
				: 'null'
		}`
	);
	console.log(
		`orderActionRecord.marketIndex: ${orderActionRecord.marketIndex}`
	);
	console.log(
		`orderActionRecord.marketType: ${
			orderActionRecord.marketType
				? JSON.stringify(orderActionRecord.marketType)
				: 'null'
		}`
	);
	console.log(
		`orderActionRecord.filler: ${
			orderActionRecord.filler ? orderActionRecord.filler.toString() : 'null'
		}`
	);
	console.log(
		`orderActionRecord.fillerReward: ${
			orderActionRecord.fillerReward
				? orderActionRecord.fillerReward.toString()
				: 'null'
		}`
	);
	console.log(
		`orderActionRecord.fillRecordId: ${
			orderActionRecord.fillRecordId
				? orderActionRecord.fillRecordId.toString()
				: 'null'
		}`
	);
	console.log(
		`orderActionRecord.baseAssetAmountFilled: ${
			orderActionRecord.baseAssetAmountFilled
				? orderActionRecord.baseAssetAmountFilled.toString()
				: 'null'
		}`
	);
	console.log(
		`orderActionRecord.quoteAssetAmountFilled: ${
			orderActionRecord.quoteAssetAmountFilled
				? orderActionRecord.quoteAssetAmountFilled.toString()
				: 'null'
		}`
	);
	console.log(
		`orderActionRecord.takerFee: ${
			orderActionRecord.takerFee
				? orderActionRecord.takerFee.toString()
				: 'null'
		}`
	);
	console.log(
		`orderActionRecord.makerFee: ${
			orderActionRecord.makerFee
				? orderActionRecord.makerFee.toString()
				: 'null'
		}`
	);
	console.log(
		`orderActionRecord.referrerReward: ${
			orderActionRecord.referrerReward !== null
				? orderActionRecord.referrerReward
				: 'null'
		}`
	);
	console.log(
		`orderActionRecord.quoteAssetAmountSurplus: ${
			orderActionRecord.quoteAssetAmountSurplus
				? orderActionRecord.quoteAssetAmountSurplus.toString()
				: 'null'
		}`
	);
	console.log(
		`orderActionRecord.spotFulfillmentMethodFee: ${
			orderActionRecord.spotFulfillmentMethodFee
				? orderActionRecord.spotFulfillmentMethodFee.toString()
				: 'null'
		}`
	);
	console.log(
		`orderActionRecord.taker: ${
			orderActionRecord.taker ? orderActionRecord.taker.toString() : 'null'
		}`
	);
	console.log(
		`orderActionRecord.takerOrderId: ${
			orderActionRecord.takerOrderId !== null
				? orderActionRecord.takerOrderId
				: 'null'
		}`
	);
	console.log(
		`orderActionRecord.takerOrderDirection: ${
			orderActionRecord.takerOrderDirection
				? JSON.stringify(orderActionRecord.takerOrderDirection)
				: 'null'
		}`
	);
	console.log(
		`orderActionRecord.takerOrderBaseAssetAmount: ${
			orderActionRecord.takerOrderBaseAssetAmount
				? orderActionRecord.takerOrderBaseAssetAmount.toString()
				: 'null'
		}`
	);
	console.log(
		`orderActionRecord.takerOrderCumulativeBaseAssetAmountFilled: ${
			orderActionRecord.takerOrderCumulativeBaseAssetAmountFilled
				? orderActionRecord.takerOrderCumulativeBaseAssetAmountFilled.toString()
				: 'null'
		}`
	);
	console.log(
		`orderActionRecord.takerOrderCumulativeQuoteAssetAmountFilled: ${
			orderActionRecord.takerOrderCumulativeQuoteAssetAmountFilled
				? orderActionRecord.takerOrderCumulativeQuoteAssetAmountFilled.toString()
				: 'null'
		}`
	);
	console.log(
		`orderActionRecord.maker: ${
			orderActionRecord.maker ? orderActionRecord.maker.toString() : 'null'
		}`
	);
	console.log(
		`orderActionRecord.makerOrderId: ${
			orderActionRecord.makerOrderId !== null
				? orderActionRecord.makerOrderId
				: 'null'
		}`
	);
	console.log(
		`orderActionRecord.makerOrderDirection: ${
			orderActionRecord.makerOrderDirection
				? JSON.stringify(orderActionRecord.makerOrderDirection)
				: 'null'
		}`
	);
	console.log(
		`orderActionRecord.makerOrderBaseAssetAmount: ${
			orderActionRecord.makerOrderBaseAssetAmount
				? orderActionRecord.makerOrderBaseAssetAmount.toString()
				: 'null'
		}`
	);
	console.log(
		`orderActionRecord.makerOrderCumulativeBaseAssetAmountFilled: ${
			orderActionRecord.makerOrderCumulativeBaseAssetAmountFilled
				? orderActionRecord.makerOrderCumulativeBaseAssetAmountFilled.toString()
				: 'null'
		}`
	);
	console.log(
		`orderActionRecord.makerOrderCumulativeQuoteAssetAmountFilled: ${
			orderActionRecord.makerOrderCumulativeQuoteAssetAmountFilled
				? orderActionRecord.makerOrderCumulativeQuoteAssetAmountFilled.toString()
				: 'null'
		}`
	);
	console.log(
		`orderActionRecord.oraclePrice: ${
			orderActionRecord.oraclePrice
				? orderActionRecord.oraclePrice.toString()
				: 'null'
		}`
	);
}

function printOrder(order: Order): void {
	console.log('=== Order ===');
	console.log(
		`order.status: ${order.status ? JSON.stringify(order.status) : 'null'}`
	);
	console.log(
		`order.orderType: ${
			order.orderType ? JSON.stringify(order.orderType) : 'null'
		}`
	);
	console.log(
		`order.marketType: ${
			order.marketType ? JSON.stringify(order.marketType) : 'null'
		}`
	);
	console.log(`order.slot: ${order.slot ? order.slot.toString() : 'null'}`);
	console.log(`order.orderId: ${order.orderId}`);
	console.log(`order.userOrderId: ${order.userOrderId}`);
	console.log(`order.marketIndex: ${order.marketIndex}`);
	console.log(`order.price: ${order.price ? order.price.toString() : 'null'}`);
	console.log(
		`order.baseAssetAmount: ${
			order.baseAssetAmount ? order.baseAssetAmount.toString() : 'null'
		}`
	);
	console.log(
		`order.quoteAssetAmount: ${
			order.quoteAssetAmount ? order.quoteAssetAmount.toString() : 'null'
		}`
	);
	console.log(
		`order.baseAssetAmountFilled: ${
			order.baseAssetAmountFilled
				? order.baseAssetAmountFilled.toString()
				: 'null'
		}`
	);
	console.log(
		`order.quoteAssetAmountFilled: ${
			order.quoteAssetAmountFilled
				? order.quoteAssetAmountFilled.toString()
				: 'null'
		}`
	);
	console.log(
		`order.direction: ${
			order.direction ? JSON.stringify(order.direction) : 'null'
		}`
	);
	console.log(`order.reduceOnly: ${order.reduceOnly}`);
	console.log(
		`order.triggerPrice: ${
			order.triggerPrice ? order.triggerPrice.toString() : 'null'
		}`
	);
	console.log(
		`order.triggerCondition: ${
			order.triggerCondition ? JSON.stringify(order.triggerCondition) : 'null'
		}`
	);
	console.log(
		`order.existingPositionDirection: ${
			order.existingPositionDirection
				? JSON.stringify(order.existingPositionDirection)
				: 'null'
		}`
	);
	console.log(`order.postOnly: ${order.postOnly}`);
	console.log(`order.immediateOrCancel: ${order.immediateOrCancel}`);
	console.log(`order.oraclePriceOffset: ${order.oraclePriceOffset}`);
	console.log(`order.auctionDuration: ${order.auctionDuration}`);
	console.log(
		`order.auctionStartPrice: ${
			order.auctionStartPrice ? order.auctionStartPrice.toString() : 'null'
		}`
	);
	console.log(
		`order.auctionEndPrice: ${
			order.auctionEndPrice ? order.auctionEndPrice.toString() : 'null'
		}`
	);
	console.log(`order.maxTs: ${order.maxTs ? order.maxTs.toString() : 'null'}`);
}
