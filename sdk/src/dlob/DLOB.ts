import { getOrderSignature, getVammNodeGenerator, NodeList } from './NodeList';
import {
	MarketType,
	BN,
	calculateAskPrice,
	calculateBidPrice,
	DriftClient,
	convertToNumber,
	isAuctionComplete,
	isOrderExpired,
	isOneOfVariant,
	isVariant,
	getVariant,
	Order,
	PRICE_PRECISION,
	SpotMarketAccount,
	PerpMarketAccount,
	OraclePriceData,
	SlotSubscriber,
	MarketTypeStr,
	StateAccount,
	isMarketOrder,
	mustBeTriggered,
	isTriggered,
	getLimitPrice,
	UserMap,
	OrderRecord,
	OrderActionRecord,
	ZERO,
	BN_MAX,
} from '..';
import { PublicKey } from '@solana/web3.js';
import { DLOBNode, DLOBNodeType, TriggerOrderNode } from '..';
import { ammPaused, exchangePaused, fillPaused } from '../math/exchangeStatus';
import { DLOBOrders } from './DLOBOrders';

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

type OrderBookCallback = () => void;

export type NodeToFill = {
	node: DLOBNode;
	makerNode?: DLOBNode;
};

export type NodeToTrigger = {
	node: TriggerOrderNode;
};

const SUPPORTED_ORDER_TYPES = [
	'market',
	'limit',
	'triggerMarket',
	'triggerLimit',
	'oracle',
];

export class DLOB {
	openOrders = new Map<MarketTypeStr, Set<string>>();
	orderLists = new Map<MarketTypeStr, Map<number, MarketNodeLists>>();

	initialized = false;

	public constructor() {
		this.init();
	}

	private init() {
		this.openOrders.set('perp', new Set<string>());
		this.openOrders.set('spot', new Set<string>());
		this.orderLists.set('perp', new Map<number, MarketNodeLists>());
		this.orderLists.set('spot', new Map<number, MarketNodeLists>());
	}

	public clear() {
		for (const marketType of this.openOrders.keys()) {
			this.openOrders.get(marketType).clear();
		}
		this.openOrders.clear();

		for (const marketType of this.orderLists.keys()) {
			for (const marketIndex of this.orderLists.get(marketType).keys()) {
				const marketNodeLists = this.orderLists
					.get(marketType)
					.get(marketIndex);
				for (const side of Object.keys(marketNodeLists)) {
					for (const orderType of Object.keys(marketNodeLists[side])) {
						marketNodeLists[side][orderType].clear();
					}
				}
			}
		}
		this.orderLists.clear();

		this.init();
	}

	/**
	 * initializes a new DLOB instance
	 *
	 * @returns a promise that resolves when the DLOB is initialized
	 */
	public async initFromUserMap(userMap: UserMap): Promise<boolean> {
		if (this.initialized) {
			return false;
		}

		// initialize the dlob with the user map
		for (const user of userMap.values()) {
			const userAccount = user.getUserAccount();
			const userAccountPubkey = user.getUserAccountPublicKey();

			for (const order of userAccount.orders) {
				this.insertOrder(order, userAccountPubkey);
			}
		}

		this.initialized = true;
		return true;
	}

	public initFromOrders(dlobOrders: DLOBOrders): boolean {
		if (this.initialized) {
			return false;
		}

		for (const { user, order } of dlobOrders) {
			this.insertOrder(order, user);
		}

		this.initialized = true;
		return true;
	}

	public handleOrderRecord(record: OrderRecord): void {
		this.insertOrder(record.order, record.user);
	}

	public handleOrderActionRecord(record: OrderActionRecord): void {
		if (isOneOfVariant(record.action, ['place', 'expire'])) {
			return;
		}

		if (isVariant(record.action, 'trigger')) {
			if (record.taker !== null) {
				const takerOrder = this.getOrder(record.takerOrderId, record.taker);
				if (takerOrder) {
					this.trigger(takerOrder, record.taker);
				}
			}

			if (record.maker !== null) {
				const makerOrder = this.getOrder(record.makerOrderId, record.maker);
				if (makerOrder) {
					this.trigger(makerOrder, record.maker);
				}
			}
		} else if (isVariant(record.action, 'fill')) {
			if (record.taker !== null) {
				const takerOrder = this.getOrder(record.takerOrderId, record.taker);
				if (takerOrder) {
					this.updateOrder(
						takerOrder,
						record.taker,
						record.takerOrderCumulativeBaseAssetAmountFilled
					);
				}
			}

			if (record.maker !== null) {
				const makerOrder = this.getOrder(record.makerOrderId, record.maker);
				if (makerOrder) {
					this.updateOrder(
						makerOrder,
						record.maker,
						record.makerOrderCumulativeBaseAssetAmountFilled
					);
				}
			}
		} else if (isVariant(record.action, 'cancel')) {
			if (record.taker !== null) {
				const takerOrder = this.getOrder(record.takerOrderId, record.taker);
				if (takerOrder) {
					this.delete(takerOrder, record.taker);
				}
			}

			if (record.maker !== null) {
				const makerOrder = this.getOrder(record.makerOrderId, record.maker);
				if (makerOrder) {
					this.delete(makerOrder, record.maker);
				}
			}
		}
	}

	public insertOrder(
		order: Order,
		userAccount: PublicKey,
		onInsert?: OrderBookCallback
	): void {
		if (isVariant(order.status, 'init')) {
			return;
		}

		if (!isOneOfVariant(order.orderType, SUPPORTED_ORDER_TYPES)) {
			return;
		}

		const marketType = getVariant(order.marketType) as MarketTypeStr;

		if (!this.orderLists.get(marketType).has(order.marketIndex)) {
			this.addOrderList(marketType, order.marketIndex);
		}

		if (isVariant(order.status, 'open')) {
			this.openOrders
				.get(marketType)
				.add(getOrderSignature(order.orderId, userAccount));
		}
		this.getListForOrder(order)?.insert(order, marketType, userAccount);

		if (onInsert) {
			onInsert();
		}
	}

	addOrderList(marketType: MarketTypeStr, marketIndex: number): void {
		this.orderLists.get(marketType).set(marketIndex, {
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

	public updateOrder(
		order: Order,
		userAccount: PublicKey,
		cumulativeBaseAssetAmountFilled: BN,
		onUpdate?: OrderBookCallback
	): void {
		if (order.baseAssetAmount.eq(cumulativeBaseAssetAmountFilled)) {
			this.delete(order, userAccount);
			return;
		}

		if (order.baseAssetAmountFilled.eq(cumulativeBaseAssetAmountFilled)) {
			return;
		}

		const newOrder = {
			...order,
		};
		newOrder.baseAssetAmountFilled = cumulativeBaseAssetAmountFilled;

		this.getListForOrder(order)?.update(newOrder, userAccount);

		if (onUpdate) {
			onUpdate();
		}
	}

	public trigger(
		order: Order,
		userAccount: PublicKey,
		onTrigger?: OrderBookCallback
	): void {
		if (isVariant(order.status, 'init')) {
			return;
		}

		if (isTriggered(order)) {
			return;
		}

		const marketType = getVariant(order.marketType) as MarketTypeStr;

		const triggerList = this.orderLists.get(marketType).get(order.marketIndex)
			.trigger[isVariant(order.triggerCondition, 'above') ? 'above' : 'below'];
		triggerList.remove(order, userAccount);

		this.getListForOrder(order)?.insert(order, marketType, userAccount);
		if (onTrigger) {
			onTrigger();
		}
	}

	public delete(
		order: Order,
		userAccount: PublicKey,
		onDelete?: OrderBookCallback
	): void {
		if (isVariant(order.status, 'init')) {
			return;
		}

		this.getListForOrder(order)?.remove(order, userAccount);
		if (onDelete) {
			onDelete();
		}
	}

	public getListForOrder(order: Order): NodeList<any> | undefined {
		const isInactiveTriggerOrder =
			mustBeTriggered(order) && !isTriggered(order);

		let type: DLOBNodeType;
		if (isInactiveTriggerOrder) {
			type = 'trigger';
		} else if (
			isOneOfVariant(order.orderType, ['market', 'triggerMarket', 'oracle'])
		) {
			type = 'market';
		} else if (order.oraclePriceOffset !== 0) {
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

		const marketType = getVariant(order.marketType) as MarketTypeStr;

		if (!this.orderLists.has(marketType)) {
			return undefined;
		}

		return this.orderLists.get(marketType).get(order.marketIndex)[type][
			subType
		];
	}

	public getOrder(orderId: number, userAccount: PublicKey): Order | undefined {
		for (const nodeList of this.getNodeLists()) {
			const node = nodeList.get(orderId, userAccount);
			if (node) {
				return node.order;
			}
		}

		return undefined;
	}

	public findNodesToFill(
		marketIndex: number,
		fallbackBid: BN | undefined,
		fallbackAsk: BN | undefined,
		slot: number,
		ts: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		stateAccount: StateAccount,
		marketAccount: PerpMarketAccount | SpotMarketAccount
	): NodeToFill[] {
		if (fillPaused(stateAccount, marketAccount)) {
			return [];
		}

		const isAmmPaused = ammPaused(stateAccount, marketAccount);

		const marketOrderNodesToFill: Array<NodeToFill> =
			this.findMarketNodesToFill(
				marketIndex,
				slot,
				marketType,
				oraclePriceData,
				isAmmPaused,
				fallbackAsk,
				fallbackBid
			);

		const limitOrderNodesToFill: Array<NodeToFill> =
			this.findLimitOrderNodesToFill(
				marketIndex,
				slot,
				marketType,
				oraclePriceData,
				isAmmPaused,
				fallbackAsk,
				fallbackBid
			);

		// get expired market nodes
		const expiredNodesToFill = this.findExpiredNodesToFill(
			marketIndex,
			ts,
			marketType
		);
		return marketOrderNodesToFill.concat(
			limitOrderNodesToFill,
			expiredNodesToFill
		);
	}

	public findLimitOrderNodesToFill(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		isAmmPaused: boolean,
		fallbackAsk: BN | undefined,
		fallbackBid: BN | undefined
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		const crossingNodes = this.findCrossingLimitOrders(
			marketIndex,
			slot,
			marketType,
			oraclePriceData,
			fallbackAsk,
			fallbackBid
		);

		for (const crossingNode of crossingNodes) {
			nodesToFill.push(crossingNode);
		}

		if (fallbackBid && !isAmmPaused) {
			const askGenerator = this.getLimitAsks(
				marketIndex,
				slot,
				marketType,
				oraclePriceData
			);
			const asksCrossingFallback = this.findNodesCrossingFallbackLiquidity(
				marketType,
				slot,
				oraclePriceData,
				askGenerator,
				fallbackBid,
				(askPrice, fallbackPrice) => {
					return askPrice.lte(fallbackPrice);
				}
			);

			for (const askCrossingFallback of asksCrossingFallback) {
				nodesToFill.push(askCrossingFallback);
			}
		}

		if (fallbackAsk && !isAmmPaused) {
			const bidGenerator = this.getLimitBids(
				marketIndex,
				slot,
				marketType,
				oraclePriceData
			);
			const bidsCrossingFallback = this.findNodesCrossingFallbackLiquidity(
				marketType,
				slot,
				oraclePriceData,
				bidGenerator,
				fallbackAsk,
				(bidPrice, fallbackPrice) => {
					return bidPrice.gte(fallbackPrice);
				}
			);

			for (const bidCrossingFallback of bidsCrossingFallback) {
				nodesToFill.push(bidCrossingFallback);
			}
		}

		return nodesToFill;
	}

	public findMarketNodesToFill(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		isAmmPaused: boolean,
		fallbackAsk: BN | undefined,
		fallbackBid?: BN | undefined
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		let marketOrderGenerator = this.getMarketAsks(marketIndex, marketType);

		const marketAsksCrossingBids = this.findMarketNodesCrossingLimitNodes(
			marketIndex,
			slot,
			marketType,
			oraclePriceData,
			marketOrderGenerator,
			this.getLimitBids.bind(this),
			(takerPrice, makerPrice) => {
				return takerPrice === undefined || takerPrice.lte(makerPrice);
			}
		);
		for (const marketAskCrossingBid of marketAsksCrossingBids) {
			nodesToFill.push(marketAskCrossingBid);
		}

		if (fallbackBid && !isAmmPaused) {
			marketOrderGenerator = this.getMarketAsks(marketIndex, marketType);
			const marketAsksCrossingFallback =
				this.findNodesCrossingFallbackLiquidity(
					marketType,
					slot,
					oraclePriceData,
					marketOrderGenerator,
					fallbackBid,
					(takerPrice, fallbackPrice) => {
						return takerPrice === undefined || takerPrice.lte(fallbackPrice);
					}
				);

			for (const marketAskCrossingFallback of marketAsksCrossingFallback) {
				nodesToFill.push(marketAskCrossingFallback);
			}
		}

		marketOrderGenerator = this.getMarketBids(marketIndex, marketType);

		const marketBidsToFill = this.findMarketNodesCrossingLimitNodes(
			marketIndex,
			slot,
			marketType,
			oraclePriceData,
			marketOrderGenerator,
			this.getLimitAsks.bind(this),
			(takerPrice, fallbackPrice) => {
				return takerPrice === undefined || takerPrice.gte(fallbackPrice);
			}
		);

		for (const marketBidToFill of marketBidsToFill) {
			nodesToFill.push(marketBidToFill);
		}

		if (fallbackAsk && !isAmmPaused) {
			marketOrderGenerator = this.getMarketBids(marketIndex, marketType);
			const marketBidsCrossingFallback =
				this.findNodesCrossingFallbackLiquidity(
					marketType,
					slot,
					oraclePriceData,
					marketOrderGenerator,
					fallbackAsk,
					(takerPrice, fallbackPrice) => {
						return takerPrice === undefined || takerPrice.gte(fallbackPrice);
					}
				);
			for (const marketBidCrossingFallback of marketBidsCrossingFallback) {
				nodesToFill.push(marketBidCrossingFallback);
			}
		}

		return nodesToFill;
	}

	public findMarketNodesCrossingLimitNodes(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		takerNodeGenerator: Generator<DLOBNode>,
		makerNodeGeneratorFn: (
			marketIndex: number,
			slot: number,
			marketType: MarketType,
			oraclePriceData: OraclePriceData
		) => Generator<DLOBNode>,
		doesCross: (takerPrice: BN | undefined, makerPrice: BN) => boolean
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		for (const takerNode of takerNodeGenerator) {
			const makerNodeGenerator = makerNodeGeneratorFn(
				marketIndex,
				slot,
				marketType,
				oraclePriceData
			);

			for (const makerNode of makerNodeGenerator) {
				// Can't match orders from the same user
				const sameUser = takerNode.userAccount.equals(makerNode.userAccount);
				if (sameUser) {
					continue;
				}

				const makerPrice = makerNode.getPrice(oraclePriceData, slot);
				const takerPrice = takerNode.getPrice(oraclePriceData, slot);

				const ordersCross = doesCross(takerPrice, makerPrice);
				if (!ordersCross) {
					// market orders aren't sorted by price, they are sorted by time, so we need to traverse
					// through all of em
					break;
				}

				nodesToFill.push({
					node: takerNode,
					makerNode: makerNode,
				});

				const makerOrder = makerNode.order;
				const takerOrder = takerNode.order;

				const makerBaseRemaining = makerOrder.baseAssetAmount.sub(
					makerOrder.baseAssetAmountFilled
				);
				const takerBaseRemaining = takerOrder.baseAssetAmount.sub(
					takerOrder.baseAssetAmountFilled
				);

				const baseFilled = BN.min(makerBaseRemaining, takerBaseRemaining);

				const newMakerOrder = { ...makerOrder };
				newMakerOrder.baseAssetAmountFilled =
					makerOrder.baseAssetAmountFilled.add(baseFilled);
				this.getListForOrder(newMakerOrder).update(
					newMakerOrder,
					makerNode.userAccount
				);

				const newTakerOrder = { ...takerOrder };
				newTakerOrder.baseAssetAmountFilled =
					takerOrder.baseAssetAmountFilled.add(baseFilled);
				this.getListForOrder(newTakerOrder).update(
					newTakerOrder,
					takerNode.userAccount
				);

				if (
					newTakerOrder.baseAssetAmountFilled.eq(takerOrder.baseAssetAmount)
				) {
					break;
				}
			}
		}

		return nodesToFill;
	}

	public findNodesCrossingFallbackLiquidity(
		marketType: MarketType,
		slot: number,
		oraclePriceData: OraclePriceData,
		nodeGenerator: Generator<DLOBNode>,
		fallbackPrice: BN,
		doesCross: (nodePrice: BN | undefined, fallbackPrice: BN) => boolean
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		let nextNode = nodeGenerator.next();
		while (!nextNode.done) {
			const node = nextNode.value;

			if (isVariant(marketType, 'spot') && node.order?.postOnly) {
				nextNode = nodeGenerator.next();
				continue;
			}

			const nodePrice = getLimitPrice(node.order, oraclePriceData, slot);

			// order crosses if there is no limit price or it crosses fallback price
			const crosses = doesCross(nodePrice, fallbackPrice);

			// fallback is available if auction is complete or it's a spot order
			const fallbackAvailable =
				isVariant(marketType, 'spot') || isAuctionComplete(node.order, slot);

			if (crosses && fallbackAvailable) {
				nodesToFill.push({
					node: node,
					makerNode: undefined, // filled by fallback
				});
			}

			nextNode = nodeGenerator.next();
		}

		return nodesToFill;
	}

	public findExpiredNodesToFill(
		marketIndex: number,
		ts: number,
		marketType: MarketType
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const nodeLists = this.orderLists.get(marketTypeStr).get(marketIndex);

		if (!nodeLists) {
			return nodesToFill;
		}

		// All bids/asks that can expire
		const bidGenerators = [
			nodeLists.limit.bid.getGenerator(),
			nodeLists.floatingLimit.bid.getGenerator(),
			nodeLists.market.bid.getGenerator(),
		];
		const askGenerators = [
			nodeLists.limit.ask.getGenerator(),
			nodeLists.floatingLimit.ask.getGenerator(),
			nodeLists.market.ask.getGenerator(),
		];

		for (const bidGenerator of bidGenerators) {
			for (const bid of bidGenerator) {
				if (isOrderExpired(bid.order, ts)) {
					nodesToFill.push({
						node: bid,
					});
				}
			}
		}

		for (const askGenerator of askGenerators) {
			for (const ask of askGenerator) {
				if (isOrderExpired(ask.order, ts)) {
					nodesToFill.push({
						node: ask,
					});
				}
			}
		}

		return nodesToFill;
	}

	public findJitAuctionNodesToFill(
		marketIndex: number,
		slot: number,
		marketType: MarketType
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();
		// Then see if there are orders still in JIT auction
		for (const marketBid of this.getMarketBids(marketIndex, marketType)) {
			if (!isAuctionComplete(marketBid.order, slot)) {
				nodesToFill.push({
					node: marketBid,
				});
			}
		}

		for (const marketAsk of this.getMarketAsks(marketIndex, marketType)) {
			if (!isAuctionComplete(marketAsk.order, slot)) {
				nodesToFill.push({
					node: marketAsk,
				});
			}
		}
		return nodesToFill;
	}

	*getMarketBids(
		marketIndex: number,
		marketType: MarketType
	): Generator<DLOBNode> {
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const orderLists = this.orderLists.get(marketTypeStr).get(marketIndex);
		if (!orderLists) {
			return;
		}

		const generator = orderLists.market.bid.getGenerator();
		for (const marketBidNode of generator) {
			if (marketBidNode.isBaseFilled()) {
				continue;
			}
			yield marketBidNode;
		}
	}

	*getMarketAsks(
		marketIndex: number,
		marketType: MarketType
	): Generator<DLOBNode> {
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const orderLists = this.orderLists.get(marketTypeStr).get(marketIndex);
		if (!orderLists) {
			return;
		}

		const generator = orderLists.market.ask.getGenerator();
		for (const marketAskNode of generator) {
			if (marketAskNode.isBaseFilled()) {
				continue;
			}
			yield marketAskNode;
		}
	}

	private *getBestNode(
		generatorList: Array<Generator<DLOBNode>>,
		oraclePriceData: OraclePriceData,
		slot: number,
		compareFcn: (bestPrice: BN, currentPrice: BN) => boolean
	): Generator<DLOBNode> {
		const generators = generatorList.map((generator) => {
			return {
				next: generator.next(),
				generator,
			};
		});

		let sideExhausted = false;
		while (!sideExhausted) {
			const bestGenerator = generators.reduce(
				(bestGenerator, currentGenerator) => {
					if (currentGenerator.next.done) {
						return bestGenerator;
					}

					if (bestGenerator.next.done) {
						return currentGenerator;
					}

					const bestValue = bestGenerator.next.value as DLOBNode;
					const currentValue = currentGenerator.next.value as DLOBNode;

					// always return the market orders first
					if (bestValue.order && isMarketOrder(bestValue.order)) {
						return bestGenerator;
					}
					if (currentValue.order && isMarketOrder(currentValue.order)) {
						return currentGenerator;
					}

					const bestPrice = bestValue.getPrice(oraclePriceData, slot);
					const currentPrice = currentValue.getPrice(oraclePriceData, slot);

					return compareFcn(bestPrice, currentPrice)
						? bestGenerator
						: currentGenerator;
				}
			);

			if (!bestGenerator.next.done) {
				// skip this node if it's already completely filled
				if (bestGenerator.next.value.isBaseFilled()) {
					bestGenerator.next = bestGenerator.generator.next();
					continue;
				}

				yield bestGenerator.next.value;
				bestGenerator.next = bestGenerator.generator.next();
			} else {
				sideExhausted = true;
			}
		}
	}

	*getLimitAsks(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): Generator<DLOBNode> {
		if (isVariant(marketType, 'spot') && !oraclePriceData) {
			throw new Error('Must provide OraclePriceData to get spot asks');
		}
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const nodeLists = this.orderLists.get(marketTypeStr).get(marketIndex);

		if (!nodeLists) {
			return;
		}

		const generatorList = [
			nodeLists.limit.ask.getGenerator(),
			nodeLists.floatingLimit.ask.getGenerator(),
		];

		yield* this.getBestNode(
			generatorList,
			oraclePriceData,
			slot,
			(bestPrice, currentPrice) => {
				return bestPrice.lt(currentPrice);
			}
		);
	}

	/**
	 * Filters the limit asks that are post only or have been place for sufficiently long
	 * Useful for displaying order book that doesn't have taker limit orders crossing spread
	 *
	 * @returns
	 */
	*getRestingLimitAsks(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		minPerpAuctionDuration: number
	): Generator<DLOBNode> {
		for (const node of this.getLimitAsks(
			marketIndex,
			slot,
			marketType,
			oraclePriceData
		)) {
			if (this.isRestingLimitOrder(node.order, slot, minPerpAuctionDuration)) {
				yield node;
			}
		}
	}

	isRestingLimitOrder(
		order: Order,
		slot: number,
		minPerpAuctionDuration: number
	): boolean {
		return (
			order.postOnly ||
			new BN(slot).sub(order.slot).gte(new BN(minPerpAuctionDuration * 1.5))
		);
	}

	*getLimitBids(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): Generator<DLOBNode> {
		if (isVariant(marketType, 'spot') && !oraclePriceData) {
			throw new Error('Must provide OraclePriceData to get spot bids');
		}

		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const nodeLists = this.orderLists.get(marketTypeStr).get(marketIndex);

		if (!nodeLists) {
			return;
		}

		const generatorList = [
			nodeLists.limit.bid.getGenerator(),
			nodeLists.floatingLimit.bid.getGenerator(),
		];

		yield* this.getBestNode(
			generatorList,
			oraclePriceData,
			slot,
			(bestPrice, currentPrice) => {
				return bestPrice.gt(currentPrice);
			}
		);
	}

	/**
	 * Filters the limit bids that are post only or have been place for sufficiently long
	 * Useful for displaying order book that doesn't have taker limit orders crossing spread
	 *
	 * @returns
	 */
	*getRestingLimitBids(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		minPerpAuctionDuration: number
	): Generator<DLOBNode> {
		for (const node of this.getLimitBids(
			marketIndex,
			slot,
			marketType,
			oraclePriceData
		)) {
			if (this.isRestingLimitOrder(node.order, slot, minPerpAuctionDuration)) {
				yield node;
			}
		}
	}

	*getAsks(
		marketIndex: number,
		fallbackAsk: BN | undefined,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): Generator<DLOBNode> {
		if (isVariant(marketType, 'spot') && !oraclePriceData) {
			throw new Error('Must provide OraclePriceData to get spot asks');
		}

		const generatorList = [
			this.getMarketAsks(marketIndex, marketType),
			this.getLimitAsks(marketIndex, slot, marketType, oraclePriceData),
		];

		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		if (marketTypeStr === 'perp' && fallbackAsk) {
			generatorList.push(getVammNodeGenerator(fallbackAsk));
		}

		yield* this.getBestNode(
			generatorList,
			oraclePriceData,
			slot,
			(bestPrice, currentPrice) => {
				return bestPrice.lt(currentPrice);
			}
		);
	}

	*getBids(
		marketIndex: number,
		fallbackBid: BN | undefined,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): Generator<DLOBNode> {
		if (isVariant(marketType, 'spot') && !oraclePriceData) {
			throw new Error('Must provide OraclePriceData to get spot bids');
		}

		const generatorList = [
			this.getMarketBids(marketIndex, marketType),
			this.getLimitBids(marketIndex, slot, marketType, oraclePriceData),
		];

		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		if (marketTypeStr === 'perp' && fallbackBid) {
			generatorList.push(getVammNodeGenerator(fallbackBid));
		}

		yield* this.getBestNode(
			generatorList,
			oraclePriceData,
			slot,
			(bestPrice, currentPrice) => {
				return bestPrice.gt(currentPrice);
			}
		);
	}

	findCrossingLimitOrders(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		fallbackAsk: BN | undefined,
		fallbackBid: BN | undefined
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		for (const askNode of this.getLimitAsks(
			marketIndex,
			slot,
			marketType,
			oraclePriceData
		)) {
			for (const bidNode of this.getLimitBids(
				marketIndex,
				slot,
				marketType,
				oraclePriceData
			)) {
				const bidPrice = bidNode.getPrice(oraclePriceData, slot);
				const askPrice = askNode.getPrice(oraclePriceData, slot);

				// orders don't cross - we're done walking the book
				if (bidPrice.lt(askPrice)) {
					return nodesToFill;
				}

				const bidOrder = bidNode.order;
				const askOrder = askNode.order;

				// Can't match orders from the same user
				const sameUser = bidNode.userAccount.equals(askNode.userAccount);
				if (sameUser || (bidOrder.postOnly && askOrder.postOnly)) {
					continue;
				}

				const { takerNode, makerNode } = this.determineMakerAndTaker(
					askNode,
					bidNode
				);

				// extra guard against bad fills for limit orders where auction is incomplete
				if (!isAuctionComplete(takerNode.order, slot)) {
					let bidPrice: BN;
					let askPrice: BN;
					if (isVariant(takerNode.order.direction, 'long')) {
						bidPrice = BN.min(
							takerNode.getPrice(oraclePriceData, slot),
							fallbackAsk || BN_MAX
						);
						askPrice = makerNode.getPrice(oraclePriceData, slot);
					} else {
						bidPrice = makerNode.getPrice(oraclePriceData, slot);
						askPrice = BN.max(
							takerNode.getPrice(oraclePriceData, slot),
							fallbackBid || ZERO
						);
					}

					if (bidPrice.lt(askPrice)) {
						continue;
					}
				}

				const bidBaseRemaining = bidOrder.baseAssetAmount.sub(
					bidOrder.baseAssetAmountFilled
				);
				const askBaseRemaining = askOrder.baseAssetAmount.sub(
					askOrder.baseAssetAmountFilled
				);

				const baseFilled = BN.min(bidBaseRemaining, askBaseRemaining);

				const newBidOrder = { ...bidOrder };
				newBidOrder.baseAssetAmountFilled =
					bidOrder.baseAssetAmountFilled.add(baseFilled);
				this.getListForOrder(newBidOrder).update(
					newBidOrder,
					bidNode.userAccount
				);

				// ask completely filled
				const newAskOrder = { ...askOrder };
				newAskOrder.baseAssetAmountFilled =
					askOrder.baseAssetAmountFilled.add(baseFilled);
				this.getListForOrder(newAskOrder).update(
					newAskOrder,
					askNode.userAccount
				);

				nodesToFill.push({
					node: takerNode,
					makerNode: makerNode,
				});

				if (newAskOrder.baseAssetAmount.eq(newAskOrder.baseAssetAmountFilled)) {
					break;
				}
			}
		}

		return nodesToFill;
	}

	determineMakerAndTaker(
		askNode: DLOBNode,
		bidNode: DLOBNode
	): { takerNode: DLOBNode; makerNode: DLOBNode } {
		if (bidNode.order.postOnly) {
			return {
				takerNode: askNode,
				makerNode: bidNode,
			};
		} else if (askNode.order.postOnly) {
			return {
				takerNode: bidNode,
				makerNode: askNode,
			};
		} else if (askNode.order.slot.lt(bidNode.order.slot)) {
			return {
				takerNode: bidNode,
				makerNode: askNode,
			};
		} else {
			return {
				takerNode: askNode,
				makerNode: bidNode,
			};
		}
	}

	public getBestAsk(
		marketIndex: number,
		fallbackAsk: BN | undefined,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): BN {
		return this.getAsks(
			marketIndex,
			fallbackAsk,
			slot,
			marketType,
			oraclePriceData
		)
			.next()
			.value.getPrice(oraclePriceData, slot);
	}

	public getBestBid(
		marketIndex: number,
		fallbackBid: BN | undefined,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): BN {
		return this.getBids(
			marketIndex,
			fallbackBid,
			slot,
			marketType,
			oraclePriceData
		)
			.next()
			.value.getPrice(oraclePriceData, slot);
	}

	public findNodesToTrigger(
		marketIndex: number,
		slot: number,
		oraclePrice: BN,
		marketType: MarketType,
		stateAccount: StateAccount
	): NodeToTrigger[] {
		if (exchangePaused(stateAccount)) {
			return [];
		}

		const nodesToTrigger = [];
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const marketNodeLists = this.orderLists.get(marketTypeStr).get(marketIndex);

		const triggerAboveList = marketNodeLists
			? marketNodeLists.trigger.above
			: undefined;
		if (triggerAboveList) {
			for (const node of triggerAboveList.getGenerator()) {
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
		}

		const triggerBelowList = marketNodeLists
			? marketNodeLists.trigger.below
			: undefined;
		if (triggerBelowList) {
			for (const node of triggerBelowList.getGenerator()) {
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
		}

		return nodesToTrigger;
	}

	public printTopOfOrderLists(
		sdkConfig: any,
		driftClient: DriftClient,
		slotSubscriber: SlotSubscriber,
		marketIndex: number,
		marketType: MarketType
	) {
		if (isVariant(marketType, 'perp')) {
			const market = driftClient.getPerpMarketAccount(marketIndex);

			const slot = slotSubscriber.getSlot();
			const oraclePriceData =
				driftClient.getOracleDataForPerpMarket(marketIndex);
			const fallbackAsk = calculateAskPrice(market, oraclePriceData);
			const fallbackBid = calculateBidPrice(market, oraclePriceData);

			const bestAsk = this.getBestAsk(
				marketIndex,
				fallbackAsk,
				slot,
				marketType,
				oraclePriceData
			);
			const bestBid = this.getBestBid(
				marketIndex,
				fallbackBid,
				slot,
				marketType,
				oraclePriceData
			);
			const mid = bestAsk.add(bestBid).div(new BN(2));

			const bidSpread =
				(convertToNumber(bestBid, PRICE_PRECISION) /
					convertToNumber(oraclePriceData.price, PRICE_PRECISION) -
					1) *
				100.0;
			const askSpread =
				(convertToNumber(bestAsk, PRICE_PRECISION) /
					convertToNumber(oraclePriceData.price, PRICE_PRECISION) -
					1) *
				100.0;

			console.log(`Market ${sdkConfig.MARKETS[marketIndex].symbol} Orders`);
			console.log(
				`  Ask`,
				convertToNumber(bestAsk, PRICE_PRECISION).toFixed(3),
				`(${askSpread.toFixed(4)}%)`
			);
			console.log(`  Mid`, convertToNumber(mid, PRICE_PRECISION).toFixed(3));
			console.log(
				`  Bid`,
				convertToNumber(bestBid, PRICE_PRECISION).toFixed(3),
				`(${bidSpread.toFixed(4)}%)`
			);
		} else if (isVariant(marketType, 'spot')) {
			const slot = slotSubscriber.getSlot();
			const oraclePriceData =
				driftClient.getOracleDataForPerpMarket(marketIndex);

			const bestAsk = this.getBestAsk(
				marketIndex,
				undefined,
				slot,
				marketType,
				oraclePriceData
			);
			const bestBid = this.getBestBid(
				marketIndex,
				undefined,
				slot,
				marketType,
				oraclePriceData
			);
			const mid = bestAsk.add(bestBid).div(new BN(2));

			const bidSpread =
				(convertToNumber(bestBid, PRICE_PRECISION) /
					convertToNumber(oraclePriceData.price, PRICE_PRECISION) -
					1) *
				100.0;
			const askSpread =
				(convertToNumber(bestAsk, PRICE_PRECISION) /
					convertToNumber(oraclePriceData.price, PRICE_PRECISION) -
					1) *
				100.0;

			console.log(`Market ${sdkConfig.MARKETS[marketIndex].symbol} Orders`);
			console.log(
				`  Ask`,
				convertToNumber(bestAsk, PRICE_PRECISION).toFixed(3),
				`(${askSpread.toFixed(4)}%)`
			);
			console.log(`  Mid`, convertToNumber(mid, PRICE_PRECISION).toFixed(3));
			console.log(
				`  Bid`,
				convertToNumber(bestBid, PRICE_PRECISION).toFixed(3),
				`(${bidSpread.toFixed(4)}%)`
			);
		}
	}

	public getDLOBOrders(): DLOBOrders {
		const dlobOrders: DLOBOrders = [];

		for (const nodeList of this.getNodeLists()) {
			for (const node of nodeList.getGenerator()) {
				dlobOrders.push({
					user: node.userAccount,
					order: node.order,
				});
			}
		}

		return dlobOrders;
	}

	*getNodeLists(): Generator<NodeList<DLOBNodeType>> {
		for (const [_, nodeLists] of this.orderLists.get('perp')) {
			yield nodeLists.limit.bid;
			yield nodeLists.limit.ask;
			yield nodeLists.market.bid;
			yield nodeLists.market.ask;
			yield nodeLists.floatingLimit.bid;
			yield nodeLists.floatingLimit.ask;
			yield nodeLists.trigger.above;
			yield nodeLists.trigger.below;
		}

		for (const [_, nodeLists] of this.orderLists.get('spot')) {
			yield nodeLists.limit.bid;
			yield nodeLists.limit.ask;
			yield nodeLists.market.bid;
			yield nodeLists.market.ask;
			yield nodeLists.floatingLimit.bid;
			yield nodeLists.floatingLimit.ask;
			yield nodeLists.trigger.above;
			yield nodeLists.trigger.below;
		}
	}
}
