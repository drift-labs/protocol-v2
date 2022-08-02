import { getOrderId, getVammNodeGenerator, NodeList } from './NodeList';
import {
	BN,
	calculateAskPrice,
	calculateBidPrice,
	ClearingHouse,
	convertToNumber,
	isAuctionComplete,
	isOneOfVariant,
	isVariant,
	Order,
	OrderRecord,
	OrderAction,
	ZERO,
	MARK_PRICE_PRECISION,
	MarketAccount,
	OraclePriceData,
	SlotSubscriber,
} from '..';
import { PublicKey } from '@solana/web3.js';
import { DLOBNode, DLOBNodeType, TriggerOrderNode } from './DLOBNode';

export type MarketNodeLists = {
	limit: {
		ask: NodeList<'limit'>;
		bid: NodeList<'limit'>;
	};
	floatingLimit: {
		ask: NodeList<'floatingLimit'>;
		bid: NodeList<'floatingLimit'>;
	};
	market: {
		ask: NodeList<'market'>;
		bid: NodeList<'market'>;
	};
	trigger: {
		above: NodeList<'trigger'>;
		below: NodeList<'trigger'>;
	};
};

export type OrderBookCallback = (order: Order, userAccount: PublicKey) => void;

export type NodeToFill = {
	node: DLOBNode;
	makerNode?: DLOBNode;
};

// maker node must be there for crossed nodes
type CrossedNodesToFill = NodeToFill & {
	makerNode: DLOBNode;
};

export type NodeToTrigger = {
	node: TriggerOrderNode;
};

type Side = 'ask' | 'bid';

export class DLOB {
	openOrders = new Set<string>();
	orderLists = new Map<number, MarketNodeLists>();
	marketIndexToAccount = new Map<number, MarketAccount>();

	private onUpdate: OrderBookCallback;
	private onRemove: OrderBookCallback;
	private onInsert: OrderBookCallback;
	private onTrigger: OrderBookCallback;

	public constructor(
		markets: MarketAccount[],
		onUpdate?: OrderBookCallback,
		onRemove?: OrderBookCallback,
		onInsert?: OrderBookCallback,
		onTrigger?: OrderBookCallback
	) {
		for (const market of markets) {
			const marketIndex = market.marketIndex;
			this.marketIndexToAccount.set(marketIndex.toNumber(), market);

			this.orderLists.set(marketIndex.toNumber(), {
				limit: {
					ask: new NodeList('limit', 'asc'),
					bid: new NodeList('limit', 'desc'),
				},
				floatingLimit: {
					ask: new NodeList('floatingLimit', 'asc'),
					bid: new NodeList('floatingLimit', 'desc'),
				},
				market: {
					ask: new NodeList('market', 'asc'),
					bid: new NodeList('market', 'asc'), // always sort ascending for market orders
				},
				trigger: {
					above: new NodeList('trigger', 'asc'),
					below: new NodeList('trigger', 'desc'),
				},
			});
		}

		this.onUpdate = onUpdate;
		this.onRemove = onRemove;
		this.onInsert = onInsert;
		this.onTrigger = onTrigger;
	}

	public insert(order: Order, userAccount: PublicKey): void {
		if (isVariant(order.status, 'init')) {
			return;
		}

		if (isVariant(order.status, 'open')) {
			this.openOrders.add(this.getOpenOrderId(order, userAccount));
		}
		this.getListForOrder(order).insert(
			order,
			this.marketIndexToAccount.get(order.marketIndex.toNumber()),
			userAccount
		);

		if (this.onInsert) {
			this.onInsert(order, userAccount);
		}
	}

	public remove(order: Order, userAccount: PublicKey): void {
		this.openOrders.delete(this.getOpenOrderId(order, userAccount));
		this.getListForOrder(order).remove(order, userAccount);

		if (this.onRemove) {
			this.onRemove(order, userAccount);
		}
	}

	public update(order: Order, userAccount: PublicKey): void {
		this.getListForOrder(order).update(order, userAccount);
		if (this.onUpdate) {
			this.onUpdate(order, userAccount);
		}
	}

	public trigger(order: Order, userAccount: PublicKey): void {
		const triggerList = this.orderLists.get(order.marketIndex.toNumber())
			.trigger[isVariant(order.triggerCondition, 'above') ? 'above' : 'below'];
		triggerList.remove(order, userAccount);

		this.getListForOrder(order).insert(
			order,
			this.marketIndexToAccount.get(order.marketIndex.toNumber()),
			userAccount
		);
		if (this.onTrigger) {
			this.onTrigger(order, userAccount);
		}
	}

	public getListForOrder(order: Order): NodeList<any> {
		const isInactiveTriggerOrder =
			isOneOfVariant(order.orderType, ['triggerMarket', 'triggerLimit']) &&
			!order.triggered;

		let type: DLOBNodeType;
		if (isInactiveTriggerOrder) {
			type = 'trigger';
		} else if (isOneOfVariant(order.orderType, ['market', 'triggerMarket'])) {
			type = 'market';
		} else if (order.oraclePriceOffset.gt(ZERO)) {
			type = 'floatingLimit';
		} else {
			type = 'limit';
		}

		let subType: string;
		if (isInactiveTriggerOrder) {
			subType = isVariant(order.triggerCondition, 'above') ? 'above' : 'below';
		} else {
			subType = isVariant(order.direction, 'long') ? 'bid' : 'ask';
		}

		return this.orderLists.get(order.marketIndex.toNumber())[type][subType];
	}

	public getOpenOrderId(order: Order, userAccount: PublicKey): string {
		return getOrderId(order, userAccount);
	}

	public findNodesToFill(
		marketIndex: BN,
		vBid: BN,
		vAsk: BN,
		slot: number,
		oraclePriceData?: OraclePriceData
	): NodeToFill[] {
		// Find all the crossing nodes
		const crossingNodesToFill: Array<NodeToFill> = this.findCrossingNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			slot,
			oraclePriceData
		);
		// Find all market nodes to fill
		const marketNodesToFill = this.findMarketNodesToFill(marketIndex, slot);
		return crossingNodesToFill.concat(marketNodesToFill);
	}

	public findCrossingNodesToFill(
		marketIndex: BN,
		vBid: BN,
		vAsk: BN,
		slot: number,
		oraclePriceData?: OraclePriceData
	): CrossedNodesToFill[] {
		const nodesToFill = new Array<CrossedNodesToFill>();

		const askGenerator = this.getAsks(marketIndex, vAsk, slot, oraclePriceData);
		const bidGenerator = this.getBids(marketIndex, vBid, slot, oraclePriceData);

		let nextAsk = askGenerator.next();
		let nextBid = bidGenerator.next();

		// First try to find orders that cross
		while (!nextAsk.done && !nextBid.done) {
			const { crossingNodes, crossingSide } = this.findCrossingOrders(
				nextAsk.value,
				askGenerator,
				nextBid.value,
				bidGenerator,
				oraclePriceData,
				slot
			);

			if (crossingNodes) {
				nodesToFill.push(crossingNodes);
				if (nodesToFill.length === 10) {
					break;
				}
			}

			if (crossingSide === 'bid') {
				nextBid = bidGenerator.next();
			} else if (crossingSide === 'ask') {
				nextAsk = askGenerator.next();
			} else {
				break;
			}
		}
		return nodesToFill;
	}

	public findMarketNodesToFill(marketIndex: BN, slot: number): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();
		// Then see if there are orders to fill against vamm
		for (const marketBid of this.getMarketBids(marketIndex)) {
			if (isAuctionComplete(marketBid.order, slot)) {
				nodesToFill.push({
					node: marketBid,
				});
			}
		}

		for (const marketAsk of this.getMarketAsks(marketIndex)) {
			if (isAuctionComplete(marketAsk.order, slot)) {
				nodesToFill.push({
					node: marketAsk,
				});
			}
		}
		return nodesToFill;
	}

	public findJitAuctionNodesToFill(
		marketIndex: BN,
		slot: number
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();
		// Then see if there are orders still in JIT auction
		for (const marketBid of this.getMarketBids(marketIndex)) {
			if (!isAuctionComplete(marketBid.order, slot)) {
				nodesToFill.push({
					node: marketBid,
				});
			}
		}

		for (const marketAsk of this.getMarketAsks(marketIndex)) {
			if (!isAuctionComplete(marketAsk.order, slot)) {
				nodesToFill.push({
					node: marketAsk,
				});
			}
		}
		return nodesToFill;
	}

	public getMarketBids(marketIndex: BN): Generator<DLOBNode> {
		return this.orderLists
			.get(marketIndex.toNumber())
			.market.bid.getGenerator();
	}

	public getMarketAsks(marketIndex: BN): Generator<DLOBNode> {
		return this.orderLists
			.get(marketIndex.toNumber())
			.market.ask.getGenerator();
	}

	*getAsks(
		marketIndex: BN,
		vAsk: BN,
		slot: number,
		oraclePriceData?: OraclePriceData
	): Generator<DLOBNode> {
		const nodeLists = this.orderLists.get(marketIndex.toNumber());

		const generators = [
			nodeLists.limit.ask.getGenerator(),
			nodeLists.floatingLimit.ask.getGenerator(),
			nodeLists.market.ask.getGenerator(),
			getVammNodeGenerator(vAsk),
		].map((generator) => {
			return {
				next: generator.next(),
				generator,
			};
		});

		let asksExhausted = false;
		while (!asksExhausted) {
			const bestGenerator = generators.reduce(
				(bestGenerator, currentGenerator) => {
					if (currentGenerator.next.done) {
						return bestGenerator;
					}

					if (bestGenerator.next.done) {
						return currentGenerator;
					}

					const bestAskPrice = bestGenerator.next.value.getPrice(
						oraclePriceData,
						slot
					);
					const currentAskPrice = currentGenerator.next.value.getPrice(
						oraclePriceData,
						slot
					);

					return bestAskPrice.lt(currentAskPrice)
						? bestGenerator
						: currentGenerator;
				}
			);

			if (!bestGenerator.next.done) {
				yield bestGenerator.next.value;
				bestGenerator.next = bestGenerator.generator.next();
			} else {
				asksExhausted = true;
			}
		}
	}

	*getBids(
		marketIndex: BN,
		vBid: BN,
		slot: number,
		oraclePriceData?: OraclePriceData
	): Generator<DLOBNode> {
		const nodeLists = this.orderLists.get(marketIndex.toNumber());

		const bidGenerators = [
			nodeLists.limit.bid.getGenerator(),
			nodeLists.floatingLimit.bid.getGenerator(),
			nodeLists.market.bid.getGenerator(),
			getVammNodeGenerator(vBid),
		].map((generator) => {
			return {
				next: generator.next(),
				generator,
			};
		});

		let bidsExhausted = false; // there will always be the vBid
		while (!bidsExhausted) {
			const bestGenerator = bidGenerators.reduce(
				(bestGenerator, currentGenerator) => {
					if (currentGenerator.next.done) {
						return bestGenerator;
					}

					if (bestGenerator.next.done) {
						return currentGenerator;
					}

					const bestBidPrice = bestGenerator.next.value.getPrice(
						oraclePriceData,
						slot
					);
					const currentBidPrice = currentGenerator.next.value.getPrice(
						oraclePriceData,
						slot
					);

					return bestBidPrice.gt(currentBidPrice)
						? bestGenerator
						: currentGenerator;
				}
			);

			if (!bestGenerator.next.done) {
				yield bestGenerator.next.value;
				bestGenerator.next = bestGenerator.generator.next();
			} else {
				bidsExhausted = true;
			}
		}
	}

	findCrossingOrders(
		askNode: DLOBNode,
		askGenerator: Generator<DLOBNode>,
		bidNode: DLOBNode,
		bidGenerator: Generator<DLOBNode>,
		oraclePriceData: OraclePriceData,
		slot: number
	): {
		crossingNodes?: CrossedNodesToFill;
		crossingSide?: Side;
	} {
		const bidPrice = bidNode.getPrice(oraclePriceData, slot);
		const askPrice = askNode.getPrice(oraclePriceData, slot);
		// no cross
		if (bidPrice.lt(askPrice)) {
			return {};
		}

		// User bid crosses the vamm ask
		// Cant match orders
		if (askNode.isVammNode()) {
			return {
				crossingSide: 'bid',
			};
		}

		// User ask crosses the vamm bid
		// Cant match orders
		if (bidNode.isVammNode()) {
			return {
				crossingSide: 'ask',
			};
		}

		const bidOrder = bidNode.order;
		const askOrder = askNode.order;

		// Two maker orders cross
		if (bidOrder.postOnly && askOrder.postOnly) {
			return {
				crossingSide: bidOrder.ts.lt(askOrder.ts) ? 'bid' : 'ask',
			};
		}

		// Bid is maker
		if (bidOrder.postOnly) {
			return {
				crossingNodes: {
					node: askNode,
					makerNode: bidNode,
				},
				crossingSide: 'ask',
			};
		}

		// Ask is maker
		if (askOrder.postOnly) {
			return {
				crossingNodes: {
					node: bidNode,
					makerNode: askNode,
				},
				crossingSide: 'bid',
			};
		}

		// Both are takers
		// older order is maker
		const newerNode = bidOrder.ts.lt(askOrder.ts) ? askNode : bidNode;
		const olderNode = askOrder.ts.lt(bidOrder.ts) ? bidNode : askNode;
		const crossingSide = askOrder.ts.lt(bidOrder.ts) ? 'bid' : 'ask';
		return {
			crossingNodes: {
				node: newerNode,
				makerNode: olderNode,
			},
			crossingSide,
		};
	}

	public getBestAsk(
		marketIndex: BN,
		vAsk: BN,
		slot: number,
		oraclePriceData: OraclePriceData
	): BN {
		return this.getAsks(marketIndex, vAsk, slot, oraclePriceData)
			.next()
			.value.getPrice(oraclePriceData, slot);
	}

	public getBestBid(
		marketIndex: BN,
		vBid: BN,
		slot: number,
		oraclePriceData: OraclePriceData
	): BN {
		return this.getBids(marketIndex, vBid, slot, oraclePriceData)
			.next()
			.value.getPrice(oraclePriceData, slot);
	}

	public findNodesToTrigger(
		marketIndex: BN,
		slot: number,
		oraclePrice: BN
	): NodeToTrigger[] {
		const nodesToTrigger = [];
		for (const node of this.orderLists
			.get(marketIndex.toNumber())
			.trigger.above.getGenerator()) {
			if (oraclePrice.gt(node.order.triggerPrice)) {
				if (isAuctionComplete(node.order, slot)) {
					nodesToTrigger.push({
						node: node,
					});
				}
			} else {
				break;
			}
		}

		for (const node of this.orderLists
			.get(marketIndex.toNumber())
			.trigger.below.getGenerator()) {
			if (oraclePrice.lt(node.order.triggerPrice)) {
				if (isAuctionComplete(node.order, slot)) {
					nodesToTrigger.push({
						node: node,
					});
				}
			} else {
				break;
			}
		}

		return nodesToTrigger;
	}

	public printTopOfOrderLists(
		sdkConfig: any,
		clearingHouse: ClearingHouse,
		slotSubscriber: SlotSubscriber,
		marketIndex: BN
	) {
		const market = clearingHouse.getMarketAccount(marketIndex);

		const slot = slotSubscriber.getSlot();
		const oraclePriceData = clearingHouse.getOracleDataForMarket(marketIndex);
		const vAsk = calculateAskPrice(market, oraclePriceData);
		const vBid = calculateBidPrice(market, oraclePriceData);

		const bestAsk = this.getBestAsk(marketIndex, vAsk, slot, oraclePriceData);
		const bestBid = this.getBestBid(marketIndex, vBid, slot, oraclePriceData);
		const mid = bestAsk.add(bestBid).div(new BN(2));

		const bidSpread =
			(convertToNumber(bestBid, MARK_PRICE_PRECISION) /
				convertToNumber(oraclePriceData.price, MARK_PRICE_PRECISION) -
				1) *
			100.0;
		const askSpread =
			(convertToNumber(bestAsk, MARK_PRICE_PRECISION) /
				convertToNumber(oraclePriceData.price, MARK_PRICE_PRECISION) -
				1) *
			100.0;

		console.log(
			`Market ${sdkConfig.MARKETS[marketIndex.toNumber()].symbol} Orders`
		);
		console.log(
			`  Ask`,
			convertToNumber(bestAsk, MARK_PRICE_PRECISION).toFixed(3),
			`(${askSpread.toFixed(4)}%)`
		);
		console.log(`  Mid`, convertToNumber(mid, MARK_PRICE_PRECISION).toFixed(3));
		console.log(
			`  Bid`,
			convertToNumber(bestBid, MARK_PRICE_PRECISION).toFixed(3),
			`(${bidSpread.toFixed(4)}%)`
		);
	}

	private updateWithOrder(
		order: Order,
		userAccount: PublicKey,
		action: OrderAction
	) {
		if (isVariant(action, 'place')) {
			this.insert(order, userAccount);
		} else if (isVariant(action, 'cancel')) {
			this.remove(order, userAccount);
		} else if (isVariant(action, 'trigger')) {
			this.trigger(order, userAccount);
		} else if (isVariant(action, 'fill')) {
			if (order.baseAssetAmount.eq(order.baseAssetAmountFilled)) {
				this.remove(order, userAccount);
			} else {
				this.update(order, userAccount);
			}
		}
	}

	public applyOrderRecord(record: OrderRecord) {
		if (!record.taker.equals(PublicKey.default)) {
			this.updateWithOrder(record.takerOrder, record.taker, record.action);
		}

		if (!record.maker.equals(PublicKey.default)) {
			this.updateWithOrder(record.makerOrder, record.maker, record.action);
		}
	}
}
