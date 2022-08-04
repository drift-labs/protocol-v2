import * as anchor from '@project-serum/anchor';

import { assert } from 'chai';
import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	Admin,
	BN,
	EventSubscriber,
	Order,
	OrderRecord,
} from '../../sdk/src';

import {
	DLOB
} from '../../sdk/src/dlob/DLOB';

import {
	mockUSDCMint,
	mockOracle,
	initializeQuoteAssetBank,
} from '../testHelpers';

describe('dlob', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);

		const solUsd = await mockOracle(1);
		const periodicity = new BN(60 * 60); // 1 HOUR

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes: [new BN(0)],
			bankIndexes: [new BN(0)],
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);
		await clearingHouse.updateAuctionDuration(new BN(0), new BN(0));

		await clearingHouse.initializeMarket(
			solUsd,
			new BN(1000),
			new BN(1000),
			periodicity
		);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
	});

	it('DLOB handle place sell', async () => {

		await clearingHouse.fetchAccounts();
		const markets = clearingHouse.getMarketAccount(0);

		const dlob = new DLOB(
			[markets],
			(o: Order, u: PublicKey) => {
				console.log(`DLOB update: ${u.toBase58()}-${o.orderId.toString()}`)
			},
			(o: Order, u: PublicKey) => {
				console.log(`DLOB remove: ${u.toBase58()}-${o.orderId.toString()}`)
			},
			(o: Order, u: PublicKey) => {
				console.log(`DLOB insert: ${u.toBase58()}-${o.orderId.toString()}`)
			},
			(o: Order, u: PublicKey) => {
				console.log(`DLOB trigger: ${u.toBase58()}-${o.orderId.toString()}`)
			}
		)

		const sellOrder = {
			"ts": new BN("62e99f4e", 16),
			"slot": new BN(152323904),
			"taker": new PublicKey("DJwD8T2TKev7asmcvPyU9BUhTsjH5yZYEwoKDoHHcicu"),
			"maker": PublicKey.default,
			"takerOrder": {
				"status": {
					"open": {}
				},
				"orderType": {
					"market": {}
				},
				"ts": new BN("62e99f4e", 16),
				"slot": new BN("09144740", 16),
				"orderId": new BN("112f", 16),
				"userOrderId": 0,
				"marketIndex": new BN("00", 16),
				"price": new BN("00", 16),
				"existingPositionDirection": {
					"long": {}
				},
				"baseAssetAmount": new BN("e221d1b380", 16),
				"baseAssetAmountFilled": new BN("00", 16),
				"quoteAssetAmountFilled": new BN("00", 16),
				"fee": new BN("00", 16),
				"direction": {
					"short": {}
				},
				"reduceOnly": false,
				"postOnly": false,
				"immediateOrCancel": false,
				"discountTier": {
					"none": {}
				},
				"triggerPrice": new BN("00", 16),
				"triggerCondition": {
					"above": {}
				},
				"triggered": false,
				"referrer": PublicKey.default,
				"oraclePriceOffset": new BN("00", 16),
				"auctionStartPrice": new BN("6001bd2896", 16),
				"auctionEndPrice": new BN("5fe64dd31d", 16),
				"auctionDuration": 10,
				"padding": [
					0,
					0,
					0
				]
			},
			"makerOrder": {
				"status": {
					"init": {}
				},
				"orderType": {
					"limit": {}
				},
				"ts": new BN("00", 16),
				"slot": new BN("00", 16),
				"orderId": new BN("00", 16),
				"userOrderId": 0,
				"marketIndex": new BN("00", 16),
				"price": new BN("00", 16),
				"existingPositionDirection": {
					"long": {}
				},
				"baseAssetAmount": new BN("00", 16),
				"baseAssetAmountFilled": new BN("00", 16),
				"quoteAssetAmountFilled": new BN("00", 16),
				"fee": new BN("00", 16),
				"direction": {
					"long": {}
				},
				"reduceOnly": false,
				"postOnly": false,
				"immediateOrCancel": false,
				"discountTier": {
					"none": {}
				},
				"triggerPrice": new BN("00", 16),
				"triggerCondition": {
					"above": {}
				},
				"triggered": false,
				"referrer": "11111111111111111111111111111111",
				"oraclePriceOffset": new BN("00", 16),
				"auctionStartPrice": new BN("00", 16),
				"auctionEndPrice": new BN("00", 16),
				"auctionDuration": 0,
				"padding": [
					0,
					0,
					0
				]
			},
			"makerUnsettledPnl": new BN("00", 16),
			"takerUnsettledPnl": new BN("00", 16),
			"action": {
				"place": {}
			},
			"actionExplanation": {
				"none": {}
			},
			"filler": "11111111111111111111111111111111",
			"fillRecordId": new BN("00", 16),
			"marketIndex": new BN("00", 16),
			"baseAssetAmountFilled": new BN("00", 16),
			"quoteAssetAmountFilled": new BN("00", 16),
			"makerRebate": new BN("00", 16),
			"takerFee": new BN("00", 16),
			"fillerReward": new BN("00", 16),
			"quoteAssetAmountSurplus": new BN("00", 16),
			"oraclePrice": new BN("5ff2b8f220", 16),
			"txSig": "vMoYxjBbPgwGB8dRyB4FCeYWrw8mxJiMVteZTYKWnQVUUBkvxwpshLgDLHhrNkQPE1BRw2krDxAGVyYwVjxRvPc",
			"eventType": "OrderRecord"
			}
			

		let bidsCountBefore = 0;
		for await (const bid of dlob.getBids(new BN(0), new BN(0), 0)) {
			bidsCountBefore++;
		}
		let asksCountBefore = 0;
		for await (const ask of dlob.getAsks(new BN(0), new BN(0), 0)) {
			asksCountBefore++;
		}
		
		dlob.applyOrderRecord(sellOrder as OrderRecord);

		let bidsCountAfter = 0;
		for await (const bid of dlob.getBids(new BN(0), new BN(0), 0)) {
			bidsCountAfter++;
		}
		let asksCountAfter = 0;
		let foundMatchingAsk = false;
		for await (const ask of dlob.getAsks(new BN(0), new BN(0), 0)) {
			asksCountAfter++;
			if (ask.order && (ask.order.orderId === sellOrder.takerOrder.orderId)) {
				foundMatchingAsk = true;
			}
		}

		assert(asksCountAfter === asksCountBefore + 1);
		assert(bidsCountAfter === bidsCountBefore);
		assert(foundMatchingAsk);
	});

	it('DLOB handle fill', async () => {

		await clearingHouse.fetchAccounts();
		const markets = clearingHouse.getMarketAccount(0);

		const dlob = new DLOB(
			[markets],
			(o: Order, u: PublicKey) => {
				console.log(`DLOB update: ${u.toBase58()}-${o.orderId.toString()}`)
			},
			(o: Order, u: PublicKey) => {
				console.log(`DLOB remove: ${u.toBase58()}-${o.orderId.toString()}`)
			},
			(o: Order, u: PublicKey) => {
				console.log(`DLOB insert: ${u.toBase58()}-${o.orderId.toString()}`)
			},
			(o: Order, u: PublicKey) => {
				console.log(`DLOB trigger: ${u.toBase58()}-${o.orderId.toString()}`)
			}
		)

		const sellOrder = {
			"ts": new BN("62e99f4e", 16),
			"slot": new BN(152323904),
			"taker": new PublicKey("DJwD8T2TKev7asmcvPyU9BUhTsjH5yZYEwoKDoHHcicu"),
			"maker": PublicKey.default,
			"takerOrder": {
				"status": {
					"open": {}
				},
				"orderType": {
					"market": {}
				},
				"ts": new BN("62e99f4e", 16),
				"slot": new BN("09144740", 16),
				"orderId": new BN("112f", 16),
				"userOrderId": 0,
				"marketIndex": new BN("00", 16),
				"price": new BN("00", 16),
				"existingPositionDirection": {
					"long": {}
				},
				"baseAssetAmount": new BN("e221d1b380", 16),
				"baseAssetAmountFilled": new BN("00", 16),
				"quoteAssetAmountFilled": new BN("00", 16),
				"fee": new BN("00", 16),
				"direction": {
					"short": {}
				},
				"reduceOnly": false,
				"postOnly": false,
				"immediateOrCancel": false,
				"discountTier": {
					"none": {}
				},
				"triggerPrice": new BN("00", 16),
				"triggerCondition": {
					"above": {}
				},
				"triggered": false,
				"referrer": PublicKey.default,
				"oraclePriceOffset": new BN("00", 16),
				"auctionStartPrice": new BN("6001bd2896", 16),
				"auctionEndPrice": new BN("5fe64dd31d", 16),
				"auctionDuration": 10,
				"padding": [
					0,
					0,
					0
				]
			},
			"makerOrder": {
				"status": {
					"init": {}
				},
				"orderType": {
					"limit": {}
				},
				"ts": new BN("00", 16),
				"slot": new BN("00", 16),
				"orderId": new BN("00", 16),
				"userOrderId": 0,
				"marketIndex": new BN("00", 16),
				"price": new BN("00", 16),
				"existingPositionDirection": {
					"long": {}
				},
				"baseAssetAmount": new BN("00", 16),
				"baseAssetAmountFilled": new BN("00", 16),
				"quoteAssetAmountFilled": new BN("00", 16),
				"fee": new BN("00", 16),
				"direction": {
					"long": {}
				},
				"reduceOnly": false,
				"postOnly": false,
				"immediateOrCancel": false,
				"discountTier": {
					"none": {}
				},
				"triggerPrice": new BN("00", 16),
				"triggerCondition": {
					"above": {}
				},
				"triggered": false,
				"referrer": "11111111111111111111111111111111",
				"oraclePriceOffset": new BN("00", 16),
				"auctionStartPrice": new BN("00", 16),
				"auctionEndPrice": new BN("00", 16),
				"auctionDuration": 0,
				"padding": [
					0,
					0,
					0
				]
			},
			"makerUnsettledPnl": new BN("00", 16),
			"takerUnsettledPnl": new BN("00", 16),
			"action": {
				"place": {}
			},
			"actionExplanation": {
				"none": {}
			},
			"filler": "11111111111111111111111111111111",
			"fillRecordId": new BN("00", 16),
			"marketIndex": new BN("00", 16),
			"baseAssetAmountFilled": new BN("00", 16),
			"quoteAssetAmountFilled": new BN("00", 16),
			"makerRebate": new BN("00", 16),
			"takerFee": new BN("00", 16),
			"fillerReward": new BN("00", 16),
			"quoteAssetAmountSurplus": new BN("00", 16),
			"oraclePrice": new BN("5ff2b8f220", 16),
			"txSig": "vMoYxjBbPgwGB8dRyB4FCeYWrw8mxJiMVteZTYKWnQVUUBkvxwpshLgDLHhrNkQPE1BRw2krDxAGVyYwVjxRvPc",
			"eventType": "OrderRecord"
		}
		const fillOrder = {
			"ts": new BN("62e99f55", 16),
			"slot": 152323921,
			"taker": new PublicKey("DJwD8T2TKev7asmcvPyU9BUhTsjH5yZYEwoKDoHHcicu"),
			"maker": PublicKey.default,
			"takerOrder": {
				"status": {
					"filled": {}
				},
				"orderType": {
					"market": {}
				},
				"ts": new BN("62e99f4f", 16),
				"slot": new BN("09144743", 16),
				"orderId": new BN("112f", 16),
				"userOrderId": 0,
				"marketIndex": new BN("00", 16),
				"price": new BN("00", 16),
				"existingPositionDirection": {
					"long": {}
				},
				"baseAssetAmount": new BN("e221d1b380", 16),
				"baseAssetAmountFilled": new BN("e221d1b380", 16),
				"quoteAssetAmountFilled": new BN("3d19b4", 16),
				"fee": new BN("0fa4", 16),
				"direction": {
					"short": {}
				},
				"reduceOnly": false,
				"postOnly": false,
				"immediateOrCancel": false,
				"discountTier": {
					"none": {}
				},
				"triggerPrice": new BN("00", 16),
				"triggerCondition": {
					"above": {}
				},
				"triggered": false,
				"referrer": PublicKey.default,
				"oraclePriceOffset": new BN("00", 16),
				"auctionStartPrice": new BN("6016da4df1", 16),
				"auctionEndPrice": new BN("5ffb577ba2", 16),
				"auctionDuration": 10,
				"padding": [
					0,
					0,
					0
				]
			},
			"makerOrder": {
				"status": {
					"init": {}
				},
				"orderType": {
					"limit": {}
				},
				"ts": new BN("00", 16),
				"slot": new BN("00", 16),
				"orderId": new BN("00", 16),
				"userOrderId": 0,
				"marketIndex": new BN("00", 16),
				"price": new BN("00", 16),
				"existingPositionDirection": {
					"long": {}
				},
				"baseAssetAmount": new BN("00", 16),
				"baseAssetAmountFilled": new BN("00", 16),
				"quoteAssetAmountFilled": new BN("00", 16),
				"fee": new BN("00", 16),
				"direction": {
					"long": {}
				},
				"reduceOnly": false,
				"postOnly": false,
				"immediateOrCancel": false,
				"discountTier": {
					"none": {}
				},
				"triggerPrice": new BN("00", 16),
				"triggerCondition": {
					"above": {}
				},
				"triggered": false,
				"referrer": PublicKey.default,
				"oraclePriceOffset": new BN("00", 16),
				"auctionStartPrice": new BN("00", 16),
				"auctionEndPrice": new BN("00", 16),
				"auctionDuration": 0,
				"padding": [
					0,
					0,
					0
				]
			},
			"makerUnsettledPnl": new BN("00", 16),
			"takerUnsettledPnl": new BN("-2fcb75", 16),
			"action": {
				"fill": {}
			},
			"actionExplanation": {
				"none": {}
			},
			"filler": new PublicKey("AuecZ3S8dPwZVrXDCYB7sSTwRPYk2tF5bc2u82WPkMED"),
			"fillRecordId": new BN("068a", 16),
			"marketIndex": new BN("00", 16),
			"baseAssetAmountFilled": new BN("e221d1b380", 16),
			"quoteAssetAmountFilled": new BN("3d19b4", 16),
			"makerRebate": new BN("00", 16),
			"takerFee": new BN("0fa4", 16),
			"fillerReward": new BN("0190", 16),
			"quoteAssetAmountSurplus": new BN("07d3", 16),
			"oraclePrice": new BN("600a8fb2d0", 16),
			"txSig": "Jd8vmhH2iijVpN3SW5Tbj4d3mroHGKxWmWyMKTNqwkNuVwzjvWS3LFM4bptJsDG5PGYNCnmqEY4ETbS6oZE8nu7",
			"eventType": "OrderRecord"
		}
			
		dlob.applyOrderRecord(sellOrder as OrderRecord);

		let bidsCountBefore = 0;
		for await (const bid of dlob.getBids(new BN(0), new BN(0), 0)) {
			bidsCountBefore++;
		}
		let asksCountBefore = 0;
		for await (const ask of dlob.getAsks(new BN(0), new BN(0), 0)) {
			asksCountBefore++;
		}
		dlob.applyOrderRecord(fillOrder as OrderRecord);

		let bidsCountAfter = 0;
		for await (const bid of dlob.getBids(new BN(0), new BN(0), 0)) {
			bidsCountAfter++;
		}
		let asksCountAfter = 0;
		for await (const ask of dlob.getAsks(new BN(0), new BN(0), 0)) {
			asksCountAfter++;
		}

		assert(asksCountAfter === asksCountBefore - 1); // removed one order
		assert(bidsCountAfter === asksCountAfter); // no more orders
	});

	it('DLOB handle cancel', async () => {

		await clearingHouse.fetchAccounts();
		const markets = clearingHouse.getMarketAccount(0);

		const dlob = new DLOB(
			[markets],
			(o: Order, u: PublicKey) => {
				console.log(`DLOB update: ${u.toBase58()}-${o.orderId.toString()}`)
			},
			(o: Order, u: PublicKey) => {
				console.log(`DLOB remove: ${u.toBase58()}-${o.orderId.toString()}`)
			},
			(o: Order, u: PublicKey) => {
				console.log(`DLOB insert: ${u.toBase58()}-${o.orderId.toString()}`)
			},
			(o: Order, u: PublicKey) => {
				console.log(`DLOB trigger: ${u.toBase58()}-${o.orderId.toString()}`)
			}
		)

		const sellOrder = {
			"ts": new BN("62e99f4e", 16),
			"slot": new BN(152323904),
			"taker": new PublicKey("DJwD8T2TKev7asmcvPyU9BUhTsjH5yZYEwoKDoHHcicu"),
			"maker": PublicKey.default,
			"takerOrder": {
				"status": {
					"open": {}
				},
				"orderType": {
					"market": {}
				},
				"ts": new BN("62e99f4e", 16),
				"slot": new BN("09144740", 16),
				"orderId": new BN("112f", 16),
				"userOrderId": 0,
				"marketIndex": new BN("00", 16),
				"price": new BN("00", 16),
				"existingPositionDirection": {
					"long": {}
				},
				"baseAssetAmount": new BN("e221d1b380", 16),
				"baseAssetAmountFilled": new BN("00", 16),
				"quoteAssetAmountFilled": new BN("00", 16),
				"fee": new BN("00", 16),
				"direction": {
					"short": {}
				},
				"reduceOnly": false,
				"postOnly": false,
				"immediateOrCancel": false,
				"discountTier": {
					"none": {}
				},
				"triggerPrice": new BN("00", 16),
				"triggerCondition": {
					"above": {}
				},
				"triggered": false,
				"referrer": PublicKey.default,
				"oraclePriceOffset": new BN("00", 16),
				"auctionStartPrice": new BN("6001bd2896", 16),
				"auctionEndPrice": new BN("5fe64dd31d", 16),
				"auctionDuration": 10,
				"padding": [
					0,
					0,
					0
				]
			},
			"makerOrder": {
				"status": {
					"init": {}
				},
				"orderType": {
					"limit": {}
				},
				"ts": new BN("00", 16),
				"slot": new BN("00", 16),
				"orderId": new BN("00", 16),
				"userOrderId": 0,
				"marketIndex": new BN("00", 16),
				"price": new BN("00", 16),
				"existingPositionDirection": {
					"long": {}
				},
				"baseAssetAmount": new BN("00", 16),
				"baseAssetAmountFilled": new BN("00", 16),
				"quoteAssetAmountFilled": new BN("00", 16),
				"fee": new BN("00", 16),
				"direction": {
					"long": {}
				},
				"reduceOnly": false,
				"postOnly": false,
				"immediateOrCancel": false,
				"discountTier": {
					"none": {}
				},
				"triggerPrice": new BN("00", 16),
				"triggerCondition": {
					"above": {}
				},
				"triggered": false,
				"referrer": "11111111111111111111111111111111",
				"oraclePriceOffset": new BN("00", 16),
				"auctionStartPrice": new BN("00", 16),
				"auctionEndPrice": new BN("00", 16),
				"auctionDuration": 0,
				"padding": [
					0,
					0,
					0
				]
			},
			"makerUnsettledPnl": new BN("00", 16),
			"takerUnsettledPnl": new BN("00", 16),
			"action": {
				"place": {}
			},
			"actionExplanation": {
				"none": {}
			},
			"filler": "11111111111111111111111111111111",
			"fillRecordId": new BN("00", 16),
			"marketIndex": new BN("00", 16),
			"baseAssetAmountFilled": new BN("00", 16),
			"quoteAssetAmountFilled": new BN("00", 16),
			"makerRebate": new BN("00", 16),
			"takerFee": new BN("00", 16),
			"fillerReward": new BN("00", 16),
			"quoteAssetAmountSurplus": new BN("00", 16),
			"oraclePrice": new BN("5ff2b8f220", 16),
			"txSig": "vMoYxjBbPgwGB8dRyB4FCeYWrw8mxJiMVteZTYKWnQVUUBkvxwpshLgDLHhrNkQPE1BRw2krDxAGVyYwVjxRvPc",
			"eventType": "OrderRecord"
		}
		const cancelOrder = {
			"ts": new BN("62e99f55", 16),
			"slot": 152323921,
			"taker": new PublicKey("DJwD8T2TKev7asmcvPyU9BUhTsjH5yZYEwoKDoHHcicu"),
			"maker": PublicKey.default,
			"takerOrder": {
				"status": {
					"canceled": {}
				},
				"orderType": {
					"market": {}
				},
				"ts": new BN("62e99f4f", 16),
				"slot": new BN("09144743", 16),
				"orderId": new BN("112f", 16),
				"userOrderId": 0,
				"marketIndex": new BN("00", 16),
				"price": new BN("00", 16),
				"existingPositionDirection": {
					"long": {}
				},
				"baseAssetAmount": new BN("e221d1b380", 16),
				"baseAssetAmountFilled": new BN("e221d1b380", 16),
				"quoteAssetAmountFilled": new BN("3d19b4", 16),
				"fee": new BN("0fa4", 16),
				"direction": {
					"short": {}
				},
				"reduceOnly": false,
				"postOnly": false,
				"immediateOrCancel": false,
				"discountTier": {
					"none": {}
				},
				"triggerPrice": new BN("00", 16),
				"triggerCondition": {
					"above": {}
				},
				"triggered": false,
				"referrer": PublicKey.default,
				"oraclePriceOffset": new BN("00", 16),
				"auctionStartPrice": new BN("6016da4df1", 16),
				"auctionEndPrice": new BN("5ffb577ba2", 16),
				"auctionDuration": 10,
				"padding": [
					0,
					0,
					0
				]
			},
			"makerOrder": {
				"status": {
					"init": {}
				},
				"orderType": {
					"limit": {}
				},
				"ts": new BN("00", 16),
				"slot": new BN("00", 16),
				"orderId": new BN("00", 16),
				"userOrderId": 0,
				"marketIndex": new BN("00", 16),
				"price": new BN("00", 16),
				"existingPositionDirection": {
					"long": {}
				},
				"baseAssetAmount": new BN("00", 16),
				"baseAssetAmountFilled": new BN("00", 16),
				"quoteAssetAmountFilled": new BN("00", 16),
				"fee": new BN("00", 16),
				"direction": {
					"long": {}
				},
				"reduceOnly": false,
				"postOnly": false,
				"immediateOrCancel": false,
				"discountTier": {
					"none": {}
				},
				"triggerPrice": new BN("00", 16),
				"triggerCondition": {
					"above": {}
				},
				"triggered": false,
				"referrer": PublicKey.default,
				"oraclePriceOffset": new BN("00", 16),
				"auctionStartPrice": new BN("00", 16),
				"auctionEndPrice": new BN("00", 16),
				"auctionDuration": 0,
				"padding": [
					0,
					0,
					0
				]
			},
			"makerUnsettledPnl": new BN("00", 16),
			"takerUnsettledPnl": new BN("-2fcb75", 16),
			"action": {
				"cancel": {}
			},
			"actionExplanation": {
				"marketOrderAuctionExpired": {}
			},
			"filler": new PublicKey("AuecZ3S8dPwZVrXDCYB7sSTwRPYk2tF5bc2u82WPkMED"),
			"fillRecordId": new BN("00", 16),
			"marketIndex": new BN("00", 16),
			"baseAssetAmountFilled": new BN("00", 16),
			"quoteAssetAmountFilled": new BN("00", 16),
			"makerRebate": new BN("00", 16),
			"takerFee": new BN("00", 16),
			"fillerReward": new BN("2710", 16),
			"quoteAssetAmountSurplus": new BN("07d3", 16),
			"oraclePrice": new BN("600a8fb2d0", 16),
			"txSig": "Jd8vmhH2iijVpN3SW5Tbj4d3mroHGKxWmWyMKTNqwkNuVwzjvWS3LFM4bptJsDG5PGYNCnmqEY4ETbS6oZE8nu7",
			"eventType": "OrderRecord"
		}
			
		dlob.applyOrderRecord(sellOrder as OrderRecord);

		let bidsCountBefore = 0;
		for await (const bid of dlob.getBids(new BN(0), new BN(0), 0)) {
			bidsCountBefore++;
		}
		let asksCountBefore = 0;
		for await (const ask of dlob.getAsks(new BN(0), new BN(0), 0)) {
			asksCountBefore++;
		}
		dlob.applyOrderRecord(cancelOrder as OrderRecord);

		let bidsCountAfter = 0;
		for await (const bid of dlob.getBids(new BN(0), new BN(0), 0)) {
			bidsCountAfter++;
		}
		let asksCountAfter = 0;
		for await (const ask of dlob.getAsks(new BN(0), new BN(0), 0)) {
			asksCountAfter++;
		}

		assert(asksCountAfter === asksCountBefore - 1); // removed one order
		assert(bidsCountAfter === asksCountAfter); // no more orders
	});

	it('DLOB handle partial fill', async () => {

		await clearingHouse.fetchAccounts();
		const markets = clearingHouse.getMarketAccount(0);

		const dlob = new DLOB(
			[markets],
			(o: Order, u: PublicKey) => {
				console.log(`DLOB update: ${u.toBase58()}-${o.orderId.toString()}`)
			},
			(o: Order, u: PublicKey) => {
				console.log(`DLOB remove: ${u.toBase58()}-${o.orderId.toString()}`)
			},
			(o: Order, u: PublicKey) => {
				console.log(`DLOB insert: ${u.toBase58()}-${o.orderId.toString()}`)
			},
			(o: Order, u: PublicKey) => {
				console.log(`DLOB trigger: ${u.toBase58()}-${o.orderId.toString()}`)
			}
		)

		const sellOrder = {
			"ts": new BN("62e99f4e", 16),
			"slot": new BN(152323904),
			"taker": new PublicKey("DJwD8T2TKev7asmcvPyU9BUhTsjH5yZYEwoKDoHHcicu"),
			"maker": PublicKey.default,
			"takerOrder": {
				"status": {
					"open": {}
				},
				"orderType": {
					"market": {}
				},
				"ts": new BN("62e99f4e", 16),
				"slot": new BN("09144740", 16),
				"orderId": new BN("112f", 16),
				"userOrderId": 0,
				"marketIndex": new BN("00", 16),
				"price": new BN("00", 16),
				"existingPositionDirection": {
					"long": {}
				},
				"baseAssetAmount": new BN("e221d1b380", 16),
				"baseAssetAmountFilled": new BN("00", 16),
				"quoteAssetAmountFilled": new BN("00", 16),
				"fee": new BN("00", 16),
				"direction": {
					"short": {}
				},
				"reduceOnly": false,
				"postOnly": false,
				"immediateOrCancel": false,
				"discountTier": {
					"none": {}
				},
				"triggerPrice": new BN("00", 16),
				"triggerCondition": {
					"above": {}
				},
				"triggered": false,
				"referrer": PublicKey.default,
				"oraclePriceOffset": new BN("00", 16),
				"auctionStartPrice": new BN("6001bd2896", 16),
				"auctionEndPrice": new BN("5fe64dd31d", 16),
				"auctionDuration": 10,
				"padding": [
					0,
					0,
					0
				]
			},
			"makerOrder": {
				"status": {
					"init": {}
				},
				"orderType": {
					"limit": {}
				},
				"ts": new BN("00", 16),
				"slot": new BN("00", 16),
				"orderId": new BN("00", 16),
				"userOrderId": 0,
				"marketIndex": new BN("00", 16),
				"price": new BN("00", 16),
				"existingPositionDirection": {
					"long": {}
				},
				"baseAssetAmount": new BN("00", 16),
				"baseAssetAmountFilled": new BN("00", 16),
				"quoteAssetAmountFilled": new BN("00", 16),
				"fee": new BN("00", 16),
				"direction": {
					"long": {}
				},
				"reduceOnly": false,
				"postOnly": false,
				"immediateOrCancel": false,
				"discountTier": {
					"none": {}
				},
				"triggerPrice": new BN("00", 16),
				"triggerCondition": {
					"above": {}
				},
				"triggered": false,
				"referrer": "11111111111111111111111111111111",
				"oraclePriceOffset": new BN("00", 16),
				"auctionStartPrice": new BN("00", 16),
				"auctionEndPrice": new BN("00", 16),
				"auctionDuration": 0,
				"padding": [
					0,
					0,
					0
				]
			},
			"makerUnsettledPnl": new BN("00", 16),
			"takerUnsettledPnl": new BN("00", 16),
			"action": {
				"place": {}
			},
			"actionExplanation": {
				"none": {}
			},
			"filler": "11111111111111111111111111111111",
			"fillRecordId": new BN("00", 16),
			"marketIndex": new BN("00", 16),
			"baseAssetAmountFilled": new BN("00", 16),
			"quoteAssetAmountFilled": new BN("00", 16),
			"makerRebate": new BN("00", 16),
			"takerFee": new BN("00", 16),
			"fillerReward": new BN("00", 16),
			"quoteAssetAmountSurplus": new BN("00", 16),
			"oraclePrice": new BN("5ff2b8f220", 16),
			"txSig": "vMoYxjBbPgwGB8dRyB4FCeYWrw8mxJiMVteZTYKWnQVUUBkvxwpshLgDLHhrNkQPE1BRw2krDxAGVyYwVjxRvPc",
			"eventType": "OrderRecord"
		}
		const partialFillOrder = {
			"ts": new BN("62e99f55", 16),
			"slot": 152323921,
			"taker": new PublicKey("DJwD8T2TKev7asmcvPyU9BUhTsjH5yZYEwoKDoHHcicu"),
			"maker": PublicKey.default,
			"takerOrder": {
				"status": {
					"open": {}
				},
				"orderType": {
					"market": {}
				},
				"ts": new BN("62e99f4f", 16),
				"slot": new BN("09144743", 16),
				"orderId": new BN("112f", 16),
				"userOrderId": 0,
				"marketIndex": new BN("00", 16),
				"price": new BN("00", 16),
				"existingPositionDirection": {
					"long": {}
				},
				"baseAssetAmount": new BN("e221d1b380", 16),
				"baseAssetAmountFilled": new BN("26be3680", 16),
				"quoteAssetAmountFilled": new BN("16dc40", 16),
				"fee": new BN("0fa4", 16),
				"direction": {
					"short": {}
				},
				"reduceOnly": false,
				"postOnly": false,
				"immediateOrCancel": false,
				"discountTier": {
					"none": {}
				},
				"triggerPrice": new BN("00", 16),
				"triggerCondition": {
					"above": {}
				},
				"triggered": false,
				"referrer": PublicKey.default,
				"oraclePriceOffset": new BN("00", 16),
				"auctionStartPrice": new BN("6016da4df1", 16),
				"auctionEndPrice": new BN("5ffb577ba2", 16),
				"auctionDuration": 10,
				"padding": [
					0,
					0,
					0
				]
			},
			"makerOrder": {
				"status": {
					"filled": {}
				},
				"orderType": {
					"limit": {}
				},
				"ts": new BN("62e9937b", 16),
				"slot": new BN("09142815", 16),
				"orderId": new BN("0b8f", 16),
				"userOrderId": 0,
				"marketIndex": new BN("00", 16),
				"price": new BN("00", 16),
				"existingPositionDirection": {
					"long": {}
				},
				"baseAssetAmount": new BN("26be3680", 16),
				"baseAssetAmountFilled": new BN("26be3680", 16),
				"quoteAssetAmountFilled": new BN("16dc40", 16),
				"fee": new BN("00", 16),
				"direction": {
					"long": {}
				},
				"reduceOnly": false,
				"postOnly": false,
				"immediateOrCancel": false,
				"discountTier": {
					"none": {}
				},
				"triggerPrice": new BN("00", 16),
				"triggerCondition": {
					"above": {}
				},
				"triggered": false,
				"referrer": PublicKey.default,
				"oraclePriceOffset": new BN("00", 16),
				"auctionStartPrice": new BN("00", 16),
				"auctionEndPrice": new BN("00", 16),
				"auctionDuration": 0,
				"padding": [
					0,
					0,
					0
				]
			},
			"makerUnsettledPnl": new BN("0382", 16),
			"takerUnsettledPnl": new BN("-2fcb75", 16),
			"action": {
				"fill": {}
			},
			"actionExplanation": {
				"none": {}
			},
			"filler": new PublicKey("AuecZ3S8dPwZVrXDCYB7sSTwRPYk2tF5bc2u82WPkMED"),
			"fillRecordId": new BN("05ef", 16),
			"marketIndex": new BN("00", 16),
			"baseAssetAmountFilled": new BN("26be3680", 16),
			"quoteAssetAmountFilled": new BN("16dc40", 16),
			"makerRebate": new BN("0382", 16),
			"takerFee": new BN("05da", 16),
			"fillerReward": new BN("2710", 16),
			"quoteAssetAmountSurplus": new BN("00", 16),
			"oraclePrice": new BN("600a8fb2d0", 16),
			"txSig": "Jd8vmhH2iijVpN3SW5Tbj4d3mroHGKxWmWyMKTNqwkNuVwzjvWS3LFM4bptJsDG5PGYNCnmqEY4ETbS6oZE8nu7",
			"eventType": "OrderRecord"
		}
			
		dlob.applyOrderRecord(sellOrder as OrderRecord);

		let bidsCountBefore = 0;
		for await (const bid of dlob.getBids(new BN(0), new BN(0), 0)) {
			bidsCountBefore++;
		}
		let asksCountBefore = 0;
		for await (const ask of dlob.getAsks(new BN(0), new BN(0), 0)) {
			asksCountBefore++;
		}
		dlob.applyOrderRecord(partialFillOrder as OrderRecord);

		let bidsCountAfter = 0;
		for await (const bid of dlob.getBids(new BN(0), new BN(0), 0)) {
			bidsCountAfter++;
		}
		let asksCountAfter = 0;
		for await (const ask of dlob.getAsks(new BN(0), new BN(0), 0)) {
			asksCountAfter++;
		}

		assert(asksCountAfter === asksCountBefore); // no new records
	});
});