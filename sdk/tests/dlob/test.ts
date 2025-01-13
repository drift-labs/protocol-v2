import { expect } from 'chai';
import { PublicKey, Keypair } from '@solana/web3.js';

import {
	getVariant,
	MarketType,
	DLOB,
	BN,
	BASE_PRECISION,
	PositionDirection,
	OrderStatus,
	OrderType,
	OrderTriggerCondition,
	PRICE_PRECISION,
	DLOBNode,
	OraclePriceData,
	NodeToFill,
	isOrderExpired,
	Order,
	isMarketOrder,
	isLimitOrder,
	ZERO,
	convertToNumber,
	QUOTE_PRECISION,
	//isVariant,
	uncrossL2,
	L2Level,
} from '../../src';

import { mockPerpMarkets, mockSpotMarkets, mockStateAccount } from './helpers';

// Returns true if asks are sorted ascending
const asksAreSortedAsc = (asks: L2Level[]) => {
	return asks.every((ask, i) => {
		if (i === 0) {
			return true;
		}
		return ask.price.gt(asks[i - 1].price);
	});
};

// Returns true if asks are sorted descending
const bidsAreSortedDesc = (bids: L2Level[]) => {
	return bids.every((bid, i) => {
		if (i === 0) {
			return true;
		}
		return bid.price.lt(bids[i - 1].price);
	});
};

function insertOrderToDLOB(
	dlob: DLOB,
	userAccount: PublicKey,
	orderType: OrderType,
	marketType: MarketType,
	orderId: number,
	marketIndex: number,
	price: BN,
	baseAssetAmount: BN,
	direction: PositionDirection,
	auctionStartPrice: BN,
	auctionEndPrice: BN,
	slot?: BN,
	maxTs = ZERO,
	oraclePriceOffset = new BN(0),
	postOnly = false,
	auctionDuration = 10
) {
	slot = slot || new BN(1);
	dlob.insertOrder(
		{
			status: OrderStatus.OPEN,
			orderType,
			marketType,
			slot,
			orderId,
			userOrderId: 0,
			marketIndex,
			price,
			baseAssetAmount,
			baseAssetAmountFilled: new BN(0),
			quoteAssetAmountFilled: new BN(0),
			quoteAssetAmount: new BN(0),
			direction,
			reduceOnly: false,
			triggerPrice: new BN(0),
			triggerCondition: OrderTriggerCondition.ABOVE,
			existingPositionDirection: PositionDirection.LONG,
			postOnly,
			immediateOrCancel: false,
			oraclePriceOffset: oraclePriceOffset.toNumber(),
			auctionDuration,
			auctionStartPrice,
			auctionEndPrice,
			maxTs,
		},
		userAccount.toString(),
		slot.toNumber(),
		false
	);
}

function insertTriggerOrderToDLOB(
	dlob: DLOB,
	userAccount: PublicKey,
	orderType: OrderType,
	marketType: MarketType,
	orderId: number,
	marketIndex: number,
	price: BN,
	baseAssetAmount: BN,
	direction: PositionDirection,
	triggerPrice: BN,
	triggerCondition: OrderTriggerCondition,
	auctionStartPrice: BN,
	auctionEndPrice: BN,
	slot?: BN,
	maxTs = ZERO,
	oraclePriceOffset = new BN(0)
) {
	slot = slot || new BN(1);
	dlob.insertOrder(
		{
			status: OrderStatus.OPEN,
			orderType,
			marketType,
			slot,
			orderId,
			userOrderId: 0,
			marketIndex,
			price,
			baseAssetAmount,
			baseAssetAmountFilled: new BN(0),
			quoteAssetAmountFilled: new BN(0),
			quoteAssetAmount: new BN(0),
			direction,
			reduceOnly: false,
			triggerPrice,
			triggerCondition,
			existingPositionDirection: PositionDirection.LONG,
			postOnly: false,
			immediateOrCancel: true,
			oraclePriceOffset: oraclePriceOffset.toNumber(),
			auctionDuration: 10,
			auctionStartPrice,
			auctionEndPrice,
			maxTs,
		},
		userAccount.toString(),
		slot.toNumber(),
		false
	);
}

function printOrderNode(
	node: DLOBNode,
	oracle: OraclePriceData | undefined,
	slot: number | undefined
) {
	console.log(
		` . vAMMNode? ${node.isVammNode()},\t${
			node.order ? getVariant(node.order?.orderType) : '~'
		} ${node.order ? getVariant(node.order?.direction) : '~'}\t, slot: ${
			node.order?.slot.toString() || '~'
		}, orderId: ${node.order?.orderId.toString() || '~'},\tnode.getPrice: ${
			oracle ? node.getPrice(oracle, slot!) : '~'
		}, node.price: ${node.order?.price.toString() || '~'}, priceOffset: ${
			node.order?.oraclePriceOffset.toString() || '~'
		} quantity: ${node.order?.baseAssetAmountFilled.toString() || '~'}/${
			node.order?.baseAssetAmount.toString() || '~'
		}`
	);
}

function printBookState(
	dlob: DLOB,
	marketIndex: number,
	vBid: BN | undefined,
	vAsk: BN | undefined,
	slot: number,
	oracle: OraclePriceData
) {
	const askNodes = dlob.getAsks(
		marketIndex,
		vAsk,
		slot,
		MarketType.PERP,
		oracle
	);
	let aa = 0;
	console.log(`Oracle price: ${oracle.price.toNumber()}`);
	console.log(`asks:`);
	for (const a of askNodes) {
		printOrderNode(a, oracle, slot);
		aa++;
	}
	console.log(`Total ask nodes: ${aa}`);

	const bidNodes = dlob.getBids(
		marketIndex,
		vBid,
		slot,
		MarketType.PERP,
		oracle
	);
	let bb = 0;
	console.log(`bids:`);
	for (const b of bidNodes) {
		printOrderNode(b, oracle, slot);
		bb++;
	}
	console.log(`Total bid nodes: ${bb}`);
}

function printCrossedNodes(n: NodeToFill, slot: number) {
	console.log(
		`Cross Found, takerExists: ${n.node.order !== undefined}, makerExists: ${
			n.makerNodes !== undefined
		}`
	);
	console.log(
		`node: (mkt: ${isMarketOrder(n.node.order!)}, lim: ${isLimitOrder(
			n.node.order!
		)})`
	);
	if (n.makerNodes) {
		for (const makerNode of n.makerNodes) {
			console.log(
				`makerNode: (mkt: ${isMarketOrder(
					makerNode.order!
				)}, lim: ${isLimitOrder(makerNode.order!)})`
			);
		}
	}

	const printOrder = (o: Order) => {
		console.log(
			`  orderId: ${o.orderId}, ${getVariant(o.orderType)}, ${getVariant(
				o.direction
			)},\texpired: ${isOrderExpired(o, slot)}, postOnly: ${
				o.postOnly
			}, reduceOnly: ${
				o.reduceOnly
			}, price: ${o.price.toString()}, priceOffset: ${o.oraclePriceOffset.toString()}, baseAmtFileld: ${o.baseAssetAmountFilled.toString()}/${o.baseAssetAmount.toString()}`
		);
	};

	if (n.node.order) {
		const t = n.node.order;
		console.log(`Taker Order:`);
		printOrder(t);
	}

	if (n.makerNodes.length === 0) {
		console.log(`  maker is vAMM node`);
	} else {
		for (const m of n.makerNodes) {
			console.log(`Maker Order:`);
			printOrder(m.order!);
		}
	}
}

describe('DLOB Tests', () => {
	it('Fresh DLOB is empty', () => {
		const dlob = new DLOB();
		const vAsk = new BN(11);
		const vBid = new BN(10);
		const slot = 12;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		// check perps
		for (const market of mockPerpMarkets) {
			let foundAsks = 0;
			for (const _ask of dlob.getAsks(
				market.marketIndex,
				vAsk,
				slot,
				MarketType.PERP,
				oracle
			)) {
				foundAsks++;
			}
			expect(foundAsks).to.equal(1);

			let foundBids = 0;
			for (const _bid of dlob.getBids(
				market.marketIndex,
				vBid,
				0,
				MarketType.PERP,
				oracle
			)) {
				foundBids++;
			}
			expect(foundBids).to.equal(1);
		}

		// check spots
		for (const market of mockSpotMarkets) {
			let foundAsks = 0;
			for (const _ask of dlob.getAsks(
				market.marketIndex,
				undefined,
				0,
				MarketType.SPOT,
				oracle
			)) {
				foundAsks++;
			}
			expect(foundAsks).to.equal(0);
			let foundBids = 0;
			for (const _bid of dlob.getBids(
				market.marketIndex,
				undefined,
				0,
				MarketType.SPOT,
				oracle
			)) {
				foundBids++;
			}
			expect(foundBids).to.equal(0);
		}
	});

	it('Can clear DLOB', () => {
		const vAsk = new BN(15);
		const vBid = new BN(10);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 12;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			0, // orderId
			marketIndex,
			new BN(9), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			1, // orderId
			marketIndex,
			new BN(8), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			new BN(8), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);

		const bids = dlob.getBids(
			marketIndex,
			undefined,
			slot,
			MarketType.PERP,
			oracle
		);
		let b = 0;
		for (const _bid of bids) {
			b++;
		}
		expect(b).to.equal(3);

		dlob.clear();

		const bids1 = dlob.getBids(
			marketIndex,
			undefined,
			0,
			MarketType.PERP,
			oracle
		);
		bids1.next();
		expect(bids1.next().done, 'bid generator should be done').to.equal(true);
	});

	it('DLOB update resting limit orders bids', () => {
		const vAsk = new BN(15);
		const vBid = new BN(10);

		let slot = 1;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;
		const marketType = MarketType.PERP;

		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			1, // orderId
			marketIndex,
			new BN(11), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(1)
		);
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			new BN(12), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(11)
		);
		insertOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			3, // orderId
			marketIndex,
			new BN(13), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(21)
		);

		let takingBids = Array.from(
			dlob.getTakingBids(marketIndex, marketType, slot, oracle)
		);

		expect(takingBids.length).to.equal(3);
		expect(takingBids[0].order!.orderId).to.equal(1);
		expect(takingBids[1].order!.orderId).to.equal(2);
		expect(takingBids[2].order!.orderId).to.equal(3);

		let restingBids = Array.from(
			dlob.getRestingLimitBids(marketIndex, slot, marketType, oracle)
		);

		expect(restingBids.length).to.equal(0);

		slot += 11;

		takingBids = Array.from(
			dlob.getTakingBids(marketIndex, marketType, slot, oracle)
		);

		expect(takingBids.length).to.equal(2);
		expect(takingBids[0].order!.orderId).to.equal(2);
		expect(takingBids[1].order!.orderId).to.equal(3);

		restingBids = Array.from(
			dlob.getRestingLimitBids(marketIndex, slot, marketType, oracle)
		);

		expect(restingBids.length).to.equal(1);
		expect(restingBids[0].order!.orderId).to.equal(1);

		slot += 11;

		takingBids = Array.from(
			dlob.getTakingBids(marketIndex, marketType, slot, oracle)
		);

		expect(takingBids.length).to.equal(1);
		expect(takingBids[0].order!.orderId).to.equal(3);

		restingBids = Array.from(
			dlob.getRestingLimitBids(marketIndex, slot, marketType, oracle)
		);

		expect(restingBids.length).to.equal(2);
		expect(restingBids[0].order!.orderId).to.equal(2);
		expect(restingBids[1].order!.orderId).to.equal(1);

		slot += 11;

		takingBids = Array.from(
			dlob.getTakingBids(marketIndex, marketType, slot, oracle)
		);

		expect(takingBids.length).to.equal(0);

		restingBids = Array.from(
			dlob.getRestingLimitBids(marketIndex, slot, marketType, oracle)
		);

		expect(restingBids.length).to.equal(3);
		expect(restingBids[0].order!.orderId).to.equal(3);
		expect(restingBids[1].order!.orderId).to.equal(2);
		expect(restingBids[2].order!.orderId).to.equal(1);
	});

	it('DLOB update resting limit orders asks', () => {
		const vAsk = new BN(15);
		const vBid = new BN(10);

		let slot = 1;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;
		const marketType = MarketType.PERP;

		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			1, // orderId
			marketIndex,
			new BN(13), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			new BN(1)
		);
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			new BN(12), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			new BN(11)
		);
		insertOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			3, // orderId
			marketIndex,
			new BN(11), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			new BN(21)
		);

		let takingBids = Array.from(
			dlob.getTakingAsks(marketIndex, marketType, slot, oracle)
		);

		expect(takingBids.length).to.equal(3);
		expect(takingBids[0].order!.orderId).to.equal(1);
		expect(takingBids[1].order!.orderId).to.equal(2);
		expect(takingBids[2].order!.orderId).to.equal(3);

		let restingBids = Array.from(
			dlob.getRestingLimitAsks(marketIndex, slot, marketType, oracle)
		);

		expect(restingBids.length).to.equal(0);

		slot += 11;

		takingBids = Array.from(
			dlob.getTakingAsks(marketIndex, marketType, slot, oracle)
		);

		expect(takingBids.length).to.equal(2);
		expect(takingBids[0].order!.orderId).to.equal(2);
		expect(takingBids[1].order!.orderId).to.equal(3);

		restingBids = Array.from(
			dlob.getRestingLimitAsks(marketIndex, slot, marketType, oracle)
		);

		expect(restingBids.length).to.equal(1);
		expect(restingBids[0].order!.orderId).to.equal(1);

		slot += 11;

		takingBids = Array.from(
			dlob.getTakingAsks(marketIndex, marketType, slot, oracle)
		);

		expect(takingBids.length).to.equal(1);
		expect(takingBids[0].order!.orderId).to.equal(3);

		restingBids = Array.from(
			dlob.getRestingLimitAsks(marketIndex, slot, marketType, oracle)
		);

		expect(restingBids.length).to.equal(2);
		expect(restingBids[0].order!.orderId).to.equal(2);
		expect(restingBids[1].order!.orderId).to.equal(1);

		slot += 11;

		takingBids = Array.from(
			dlob.getTakingAsks(marketIndex, marketType, slot, oracle)
		);

		expect(takingBids.length).to.equal(0);

		restingBids = Array.from(
			dlob.getRestingLimitAsks(marketIndex, slot, marketType, oracle)
		);

		expect(restingBids.length).to.equal(3);
		expect(restingBids[0].order!.orderId).to.equal(3);
		expect(restingBids[1].order!.orderId).to.equal(2);
		expect(restingBids[2].order!.orderId).to.equal(1);
	});
});

describe('DLOB Perp Tests', () => {
	it('Test proper bids', () => {
		const vAsk = new BN(15);
		const vBid = new BN(10);
		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 12;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};
		const testCases = [
			{
				expectedIdx: 0,
				isVamm: false,
				orderId: 5,
				price: new BN(0),
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
				slot: new BN(0),
				postOnly: false,
			},
			{
				expectedIdx: 1,
				isVamm: false,
				orderId: 6,
				price: new BN(0),
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
				slot: new BN(1),
				postOnly: false,
			},
			{
				expectedIdx: 2,
				isVamm: false,
				orderId: 7,
				price: new BN(0),
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
				slot: new BN(2),
				postOnly: false,
			},
			{
				expectedIdx: 3,
				isVamm: false,
				orderId: 1,
				price: new BN(12),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				slot: new BN(3),
				postOnly: false,
			},
			{
				expectedIdx: 4,
				isVamm: false,
				orderId: 2,
				price: new BN(11),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				slot: new BN(4),
				postOnly: false,
			},
			{
				expectedIdx: 7,
				isVamm: false,
				orderId: 3,
				price: new BN(8),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				slot: new BN(5),
				postOnly: true,
			},
			{
				expectedIdx: 5,
				isVamm: true,
				orderId: undefined,
				price: undefined,
				direction: undefined,
				orderType: undefined,
				slot: undefined,
				postOnly: false,
			},
			{
				expectedIdx: 6,
				isVamm: false,
				orderId: 4,
				price: new BN(9),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				slot: new BN(6),
				postOnly: true,
			},
		];

		for (const t of testCases) {
			if (t.isVamm) {
				continue;
			}

			const user = Keypair.generate();

			insertOrderToDLOB(
				dlob,
				user.publicKey,
				t.orderType || OrderType.LIMIT,
				MarketType.PERP,
				t.orderId || 0, // orderId
				marketIndex,
				t.price || new BN(0), // price
				BASE_PRECISION, // quantity
				t.direction || PositionDirection.LONG,
				!t.postOnly ? vBid : ZERO,
				!t.postOnly ? vAsk : ZERO,
				t.slot,
				undefined,
				undefined,
				t.postOnly
			);
		}

		const expectedTestCase = testCases.sort((a, b) => {
			// ascending order
			return a.expectedIdx - b.expectedIdx;
		});
		const allBids = dlob.getBids(
			marketIndex,
			vBid,
			slot,
			MarketType.PERP,
			oracle
		);
		let countBids = 0;
		for (const bid of allBids) {
			expect(bid.isVammNode(), `expected vAMM node`).to.be.eq(
				expectedTestCase[countBids].isVamm
			);
			expect(bid.order?.orderId, `expected orderId`).to.equal(
				expectedTestCase[countBids].orderId
			);
			expect(bid.order?.price.toNumber(), `expected price`).to.equal(
				expectedTestCase[countBids].price?.toNumber()
			);
			expect(bid.order?.direction, `expected order direction`).to.equal(
				expectedTestCase[countBids].direction
			);
			expect(bid.order?.orderType, `expected order type`).to.equal(
				expectedTestCase[countBids].orderType
			);
			countBids++;
		}
		expect(countBids).to.equal(testCases.length);

		const takingBids = dlob.getTakingBids(
			marketIndex,
			MarketType.PERP,
			slot,
			oracle
		);
		countBids = 0;
		for (const bid of takingBids) {
			expect(bid.isVammNode(), `expected vAMM node`).to.be.eq(
				expectedTestCase.slice(0, 5)[countBids].isVamm
			);
			expect(bid.order?.orderId, `expected orderId`).to.equal(
				expectedTestCase.slice(0, 5)[countBids].orderId
			);
			expect(bid.order?.price.toNumber(), `expected price`).to.equal(
				expectedTestCase.slice(0, 5)[countBids].price?.toNumber()
			);
			expect(bid.order?.direction, `expected order direction`).to.equal(
				expectedTestCase.slice(0, 5)[countBids].direction
			);
			expect(bid.order?.orderType, `expected order type`).to.equal(
				expectedTestCase.slice(0, 5)[countBids].orderType
			);
			countBids++;
		}
		expect(countBids).to.equal(expectedTestCase.slice(0, 5).length);

		const limitBids = dlob.getRestingLimitBids(
			marketIndex,
			slot,
			MarketType.PERP,
			oracle
		);
		countBids = 0;
		let idx = 0;
		for (const bid of limitBids) {
			if (expectedTestCase.slice(5)[idx].isVamm) {
				idx++;
			}
			expect(bid.isVammNode(), `expected vAMM node`).to.be.eq(
				expectedTestCase.slice(5)[idx].isVamm
			);
			expect(bid.order?.orderId, `expected orderId`).to.equal(
				expectedTestCase.slice(5)[idx].orderId
			);
			expect(bid.order?.price.toNumber(), `expected price`).to.equal(
				expectedTestCase.slice(5)[idx].price?.toNumber()
			);
			expect(bid.order?.direction, `expected order direction`).to.equal(
				expectedTestCase.slice(5)[idx].direction
			);
			expect(bid.order?.orderType, `expected order type`).to.equal(
				expectedTestCase.slice(5)[idx].orderType
			);
			countBids++;
			idx++;
		}
		expect(countBids).to.equal(expectedTestCase.slice(5).length - 1); // subtract one since test case 5 is vAMM node
	});

	it('Test proper bids on multiple markets', () => {
		const vAsk = new BN(15);
		const vBid = new BN(10);
		const dlob = new DLOB();
		const marketIndex0 = 0;
		const marketIndex1 = 1;

		const slot = 12;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};
		const testCases = [
			{
				expectedIdx: 3,
				isVamm: false,
				orderId: 5,
				price: new BN(0),
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
				marketIndex: marketIndex0,
			},
			{
				expectedIdx: 4,
				isVamm: false,
				orderId: 6,
				price: new BN(0),
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
				marketIndex: marketIndex0,
			},
			{
				expectedIdx: 5,
				isVamm: false,
				orderId: 7,
				price: new BN(0),
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
				marketIndex: marketIndex1,
			},
			{
				expectedIdx: 0,
				isVamm: false,
				orderId: 1,
				price: new BN(12),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				marketIndex: marketIndex0,
			},
			{
				expectedIdx: 1,
				isVamm: false,
				orderId: 2,
				price: new BN(11),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				marketIndex: marketIndex0,
			},
			{
				expectedIdx: 7,
				isVamm: false,
				orderId: 3,
				price: new BN(8),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				marketIndex: marketIndex0,
			},
			{
				expectedIdx: 6,
				isVamm: false,
				orderId: 4,
				price: new BN(9),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				marketIndex: marketIndex1,
			},
		];

		for (const t of testCases) {
			if (t.isVamm) {
				continue;
			}

			const user = Keypair.generate();

			insertOrderToDLOB(
				dlob,
				user.publicKey,
				t.orderType || OrderType.LIMIT,
				MarketType.PERP,
				t.orderId || 0, // orderId
				t.marketIndex,
				t.price || new BN(0), // price
				BASE_PRECISION, // quantity
				t.direction || PositionDirection.LONG,
				vBid,
				vAsk
			);
		}

		const bids0 = dlob.getBids(
			marketIndex0,
			vBid,
			slot,
			MarketType.PERP,
			oracle
		);
		let countBids0 = 0;
		for (const bid of bids0) {
			console.log(
				` . vAMMNode? ${bid.isVammNode()}, ${JSON.stringify(
					bid.order?.orderType
				)} , ${bid.order?.orderId.toString()} , vammTestgetPRice: ${bid.getPrice(
					oracle,
					slot
				)}, price: ${bid.order?.price.toString()}, quantity: ${bid.order?.baseAssetAmountFilled.toString()}/${bid.order?.baseAssetAmount.toString()}`
			);
			countBids0++;
		}
		expect(countBids0).to.equal(6);

		const bids1 = dlob.getBids(
			marketIndex1,
			vBid,
			slot,
			MarketType.PERP,
			oracle
		);
		let countBids1 = 0;
		for (const bid of bids1) {
			console.log(
				` . vAMMNode? ${bid.isVammNode()}, ${JSON.stringify(
					bid.order?.orderType
				)} , ${bid.order?.orderId.toString()} , vammTestgetPRice: ${bid.getPrice(
					oracle,
					slot
				)}, price: ${bid.order?.price.toString()}, quantity: ${bid.order?.baseAssetAmountFilled.toString()}/${bid.order?.baseAssetAmount.toString()}`
			);

			countBids1++;
		}
		expect(countBids1).to.equal(3);
	});

	it('Test proper asks', () => {
		const vAsk = new BN(15);
		const vBid = new BN(10);
		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 12;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};
		const testCases = [
			{
				expectedIdx: 0,
				isVamm: false,
				orderId: 3,
				price: new BN(0),
				direction: PositionDirection.SHORT,
				orderType: OrderType.MARKET,
				slot: new BN(0),
				postOnly: false,
			},
			{
				expectedIdx: 1,
				isVamm: false,
				orderId: 4,
				price: new BN(0),
				direction: PositionDirection.SHORT,
				orderType: OrderType.MARKET,
				slot: new BN(1),
				postOnly: false,
			},
			{
				expectedIdx: 2,
				isVamm: false,
				orderId: 5,
				price: new BN(0),
				direction: PositionDirection.SHORT,
				orderType: OrderType.MARKET,
				slot: new BN(2),
				postOnly: false,
			},
			{
				expectedIdx: 3,
				isVamm: false,
				orderId: 1,
				price: new BN(13),
				direction: PositionDirection.SHORT,
				orderType: OrderType.LIMIT,
				slot: new BN(3),
				postOnly: false,
			},
			{
				expectedIdx: 6,
				isVamm: false,
				orderId: 6,
				price: new BN(16),
				direction: PositionDirection.SHORT,
				orderType: OrderType.LIMIT,
				slot: new BN(4),
				postOnly: true,
			},
			{
				expectedIdx: 5,
				isVamm: true,
				orderId: undefined,
				price: undefined,
				direction: undefined,
				orderType: undefined,
				slot: new BN(0),
				postOnly: false,
			},
			{
				expectedIdx: 7,
				isVamm: false,
				orderId: 7,
				price: new BN(17),
				direction: PositionDirection.SHORT,
				orderType: OrderType.LIMIT,
				slot: new BN(4),
				postOnly: true,
			},
			{
				expectedIdx: 4,
				isVamm: false,
				orderId: 2,
				price: new BN(14),
				direction: PositionDirection.SHORT,
				orderType: OrderType.LIMIT,
				slot: new BN(4),
				postOnly: true,
			},
		];

		for (const t of testCases) {
			if (t.isVamm) {
				continue;
			}

			const user = Keypair.generate();

			insertOrderToDLOB(
				dlob,
				user.publicKey,
				t.orderType || OrderType.LIMIT,
				MarketType.PERP,
				t.orderId || 0, // orderId
				marketIndex,
				t.price || new BN(0), // price
				BASE_PRECISION, // quantity
				t.direction || PositionDirection.SHORT,
				!t.postOnly ? vBid : ZERO,
				!t.postOnly ? vAsk : ZERO,
				t.slot,
				undefined,
				undefined,
				t.postOnly
			);
		}

		const expectedTestCase = testCases.sort((a, b) => {
			// ascending order
			return a.expectedIdx - b.expectedIdx;
		});

		const asks = dlob.getAsks(marketIndex, vAsk, slot, MarketType.PERP, oracle);
		let countAsks = 0;
		for (const ask of asks) {
			expect(ask.isVammNode()).to.be.eq(expectedTestCase[countAsks].isVamm);
			expect(ask.order?.orderId).to.equal(expectedTestCase[countAsks].orderId);
			expect(ask.order?.price.toNumber()).to.equal(
				expectedTestCase[countAsks].price?.toNumber()
			);
			expect(ask.order?.direction).to.equal(
				expectedTestCase[countAsks].direction
			);
			expect(ask.order?.orderType).to.equal(
				expectedTestCase[countAsks].orderType
			);
			countAsks++;
		}
		expect(countAsks).to.equal(testCases.length);

		const takingAsks = dlob.getTakingAsks(
			marketIndex,
			MarketType.PERP,
			slot,
			oracle
		);
		countAsks = 0;
		for (const ask of takingAsks) {
			expect(ask.isVammNode()).to.be.eq(
				expectedTestCase.slice(0, 4)[countAsks].isVamm
			);
			expect(ask.order?.orderId).to.equal(
				expectedTestCase.slice(0, 4)[countAsks].orderId
			);
			expect(ask.order?.price.toNumber()).to.equal(
				expectedTestCase.slice(0, 4)[countAsks].price?.toNumber()
			);
			expect(ask.order?.direction).to.equal(
				expectedTestCase.slice(0, 4)[countAsks].direction
			);
			expect(ask.order?.orderType).to.equal(
				expectedTestCase.slice(0, 4)[countAsks].orderType
			);
			countAsks++;
		}
		expect(countAsks).to.equal(expectedTestCase.slice(0, 4).length);

		const limitAsks = dlob.getRestingLimitAsks(
			marketIndex,
			slot,
			MarketType.PERP,
			oracle
		);
		countAsks = 0;
		let idx = 0;
		for (const ask of limitAsks) {
			if (expectedTestCase.slice(4)[idx].isVamm) {
				idx++;
			}
			expect(ask.isVammNode()).to.be.eq(expectedTestCase.slice(4)[idx].isVamm);
			expect(ask.order?.orderId).to.equal(
				expectedTestCase.slice(4)[idx].orderId
			);
			expect(ask.order?.price.toNumber()).to.equal(
				expectedTestCase.slice(4)[idx].price?.toNumber()
			);
			expect(ask.order?.direction).to.equal(
				expectedTestCase.slice(4)[idx].direction
			);
			expect(ask.order?.orderType).to.equal(
				expectedTestCase.slice(4)[idx].orderType
			);
			countAsks++;
			idx++;
		}
		expect(countAsks).to.equal(expectedTestCase.slice(4).length - 1); // subtract one since test case includes vAMM node
	});

	it('Test insert market orders', () => {
		const vAsk = new BN(11);
		const vBid = new BN(10);
		const dlob = new DLOB();
		const marketIndex = 0;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(12),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		// 3 mkt buys
		for (let i = 0; i < 3; i++) {
			const user = Keypair.generate();

			insertOrderToDLOB(
				dlob,
				user.publicKey,
				OrderType.MARKET,
				MarketType.PERP,
				i + 1,
				marketIndex,
				new BN(0),
				BASE_PRECISION,
				PositionDirection.LONG,
				vBid,
				vAsk
			);
		}

		// 3 mkt sells
		for (let i = 0; i < 3; i++) {
			const user = Keypair.generate();

			insertOrderToDLOB(
				dlob,
				user.publicKey,
				OrderType.MARKET,
				MarketType.PERP,
				i + 1,
				marketIndex,
				new BN(0),
				BASE_PRECISION,
				PositionDirection.SHORT,
				vBid,
				vAsk
			);
		}

		let asks = 0;
		for (const ask of dlob.getAsks(
			marketIndex,
			vAsk,
			2,
			MarketType.PERP,
			oracle
		)) {
			// vamm node is last in asks
			asks++;

			if (ask.order) {
				// market orders
				expect(getVariant(ask.order?.status)).to.equal('open');
				expect(getVariant(ask.order?.orderType)).to.equal('market');
				expect(getVariant(ask.order?.direction)).to.equal('short');
				expect(ask.order?.orderId).to.equal(asks);
			}
		}
		expect(asks).to.equal(4); // vamm ask + 3 orders

		let bids = 0;
		const expectedBidOrderIds = [1, 2, 3];
		for (const bid of dlob.getBids(
			marketIndex,
			vBid,
			2,
			MarketType.PERP,
			oracle
		)) {
			bids++;
			if (bid.isVammNode()) {
				continue;
			}
			// market orders
			expect(getVariant(bid.order?.status)).to.equal('open');
			expect(getVariant(bid.order?.orderType)).to.equal('market');
			expect(getVariant(bid.order?.direction)).to.equal('long');
			expect(bid.order?.orderId).to.equal(expectedBidOrderIds[bids - 1]);
		}
		expect(bids).to.equal(4); // vamm bid + 3 orders
	});

	it('Test insert limit orders', () => {
		const slot = 12;
		const vAsk = new BN(11);
		const vBid = new BN(10);
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();
		const user3 = Keypair.generate();
		const user4 = Keypair.generate();
		const user5 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			3, // orderId
			marketIndex,
			new BN(5),
			BASE_PRECISION,
			PositionDirection.LONG,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			undefined,
			0
		);

		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			2,
			marketIndex,
			new BN(6),
			BASE_PRECISION,
			PositionDirection.LONG,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			undefined,
			0
		);

		insertOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			1, // orderId
			marketIndex,
			new BN(7),
			BASE_PRECISION,
			PositionDirection.LONG,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			undefined,
			0
		);

		insertOrderToDLOB(
			dlob,
			user3.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			1, // orderId
			marketIndex,
			new BN(12),
			BASE_PRECISION,
			PositionDirection.SHORT,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			undefined,
			0
		);

		insertOrderToDLOB(
			dlob,
			user4.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			new BN(13),
			BASE_PRECISION,
			PositionDirection.SHORT,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			undefined,
			0
		);

		insertOrderToDLOB(
			dlob,
			user5.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			3, // orderId
			marketIndex,
			new BN(14),
			BASE_PRECISION,
			PositionDirection.SHORT,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			undefined,
			0
		);

		let asks = 0;
		for (const ask of dlob.getAsks(
			marketIndex,
			vAsk,
			2,
			MarketType.PERP,
			oracle
		)) {
			if (ask.order) {
				// market orders
				console.log(`ask price: ${ask.order.price.toString()}`);
				expect(getVariant(ask.order?.status)).to.equal('open');
				expect(getVariant(ask.order?.orderType)).to.equal('limit');
				expect(getVariant(ask.order?.direction)).to.equal('short');
				expect(ask.order?.orderId).to.equal(asks);
				expect(ask.order?.price.gt(vAsk)).to.equal(true);
			}

			// vamm node is first for limit asks
			asks++;
		}
		expect(asks).to.equal(4); // vamm ask + 3 orders

		let bids = 0;
		for (const bid of dlob.getBids(
			marketIndex,
			vBid,
			2,
			MarketType.PERP,
			oracle
		)) {
			if (bids === 0) {
				// vamm node
				expect(bid.order).to.equal(undefined);
			} else {
				// market orders
				console.log(`bid price: ${bid.order?.price.toString()}`);
				expect(getVariant(bid.order?.status)).to.equal('open');
				expect(getVariant(bid.order?.orderType)).to.equal('limit');
				expect(getVariant(bid.order?.direction)).to.equal('long');
				expect(bid.order?.orderId).to.equal(bids);
				expect(bid.order?.price.lt(vBid)).to.equal(true);
			}
			bids++;
		}
		expect(bids).to.equal(4); // vamm bid + 3 orders
	});

	it('Test insert floatinglimit orders', () => {
		const slot = 12;
		const vAsk = new BN(11).mul(PRICE_PRECISION);
		const vBid = new BN(10).mul(PRICE_PRECISION);
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();
		const user3 = Keypair.generate();
		const user4 = Keypair.generate();
		const user5 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		// insert floating bids
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			1, // orderId
			marketIndex,
			new BN(0), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(slot),
			ZERO, // TiF
			new BN(-1).mul(PRICE_PRECISION) // oraclePriceOffset
		);
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			3, // orderId
			marketIndex,
			new BN(0), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(slot),
			ZERO, // TiF
			new BN(-3).mul(PRICE_PRECISION) // oraclePriceOffset
		);
		insertOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			new BN(0), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(slot),
			ZERO, // TiF
			new BN(-2).mul(PRICE_PRECISION) // oraclePriceOffset
		);

		// insert floating asks
		insertOrderToDLOB(
			dlob,
			user3.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			5, // orderId
			marketIndex,
			new BN(0), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vAsk,
			vBid,
			new BN(slot),
			ZERO, // TiF
			new BN(2).mul(PRICE_PRECISION) // oraclePriceOffset
		);
		insertOrderToDLOB(
			dlob,
			user4.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			6, // orderId
			marketIndex,
			new BN(0), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vAsk,
			vBid,
			new BN(slot),
			ZERO, // TiF
			new BN(3).mul(PRICE_PRECISION) // oraclePriceOffset
		);
		insertOrderToDLOB(
			dlob,
			user5.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			4, // orderId
			marketIndex,
			new BN(0), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vAsk,
			vBid,
			new BN(slot),
			ZERO, // TiF
			new BN(1).mul(PRICE_PRECISION) // oraclePriceOffset
		);

		// check floating bids
		console.log(`bids:`);
		let lastBidPrice = new BN(9999999999999); // very big
		let bids = 0;
		for (const bid of dlob.getBids(
			marketIndex,
			vBid,
			slot,
			MarketType.PERP,
			oracle
		)) {
			printOrderNode(bid, oracle, slot);

			if (!bid.isVammNode()) {
				expect(getVariant(bid.order?.status)).to.equal('open');
				expect(getVariant(bid.order?.orderType)).to.equal('limit');
				expect(getVariant(bid.order?.direction)).to.equal('long');

				// price should be getting worse (getting lower) as we iterate
				const currentPrice = bid.getPrice(oracle, slot);
				expect(
					currentPrice.lte(lastBidPrice),
					`each bid should be lte the last. current: ${currentPrice.toString()}, last: ${lastBidPrice.toString()}`
				).to.be.true;
			}
			lastBidPrice = bid.getPrice(oracle, slot);
			bids++;
		}
		expect(bids).to.equal(4); // vamm bid + 3 orders

		// check floating asks
		console.log(`asks:`);
		let asks = 0;
		for (const ask of dlob.getAsks(
			marketIndex,
			vAsk,
			slot,
			MarketType.PERP,
			oracle
		)) {
			printOrderNode(ask, oracle, slot);
			if (!ask.isVammNode()) {
				expect(getVariant(ask.order?.status)).to.equal('open');
				expect(getVariant(ask.order?.orderType)).to.equal('limit');
				expect(getVariant(ask.order?.direction)).to.equal('short');

				// price should be getting worse (getting higher) as we iterate
				const currentPrice = ask.getPrice(oracle, slot);
				expect(
					currentPrice.gte(lastBidPrice),
					`each ask should be gte the last. current: ${currentPrice.toString()}, last: ${lastBidPrice.toString()}`
				).to.be.true;
			}
			asks++;
		}
		expect(asks).to.equal(4); // vamm ask + 3 orders
	});

	it('Test multiple market orders fill with multiple limit orders', async () => {
		const vAsk = new BN(15);
		const vBid = new BN(10);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();
		const user3 = Keypair.generate();
		const user4 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		// insert some limit buys above vamm bid, below ask
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			1, // orderId
			marketIndex,
			new BN(11), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			true
		);
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			new BN(12), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			true
		);
		insertOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			3, // orderId
			marketIndex,
			new BN(13), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			true
		);

		// should have no crossing orders
		const nodesToFillBefore = dlob.findRestingLimitOrderNodesToFill(
			marketIndex,
			12, // auction over
			MarketType.PERP,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(12),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			},
			false,
			10,
			0,
			1,
			undefined,
			undefined
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// place two market sell order eating 2 of the limit orders
		insertOrderToDLOB(
			dlob,
			user3.publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			4, // orderId
			marketIndex,
			new BN(12), // price
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			user4.publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			5, // orderId
			marketIndex,
			new BN(12), // price
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk
		);

		const nodesToFillAfter = dlob.findNodesToFill(
			marketIndex,
			undefined,
			undefined,
			12, // auction over
			Date.now(),
			MarketType.PERP,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(12),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			},
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);
		console.log(`Filled nodes: ${nodesToFillAfter.length}`);
		for (const n of nodesToFillAfter) {
			printCrossedNodes(n, 12);
		}
		expect(nodesToFillAfter.length).to.equal(2);

		// first taker should fill with best maker
		expect(nodesToFillAfter[0].node.order?.orderId).to.equal(4);
		expect(nodesToFillAfter[0].makerNodes[0]?.order?.orderId).to.equal(3);

		// second taker should fill with second best maker
		expect(nodesToFillAfter[1].node.order?.orderId).to.equal(5);
		expect(nodesToFillAfter[1].makerNodes[0]?.order?.orderId).to.equal(2);
	});

	it('Test one market orders fills two limit orders', () => {
		const vAsk = new BN(15);
		const vBid = new BN(10);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();
		const user3 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		// insert some limit sells below vAMM ask, above bid
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			1, // orderId
			marketIndex,
			new BN(14), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			true
		);
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			new BN(13), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			true
		);
		insertOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			3, // orderId
			marketIndex,
			new BN(12), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			true
		);

		// auction over
		const endSlot = 12;

		// should have no crossing orders
		const nodesToFillBefore = dlob.findRestingLimitOrderNodesToFill(
			marketIndex,
			endSlot,
			MarketType.PERP,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(endSlot),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			},
			false,
			10,
			0,
			1,
			undefined,
			undefined
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// place one market buy order eating 2 of the limit orders
		insertOrderToDLOB(
			dlob,
			user3.publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			4, // orderId
			marketIndex,
			new BN(13), // price
			new BN(2).mul(BASE_PRECISION), // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);

		const nodesToFillAfter = dlob.findNodesToFill(
			marketIndex,
			undefined,
			undefined,
			endSlot,
			Date.now(),
			MarketType.PERP,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(endSlot),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			},
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);
		console.log(`Filled nodes: ${nodesToFillAfter.length}`);
		for (const n of nodesToFillAfter) {
			printCrossedNodes(n, endSlot);
		}
		expect(nodesToFillAfter.length).to.equal(1);

		// taker should fill completely with best maker
		expect(
			nodesToFillAfter[0].node.order?.orderId,
			'wrong taker orderId'
		).to.equal(4);
		expect(
			nodesToFillAfter[0].makerNodes[0]?.order?.orderId,
			'wrong maker orderId'
		).to.equal(3);

		expect(
			nodesToFillAfter[0].makerNodes[1]?.order?.orderId,
			'wrong maker orderId'
		).to.equal(2);
	});

	it('Test two market orders to fill one limit order', () => {
		const vAsk = new BN(15);
		const vBid = new BN(8);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();
		const user3 = Keypair.generate();
		const user4 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 12;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		// insert some limit sells below vAMM ask, above bid
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			1, // orderId
			marketIndex,
			new BN(14), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			true
		);
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			new BN(13), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			true
		);
		insertOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			3, // orderId
			marketIndex,
			new BN(9), // price <-- best price
			new BN(3).mul(BASE_PRECISION), // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			true
		);

		const nodesToFillBefore = dlob.findNodesToFill(
			marketIndex,
			undefined,
			undefined,
			slot, // auction over
			Date.now(),
			MarketType.PERP,
			oracle,
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// place two market buy orders to eat the best ask
		insertOrderToDLOB(
			dlob,
			user3.publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			4, // orderId
			marketIndex,
			new BN(0), // price
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			user4.publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			5, // orderId
			marketIndex,
			new BN(0), // price
			new BN(2).mul(BASE_PRECISION), // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);

		const nodesToFillAfter = dlob.findNodesToFill(
			marketIndex,
			undefined,
			undefined,
			slot, // auction over
			Date.now(),
			MarketType.PERP,
			oracle,
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);
		const mktNodes = dlob.findExpiredNodesToFill(
			marketIndex,
			slot,
			MarketType.PERP
		);
		console.log(`market nodes: ${mktNodes.length}`);

		printBookState(dlob, marketIndex, vBid, vAsk, slot, oracle);

		console.log(`Filled nodes: ${nodesToFillAfter.length}`);
		for (const n of nodesToFillAfter) {
			printCrossedNodes(n, slot);
		}
		expect(nodesToFillAfter.length).to.equal(2);

		// taker should fill completely with best maker
		expect(nodesToFillAfter[0].node.order?.orderId).to.equal(4);
		expect(nodesToFillAfter[0].makerNodes[0]?.order?.orderId).to.equal(3);

		// taker should fill completely with second best maker
		expect(nodesToFillAfter[1].node.order?.orderId).to.equal(5);
		expect(nodesToFillAfter[1].makerNodes[0]?.order?.orderId).to.equal(3);
	});

	it('Test post only bid fills against fallback', async () => {
		const vAsk = new BN(150);
		const vBid = new BN(100);

		const user0 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		const makerRebateNumerator = 1;
		const makerRebateDenominator = 10;

		// post only bid same as ask
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			1, // orderId
			marketIndex,
			vAsk, // same price as vAsk
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			true
		);

		// should have no crossing orders
		const nodesToFillBefore = dlob.findRestingLimitOrderNodesToFill(
			marketIndex,
			12, // auction over
			MarketType.PERP,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(12),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			},
			false,
			10,
			makerRebateNumerator,
			makerRebateDenominator,
			vAsk,
			vBid
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// post only bid crosses ask
		const price = vAsk.add(
			vAsk.muln(makerRebateNumerator).divn(makerRebateDenominator)
		);
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			price, // crosses vask
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			true
		);

		// should have no crossing orders
		const nodesToFillAfter = dlob.findRestingLimitOrderNodesToFill(
			marketIndex,
			12, // auction over
			MarketType.PERP,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(12),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			},
			false,
			10,
			makerRebateNumerator,
			makerRebateDenominator,
			vAsk,
			vBid
		);
		expect(nodesToFillAfter.length).to.equal(1);
	});

	it('Test post only ask fills against fallback', async () => {
		const vAsk = new BN(150);
		const vBid = new BN(100);

		const user0 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		const makerRebateNumerator = 1;
		const makerRebateDenominator = 10;

		// post only bid same as ask
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			1, // orderId
			marketIndex,
			vBid, // same price as vAsk
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			true
		);

		// should have no crossing orders
		const nodesToFillBefore = dlob.findRestingLimitOrderNodesToFill(
			marketIndex,
			12, // auction over
			MarketType.PERP,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(12),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			},
			false,
			10,
			makerRebateNumerator,
			makerRebateDenominator,
			vAsk,
			vBid
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// post only bid crosses ask
		const price = vBid.sub(
			vAsk.muln(makerRebateNumerator).divn(makerRebateDenominator)
		);
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			price, // crosses vask
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			true
		);

		// should have no crossing orders
		const nodesToFillAfter = dlob.findRestingLimitOrderNodesToFill(
			marketIndex,
			12, // auction over
			MarketType.PERP,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(12),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			},
			false,
			10,
			makerRebateNumerator,
			makerRebateDenominator,
			vAsk,
			vBid
		);
		expect(nodesToFillAfter.length).to.equal(1);
	});

	it('Test trigger orders', () => {
		const vAsk = new BN(15);
		const vBid = new BN(8);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();
		const user3 = Keypair.generate();
		const user4 = Keypair.generate();
		const user5 = Keypair.generate();
		const user6 = Keypair.generate();
		const user7 = Keypair.generate();
		const user8 = Keypair.generate();
		const user9 = Keypair.generate();
		const user10 = Keypair.generate();
		const user11 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 20;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		const orderIdsToTrigger = [1, 2, 3, 4, 5, 6, 7, 8];
		// const orderIdsToNotTrigger = [9, 10, 11, 12];

		// should trigger limit buy with above condition
		insertTriggerOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.TRIGGER_LIMIT,
			MarketType.PERP,
			1, //orderId
			marketIndex, // marketIndex
			vBid, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.LONG,
			oracle.price.sub(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.ABOVE, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);
		// should trigger limit sell with above condition
		insertTriggerOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.TRIGGER_LIMIT,
			MarketType.PERP,
			2, //orderId
			marketIndex, // marketIndex
			vBid, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.SHORT,
			oracle.price.sub(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.ABOVE, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);
		// should trigger market buy with above condition
		insertTriggerOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.PERP,
			3, //orderId
			marketIndex, // marketIndex
			vAsk, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.LONG,
			oracle.price.sub(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.ABOVE, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);
		// should trigger market sell with above condition
		insertTriggerOrderToDLOB(
			dlob,
			user3.publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.PERP,
			4, //orderId
			marketIndex, // marketIndex
			vBid, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.SHORT,
			oracle.price.sub(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.ABOVE, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);
		// should trigger limit buy with below condition
		insertTriggerOrderToDLOB(
			dlob,
			user4.publicKey,
			OrderType.TRIGGER_LIMIT,
			MarketType.PERP,
			5, //orderId
			marketIndex, // marketIndex
			vBid, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.LONG,
			oracle.price.add(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.BELOW, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);
		// should trigger limit sell with below condition
		insertTriggerOrderToDLOB(
			dlob,
			user5.publicKey,
			OrderType.TRIGGER_LIMIT,
			MarketType.PERP,
			6, //orderId
			marketIndex, // marketIndex
			vBid, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.SHORT,
			oracle.price.add(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.BELOW, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);
		// should trigger market buy with below condition
		insertTriggerOrderToDLOB(
			dlob,
			user6.publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.PERP,
			7, //orderId
			marketIndex, // marketIndex
			vBid, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.LONG,
			oracle.price.add(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.BELOW, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);
		// should trigger market sell with below condition
		insertTriggerOrderToDLOB(
			dlob,
			user7.publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.PERP,
			8, //orderId
			marketIndex, // marketIndex
			vBid, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.LONG,
			oracle.price.add(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.BELOW, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);

		// should NOT trigger market sell with above condition
		insertTriggerOrderToDLOB(
			dlob,
			user8.publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.PERP,
			9, //orderId
			marketIndex, // marketIndex
			vBid, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.SHORT,
			oracle.price.add(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.ABOVE, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);
		// should NOT trigger market sell with below condition
		insertTriggerOrderToDLOB(
			dlob,
			user9.publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.PERP,
			10, //orderId
			marketIndex, // marketIndex
			vBid, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.SHORT,
			oracle.price.sub(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.BELOW, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);
		// should NOT trigger market buy with above condition
		insertTriggerOrderToDLOB(
			dlob,
			user10.publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.PERP,
			11, //orderId
			marketIndex, // marketIndex
			vBid, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.LONG,
			oracle.price.add(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.ABOVE, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);
		// should NOT trigger market buy with below condition
		insertTriggerOrderToDLOB(
			dlob,
			user11.publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.PERP,
			12, //orderId
			marketIndex, // marketIndex
			vBid, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.LONG,
			oracle.price.sub(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.BELOW, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);

		const nodesToTrigger = dlob.findNodesToTrigger(
			marketIndex,
			slot,
			oracle.price,
			MarketType.PERP,
			mockStateAccount
		);
		console.log(`nodesToTriggeR: ${nodesToTrigger.length}`);
		for (const [idx, n] of nodesToTrigger.entries()) {
			expect(n.node.order?.orderId).to.equal(orderIdsToTrigger[idx]);
		}
	});

	it('Test will return expired market orders to fill', () => {
		const vAsk = new BN(15);
		const vBid = new BN(8);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 20;
		const ts = 20;
		const maxTs = new BN(30);

		// non crossing bid
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			255, // orderId
			marketIndex,
			new BN(2), // price, very low, don't cross vamm
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(slot),
			maxTs
		);
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			new BN(30), // price, very high, don't cross vamm
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vAsk,
			vBid,
			new BN(slot),
			maxTs
		);

		// order auction is not yet complete, and order is not expired.
		const slot0 = slot;
		const ts0 = ts;
		const nodesToFillBefore = dlob.findNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			slot0,
			ts0,
			MarketType.PERP,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(slot0),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			},
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// should get order to fill after timeInForce
		const slot1 = slot0 + 20;
		const ts1 = ts0 + 20; // overshoots expiry
		const nodesToFillAfter = dlob.findNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			slot1, // auction is over, and order ix expired
			ts1,
			MarketType.PERP,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(slot1),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			},
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);
		console.log(`Filled nodes: ${nodesToFillAfter.length}`);
		for (const n of nodesToFillAfter) {
			printCrossedNodes(n, slot1);
		}
		expect(nodesToFillAfter.length).to.equal(2);

		// check that the nodes have no makers
		expect(nodesToFillAfter[0].makerNodes.length).to.equal(0);
		expect(nodesToFillAfter[1].makerNodes.length).to.equal(0);
	});

	it('Test skips vAMM and fills market buy order with floating limit order during auction', () => {
		const vAsk = new BN(15).mul(PRICE_PRECISION);
		const vBid = new BN(8).mul(PRICE_PRECISION);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();
		const user3 = Keypair.generate();
		const user4 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 12;
		const ts = 12;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		// insert some floating limit sells above vAMM ask
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			1, // orderId
			marketIndex,
			new BN(14).mul(PRICE_PRECISION), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			new BN(slot),
			ZERO,
			new BN(1).mul(PRICE_PRECISION),
			true,
			0
		);
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			new BN(13).mul(PRICE_PRECISION), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			new BN(slot),
			ZERO,
			new BN(1).mul(PRICE_PRECISION),
			true,
			0
		);
		insertOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			3, // orderId
			marketIndex,
			new BN(9).mul(PRICE_PRECISION), // price <-- best price
			new BN(3).mul(BASE_PRECISION), // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			new BN(slot),
			ZERO,
			new BN(1).mul(PRICE_PRECISION),
			true,
			0
		);

		// should have no crossing orders
		const nodesToFillBefore = dlob.findNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			slot,
			ts,
			MarketType.PERP,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(slot),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			},
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// place two market buy orders to eat the best ask
		insertOrderToDLOB(
			dlob,
			user3.publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			4, // orderId
			marketIndex,
			new BN(15).mul(PRICE_PRECISION), // price
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			user4.publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			5, // orderId
			marketIndex,
			new BN(15).mul(PRICE_PRECISION), // price
			new BN(2).mul(BASE_PRECISION), // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);

		const nodesToFillAfter = dlob.findNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			slot,
			ts,
			MarketType.PERP,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(slot),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			},
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);
		const mktNodes = dlob.findExpiredNodesToFill(
			marketIndex,
			slot,
			MarketType.PERP
		);
		console.log(`market nodes: ${mktNodes.length}`);

		printBookState(dlob, marketIndex, vBid, vAsk, slot, oracle);

		console.log(`Filled nodes: ${nodesToFillAfter.length}`);
		for (const n of nodesToFillAfter) {
			printCrossedNodes(n, slot);
		}
		expect(nodesToFillAfter.length).to.equal(2);

		// taker should fill first order completely with best maker (1/1)
		expect(nodesToFillAfter[0].node.order?.orderId).to.equal(4);
		expect(nodesToFillAfter[0].makerNodes[0]?.order?.orderId).to.equal(1);

		// taker should fill partially with second best maker (1/2)
		expect(nodesToFillAfter[1].node.order?.orderId).to.equal(5);
		expect(nodesToFillAfter[1].makerNodes[0]?.order?.orderId).to.equal(2);

		// taker should fill completely with third best maker (2/2)
		expect(nodesToFillAfter[1].makerNodes[1]?.order?.orderId).to.equal(3);
	});

	it('Test fills market buy order with better priced vAMM after auction', () => {
		const vAsk = new BN(15).mul(PRICE_PRECISION);
		const vBid = new BN(8).mul(PRICE_PRECISION);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();
		const user3 = Keypair.generate();
		const user4 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 12;
		const ts = 12;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		// insert some floating limit sells above vAMM ask
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			1, // orderId
			marketIndex,
			new BN(14).mul(PRICE_PRECISION), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			new BN(slot),
			ZERO,
			new BN(3).mul(PRICE_PRECISION)
		);
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			new BN(13).mul(PRICE_PRECISION), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			new BN(slot),
			ZERO,
			new BN(4).mul(PRICE_PRECISION)
		);
		insertOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			3, // orderId
			marketIndex,
			new BN(9).mul(PRICE_PRECISION), // price <-- best price
			new BN(3).mul(BASE_PRECISION), // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			new BN(slot),
			ZERO,
			new BN(5).mul(PRICE_PRECISION)
		);

		// should have no crossing orders
		const auctionOverSlot = slot * 10;
		const auctionOverTs = ts * 10;
		const nodesToFillBefore = dlob.findRestingLimitOrderNodesToFill(
			marketIndex,
			auctionOverSlot, // auction over
			MarketType.PERP,
			oracle,
			false,
			10,
			0,
			1,
			undefined,
			undefined
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// place two market buy orders
		insertOrderToDLOB(
			dlob,
			user3.publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			4, // orderId
			marketIndex,
			new BN(15).mul(PRICE_PRECISION), // price
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(slot),
			ZERO
		);
		insertOrderToDLOB(
			dlob,
			user4.publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			5, // orderId
			marketIndex,
			new BN(15).mul(PRICE_PRECISION), // price
			new BN(2).mul(BASE_PRECISION), // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(slot),
			ZERO
		);

		const nodesToFillAfter = dlob.findNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			auctionOverTs, // auction in progress
			ts,
			MarketType.PERP,
			oracle,
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);

		console.log(`Filled nodes: ${nodesToFillAfter.length}`);
		for (const n of nodesToFillAfter) {
			printCrossedNodes(n, auctionOverSlot);
		}
		expect(nodesToFillAfter.length).to.equal(2);

		// taker should fill completely with best maker
		expect(nodesToFillAfter[0].node.order?.orderId).to.equal(4);
		expect(nodesToFillAfter[0].makerNodes[0]?.order?.orderId).to.equal(1);

		// taker should fill the rest with the vAMM
		expect(nodesToFillAfter[1].node.order?.orderId).to.equal(5);
		expect(nodesToFillAfter[1].makerNodes[0]?.order?.orderId).to.equal(
			undefined
		);
	});

	it('Test skips vAMM and fills market sell order with floating limit buys during auction', () => {
		const vAsk = new BN(15).mul(PRICE_PRECISION);
		const vBid = new BN(8).mul(PRICE_PRECISION);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();
		const user3 = Keypair.generate();
		const user4 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 12;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)), // 11.5
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		// insert some floating limit buy below vAMM bid
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			new BN(0).mul(PRICE_PRECISION), // price, ignored since it's a floating limit
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(slot),
			ZERO,
			new BN(-4).mul(PRICE_PRECISION), // second best bid, but worse than vBid (8): 7.5
			true
		);
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			3, // orderId
			marketIndex,
			new BN(0).mul(PRICE_PRECISION), // price; ignored since it's a floating limit
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(slot),
			ZERO,
			new BN(-1).mul(PRICE_PRECISION), // best price: 10.5
			true
		);
		insertOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			1, // orderId
			marketIndex,
			new BN(0).mul(PRICE_PRECISION), // price; ignored since it's a floating limit
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(slot),
			ZERO,
			new BN(-5).mul(PRICE_PRECISION), // third best bid, worse than vBid (8): 6.5
			true
		);

		// should have no crossing orders
		const nodesToFillBefore = dlob.findNodesToFill(
			marketIndex,
			undefined,
			undefined,
			slot,
			Date.now(),
			MarketType.PERP,
			oracle,
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// place two market sell orders to eat the best bid
		insertOrderToDLOB(
			dlob,
			user3.publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			4, // orderId
			marketIndex,
			new BN(5).mul(PRICE_PRECISION), // price
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			user4.publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			5, // orderId
			marketIndex,
			new BN(4).mul(PRICE_PRECISION), // price
			new BN(2).mul(BASE_PRECISION), // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk
		);

		const nodesToFillAfter = dlob.findNodesToFill(
			marketIndex,
			undefined,
			undefined,
			slot, // auction in progress
			Date.now(),
			MarketType.PERP,
			oracle,
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);
		const mktNodes = dlob.findExpiredNodesToFill(
			marketIndex,
			slot,
			MarketType.PERP
		);
		console.log(`market nodes: ${mktNodes.length}`);

		printBookState(dlob, marketIndex, vBid, vAsk, slot, oracle);

		console.log(`Filled nodes: ${nodesToFillAfter.length}`);
		for (const n of nodesToFillAfter) {
			printCrossedNodes(n, slot);
		}
		expect(nodesToFillAfter.length).to.equal(2);

		// taker should fill first order completely with best maker (1/1)
		expect(
			nodesToFillAfter[0].node.order?.orderId,
			'wrong taker orderId'
		).to.equal(4);
		expect(
			nodesToFillAfter[0].makerNodes[0]?.order?.orderId,
			'wrong maker orderId'
		).to.equal(3);

		// taker should fill partially with second best maker (1/2)
		expect(
			nodesToFillAfter[1].node.order?.orderId,
			'wrong maker orderId'
		).to.equal(5);
		expect(
			nodesToFillAfter[1].makerNodes[0]?.order?.orderId,
			'wrong maker orderId'
		).to.equal(2);

		// taker should fill completely with third best maker (2/2)
		expect(
			nodesToFillAfter[1].makerNodes[1]?.order?.orderId,
			'wrong maker orderId'
		).to.equal(1);
	});

	it('Test fills market sell order with better priced vAMM after auction', () => {
		const vAsk = new BN(15).mul(PRICE_PRECISION);
		const vBid = new BN(8).mul(PRICE_PRECISION);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();
		const user3 = Keypair.generate();
		const user4 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 12;
		const ts = 12;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)), // 11.5
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		// insert some floating limit buy below vAMM bid
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			new BN(0).mul(PRICE_PRECISION), // price, ignored since it's a floating limit
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(slot),
			ZERO,
			new BN(-4).mul(PRICE_PRECISION), // second best bid, but worse than vBid (8): 7.5
			true
		);
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			3, // orderId
			marketIndex,
			new BN(0).mul(PRICE_PRECISION), // price; ignored since it's a floating limit
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(slot),
			ZERO,
			new BN(-1).mul(PRICE_PRECISION), // best price: 10.5
			true
		);
		insertOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			1, // orderId
			marketIndex,
			new BN(0).mul(PRICE_PRECISION), // price; ignored since it's a floating limit
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(slot),
			ZERO,
			new BN(-5).mul(PRICE_PRECISION), // third best bid, worse than vBid (8): 6.5
			true
		);

		console.log('DLOB state before fill:');
		printBookState(dlob, marketIndex, vBid, vAsk, slot, oracle);

		const nodesToFillBefore = dlob.findNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			slot,
			ts,
			MarketType.PERP,
			oracle,
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// place two market sell orders to eat the best bid
		insertOrderToDLOB(
			dlob,
			user3.publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			4, // orderId
			marketIndex,
			new BN(5).mul(PRICE_PRECISION), // price
			new BN(1).mul(BASE_PRECISION), // quantity, should consume best bid floating limit
			PositionDirection.SHORT,
			vBid,
			vAsk,
			new BN(slot)
		);
		insertOrderToDLOB(
			dlob,
			user4.publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			5, // orderId
			marketIndex,
			// new BN(8).mul(PRICE_PRECISION), // price, this price will fill with vamm
			new BN(4).mul(PRICE_PRECISION), // price, this SHOULD fill with vamm
			new BN(2).mul(BASE_PRECISION), // quantity, should be filled with next best bid (vAMM)
			PositionDirection.SHORT,
			vBid,
			vAsk,
			new BN(slot)
		);

		// auction ends, but order not expired
		const afterAuctionSlot = slot + 11;
		const afterAuctionTs = ts + 11;
		printBookState(dlob, marketIndex, vBid, vAsk, afterAuctionSlot, oracle);

		const nodesToFillAfter = dlob.findNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			afterAuctionSlot,
			afterAuctionTs,
			MarketType.PERP,
			oracle,
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);

		console.log(`Filled nodes: ${nodesToFillAfter.length}`);
		for (const n of nodesToFillAfter) {
			printCrossedNodes(n, afterAuctionSlot);
		}

		// taker should fill first order completely with best maker (1/1)
		expect(
			nodesToFillAfter[0].node.order?.orderId,
			'wrong taker orderId'
		).to.equal(4);
		expect(
			nodesToFillAfter[0].makerNodes[0]?.order?.orderId,
			'wrong maker orderId'
		).to.equal(3);

		// taker should fill second order completely with vamm
		expect(
			nodesToFillAfter[1].node.order?.orderId,
			'wrong taker orderId'
		).to.equal(5);
		expect(
			nodesToFillAfter[1].makerNodes[0]?.order?.orderId,
			'wrong maker orderId'
		).to.equal(2); // filler should match the DLOB makers, protocol will fill the taker with vAMM if it offers a better price.

		expect(nodesToFillAfter.length).to.equal(2);
	});

	it('Test fills crossing bids with vAMM after auction ends', () => {
		const vAsk = new BN(15).mul(PRICE_PRECISION);
		const vBid = new BN(8).mul(PRICE_PRECISION);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 12;
		const ts = 12;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)), // 11.5
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		// insert some floating limit buy below vAMM bid
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			new BN(17).mul(PRICE_PRECISION), // price, crosses vAsk
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(slot),
			new BN(200)
		);
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			3, // orderId
			marketIndex,
			new BN(19).mul(PRICE_PRECISION), // price; crosses vAsk
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(slot),
			new BN(200)
		);
		insertOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			1, // orderId
			marketIndex,
			new BN(5).mul(PRICE_PRECISION), // price; doens't cross
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(slot),
			new BN(200)
		);
		console.log(`Book state before fill:`);
		printBookState(dlob, marketIndex, vBid, vAsk, slot, oracle);

		const nodesToFillBefore = dlob.findNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			slot,
			ts,
			MarketType.PERP,
			oracle,
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// auction ends now
		const afterAuctionSlot = 11 + slot;
		const afterAuctionTs = 10 * ts;

		const nodesToFillAfter = dlob.findNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			afterAuctionSlot,
			afterAuctionTs,
			MarketType.PERP,
			oracle,
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);

		console.log(`Book state after fill:`);
		printBookState(dlob, marketIndex, vBid, vAsk, afterAuctionSlot, oracle);

		console.log(`Filled nodes: ${nodesToFillAfter.length}`);
		for (const n of nodesToFillAfter) {
			printCrossedNodes(n, afterAuctionSlot);
		}

		expect(
			nodesToFillAfter[0].node.order?.orderId,
			'wrong taker orderId'
		).to.equal(3);
		expect(
			nodesToFillAfter[0].makerNodes[0]?.order?.orderId,
			'wrong maker orderId'
		).to.equal(undefined);

		expect(
			nodesToFillAfter[1].node.order?.orderId,
			'wrong taker orderId'
		).to.equal(2);
		expect(
			nodesToFillAfter[1].makerNodes[0]?.order?.orderId,
			'wrong maker orderId'
		).to.equal(undefined);

		expect(nodesToFillAfter.length).to.equal(2);
	});

	it('Test fills two limit orders better than vAmm', () => {
		const vAsk = new BN(20).mul(PRICE_PRECISION);
		const vBid = new BN(5).mul(PRICE_PRECISION);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 12;
		const ts = 12;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)), // 11.5
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		// insert a sell below the bid, but above vBid
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			3, // orderId
			marketIndex,
			new BN(10).mul(PRICE_PRECISION), // price; crosses bid
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.SHORT,
			vAsk,
			vBid,
			new BN(slot),
			new BN(200),
			undefined,
			true,
			0
		);
		// insert a buy above the vBid
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			new BN(15).mul(PRICE_PRECISION), // price,
			new BN(8768).mul(BASE_PRECISION).div(new BN(10000)), // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(slot + 1), // later order becomes taker
			new BN(200),
			undefined,
			undefined,
			0
		);

		console.log(`Book state before fill:`);
		printBookState(dlob, marketIndex, vBid, vAsk, slot, oracle);

		const nodesToFillBefore = dlob.findNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			slot,
			ts,
			MarketType.PERP,
			oracle,
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);
		console.log(`Filled nodes: ${nodesToFillBefore.length}`);
		for (const n of nodesToFillBefore) {
			printCrossedNodes(n, slot);
		}
		expect(nodesToFillBefore.length).to.equal(1);

		// first order is maker, second is taker
		expect(
			nodesToFillBefore[0].node.order?.orderId,
			'wrong taker orderId'
		).to.equal(2);
		expect(
			nodesToFillBefore[0].makerNodes[0]?.order?.orderId,
			'wrong maker orderId'
		).to.equal(3);
	});

	it('Test fills 0 price market order with limit orders better than vAMM', () => {
		const vAsk = new BN(20).mul(PRICE_PRECISION);
		const vBid = new BN(5).mul(PRICE_PRECISION);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 12;
		const ts = 12;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		// resting bid above vBid (better)
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			new BN(15).mul(PRICE_PRECISION), // price,
			new BN(10).mul(BASE_PRECISION), // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(slot),
			new BN(200),
			undefined,
			true
		);

		// market sell into the resting bid
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			3, // orderId
			marketIndex,
			new BN(0), // price
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.SHORT,
			vAsk,
			vBid,
			new BN(slot),
			new BN(200)
		);

		console.log(`Book state before taker auction ends:`);
		printBookState(dlob, marketIndex, vBid, vAsk, slot, oracle);

		console.log(``);
		const auctionEndSlot = slot * 2;
		console.log(`Book state after taker auction ends:`);
		printBookState(dlob, marketIndex, vBid, vAsk, auctionEndSlot, oracle);

		const nodesToFillBefore = dlob.findNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			auctionEndSlot, // auction ends
			ts,
			MarketType.PERP,
			oracle,
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);
		console.log(`Nodes to fill: ${nodesToFillBefore.length}`);
		for (const n of nodesToFillBefore) {
			printCrossedNodes(n, slot);
		}
		expect(nodesToFillBefore.length).to.equal(1);

		// first order is maker, second is taker
		expect(
			nodesToFillBefore[0].node.order?.orderId,
			'wrong taker orderId'
		).to.equal(3);
		expect(
			nodesToFillBefore[0].makerNodes[0]?.order?.orderId,
			'wrong maker orderId'
		).to.equal(2);
	});

	it('Test vamm ask/bid bounds on maker orders', () => {
		const vAsk = new BN(20).mul(PRICE_PRECISION);
		const vBid = new BN(5).mul(PRICE_PRECISION);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();
		const user3 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 12;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)), // 11.5
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		// insert a sell that crosses amm bid
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			1, // orderId
			marketIndex,
			vBid.sub(PRICE_PRECISION),
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.SHORT,
			ZERO,
			ZERO,
			new BN(slot),
			new BN(200),
			undefined,
			undefined,
			0
		);

		// Market buy right above amm bid. crosses limit sell but can't be used
		insertOrderToDLOB(
			dlob,
			user3.publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			new BN(0), // price
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.LONG,
			vBid.add(PRICE_PRECISION),
			vAsk,
			new BN(slot),
			new BN(200)
		);

		// insert a limit buy above the amm ask
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			3, // orderId
			marketIndex,
			vAsk.add(PRICE_PRECISION), // price,
			new BN(8768).mul(BASE_PRECISION).div(new BN(10000)), // quantity
			PositionDirection.LONG,
			ZERO,
			ZERO,
			new BN(slot),
			undefined,
			undefined,
			undefined,
			0
		);

		// Market sell right below amm ask. crosses limit buy but can't be used
		insertOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			4, // orderId
			marketIndex,
			new BN(0), // price
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.SHORT,
			vAsk.sub(PRICE_PRECISION),
			vBid,
			new BN(slot),
			new BN(200)
		);

		console.log(`Book state before fill:`);
		printBookState(dlob, marketIndex, vBid, vAsk, slot, oracle);

		const nodesToFillBefore = dlob.findTakingNodesToFill(
			marketIndex,
			slot,
			MarketType.PERP,
			oracle,
			false,
			10,
			vAsk,
			vBid
		);

		expect(nodesToFillBefore.length).to.equal(2);
	});

	it('Test limit bid fills during auction', () => {
		const vAsk = new BN(20).mul(PRICE_PRECISION);
		const vBid = new BN(5).mul(PRICE_PRECISION);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();
		const user3 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 9;
		const ts = 9;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)), // 11.5
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		insertOrderToDLOB(
			dlob,
			user3.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			vAsk, // price
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.LONG,
			vBid.add(PRICE_PRECISION),
			vAsk,
			new BN(0),
			new BN(200),
			undefined,
			undefined,
			10
		);

		insertOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			4, // orderId
			marketIndex,
			vBid, // price
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.SHORT,
			vAsk.sub(PRICE_PRECISION),
			vBid,
			new BN(0),
			new BN(200),
			undefined,
			undefined,
			10
		);

		// insert a sell right above amm bid
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			5, // orderId
			marketIndex,
			oracle.price,
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.SHORT,
			ZERO,
			ZERO,
			new BN(slot),
			new BN(200),
			undefined,
			true,
			0
		);

		// insert a buy below the amm ask
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			6, // orderId
			marketIndex,
			oracle.price, // price,
			new BN(8768).mul(BASE_PRECISION).div(new BN(10000)), // quantity
			PositionDirection.LONG,
			ZERO,
			ZERO,
			new BN(slot),
			undefined,
			undefined,
			true,
			0
		);

		const nodesToFillAfter = dlob.findNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			slot,
			ts,
			MarketType.PERP,
			oracle,
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);

		expect(nodesToFillAfter.length).to.equal(2);

		expect(
			nodesToFillAfter[0].node.order?.orderId,
			'wrong taker orderId'
		).to.equal(4);
		expect(
			nodesToFillAfter[0].makerNodes[0]?.order?.orderId,
			'wrong maker orderId'
		).to.equal(6);

		expect(
			nodesToFillAfter[1].node.order?.orderId,
			'wrong taker orderId'
		).to.equal(2);
		expect(
			nodesToFillAfter[1].makerNodes[0]?.order?.orderId,
			'wrong maker orderId'
		).to.equal(5);
	});
});

describe('DLOB Spot Tests', () => {
	it('Test proper bids', () => {
		const vAsk = new BN(115);
		const vBid = new BN(100);
		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 12;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};
		const testCases = [
			{
				expectedIdx: 0,
				orderId: 5,
				price: new BN(0), // will calc 108
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
				slot: new BN(0),
				postOnly: false,
			},
			{
				expectedIdx: 1,
				orderId: 6,
				price: new BN(0), // will calc 108
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
				slot: new BN(1),
				postOnly: false,
			},
			{
				expectedIdx: 2,
				orderId: 7,
				price: new BN(0), // will calc 108
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
				slot: new BN(2),
				postOnly: false,
			},
			{
				expectedIdx: 4,
				orderId: 1,
				price: new BN(110),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				slot: new BN(0),
				postOnly: true,
			},
			{
				expectedIdx: 5,
				orderId: 2,
				price: new BN(109),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				slot: new BN(0),
				postOnly: true,
			},
			{
				expectedIdx: 6,
				orderId: 3,
				price: new BN(107),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				slot: new BN(0),
				postOnly: true,
			},
			{
				expectedIdx: 7,
				orderId: 4,
				price: new BN(106),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				slot: new BN(0),
				postOnly: true,
			},
		];

		for (const t of testCases) {
			const user0 = Keypair.generate();

			insertOrderToDLOB(
				dlob,
				user0.publicKey,
				t.orderType || OrderType.LIMIT,
				MarketType.SPOT,
				t.orderId || 0, // orderId
				marketIndex,
				t.price || new BN(0), // price
				BASE_PRECISION, // quantity
				t.direction || PositionDirection.LONG,
				!t.postOnly ? vBid : ZERO,
				!t.postOnly ? vAsk : ZERO,
				t.slot,
				undefined,
				undefined,
				t.postOnly
			);
		}

		const expectedTestCase = testCases.sort((a, b) => {
			// ascending order
			return a.expectedIdx - b.expectedIdx;
		});
		const bids = dlob.getBids(
			marketIndex,
			undefined,
			slot,
			MarketType.SPOT,
			oracle
		);

		console.log('The Book Bids:');
		let countBids = 0;
		for (const bid of bids) {
			printOrderNode(bid, oracle, slot);

			expect(bid.order?.orderId).to.equal(expectedTestCase[countBids].orderId);
			expect(bid.order?.price.toNumber()).to.equal(
				expectedTestCase[countBids].price?.toNumber()
			);
			expect(bid.order?.direction).to.equal(
				expectedTestCase[countBids].direction
			);
			expect(bid.order?.orderType).to.equal(
				expectedTestCase[countBids].orderType
			);
			countBids++;
		}

		expect(countBids).to.equal(testCases.length);
	});

	it('Test proper bids on multiple markets', () => {
		const vAsk = new BN(15);
		const vBid = new BN(10);
		const dlob = new DLOB();
		const marketIndex0 = 0;
		const marketIndex1 = 1;

		const slot = 12;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};
		const testCases = [
			{
				expectedIdx: 3,
				orderId: 5,
				price: new BN(0),
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
				marketIndex: marketIndex0,
			},
			{
				expectedIdx: 4,
				orderId: 6,
				price: new BN(0),
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
				marketIndex: marketIndex0,
			},
			{
				expectedIdx: 5,
				orderId: 7,
				price: new BN(0),
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
				marketIndex: marketIndex1,
			},
			{
				expectedIdx: 0,
				orderId: 1,
				price: new BN(12),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				marketIndex: marketIndex0,
			},
			{
				expectedIdx: 1,
				orderId: 2,
				price: new BN(11),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				marketIndex: marketIndex0,
			},
			{
				expectedIdx: 7,
				orderId: 3,
				price: new BN(8),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				marketIndex: marketIndex0,
			},
			{
				expectedIdx: 6,
				orderId: 4,
				price: new BN(9),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				marketIndex: marketIndex1,
			},
		];

		for (const t of testCases) {
			const user0 = Keypair.generate();

			insertOrderToDLOB(
				dlob,
				user0.publicKey,
				t.orderType || OrderType.LIMIT,
				MarketType.SPOT,
				t.orderId || 0, // orderId
				t.marketIndex,
				t.price || new BN(0), // price
				BASE_PRECISION, // quantity
				t.direction || PositionDirection.LONG,
				vBid,
				vAsk
			);
		}

		const bids0 = dlob.getBids(
			marketIndex0,
			vBid,
			slot,
			MarketType.SPOT,
			oracle
		);
		let countBids0 = 0;
		for (const bid of bids0) {
			console.log(
				` . vAMMNode? ${bid.isVammNode()}, ${JSON.stringify(
					bid.order?.orderType
				)} , ${bid.order?.orderId.toString()} , vammTestgetPRice: ${bid.getPrice(
					oracle,
					slot
				)}, price: ${bid.order?.price.toString()}, quantity: ${bid.order?.baseAssetAmountFilled.toString()}/${bid.order?.baseAssetAmount.toString()}`
			);
			countBids0++;
		}
		expect(countBids0).to.equal(5);

		const bids1 = dlob.getBids(
			marketIndex1,
			vBid,
			slot,
			MarketType.SPOT,
			oracle
		);
		let countBids1 = 0;
		for (const bid of bids1) {
			console.log(
				` . vAMMNode? ${bid.isVammNode()}, ${JSON.stringify(
					bid.order?.orderType
				)} , ${bid.order?.orderId.toString()} , vammTestgetPRice: ${bid.getPrice(
					oracle,
					slot
				)}, price: ${bid.order?.price.toString()}, quantity: ${bid.order?.baseAssetAmountFilled.toString()}/${bid.order?.baseAssetAmount.toString()}`
			);

			countBids1++;
		}
		expect(countBids1).to.equal(2);
	});

	it('Test proper asks', () => {
		const vAsk = new BN(15);
		const vBid = new BN(10);
		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 12;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};
		const testCases = [
			{
				expectedIdx: 0,
				orderId: 3,
				price: new BN(0),
				direction: PositionDirection.SHORT,
				orderType: OrderType.MARKET,
				slot: new BN(0),
				postOnly: false,
			},
			{
				expectedIdx: 1,
				orderId: 4,
				price: new BN(0),
				direction: PositionDirection.SHORT,
				orderType: OrderType.MARKET,
				slot: new BN(1),
				postOnly: false,
			},
			{
				expectedIdx: 2,
				orderId: 5,
				price: new BN(0),
				direction: PositionDirection.SHORT,
				orderType: OrderType.MARKET,
				slot: new BN(2),
				postOnly: false,
			},
			{
				expectedIdx: 3,
				orderId: 1,
				price: new BN(13),
				direction: PositionDirection.SHORT,
				orderType: OrderType.LIMIT,
				slot: new BN(3),
				postOnly: false,
			},
			{
				expectedIdx: 6,
				orderId: 6,
				price: new BN(16),
				direction: PositionDirection.SHORT,
				orderType: OrderType.LIMIT,
				slot: new BN(0),
				postOnly: true,
			},
			{
				expectedIdx: 7,
				orderId: 7,
				price: new BN(17),
				direction: PositionDirection.SHORT,
				orderType: OrderType.LIMIT,
				slot: new BN(0),
				postOnly: true,
			},
			{
				expectedIdx: 4,
				orderId: 2,
				price: new BN(14),
				direction: PositionDirection.SHORT,
				orderType: OrderType.LIMIT,
				slot: new BN(0),
				postOnly: true,
			},
		];

		for (const t of testCases) {
			const user0 = Keypair.generate();

			insertOrderToDLOB(
				dlob,
				user0.publicKey,
				t.orderType || OrderType.LIMIT,
				MarketType.SPOT,
				t.orderId || 0, // orderId
				marketIndex,
				t.price || new BN(0), // price
				BASE_PRECISION, // quantity
				t.direction || PositionDirection.SHORT,
				!t.postOnly ? vBid : ZERO,
				!t.postOnly ? vAsk : ZERO,
				t.slot,
				undefined,
				undefined,
				t.postOnly
			);
		}

		const expectedTestCase = testCases.sort((a, b) => {
			// ascending order
			return a.expectedIdx - b.expectedIdx;
		});
		const asks = dlob.getAsks(marketIndex, vAsk, slot, MarketType.SPOT, oracle);

		console.log('The Book Asks:');
		let countAsks = 0;
		for (const ask of asks) {
			console.log(
				` . vAMMNode? ${ask.isVammNode()}, ${JSON.stringify(
					ask.order?.orderType
				)} , ${ask.order?.orderId.toString()} , vammTestgetPRice: ${ask.getPrice(
					oracle,
					slot
				)}, price: ${ask.order?.price.toString()}, quantity: ${ask.order?.baseAssetAmountFilled.toString()}/${ask.order?.baseAssetAmount.toString()}`
			);

			expect(ask.order?.orderId).to.equal(expectedTestCase[countAsks].orderId);
			expect(ask.order?.price.toNumber()).to.equal(
				expectedTestCase[countAsks].price?.toNumber()
			);
			expect(ask.order?.direction).to.equal(
				expectedTestCase[countAsks].direction
			);
			expect(ask.order?.orderType).to.equal(
				expectedTestCase[countAsks].orderType
			);
			countAsks++;
		}

		expect(countAsks).to.equal(testCases.length);
	});

	it('Test insert market orders', () => {
		const slot = 12;
		const vAsk = new BN(110);
		const vBid = new BN(100);
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};
		const dlob = new DLOB();
		const marketIndex = 0;

		// 3 mkt buys
		for (let i = 0; i < 3; i++) {
			const user0 = Keypair.generate();

			insertOrderToDLOB(
				dlob,
				user0.publicKey,
				OrderType.MARKET,
				MarketType.SPOT,
				i + 1,
				marketIndex,
				new BN(0),
				BASE_PRECISION,
				PositionDirection.LONG,
				vBid,
				vAsk
			);
		}

		// 3 mkt sells
		for (let i = 0; i < 3; i++) {
			const user0 = Keypair.generate();

			insertOrderToDLOB(
				dlob,
				user0.publicKey,
				OrderType.MARKET,
				MarketType.SPOT,
				i + 1,
				marketIndex,
				new BN(0),
				BASE_PRECISION,
				PositionDirection.SHORT,
				vBid,
				vAsk
			);
		}

		let asks = 0;
		for (const ask of dlob.getAsks(
			marketIndex,
			vAsk,
			2,
			MarketType.SPOT,
			oracle
		)) {
			// vamm node is last in asks
			asks++;

			if (ask.order) {
				// market orders
				expect(getVariant(ask.order?.status)).to.equal('open');
				expect(getVariant(ask.order?.orderType)).to.equal('market');
				expect(getVariant(ask.order?.direction)).to.equal('short');
				expect(ask.order?.orderId).to.equal(asks);
			}
		}
		expect(asks).to.equal(3);

		let bids = 0;
		for (const bid of dlob.getBids(
			marketIndex,
			vBid,
			2,
			MarketType.SPOT,
			oracle
		)) {
			// market orders
			expect(getVariant(bid.order?.status)).to.equal('open');
			expect(getVariant(bid.order?.orderType)).to.equal('market');
			expect(getVariant(bid.order?.direction)).to.equal('long');
			expect(bid.order?.orderId).to.equal(bids + 1);
			bids++;
		}
		expect(bids).to.equal(3); // 3 orders
	});

	it('Test insert limit orders', () => {
		const vAsk = new BN(110);
		const vBid = new BN(100);
		const slot = 12;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();
		const user3 = Keypair.generate();
		const user4 = Keypair.generate();
		const user5 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			3, // orderId
			marketIndex,
			new BN(50),
			BASE_PRECISION,
			PositionDirection.LONG,
			vBid,
			vAsk
		);

		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			2, // orderId
			marketIndex,
			new BN(60),
			BASE_PRECISION,
			PositionDirection.LONG,
			vBid,
			vAsk
		);

		insertOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			1, // orderId
			marketIndex,
			new BN(70),
			BASE_PRECISION,
			PositionDirection.LONG,
			vBid,
			vAsk
		);

		insertOrderToDLOB(
			dlob,
			user3.publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			1, // orderId
			marketIndex,
			new BN(120),
			BASE_PRECISION,
			PositionDirection.SHORT,
			vBid,
			vAsk
		);

		insertOrderToDLOB(
			dlob,
			user4.publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			2, // orderId
			marketIndex,
			new BN(130),
			BASE_PRECISION,
			PositionDirection.SHORT,
			vBid,
			vAsk
		);

		insertOrderToDLOB(
			dlob,
			user5.publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			3, // orderId
			marketIndex,
			new BN(140),
			BASE_PRECISION,
			PositionDirection.SHORT,
			vBid,
			vAsk
		);

		let asks = 0;
		for (const ask of dlob.getAsks(
			marketIndex,
			vAsk,
			slot,
			MarketType.SPOT,
			oracle
		)) {
			if (!ask.order) {
				console.error('wtf ask vamm?');
				continue;
			}
			// market orders
			console.log(`ask price: ${ask.order?.price.toString()}`);
			expect(getVariant(ask.order?.status)).to.equal('open');
			expect(getVariant(ask.order?.orderType)).to.equal('limit');
			expect(getVariant(ask.order?.direction)).to.equal('short');
			expect(ask.order?.orderId).to.equal(asks + 1);
			expect(ask.order?.price.gt(vAsk)).to.equal(true);
			asks++;
		}
		expect(asks).to.equal(3);

		let bids = 0;
		for (const bid of dlob.getBids(
			marketIndex,
			vBid,
			slot,
			MarketType.SPOT,
			oracle
		)) {
			if (!bid.order) {
				console.error('wtf bid vamm?');
				continue;
			}
			// market orders
			console.log(`bid price: ${bid.order?.price.toString()}`);
			expect(getVariant(bid.order?.status)).to.equal('open');
			expect(getVariant(bid.order?.orderType)).to.equal('limit');
			expect(getVariant(bid.order?.direction)).to.equal('long');
			expect(bid.order?.orderId).to.equal(bids + 1);
			expect(bid.order?.price.lt(vBid)).to.equal(true);
			bids++;
		}
		expect(bids).to.equal(3);
	});

	it('Test multiple market orders fill with multiple limit orders', () => {
		const vAsk = new BN(15);
		const vBid = new BN(10);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();
		const user4 = Keypair.generate();
		const user5 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		// insert some limit buys above vamm bid, below ask
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			1, // orderId
			marketIndex,
			new BN(11), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			true
		);
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			2, // orderId
			marketIndex,
			new BN(12), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			true
		);
		insertOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			3, // orderId
			marketIndex,
			new BN(13), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			true
		);

		// should have no crossing orders
		const nodesToFillBefore = dlob.findNodesToFill(
			marketIndex,
			undefined,
			undefined,
			Date.now(),
			12, // auction over
			MarketType.SPOT,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(12),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			},
			mockStateAccount,
			mockSpotMarkets[marketIndex]
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// place two market sell order eating 2 of the limit orders
		insertOrderToDLOB(
			dlob,
			user4.publicKey,
			OrderType.MARKET,
			MarketType.SPOT,
			4, // orderId
			marketIndex,
			new BN(12), // price
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			user5.publicKey,
			OrderType.MARKET,
			MarketType.SPOT,
			5, // orderId
			marketIndex,
			new BN(12), // price
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk
		);

		const nodesToFillAfter = dlob.findNodesToFill(
			marketIndex,
			undefined,
			undefined,
			12, // auction over
			Date.now(),
			MarketType.SPOT,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(12),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			},
			mockStateAccount,
			mockSpotMarkets[marketIndex]
		);
		for (const n of nodesToFillAfter) {
			console.log(
				`cross found: taker orderId: ${n.node.order?.orderId.toString()}: BAA: ${n.node.order?.baseAssetAmount.toString()}, maker orderId: ${n.makerNodes[0]?.order?.orderId.toString()}: BAA: ${n.makerNodes[0]?.order?.baseAssetAmount.toString()}`
			);
		}
		expect(nodesToFillAfter.length).to.equal(2);

		// first taker should fill with best maker
		expect(nodesToFillAfter[0].node.order?.orderId).to.equal(4);
		expect(nodesToFillAfter[0].makerNodes[0]?.order?.orderId).to.equal(3);

		// second taker should fill with second best maker
		expect(nodesToFillAfter[1].node.order?.orderId).to.equal(5);
		expect(nodesToFillAfter[1].makerNodes[0]?.order?.orderId).to.equal(2);
	});

	it('Test one market order fills two limit orders', () => {
		const vAsk = new BN(15);
		const vBid = new BN(10);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();
		const user3 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		// insert some limit sells below vAMM ask, above bid
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			1, // orderId
			marketIndex,
			new BN(14), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			true
		);
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			2, // orderId
			marketIndex,
			new BN(12), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			true
		);
		insertOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			3, // orderId
			marketIndex,
			new BN(11), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			true
		);

		// should have no crossing orders
		const nodesToFillBefore = dlob.findNodesToFill(
			marketIndex,
			undefined,
			undefined,
			12, // auction over
			Date.now(),
			MarketType.SPOT,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(12),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			},
			mockStateAccount,
			mockSpotMarkets[marketIndex]
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// place one market buy order eating 2 of the limit orders
		insertOrderToDLOB(
			dlob,
			user3.publicKey,
			OrderType.MARKET,
			MarketType.SPOT,
			4, // orderId
			marketIndex,
			new BN(12), // price
			new BN(2).mul(BASE_PRECISION), // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);

		const nodesToFillAfter = dlob.findNodesToFill(
			marketIndex,
			undefined,
			undefined,
			12, // auction over
			Date.now(),
			MarketType.SPOT,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(12),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			},
			mockStateAccount,
			mockSpotMarkets[marketIndex]
		);
		for (const n of nodesToFillAfter) {
			console.log(
				`cross found: taker orderId: ${n.node.order?.orderId.toString()}: BAA: ${n.node.order?.baseAssetAmountFilled.toString()}/${n.node.order?.baseAssetAmount.toString()}, maker orderId: ${n.makerNodes[0]?.order?.orderId.toString()}: BAA: ${n.makerNodes[0]?.order?.baseAssetAmountFilled.toString()}/${n.makerNodes[0]?.order?.baseAssetAmount.toString()}`
			);
		}
		expect(nodesToFillAfter.length).to.equal(1);

		// taker should fill completely with best maker
		expect(nodesToFillAfter[0].makerNodes.length).to.equal(2);
	});

	it('Test two market orders to fill one limit order', () => {
		const fallbackAsk = new BN(15);
		const fallbackBid = new BN(8);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();
		const user3 = Keypair.generate();
		const user4 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 12;
		const oracle = {
			price: fallbackBid.add(fallbackAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		// insert some limit sells below vAMM ask, above bid
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			1, // orderId
			marketIndex,
			new BN(14), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			fallbackBid,
			fallbackAsk,
			undefined,
			undefined,
			undefined,
			true
		);
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			2, // orderId
			marketIndex,
			new BN(13), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			fallbackBid,
			fallbackAsk,
			undefined,
			undefined,
			undefined,
			true
		);
		insertOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			3, // orderId
			marketIndex,
			new BN(8), // price <-- best price
			new BN(3).mul(BASE_PRECISION), // quantity
			PositionDirection.SHORT,
			fallbackBid,
			fallbackAsk,
			undefined,
			undefined,
			undefined,
			true
		);

		// should have no crossing orders
		const nodesToFillBefore = dlob.findNodesToFill(
			marketIndex,
			undefined,
			undefined,
			12, // auction over
			Date.now(),
			MarketType.SPOT,
			oracle,
			mockStateAccount,
			mockSpotMarkets[marketIndex]
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// place two market buy orders to eat the best ask
		insertOrderToDLOB(
			dlob,
			user3.publicKey,
			OrderType.MARKET,
			MarketType.SPOT,
			4, // orderId
			marketIndex,
			fallbackAsk, // price
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.LONG,
			fallbackBid,
			fallbackAsk
		);
		insertOrderToDLOB(
			dlob,
			user4.publicKey,
			OrderType.MARKET,
			MarketType.SPOT,
			5, // orderId
			marketIndex,
			fallbackAsk, // price
			new BN(2).mul(BASE_PRECISION), // quantity
			PositionDirection.LONG,
			fallbackBid,
			fallbackAsk
		);

		const nodesToFillAfter = dlob.findNodesToFill(
			marketIndex,
			undefined,
			undefined,
			slot, // auction over
			Date.now(),
			MarketType.SPOT,
			oracle,
			mockStateAccount,
			mockSpotMarkets[marketIndex]
		);
		const mktNodes = dlob.findExpiredNodesToFill(
			marketIndex,
			slot,
			MarketType.SPOT
		);
		console.log(`market nodes: ${mktNodes.length}`);

		printBookState(dlob, marketIndex, fallbackBid, fallbackAsk, slot, oracle);

		for (const n of nodesToFillAfter) {
			console.log(
				`cross found: taker orderId: ${n.node.order?.orderId.toString()}: BAA: ${n.node.order?.baseAssetAmountFilled.toString()}/${n.node.order?.baseAssetAmount.toString()}, maker orderId: ${n.makerNodes[0]?.order?.orderId.toString()}: BAA: ${n.makerNodes[0]?.order?.baseAssetAmountFilled.toString()}/${n.makerNodes[0]?.order?.baseAssetAmount.toString()}`
			);
		}
		expect(nodesToFillAfter.length).to.equal(2);

		// taker should fill completely with best maker
		expect(nodesToFillAfter[0].node.order?.orderId).to.equal(4);
		expect(nodesToFillAfter[0].makerNodes[0]?.order?.orderId).to.equal(3);

		// taker should fill completely with second best maker
		expect(nodesToFillAfter[1].node.order?.orderId).to.equal(5);
		expect(nodesToFillAfter[1].makerNodes[0]?.order?.orderId).to.equal(3);
	});

	it('Test market orders skipping maker with same authority', () => {
		const vAsk = new BN(15);
		const vBid = new BN(8);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 12;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		// insert some limit sells below vAMM ask, above bid
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			1, // orderId
			marketIndex,
			new BN(14), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			true
		);
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			new BN(13), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			undefined,
			undefined,
			undefined,
			true
		);

		// should have no crossing orders
		const nodesToFillBefore = dlob.findNodesToFill(
			marketIndex,
			undefined,
			undefined,
			12, // auction over
			Date.now(),
			MarketType.PERP,
			oracle,
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// place two market buy orders to eat the best ask
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			3, // orderId
			marketIndex,
			new BN(0), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			4, // orderId
			marketIndex,
			new BN(0), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);

		const nodesToFillAfter = dlob.findNodesToFill(
			marketIndex,
			undefined,
			undefined,
			slot, // auction over
			Date.now(),
			MarketType.PERP,
			oracle,
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);

		printBookState(dlob, marketIndex, vBid, vAsk, slot, oracle);

		for (const n of nodesToFillAfter) {
			console.log(
				`cross found: taker orderId: ${n.node.order?.orderId.toString()}: BAA: ${n.node.order?.baseAssetAmountFilled.toString()}/${n.node.order?.baseAssetAmount.toString()}, maker orderId: ${n.makerNodes[0]?.order?.orderId.toString()}: BAA: ${n.makerNodes[0]?.order?.baseAssetAmountFilled.toString()}/${n.makerNodes[0]?.order?.baseAssetAmount.toString()}`
			);
		}
		expect(nodesToFillAfter.length).to.equal(2);

		// taker should fill completely with best maker
		expect(nodesToFillAfter[0].node.order?.orderId).to.equal(3);
		expect(nodesToFillAfter[0].makerNodes[0]?.order?.orderId).to.equal(1);

		// taker should fill completely with second best maker
		expect(nodesToFillAfter[1].node.order?.orderId).to.equal(4);
		expect(nodesToFillAfter[1].makerNodes[0]?.order?.orderId).to.equal(2);
	});

	it('Test limit orders skipping maker with same authority', () => {
		const vAsk = new BN(15);
		const vBid = new BN(8);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 12;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		// insert some limit sells below vAMM ask, above bid
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			1, // orderId
			marketIndex,
			new BN(14), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			new BN(1)
		);
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			new BN(13), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			new BN(1)
		);

		// should have no crossing orders
		const nodesToFillBefore = dlob.findNodesToFill(
			marketIndex,
			undefined,
			undefined,
			12, // auction over
			Date.now(),
			MarketType.PERP,
			oracle,
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// place two market buy orders to eat the best ask
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			3, // orderId
			marketIndex,
			new BN(15), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(0),
			undefined,
			undefined,
			true
		);
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			4, // orderId
			marketIndex,
			new BN(14), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(0),
			undefined,
			undefined,
			true
		);

		const nodesToFillAfter = dlob.findNodesToFill(
			marketIndex,
			undefined,
			undefined,
			slot, // auction over
			Date.now(),
			MarketType.PERP,
			oracle,
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);

		printBookState(dlob, marketIndex, vBid, vAsk, slot, oracle);

		for (const n of nodesToFillAfter) {
			console.log(
				`cross found: taker orderId: ${n.node.order?.orderId.toString()}: BAA: ${n.node.order?.baseAssetAmountFilled.toString()}/${n.node.order?.baseAssetAmount.toString()}, maker orderId: ${n.makerNodes[0]?.order?.orderId.toString()}: BAA: ${n.makerNodes[0]?.order?.baseAssetAmountFilled.toString()}/${n.makerNodes[0]?.order?.baseAssetAmount.toString()}`
			);
		}
		expect(nodesToFillAfter.length).to.equal(2);

		// taker should fill completely with best maker
		expect(nodesToFillAfter[0].node.order?.orderId).to.equal(2);
		expect(nodesToFillAfter[0].makerNodes[0]?.order?.orderId).to.equal(4);

		// taker should fill completely with second best maker
		expect(nodesToFillAfter[1].node.order?.orderId).to.equal(1);
		expect(nodesToFillAfter[1].makerNodes[0]?.order?.orderId).to.equal(3);
	});

	// add back if dlob checks limit order age again
	it.skip('Test limit orders skipping more recent post onlys', () => {
		const vAsk = new BN(15);
		const vBid = new BN(8);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 12;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		// insert some limit sells below vAMM ask, above bid
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			1, // orderId
			marketIndex,
			new BN(14), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			new BN(1)
		);
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			2, // orderId
			marketIndex,
			new BN(13), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk,
			new BN(1)
		);

		// should have no crossing orders
		const nodesToFillBefore = dlob.findNodesToFill(
			marketIndex,
			undefined,
			undefined,
			12, // auction over
			Date.now(),
			MarketType.PERP,
			oracle,
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// add post only orders that are newer than resting limit orders and thus cant match
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			3, // orderId
			marketIndex,
			new BN(15), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(2),
			undefined,
			undefined,
			true
		);
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			4, // orderId
			marketIndex,
			new BN(14), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(2),
			undefined,
			undefined,
			true
		);

		let nodesToFillAfter = dlob.findNodesToFill(
			marketIndex,
			undefined,
			undefined,
			slot, // auction over
			Date.now(),
			MarketType.PERP,
			oracle,
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);

		expect(nodesToFillAfter.length).to.equal(0);

		// add post only orders that are older than resting limit orders
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			5, // orderId
			marketIndex,
			new BN(15), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(0),
			undefined,
			undefined,
			true
		);
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			6, // orderId
			marketIndex,
			new BN(14), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(0),
			undefined,
			undefined,
			true
		);

		nodesToFillAfter = dlob.findNodesToFill(
			marketIndex,
			undefined,
			undefined,
			slot, // auction over
			Date.now(),
			MarketType.PERP,
			oracle,
			mockStateAccount,
			mockPerpMarkets[marketIndex]
		);

		expect(nodesToFillAfter.length).to.equal(2);

		printBookState(dlob, marketIndex, vBid, vAsk, slot, oracle);

		for (const n of nodesToFillAfter) {
			console.log(
				`cross found: taker orderId: ${n.node.order?.orderId.toString()}: BAA: ${n.node.order?.baseAssetAmountFilled.toString()}/${n.node.order?.baseAssetAmount.toString()}, maker orderId: ${n.makerNodes[0]?.order?.orderId.toString()}: BAA: ${n.makerNodes[0]?.order?.baseAssetAmountFilled.toString()}/${n.makerNodes[0]?.order?.baseAssetAmount.toString()}`
			);
		}
		expect(nodesToFillAfter.length).to.equal(2);

		// taker should fill completely with best maker
		expect(nodesToFillAfter[0].node.order?.orderId).to.equal(2);
		expect(nodesToFillAfter[0].makerNodes[0]?.order?.orderId).to.equal(6);

		// taker should fill completely with second best maker
		expect(nodesToFillAfter[1].node.order?.orderId).to.equal(1);
		expect(nodesToFillAfter[1].makerNodes[0]?.order?.orderId).to.equal(5);
	});

	it('Test trigger orders', () => {
		const vAsk = new BN(15);
		const vBid = new BN(8);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();
		const user3 = Keypair.generate();
		const user4 = Keypair.generate();
		const user5 = Keypair.generate();
		const user6 = Keypair.generate();
		const user7 = Keypair.generate();
		const user8 = Keypair.generate();
		const user9 = Keypair.generate();
		const user10 = Keypair.generate();
		const user11 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 20;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		const orderIdsToTrigger = [1, 2, 3, 4, 5, 6, 7, 8];
		// const orderIdsToNotTrigger = [9, 10, 11, 12];

		// should trigger limit buy with above condition
		insertTriggerOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.TRIGGER_LIMIT,
			MarketType.SPOT,
			1, //orderId
			marketIndex, // marketIndex
			vBid, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.LONG,
			oracle.price.sub(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.ABOVE, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);
		// should trigger limit sell with above condition
		insertTriggerOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.TRIGGER_LIMIT,
			MarketType.SPOT,
			2, //orderId
			marketIndex, // marketIndex
			vBid, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.SHORT,
			oracle.price.sub(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.ABOVE, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);
		// should trigger market buy with above condition
		insertTriggerOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.SPOT,
			3, //orderId
			marketIndex, // marketIndex
			vAsk, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.LONG,
			oracle.price.sub(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.ABOVE, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);
		// should trigger market sell with above condition
		insertTriggerOrderToDLOB(
			dlob,
			user3.publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.SPOT,
			4, //orderId
			marketIndex, // marketIndex
			vBid, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.SHORT,
			oracle.price.sub(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.ABOVE, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);
		// should trigger limit buy with below condition
		insertTriggerOrderToDLOB(
			dlob,
			user4.publicKey,
			OrderType.TRIGGER_LIMIT,
			MarketType.SPOT,
			5, //orderId
			marketIndex, // marketIndex
			vBid, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.LONG,
			oracle.price.add(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.BELOW, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);
		// should trigger limit sell with below condition
		insertTriggerOrderToDLOB(
			dlob,
			user5.publicKey,
			OrderType.TRIGGER_LIMIT,
			MarketType.SPOT,
			6, //orderId
			marketIndex, // marketIndex
			vBid, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.SHORT,
			oracle.price.add(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.BELOW, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);
		// should trigger market buy with below condition
		insertTriggerOrderToDLOB(
			dlob,
			user6.publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.SPOT,
			7, //orderId
			marketIndex, // marketIndex
			vBid, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.LONG,
			oracle.price.add(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.BELOW, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);
		// should trigger market sell with below condition
		insertTriggerOrderToDLOB(
			dlob,
			user7.publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.SPOT,
			8, //orderId
			marketIndex, // marketIndex
			vBid, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.LONG,
			oracle.price.add(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.BELOW, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);

		// should NOT trigger market sell with above condition
		insertTriggerOrderToDLOB(
			dlob,
			user8.publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.SPOT,
			9, //orderId
			marketIndex, // marketIndex
			vBid, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.SHORT,
			oracle.price.add(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.ABOVE, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);
		// should NOT trigger market sell with below condition
		insertTriggerOrderToDLOB(
			dlob,
			user9.publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.SPOT,
			10, //orderId
			marketIndex, // marketIndex
			vBid, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.SHORT,
			oracle.price.sub(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.BELOW, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);
		// should NOT trigger market buy with above condition
		insertTriggerOrderToDLOB(
			dlob,
			user10.publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.SPOT,
			11, //orderId
			marketIndex, // marketIndex
			vBid, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.LONG,
			oracle.price.add(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.ABOVE, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);
		// should NOT trigger market buy with below condition
		insertTriggerOrderToDLOB(
			dlob,
			user11.publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.SPOT,
			12, //orderId
			marketIndex, // marketIndex
			vBid, // price
			BASE_PRECISION, // baseAssetAmount: BN,
			PositionDirection.LONG,
			oracle.price.sub(new BN(1)), // triggerPrice: BN,
			OrderTriggerCondition.BELOW, // triggerCondition: OrderTriggerCondition,
			vBid,
			vAsk
		);

		const nodesToTrigger = dlob.findNodesToTrigger(
			marketIndex,
			slot,
			oracle.price,
			MarketType.SPOT,
			mockStateAccount
		);
		for (const [idx, n] of nodesToTrigger.entries()) {
			expect(n.node.order?.orderId).to.equal(orderIdsToTrigger[idx]);
		}
	});

	it('Test will return expired market orders to fill', () => {
		const vAsk = new BN(15);
		const vBid = new BN(8);

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;

		const slot = 20;
		const ts = 20;
		const maxTs = new BN(30);

		// non crossing bid
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.MARKET,
			MarketType.SPOT,
			255, // orderId
			marketIndex,
			new BN(2), // price, very low, don't cross vamm
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(slot),
			maxTs
		);
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.MARKET,
			MarketType.SPOT,
			2, // orderId
			marketIndex,
			new BN(30), // price, very high, don't cross vamm
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vAsk,
			vBid,
			new BN(slot),
			maxTs
		);

		// order auction is not yet complete, and order is not expired.
		const slot0 = slot;
		const ts0 = ts;
		const nodesToFillBefore = dlob.findNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			slot0,
			ts0,
			MarketType.SPOT,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(slot0),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			},
			mockStateAccount,
			mockSpotMarkets[marketIndex]
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// should get order to fill after timeInForce
		const slot1 = slot0 + slot * 2; // overshoots expiry
		const ts1 = ts + ts * 2;
		const nodesToFillAfter = dlob.findNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			slot1,
			ts1,
			MarketType.SPOT,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(slot1),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			},
			mockStateAccount,
			mockSpotMarkets[marketIndex]
		);
		expect(nodesToFillAfter.length).to.equal(2);

		// check that the nodes have no makers
		expect(nodesToFillAfter[0].makerNodes.length).to.equal(0);
		expect(nodesToFillAfter[1].makerNodes.length).to.equal(0);
	});

	it('DLOB estimateFillExactBaseAmount spot buy', () => {
		const vAsk = new BN(20790000);
		const vBid = new BN(20580000);

		let slot = 1;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;
		const marketType = MarketType.SPOT;

		const b1 = BASE_PRECISION;
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			marketType,
			1, // orderId
			marketIndex,
			new BN(20690000), // price
			b1, // quantity
			PositionDirection.SHORT,
			vAsk,
			vBid,
			new BN(1)
		);
		const b2 = new BN(2).mul(BASE_PRECISION);
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			marketType,
			2, // orderId
			marketIndex,
			new BN(20700000), // price
			b2, // quantity
			PositionDirection.SHORT,
			vAsk,
			vBid,
			new BN(1)
		);
		const b3 = new BN(3).mul(BASE_PRECISION);
		insertOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.LIMIT,
			marketType,
			3, // orderId
			marketIndex,
			new BN(20710000), // price
			b3, // quantity
			PositionDirection.SHORT,
			vAsk,
			vBid,
			new BN(1)
		);

		slot += 11;

		const restingAsks = Array.from(
			dlob.getRestingLimitAsks(marketIndex, slot, marketType, oracle)
		);

		expect(restingAsks.length).to.equal(3);

		const baseAmount = new BN(4).mul(BASE_PRECISION);
		const out = dlob.estimateFillWithExactBaseAmount({
			marketIndex,
			marketType,
			baseAmount,
			orderDirection: PositionDirection.LONG,
			slot,
			oraclePriceData: oracle,
		});
		const quoteAmtOut = convertToNumber(out, QUOTE_PRECISION);

		// 1 * 20.69 + 2 * 20.70 + 1 * 20.71 = 82.8
		expect(quoteAmtOut === 82.8).to.be.true;
	});

	it('DLOB estimateFillExactBaseAmount spot sell', () => {
		const vAsk = new BN(20790000);
		const vBid = new BN(20580000);

		let slot = 1;
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(slot),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		const user0 = Keypair.generate();
		const user1 = Keypair.generate();
		const user2 = Keypair.generate();

		const dlob = new DLOB();
		const marketIndex = 0;
		const marketType = MarketType.SPOT;

		const b1 = BASE_PRECISION;
		insertOrderToDLOB(
			dlob,
			user0.publicKey,
			OrderType.LIMIT,
			marketType,
			1, // orderId
			marketIndex,
			new BN(20690000), // price
			b1, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(1)
		);
		const b2 = new BN(2).mul(BASE_PRECISION);
		insertOrderToDLOB(
			dlob,
			user1.publicKey,
			OrderType.LIMIT,
			marketType,
			2, // orderId
			marketIndex,
			new BN(20680000), // price
			b2, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(1)
		);
		const b3 = new BN(3).mul(BASE_PRECISION);
		insertOrderToDLOB(
			dlob,
			user2.publicKey,
			OrderType.LIMIT,
			marketType,
			3, // orderId
			marketIndex,
			new BN(20670000), // price
			b3, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(1)
		);

		slot += 11;

		const restingBids = Array.from(
			dlob.getRestingLimitBids(marketIndex, slot, marketType, oracle)
		);

		expect(restingBids.length).to.equal(3);

		const baseAmount = new BN(4).mul(BASE_PRECISION);
		const out = dlob.estimateFillWithExactBaseAmount({
			marketIndex,
			marketType,
			baseAmount,
			orderDirection: PositionDirection.SHORT,
			slot,
			oraclePriceData: oracle,
		});
		const quoteAmtOut = convertToNumber(out, QUOTE_PRECISION);

		// 1 * 20.69 + 2 * 20.68 + 1 * 20.67 = 82.72
		expect(quoteAmtOut === 82.72).to.be.true;
	});
});

describe('Uncross L2', () => {
	it('Bid crosses ask above oracle (no premium)', () => {
		const bids = [
			{
				price: new BN(104).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
			{
				price: new BN(103).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
			{
				price: new BN(102).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { dlob: new BN(1).mul(BASE_PRECISION) },
			},
			{
				price: new BN(100).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
		];

		const asks = [
			{
				price: new BN(101).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
			{
				price: new BN(102).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
		];

		const oraclePrice = new BN(100).mul(QUOTE_PRECISION);
		const oraclePrice5Min = new BN(100).mul(QUOTE_PRECISION);
		const markPrice5Min = new BN(100).mul(QUOTE_PRECISION);

		const groupingSize = QUOTE_PRECISION.divn(10);

		const { bids: newBids, asks: newAsks } = uncrossL2(
			bids,
			asks,
			oraclePrice,
			oraclePrice5Min,
			markPrice5Min,
			groupingSize,
			new Set<string>(),
			new Set<string>()
		);

		expect(newBids[0].price.toString()).to.equal(
			new BN(101).mul(QUOTE_PRECISION).sub(groupingSize).toString()
		);
		expect(newBids[0].size.toString()).to.equal(
			new BN(3).mul(BASE_PRECISION).toString()
		);
		expect(newBids[0].sources['vamm'].toString()).to.equal(
			new BN(2).mul(BASE_PRECISION).toString()
		);
		expect(newBids[0].sources['dlob'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);

		expect(newBids[1].price.toString()).to.equal(
			new BN(100).mul(QUOTE_PRECISION).toString()
		);
		expect(newBids[1].size.toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newBids[1].sources['vamm'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);

		expect(newAsks[0].price.toString()).to.equal(
			new BN(101).mul(QUOTE_PRECISION).toString()
		);
		expect(newAsks[0].size.toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newAsks[0].sources['vamm'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);

		expect(newAsks[1].price.toString()).to.equal(
			new BN(102).mul(QUOTE_PRECISION).toString()
		);
		expect(newAsks[1].size.toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newAsks[1].sources['vamm'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
	});

	it('Ask crosses ask below oracle, (new premium)', () => {
		const bids = [
			{
				price: new BN(99).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
			{
				price: new BN(98).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
		];

		const asks = [
			{
				price: new BN(96).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
			{
				price: new BN(97).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
			{
				price: new BN(98).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { dlob: new BN(1).mul(BASE_PRECISION) },
			},
			{
				price: new BN(100).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
		];

		const oraclePrice = new BN(100).mul(QUOTE_PRECISION);
		const oraclePrice5Min = new BN(100).mul(QUOTE_PRECISION);
		const markPrice5Min = new BN(100).mul(QUOTE_PRECISION);

		const groupingSize = QUOTE_PRECISION.divn(10);

		const { bids: newBids, asks: newAsks } = uncrossL2(
			bids,
			asks,
			oraclePrice,
			oraclePrice5Min,
			markPrice5Min,
			groupingSize,
			new Set<string>(),
			new Set<string>()
		);

		expect(newBids[0].price.toString()).to.equal(
			new BN(99).mul(QUOTE_PRECISION).toString()
		);
		expect(newBids[0].size.toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newBids[0].sources['vamm'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);

		expect(newBids[1].price.toString()).to.equal(
			new BN(98).mul(QUOTE_PRECISION).toString()
		);
		expect(newBids[1].size.toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newBids[1].sources['vamm'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);

		expect(newAsks[0].price.toString()).to.equal(
			new BN(99).mul(QUOTE_PRECISION).add(groupingSize).toString()
		);
		expect(newAsks[0].size.toString()).to.equal(
			new BN(3).mul(BASE_PRECISION).toString()
		);
		expect(newAsks[0].sources['vamm'].toString()).to.equal(
			new BN(2).mul(BASE_PRECISION).toString()
		);
		expect(newAsks[0].sources['dlob'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);

		expect(newAsks[1].price.toString()).to.equal(
			new BN(100).mul(QUOTE_PRECISION).toString()
		);
		expect(newAsks[1].size.toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newAsks[1].sources['vamm'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
	});

	it('No cross (no premium)', () => {
		const bids = [
			{
				price: new BN(99).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
			{
				price: new BN(98).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
			{
				price: new BN(97).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
		];

		const asks = [
			{
				price: new BN(101).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
			{
				price: new BN(102).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
		];

		const oraclePrice = new BN(100).mul(QUOTE_PRECISION);
		const oraclePrice5Min = new BN(100).mul(QUOTE_PRECISION);
		const markPrice5Min = new BN(100).mul(QUOTE_PRECISION);

		const groupingSize = QUOTE_PRECISION.divn(10);

		const { bids: newBids, asks: newAsks } = uncrossL2(
			bids,
			asks,
			oraclePrice,
			oraclePrice5Min,
			markPrice5Min,
			groupingSize,
			new Set<string>(),
			new Set<string>()
		);

		expect(newBids[0].price.toString()).to.equal(
			new BN(99).mul(QUOTE_PRECISION).toString()
		);
		expect(newBids[0].size.toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newBids[0].sources['vamm'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);

		expect(newBids[1].price.toString()).to.equal(
			new BN(98).mul(QUOTE_PRECISION).toString()
		);
		expect(newBids[1].size.toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newBids[1].sources['vamm'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);

		expect(newBids[2].price.toString()).to.equal(
			new BN(97).mul(QUOTE_PRECISION).toString()
		);
		expect(newBids[2].size.toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newBids[2].sources['vamm'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);

		expect(newAsks[0].price.toString()).to.equal(
			new BN(101).mul(QUOTE_PRECISION).toString()
		);
		expect(newAsks[0].size.toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newAsks[0].sources['vamm'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);

		expect(newAsks[1].price.toString()).to.equal(
			new BN(102).mul(QUOTE_PRECISION).toString()
		);
		expect(newAsks[1].size.toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newAsks[1].sources['vamm'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
	});

	it('Crossed on opposite sides of reference price', () => {
		const bids = [
			{
				price: new BN(32).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { dlob: new BN(1).mul(BASE_PRECISION) },
			},
		];

		const asks = [
			{
				price: new BN(29).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
		];

		const oraclePrice = new BN('29250100');
		const oraclePrice5Min = new BN('29696597');
		const markPrice5Min = new BN('31747865');

		const groupingSize = QUOTE_PRECISION.divn(10);

		const { bids: newBids, asks: newAsks } = uncrossL2(
			bids,
			asks,
			oraclePrice,
			oraclePrice5Min,
			markPrice5Min,
			groupingSize,
			new Set<string>(),
			new Set<string>()
		);

		const referencePrice = oraclePrice.add(markPrice5Min.sub(oraclePrice5Min));

		expect(newBids[0].price.toString()).to.equal(
			referencePrice.sub(groupingSize).toString()
		);
		expect(newBids[0].size.toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newBids[0].sources['dlob'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);

		expect(newAsks[0].price.toString()).to.equal(
			referencePrice.add(groupingSize).toString()
		);
		expect(newAsks[0].size.toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newAsks[0].sources['vamm'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
	});

	it('Skip user with bid', () => {
		const bids = [
			{
				price: new BN(104).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { dlob: new BN(1).mul(BASE_PRECISION) },
			},
			{
				price: new BN(103).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
			{
				price: new BN(102).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { dlob: new BN(1).mul(BASE_PRECISION) },
			},
			{
				price: new BN(100).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
		];

		const asks = [
			{
				price: new BN(101).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
			{
				price: new BN(102).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
		];

		const oraclePrice = new BN(100).mul(QUOTE_PRECISION);
		const oraclePrice5Min = new BN(100).mul(QUOTE_PRECISION);
		const markPrice5Min = new BN(100).mul(QUOTE_PRECISION);

		const groupingSize = QUOTE_PRECISION.divn(10);

		const userBids = new Set<string>([
			new BN(104).mul(QUOTE_PRECISION).toString(),
		]);
		const { bids: newBids, asks: newAsks } = uncrossL2(
			bids,
			asks,
			oraclePrice,
			oraclePrice5Min,
			markPrice5Min,
			groupingSize,
			userBids,
			new Set<string>()
		);

		expect(newBids[0].price.toString()).to.equal(
			new BN(104).mul(QUOTE_PRECISION).toString()
		);
		expect(newBids[0].size.toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newBids[0].sources['dlob'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);

		expect(newBids[1].price.toString()).to.equal(
			new BN(101).mul(QUOTE_PRECISION).sub(groupingSize).toString()
		);
		expect(newBids[1].size.toString()).to.equal(
			new BN(2).mul(BASE_PRECISION).toString()
		);
		expect(newBids[1].sources['vamm'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newBids[1].sources['dlob'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);

		expect(newBids[2].price.toString()).to.equal(
			new BN(100).mul(QUOTE_PRECISION).toString()
		);
		expect(newBids[2].size.toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newBids[2].sources['vamm'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);

		expect(newAsks[0].price.toString()).to.equal(
			new BN(101).mul(QUOTE_PRECISION).toString()
		);
		expect(newAsks[0].size.toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newAsks[0].sources['vamm'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);

		expect(newAsks[1].price.toString()).to.equal(
			new BN(102).mul(QUOTE_PRECISION).toString()
		);
		expect(newAsks[1].size.toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newAsks[1].sources['vamm'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
	});

	it('Skip user with ask', () => {
		const bids = [
			{
				price: new BN(99).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
			{
				price: new BN(98).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
		];

		const asks = [
			{
				price: new BN(96).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { dlob: new BN(1).mul(BASE_PRECISION) },
			},
			{
				price: new BN(97).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
			{
				price: new BN(98).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { dlob: new BN(1).mul(BASE_PRECISION) },
			},
			{
				price: new BN(100).mul(QUOTE_PRECISION),
				size: new BN(1).mul(BASE_PRECISION),
				sources: { vamm: new BN(1).mul(BASE_PRECISION) },
			},
		];

		const oraclePrice = new BN(100).mul(QUOTE_PRECISION);
		const oraclePrice5Min = new BN(100).mul(QUOTE_PRECISION);
		const markPrice5Min = new BN(100).mul(QUOTE_PRECISION);

		const groupingSize = QUOTE_PRECISION.divn(10);

		const userAsks = new Set<string>([
			new BN(96).mul(QUOTE_PRECISION).toString(),
		]);
		const { bids: newBids, asks: newAsks } = uncrossL2(
			bids,
			asks,
			oraclePrice,
			oraclePrice5Min,
			markPrice5Min,
			groupingSize,
			new Set<string>(),
			userAsks
		);

		expect(newBids[0].price.toString()).to.equal(
			new BN(99).mul(QUOTE_PRECISION).toString()
		);
		expect(newBids[0].size.toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newBids[0].sources['vamm'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);

		expect(newBids[1].price.toString()).to.equal(
			new BN(98).mul(QUOTE_PRECISION).toString()
		);
		expect(newBids[1].size.toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newBids[1].sources['vamm'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);

		expect(newAsks[0].price.toString()).to.equal(
			new BN(96).mul(QUOTE_PRECISION).toString()
		);
		expect(newAsks[0].size.toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newAsks[0].sources['dlob'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);

		expect(newAsks[1].price.toString()).to.equal(
			new BN(99).mul(QUOTE_PRECISION).add(groupingSize).toString()
		);
		expect(newAsks[1].size.toString()).to.equal(
			new BN(2).mul(BASE_PRECISION).toString()
		);
		expect(newAsks[1].sources['vamm'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newAsks[1].sources['dlob'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);

		expect(newAsks[2].price.toString()).to.equal(
			new BN(100).mul(QUOTE_PRECISION).toString()
		);
		expect(newAsks[2].size.toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
		expect(newAsks[2].sources['vamm'].toString()).to.equal(
			new BN(1).mul(BASE_PRECISION).toString()
		);
	});

	it('Handles user crossing bid in second level', () => {
		const oraclePrice = new BN(190.3843 * PRICE_PRECISION.toNumber());
		const bids = [
			[190.59, 2],
			[190.588, 58.3],
			[190.5557, 5],
			[190.5547, 5],
			[190.5508, 5],
			[190.541, 2],
			[190.5099, 49.1],
			[190.5, 60],
		].map(([price, size]) => ({
			price: new BN(price * PRICE_PRECISION.toNumber()),
			size: new BN(size * BASE_PRECISION.toNumber()),
			sources: { vamm: new BN(size * BASE_PRECISION.toNumber()) },
		}));

		const asks = [
			[190.5, 86.5],
			[190.6159, 1],
			[190.656, 10.5],
			[190.6561, 1],
			[190.6585, 5],
			[190.6595, 5],
			[190.6596, 5],
		].map(([price, size]) => ({
			price: new BN(price * PRICE_PRECISION.toNumber()),
			size: new BN(size * BASE_PRECISION.toNumber()),
			sources: { vamm: new BN(size * BASE_PRECISION.toNumber()) },
		}));

		expect(asksAreSortedAsc(asks), 'Input asks are ascending').to.be.true;
		expect(bidsAreSortedDesc(bids), 'Input bids are descending').to.be.true;

		const groupingSize = new BN('100');

		const userBidPrice = new BN(190.588 * PRICE_PRECISION.toNumber());
		const userBids = new Set<string>([userBidPrice.toString()]);

		const { bids: newBids, asks: newAsks } = uncrossL2(
			bids,
			asks,
			oraclePrice,
			oraclePrice,
			oraclePrice,
			groupingSize,
			userBids,
			new Set<string>()
		);

		expect(asksAreSortedAsc(newAsks), 'Uncrossed asks are ascending').to.be
			.true;
		expect(bidsAreSortedDesc(newBids), 'Uncrossed bids are descending').to.be
			.true;
		expect(newBids[0].price.toString()).to.equal(userBidPrice.toString());
	});

	it('Handles edge case bide and asks with large cross and an overlapping level', () => {
		const bids = [
			'104411000',
			'103835800',
			'103826259',
			'103825000',
			'103822000',
			'103821500',
			'103820283',
			'103816900',
			'103816000',
			'103815121',
		].map((priceStr) => ({
			price: new BN(priceStr),
			size: new BN(1).mul(BASE_PRECISION),
			sources: { vamm: new BN(1).mul(BASE_PRECISION) },
		}));

		const asks = [
			'103822000',
			'103838354',
			'103843087',
			'103843351',
			'103843880',
			'103845114',
			'103846148',
			'103850100',
			'103851300',
			'103854304',
		].map((priceStr) => ({
			price: new BN(priceStr),
			size: new BN(1).mul(BASE_PRECISION),
			sources: { vamm: new BN(1).mul(BASE_PRECISION) },
		}));

		expect(asksAreSortedAsc(asks), 'Input asks are ascending').to.be.true;
		expect(bidsAreSortedDesc(bids), 'Input bids are descending').to.be.true;

		const oraclePrice = new BN('103649895');
		const oraclePrice5Min = new BN('103285000');
		const markPrice5Min = new BN('103371000');

		const groupingSize = new BN('100');

		const userAsks = new Set<string>();

		const { bids: newBids, asks: newAsks } = uncrossL2(
			bids,
			asks,
			oraclePrice,
			oraclePrice5Min,
			markPrice5Min,
			groupingSize,
			new Set<string>(),
			userAsks
		);

		expect(asksAreSortedAsc(newAsks), 'Uncrossed asks are ascending').to.be
			.true;
		expect(bidsAreSortedDesc(newBids), 'Uncrossed bids are descending').to.be
			.true;
	});

	it('Crossing edge case : top bid and ask have a big cross, following ones dont - shouldnt get uncrossed out of order', () => {
		const bids = [
			'101825900',
			'101783900',
			'101783000',
			'101782600',
			'101770700',
			'101770200',
			'101749857',
			'101735900',
			'101729994',
			'101726900',
		].map((priceStr) => ({
			price: new BN(priceStr),
			size: new BN(1).mul(BASE_PRECISION),
			sources: { vamm: new BN(1).mul(BASE_PRECISION) },
		}));

		const asks = [
			'101750700',
			'101790467',
			'101793400',
			'101794116',
			'101798548',
			'101799532',
			'101803500',
			'101820927',
			'101823900',
			'101827638',
		].map((priceStr) => ({
			price: new BN(priceStr),
			size: new BN(1).mul(BASE_PRECISION),
			sources: { vamm: new BN(1).mul(BASE_PRECISION) },
		}));

		expect(asksAreSortedAsc(asks), 'Input asks are ascending').to.be.true;
		expect(bidsAreSortedDesc(bids), 'Input bids are descending').to.be.true;

		const oraclePrice = new BN('101711384');
		const oraclePrice5Min = new BN('101805000');
		const markPrice5Min = new BN('101867000');

		const groupingSize = new BN('100');

		const userAsks = new Set<string>();

		const { bids: newBids, asks: newAsks } = uncrossL2(
			bids,
			asks,
			oraclePrice,
			oraclePrice5Min,
			markPrice5Min,
			groupingSize,
			new Set<string>(),
			userAsks
		);

		expect(asksAreSortedAsc(newAsks), 'Uncrossed asks are ascending').to.be
			.true;
		expect(bidsAreSortedDesc(newBids), 'Uncrossed bids are descending').to.be
			.true;
	});
});
