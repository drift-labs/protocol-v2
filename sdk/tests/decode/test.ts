import { AnchorProvider, Idl, Program } from '@coral-xyz/anchor';
import driftIDL from '../../src/idl/drift.json';
import { Connection, Keypair } from '@solana/web3.js';
import {
	decodeUser,
	Wallet,
	DRIFT_PROGRAM_ID,
	isSpotPositionAvailable,
	isVariant,
	Order,
	PerpPosition,
	positionIsAvailable,
	SpotPosition,
} from '../../src';
import { assert } from 'chai';
import { userAccountBufferStrings } from './userAccountBufferStrings';
const sizeof = require('object-sizeof');

describe('Custom user decode', () => {
	it('test', async () => {
		const connection = new Connection('http://localhost:8899');
		const wallet = new Wallet(new Keypair());
		// @ts-ignore
		const provider = new AnchorProvider(connection, wallet);
		const program = new Program(driftIDL as Idl, DRIFT_PROGRAM_ID, provider);

		let totalAnchorSize = 0;
		let totalCustomSize = 0;
		let totalAnchorTime = 0;
		let totalCustomTime = 0;
		for (const [
			i,
			userAccountBufferString,
		] of userAccountBufferStrings.entries()) {
			const userAccountBuffer = Buffer.from(userAccountBufferString, 'base64');
			const [anchorSize, customSize, anchorTime, customTime] =
				testUserAccountDecode(program, userAccountBuffer, i);
			totalAnchorSize += anchorSize;
			totalCustomSize += customSize;
			totalAnchorTime += anchorTime;
			totalCustomTime += customTime;
		}

		console.log(`Total anchor size: ${totalAnchorSize}`);
		console.log(`Total custom size: ${totalCustomSize}`);
		console.log(`Total anchor time: ${totalAnchorTime}`);
		console.log(`Total custom size: ${totalCustomTime}`);
	});
});

function testUserAccountDecode(program: Program, buffer: Buffer, i: number) {
	console.log(`Testing user account decode ${i}`);

	const anchorStartTimestamp = Date.now();
	const anchorUserAccount = program.coder.accounts.decode('User', buffer);
	const anchorEndTimestamp = Date.now();
	const anchorTime = anchorEndTimestamp - anchorStartTimestamp;

	const customStartTimestamp = Date.now();
	const customUserAccount = decodeUser(buffer);
	const customEndTimestamp = Date.now();
	const customTime = customEndTimestamp - customStartTimestamp;

	const anchorSize = sizeof(anchorUserAccount);
	const customSize = sizeof(customUserAccount);

	assert(anchorUserAccount.authority.equals(customUserAccount.authority));
	assert(anchorUserAccount.delegate.equals(customUserAccount.delegate));
	assert(arraysAreEqual(anchorUserAccount.name, customUserAccount.name));

	const anchorSpotPositionGenerator = getSpotPositions(
		anchorUserAccount.spotPositions
	);
	const customSpotPositionGenerator = getSpotPositions(
		customUserAccount.spotPositions
	);
	for (const [anchorSpotPosition, customSpotPosition] of zipGenerator(
		anchorSpotPositionGenerator,
		customSpotPositionGenerator
	)) {
		testSpotPosition(anchorSpotPosition, customSpotPosition);
	}

	const anchorPerpPositionGenerator = getPerpPositions(
		anchorUserAccount.perpPositions
	);
	const customPerpPositionGenerator = getPerpPositions(
		customUserAccount.perpPositions
	);
	for (const [anchorPerpPosition, customPerpPosition] of zipGenerator(
		anchorPerpPositionGenerator,
		customPerpPositionGenerator
	)) {
		testPerpPosition(anchorPerpPosition, customPerpPosition);
	}

	const anchorOrderGenerator = getOrders(anchorUserAccount.orders);
	const customOrderGenerator = getOrders(customUserAccount.orders);
	for (const [anchorOrder, customOrder] of zipGenerator(
		anchorOrderGenerator,
		customOrderGenerator
	)) {
		testOrder(anchorOrder, customOrder);
	}

	assert(
		anchorUserAccount.lastAddPerpLpSharesTs.eq(
			customUserAccount.lastAddPerpLpSharesTs
		)
	);
	assert(anchorUserAccount.totalDeposits.eq(customUserAccount.totalDeposits));
	assert(anchorUserAccount.totalWithdraws.eq(customUserAccount.totalWithdraws));
	assert(
		anchorUserAccount.totalSocialLoss.eq(customUserAccount.totalSocialLoss)
	);
	assert(anchorUserAccount.settledPerpPnl.eq(customUserAccount.settledPerpPnl));
	assert(
		anchorUserAccount.cumulativeSpotFees.eq(
			customUserAccount.cumulativeSpotFees
		)
	);
	assert(
		anchorUserAccount.cumulativePerpFunding.eq(
			customUserAccount.cumulativePerpFunding
		)
	);
	assert(
		anchorUserAccount.liquidationMarginFreed.eq(
			customUserAccount.liquidationMarginFreed
		)
	);
	assert(anchorUserAccount.lastActiveSlot.eq(customUserAccount.lastActiveSlot));
	assert(anchorUserAccount.subAccountId === customUserAccount.subAccountId);
	assert(anchorUserAccount.status === customUserAccount.status);
	assert(
		anchorUserAccount.nextLiquidationId === customUserAccount.nextLiquidationId
	);
	assert(anchorUserAccount.nextOrderId === customUserAccount.nextOrderId);
	assert(anchorUserAccount.maxMarginRatio === customUserAccount.maxMarginRatio);
	assert(
		anchorUserAccount.isMarginTradingEnabled ===
			customUserAccount.isMarginTradingEnabled
	);
	assert(anchorUserAccount.idle === customUserAccount.idle);
	assert(anchorUserAccount.openOrders === customUserAccount.openOrders);
	assert(anchorUserAccount.hasOpenOrder === customUserAccount.hasOpenOrder);
	assert(anchorUserAccount.openAuctions === customUserAccount.openAuctions);
	assert(anchorUserAccount.hasOpenAuction === customUserAccount.hasOpenAuction);

	return [anchorSize, customSize, anchorTime, customTime];
}

function* getSpotPositions(spotPositions: SpotPosition[]) {
	for (const spotPosition of spotPositions) {
		if (!isSpotPositionAvailable(spotPosition)) {
			yield spotPosition;
		}
	}
}

function testSpotPosition(anchor: SpotPosition, custom: SpotPosition) {
	assert(anchor.marketIndex === custom.marketIndex);
	assert(enumsAreEqual(anchor.balanceType, custom.balanceType));
	assert(anchor.openOrders === custom.openOrders);
	assert(anchor.scaledBalance.eq(custom.scaledBalance));
	assert(anchor.openBids.eq(custom.openBids));
	assert(anchor.openAsks.eq(custom.openAsks));
	assert(anchor.cumulativeDeposits.eq(custom.cumulativeDeposits));
}

function* getPerpPositions(perpPositions: PerpPosition[]) {
	for (const perpPosition of perpPositions) {
		if (!positionIsAvailable(perpPosition)) {
			yield perpPosition;
		}
	}
}

function testPerpPosition(anchor: PerpPosition, custom: PerpPosition) {
	assert(anchor.baseAssetAmount.eq(custom.baseAssetAmount));
	assert(anchor.lastCumulativeFundingRate.eq(custom.lastCumulativeFundingRate));
	assert(anchor.marketIndex === custom.marketIndex);
	assert(anchor.quoteAssetAmount.eq(custom.quoteAssetAmount));
	assert(anchor.quoteEntryAmount.eq(custom.quoteEntryAmount));
	assert(anchor.quoteBreakEvenAmount.eq(custom.quoteBreakEvenAmount));
	assert(anchor.openBids.eq(custom.openBids));
	assert(anchor.openAsks.eq(custom.openAsks));
	assert(anchor.settledPnl.eq(custom.settledPnl));
	assert(anchor.lpShares.eq(custom.lpShares));
	assert(anchor.lastBaseAssetAmountPerLp.eq(custom.lastBaseAssetAmountPerLp));
	assert(anchor.lastQuoteAssetAmountPerLp.eq(custom.lastQuoteAssetAmountPerLp));
	assert(anchor.openOrders === custom.openOrders);
	assert(anchor.perLpBase === custom.perLpBase);
}

function* getOrders(orders: Order[]) {
	for (const order of orders) {
		if (isVariant(order.status, 'open')) {
			yield order;
		}
	}
}

function testOrder(anchor: Order, custom: Order) {
	assert(enumsAreEqual(anchor.status, custom.status));
	assert(enumsAreEqual(anchor.orderType, custom.orderType));
	assert(enumsAreEqual(anchor.marketType, custom.marketType));
	assert(anchor.slot.eq(custom.slot));
	assert(anchor.orderId === custom.orderId);
	assert(anchor.userOrderId === custom.userOrderId);
	assert(anchor.marketIndex === custom.marketIndex);
	assert(anchor.price.eq(custom.price));
	assert(anchor.baseAssetAmount.eq(custom.baseAssetAmount));
	assert(anchor.baseAssetAmountFilled.eq(custom.baseAssetAmountFilled));
	assert(anchor.quoteAssetAmountFilled.eq(custom.quoteAssetAmountFilled));
	assert(enumsAreEqual(anchor.direction, custom.direction));
	assert(anchor.reduceOnly === custom.reduceOnly);
	assert(anchor.triggerPrice.eq(custom.triggerPrice));
	assert(enumsAreEqual(anchor.triggerCondition, custom.triggerCondition));
	assert(
		enumsAreEqual(
			anchor.existingPositionDirection,
			custom.existingPositionDirection
		)
	);
	assert(anchor.postOnly === custom.postOnly);
	assert(anchor.immediateOrCancel === custom.immediateOrCancel);
	assert(anchor.oraclePriceOffset === custom.oraclePriceOffset);
	assert(anchor.auctionDuration === custom.auctionDuration);
	assert(anchor.auctionStartPrice.eq(custom.auctionStartPrice));
	assert(anchor.auctionEndPrice.eq(custom.auctionEndPrice));
	assert(anchor.maxTs.eq(custom.maxTs));
}

function enumsAreEqual(e1: any, e2: any) {
	return JSON.stringify(e1) === JSON.stringify(e2);
}

function arraysAreEqual(arr1, arr2) {
	if (arr1.length !== arr2.length) {
		return false;
	}

	for (let i = 0; i < arr1.length; i++) {
		if (arr1[i] !== arr2[i]) {
			return false;
		}
	}

	return true;
}

function* zipGenerator(gen1, gen2) {
	let iter1 = gen1.next();
	let iter2 = gen2.next();

	while (!iter1.done && !iter2.done) {
		yield [iter1.value, iter2.value];
		iter1 = gen1.next();
		iter2 = gen2.next();
	}

	if (iter1.done !== iter2.done) {
		throw new Error('Generators have different lengths');
	}
}
