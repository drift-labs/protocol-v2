import {
	AnchorProvider,
	Idl,
	Program,
} from '@coral-xyz/anchor';
import driftIDL from '../../src/idl/drift.json';
import {Connection, Keypair} from "@solana/web3.js";
import {Wallet} from "../../src";
import {
	DRIFT_PROGRAM_ID,
	isSpotPositionAvailable, isVariant,
	Order,
	PerpPosition,
	positionIsAvailable,
	SpotPosition
} from "../../lib";
import {decodeUser} from "../../lib/decode";
import { assert } from 'chai';

describe('Custom user decode', () => {
	it('test', async () => {
		const connection = new Connection('http://localhost:8899');
		const wallet = new Wallet(new Keypair());
		// @ts-ignore
		const provider = new AnchorProvider(connection, wallet);
		const program = new Program(driftIDL as Idl, DRIFT_PROGRAM_ID, provider);


		const userAccountBufferStrings = [
			'n3Vf4++XOuwIrD1jL22rz6RZlEfmZHqxneDBS0Mflxjd93h2f2ldQwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAU3ViYWNjb3VudCAxOCAgICAgICAgICAgICAgICAgICAT2BGXAgAAAAAAAAAAAAAAAAAAAAAAAACnDsQAAAAAAAAAAAAAAAAADJI7AQAAAAAAAAAAAAAAAAAAAAAAAAAAKJ87AQAAAAAGAAAAAAAAAAAAAAAAAAAAgJaYAAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAQAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD+/////////wEAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIfeAhgBAAAAAEbDIwAAAACs37f9/////+hYuf3/////7O25/f////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHT69///////AChr7gAAAACkMI7//////6Qwjv//////wE2O//////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADV27A0AAAAAQA0DAAAAAACAlpgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABnAAAABwABAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAhjLkAAAAAADgjREAAAAAAAAAAAAAAAAA5Tro//////8AAAAAAAAAACT2////////AAAAAAAAAADWUvwNAAAAAHMAAAAAAAAAAQARAAABAAEBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
		];

		for (const [i, userAccountBufferString] of userAccountBufferStrings.entries()) {
			const userAccountBuffer = Buffer.from(userAccountBufferString, 'base64');
			testUserAccountDecode(program, userAccountBuffer, i);
		}
	});
});

function testUserAccountDecode(program: Program, buffer: Buffer, i: number) {
	console.log(`Testing user account decode ${i}`);

	const anchorUserAccount = program.coder.accounts.decode('User', buffer);
	const customUserAccount = decodeUser(buffer);

	assert(anchorUserAccount.authority.equals(customUserAccount.authority));
	assert(anchorUserAccount.delegate.equals(customUserAccount.delegate));
	assert(arraysAreEqual(anchorUserAccount.name, customUserAccount.name));
	for (const anchorSpotPosition of getSpotPositions(anchorUserAccount.spotPositions)) {
		for (const customSpotPosition of getSpotPositions(customUserAccount.spotPositions)) {
			testSpotPosition(anchorSpotPosition, customSpotPosition);
		}
	}
	for (const anchorPerpPosition of getPerpPositions(anchorUserAccount.perpPositions)) {
		for (const customPerpPosition of getPerpPositions(customUserAccount.perpPositions)) {
			testPerpPosition(anchorPerpPosition, customPerpPosition);
		}
	}
	for (const anchorOrders of getOrders(anchorUserAccount.orders)) {
		for (const customOrder of getOrders(customUserAccount.orders)) {
			testOrder(anchorOrders, customOrder);
		}
	}
	assert(anchorUserAccount.lastAddPerpLpSharesTs.eq(customUserAccount.lastAddPerpLpSharesTs));
	assert(anchorUserAccount.totalDeposits.eq(customUserAccount.totalDeposits));
	assert(anchorUserAccount.totalWithdraws.eq(customUserAccount.totalWithdraws));
	assert(anchorUserAccount.totalSocialLoss.eq(customUserAccount.totalSocialLoss));
	assert(anchorUserAccount.settledPerpPnl.eq(customUserAccount.settledPerpPnl));
	assert(anchorUserAccount.cumulativeSpotFees.eq(customUserAccount.cumulativeSpotFees));
	assert(anchorUserAccount.cumulativePerpFunding.eq(customUserAccount.cumulativePerpFunding));
	assert(anchorUserAccount.liquidationMarginFreed.eq(customUserAccount.liquidationMarginFreed));
	assert(anchorUserAccount.lastActiveSlot.eq(customUserAccount.lastActiveSlot));
	assert(anchorUserAccount.subAccountId === customUserAccount.subAccountId);
	assert(anchorUserAccount.status === customUserAccount.status);
	assert(anchorUserAccount.nextLiquidationId === customUserAccount.nextLiquidationId);
	assert(anchorUserAccount.nextOrderId === customUserAccount.nextOrderId);
	assert(anchorUserAccount.maxMarginRatio === customUserAccount.maxMarginRatio);
	assert(anchorUserAccount.isMarginTradingEnabled === customUserAccount.isMarginTradingEnabled);
	assert(anchorUserAccount.idle === customUserAccount.idle);
	assert(anchorUserAccount.openOrders === customUserAccount.openOrders);
	assert(anchorUserAccount.hasOpenOrder === customUserAccount.hasOpenOrder);
	assert(anchorUserAccount.openAuctions === customUserAccount.openAuctions);
	assert(anchorUserAccount.hasOpenAuction === customUserAccount.hasOpenAuction);
}

function* getSpotPositions(spotPositions: SpotPosition[]) {
	for (const spotPosition of spotPositions) {
		if (isSpotPositionAvailable(spotPosition)) {
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
		if (positionIsAvailable(perpPosition)) {
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
	assert(enumsAreEqual(anchor.existingPositionDirection, custom.existingPositionDirection));
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