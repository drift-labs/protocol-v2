import {
	MarketData,
	marketHeaderBeet,
	OrderId,
	RestingOrder,
	TraderState,
	getUiOrderSequenceNumber,
	sign,
	toNum,
	toBN,
} from '@ellipsis-labs/phoenix-sdk';
import * as beet from '@metaplex-foundation/beet';

export const orderIdBeet = new beet.BeetArgsStruct<OrderId>(
	[
		['priceInTicks', beet.u64],
		['orderSequenceNumber', beet.u64],
	],
	'fIFOOrderId'
);

export const restingOrderBeet = new beet.BeetArgsStruct<RestingOrder>(
	[
		['traderIndex', beet.u64],
		['numBaseLots', beet.u64],
		['lastValidSlot', beet.u64],
		['lastValidUnixTimestampInSeconds', beet.u64],
	],
	'fIFORestingOrder'
);

function deserializeRedBlackTree<Key, Value>(
	data: Buffer,
	keyDeserializer: beet.BeetArgsStruct<Key>,
	valueDeserializer: beet.BeetArgsStruct<Value>
): Map<Key, Value> {
	const tree = new Map<Key, Value>();
	const treeNodes = deserializeRedBlackTreeNodes(
		data,
		keyDeserializer,
		valueDeserializer
	);

	const nodes = treeNodes[0];
	const freeNodes = treeNodes[1];

	for (const [index, [key, value]] of nodes.entries()) {
		if (!freeNodes.has(index)) {
			tree.set(key, value);
		}
	}

	return tree;
}

function deserializeRedBlackTreeNodes<Key, Value>(
	data: Buffer,
	keyDeserializer: beet.BeetArgsStruct<Key>,
	valueDeserializer: beet.BeetArgsStruct<Value>
): [Array<[Key, Value]>, Set<number>] {
	let offset = 0;
	const keySize = keyDeserializer.byteSize;
	const valueSize = valueDeserializer.byteSize;

	const nodes = new Array<[Key, Value]>();

	// Skip RBTree header
	offset += 16;

	// Skip node allocator size
	offset += 8;
	const bumpIndex = data.readInt32LE(offset);
	offset += 4;
	let freeListHead = data.readInt32LE(offset);
	offset += 4;

	const freeListPointers = new Array<[number, number]>();

	for (let index = 0; offset < data.length && index < bumpIndex - 1; index++) {
		const registers = new Array<number>();
		for (let i = 0; i < 4; i++) {
			registers.push(data.readInt32LE(offset)); // skip padding
			offset += 4;
		}
		const [key] = keyDeserializer.deserialize(
			data.subarray(offset, offset + keySize)
		);
		offset += keySize;
		const [value] = valueDeserializer.deserialize(
			data.subarray(offset, offset + valueSize)
		);
		offset += valueSize;
		nodes.push([key, value]);
		freeListPointers.push([index, registers[0]]);
	}
	const freeNodes = new Set<number>();
	let indexToRemove = freeListHead - 1;

	let counter = 0;
	// If there's an infinite loop here, that means that the state is corrupted
	while (freeListHead < bumpIndex) {
		// We need to subtract 1 because the node allocator is 1-indexed
		const next = freeListPointers[freeListHead - 1];
		[indexToRemove, freeListHead] = next;
		freeNodes.add(indexToRemove);
		counter += 1;
		if (counter > bumpIndex) {
			throw new Error('Infinite loop detected');
		}
	}

	return [nodes, freeNodes];
}

export const fastDecode = (buffer: Buffer): MarketData => {
	let offset = marketHeaderBeet.byteSize;
	const [header] = marketHeaderBeet.deserialize(buffer.subarray(0, offset));

	const paddingLen = 8 * 32;
	let remaining = buffer.subarray(offset + paddingLen);
	offset = 0;
	const baseLotsPerBaseUnit = Number(remaining.readBigUInt64LE(offset));
	offset += 8;
	const quoteLotsPerBaseUnitPerTick = Number(remaining.readBigUInt64LE(offset));
	offset += 8;
	const sequenceNumber = Number(remaining.readBigUInt64LE(offset));
	offset += 8;
	const takerFeeBps = Number(remaining.readBigUInt64LE(offset));
	offset += 8;
	const collectedQuoteLotFees = Number(remaining.readBigUInt64LE(offset));
	offset += 8;
	const unclaimedQuoteLotFees = Number(remaining.readBigUInt64LE(offset));
	offset += 8;
	remaining = remaining.subarray(offset);

	const totalNumBids = toNum(header.marketSizeParams.bidsSize);
	const totalNumAsks = toNum(header.marketSizeParams.asksSize);

	const totalBidsSize =
		16 +
		16 +
		(16 + orderIdBeet.byteSize + restingOrderBeet.byteSize) * totalNumBids;
	const totalAsksSize =
		16 +
		16 +
		(16 + orderIdBeet.byteSize + restingOrderBeet.byteSize) * totalNumAsks;

	offset = 0;

	const bidBuffer = remaining.subarray(offset, offset + totalBidsSize);
	offset += totalBidsSize;
	const askBuffer = remaining.subarray(offset, offset + totalAsksSize);

	const bidsUnsorted = deserializeRedBlackTree(
		bidBuffer,
		orderIdBeet,
		restingOrderBeet
	);
	const asksUnsorted = deserializeRedBlackTree(
		askBuffer,
		orderIdBeet,
		restingOrderBeet
	);

	const bids = [...bidsUnsorted].sort((a, b) => {
		const priceComparison = sign(
			toBN(b[0].priceInTicks).sub(toBN(a[0].priceInTicks))
		);
		if (priceComparison !== 0) {
			return priceComparison;
		}
		return sign(
			getUiOrderSequenceNumber(a[0]).sub(getUiOrderSequenceNumber(b[0]))
		);
	});

	const asks = [...asksUnsorted].sort((a, b) => {
		const priceComparison = sign(
			toBN(a[0].priceInTicks).sub(toBN(b[0].priceInTicks))
		);
		if (priceComparison !== 0) {
			return priceComparison;
		}
		return sign(
			getUiOrderSequenceNumber(a[0]).sub(getUiOrderSequenceNumber(b[0]))
		);
	});

	const traders = new Map<string, TraderState>();
	const traderPubkeyToTraderIndex = new Map<string, number>();
	const traderIndexToTraderPubkey = new Map<number, string>();

	return {
		header,
		baseLotsPerBaseUnit,
		quoteLotsPerBaseUnitPerTick,
		sequenceNumber,
		takerFeeBps,
		collectedQuoteLotFees,
		unclaimedQuoteLotFees,
		bids,
		asks,
		traders,
		traderPubkeyToTraderIndex,
		traderIndexToTraderPubkey,
	};
};
