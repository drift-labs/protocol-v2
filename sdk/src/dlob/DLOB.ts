import { getOrderSignature, getVammNodeGenerator, NodeList } from './NodeList';
import {
	MarketType,
	BN,
	calculateAskPrice,
	calculateBidPrice,
	ClearingHouse,
	convertToNumber,
	isAuctionComplete,
	isOneOfVariant,
	isVariant,
	getVariant,
	Order,
	ZERO,
	MARK_PRICE_PRECISION,
	SpotMarketAccount,
	PerpMarketAccount,
	OraclePriceData,
	SlotSubscriber,
	UserMap,
	MarketTypeStr,
} from '..';
import { PublicKey } from '@solana/web3.js';
import { DLOBNode, DLOBNodeType, TriggerOrderNode } from '..';

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

type Side = 'ask' | 'bid' | 'both';

export class DLOB {
	openOrders = new Map<MarketTypeStr, Set<string>>();
	orderLists = new Map<MarketTypeStr, Map<number, MarketNodeLists>>();
	marketIndexToAccount = new Map<
		MarketTypeStr,
		Map<number, PerpMarketAccount | SpotMarketAccount>
	>();

	silent = false;
	initialized = false;

	/**
	 *
	 * @param perpMarkets The perp markets to maintain a DLOB for
	 * @param spotMarkets The spot markets to maintain a DLOB for
	 * @param silent set to true to prevent logging on inserts and removals
	 */
	public constructor(
		perpMarkets: PerpMarketAccount[],
		spotMarkets: SpotMarketAccount[],
		silent?: boolean
	) {
		this.silent = silent;

		this.openOrders.set('perp', new Set<string>());
		this.openOrders.set('spot', new Set<string>());
		this.orderLists.set('perp', new Map<number, MarketNodeLists>());
		this.orderLists.set('spot', new Map<number, MarketNodeLists>());
		this.marketIndexToAccount.set('perp', new Map<number, PerpMarketAccount>());
		this.marketIndexToAccount.set('spot', new Map<number, SpotMarketAccount>());

		for (const market of perpMarkets) {
			const marketIndex = market.marketIndex;
			this.marketIndexToAccount.get('perp').set(marketIndex.toNumber(), market);

			this.orderLists.get('perp').set(marketIndex.toNumber(), {
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
			this.marketIndexToAccount.get('spot').set(marketIndex.toNumber(), market);

			this.orderLists.get('spot').set(marketIndex.toNumber(), {
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

	/**
	 * initializes a new DLOB instance
	 *
	 * @param clearingHouse The ClearingHouse instance to use for price data
	 * @returns a promise that resolves when the DLOB is initialized
	 */
	public async init(
		clearingHouse: ClearingHouse,
		userMap?: UserMap
	): Promise<boolean> {
		if (this.initialized) {
			return false;
		}
		if (userMap) {
			// initialize the dlob with the user map (prevents hitting getProgramAccounts)
			for (const user of userMap.values()) {
				const userAccount = user.getUserAccount();
				const userAccountPubkey = user.getUserAccountPublicKey();

				for (const order of userAccount.orders) {
					this.insertOrder(order, userAccountPubkey);
				}
			}
		} else {
			const programAccounts = await clearingHouse.program.account.user.all();
			for (const programAccount of programAccounts) {
				// @ts-ignore
				const userAccount: UserAccount = programAccount.account;
				const userAccountPublicKey = programAccount.publicKey;

				for (const order of userAccount.orders) {
					this.insertOrder(order, userAccountPublicKey);
				}
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
		this.getListForOrder(order).insert(
			order,
			marketType,
			this.marketIndexToAccount
				.get(marketType)
				.get(order.marketIndex.toNumber()),
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

		const triggerList = this.orderLists
			.get(marketType)
			.get(order.marketIndex.toNumber()).trigger[
			isVariant(order.triggerCondition, 'above') ? 'above' : 'below'
		];
		triggerList.remove(order, userAccount);

		this.getListForOrder(order).insert(
			order,
			marketType,
			this.marketIndexToAccount
				.get(marketType)
				.get(order.marketIndex.toNumber()),
			userAccount
		);
		if (onTrigger) {
			onTrigger();
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

		const marketType = getVariant(order.marketType) as MarketTypeStr;
		return this.orderLists.get(marketType).get(order.marketIndex.toNumber())[
			type
		][subType];
	}

	public findNodesToFill(
		marketIndex: BN,
		vBid: BN | undefined,
		vAsk: BN | undefined,
		slot: number,
		marketType: MarketType,
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

		// TODO: verify that crossing nodes indeed include all market nodes? ok it's not, orders will be in one but not thet other zzz
		// Find all market nodes to fill
		const marketNodesToFill = this.findMarketNodesToFill(
			marketIndex,
			slot,
			marketType
		);
		return crossingNodesToFill.concat(marketNodesToFill);
	}

	public findCrossingNodesToFill(
		marketIndex: BN,
		vBid: BN | undefined,
		vAsk: BN | undefined,
		slot: number,
		marketType: MarketType,
		oraclePriceData?: OraclePriceData
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		const askGenerator = this.getAsks(
			marketIndex,
			vAsk,
			slot,
			marketType,
			oraclePriceData
		);
		const bidGenerator = this.getBids(
			marketIndex,
			vBid,
			slot,
			marketType,
			oraclePriceData
		);

		let nextAsk = askGenerator.next();
		let nextBid = bidGenerator.next();

		// First try to find orders that cross
		while (!nextAsk.done && !nextBid.done) {
			const { crossingNodes, exhaustedSide } = this.findCrossingOrders(
				nextAsk.value,
				nextBid.value,
				oraclePriceData,
				slot
			);

			const takerIsMaker =
				crossingNodes?.makerNode !== undefined &&
				crossingNodes.node.userAccount.equals(
					crossingNodes.makerNode.userAccount
				);

			// Verify that each side is different user
			if (crossingNodes && !takerIsMaker) {
				nodesToFill.push(crossingNodes);
			}

			if (exhaustedSide === 'bid') {
				nextBid = bidGenerator.next();
			} else if (exhaustedSide === 'ask') {
				nextAsk = askGenerator.next();
			} else if (exhaustedSide === 'both') {
				nextBid = bidGenerator.next();
				nextAsk = askGenerator.next();
			} else {
				console.log('tfff exhaustedSide:', exhaustedSide);
				// nextBid = bidGenerator.next();
				// nextAsk = askGenerator.next();
				break;
			}
		}
		return nodesToFill;
	}

	public findMarketNodesToFill(
		marketIndex: BN,
		slot: number,
		marketType: MarketType
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();
		// Then see if there are orders to fill against vamm
		for (const marketBid of this.getMarketBids(marketIndex, marketType)) {
			if (isAuctionComplete(marketBid.order, slot)) {
				nodesToFill.push({
					node: marketBid,
				});
			}
		}

		for (const marketAsk of this.getMarketAsks(marketIndex, marketType)) {
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

	public getMarketBids(
		marketIndex: BN,
		marketType: MarketType
	): Generator<DLOBNode> {
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		return this.orderLists
			.get(marketTypeStr)
			.get(marketIndex.toNumber())
			.market.bid.getGenerator();
	}

	public getMarketAsks(
		marketIndex: BN,
		marketType: MarketType
	): Generator<DLOBNode> {
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		return this.orderLists
			.get(marketTypeStr)
			.get(marketIndex.toNumber())
			.market.ask.getGenerator();
	}

	*getAsks(
		marketIndex: BN,
		vAsk: BN | undefined,
		slot: number,
		marketType: MarketType,
		oraclePriceData?: OraclePriceData
	): Generator<DLOBNode> {
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const nodeLists = this.orderLists
			.get(marketTypeStr)
			.get(marketIndex.toNumber());

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
		vBid: BN | undefined,
		slot: number,
		marketType: MarketType,
		oraclePriceData?: OraclePriceData
	): Generator<DLOBNode> {
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const nodeLists = this.orderLists
			.get(marketTypeStr)
			.get(marketIndex.toNumber());

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
		bidNode: DLOBNode,
		oraclePriceData: OraclePriceData,
		slot: number
	): {
		crossingNodes?: NodeToFill;
		exhaustedSide?: Side;
	} {
		const bidPrice = bidNode.getPrice(oraclePriceData, slot);
		const askPrice = askNode.getPrice(oraclePriceData, slot);

		// contains market order
		const containsMarketOrder =
			(askNode.order && isOneOfVariant(askNode.order.orderType, ['market'])) ||
			(bidNode.order && isOneOfVariant(bidNode.order.orderType, ['market']));
		if (!containsMarketOrder && bidPrice.lt(askPrice)) {
			if (askNode.isVammNode() && !bidNode.isVammNode()) {
				return {
					exhaustedSide: 'bid',
				};
			} else if (!askNode.isVammNode() && bidNode.isVammNode()) {
				return {
					exhaustedSide: 'ask',
				};
			} else {
				return {
					exhaustedSide: 'both',
				};
			}
		}

		const bidOrder = bidNode.order;
		const askOrder = askNode.order;

		// User bid crosses the vamm ask
		// Cant match orders
		if (askNode.isVammNode()) {
			if (!isAuctionComplete(bidOrder, slot)) {
				return {
					exhaustedSide: 'bid',
				};
			}
			return {
				crossingNodes: {
					node: bidNode,
				},
				exhaustedSide: 'bid',
			};
		}

		// User ask crosses the vamm bid
		// Cant match orders
		if (bidNode.isVammNode()) {
			if (!isAuctionComplete(askOrder, slot)) {
				return {
					exhaustedSide: 'ask',
				};
			}
			return {
				crossingNodes: {
					node: askNode,
				},
				exhaustedSide: 'ask',
			};
		}

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

		// update the orders as if they fill
		if (exhaustedSide === 'ask') {
			bidNode.order.baseAssetAmountFilled =
				bidOrder.baseAssetAmountFilled.add(askBaseRemaining);
			askNode.order.baseAssetAmountFilled = askOrder.baseAssetAmount;
		} else if (exhaustedSide === 'bid') {
			askNode.order.baseAssetAmountFilled =
				askOrder.baseAssetAmountFilled.add(bidBaseRemaining);
			bidNode.order.baseAssetAmountFilled = bidOrder.baseAssetAmount;
		} else {
			askNode.order.baseAssetAmountFilled = askOrder.baseAssetAmount;
			bidNode.order.baseAssetAmountFilled = bidOrder.baseAssetAmount;
		}

		// Two maker orders cross
		if (bidOrder.postOnly && askOrder.postOnly) {
			return {
				exhaustedSide,
			};
		}

		// Bid is maker
		if (bidOrder.postOnly) {
			return {
				crossingNodes: {
					node: askNode,
					makerNode: bidNode,
				},
				exhaustedSide,
			};
		}

		// Ask is maker
		if (askOrder.postOnly) {
			return {
				crossingNodes: {
					node: bidNode,
					makerNode: askNode,
				},
				exhaustedSide,
			};
		}

		// Both are takers
		// older order is maker
		const [olderNode, newerNode] = askOrder.ts.lt(bidOrder.ts)
			? [askNode, bidNode]
			: [bidNode, askNode];
		return {
			crossingNodes: {
				node: newerNode,
				makerNode: olderNode,
			},
			exhaustedSide,
		};
	}

	public getBestAsk(
		marketIndex: BN,
		vAsk: BN | undefined,
		slot: number,
		oraclePriceData: OraclePriceData
	): BN {
		return this.getAsks(marketIndex, vAsk, slot, oraclePriceData)
			.next()
			.value.getPrice(oraclePriceData, slot);
	}

	public getBestBid(
		marketIndex: BN,
		vBid: BN | undefined,
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
		oraclePrice: BN,
		marketType: MarketType
	): NodeToTrigger[] {
		const nodesToTrigger = [];
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		for (const node of this.orderLists
			.get(marketTypeStr)
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
			.get(marketTypeStr)
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
		marketIndex: BN,
		marketType: MarketType
	) {
		if (isVariant(marketType, 'perp')) {
			const market = clearingHouse.getPerpMarketAccount(marketIndex);

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
			console.log(
				`  Mid`,
				convertToNumber(mid, MARK_PRICE_PRECISION).toFixed(3)
			);
			console.log(
				`  Bid`,
				convertToNumber(bestBid, MARK_PRICE_PRECISION).toFixed(3),
				`(${bidSpread.toFixed(4)}%)`
			);
		} else if (isVariant(marketType, 'spot')) {
			const slot = slotSubscriber.getSlot();
			const oraclePriceData = clearingHouse.getOracleDataForMarket(marketIndex);

			const bestAsk = this.getBestAsk(
				marketIndex,
				undefined,
				slot,
				oraclePriceData
			);
			const bestBid = this.getBestBid(
				marketIndex,
				undefined,
				slot,
				oraclePriceData
			);
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
			console.log(
				`  Mid`,
				convertToNumber(mid, MARK_PRICE_PRECISION).toFixed(3)
			);
			console.log(
				`  Bid`,
				convertToNumber(bestBid, MARK_PRICE_PRECISION).toFixed(3),
				`(${bidSpread.toFixed(4)}%)`
			);
		}
	}
}
