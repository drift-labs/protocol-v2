import { expect } from 'chai';
import { Keypair } from '@solana/web3.js';

import {
	BN,
	DLOB,
	DLOBSubscriber,
	MarketType,
	Order,
	OrderStatus,
	OrderType,
	OrderTriggerCondition,
	PositionDirection,
	MMOraclePriceData,
	ZERO,
	standardizePrice,
	getAuctionPrice,
	getAuctionPriceForFixedAuction,
	getAuctionPriceForOracleOffsetAuction,
	getLimitPrice,
	hasBuilder,
	OrderBitFlag,
} from '../../src';

// Minimal Order factory mirroring the on-chain layout used by the math paths.
function makeOrder(overrides: Partial<Order>): Order {
	return {
		status: OrderStatus.OPEN,
		orderType: OrderType.LIMIT,
		marketType: MarketType.PERP,
		slot: new BN(1),
		orderId: 1,
		userOrderId: 0,
		marketIndex: 0,
		price: ZERO,
		baseAssetAmount: new BN(1),
		baseAssetAmountFilled: ZERO,
		quoteAssetAmountFilled: ZERO,
		direction: PositionDirection.LONG,
		reduceOnly: false,
		triggerPrice: ZERO,
		triggerCondition: OrderTriggerCondition.ABOVE,
		existingPositionDirection: PositionDirection.LONG,
		postOnly: false,
		immediateOrCancel: false,
		oraclePriceOffset: ZERO,
		auctionDuration: 10,
		auctionStartPrice: ZERO,
		auctionEndPrice: ZERO,
		maxTs: ZERO,
		bitFlags: 0,
		postedSlotTail: 0,
		...overrides,
	} as Order;
}

function mmOracle(price: number, slot: number): MMOraclePriceData {
	return {
		price: new BN(price),
		slot: new BN(slot),
		confidence: new BN(1),
		hasSufficientNumberOfDataPoints: true,
		isMMOracleActive: true,
	};
}

describe('tick size standardization parity', () => {
	const TICK = new BN(10);

	describe('standardizePrice mirrors program standardize_price', () => {
		it('long floors to the tick below', () => {
			expect(
				standardizePrice(new BN(127), TICK, PositionDirection.LONG).toString()
			).to.equal('120');
		});

		it('short ceils to the tick above', () => {
			expect(
				standardizePrice(new BN(127), TICK, PositionDirection.SHORT).toString()
			).to.equal('130');
		});

		it('leaves on-tick prices untouched (both directions)', () => {
			expect(
				standardizePrice(new BN(130), TICK, PositionDirection.LONG).toString()
			).to.equal('130');
			expect(
				standardizePrice(new BN(130), TICK, PositionDirection.SHORT).toString()
			).to.equal('130');
		});

		it('returns zero unchanged', () => {
			expect(
				standardizePrice(ZERO, TICK, PositionDirection.SHORT).toString()
			).to.equal('0');
		});
	});

	describe('getAuctionPriceForFixedAuction lands on tick boundaries per direction', () => {
		it('long floors the interpolated price', () => {
			// long: start + (end-start)*num/den = 100 + (207-100)*3/10 = 132 -> floor 130
			const order = makeOrder({
				direction: PositionDirection.LONG,
				auctionStartPrice: new BN(100),
				auctionEndPrice: new BN(207),
				auctionDuration: 10,
				slot: new BN(1),
			});
			expect(
				getAuctionPriceForFixedAuction(order, 4, TICK).toString()
			).to.equal('130');
		});

		it('short ceils the interpolated price', () => {
			// short: start - (start-end)*num/den = 207 - (207-100)*3/10 = 175 -> ceil 180
			const order = makeOrder({
				direction: PositionDirection.SHORT,
				auctionStartPrice: new BN(207),
				auctionEndPrice: new BN(100),
				auctionDuration: 10,
				slot: new BN(1),
			});
			expect(
				getAuctionPriceForFixedAuction(order, 4, TICK).toString()
			).to.equal('180');
		});

		it('standardizes the auctionEndPrice when duration is zero', () => {
			const longOrder = makeOrder({
				direction: PositionDirection.LONG,
				auctionEndPrice: new BN(127),
				auctionDuration: 0,
			});
			expect(
				getAuctionPriceForFixedAuction(longOrder, 4, TICK).toString()
			).to.equal('120');
		});

		it('defaults to no standardization (tick=1) when tickSize omitted', () => {
			const order = makeOrder({
				direction: PositionDirection.LONG,
				auctionStartPrice: new BN(100),
				auctionEndPrice: new BN(207),
				auctionDuration: 10,
				slot: new BN(1),
			});
			expect(getAuctionPriceForFixedAuction(order, 4).toString()).to.equal(
				'132'
			);
		});
	});

	describe('getAuctionPriceForOracleOffsetAuction floors at tickSize and standardizes', () => {
		it('long: floors oracle+offset to the tick below (duration zero)', () => {
			// max(1000 + 27, 10) = 1027 -> long floor 1020
			const order = makeOrder({
				orderType: OrderType.ORACLE,
				direction: PositionDirection.LONG,
				auctionEndPrice: new BN(27),
				auctionDuration: 0,
			});
			expect(
				getAuctionPriceForOracleOffsetAuction(
					order,
					4,
					new BN(1000),
					TICK
				).toString()
			).to.equal('1020');
		});

		it('short: ceils oracle+offset to the tick above (duration zero)', () => {
			const order = makeOrder({
				orderType: OrderType.ORACLE,
				direction: PositionDirection.SHORT,
				auctionEndPrice: new BN(27),
				auctionDuration: 0,
			});
			expect(
				getAuctionPriceForOracleOffsetAuction(
					order,
					4,
					new BN(1000),
					TICK
				).toString()
			).to.equal('1030');
		});

		it('floors the raw result at tickSize, not at ONE', () => {
			// oracle + offset = 1 - 100 = -99 -> max(-99, 10) = 10 (tick), not 1
			const order = makeOrder({
				orderType: OrderType.ORACLE,
				direction: PositionDirection.LONG,
				auctionEndPrice: new BN(-100),
				auctionDuration: 0,
			});
			expect(
				getAuctionPriceForOracleOffsetAuction(
					order,
					4,
					new BN(1),
					TICK
				).toString()
			).to.equal('10');
		});

		it('standardizes the interpolated offset price (non-zero duration)', () => {
			// offset delta = (107-0)*3/10 = 32 ; price = max(1000+32, 10) = 1032 -> long floor 1030
			const order = makeOrder({
				orderType: OrderType.ORACLE,
				direction: PositionDirection.LONG,
				auctionStartPrice: ZERO,
				auctionEndPrice: new BN(107),
				auctionDuration: 10,
				slot: new BN(1),
			});
			expect(
				getAuctionPriceForOracleOffsetAuction(
					order,
					4,
					new BN(1000),
					TICK
				).toString()
			).to.equal('1030');
		});
	});

	describe('getLimitPrice threads tick size', () => {
		it('standardizes the oracle-offset limit price and floors at tickSize', () => {
			// auction complete (duration 0), oracle offset path
			const longOrder = makeOrder({
				orderType: OrderType.LIMIT,
				direction: PositionDirection.LONG,
				oraclePriceOffset: new BN(27),
				auctionDuration: 0,
			});
			expect(
				getLimitPrice(
					longOrder,
					mmOracle(1000, 4),
					4,
					undefined,
					TICK
				)!.toString()
			).to.equal('1020');

			const shortOrder = makeOrder({
				orderType: OrderType.LIMIT,
				direction: PositionDirection.SHORT,
				oraclePriceOffset: new BN(27),
				auctionDuration: 0,
			});
			expect(
				getLimitPrice(
					shortOrder,
					mmOracle(1000, 4),
					4,
					undefined,
					TICK
				)!.toString()
			).to.equal('1030');
		});

		it('oracle-offset limit floors at tickSize when the sum underflows', () => {
			const order = makeOrder({
				orderType: OrderType.LIMIT,
				direction: PositionDirection.LONG,
				oraclePriceOffset: new BN(-100),
				auctionDuration: 0,
			});
			expect(
				getLimitPrice(order, mmOracle(5, 4), 4, undefined, TICK)!.toString()
			).to.equal('10');
		});

		it('routes auction orders through the standardized auction price', () => {
			// live auction (not complete) with fixed prices
			const order = makeOrder({
				orderType: OrderType.MARKET,
				direction: PositionDirection.LONG,
				auctionStartPrice: new BN(100),
				auctionEndPrice: new BN(207),
				auctionDuration: 10,
				slot: new BN(1),
			});
			// slot 4 -> elapsed 3 -> raw 132 -> floor 130
			expect(
				getLimitPrice(order, mmOracle(1000, 4), 4, undefined, TICK)!.toString()
			).to.equal('130');
		});

		it('returns a raw fixed limit price unchanged (matches program)', () => {
			const order = makeOrder({
				orderType: OrderType.LIMIT,
				direction: PositionDirection.LONG,
				price: new BN(123),
				auctionDuration: 0,
			});
			expect(
				getLimitPrice(order, mmOracle(1000, 4), 4, undefined, TICK)!.toString()
			).to.equal('123');
		});

		it('standardizes a fallback price when order price is zero', () => {
			const order = makeOrder({
				orderType: OrderType.LIMIT,
				direction: PositionDirection.SHORT,
				price: ZERO,
				oraclePriceOffset: ZERO,
				auctionDuration: 0,
			});
			expect(
				getLimitPrice(
					order,
					mmOracle(1000, 4),
					4,
					new BN(127),
					TICK
				)!.toString()
			).to.equal('130');
		});
	});

	describe('getAuctionPrice dispatch honours tick size', () => {
		it('passes tickSize down for oracle offset limit orders', () => {
			const order = makeOrder({
				orderType: OrderType.LIMIT,
				direction: PositionDirection.LONG,
				oraclePriceOffset: new BN(27),
				auctionStartPrice: new BN(10),
				auctionEndPrice: new BN(27),
				auctionDuration: 10,
				slot: new BN(1),
			});
			// live auction, oracle-offset auction path: offset delta = (27-10)*3/10 = 5,
			// offset = 15, price = max(1000+15, 10) = 1015 -> long floor 1010
			expect(getAuctionPrice(order, 4, new BN(1000), TICK).toString()).to.equal(
				'1010'
			);
		});
	});

	describe('DLOB crossing evaluation at a tick boundary', () => {
		const marketIndex = 0;
		const marketType = MarketType.PERP;
		const slot = 100; // auctions (duration 10, order slot 1) are complete
		const oracle = mmOracle(1000, slot);

		const buildDlob = (): DLOB => {
			const dlob = new DLOB();
			const longUser = Keypair.generate().publicKey;
			const shortUser = Keypair.generate().publicKey;
			// long resting limit via oracle offset: raw 1005 -> floor(10) 1000
			dlob.insertOrder(
				{
					status: OrderStatus.OPEN,
					orderType: OrderType.LIMIT,
					marketType,
					slot: new BN(1),
					orderId: 1,
					userOrderId: 0,
					marketIndex,
					price: ZERO,
					baseAssetAmount: new BN(1),
					baseAssetAmountFilled: ZERO,
					quoteAssetAmountFilled: ZERO,
					direction: PositionDirection.LONG,
					reduceOnly: false,
					triggerPrice: ZERO,
					triggerCondition: OrderTriggerCondition.ABOVE,
					existingPositionDirection: PositionDirection.LONG,
					postOnly: false,
					immediateOrCancel: false,
					oraclePriceOffset: new BN(5),
					auctionDuration: 10,
					auctionStartPrice: ZERO,
					auctionEndPrice: ZERO,
					maxTs: ZERO,
					bitFlags: 0,
					postedSlotTail: 0,
				} as Order,
				longUser.toString(),
				1,
				new BN(1)
			);
			// short resting limit via oracle offset: raw 1004 -> ceil(10) 1010
			dlob.insertOrder(
				{
					status: OrderStatus.OPEN,
					orderType: OrderType.LIMIT,
					marketType,
					slot: new BN(1),
					orderId: 2,
					userOrderId: 0,
					marketIndex,
					price: ZERO,
					baseAssetAmount: new BN(1),
					baseAssetAmountFilled: ZERO,
					quoteAssetAmountFilled: ZERO,
					direction: PositionDirection.SHORT,
					reduceOnly: false,
					triggerPrice: ZERO,
					triggerCondition: OrderTriggerCondition.ABOVE,
					existingPositionDirection: PositionDirection.LONG,
					postOnly: false,
					immediateOrCancel: false,
					oraclePriceOffset: new BN(4),
					auctionDuration: 10,
					auctionStartPrice: ZERO,
					auctionEndPrice: ZERO,
					maxTs: ZERO,
					bitFlags: 0,
					postedSlotTail: 0,
				} as Order,
				shortUser.toString(),
				1,
				new BN(1)
			);
			return dlob;
		};

		it('with tick=1 the raw prices cross (bid 1005 >= ask 1004)', () => {
			const dlob = buildDlob();
			const fills = dlob.findCrossingRestingLimitOrders(
				marketIndex,
				slot,
				marketType,
				oracle
			);
			expect(fills.length).to.equal(1);
		});

		it('with tick=10 the standardized prices do NOT cross (bid 1000 < ask 1010)', () => {
			const dlob = buildDlob();
			const fills = dlob.findCrossingRestingLimitOrders(
				marketIndex,
				slot,
				marketType,
				oracle,
				TICK
			);
			expect(fills.length).to.equal(0);
		});
	});

	describe('hasBuilder uses the shared OrderBitFlag enum', () => {
		it('detects the HasBuilder flag', () => {
			const order = makeOrder({ bitFlags: OrderBitFlag.HasBuilder });
			expect(hasBuilder(order)).to.equal(true);
		});
		it('is false without the flag', () => {
			const order = makeOrder({ bitFlags: OrderBitFlag.SignedMessage });
			expect(hasBuilder(order)).to.equal(false);
		});
	});
});

// C3: the public book-view wrapper (DLOBSubscriber.getL2/getL3) must forward the
// market's orderTickSize into DLOB, otherwise getLimitPrice falls back to ONE and
// the shipped book (dlob-server) emits un-standardized prices for tick_size>1 markets.
describe('DLOBSubscriber threads orderTickSize into DLOB', () => {
	const PERP_TICK = new BN(1000);
	const SPOT_TICK = new BN(500);

	function makeSubscriberWithSpy() {
		const calls: {
			method: string;
			marketType: MarketType;
			tickSize?: BN;
		}[] = [];

		const velocityClient = {
			getMMOracleDataForPerpMarket: () => mmOracle(100, 1),
			getOracleDataForSpotMarket: () => ({
				price: new BN(100),
				slot: new BN(1),
				confidence: new BN(1),
				hasSufficientNumberOfDataPoints: true,
			}),
			getPerpMarketAccountOrThrow: () => ({
				marketIndex: 0,
				orderTickSize: PERP_TICK,
			}),
			getSpotMarketAccountOrThrow: () => ({
				marketIndex: 0,
				orderTickSize: SPOT_TICK,
			}),
		} as any;

		const subscriber = new DLOBSubscriber({
			velocityClient,
			slotSource: { getSlot: () => 1 },
			dlobSource: { getDLOB: async () => new DLOB() } as any,
			updateFrequency: 1000,
		});

		// Spy on the underlying DLOB the wrapper delegates to.
		subscriber.dlob = {
			getL2: (args: any) => {
				calls.push({
					method: 'getL2',
					marketType: args.marketType,
					tickSize: args.tickSize,
				});
				return { bids: [], asks: [], slot: 1 };
			},
			getL3: (args: any) => {
				calls.push({
					method: 'getL3',
					marketType: args.marketType,
					tickSize: args.tickSize,
				});
				return { bids: [], asks: [], slot: 1 };
			},
		} as any;

		return { subscriber, calls };
	}

	it('getL2 passes the perp market orderTickSize', () => {
		const { subscriber, calls } = makeSubscriberWithSpy();
		subscriber.getL2({ marketIndex: 0, marketType: MarketType.PERP });
		expect(calls).to.have.length(1);
		expect(calls[0].tickSize).to.not.equal(undefined);
		expect(calls[0].tickSize!.eq(PERP_TICK)).to.equal(true);
	});

	it('getL2 passes the spot market orderTickSize', () => {
		const { subscriber, calls } = makeSubscriberWithSpy();
		subscriber.getL2({ marketIndex: 0, marketType: MarketType.SPOT });
		expect(calls[0].tickSize!.eq(SPOT_TICK)).to.equal(true);
	});

	it('getL3 passes the perp market orderTickSize', () => {
		const { subscriber, calls } = makeSubscriberWithSpy();
		subscriber.getL3({ marketIndex: 0, marketType: MarketType.PERP });
		expect(calls[0].tickSize!.eq(PERP_TICK)).to.equal(true);
	});

	it('getL3 passes the spot market orderTickSize', () => {
		const { subscriber, calls } = makeSubscriberWithSpy();
		subscriber.getL3({ marketIndex: 0, marketType: MarketType.SPOT });
		expect(calls[0].tickSize!.eq(SPOT_TICK)).to.equal(true);
	});
});
