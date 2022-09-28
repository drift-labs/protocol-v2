import { getOrderSignature, getVammNodeGenerator, NodeList } from './NodeList';
import {
	MarketType,
	BN,
	calculateAskPrice,
	calculateBidPrice,
	ClearingHouse,
	convertToNumber,
	isAuctionComplete,
	isOrderExpired,
	isOneOfVariant,
	isVariant,
	getVariant,
	Order,
	ZERO,
	PRICE_PRECISION,
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

		if (!this.orderLists.has(marketType)) {
			return undefined;
		}

		return this.orderLists.get(marketType).get(order.marketIndex)[type][
			subType
		];
	}

	public findNodesToFill(
		marketIndex: number,
		vBid: BN | undefined,
		vAsk: BN | undefined,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): NodeToFill[] {
		// Find all the crossing nodes
		const crossingNodesToFill: Array<NodeToFill> = this.findCrossingNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			slot,
			marketType,
			oraclePriceData
		);

		// get expired market nodes
		const marketNodesToFill = this.findMarketNodesToFill(
			marketIndex,
			slot,
			marketType
		);
		return crossingNodesToFill.concat(marketNodesToFill);
	}

	public findCrossingNodesToFill(
		marketIndex: number,
		vBid: BN | undefined,
		vAsk: BN | undefined,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		const askGenerator = this.getAsks(
			marketIndex,
			undefined, // dont include vask
			slot,
			marketType,
			oraclePriceData
		);
		const bidGenerator = this.getBids(
			marketIndex,
			undefined, // dont include vbid
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
				vAsk,
				vBid,
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
			} else {
				console.error(`invalid exhaustedSide: ${exhaustedSide}`);
				break;
			}

			for (const crossingNode of crossingNodes) {
				nodesToFill.push(crossingNode);
			}
		}
		return nodesToFill;
	}

	public findMarketNodesToFill(
		marketIndex: number,
		slot: number,
		marketType: MarketType
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();
		// Then see if there are orders to fill against vamm
		for (const marketBid of this.getMarketBids(marketIndex, marketType)) {
			if (
				isAuctionComplete(marketBid.order, slot) ||
				isOrderExpired(marketBid.order, slot)
			) {
				nodesToFill.push({
					node: marketBid,
				});
			}
		}

		for (const marketAsk of this.getMarketAsks(marketIndex, marketType)) {
			if (
				isAuctionComplete(marketAsk.order, slot) ||
				isOrderExpired(marketAsk.order, slot)
			) {
				nodesToFill.push({
					node: marketAsk,
				});
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

	public getMarketBids(
		marketIndex: number,
		marketType: MarketType
	): Generator<DLOBNode> {
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		return this.orderLists
			.get(marketTypeStr)
			.get(marketIndex)
			.market.bid.getGenerator();
	}

	public getMarketAsks(
		marketIndex: number,
		marketType: MarketType
	): Generator<DLOBNode> {
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		return this.orderLists
			.get(marketTypeStr)
			.get(marketIndex)
			.market.ask.getGenerator();
	}

	*getAsks(
		marketIndex: number,
		vAsk: BN | undefined,
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
			nodeLists.market.ask.getGenerator(),
		];

		if (marketTypeStr === 'perp') {
			generatorList.push(getVammNodeGenerator(vAsk));
		}

		const askGenerators = generatorList.map((generator) => {
			return {
				next: generator.next(),
				generator,
			};
		});

		let asksExhausted = false;
		while (!asksExhausted) {
			const bestGenerator = askGenerators.reduce(
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
		marketIndex: number,
		vBid: BN | undefined,
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
			nodeLists.market.bid.getGenerator(),
		];
		if (marketTypeStr === 'perp') {
			generatorList.push(getVammNodeGenerator(vBid));
		}
		const bidGenerators = generatorList.map((generator) => {
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
		vAsk: BN | undefined,
		vBid: BN | undefined,
		oraclePriceData: OraclePriceData,
		slot: number
	): {
		crossingNodes: NodeToFill[];
		exhaustedSide: Side;
	} {
		const bidPrice = bidNode.getPrice(oraclePriceData, slot);
		const askPrice = askNode.getPrice(oraclePriceData, slot);

		const bidOrder = bidNode.order;
		const askOrder = askNode.order;

		// when bid and ask don't cross, check against vamm
		if (bidPrice.lt(askPrice)) {
			if (vBid && vAsk) {
				const crossingNodes: NodeToFill[] = [];
				if (bidPrice.gte(vAsk) && isAuctionComplete(bidOrder, slot)) {
					crossingNodes.push({
						node: bidNode,
					});
				}
				if (askPrice.lte(vBid) && isAuctionComplete(askOrder, slot)) {
					crossingNodes.push({
						node: askNode,
					});
				}

				return {
					crossingNodes,
					exhaustedSide: 'both',
				};
			} else {
				return {
					crossingNodes: [],
					exhaustedSide: 'both',
				};
			}
		}

		// Can't match two maker orders or if maker and taker are the same
		const makerIsTaker = bidNode.userAccount.equals(askNode.userAccount);
		if (makerIsTaker || (bidOrder.postOnly && askOrder.postOnly)) {
			// don't have a principle way to pick which one to exhaust,
			// exhaust each one 50% of the time so we can try each one against other orders
			const exhaustedSide = Math.random() < 0.5 ? 'bid' : 'ask';
			return {
				crossingNodes: [],
				exhaustedSide,
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

		// update the orders as if they fill - so we don't try to match them on the next iteration
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

		// Bid is maker
		if (bidOrder.postOnly) {
			return {
				crossingNodes: [
					{
						node: askNode,
						makerNode: bidNode,
					},
				],
				exhaustedSide,
			};
		}

		// Ask is maker
		if (askOrder.postOnly) {
			return {
				crossingNodes: [
					{
						node: bidNode,
						makerNode: askNode,
					},
				],
				exhaustedSide,
			};
		}

		// Both are takers
		// older order is maker
		const [olderNode, newerNode] = askOrder.ts.lt(bidOrder.ts)
			? [askNode, bidNode]
			: [bidNode, askNode];
		return {
			crossingNodes: [
				{
					node: newerNode,
					makerNode: olderNode,
				},
			],
			exhaustedSide,
		};
	}

	public getBestAsk(
		marketIndex: number,
		vAsk: BN | undefined,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): BN {
		return this.getAsks(marketIndex, vAsk, slot, marketType, oraclePriceData)
			.next()
			.value.getPrice(oraclePriceData, slot);
	}

	public getBestBid(
		marketIndex: number,
		vBid: BN | undefined,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): BN {
		return this.getBids(marketIndex, vBid, slot, marketType, oraclePriceData)
			.next()
			.value.getPrice(oraclePriceData, slot);
	}

	public findNodesToTrigger(
		marketIndex: number,
		slot: number,
		oraclePrice: BN,
		marketType: MarketType
	): NodeToTrigger[] {
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
		clearingHouse: ClearingHouse,
		slotSubscriber: SlotSubscriber,
		marketIndex: number,
		marketType: MarketType
	) {
		if (isVariant(marketType, 'perp')) {
			const market = clearingHouse.getPerpMarketAccount(marketIndex);

			const slot = slotSubscriber.getSlot();
			const oraclePriceData = clearingHouse.getOracleDataForMarket(marketIndex);
			const vAsk = calculateAskPrice(market, oraclePriceData);
			const vBid = calculateBidPrice(market, oraclePriceData);

			const bestAsk = this.getBestAsk(
				marketIndex,
				vAsk,
				slot,
				marketType,
				oraclePriceData
			);
			const bestBid = this.getBestBid(
				marketIndex,
				vBid,
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
			const oraclePriceData = clearingHouse.getOracleDataForMarket(marketIndex);

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
