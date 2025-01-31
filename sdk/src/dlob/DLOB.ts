import { getOrderSignature, NodeList } from './NodeList';
import {
	BASE_PRECISION,
	BN,
	BN_MAX,
	convertToNumber,
	decodeName,
	DLOBNode,
	DLOBNodeType,
	DriftClient,
	getLimitPrice,
	getVariant,
	isFallbackAvailableLiquiditySource,
	isOneOfVariant,
	isOrderExpired,
	isRestingLimitOrder,
	isTriggered,
	isUserProtectedMaker,
	isVariant,
	MarketType,
	MarketTypeStr,
	mustBeTriggered,
	OraclePriceData,
	Order,
	PerpMarketAccount,
	PositionDirection,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	SlotSubscriber,
	SpotMarketAccount,
	StateAccount,
	TriggerOrderNode,
	UserMap,
	ZERO,
} from '..';
import { PublicKey } from '@solana/web3.js';
import { ammPaused, exchangePaused, fillPaused } from '../math/exchangeStatus';
import {
	createL2Levels,
	getL2GeneratorFromDLOBNodes,
	L2OrderBook,
	L2OrderBookGenerator,
	L3Level,
	L3OrderBook,
	mergeL2LevelGenerators,
} from './orderBookLevels';

export type DLOBOrder = { user: PublicKey; order: Order };
export type DLOBOrders = DLOBOrder[];

export type MarketNodeLists = {
	restingLimit: {
		ask: NodeList<'restingLimit'>;
		bid: NodeList<'restingLimit'>;
	};
	floatingLimit: {
		ask: NodeList<'floatingLimit'>;
		bid: NodeList<'floatingLimit'>;
	};
	protectedFloatingLimit: {
		ask: NodeList<'protectedFloatingLimit'>;
		bid: NodeList<'protectedFloatingLimit'>;
	};
	takingLimit: {
		ask: NodeList<'takingLimit'>;
		bid: NodeList<'takingLimit'>;
	};
	market: {
		ask: NodeList<'market'>;
		bid: NodeList<'market'>;
	};
	trigger: {
		above: NodeList<'trigger'>;
		below: NodeList<'trigger'>;
	};
	swift: {
		ask: NodeList<'swift'>;
		bid: NodeList<'swift'>;
	};
};

type OrderBookCallback = () => void;

/**
 *  Receives a DLOBNode and is expected to return true if the node should
 *  be taken into account when generating, or false otherwise.
 *
 * Currently used in functions that rely on getBestNode
 */
export type DLOBFilterFcn = (node: DLOBNode) => boolean;

export type NodeToFill = {
	node: DLOBNode;
	makerNodes: DLOBNode[];
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
	maxSlotForRestingLimitOrders = 0;

	initialized = false;

	protectedMakerView: boolean;

	public constructor(protectedMakerView?: boolean) {
		this.protectedMakerView = protectedMakerView || false;
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

		this.maxSlotForRestingLimitOrders = 0;

		this.init();
	}

	/**
	 * initializes a new DLOB instance
	 *
	 * @returns a promise that resolves when the DLOB is initialized
	 */
	public async initFromUserMap(
		userMap: UserMap,
		slot: number
	): Promise<boolean> {
		if (this.initialized) {
			return false;
		}

		// initialize the dlob with the user map
		for (const user of userMap.values()) {
			const userAccount = user.getUserAccount();
			const userAccountPubkey = user.getUserAccountPublicKey();
			const userAccountPubkeyString = userAccountPubkey.toString();
			const protectedMaker = isUserProtectedMaker(userAccount);

			for (const order of userAccount.orders) {
				this.insertOrder(order, userAccountPubkeyString, slot, protectedMaker);
			}
		}

		this.initialized = true;
		return true;
	}

	public insertOrder(
		order: Order,
		userAccount: string,
		slot: number,
		isUserProtectedMaker: boolean,
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
		this.getListForOnChainOrder(order, slot, isUserProtectedMaker)?.insert(
			order,
			marketType,
			userAccount,
			isUserProtectedMaker,
			this.protectedMakerView
		);

		if (onInsert) {
			onInsert();
		}
	}

	public insertSwiftOrder(
		order: Order,
		userAccount: string,
		isUserProtectedMaker: boolean,
		onInsert?: OrderBookCallback
	): void {
		const marketType = getVariant(order.marketType) as MarketTypeStr;
		const marketIndex = order.marketIndex;
		const bidOrAsk = isVariant(order.direction, 'long') ? 'bid' : 'ask';
		if (!this.orderLists.get(marketType).has(order.marketIndex)) {
			this.addOrderList(marketType, order.marketIndex);
		}
		this.openOrders
			.get(marketType)
			.add(getOrderSignature(order.orderId, userAccount));
		this.orderLists
			.get(marketType)
			.get(marketIndex)
			.swift[bidOrAsk].insert(
				order,
				marketType,
				userAccount,
				isUserProtectedMaker,
				this.protectedMakerView
			);
		if (onInsert) {
			onInsert();
		}
	}

	addOrderList(marketType: MarketTypeStr, marketIndex: number): void {
		this.orderLists.get(marketType).set(marketIndex, {
			restingLimit: {
				ask: new NodeList('restingLimit', 'asc'),
				bid: new NodeList('restingLimit', 'desc'),
			},
			floatingLimit: {
				ask: new NodeList('floatingLimit', 'asc'),
				bid: new NodeList('floatingLimit', 'desc'),
			},
			protectedFloatingLimit: {
				ask: new NodeList('protectedFloatingLimit', 'asc'),
				bid: new NodeList('protectedFloatingLimit', 'desc'),
			},
			takingLimit: {
				ask: new NodeList('takingLimit', 'asc'),
				bid: new NodeList('takingLimit', 'asc'), // always sort ascending for market orders
			},
			market: {
				ask: new NodeList('market', 'asc'),
				bid: new NodeList('market', 'asc'), // always sort ascending for market orders
			},
			trigger: {
				above: new NodeList('trigger', 'asc'),
				below: new NodeList('trigger', 'desc'),
			},
			swift: {
				ask: new NodeList('swift', 'asc'),
				bid: new NodeList('swift', 'asc'),
			},
		});
	}

	public delete(
		order: Order,
		userAccount: PublicKey,
		slot: number,
		isUserProtectedMaker: boolean,
		onDelete?: OrderBookCallback
	): void {
		if (isVariant(order.status, 'init')) {
			return;
		}

		this.updateRestingLimitOrders(slot);

		this.getListForOnChainOrder(order, slot, isUserProtectedMaker)?.remove(
			order,
			userAccount.toString()
		);

		if (onDelete) {
			onDelete();
		}
	}

	public getListForOnChainOrder(
		order: Order,
		slot: number,
		isProtectedMaker: boolean
	): NodeList<any> | undefined {
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
			type = isProtectedMaker ? 'protectedFloatingLimit' : 'floatingLimit';
		} else {
			const isResting = isRestingLimitOrder(order, slot);
			type = isResting ? 'restingLimit' : 'takingLimit';
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

	public updateRestingLimitOrders(slot: number): void {
		if (slot <= this.maxSlotForRestingLimitOrders) {
			return;
		}

		this.maxSlotForRestingLimitOrders = slot;

		this.updateRestingLimitOrdersForMarketType(slot, 'perp');

		this.updateRestingLimitOrdersForMarketType(slot, 'spot');
	}

	updateRestingLimitOrdersForMarketType(
		slot: number,
		marketTypeStr: MarketTypeStr
	): void {
		for (const [_, nodeLists] of this.orderLists.get(marketTypeStr)) {
			const nodesToUpdate = [];
			for (const node of nodeLists.takingLimit.ask.getGenerator()) {
				if (!isRestingLimitOrder(node.order, slot)) {
					continue;
				}

				nodesToUpdate.push({
					side: 'ask',
					node,
				});
			}

			for (const node of nodeLists.takingLimit.bid.getGenerator()) {
				if (!isRestingLimitOrder(node.order, slot)) {
					continue;
				}

				nodesToUpdate.push({
					side: 'bid',
					node,
				});
			}

			for (const nodeToUpdate of nodesToUpdate) {
				const { side, node } = nodeToUpdate;
				nodeLists.takingLimit[side].remove(node.order, node.userAccount);
				nodeLists.restingLimit[side].insert(
					node.order,
					marketTypeStr,
					node.userAccount,
					node.isProtectedMaker,
					this.protectedMakerView
				);
			}
		}
	}

	public getOrder(orderId: number, userAccount: PublicKey): Order | undefined {
		const orderSignature = getOrderSignature(orderId, userAccount.toString());
		for (const nodeList of this.getNodeLists()) {
			const node = nodeList.get(orderSignature);
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

		const minAuctionDuration = isVariant(marketType, 'perp')
			? stateAccount.minPerpAuctionDuration
			: 0;

		const { makerRebateNumerator, makerRebateDenominator } =
			this.getMakerRebate(marketType, stateAccount, marketAccount);

		const takingOrderNodesToFill: Array<NodeToFill> =
			this.findTakingNodesToFill(
				marketIndex,
				slot,
				marketType,
				oraclePriceData,
				isAmmPaused,
				minAuctionDuration,
				fallbackAsk,
				fallbackBid
			);

		const restingLimitOrderNodesToFill: Array<NodeToFill> =
			this.findRestingLimitOrderNodesToFill(
				marketIndex,
				slot,
				marketType,
				oraclePriceData,
				isAmmPaused,
				minAuctionDuration,
				makerRebateNumerator,
				makerRebateDenominator,
				fallbackAsk,
				fallbackBid
			);

		// get expired market nodes
		const expiredNodesToFill = this.findExpiredNodesToFill(
			marketIndex,
			ts,
			marketType,
			new BN(slot)
		);

		return this.mergeNodesToFill(
			restingLimitOrderNodesToFill,
			takingOrderNodesToFill
		).concat(expiredNodesToFill);
	}

	getMakerRebate(
		marketType: MarketType,
		stateAccount: StateAccount,
		marketAccount: PerpMarketAccount | SpotMarketAccount
	): { makerRebateNumerator: number; makerRebateDenominator: number } {
		let makerRebateNumerator: number;
		let makerRebateDenominator: number;
		if (isVariant(marketType, 'perp')) {
			makerRebateNumerator =
				stateAccount.perpFeeStructure.feeTiers[0].makerRebateNumerator;
			makerRebateDenominator =
				stateAccount.perpFeeStructure.feeTiers[0].makerRebateDenominator;
		} else {
			makerRebateNumerator =
				stateAccount.spotFeeStructure.feeTiers[0].makerRebateNumerator;
			makerRebateDenominator =
				stateAccount.spotFeeStructure.feeTiers[0].makerRebateDenominator;
		}

		// @ts-ignore
		const feeAdjustment = marketAccount.feeAdjustment || 0;
		if (feeAdjustment !== 0) {
			makerRebateNumerator += (makerRebateNumerator * feeAdjustment) / 100;
		}

		return { makerRebateNumerator, makerRebateDenominator };
	}

	mergeNodesToFill(
		restingLimitOrderNodesToFill: NodeToFill[],
		takingOrderNodesToFill: NodeToFill[]
	): NodeToFill[] {
		const mergedNodesToFill = new Map<string, NodeToFill>();

		const mergeNodesToFillHelper = (nodesToFillArray: NodeToFill[]) => {
			nodesToFillArray.forEach((nodeToFill) => {
				const nodeSignature = getOrderSignature(
					nodeToFill.node.order.orderId,
					nodeToFill.node.userAccount
				);

				if (!mergedNodesToFill.has(nodeSignature)) {
					mergedNodesToFill.set(nodeSignature, {
						node: nodeToFill.node,
						makerNodes: [],
					});
				}

				if (nodeToFill.makerNodes) {
					mergedNodesToFill
						.get(nodeSignature)
						.makerNodes.push(...nodeToFill.makerNodes);
				}
			});
		};

		mergeNodesToFillHelper(restingLimitOrderNodesToFill);
		mergeNodesToFillHelper(takingOrderNodesToFill);

		return Array.from(mergedNodesToFill.values());
	}

	public findRestingLimitOrderNodesToFill(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		isAmmPaused: boolean,
		minAuctionDuration: number,
		makerRebateNumerator: number,
		makerRebateDenominator: number,
		fallbackAsk: BN | undefined,
		fallbackBid: BN | undefined
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		const crossingNodes = this.findCrossingRestingLimitOrders(
			marketIndex,
			slot,
			marketType,
			oraclePriceData
		);

		for (const crossingNode of crossingNodes) {
			nodesToFill.push(crossingNode);
		}

		if (fallbackBid && !isAmmPaused) {
			const askGenerator = this.getRestingLimitAsks(
				marketIndex,
				slot,
				marketType,
				oraclePriceData
			);

			const fallbackBidWithBuffer = fallbackBid.sub(
				fallbackBid.muln(makerRebateNumerator).divn(makerRebateDenominator)
			);

			const asksCrossingFallback = this.findNodesCrossingFallbackLiquidity(
				marketType,
				slot,
				oraclePriceData,
				askGenerator,
				(askPrice) => {
					return askPrice.lte(fallbackBidWithBuffer);
				},
				minAuctionDuration
			);

			for (const askCrossingFallback of asksCrossingFallback) {
				nodesToFill.push(askCrossingFallback);
			}
		}

		if (fallbackAsk && !isAmmPaused) {
			const bidGenerator = this.getRestingLimitBids(
				marketIndex,
				slot,
				marketType,
				oraclePriceData
			);

			const fallbackAskWithBuffer = fallbackAsk.add(
				fallbackAsk.muln(makerRebateNumerator).divn(makerRebateDenominator)
			);

			const bidsCrossingFallback = this.findNodesCrossingFallbackLiquidity(
				marketType,
				slot,
				oraclePriceData,
				bidGenerator,
				(bidPrice) => {
					return bidPrice.gte(fallbackAskWithBuffer);
				},
				minAuctionDuration
			);

			for (const bidCrossingFallback of bidsCrossingFallback) {
				nodesToFill.push(bidCrossingFallback);
			}
		}

		return nodesToFill;
	}

	public findTakingNodesToFill(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		isAmmPaused: boolean,
		minAuctionDuration: number,
		fallbackAsk: BN | undefined,
		fallbackBid?: BN | undefined
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		let takingOrderGenerator = this.getTakingAsks(
			marketIndex,
			marketType,
			slot,
			oraclePriceData
		);

		const takingAsksCrossingBids = this.findTakingNodesCrossingMakerNodes(
			marketIndex,
			slot,
			marketType,
			oraclePriceData,
			takingOrderGenerator,
			this.getRestingLimitBids.bind(this),
			(takerPrice, makerPrice) => {
				if (isVariant(marketType, 'spot')) {
					if (takerPrice === undefined) {
						return false;
					}

					if (fallbackBid && makerPrice.lt(fallbackBid)) {
						return false;
					}
				}
				return takerPrice === undefined || takerPrice.lte(makerPrice);
			}
		);
		for (const takingAskCrossingBid of takingAsksCrossingBids) {
			nodesToFill.push(takingAskCrossingBid);
		}

		if (fallbackBid && !isAmmPaused) {
			takingOrderGenerator = this.getTakingAsks(
				marketIndex,
				marketType,
				slot,
				oraclePriceData
			);
			const takingAsksCrossingFallback =
				this.findNodesCrossingFallbackLiquidity(
					marketType,
					slot,
					oraclePriceData,
					takingOrderGenerator,
					(takerPrice) => {
						return takerPrice === undefined || takerPrice.lte(fallbackBid);
					},
					minAuctionDuration
				);

			for (const takingAskCrossingFallback of takingAsksCrossingFallback) {
				nodesToFill.push(takingAskCrossingFallback);
			}
		}

		takingOrderGenerator = this.getTakingBids(
			marketIndex,
			marketType,
			slot,
			oraclePriceData
		);

		const takingBidsToFill = this.findTakingNodesCrossingMakerNodes(
			marketIndex,
			slot,
			marketType,
			oraclePriceData,
			takingOrderGenerator,
			this.getRestingLimitAsks.bind(this),
			(takerPrice, makerPrice) => {
				if (isVariant(marketType, 'spot')) {
					if (takerPrice === undefined) {
						return false;
					}

					if (fallbackAsk && makerPrice.gt(fallbackAsk)) {
						return false;
					}
				}

				return takerPrice === undefined || takerPrice.gte(makerPrice);
			}
		);

		for (const takingBidToFill of takingBidsToFill) {
			nodesToFill.push(takingBidToFill);
		}

		if (fallbackAsk && !isAmmPaused) {
			takingOrderGenerator = this.getTakingBids(
				marketIndex,
				marketType,
				slot,
				oraclePriceData
			);
			const takingBidsCrossingFallback =
				this.findNodesCrossingFallbackLiquidity(
					marketType,
					slot,
					oraclePriceData,
					takingOrderGenerator,
					(takerPrice) => {
						return takerPrice === undefined || takerPrice.gte(fallbackAsk);
					},
					minAuctionDuration
				);
			for (const marketBidCrossingFallback of takingBidsCrossingFallback) {
				nodesToFill.push(marketBidCrossingFallback);
			}
		}

		return nodesToFill;
	}

	public findTakingNodesCrossingMakerNodes(
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
				const sameUser = takerNode.userAccount === makerNode.userAccount;
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
					makerNodes: [makerNode],
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
				this.getListForOnChainOrder(
					newMakerOrder,
					slot,
					makerNode.isProtectedMaker
				).update(newMakerOrder, makerNode.userAccount);

				const newTakerOrder = { ...takerOrder };
				newTakerOrder.baseAssetAmountFilled =
					takerOrder.baseAssetAmountFilled.add(baseFilled);
				this.getListForOnChainOrder(
					newTakerOrder,
					slot,
					takerNode.isProtectedMaker
				).update(newTakerOrder, takerNode.userAccount);

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
		doesCross: (nodePrice: BN | undefined) => boolean,
		minAuctionDuration: number
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
			const crosses = doesCross(nodePrice);

			// fallback is available if auction is complete or it's a spot order
			const fallbackAvailable =
				isVariant(marketType, 'spot') ||
				isFallbackAvailableLiquiditySource(
					node.order,
					minAuctionDuration,
					slot
				);

			if (crosses && fallbackAvailable) {
				nodesToFill.push({
					node: node,
					makerNodes: [], // filled by fallback
				});
			}

			nextNode = nodeGenerator.next();
		}

		return nodesToFill;
	}

	public findExpiredNodesToFill(
		marketIndex: number,
		ts: number,
		marketType: MarketType,
		slot?: BN
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const nodeLists = this.orderLists.get(marketTypeStr).get(marketIndex);

		if (!nodeLists) {
			return nodesToFill;
		}

		// All bids/asks that can expire
		// dont try to expire limit orders with tif as its inefficient use of blockspace
		const bidGenerators = [
			nodeLists.takingLimit.bid.getGenerator(),
			nodeLists.restingLimit.bid.getGenerator(),
			nodeLists.floatingLimit.bid.getGenerator(),
			nodeLists.market.bid.getGenerator(),
			nodeLists.swift.bid.getGenerator(),
		];
		const askGenerators = [
			nodeLists.takingLimit.ask.getGenerator(),
			nodeLists.restingLimit.ask.getGenerator(),
			nodeLists.floatingLimit.ask.getGenerator(),
			nodeLists.market.ask.getGenerator(),
			nodeLists.swift.ask.getGenerator(),
		];

		for (const bidGenerator of bidGenerators) {
			for (const bid of bidGenerator) {
				if (
					bid.isSwift &&
					slot.gt(bid.order.slot.addn(bid.order.auctionDuration))
				) {
					this.orderLists
						.get(marketTypeStr)
						.get(marketIndex)
						.swift.bid.remove(bid.order, bid.userAccount);
				} else if (isOrderExpired(bid.order, ts, true, 25)) {
					nodesToFill.push({
						node: bid,
						makerNodes: [],
					});
				}
			}
		}

		for (const askGenerator of askGenerators) {
			for (const ask of askGenerator) {
				if (isOrderExpired(ask.order, ts, true, 25)) {
					nodesToFill.push({
						node: ask,
						makerNodes: [],
					});
				}
			}
		}

		return nodesToFill;
	}

	*getTakingBids(
		marketIndex: number,
		marketType: MarketType,
		slot: number,
		oraclePriceData: OraclePriceData,
		filterFcn?: DLOBFilterFcn
	): Generator<DLOBNode> {
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const orderLists = this.orderLists.get(marketTypeStr).get(marketIndex);
		if (!orderLists) {
			return;
		}

		this.updateRestingLimitOrders(slot);

		const generatorList = [
			orderLists.market.bid.getGenerator(),
			orderLists.takingLimit.bid.getGenerator(),
			orderLists.swift.bid.getGenerator(),
		];

		yield* this.getBestNode(
			generatorList,
			oraclePriceData,
			slot,
			(bestNode, currentNode) => {
				return bestNode.order.slot.lt(currentNode.order.slot);
			},
			filterFcn
		);
	}

	*getTakingAsks(
		marketIndex: number,
		marketType: MarketType,
		slot: number,
		oraclePriceData: OraclePriceData,
		filterFcn?: DLOBFilterFcn
	): Generator<DLOBNode> {
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const orderLists = this.orderLists.get(marketTypeStr).get(marketIndex);
		if (!orderLists) {
			return;
		}

		this.updateRestingLimitOrders(slot);

		const generatorList = [
			orderLists.market.ask.getGenerator(),
			orderLists.takingLimit.ask.getGenerator(),
			orderLists.swift.ask.getGenerator(),
		];

		yield* this.getBestNode(
			generatorList,
			oraclePriceData,
			slot,
			(bestNode, currentNode) => {
				return bestNode.order.slot.lt(currentNode.order.slot);
			},
			filterFcn
		);
	}

	protected *getBestNode(
		generatorList: Array<Generator<DLOBNode>>,
		oraclePriceData: OraclePriceData,
		slot: number,
		compareFcn: (
			bestDLOBNode: DLOBNode,
			currentDLOBNode: DLOBNode,
			slot: number,
			oraclePriceData: OraclePriceData
		) => boolean,
		filterFcn?: DLOBFilterFcn
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

					return compareFcn(bestValue, currentValue, slot, oraclePriceData)
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

				if (filterFcn && !filterFcn(bestGenerator.next.value)) {
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

	*getRestingLimitAsks(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		filterFcn?: DLOBFilterFcn
	): Generator<DLOBNode> {
		if (isVariant(marketType, 'spot') && !oraclePriceData) {
			throw new Error('Must provide OraclePriceData to get spot asks');
		}

		this.updateRestingLimitOrders(slot);

		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const nodeLists = this.orderLists.get(marketTypeStr).get(marketIndex);

		if (!nodeLists) {
			return;
		}

		const generatorList = [
			nodeLists.restingLimit.ask.getGenerator(),
			nodeLists.floatingLimit.ask.getGenerator(),
			nodeLists.protectedFloatingLimit.ask.getGenerator(),
		];

		yield* this.getBestNode(
			generatorList,
			oraclePriceData,
			slot,
			(bestNode, currentNode, slot, oraclePriceData) => {
				return bestNode
					.getPrice(oraclePriceData, slot)
					.lt(currentNode.getPrice(oraclePriceData, slot));
			},
			filterFcn
		);
	}

	*getRestingLimitBids(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		filterFcn?: DLOBFilterFcn
	): Generator<DLOBNode> {
		if (isVariant(marketType, 'spot') && !oraclePriceData) {
			throw new Error('Must provide OraclePriceData to get spot bids');
		}

		this.updateRestingLimitOrders(slot);

		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const nodeLists = this.orderLists.get(marketTypeStr).get(marketIndex);

		if (!nodeLists) {
			return;
		}

		const generatorList = [
			nodeLists.restingLimit.bid.getGenerator(),
			nodeLists.floatingLimit.bid.getGenerator(),
			nodeLists.protectedFloatingLimit.bid.getGenerator(),
		];

		yield* this.getBestNode(
			generatorList,
			oraclePriceData,
			slot,
			(bestNode, currentNode, slot, oraclePriceData) => {
				return bestNode
					.getPrice(oraclePriceData, slot)
					.gt(currentNode.getPrice(oraclePriceData, slot));
			},
			filterFcn
		);
	}

	/**
	 * This will look at both the taking and resting limit asks
	 * @param marketIndex
	 * @param fallbackAsk
	 * @param slot
	 * @param marketType
	 * @param oraclePriceData
	 * @param filterFcn
	 */
	*getAsks(
		marketIndex: number,
		_fallbackAsk: BN | undefined,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		filterFcn?: DLOBFilterFcn
	): Generator<DLOBNode> {
		if (isVariant(marketType, 'spot') && !oraclePriceData) {
			throw new Error('Must provide OraclePriceData to get spot asks');
		}

		const generatorList = [
			this.getTakingAsks(marketIndex, marketType, slot, oraclePriceData),
			this.getRestingLimitAsks(marketIndex, slot, marketType, oraclePriceData),
		];

		yield* this.getBestNode(
			generatorList,
			oraclePriceData,
			slot,
			(bestNode, currentNode, slot, oraclePriceData) => {
				const bestNodePrice = bestNode.getPrice(oraclePriceData, slot) ?? ZERO;
				const currentNodePrice =
					currentNode.getPrice(oraclePriceData, slot) ?? ZERO;

				if (bestNodePrice.eq(currentNodePrice)) {
					return bestNode.order.slot.lt(currentNode.order.slot);
				}

				return bestNodePrice.lt(currentNodePrice);
			},
			filterFcn
		);
	}

	/**
	 * This will look at both the taking and resting limit bids
	 * @param marketIndex
	 * @param fallbackBid
	 * @param slot
	 * @param marketType
	 * @param oraclePriceData
	 * @param filterFcn
	 */
	*getBids(
		marketIndex: number,
		_fallbackBid: BN | undefined,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		filterFcn?: DLOBFilterFcn
	): Generator<DLOBNode> {
		if (isVariant(marketType, 'spot') && !oraclePriceData) {
			throw new Error('Must provide OraclePriceData to get spot bids');
		}

		const generatorList = [
			this.getTakingBids(marketIndex, marketType, slot, oraclePriceData),
			this.getRestingLimitBids(marketIndex, slot, marketType, oraclePriceData),
		];

		yield* this.getBestNode(
			generatorList,
			oraclePriceData,
			slot,
			(bestNode, currentNode, slot, oraclePriceData) => {
				const bestNodePrice =
					bestNode.getPrice(oraclePriceData, slot) ?? BN_MAX;
				const currentNodePrice =
					currentNode.getPrice(oraclePriceData, slot) ?? BN_MAX;

				if (bestNodePrice.eq(currentNodePrice)) {
					return bestNode.order.slot.lt(currentNode.order.slot);
				}

				return bestNodePrice.gt(currentNodePrice);
			},
			filterFcn
		);
	}

	findCrossingRestingLimitOrders(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		for (const askNode of this.getRestingLimitAsks(
			marketIndex,
			slot,
			marketType,
			oraclePriceData
		)) {
			const bidGenerator = this.getRestingLimitBids(
				marketIndex,
				slot,
				marketType,
				oraclePriceData
			);

			for (const bidNode of bidGenerator) {
				const bidPrice = bidNode.getPrice(oraclePriceData, slot);
				const askPrice = askNode.getPrice(oraclePriceData, slot);

				// orders don't cross
				if (bidPrice.lt(askPrice)) {
					break;
				}

				const bidOrder = bidNode.order;
				const askOrder = askNode.order;

				// Can't match orders from the same user
				const sameUser = bidNode.userAccount === askNode.userAccount;
				if (sameUser) {
					continue;
				}

				const makerAndTaker = this.determineMakerAndTaker(askNode, bidNode);

				// unable to match maker and taker due to post only or slot
				if (!makerAndTaker) {
					continue;
				}

				const { takerNode, makerNode } = makerAndTaker;

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
				this.getListForOnChainOrder(
					newBidOrder,
					slot,
					bidNode.isProtectedMaker
				).update(newBidOrder, bidNode.userAccount);

				// ask completely filled
				const newAskOrder = { ...askOrder };
				newAskOrder.baseAssetAmountFilled =
					askOrder.baseAssetAmountFilled.add(baseFilled);
				this.getListForOnChainOrder(
					newAskOrder,
					slot,
					askNode.isProtectedMaker
				).update(newAskOrder, askNode.userAccount);

				nodesToFill.push({
					node: takerNode,
					makerNodes: [makerNode],
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
	): { takerNode: DLOBNode; makerNode: DLOBNode } | undefined {
		const askSlot = askNode.order.slot.add(
			new BN(askNode.order.auctionDuration)
		);
		const bidSlot = bidNode.order.slot.add(
			new BN(bidNode.order.auctionDuration)
		);

		if (bidNode.order.postOnly && askNode.order.postOnly) {
			return undefined;
		} else if (bidNode.order.postOnly) {
			return {
				takerNode: askNode,
				makerNode: bidNode,
			};
		} else if (askNode.order.postOnly) {
			return {
				takerNode: bidNode,
				makerNode: askNode,
			};
		} else if (askSlot.lte(bidSlot)) {
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
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): BN | undefined {
		const bestAsk = this.getRestingLimitAsks(
			marketIndex,
			slot,
			marketType,
			oraclePriceData
		).next().value;

		if (bestAsk) {
			return bestAsk.getPrice(oraclePriceData, slot);
		}
		return undefined;
	}

	public getBestBid(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): BN | undefined {
		const bestBid = this.getRestingLimitBids(
			marketIndex,
			slot,
			marketType,
			oraclePriceData
		).next().value;

		if (bestBid) {
			return bestBid.getPrice(oraclePriceData, slot);
		}
		return undefined;
	}

	public *getStopLosses(
		marketIndex: number,
		marketType: MarketType,
		direction: PositionDirection
	): Generator<DLOBNode> {
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const marketNodeLists = this.orderLists.get(marketTypeStr).get(marketIndex);

		if (isVariant(direction, 'long') && marketNodeLists.trigger.below) {
			for (const node of marketNodeLists.trigger.below.getGenerator()) {
				if (isVariant(node.order.direction, 'short')) {
					yield node;
				}
			}
		} else if (isVariant(direction, 'short') && marketNodeLists.trigger.above) {
			for (const node of marketNodeLists.trigger.above.getGenerator()) {
				if (isVariant(node.order.direction, 'long')) {
					yield node;
				}
			}
		}
	}

	public *getStopLossMarkets(
		marketIndex: number,
		marketType: MarketType,
		direction: PositionDirection
	): Generator<DLOBNode> {
		for (const node of this.getStopLosses(marketIndex, marketType, direction)) {
			if (isVariant(node.order.orderType, 'triggerMarket')) {
				yield node;
			}
		}
	}

	public *getStopLossLimits(
		marketIndex: number,
		marketType: MarketType,
		direction: PositionDirection
	): Generator<DLOBNode> {
		for (const node of this.getStopLosses(marketIndex, marketType, direction)) {
			if (isVariant(node.order.orderType, 'triggerLimit')) {
				yield node;
			}
		}
	}

	public *getTakeProfits(
		marketIndex: number,
		marketType: MarketType,
		direction: PositionDirection
	): Generator<DLOBNode> {
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const marketNodeLists = this.orderLists.get(marketTypeStr).get(marketIndex);

		if (isVariant(direction, 'long') && marketNodeLists.trigger.above) {
			for (const node of marketNodeLists.trigger.above.getGenerator()) {
				if (isVariant(node.order.direction, 'short')) {
					yield node;
				}
			}
		} else if (isVariant(direction, 'short') && marketNodeLists.trigger.below) {
			for (const node of marketNodeLists.trigger.below.getGenerator()) {
				if (isVariant(node.order.direction, 'long')) {
					yield node;
				}
			}
		}
	}

	public *getTakeProfitMarkets(
		marketIndex: number,
		marketType: MarketType,
		direction: PositionDirection
	): Generator<DLOBNode> {
		for (const node of this.getTakeProfits(
			marketIndex,
			marketType,
			direction
		)) {
			if (isVariant(node.order.orderType, 'triggerMarket')) {
				yield node;
			}
		}
	}

	public *getTakeProfitLimits(
		marketIndex: number,
		marketType: MarketType,
		direction: PositionDirection
	): Generator<DLOBNode> {
		for (const node of this.getTakeProfits(
			marketIndex,
			marketType,
			direction
		)) {
			if (isVariant(node.order.orderType, 'triggerLimit')) {
				yield node;
			}
		}
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
					nodesToTrigger.push({
						node: node,
					});
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
					nodesToTrigger.push({
						node: node,
					});
				} else {
					break;
				}
			}
		}

		return nodesToTrigger;
	}

	public printTop(
		driftClient: DriftClient,
		slotSubscriber: SlotSubscriber,
		marketIndex: number,
		marketType: MarketType
	) {
		if (isVariant(marketType, 'perp')) {
			const slot = slotSubscriber.getSlot();
			const oraclePriceData =
				driftClient.getOracleDataForPerpMarket(marketIndex);

			const bestAsk = this.getBestAsk(
				marketIndex,
				slot,
				marketType,
				oraclePriceData
			);
			const bestBid = this.getBestBid(
				marketIndex,
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

			const name = decodeName(
				driftClient.getPerpMarketAccount(marketIndex).name
			);
			console.log(`Market ${name} Orders`);
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
				slot,
				marketType,
				oraclePriceData
			);
			const bestBid = this.getBestBid(
				marketIndex,
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

			const name = decodeName(
				driftClient.getSpotMarketAccount(marketIndex).name
			);
			console.log(`Market ${name} Orders`);
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
					user: new PublicKey(node.userAccount),
					order: node.order,
				});
			}
		}

		return dlobOrders;
	}

	*getNodeLists(): Generator<NodeList<DLOBNodeType>> {
		for (const [_, nodeLists] of this.orderLists.get('perp')) {
			yield nodeLists.restingLimit.bid;
			yield nodeLists.restingLimit.ask;
			yield nodeLists.takingLimit.bid;
			yield nodeLists.takingLimit.ask;
			yield nodeLists.market.bid;
			yield nodeLists.market.ask;
			yield nodeLists.floatingLimit.bid;
			yield nodeLists.floatingLimit.ask;
			yield nodeLists.protectedFloatingLimit.bid;
			yield nodeLists.protectedFloatingLimit.ask;
			yield nodeLists.trigger.above;
			yield nodeLists.trigger.below;
		}

		for (const [_, nodeLists] of this.orderLists.get('spot')) {
			yield nodeLists.restingLimit.bid;
			yield nodeLists.restingLimit.ask;
			yield nodeLists.takingLimit.bid;
			yield nodeLists.takingLimit.ask;
			yield nodeLists.market.bid;
			yield nodeLists.market.ask;
			yield nodeLists.floatingLimit.bid;
			yield nodeLists.floatingLimit.ask;
			yield nodeLists.protectedFloatingLimit.bid;
			yield nodeLists.protectedFloatingLimit.ask;
			yield nodeLists.trigger.above;
			yield nodeLists.trigger.below;
		}
	}

	/**
	 * Get an L2 view of the order book for a given market.
	 *
	 * @param marketIndex
	 * @param marketType
	 * @param slot
	 * @param oraclePriceData
	 * @param depth how many levels of the order book to return
	 * @param fallbackL2Generators L2 generators for fallback liquidity e.g. vAMM {@link getVammL2Generator}, openbook {@link SerumSubscriber}
	 */
	public getL2({
		marketIndex,
		marketType,
		slot,
		oraclePriceData,
		depth,
		fallbackL2Generators = [],
	}: {
		marketIndex: number;
		marketType: MarketType;
		slot: number;
		oraclePriceData: OraclePriceData;
		depth: number;
		fallbackL2Generators?: L2OrderBookGenerator[];
	}): L2OrderBook {
		const makerAskL2LevelGenerator = getL2GeneratorFromDLOBNodes(
			this.getRestingLimitAsks(marketIndex, slot, marketType, oraclePriceData),
			oraclePriceData,
			slot
		);

		const fallbackAskGenerators = fallbackL2Generators.map(
			(fallbackL2Generator) => {
				return fallbackL2Generator.getL2Asks();
			}
		);

		const askL2LevelGenerator = mergeL2LevelGenerators(
			[makerAskL2LevelGenerator, ...fallbackAskGenerators],
			(a, b) => {
				return a.price.lt(b.price);
			}
		);

		const asks = createL2Levels(askL2LevelGenerator, depth);

		const makerBidGenerator = getL2GeneratorFromDLOBNodes(
			this.getRestingLimitBids(marketIndex, slot, marketType, oraclePriceData),
			oraclePriceData,
			slot
		);

		const fallbackBidGenerators = fallbackL2Generators.map((fallbackOrders) => {
			return fallbackOrders.getL2Bids();
		});

		const bidL2LevelGenerator = mergeL2LevelGenerators(
			[makerBidGenerator, ...fallbackBidGenerators],
			(a, b) => {
				return a.price.gt(b.price);
			}
		);

		const bids = createL2Levels(bidL2LevelGenerator, depth);

		return {
			bids,
			asks,
			slot,
		};
	}

	/**
	 * Get an L3 view of the order book for a given market. Does not include fallback liquidity sources
	 *
	 * @param marketIndex
	 * @param marketType
	 * @param slot
	 * @param oraclePriceData
	 */
	public getL3({
		marketIndex,
		marketType,
		slot,
		oraclePriceData,
	}: {
		marketIndex: number;
		marketType: MarketType;
		slot: number;
		oraclePriceData: OraclePriceData;
	}): L3OrderBook {
		const bids: L3Level[] = [];
		const asks: L3Level[] = [];

		const restingAsks = this.getRestingLimitAsks(
			marketIndex,
			slot,
			marketType,
			oraclePriceData
		);

		for (const ask of restingAsks) {
			asks.push({
				price: ask.getPrice(oraclePriceData, slot),
				size: ask.order.baseAssetAmount.sub(ask.order.baseAssetAmountFilled),
				maker: new PublicKey(ask.userAccount),
				orderId: ask.order.orderId,
			});
		}

		const restingBids = this.getRestingLimitBids(
			marketIndex,
			slot,
			marketType,
			oraclePriceData
		);

		for (const bid of restingBids) {
			bids.push({
				price: bid.getPrice(oraclePriceData, slot),
				size: bid.order.baseAssetAmount.sub(bid.order.baseAssetAmountFilled),
				maker: new PublicKey(bid.userAccount),
				orderId: bid.order.orderId,
			});
		}

		return {
			bids,
			asks,
			slot,
		};
	}

	private estimateFillExactBaseAmountInForSide(
		baseAmountIn: BN,
		oraclePriceData: OraclePriceData,
		slot: number,
		dlobSide: Generator<DLOBNode>
	): BN {
		let runningSumQuote = ZERO;
		let runningSumBase = ZERO;
		for (const side of dlobSide) {
			const price = side.getPrice(oraclePriceData, slot); //side.order.quoteAssetAmount.div(side.order.baseAssetAmount);
			const baseAmountRemaining = side.order.baseAssetAmount.sub(
				side.order.baseAssetAmountFilled
			);
			if (runningSumBase.add(baseAmountRemaining).gt(baseAmountIn)) {
				const remainingBase = baseAmountIn.sub(runningSumBase);
				runningSumBase = runningSumBase.add(remainingBase);
				runningSumQuote = runningSumQuote.add(remainingBase.mul(price));
				break;
			} else {
				runningSumBase = runningSumBase.add(baseAmountRemaining);
				runningSumQuote = runningSumQuote.add(baseAmountRemaining.mul(price));
			}
		}

		return runningSumQuote
			.mul(QUOTE_PRECISION)
			.div(BASE_PRECISION.mul(PRICE_PRECISION));
	}

	/**
	 *
	 * @param param.marketIndex the index of the market
	 * @param param.marketType the type of the market
	 * @param param.baseAmount the base amount in to estimate
	 * @param param.orderDirection the direction of the trade
	 * @param param.slot current slot for estimating dlob node price
	 * @param param.oraclePriceData the oracle price data
	 * @returns the estimated quote amount filled: QUOTE_PRECISION
	 */
	public estimateFillWithExactBaseAmount({
		marketIndex,
		marketType,
		baseAmount,
		orderDirection,
		slot,
		oraclePriceData,
	}: {
		marketIndex: number;
		marketType: MarketType;
		baseAmount: BN;
		orderDirection: PositionDirection;
		slot: number;
		oraclePriceData: OraclePriceData;
	}): BN {
		if (isVariant(orderDirection, 'long')) {
			return this.estimateFillExactBaseAmountInForSide(
				baseAmount,
				oraclePriceData,
				slot,
				this.getRestingLimitAsks(marketIndex, slot, marketType, oraclePriceData)
			);
		} else if (isVariant(orderDirection, 'short')) {
			return this.estimateFillExactBaseAmountInForSide(
				baseAmount,
				oraclePriceData,
				slot,
				this.getRestingLimitBids(marketIndex, slot, marketType, oraclePriceData)
			);
		}
	}

	public getBestMakers({
		marketIndex,
		marketType,
		direction,
		slot,
		oraclePriceData,
		numMakers,
	}: {
		marketIndex: number;
		marketType: MarketType;
		direction: PositionDirection;
		slot: number;
		oraclePriceData: OraclePriceData;
		numMakers: number;
	}): PublicKey[] {
		const makers = new Map<string, PublicKey>();
		const generator = isVariant(direction, 'long')
			? this.getRestingLimitBids(marketIndex, slot, marketType, oraclePriceData)
			: this.getRestingLimitAsks(
					marketIndex,
					slot,
					marketType,
					oraclePriceData
			  );

		for (const node of generator) {
			if (!makers.has(node.userAccount.toString())) {
				makers.set(
					node.userAccount.toString(),
					new PublicKey(node.userAccount)
				);
			}

			if (makers.size === numMakers) {
				break;
			}
		}

		return Array.from(makers.values());
	}
}
