import {
	MarketType,
	Order,
	OrderStatus,
	OrderTriggerCondition,
	OrderType,
	PerpPosition,
	PositionDirection,
	SpotBalanceType,
	SpotPosition,
	UserAccount,
} from '../types';
import { PublicKey } from '@solana/web3.js';
import { BN, MarginMode } from '../';
import { ZERO } from '../';

function readUnsignedBigInt64LE(buffer: Buffer, offset: number): BN {
	return new BN(buffer.subarray(offset, offset + 8), 10, 'le');
}

function readSignedBigInt64LE(buffer: Buffer, offset: number): BN {
	const unsignedValue = new BN(buffer.subarray(offset, offset + 8), 10, 'le');
	if (unsignedValue.testn(63)) {
		const inverted = unsignedValue.notn(64).addn(1);
		return inverted.neg();
	} else {
		return unsignedValue;
	}
}

export function decodeUser(buffer: Buffer): UserAccount {
	let offset = 8;
	const authority = new PublicKey(buffer.slice(offset, offset + 32));
	offset += 32;
	const delegate = new PublicKey(buffer.slice(offset, offset + 32));
	offset += 32;
	const name = [];
	for (let i = 0; i < 32; i++) {
		name.push(buffer.readUint8(offset + i));
	}
	offset += 32;

	const spotPositions: SpotPosition[] = [];
	for (let i = 0; i < 8; i++) {
		const scaledBalance = readUnsignedBigInt64LE(buffer, offset);
		const openOrders = buffer.readUInt8(offset + 35);
		if (scaledBalance.eq(ZERO) && openOrders === 0) {
			offset += 40;
			continue;
		}

		offset += 8;
		const openBids = readSignedBigInt64LE(buffer, offset);
		offset += 8;
		const openAsks = readSignedBigInt64LE(buffer, offset);
		offset += 8;
		const cumulativeDeposits = readSignedBigInt64LE(buffer, offset);
		offset += 8;
		const marketIndex = buffer.readUInt16LE(offset);
		offset += 2;
		const balanceTypeNum = buffer.readUInt8(offset);
		let balanceType: SpotBalanceType;
		if (balanceTypeNum === 0) {
			balanceType = SpotBalanceType.DEPOSIT;
		} else {
			balanceType = SpotBalanceType.BORROW;
		}
		offset += 6;
		spotPositions.push({
			scaledBalance,
			openBids,
			openAsks,
			cumulativeDeposits,
			marketIndex,
			balanceType,
			openOrders,
		});
	}

	const perpPositions: PerpPosition[] = [];
	for (let i = 0; i < 8; i++) {
		const baseAssetAmount = readSignedBigInt64LE(buffer, offset + 8);
		const quoteAssetAmount = readSignedBigInt64LE(buffer, offset + 16);
		const lpShares = readUnsignedBigInt64LE(buffer, offset + 64);
		const openOrders = buffer.readUInt8(offset + 94);

		if (
			baseAssetAmount.eq(ZERO) &&
			openOrders === 0 &&
			quoteAssetAmount.eq(ZERO) &&
			lpShares.eq(ZERO)
		) {
			offset += 96;
			continue;
		}

		const lastCumulativeFundingRate = readSignedBigInt64LE(buffer, offset);
		offset += 24;
		const quoteBreakEvenAmount = readSignedBigInt64LE(buffer, offset);
		offset += 8;
		const quoteEntryAmount = readSignedBigInt64LE(buffer, offset);
		offset += 8;
		const openBids = readSignedBigInt64LE(buffer, offset);
		offset += 8;
		const openAsks = readSignedBigInt64LE(buffer, offset);
		offset += 8;
		const settledPnl = readSignedBigInt64LE(buffer, offset);
		offset += 16;
		const lastBaseAssetAmountPerLp = readSignedBigInt64LE(buffer, offset);
		offset += 8;
		const lastQuoteAssetAmountPerLp = readSignedBigInt64LE(buffer, offset);
		offset += 8;
		const remainderBaseAssetAmount = buffer.readInt32LE(offset);
		offset += 4;
		const marketIndex = buffer.readUInt16LE(offset);
		offset += 3;
		const perLpBase = buffer.readUInt8(offset);
		offset += 1;

		perpPositions.push({
			lastCumulativeFundingRate,
			baseAssetAmount,
			quoteAssetAmount,
			quoteBreakEvenAmount,
			quoteEntryAmount,
			openBids,
			openAsks,
			settledPnl,
			lpShares,
			lastBaseAssetAmountPerLp,
			lastQuoteAssetAmountPerLp,
			remainderBaseAssetAmount,
			marketIndex,
			openOrders,
			perLpBase,
		});
	}

	const orders: Order[] = [];
	for (let i = 0; i < 32; i++) {
		// skip order if it's not open
		if (buffer.readUint8(offset + 82) === 0) {
			offset += 96;
			continue;
		}

		const slot = readUnsignedBigInt64LE(buffer, offset);
		offset += 8;
		const price = readUnsignedBigInt64LE(buffer, offset);
		offset += 8;
		const baseAssetAmount = readUnsignedBigInt64LE(buffer, offset);
		offset += 8;
		const baseAssetAmountFilled = readUnsignedBigInt64LE(buffer, offset);
		offset += 8;
		const quoteAssetAmountFilled = readUnsignedBigInt64LE(buffer, offset);
		offset += 8;
		const triggerPrice = readUnsignedBigInt64LE(buffer, offset);
		offset += 8;
		const auctionStartPrice = readSignedBigInt64LE(buffer, offset);
		offset += 8;
		const auctionEndPrice = readSignedBigInt64LE(buffer, offset);
		offset += 8;
		const maxTs = readSignedBigInt64LE(buffer, offset);
		offset += 8;
		const oraclePriceOffset = buffer.readInt32LE(offset);
		offset += 4;
		const orderId = buffer.readUInt32LE(offset);
		offset += 4;
		const marketIndex = buffer.readUInt16LE(offset);
		offset += 2;
		const orderStatusNum = buffer.readUInt8(offset);

		let status: OrderStatus;
		if (orderStatusNum === 0) {
			status = OrderStatus.INIT;
		} else if (orderStatusNum === 1) {
			status = OrderStatus.OPEN;
		}
		offset += 1;
		const orderTypeNum = buffer.readUInt8(offset);
		let orderType: OrderType;
		if (orderTypeNum === 0) {
			orderType = OrderType.MARKET;
		} else if (orderTypeNum === 1) {
			orderType = OrderType.LIMIT;
		} else if (orderTypeNum === 2) {
			orderType = OrderType.TRIGGER_MARKET;
		} else if (orderTypeNum === 3) {
			orderType = OrderType.TRIGGER_LIMIT;
		} else if (orderTypeNum === 4) {
			orderType = OrderType.ORACLE;
		}
		offset += 1;
		const marketTypeNum = buffer.readUInt8(offset);
		let marketType: MarketType;
		if (marketTypeNum === 0) {
			marketType = MarketType.SPOT;
		} else {
			marketType = MarketType.PERP;
		}
		offset += 1;
		const userOrderId = buffer.readUint8(offset);
		offset += 1;
		const existingPositionDirectionNum = buffer.readUInt8(offset);
		let existingPositionDirection: PositionDirection;
		if (existingPositionDirectionNum === 0) {
			existingPositionDirection = PositionDirection.LONG;
		} else {
			existingPositionDirection = PositionDirection.SHORT;
		}
		offset += 1;
		const positionDirectionNum = buffer.readUInt8(offset);
		let direction: PositionDirection;
		if (positionDirectionNum === 0) {
			direction = PositionDirection.LONG;
		} else {
			direction = PositionDirection.SHORT;
		}
		offset += 1;
		const reduceOnly = buffer.readUInt8(offset) === 1;
		offset += 1;
		const postOnly = buffer.readUInt8(offset) === 1;
		offset += 1;
		const immediateOrCancel = buffer.readUInt8(offset) === 1;
		offset += 1;
		const triggerConditionNum = buffer.readUInt8(offset);
		let triggerCondition: OrderTriggerCondition;
		if (triggerConditionNum === 0) {
			triggerCondition = OrderTriggerCondition.ABOVE;
		} else if (triggerConditionNum === 1) {
			triggerCondition = OrderTriggerCondition.BELOW;
		} else if (triggerConditionNum === 2) {
			triggerCondition = OrderTriggerCondition.TRIGGERED_ABOVE;
		} else if (triggerConditionNum === 3) {
			triggerCondition = OrderTriggerCondition.TRIGGERED_BELOW;
		}
		offset += 1;
		const auctionDuration = buffer.readUInt8(offset);
		offset += 1;
		const postedSlotTail = buffer.readUint8(offset);
		offset += 1;
		offset += 2; // padding
		orders.push({
			slot,
			price,
			baseAssetAmount,
			quoteAssetAmount: undefined,
			baseAssetAmountFilled,
			quoteAssetAmountFilled,
			triggerPrice,
			auctionStartPrice,
			auctionEndPrice,
			maxTs,
			oraclePriceOffset,
			orderId,
			marketIndex,
			status,
			orderType,
			marketType,
			userOrderId,
			existingPositionDirection,
			direction,
			reduceOnly,
			postOnly,
			immediateOrCancel,
			triggerCondition,
			auctionDuration,
			postedSlotTail,
		});
	}

	const lastAddPerpLpSharesTs = readSignedBigInt64LE(buffer, offset);
	offset += 8;

	const totalDeposits = readUnsignedBigInt64LE(buffer, offset);
	offset += 8;

	const totalWithdraws = readUnsignedBigInt64LE(buffer, offset);
	offset += 8;

	const totalSocialLoss = readUnsignedBigInt64LE(buffer, offset);
	offset += 8;

	const settledPerpPnl = readSignedBigInt64LE(buffer, offset);
	offset += 8;

	const cumulativeSpotFees = readSignedBigInt64LE(buffer, offset);
	offset += 8;

	const cumulativePerpFunding = readSignedBigInt64LE(buffer, offset);
	offset += 8;

	const liquidationMarginFreed = readUnsignedBigInt64LE(buffer, offset);
	offset += 8;

	const lastActiveSlot = readUnsignedBigInt64LE(buffer, offset);
	offset += 8;

	const nextOrderId = buffer.readUInt32LE(offset);
	offset += 4;

	const maxMarginRatio = buffer.readUInt32LE(offset);
	offset += 4;

	const nextLiquidationId = buffer.readUInt16LE(offset);
	offset += 2;

	const subAccountId = buffer.readUInt16LE(offset);
	offset += 2;

	const status = buffer.readUInt8(offset);
	offset += 1;

	const isMarginTradingEnabled = buffer.readUInt8(offset) === 1;
	offset += 1;

	const idle = buffer.readUInt8(offset) === 1;
	offset += 1;

	const openOrders = buffer.readUInt8(offset);
	offset += 1;

	const hasOpenOrder = buffer.readUInt8(offset) === 1;
	offset += 1;

	const openAuctions = buffer.readUInt8(offset);
	offset += 1;

	const hasOpenAuction = buffer.readUInt8(offset) === 1;
	offset += 1;

	let marginMode: MarginMode;
	const marginModeNum = buffer.readUInt8(offset);
	if (marginModeNum === 0) {
		marginMode = MarginMode.DEFAULT;
	} else {
		marginMode = MarginMode.HIGH_LEVERAGE;
	}
	offset += 1;

	// @ts-ignore
	return {
		authority,
		delegate,
		name,
		spotPositions,
		perpPositions,
		orders,
		lastAddPerpLpSharesTs,
		totalDeposits,
		totalWithdraws,
		totalSocialLoss,
		settledPerpPnl,
		cumulativeSpotFees,
		cumulativePerpFunding,
		liquidationMarginFreed,
		lastActiveSlot,
		nextOrderId,
		maxMarginRatio,
		nextLiquidationId,
		subAccountId,
		status,
		isMarginTradingEnabled,
		idle,
		openOrders,
		hasOpenOrder,
		openAuctions,
		hasOpenAuction,
		marginMode,
	};
}
