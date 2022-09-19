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
} from '../../src';

import { mockPerpMarkets, mockSpotMarkets } from './helpers';

function insertOrderToDLOB(
	dlob: DLOB,
	userAccount: PublicKey,
	orderType: OrderType,
	marketType: MarketType,
	orderId: BN,
	marketIndex: BN,
	price: BN,
	baseAssetAmount: BN,
	direction: PositionDirection,
	auctionStartPrice: BN,
	auctionEndPrice: BN,
	slot?: BN,
	timeInForce = 30
) {
	dlob.insertOrder(
		{
			status: OrderStatus.OPEN,
			orderType,
			marketType,
			ts: new BN(getMockTimestamp()),
			slot: slot || new BN(1),
			orderId,
			userOrderId: 0,
			marketIndex,
			price,
			baseAssetAmount,
			baseAssetAmountFilled: new BN(0),
			quoteAssetAmount: new BN(0),
			quoteAssetAmountFilled: new BN(0),
			fee: new BN(0),
			direction,
			reduceOnly: false,
			triggerPrice: new BN(0),
			triggerCondition: OrderTriggerCondition.ABOVE,
			triggered: false,
			existingPositionDirection: PositionDirection.LONG,
			postOnly: false,
			immediateOrCancel: true,
			oraclePriceOffset: new BN(0),
			auctionDuration: 10,
			auctionStartPrice,
			auctionEndPrice,
			timeInForce,
		},
		userAccount
	);
}

function insertTriggerOrderToDLOB(
	dlob: DLOB,
	userAccount: PublicKey,
	orderType: OrderType,
	marketType: MarketType,
	orderId: BN,
	marketIndex: BN,
	price: BN,
	baseAssetAmount: BN,
	direction: PositionDirection,
	triggerPrice: BN,
	triggerCondition: OrderTriggerCondition,
	auctionStartPrice: BN,
	auctionEndPrice: BN,
	slot?: BN,
	timeInForce = 30
) {
	dlob.insertOrder(
		{
			status: OrderStatus.OPEN,
			orderType,
			marketType,
			ts: new BN(getMockTimestamp()),
			slot: slot || new BN(1),
			orderId,
			userOrderId: 0,
			marketIndex,
			price,
			baseAssetAmount,
			baseAssetAmountFilled: new BN(0),
			quoteAssetAmount: new BN(0),
			quoteAssetAmountFilled: new BN(0),
			fee: new BN(0),
			direction,
			reduceOnly: false,
			triggerPrice,
			triggerCondition,
			triggered: false,
			existingPositionDirection: PositionDirection.LONG,
			postOnly: false,
			immediateOrCancel: true,
			oraclePriceOffset: new BN(0),
			auctionDuration: 10,
			auctionStartPrice,
			auctionEndPrice,
			timeInForce,
		},
		userAccount
	);
}

let mockTs = 1;
function getMockTimestamp(): number {
	return mockTs++;
}

describe('DLOB Tests', () => {
	it('Fresh DLOB is empty', () => {
		const dlob = new DLOB(mockPerpMarkets, mockSpotMarkets, false);
		const vAsk = new BN(11);
		const vBid = new BN(10);
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(12),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		// check perps
		for (const market of mockPerpMarkets) {
			let foundAsks = 0;
			for (const _ask of dlob.getAsks(
				market.marketIndex,
				vAsk,
				0,
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
});

describe('DLOB Perp Tests', () => {
	it('Test proper bids', () => {
		const vAsk = new BN(15);
		const vBid = new BN(10);
		const dlob = new DLOB(mockPerpMarkets, mockSpotMarkets, false);
		const marketIndex = new BN(0);

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
				orderId: new BN(5),
				price: new BN(0),
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
			},
			{
				expectedIdx: 4,
				isVamm: false,
				orderId: new BN(6),
				price: new BN(0),
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
			},
			{
				expectedIdx: 5,
				isVamm: false,
				orderId: new BN(7),
				price: new BN(0),
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
			},
			{
				expectedIdx: 0,
				isVamm: false,
				orderId: new BN(1),
				price: new BN(12),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
			},
			{
				expectedIdx: 1,
				isVamm: false,
				orderId: new BN(2),
				price: new BN(11),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
			},
			{
				expectedIdx: 7,
				isVamm: false,
				orderId: new BN(3),
				price: new BN(8),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
			},
			{
				expectedIdx: 2,
				isVamm: true,
				orderId: undefined,
				price: undefined,
				direction: undefined,
				orderType: undefined,
			},
			{
				expectedIdx: 6,
				isVamm: false,
				orderId: new BN(4),
				price: new BN(9),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
			},
		];

		for (const t of testCases) {
			if (t.isVamm) {
				continue;
			}
			insertOrderToDLOB(
				dlob,
				Keypair.generate().publicKey,
				t.orderType || OrderType.LIMIT,
				MarketType.PERP,
				t.orderId || new BN(0), // orderId
				marketIndex,
				t.price || new BN(0), // price
				BASE_PRECISION, // quantity
				t.direction || PositionDirection.LONG,
				vBid,
				vAsk
			);
		}

		const expectedTestCase = testCases.sort((a, b) => {
			// ascending order
			return a.expectedIdx - b.expectedIdx;
		});
		const bids = dlob.getBids(marketIndex, vBid, slot, MarketType.PERP, oracle);

		console.log('The Book Bids:');
		let countBids = 0;
		for (const bid of bids) {
			console.log(
				` . vAMMNode? ${bid.isVammNode()}, ${JSON.stringify(
					bid.order?.orderType
				)} , ${bid.order?.orderId.toString()} , vammTestgetPRice: ${bid.getPrice(
					oracle,
					slot
				)}, price: ${bid.order?.price.toString()}, quantity: ${bid.order?.baseAssetAmountFilled.toString()}/${bid.order?.baseAssetAmount.toString()}`
			);

			expect(bid.isVammNode()).to.be.eq(expectedTestCase[countBids].isVamm);
			expect(bid.order?.orderId.toNumber()).to.equal(
				expectedTestCase[countBids].orderId?.toNumber()
			);
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
		const dlob = new DLOB(mockPerpMarkets, mockSpotMarkets, false);
		const marketIndex0 = new BN(0);
		const marketIndex1 = new BN(1);

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
				orderId: new BN(5),
				price: new BN(0),
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
				marketIndex: marketIndex0,
			},
			{
				expectedIdx: 4,
				isVamm: false,
				orderId: new BN(6),
				price: new BN(0),
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
				marketIndex: marketIndex0,
			},
			{
				expectedIdx: 5,
				isVamm: false,
				orderId: new BN(7),
				price: new BN(0),
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
				marketIndex: marketIndex1,
			},
			{
				expectedIdx: 0,
				isVamm: false,
				orderId: new BN(1),
				price: new BN(12),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				marketIndex: marketIndex0,
			},
			{
				expectedIdx: 1,
				isVamm: false,
				orderId: new BN(2),
				price: new BN(11),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				marketIndex: marketIndex0,
			},
			{
				expectedIdx: 7,
				isVamm: false,
				orderId: new BN(3),
				price: new BN(8),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				marketIndex: marketIndex0,
			},
			{
				expectedIdx: 6,
				isVamm: false,
				orderId: new BN(4),
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
			insertOrderToDLOB(
				dlob,
				Keypair.generate().publicKey,
				t.orderType || OrderType.LIMIT,
				MarketType.PERP,
				t.orderId || new BN(0), // orderId
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
		const dlob = new DLOB(mockPerpMarkets, mockSpotMarkets, false);
		const marketIndex = new BN(0);

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
				orderId: new BN(3),
				price: new BN(0),
				direction: PositionDirection.SHORT,
				orderType: OrderType.MARKET,
			},
			{
				expectedIdx: 1,
				isVamm: false,
				orderId: new BN(4),
				price: new BN(0),
				direction: PositionDirection.SHORT,
				orderType: OrderType.MARKET,
			},
			{
				expectedIdx: 2,
				isVamm: false,
				orderId: new BN(5),
				price: new BN(0),
				direction: PositionDirection.SHORT,
				orderType: OrderType.MARKET,
			},
			{
				expectedIdx: 3,
				isVamm: false,
				orderId: new BN(1),
				price: new BN(13),
				direction: PositionDirection.SHORT,
				orderType: OrderType.LIMIT,
			},
			{
				expectedIdx: 6,
				isVamm: false,
				orderId: new BN(6),
				price: new BN(16),
				direction: PositionDirection.SHORT,
				orderType: OrderType.LIMIT,
			},
			{
				expectedIdx: 5,
				isVamm: true,
				orderId: undefined,
				price: undefined,
				direction: undefined,
				orderType: undefined,
			},
			{
				expectedIdx: 7,
				isVamm: false,
				orderId: new BN(7),
				price: new BN(17),
				direction: PositionDirection.SHORT,
				orderType: OrderType.LIMIT,
			},
			{
				expectedIdx: 4,
				isVamm: false,
				orderId: new BN(2),
				price: new BN(14),
				direction: PositionDirection.SHORT,
				orderType: OrderType.LIMIT,
			},
		];

		for (const t of testCases) {
			if (t.isVamm) {
				continue;
			}
			insertOrderToDLOB(
				dlob,
				Keypair.generate().publicKey,
				t.orderType || OrderType.LIMIT,
				MarketType.PERP,
				t.orderId || new BN(0), // orderId
				marketIndex,
				t.price || new BN(0), // price
				BASE_PRECISION, // quantity
				t.direction || PositionDirection.SHORT,
				vBid,
				vAsk
			);
		}

		const expectedTestCase = testCases.sort((a, b) => {
			// ascending order
			return a.expectedIdx - b.expectedIdx;
		});
		const asks = dlob.getAsks(marketIndex, vAsk, slot, MarketType.PERP, oracle);

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

			expect(ask.isVammNode()).to.be.eq(expectedTestCase[countAsks].isVamm);
			expect(ask.order?.orderId.toNumber()).to.equal(
				expectedTestCase[countAsks].orderId?.toNumber()
			);
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
		const vAsk = new BN(11);
		const vBid = new BN(10);
		const dlob = new DLOB(mockPerpMarkets, mockSpotMarkets, false);
		const marketIndex = new BN(0);
		const oracle = {
			price: vBid.add(vAsk).div(new BN(2)),
			slot: new BN(12),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};

		// 3 mkt buys
		for (let i = 0; i < 3; i++) {
			insertOrderToDLOB(
				dlob,
				Keypair.generate().publicKey,
				OrderType.MARKET,
				MarketType.PERP,
				new BN(i + 1),
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
			insertOrderToDLOB(
				dlob,
				Keypair.generate().publicKey,
				OrderType.MARKET,
				MarketType.PERP,
				new BN(i + 1),
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
				expect(ask.order?.orderId.toNumber()).to.equal(asks);
			}
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
				expect(getVariant(bid.order?.status)).to.equal('open');
				expect(getVariant(bid.order?.orderType)).to.equal('market');
				expect(getVariant(bid.order?.direction)).to.equal('long');
				expect(bid.order?.orderId.toNumber()).to.equal(bids);
			}
			bids++;
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
		const dlob = new DLOB(mockPerpMarkets, mockSpotMarkets, false);
		const marketIndex = new BN(0);
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			new BN(3),
			marketIndex,
			new BN(5),
			BASE_PRECISION,
			PositionDirection.LONG,
			vBid,
			vAsk
		);

		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			new BN(2),
			marketIndex,
			new BN(6),
			BASE_PRECISION,
			PositionDirection.LONG,
			vBid,
			vAsk
		);

		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			new BN(1),
			marketIndex,
			new BN(7),
			BASE_PRECISION,
			PositionDirection.LONG,
			vBid,
			vAsk
		);

		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			new BN(1),
			marketIndex,
			new BN(12),
			BASE_PRECISION,
			PositionDirection.SHORT,
			vBid,
			vAsk
		);

		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			new BN(2),
			marketIndex,
			new BN(13),
			BASE_PRECISION,
			PositionDirection.SHORT,
			vBid,
			vAsk
		);

		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			new BN(3),
			marketIndex,
			new BN(14),
			BASE_PRECISION,
			PositionDirection.SHORT,
			vBid,
			vAsk
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
				expect(ask.order?.orderId.toNumber()).to.equal(asks);
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
				expect(bid.order?.orderId.toNumber()).to.equal(bids);
				expect(bid.order?.price.lt(vBid)).to.equal(true);
			}
			bids++;
		}
		expect(bids).to.equal(4); // vamm bid + 3 orders
	});

	it('Test multiple market orders fill with multiple limit orders', () => {
		const vAsk = new BN(15);
		const vBid = new BN(10);
		const dlob = new DLOB(mockPerpMarkets, mockSpotMarkets, false);
		const marketIndex = new BN(0);

		// insert some limit buys above vamm bid, below ask
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			new BN(1), // orderId
			marketIndex,
			new BN(11), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			new BN(2), // orderId
			marketIndex,
			new BN(12), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			new BN(3), // orderId
			marketIndex,
			new BN(13), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);

		// should have no crossing orders
		const nodesToFillBefore = dlob.findCrossingNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			12, // auction over
			MarketType.PERP,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(12),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			}
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// place two market sell order eating 2 of the limit orders
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			new BN(4), // orderId
			marketIndex,
			new BN(12), // price
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			new BN(5), // orderId
			marketIndex,
			new BN(12), // price
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk
		);

		const nodesToFillAfter = dlob.findCrossingNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			12, // auction over
			MarketType.PERP,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(12),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			}
		);
		for (const n of nodesToFillAfter) {
			console.log(
				`cross found: taker orderId: ${n.node.order?.orderId.toString()}: BAA: ${n.node.order?.baseAssetAmount.toString()}, maker orderId: ${n.makerNode?.order?.orderId.toString()}: BAA: ${n.makerNode?.order?.baseAssetAmount.toString()}`
			);
		}
		expect(nodesToFillAfter.length).to.equal(2);

		// first taker should fill with best maker
		expect(nodesToFillAfter[0].node.order?.orderId.toNumber()).to.equal(4);
		expect(nodesToFillAfter[0].makerNode?.order?.orderId.toNumber()).to.equal(
			3
		);

		// second taker should fill with second best maker
		expect(nodesToFillAfter[1].node.order?.orderId.toNumber()).to.equal(5);
		expect(nodesToFillAfter[1].makerNode?.order?.orderId.toNumber()).to.equal(
			2
		);
	});

	it('Test one market orders fills two limit orders', () => {
		const vAsk = new BN(15);
		const vBid = new BN(10);
		const dlob = new DLOB(mockPerpMarkets, mockSpotMarkets, false);
		const marketIndex = new BN(0);

		// insert some limit sells below vAMM ask, above bid
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			new BN(1), // orderId
			marketIndex,
			new BN(14), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			new BN(2), // orderId
			marketIndex,
			new BN(13), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			new BN(3), // orderId
			marketIndex,
			new BN(12), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk
		);

		// should have no crossing orders
		const nodesToFillBefore = dlob.findCrossingNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			12, // auction over
			MarketType.PERP,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(12),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			}
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// place one market buy order eating 2 of the limit orders
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			new BN(4), // orderId
			marketIndex,
			new BN(13), // price
			new BN(2).mul(BASE_PRECISION), // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);

		const nodesToFillAfter = dlob.findCrossingNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			12, // auction over
			MarketType.PERP,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(12),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			}
		);
		for (const n of nodesToFillAfter) {
			console.log(
				`cross found: taker orderId: ${n.node.order?.orderId.toString()}: BAA: ${n.node.order?.baseAssetAmountFilled.toString()}/${n.node.order?.baseAssetAmount.toString()}, maker orderId: ${n.makerNode?.order?.orderId.toString()}: BAA: ${n.makerNode?.order?.baseAssetAmountFilled.toString()}/${n.makerNode?.order?.baseAssetAmount.toString()}`
			);
		}
		expect(nodesToFillAfter.length).to.equal(2);

		// taker should fill completely with best maker
		expect(nodesToFillAfter[0].node.order?.orderId.toNumber()).to.equal(4);
		expect(nodesToFillAfter[0].makerNode?.order?.orderId.toNumber()).to.equal(
			3
		);

		// taker should fill completely with second best maker
		expect(nodesToFillAfter[1].node.order?.orderId.toNumber()).to.equal(4);
		expect(nodesToFillAfter[1].makerNode?.order?.orderId.toNumber()).to.equal(
			2
		);
	});

	it('Test two market orders to fill one limit order', () => {
		const vAsk = new BN(15);
		const vBid = new BN(8);
		const dlob = new DLOB(mockPerpMarkets, mockSpotMarkets, false);
		const marketIndex = new BN(0);

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
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			new BN(1), // orderId
			marketIndex,
			new BN(14), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			new BN(2), // orderId
			marketIndex,
			new BN(13), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.PERP,
			new BN(3), // orderId
			marketIndex,
			new BN(9), // price <-- best price
			new BN(3).mul(BASE_PRECISION), // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk
		);

		// should have no crossing orders
		const nodesToFillBefore = dlob.findCrossingNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			12, // auction over
			MarketType.PERP,
			oracle
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// place two market buy orders to eat the best ask
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			new BN(4), // orderId
			marketIndex,
			new BN(0), // price
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			new BN(5), // orderId
			marketIndex,
			new BN(0), // price
			new BN(2).mul(BASE_PRECISION), // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);

		const nodesToFillAfter = dlob.findCrossingNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			slot, // auction over
			MarketType.PERP,
			oracle
		);
		const mktNodes = dlob.findMarketNodesToFill(
			marketIndex,
			slot,
			MarketType.PERP
		);
		console.log(`market nodes: ${mktNodes.length}`);

		const askNodes = dlob.getAsks(
			marketIndex,
			vAsk,
			slot,
			MarketType.PERP,
			oracle
		);
		let aa = 0;
		for (const b of askNodes) {
			console.log(
				` . ask: ${b.order?.orderId.toString()}: p1: ${b.order?.price.toString()} p2: ${b.getPrice(
					oracle,
					slot
				)}, ${JSON.stringify(
					b.order?.orderType
				)} BAA: ${b.order?.baseAssetAmountFilled.toString()}/${b.order?.baseAssetAmount.toString()}`
			);
			aa++;
		}
		expect(aa).to.equal(4);

		const bidNodes = dlob.getBids(
			marketIndex,
			vBid,
			slot,
			MarketType.PERP,
			oracle
		);
		let bb = 0;
		for (const b of bidNodes) {
			console.log(
				` . bid: ${b.order?.orderId.toString()}: p1: ${b.order?.price.toString()} p2: ${b.getPrice(
					oracle,
					slot
				)}, ${JSON.stringify(
					b.order?.orderType
				)} BAA: ${b.order?.baseAssetAmountFilled.toString()}/${b.order?.baseAssetAmount.toString()}`
			);
			bb++;
		}
		expect(bb).to.equal(3);

		console.log(`bids nodes: ${bb}`);
		for (const n of nodesToFillAfter) {
			console.log(
				`cross found: taker orderId: ${n.node.order?.orderId.toString()}: BAA: ${n.node.order?.baseAssetAmountFilled.toString()}/${n.node.order?.baseAssetAmount.toString()}, maker orderId: ${n.makerNode?.order?.orderId.toString()}: BAA: ${n.makerNode?.order?.baseAssetAmountFilled.toString()}/${n.makerNode?.order?.baseAssetAmount.toString()}`
			);
		}
		expect(nodesToFillAfter.length).to.equal(2);

		// taker should fill completely with best maker
		expect(nodesToFillAfter[0].node.order?.orderId.toNumber()).to.equal(4);
		expect(nodesToFillAfter[0].makerNode?.order?.orderId.toNumber()).to.equal(
			3
		);

		// taker should fill completely with second best maker
		expect(nodesToFillAfter[1].node.order?.orderId.toNumber()).to.equal(5);
		expect(nodesToFillAfter[1].makerNode?.order?.orderId.toNumber()).to.equal(
			3
		);
	});

	it('Test trigger orders', () => {
		const vAsk = new BN(15);
		const vBid = new BN(8);
		const dlob = new DLOB(mockPerpMarkets, mockSpotMarkets, false);
		const marketIndex = new BN(0);

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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_LIMIT,
			MarketType.PERP,
			new BN(1), //orderId
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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_LIMIT,
			MarketType.PERP,
			new BN(2), //orderId
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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.PERP,
			new BN(3), //orderId
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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.PERP,
			new BN(4), //orderId
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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_LIMIT,
			MarketType.PERP,
			new BN(5), //orderId
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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_LIMIT,
			MarketType.PERP,
			new BN(6), //orderId
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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.PERP,
			new BN(7), //orderId
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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.PERP,
			new BN(8), //orderId
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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.PERP,
			new BN(9), //orderId
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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.PERP,
			new BN(10), //orderId
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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.PERP,
			new BN(11), //orderId
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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.PERP,
			new BN(12), //orderId
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
			MarketType.PERP
		);
		console.log(`nodesToTriggeR: ${nodesToTrigger.length}`);
		for (const [idx, n] of nodesToTrigger.entries()) {
			expect(n.node.order?.orderId.toNumber()).to.equal(orderIdsToTrigger[idx]);
			console.log(`nodeToTrigger: ${n.node.order?.orderId.toString()}`);
		}
	});

	it('Test will return expired market orders to fill', () => {
		const vAsk = new BN(15);
		const vBid = new BN(8);
		const dlob = new DLOB(mockPerpMarkets, mockSpotMarkets, false);
		const marketIndex = new BN(0);

		const slot = 20;
		const timeInForce = 30;

		// non crossing bid
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			new BN(255), // orderId
			marketIndex,
			new BN(2), // price, very low, don't cross vamm
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(slot),
			timeInForce
		);
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.MARKET,
			MarketType.PERP,
			new BN(2), // orderId
			marketIndex,
			new BN(30), // price, very high, don't cross vamm
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vAsk,
			vBid,
			new BN(slot),
			timeInForce
		);

		// order auction is not yet complete, and order is not expired.
		const slot0 = slot;
		const nodesToFillBefore = dlob.findNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			slot0,
			MarketType.PERP,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(slot0),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			}
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// should get order to fill after timeInForce
		const slot1 = slot0 + timeInForce; // overshoots expiry
		const nodesToFillAfter = dlob.findNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			slot1, // auction is over, and order ix expired
			MarketType.PERP,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(slot1),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			}
		);
		expect(nodesToFillAfter.length).to.equal(2);

		// check that the nodes have no makers
		expect(nodesToFillAfter[0].makerNode).to.equal(undefined);
		expect(nodesToFillAfter[1].makerNode).to.equal(undefined);
	});
});

describe('DLOB Spot Tests', () => {
	it('Test proper bids', () => {
		const vAsk = new BN(115);
		const vBid = new BN(100);
		const dlob = new DLOB(mockPerpMarkets, mockSpotMarkets, false);
		const marketIndex = new BN(0);

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
				orderId: new BN(5),
				price: new BN(0), // will calc 108
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
			},
			{
				expectedIdx: 4,
				orderId: new BN(6),
				price: new BN(0), // will calc 108
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
			},
			{
				expectedIdx: 5,
				orderId: new BN(7),
				price: new BN(0), // will calc 108
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
			},
			{
				expectedIdx: 0,
				orderId: new BN(1),
				price: new BN(110),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
			},
			{
				expectedIdx: 1,
				orderId: new BN(2),
				price: new BN(109),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
			},
			{
				expectedIdx: 6,
				orderId: new BN(3),
				price: new BN(107),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
			},
			{
				expectedIdx: 7,
				orderId: new BN(4),
				price: new BN(106),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
			},
		];

		for (const t of testCases) {
			insertOrderToDLOB(
				dlob,
				Keypair.generate().publicKey,
				t.orderType || OrderType.LIMIT,
				MarketType.SPOT,
				t.orderId || new BN(0), // orderId
				marketIndex,
				t.price || new BN(0), // price
				BASE_PRECISION, // quantity
				t.direction || PositionDirection.LONG,
				vBid,
				vAsk
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
			console.log(
				` . vAMMNode? ${bid.isVammNode()}, ${JSON.stringify(
					bid.order?.orderType
				)} , ${bid.order?.orderId.toString()} , vammTestgetPRice: ${bid.getPrice(
					oracle,
					slot
				)}, price: ${bid.order?.price.toString()}, quantity: ${bid.order?.baseAssetAmountFilled.toString()}/${bid.order?.baseAssetAmount.toString()}`
			);

			expect(bid.order?.orderId.toNumber()).to.equal(
				expectedTestCase[countBids].orderId?.toNumber()
			);
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
		const dlob = new DLOB(mockPerpMarkets, mockSpotMarkets, false);
		const marketIndex0 = new BN(0);
		const marketIndex1 = new BN(1);

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
				orderId: new BN(5),
				price: new BN(0),
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
				marketIndex: marketIndex0,
			},
			{
				expectedIdx: 4,
				orderId: new BN(6),
				price: new BN(0),
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
				marketIndex: marketIndex0,
			},
			{
				expectedIdx: 5,
				orderId: new BN(7),
				price: new BN(0),
				direction: PositionDirection.LONG,
				orderType: OrderType.MARKET,
				marketIndex: marketIndex1,
			},
			{
				expectedIdx: 0,
				orderId: new BN(1),
				price: new BN(12),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				marketIndex: marketIndex0,
			},
			{
				expectedIdx: 1,
				orderId: new BN(2),
				price: new BN(11),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				marketIndex: marketIndex0,
			},
			{
				expectedIdx: 7,
				orderId: new BN(3),
				price: new BN(8),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				marketIndex: marketIndex0,
			},
			{
				expectedIdx: 6,
				orderId: new BN(4),
				price: new BN(9),
				direction: PositionDirection.LONG,
				orderType: OrderType.LIMIT,
				marketIndex: marketIndex1,
			},
		];

		for (const t of testCases) {
			insertOrderToDLOB(
				dlob,
				Keypair.generate().publicKey,
				t.orderType || OrderType.LIMIT,
				MarketType.SPOT,
				t.orderId || new BN(0), // orderId
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
		const dlob = new DLOB(mockPerpMarkets, mockSpotMarkets, false);
		const marketIndex = new BN(0);

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
				orderId: new BN(3),
				price: new BN(0),
				direction: PositionDirection.SHORT,
				orderType: OrderType.MARKET,
			},
			{
				expectedIdx: 1,
				orderId: new BN(4),
				price: new BN(0),
				direction: PositionDirection.SHORT,
				orderType: OrderType.MARKET,
			},
			{
				expectedIdx: 2,
				orderId: new BN(5),
				price: new BN(0),
				direction: PositionDirection.SHORT,
				orderType: OrderType.MARKET,
			},
			{
				expectedIdx: 3,
				orderId: new BN(1),
				price: new BN(13),
				direction: PositionDirection.SHORT,
				orderType: OrderType.LIMIT,
			},
			{
				expectedIdx: 6,
				orderId: new BN(6),
				price: new BN(16),
				direction: PositionDirection.SHORT,
				orderType: OrderType.LIMIT,
			},
			{
				expectedIdx: 7,
				orderId: new BN(7),
				price: new BN(17),
				direction: PositionDirection.SHORT,
				orderType: OrderType.LIMIT,
			},
			{
				expectedIdx: 4,
				orderId: new BN(2),
				price: new BN(14),
				direction: PositionDirection.SHORT,
				orderType: OrderType.LIMIT,
			},
		];

		for (const t of testCases) {
			insertOrderToDLOB(
				dlob,
				Keypair.generate().publicKey,
				t.orderType || OrderType.LIMIT,
				MarketType.SPOT,
				t.orderId || new BN(0), // orderId
				marketIndex,
				t.price || new BN(0), // price
				BASE_PRECISION, // quantity
				t.direction || PositionDirection.SHORT,
				vBid,
				vAsk
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

			expect(ask.order?.orderId.toNumber()).to.equal(
				expectedTestCase[countAsks].orderId?.toNumber()
			);
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
		const dlob = new DLOB(mockPerpMarkets, mockSpotMarkets, false);
		const marketIndex = new BN(0);

		// 3 mkt buys
		for (let i = 0; i < 3; i++) {
			insertOrderToDLOB(
				dlob,
				Keypair.generate().publicKey,
				OrderType.MARKET,
				MarketType.SPOT,
				new BN(i + 1),
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
			insertOrderToDLOB(
				dlob,
				Keypair.generate().publicKey,
				OrderType.MARKET,
				MarketType.SPOT,
				new BN(i + 1),
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
				expect(ask.order?.orderId.toNumber()).to.equal(asks);
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
			expect(bid.order?.orderId.toNumber()).to.equal(bids + 1);
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
		const dlob = new DLOB(mockPerpMarkets, mockSpotMarkets, false);
		const marketIndex = new BN(0);
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			new BN(3),
			marketIndex,
			new BN(50),
			BASE_PRECISION,
			PositionDirection.LONG,
			vBid,
			vAsk
		);

		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			new BN(2),
			marketIndex,
			new BN(60),
			BASE_PRECISION,
			PositionDirection.LONG,
			vBid,
			vAsk
		);

		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			new BN(1),
			marketIndex,
			new BN(70),
			BASE_PRECISION,
			PositionDirection.LONG,
			vBid,
			vAsk
		);

		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			new BN(1),
			marketIndex,
			new BN(120),
			BASE_PRECISION,
			PositionDirection.SHORT,
			vBid,
			vAsk
		);

		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			new BN(2),
			marketIndex,
			new BN(130),
			BASE_PRECISION,
			PositionDirection.SHORT,
			vBid,
			vAsk
		);

		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			new BN(3),
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
			expect(ask.order?.orderId.toNumber()).to.equal(asks + 1);
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
			expect(bid.order?.orderId.toNumber()).to.equal(bids + 1);
			expect(bid.order?.price.lt(vBid)).to.equal(true);
			bids++;
		}
		expect(bids).to.equal(3);
	});

	it('Test multiple market orders fill with multiple limit orders', () => {
		const vAsk = new BN(15);
		const vBid = new BN(10);
		const dlob = new DLOB(mockPerpMarkets, mockSpotMarkets, false);
		const marketIndex = new BN(0);

		// insert some limit buys above vamm bid, below ask
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			new BN(1), // orderId
			marketIndex,
			new BN(11), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			new BN(2), // orderId
			marketIndex,
			new BN(12), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			new BN(3), // orderId
			marketIndex,
			new BN(13), // price
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);

		// should have no crossing orders
		const nodesToFillBefore = dlob.findCrossingNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			12, // auction over
			MarketType.SPOT,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(12),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			}
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// place two market sell order eating 2 of the limit orders
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.MARKET,
			MarketType.SPOT,
			new BN(4), // orderId
			marketIndex,
			new BN(12), // price
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.MARKET,
			MarketType.SPOT,
			new BN(5), // orderId
			marketIndex,
			new BN(12), // price
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk
		);

		const nodesToFillAfter = dlob.findCrossingNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			12, // auction over
			MarketType.SPOT,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(12),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			}
		);
		for (const n of nodesToFillAfter) {
			console.log(
				`cross found: taker orderId: ${n.node.order?.orderId.toString()}: BAA: ${n.node.order?.baseAssetAmount.toString()}, maker orderId: ${n.makerNode?.order?.orderId.toString()}: BAA: ${n.makerNode?.order?.baseAssetAmount.toString()}`
			);
		}
		expect(nodesToFillAfter.length).to.equal(2);

		// first taker should fill with best maker
		expect(nodesToFillAfter[0].node.order?.orderId.toNumber()).to.equal(4);
		expect(nodesToFillAfter[0].makerNode?.order?.orderId.toNumber()).to.equal(
			3
		);

		// second taker should fill with second best maker
		expect(nodesToFillAfter[1].node.order?.orderId.toNumber()).to.equal(5);
		expect(nodesToFillAfter[1].makerNode?.order?.orderId.toNumber()).to.equal(
			2
		);
	});

	it('Test one market order fills two limit orders', () => {
		const vAsk = new BN(15);
		const vBid = new BN(10);
		const dlob = new DLOB(mockPerpMarkets, mockSpotMarkets, false);
		const marketIndex = new BN(0);

		// insert some limit sells below vAMM ask, above bid
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			new BN(1), // orderId
			marketIndex,
			new BN(14), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			new BN(2), // orderId
			marketIndex,
			new BN(12), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			new BN(3), // orderId
			marketIndex,
			new BN(11), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk
		);

		// should have no crossing orders
		const nodesToFillBefore = dlob.findCrossingNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			12, // auction over
			MarketType.SPOT,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(12),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			}
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// place one market buy order eating 2 of the limit orders
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.MARKET,
			MarketType.SPOT,
			new BN(4), // orderId
			marketIndex,
			new BN(12), // price
			new BN(2).mul(BASE_PRECISION), // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);

		const nodesToFillAfter = dlob.findCrossingNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			12, // auction over
			MarketType.SPOT,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(12),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			}
		);
		for (const n of nodesToFillAfter) {
			console.log(
				`cross found: taker orderId: ${n.node.order?.orderId.toString()}: BAA: ${n.node.order?.baseAssetAmountFilled.toString()}/${n.node.order?.baseAssetAmount.toString()}, maker orderId: ${n.makerNode?.order?.orderId.toString()}: BAA: ${n.makerNode?.order?.baseAssetAmountFilled.toString()}/${n.makerNode?.order?.baseAssetAmount.toString()}`
			);
		}
		expect(nodesToFillAfter.length).to.equal(2);

		// taker should fill completely with best maker
		expect(nodesToFillAfter[0].node.order?.orderId.toNumber()).to.equal(4);
		expect(nodesToFillAfter[0].makerNode?.order?.orderId.toNumber()).to.equal(
			3
		);

		// taker should fill completely with second best maker
		expect(nodesToFillAfter[1].node.order?.orderId.toNumber()).to.equal(4);
		expect(nodesToFillAfter[1].makerNode?.order?.orderId.toNumber()).to.equal(
			2
		);
	});

	it('Test two market orders to fill one limit order', () => {
		const vAsk = new BN(15);
		const vBid = new BN(8);
		const dlob = new DLOB(mockPerpMarkets, mockSpotMarkets, false);
		const marketIndex = new BN(0);

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
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			new BN(1), // orderId
			marketIndex,
			new BN(14), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			new BN(2), // orderId
			marketIndex,
			new BN(13), // price
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.LIMIT,
			MarketType.SPOT,
			new BN(3), // orderId
			marketIndex,
			new BN(8), // price <-- best price
			new BN(3).mul(BASE_PRECISION), // quantity
			PositionDirection.SHORT,
			vBid,
			vAsk
		);

		// should have no crossing orders
		const nodesToFillBefore = dlob.findCrossingNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			12, // auction over
			MarketType.SPOT,
			oracle
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// place two market buy orders to eat the best ask
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.MARKET,
			MarketType.SPOT,
			new BN(4), // orderId
			marketIndex,
			new BN(0), // price
			new BN(1).mul(BASE_PRECISION), // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.MARKET,
			MarketType.SPOT,
			new BN(5), // orderId
			marketIndex,
			new BN(0), // price
			new BN(2).mul(BASE_PRECISION), // quantity
			PositionDirection.LONG,
			vBid,
			vAsk
		);

		const nodesToFillAfter = dlob.findCrossingNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			slot, // auction over
			MarketType.SPOT,
			oracle
		);
		const mktNodes = dlob.findMarketNodesToFill(
			marketIndex,
			slot,
			MarketType.SPOT
		);
		console.log(`market nodes: ${mktNodes.length}`);

		const askNodes = dlob.getAsks(
			marketIndex,
			vAsk,
			slot,
			MarketType.SPOT,
			oracle
		);
		let aa = 0;
		for (const b of askNodes) {
			console.log(
				` . ask: ${b.order?.orderId.toString()}: p1: ${b.order?.price.toString()} p2: ${b.getPrice(
					oracle,
					slot
				)}, ${JSON.stringify(
					b.order?.orderType
				)} BAA: ${b.order?.baseAssetAmountFilled.toString()}/${b.order?.baseAssetAmount.toString()}`
			);
			aa++;
		}
		expect(aa).to.equal(3);

		const bidNodes = dlob.getBids(
			marketIndex,
			vBid,
			slot,
			MarketType.SPOT,
			oracle
		);
		let bb = 0;
		for (const b of bidNodes) {
			console.log(
				` . bid: ${b.order?.orderId.toString()}: p1: ${b.order?.price.toString()} p2: ${b.getPrice(
					oracle,
					slot
				)}, ${JSON.stringify(
					b.order?.orderType
				)} BAA: ${b.order?.baseAssetAmountFilled.toString()}/${b.order?.baseAssetAmount.toString()}`
			);
			bb++;
		}
		expect(bb).to.equal(2);

		console.log(`bids nodes: ${bb}`);
		for (const n of nodesToFillAfter) {
			console.log(
				`cross found: taker orderId: ${n.node.order?.orderId.toString()}: BAA: ${n.node.order?.baseAssetAmountFilled.toString()}/${n.node.order?.baseAssetAmount.toString()}, maker orderId: ${n.makerNode?.order?.orderId.toString()}: BAA: ${n.makerNode?.order?.baseAssetAmountFilled.toString()}/${n.makerNode?.order?.baseAssetAmount.toString()}`
			);
		}
		expect(nodesToFillAfter.length).to.equal(2);

		// taker should fill completely with best maker
		expect(nodesToFillAfter[0].node.order?.orderId.toNumber()).to.equal(4);
		expect(nodesToFillAfter[0].makerNode?.order?.orderId.toNumber()).to.equal(
			3
		);

		// taker should fill completely with second best maker
		expect(nodesToFillAfter[1].node.order?.orderId.toNumber()).to.equal(5);
		expect(nodesToFillAfter[1].makerNode?.order?.orderId.toNumber()).to.equal(
			3
		);
	});

	it('Test trigger orders', () => {
		const vAsk = new BN(15);
		const vBid = new BN(8);
		const dlob = new DLOB(mockPerpMarkets, mockSpotMarkets, false);
		const marketIndex = new BN(0);

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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_LIMIT,
			MarketType.SPOT,
			new BN(1), //orderId
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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_LIMIT,
			MarketType.SPOT,
			new BN(2), //orderId
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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.SPOT,
			new BN(3), //orderId
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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.SPOT,
			new BN(4), //orderId
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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_LIMIT,
			MarketType.SPOT,
			new BN(5), //orderId
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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_LIMIT,
			MarketType.SPOT,
			new BN(6), //orderId
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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.SPOT,
			new BN(7), //orderId
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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.SPOT,
			new BN(8), //orderId
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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.SPOT,
			new BN(9), //orderId
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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.SPOT,
			new BN(10), //orderId
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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.SPOT,
			new BN(11), //orderId
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
			Keypair.generate().publicKey,
			OrderType.TRIGGER_MARKET,
			MarketType.SPOT,
			new BN(12), //orderId
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
			MarketType.SPOT
		);
		console.log(`nodesToTriggeR: ${nodesToTrigger.length}`);
		for (const [idx, n] of nodesToTrigger.entries()) {
			expect(n.node.order?.orderId.toNumber()).to.equal(orderIdsToTrigger[idx]);
			console.log(`nodeToTrigger: ${n.node.order?.orderId.toString()}`);
		}
	});

	it('Test will return expired market orders to fill', () => {
		const vAsk = new BN(15);
		const vBid = new BN(8);
		const dlob = new DLOB(mockPerpMarkets, mockSpotMarkets, false);
		const marketIndex = new BN(0);

		const slot = 20;
		const timeInForce = 30;

		// non crossing bid
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.MARKET,
			MarketType.SPOT,
			new BN(255), // orderId
			marketIndex,
			new BN(2), // price, very low, don't cross vamm
			BASE_PRECISION, // quantity
			PositionDirection.LONG,
			vBid,
			vAsk,
			new BN(slot),
			timeInForce
		);
		insertOrderToDLOB(
			dlob,
			Keypair.generate().publicKey,
			OrderType.MARKET,
			MarketType.SPOT,
			new BN(2), // orderId
			marketIndex,
			new BN(30), // price, very high, don't cross vamm
			BASE_PRECISION, // quantity
			PositionDirection.SHORT,
			vAsk,
			vBid,
			new BN(slot),
			timeInForce
		);

		// order auction is not yet complete, and order is not expired.
		const slot0 = slot;
		const nodesToFillBefore = dlob.findNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			slot0,
			MarketType.SPOT,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(slot0),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			}
		);
		expect(nodesToFillBefore.length).to.equal(0);

		// should get order to fill after timeInForce
		const slot1 = slot0 + timeInForce; // overshoots expiry
		const nodesToFillAfter = dlob.findNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			slot1,
			MarketType.SPOT,
			{
				price: vBid.add(vAsk).div(new BN(2)),
				slot: new BN(slot1),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			}
		);
		expect(nodesToFillAfter.length).to.equal(2);

		// check that the nodes have no makers
		expect(nodesToFillAfter[0].makerNode).to.equal(undefined);
		expect(nodesToFillAfter[1].makerNode).to.equal(undefined);
	});
});
