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
	UserMapInterface,
	MarketTypeStr,
	StateAccount,
	isMarketOrder,
	mustBeTriggered,
	isTriggered,
	getLimitPrice,
} from '..';
import { PublicKey } from '@solana/web3.js';
import { DLOBNode, DLOBNodeType, TriggerOrderNode } from '..';
import { ammPaused, exchangePaused, fillPaused } from '../math/exchangeStatus';

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

type Side = 'ask' | 'bid' | 'both' | 'nocross';

export class DLOB {
	openOrders = new Map<MarketTypeStr, Set<string>>();
	orderLists = new Map<MarketTypeStr, Map<number, MarketNodeLists>>();
	stateAccount: StateAccount;
	marketIndexToAccount = new Map<
		MarketTypeStr,
		Map<number, PerpMarketAccount | SpotMarketAccount>
	>();

	userMap: UserMapInterface;
	silent = false;
	initialized = false;

	/**
	 *
	 * @param perpMarkets The perp markets to maintain a DLOB for
	 * @param spotMarkets The spot markets to maintain a DLOB for
	 * @param userMap map of all users
	 * @param silent set to true to prevent logging on inserts and removals
	 */
	public constructor(
		perpMarkets: PerpMarketAccount[],
		spotMarkets: SpotMarketAccount[],
		stateAccount: StateAccount,
		userMap: UserMapInterface,
		silent?: boolean
	) {
		this.stateAccount = stateAccount;
		this.userMap = userMap;
		this.silent = silent;

		this.openOrders.set('perp', new Set<string>());
		this.openOrders.set('spot', new Set<string>());
		this.orderLists.set('perp', new Map<number, MarketNodeLists>());
		this.orderLists.set('spot', new Map<number, MarketNodeLists>());
		this.marketIndexToAccount.set('perp', new Map<number, PerpMarketAccount>());
		this.marketIndexToAccount.set('spot', new Map<number, SpotMarketAccount>());

		for (const market of perpMarkets) {
			const marketIndex = market.marketIndex;
			this.marketIndexToAccount.get('perp').set(marketIndex, market);

			this.orderLists.get('perp').set(marketIndex, {
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
		for (const market of spotMarkets) {
			const marketIndex = market.marketIndex;
			this.marketIndexToAccount.get('spot').set(marketIndex, market);

			this.orderLists.get('spot').set(marketIndex, {
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

		for (const marketType of this.marketIndexToAccount.keys()) {
			this.marketIndexToAccount.get(marketType).clear();
		}
		this.marketIndexToAccount.clear();
	}

	/**
	 * initializes a new DLOB instance
	 *
	 * @returns a promise that resolves when the DLOB is initialized
	 */
	public async init(): Promise<boolean> {
		if (this.initialized) {
			return false;
		}

		// initialize the dlob with the user map (prevents hitting getProgramAccounts)
		for (const user of this.userMap.values()) {
			const userAccount = user.getUserAccount();
			const userAccountPubkey = user.getUserAccountPublicKey();

			for (const order of userAccount.orders) {
				this.insertOrder(order, userAccountPubkey);
			}
		}

		this.initialized = true;
		return true;
	}

	public insertOrder(
		order: Order,
		userAccount: PublicKey,
		onInsert?: OrderBookCallback
	): void {
		if (isVariant(order.status, 'init')) {
			return;
		}

		const marketType = getVariant(order.marketType) as MarketTypeStr;

		if (isVariant(order.status, 'open')) {
			this.openOrders
				.get(marketType)
				.add(getOrderSignature(order.orderId, userAccount));
		}
		this.getListForOrder(order)?.insert(
			order,
			marketType,
			this.marketIndexToAccount.get(marketType).get(order.marketIndex),
			userAccount
		);

		if (onInsert) {
			onInsert();
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

		const marketType = getVariant(order.marketType) as MarketTypeStr;

		const triggerList = this.orderLists.get(marketType).get(order.marketIndex)
			.trigger[isVariant(order.triggerCondition, 'above') ? 'above' : 'below'];
		triggerList.remove(order, userAccount);

		this.getListForOrder(order)?.insert(
			order,
			marketType,
			this.marketIndexToAccount.get(marketType).get(order.marketIndex),
			userAccount
		);
		if (onTrigger) {
			onTrigger();
		}
	}

	public getListForOrder(order: Order): NodeList<any> | undefined {
		const isInactiveTriggerOrder =
			mustBeTriggered(order) && !isTriggered(order);

		let type: DLOBNodeType;
		if (isInactiveTriggerOrder) {
			type = 'trigger';
		} else if (isOneOfVariant(order.orderType, ['market', 'triggerMarket'])) {
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

	public findNodesToFill(
		marketIndex: number,
		fallbackBid: BN | undefined,
		fallbackAsk: BN | undefined,
		slot: number,
		ts: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): NodeToFill[] {
		const marketAccount = this.marketIndexToAccount
			.get(getVariant(marketType) as MarketTypeStr)
			.get(marketIndex);

		if (fillPaused(this.stateAccount, marketAccount)) {
			return [];
		}

		const isAmmPaused = ammPaused(this.stateAccount, marketAccount);

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

		let askGenerator = this.getLimitAsks(
			marketIndex,
			slot,
			marketType,
			oraclePriceData
		);

		let bidGenerator = this.getLimitBids(
			marketIndex,
			slot,
			marketType,
			oraclePriceData
		);

		let nextAsk = askGenerator.next();
		let nextBid = bidGenerator.next();

		// First try to find orders that cross
		while (!nextAsk.done && !nextBid.done) {
			const { crossingNodes, exhaustedSide } = this.findCrossingLimitOrders(
				nextAsk.value,
				nextBid.value,
				oraclePriceData,
				slot
			);

			if (exhaustedSide === 'bid') {
				nextBid = bidGenerator.next();
			} else if (exhaustedSide === 'ask') {
				nextAsk = askGenerator.next();
			} else if (exhaustedSide === 'both') {
				nextBid = bidGenerator.next();
				nextAsk = askGenerator.next();
			} else if (exhaustedSide === 'nocross') {
				break;
			} else {
				console.error(`invalid exhaustedSide: ${exhaustedSide}`);
				break;
			}

			for (const crossingNode of crossingNodes) {
				nodesToFill.push(crossingNode);
			}
		}

		if (fallbackBid && !isAmmPaused) {
			askGenerator = this.getLimitAsks(
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
			bidGenerator = this.getLimitBids(
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
				const bidUserAuthority = this.userMap.getUserAuthority(
					makerNode.userAccount.toString()
				);
				const askUserAuthority = this.userMap.getUserAuthority(
					takerNode.userAccount.toString()
				);

				// Can't match orders from the same authority
				const sameAuthority = bidUserAuthority.equals(askUserAuthority);

				if (sameAuthority) {
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
		const generator = this.orderLists
			.get(marketTypeStr)
			.get(marketIndex)
			.market.bid.getGenerator();
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
		const generator = this.orderLists
			.get(marketTypeStr)
			.get(marketIndex)
			.market.ask.getGenerator();
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

				// skip order if user is being liquidated/bankrupt
				if (bestGenerator.next.value.userAccount !== undefined) {
					const user = this.userMap.get(
						bestGenerator.next.value.userAccount.toString()
					);
					if (user?.isBeingLiquidated()) {
						bestGenerator.next = bestGenerator.generator.next();
						continue;
					}
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
		askNode: DLOBNode,
		bidNode: DLOBNode,
		oraclePriceData: OraclePriceData,
		slot: number
	): {
		crossingNodes: NodeToFill[];
		exhaustedSide: Side;
	} {
		const bidPrice = bidNode.getPrice(oraclePriceData, slot);
		const askPrice = askNode.getPrice(oraclePriceData, slot);

		// orders don't cross - we're done walkin gup the book
		if (bidPrice.lt(askPrice)) {
			return {
				crossingNodes: [],
				exhaustedSide: 'nocross',
			};
		}

		const bidOrder = bidNode.order;
		const askOrder = askNode.order;

		const bidUserAuthority = this.userMap.getUserAuthority(
			bidNode.userAccount.toString()
		);
		const askUserAuthority = this.userMap.getUserAuthority(
			askNode.userAccount.toString()
		);

		// Can't match orders from the same authority
		const sameAuthority = bidUserAuthority.equals(askUserAuthority);
		if (sameAuthority || (bidOrder.postOnly && askOrder.postOnly)) {
			// don't have a principle way to pick which one to exhaust,
			// exhaust each one 50% of the time so we can try each one against other orders
			const exhaustedSide = Math.random() < 0.5 ? 'bid' : 'ask';
			return {
				crossingNodes: [],
				exhaustedSide,
			};
		}

		const { takerNode, makerNode } = this.determineMakerAndTaker(
			askNode,
			bidNode
		);

		const bidBaseRemaining = bidOrder.baseAssetAmount.sub(
			bidOrder.baseAssetAmountFilled
		);
		const askBaseRemaining = askOrder.baseAssetAmount.sub(
			askOrder.baseAssetAmountFilled
		);

		let exhaustedSide: Side;
		if (bidBaseRemaining.eq(askBaseRemaining)) {
			exhaustedSide = 'both';
		} else if (bidBaseRemaining.gt(askBaseRemaining)) {
			exhaustedSide = 'ask';
		} else {
			exhaustedSide = 'bid';
		}

		// update the orders on DLOB as if they were fill - so we don't try to match them on the next iteration
		// NOTE: if something goes wrong during the actual fill (transaction fails, i.e. due to orders already being filled)
		// then we risk having a mismatch between this local DLOB and the actual DLOB state on the blockchain. This isn't
		// a problem in the current implementation because we construct a new DLOB from the blockchain state every time, rather
		// than updating the existing DLOB based on events.
		if (exhaustedSide === 'ask') {
			// bid partially filled
			const newBidOrder = { ...bidOrder };
			newBidOrder.baseAssetAmountFilled =
				bidOrder.baseAssetAmountFilled.add(askBaseRemaining);
			this.getListForOrder(newBidOrder).update(
				newBidOrder,
				bidNode.userAccount
			);

			// ask completely filled
			const newAskOrder = { ...askOrder };
			newAskOrder.baseAssetAmountFilled = askOrder.baseAssetAmount;
			this.getListForOrder(newAskOrder).update(
				newAskOrder,
				askNode.userAccount
			);
		} else if (exhaustedSide === 'bid') {
			// ask partially filled
			const newAskOrder = { ...askOrder };
			newAskOrder.baseAssetAmountFilled =
				askOrder.baseAssetAmountFilled.add(bidBaseRemaining);
			this.getListForOrder(newAskOrder).update(
				newAskOrder,
				askNode.userAccount
			);

			// bid completely filled
			const newBidOrder = { ...bidOrder };
			newBidOrder.baseAssetAmountFilled = bidOrder.baseAssetAmount;
			this.getListForOrder(newBidOrder).update(
				newBidOrder,
				bidNode.userAccount
			);
		} else {
			// both completely filled
			const newBidOrder = { ...bidOrder };
			newBidOrder.baseAssetAmountFilled = bidOrder.baseAssetAmount;
			this.getListForOrder(newBidOrder).update(
				newBidOrder,
				bidNode.userAccount
			);

			const newAskOrder = { ...askOrder };
			newAskOrder.baseAssetAmountFilled = askOrder.baseAssetAmount;
			this.getListForOrder(newAskOrder).update(
				newAskOrder,
				askNode.userAccount
			);
		}

		return {
			crossingNodes: [
				{
					node: takerNode,
					makerNode: makerNode,
				},
			],
			exhaustedSide,
		};
	}

	determineMakerAndTaker(
		askNode: DLOBNode,
		bidNode: DLOBNode
	): { takerNode: DLOBNode; makerNode: DLOBNode; makerSide: Side } {
		if (bidNode.order.postOnly) {
			return {
				takerNode: askNode,
				makerNode: bidNode,
				makerSide: 'bid',
			};
		} else if (askNode.order.postOnly) {
			return {
				takerNode: bidNode,
				makerNode: askNode,
				makerSide: 'ask',
			};
		} else if (askNode.order.slot.lt(bidNode.order.slot)) {
			return {
				takerNode: bidNode,
				makerNode: askNode,
				makerSide: 'ask',
			};
		} else {
			return {
				takerNode: askNode,
				makerNode: bidNode,
				makerSide: 'bid',
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
		marketType: MarketType
	): NodeToTrigger[] {
		if (exchangePaused(this.stateAccount)) {
			return [];
		}

		const nodesToTrigger = [];
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		for (const node of this.orderLists
			.get(marketTypeStr)
			.get(marketIndex)
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
			.get(marketTypeStr)
			.get(marketIndex)
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
}
