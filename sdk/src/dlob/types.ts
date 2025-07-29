import {
	MarketType,
	Order,
	PerpMarketAccount,
	PositionDirection,
	ProtectedMakerParams,
	SpotMarketAccount,
	StateAccount,
} from '../types';
import { MarketTypeStr } from '../types';
import { PublicKey } from '@solana/web3.js';
import { DLOBNode, DLOBNodeType, TriggerOrderNode } from './DLOBNode';
import { BN } from '@coral-xyz/anchor';
import { OraclePriceData } from '../oracles/types';
import { NodeList } from './NodeList';
import { SlotSubscriber } from '../slot/SlotSubscriber';
import {
	L2OrderBook,
	L2OrderBookGenerator,
	L3OrderBook,
} from './orderBookLevels';
import { IDriftClient } from '../driftClient/types';
import { IUserMap } from '../userMap/types';

export type DLOBSubscriptionConfig = {
	driftClient: IDriftClient;
	dlobSource: DLOBSource;
	slotSource: SlotSource;
	updateFrequency: number;
	protectedMakerView?: boolean;
};

export interface DLOBSubscriberEvents {
	update: (dlob: IDLOB) => void;
	error: (e: Error) => void;
}

export interface DLOBSource {
	getDLOB(
		slot: number,
		protectedMakerParamsMap?: ProtectMakerParamsMap
	): Promise<IDLOB>;
}

export interface SlotSource {
	getSlot(): number;
}

export type ProtectMakerParamsMap = {
	[marketType in MarketTypeStr]: Map<number, ProtectedMakerParams>;
};

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
	signedMsg: {
		ask: NodeList<'signedMsg'>;
		bid: NodeList<'signedMsg'>;
	};
};

export type OrderBookCallback = () => void;

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

export interface IDLOB {
	// Properties
	openOrders: Map<MarketTypeStr, Set<string>>;
	orderLists: Map<MarketTypeStr, Map<number, MarketNodeLists>>;
	maxSlotForRestingLimitOrders: number;
	initialized: boolean;
	protectedMakerParamsMap: ProtectMakerParamsMap;

	// Methods
	clear(): void;

	/**
	 * initializes a new DLOB instance
	 *
	 * @returns a promise that resolves when the DLOB is initialized
	 */
	initFromUserMap(userMap: IUserMap, slot: number): Promise<boolean>;

	insertOrder(
		order: Order,
		userAccount: string,
		slot: number,
		isUserProtectedMaker: boolean,
		onInsert?: OrderBookCallback
	): void;

	insertSignedMsgOrder(
		order: Order,
		userAccount: string,
		isUserProtectedMaker: boolean,
		onInsert?: OrderBookCallback
	): void;

	addOrderList(marketType: MarketTypeStr, marketIndex: number): void;

	delete(
		order: Order,
		userAccount: PublicKey,
		slot: number,
		isUserProtectedMaker: boolean,
		onDelete?: OrderBookCallback
	): void;

	getListForOnChainOrder(
		order: Order,
		slot: number,
		isProtectedMaker: boolean
	): NodeList<any> | undefined;

	updateRestingLimitOrders(slot: number): void;

	updateRestingLimitOrdersForMarketType(
		slot: number,
		marketTypeStr: MarketTypeStr
	): void;

	getOrder(orderId: number, userAccount: PublicKey): Order | undefined;

	findNodesToFill(
		marketIndex: number,
		fallbackBid: BN | undefined,
		fallbackAsk: BN | undefined,
		slot: number,
		ts: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		stateAccount: StateAccount,
		marketAccount: PerpMarketAccount | SpotMarketAccount
	): NodeToFill[];

	getMakerRebate(
		marketType: MarketType,
		stateAccount: StateAccount,
		marketAccount: PerpMarketAccount | SpotMarketAccount
	): { makerRebateNumerator: number; makerRebateDenominator: number };

	mergeNodesToFill(
		restingLimitOrderNodesToFill: NodeToFill[],
		takingOrderNodesToFill: NodeToFill[]
	): NodeToFill[];

	findRestingLimitOrderNodesToFill(
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
	): NodeToFill[];

	findTakingNodesToFill(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		isAmmPaused: boolean,
		minAuctionDuration: number,
		fallbackAsk: BN | undefined,
		fallbackBid?: BN | undefined
	): NodeToFill[];

	findTakingNodesCrossingMakerNodes(
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
	): NodeToFill[];

	findNodesCrossingFallbackLiquidity(
		marketType: MarketType,
		slot: number,
		oraclePriceData: OraclePriceData,
		nodeGenerator: Generator<DLOBNode>,
		doesCross: (nodePrice: BN | undefined) => boolean,
		minAuctionDuration: number
	): NodeToFill[];

	findExpiredNodesToFill(
		marketIndex: number,
		ts: number,
		marketType: MarketType,
		slot?: BN
	): NodeToFill[];

	getTakingBids(
		marketIndex: number,
		marketType: MarketType,
		slot: number,
		oraclePriceData: OraclePriceData,
		filterFcn?: DLOBFilterFcn
	): Generator<DLOBNode>;

	getTakingAsks(
		marketIndex: number,
		marketType: MarketType,
		slot: number,
		oraclePriceData: OraclePriceData,
		filterFcn?: DLOBFilterFcn
	): Generator<DLOBNode>;

	getRestingLimitAsks(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		filterFcn?: DLOBFilterFcn
	): Generator<DLOBNode>;

	getRestingLimitBids(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		filterFcn?: DLOBFilterFcn
	): Generator<DLOBNode>;

	/**
	 * This will look at both the taking and resting limit asks
	 * @param marketIndex
	 * @param fallbackAsk
	 * @param slot
	 * @param marketType
	 * @param oraclePriceData
	 * @param filterFcn
	 */
	getAsks(
		marketIndex: number,
		fallbackAsk: BN | undefined,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		filterFcn?: DLOBFilterFcn
	): Generator<DLOBNode>;

	/**
	 * This will look at both the taking and resting limit bids
	 * @param marketIndex
	 * @param fallbackBid
	 * @param slot
	 * @param marketType
	 * @param oraclePriceData
	 * @param filterFcn
	 */
	getBids(
		marketIndex: number,
		fallbackBid: BN | undefined,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		filterFcn?: DLOBFilterFcn
	): Generator<DLOBNode>;

	findCrossingRestingLimitOrders(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): NodeToFill[];

	determineMakerAndTaker(
		askNode: DLOBNode,
		bidNode: DLOBNode
	): { takerNode: DLOBNode; makerNode: DLOBNode } | undefined;

	getBestAsk(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): BN | undefined;

	getBestBid(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): BN | undefined;

	getStopLosses(
		marketIndex: number,
		marketType: MarketType,
		direction: PositionDirection
	): Generator<DLOBNode>;

	getStopLossMarkets(
		marketIndex: number,
		marketType: MarketType,
		direction: PositionDirection
	): Generator<DLOBNode>;

	getStopLossLimits(
		marketIndex: number,
		marketType: MarketType,
		direction: PositionDirection
	): Generator<DLOBNode>;

	getTakeProfits(
		marketIndex: number,
		marketType: MarketType,
		direction: PositionDirection
	): Generator<DLOBNode>;

	getTakeProfitMarkets(
		marketIndex: number,
		marketType: MarketType,
		direction: PositionDirection
	): Generator<DLOBNode>;

	getTakeProfitLimits(
		marketIndex: number,
		marketType: MarketType,
		direction: PositionDirection
	): Generator<DLOBNode>;

	findNodesToTrigger(
		marketIndex: number,
		slot: number,
		oraclePrice: BN,
		marketType: MarketType,
		stateAccount: StateAccount
	): NodeToTrigger[];

	printTop(
		driftClient: IDriftClient,
		slotSubscriber: SlotSubscriber,
		marketIndex: number,
		marketType: MarketType
	): void;

	getDLOBOrders(): DLOBOrders;

	getNodeLists(): Generator<NodeList<DLOBNodeType>>;

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
	getL2(params: {
		marketIndex: number;
		marketType: MarketType;
		slot: number;
		oraclePriceData: OraclePriceData;
		depth: number;
		fallbackL2Generators?: L2OrderBookGenerator[];
	}): L2OrderBook;

	/**
	 * Get an L3 view of the order book for a given market. Does not include fallback liquidity sources
	 *
	 * @param marketIndex
	 * @param marketType
	 * @param slot
	 * @param oraclePriceData
	 */
	getL3(params: {
		marketIndex: number;
		marketType: MarketType;
		slot: number;
		oraclePriceData: OraclePriceData;
	}): L3OrderBook;

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
	estimateFillWithExactBaseAmount(params: {
		marketIndex: number;
		marketType: MarketType;
		baseAmount: BN;
		orderDirection: PositionDirection;
		slot: number;
		oraclePriceData: OraclePriceData;
	}): BN;

	getBestMakers(params: {
		marketIndex: number;
		marketType: MarketType;
		direction: PositionDirection;
		slot: number;
		oraclePriceData: OraclePriceData;
		numMakers: number;
	}): PublicKey[];
}
