import {
	BN,
	DLOBSubscriber,
	DLOBSubscriptionConfig,
	DriftEnv,
	L2OrderBookGenerator,
	MarketType,
	ONE,
	Order,
	OrderStatus,
	OrderTriggerCondition,
	OrderType,
	PerpOperation,
	PositionDirection,
	ZERO,
	calculateBidAskPrice,
	getLimitPrice,
	isOperationPaused,
	isVariant,
} from '@velocity-exchange/sdk';
import { RedisClient } from '@velocity-exchange/common/clients';
import { logger } from '../utils/logger';
import {
	SubscriberLookup,
	addMarketSlotToResponse,
	addOracletoResponse,
	l2WithBNToStrings,
	parsePositiveIntArray,
	publishGroupings,
} from '../utils/utils';
import { OffloadQueue } from '../utils/offload';
import { setHealthStatus, HEALTH_STATUS } from '../core/healthCheck';
import { CounterValue } from '../core/metricsV2';
import { COMMON_MATH } from '@velocity-exchange/common';

export type wsMarketArgs = {
	marketIndex: number;
	marketType: MarketType;
	marketName: string;
	depth: number;
	includeVamm: boolean;
	numVammOrders?: number;
	fallbackL2Generators?: L2OrderBookGenerator[];
	updateOnChange?: boolean;
	tickSize: BN;
};

require('dotenv').config();

const STALE_ORACLE_REMOVE_VAMM_THRESHOLD = 160;

const INDICATIVE_QUOTES_PUBKEY = 'inDNdu3ML4vG5LNExqcwuCQtLcCU8KfK5YM2qYV3JJz';

const PERP_MARKETS_TO_SKIP_SLOT_CHECK =
	process.env.PERP_MARKETS_TO_SKIP_SLOT_CHECK !== undefined
		? parsePositiveIntArray(process.env.PERP_MARKETS_TO_SKIP_SLOT_CHECK)
		: [];
const SPOT_MARKETS_TO_SKIP_SLOT_CHECK =
	process.env.SPOT_MARKETS_TO_SKIP_SLOT_CHECK !== undefined
		? parsePositiveIntArray(process.env.SPOT_MARKETS_TO_SKIP_SLOT_CHECK)
		: [];

export type wsMarketInfo = {
	marketIndex: number;
	marketName: string;
};

export class DLOBSubscriberIO extends DLOBSubscriber {
	public marketArgs: wsMarketArgs[] = [];
	public lastSeenL2Formatted: Map<MarketType, Map<number, any>>;
	redisClient: RedisClient;
	indicativeQuotesRedisClient?: RedisClient;
	public killSwitchSlotDiffThreshold: number;
	public offloadQueue?: ReturnType<typeof OffloadQueue>;
	public enableOffload: boolean;

	constructor(
		config: DLOBSubscriptionConfig & {
			env: DriftEnv;
			redisClient: RedisClient;
			indicativeQuotesRedisClient?: RedisClient;
			enableOffloadQueue?: boolean;
			offloadQueueCounter?: CounterValue;
			perpMarketInfos: wsMarketInfo[];
			spotMarketInfos: wsMarketInfo[];
			spotMarketSubscribers: SubscriberLookup;
			killSwitchSlotDiffThreshold?: number;
		}
	) {
		super(config);
		this.redisClient = config.redisClient;
		this.indicativeQuotesRedisClient = config.indicativeQuotesRedisClient;

		this.killSwitchSlotDiffThreshold =
			config.killSwitchSlotDiffThreshold || 200;

		this.enableOffload = config.enableOffloadQueue || false;
		if (this.enableOffload) {
			this.offloadQueue = OffloadQueue(config.offloadQueueCounter);
		}

		// Set up appropriate maps
		this.lastSeenL2Formatted = new Map();
		this.lastSeenL2Formatted.set(MarketType.SPOT, new Map());
		this.lastSeenL2Formatted.set(MarketType.PERP, new Map());

		for (const market of config.perpMarketInfos) {
			const perpMarket = this.driftClient.getPerpMarketAccount(
				market.marketIndex
			);
			const includeVamm = !isOperationPaused(
				perpMarket.pausedOperations,
				PerpOperation.AMM_FILL
			);

			this.marketArgs.push({
				marketIndex: market.marketIndex,
				marketType: MarketType.PERP,
				marketName: market.marketName,
				depth: -1,
				numVammOrders: 100,
				includeVamm,
				updateOnChange: false,
				fallbackL2Generators: [],
				tickSize: perpMarket?.amm?.orderTickSize ?? ONE,
			});
		}
		for (const market of config.spotMarketInfos) {
			this.marketArgs.push({
				marketIndex: market.marketIndex,
				marketType: MarketType.SPOT,
				marketName: market.marketName,
				depth: -1,
				includeVamm: false,
				updateOnChange: false,
				fallbackL2Generators: [],
				tickSize:
					config.spotMarketSubscribers[market.marketIndex].tickSize ?? ONE,
			});
		}
	}

	override async updateDLOB(): Promise<void> {
		await super.updateDLOB();
		const dlob = this.getDLOB();
		let indicativeOrderId = 0;
		for (const marketArgs of this.marketArgs) {
			try {
				if (this.indicativeQuotesRedisClient) {
					const oraclePriceData = isVariant(marketArgs.marketType, 'perp')
						? this.driftClient.getMMOracleDataForPerpMarket(
								marketArgs.marketIndex
						  )
						: this.driftClient.getOracleDataForSpotMarket(
								marketArgs.marketIndex
						  );
					const bestDlobBid = dlob.getBestBid(
						marketArgs.marketIndex,
						this.slotSource.getSlot(),
						isVariant(marketArgs.marketType, 'perp')
							? MarketType.PERP
							: MarketType.SPOT,
						oraclePriceData
					);
					const bestDlobAsk = dlob.getBestAsk(
						marketArgs.marketIndex,
						this.slotSource.getSlot(),
						isVariant(marketArgs.marketType, 'perp')
							? MarketType.PERP
							: MarketType.SPOT,
						oraclePriceData
					);

					const marketType = isVariant(marketArgs.marketType, 'perp')
						? 'perp'
						: 'spot';

					let bestBid = bestDlobBid;
					let bestAsk = bestDlobAsk;
					if (marketType === 'perp') {
						const [bestVammBid, bestVammAsk] = calculateBidAskPrice(
							this.driftClient.getPerpMarketAccount(marketArgs.marketIndex).amm,
							this.driftClient.getMMOracleDataForPerpMarket(
								marketArgs.marketIndex
							),
							true,
							new BN(this.slotSource.getSlot())
						);

						bestBid =
							bestBid && bestBid.gt(bestVammBid) ? bestBid : bestVammBid;
						bestAsk =
							bestAsk && bestAsk.lt(bestVammAsk) ? bestAsk : bestVammAsk;
					}

					const mms = await this.indicativeQuotesRedisClient.smembers(
						`market_mms_${marketType}_${marketArgs.marketIndex}`
					);
					let mmQuotes: any = await Promise.all(
						mms.map((mm) => {
							return this.indicativeQuotesRedisClient.get(
								`mm_quotes_v2_${marketType}_${marketArgs.marketIndex}_${mm}`
							);
						})
					);
					mmQuotes = mmQuotes.filter((x) => !!x);

					const nowMinus1000Ms = Date.now() - 1000;
					for (const quotes of mmQuotes) {
						try {
							if (Number(quotes['ts']) > nowMinus1000Ms) {
								for (const quote of quotes['quotes']) {
									const indicativeBaseOrder: Order = {
										status: OrderStatus.OPEN,
										orderType: OrderType.LIMIT,
										orderId: 0,
										slot: new BN(this.slotSource.getSlot()),
										marketIndex: marketArgs.marketIndex,
										marketType: marketArgs.marketType,
										baseAssetAmount: ZERO,
										immediateOrCancel: false,
										direction: PositionDirection.LONG,
										oraclePriceOffset: 0,
										maxTs: new BN(quote['ts'] + 1000),
										reduceOnly: false,
										triggerCondition: OrderTriggerCondition.ABOVE,
										price: ZERO,
										userOrderId: 0,
										postOnly: true,
										auctionDuration: 0,
										auctionStartPrice: ZERO,
										auctionEndPrice: ZERO,
										// Rest are not necessary and set for type conforming
										existingPositionDirection: PositionDirection.LONG,
										triggerPrice: ZERO,
										baseAssetAmountFilled: ZERO,
										quoteAssetAmountFilled: ZERO,
										quoteAssetAmount: ZERO,
										bitFlags: 0,
										postedSlotTail: 0,
									};

									if (quote['bid_size'] && quote['bid_price'] != null) {
										// Sanity check bid price and size
										let indicativeBid: Order = Object.assign(
											{},
											indicativeBaseOrder,
											{
												orderId: indicativeOrderId,
												baseAssetAmount: new BN(quote['bid_size']),
												oraclePriceOffset: quote['is_oracle_offset']
													? quote['bid_price']
													: 0,
												price: quote['is_oracle_offset']
													? ZERO
													: new BN(quote['bid_price']),
											}
										);
										const limitPrice = getLimitPrice(
											indicativeBid,
											oraclePriceData,
											this.slotSource.getSlot()
										);
										if (bestBid && limitPrice.gt(bestBid)) {
											indicativeBid = Object.assign({}, indicativeBid, {
												price: bestBid,
												oraclePriceOffset: 0,
											});
										}
										this.dlob.insertOrder(
											indicativeBid,
											INDICATIVE_QUOTES_PUBKEY,
											this.slotSource.getSlot(),
											false,
											indicativeBid.baseAssetAmount
										);
										indicativeOrderId += 1;
									}
									if (quote['ask_size'] && quote['ask_price'] != null) {
										let indicativeAsk: Order = Object.assign(
											{},
											indicativeBaseOrder,
											{
												orderId: indicativeOrderId,
												oraclePriceOffset: quote['is_oracle_offset']
													? quote['ask_price']
													: 0,
												price: quote['is_oracle_offset']
													? ZERO
													: new BN(quote['ask_price']),
												baseAssetAmount: new BN(quote['ask_size']),
												direction: PositionDirection.SHORT,
											}
										);
										const limitPrice = getLimitPrice(
											indicativeAsk,
											oraclePriceData,
											this.slotSource.getSlot()
										);
										if (bestAsk && limitPrice.lt(bestAsk)) {
											indicativeAsk = Object.assign({}, indicativeAsk, {
												price: bestAsk,
												oraclePriceOffset: 0,
											});
										}
										this.dlob.insertOrder(
											indicativeAsk,
											INDICATIVE_QUOTES_PUBKEY,
											this.slotSource.getSlot(),
											false,
											indicativeAsk.baseAssetAmount
										);
										indicativeOrderId += 1;
									}
								}
							}
						} catch (error) {
							console.log('skipping mmQuote: ', error);
						}
					}
				}
				this.getL2AndSendMsg(marketArgs);
				this.getL3AndSendMsg(marketArgs);
			} catch (error) {
				console.error(error);
				console.log(`Error getting L2 ${marketArgs.marketName}`);
			}
		}
	}

	getL2AndSendMsg(marketArgs: wsMarketArgs): void {
		const clientPrefix = this.redisClient.forceGetClient().options.keyPrefix;
		const { marketName, ...l2FuncArgs } = marketArgs;
		const marketType = isVariant(marketArgs.marketType, 'perp')
			? 'perp'
			: 'spot';

		// Test for oracle staleness to know whether to include vamm
		const dlobSlot = this.slotSource.getSlot();
		const oracleData =
			marketType === 'perp'
				? this.driftClient.getMMOracleDataForPerpMarket(marketArgs.marketIndex)
				: this.driftClient.getOracleDataForSpotMarket(marketArgs.marketIndex);
		const oracleSlot = oracleData.slot;
		const isPerpMarketAndPrelaunchMarket =
			marketType === 'perp' &&
			isVariant(
				this.driftClient.getPerpMarketAccount(marketArgs.marketIndex).amm
					.oracleSource,
				'prelaunch'
			);
		let includeVamm = marketArgs.includeVamm;
		if (
			dlobSlot - oracleSlot.toNumber() > STALE_ORACLE_REMOVE_VAMM_THRESHOLD &&
			!isPerpMarketAndPrelaunchMarket
		) {
			logger.info(
				`Oracle is stale, removing vamm orders ${marketArgs.marketName}`
			);
			includeVamm = false;
		}

		const l2 = this.getL2({
			...l2FuncArgs,
			includeVamm,
			latestSlot: new BN(this.slotSource.getSlot()),
		});
		const { markPrice, bestBidPrice, bestAskPrice, spreadPct, spreadQuote } =
			COMMON_MATH.calculateSpreadBidAskMark(l2, oracleData?.price);
		const slot = l2.slot;

		if (slot) {
			delete l2.slot;
		}

		const l2Formatted = l2WithBNToStrings(l2);

		if (marketArgs.updateOnChange) {
			if (
				this.lastSeenL2Formatted
					.get(marketArgs.marketType)
					?.get(marketArgs.marketIndex) === JSON.stringify(l2Formatted)
			)
				return;
		}

		this.lastSeenL2Formatted
			.get(marketArgs.marketType)
			?.set(marketArgs.marketIndex, JSON.stringify(l2Formatted));
		l2Formatted['marketName'] = marketName?.toUpperCase();
		l2Formatted['marketType'] = marketType?.toLowerCase();
		l2Formatted['marketIndex'] = marketArgs.marketIndex;
		l2Formatted['ts'] = Date.now();
		l2Formatted['slot'] = slot;
		l2Formatted['markPrice'] = markPrice?.toString();
		l2Formatted['bestBidPrice'] = bestBidPrice?.toString();
		l2Formatted['bestAskPrice'] = bestAskPrice?.toString();
		l2Formatted['spreadPct'] = spreadPct?.toString();
		l2Formatted['spreadQuote'] = spreadQuote?.toString();

		addOracletoResponse(
			l2Formatted,
			this.driftClient,
			marketArgs.marketType,
			marketArgs.marketIndex
		);
		addMarketSlotToResponse(
			l2Formatted,
			this.driftClient,
			marketArgs.marketType,
			marketArgs.marketIndex
		);

		if (!markPrice) {
			l2Formatted['markPrice'] = l2Formatted['oracle'];
		}

		// Check if slot diffs are too large for oracle
		const skipSlotCheck =
			(marketType === 'perp' &&
				PERP_MARKETS_TO_SKIP_SLOT_CHECK.includes(marketArgs.marketIndex)) ||
			(marketType === 'spot' &&
				SPOT_MARKETS_TO_SKIP_SLOT_CHECK.includes(marketArgs.marketIndex));
		if (
			Math.abs(slot - parseInt(l2Formatted['oracleData']['slot'])) >
				this.killSwitchSlotDiffThreshold &&
			!skipSlotCheck &&
			!isPerpMarketAndPrelaunchMarket
		) {
			console.log(
				`Unhealthy process due to slot diffs for market ${marketName}. dlobProviderSlot: ${slot}, oracleSlot: ${l2Formatted['oracleData']['slot']}`
			);
			setHealthStatus(HEALTH_STATUS.Restart);
		}

		const l2Formatted_depth100 = Object.assign({}, l2Formatted, {
			bids: l2Formatted.bids.slice(0, 100),
			asks: l2Formatted.asks.slice(0, 100),
		});

		this.redisClient.publish(
			`${clientPrefix}orderbook_${marketType}_${marketArgs.marketIndex}${
				this.indicativeQuotesRedisClient ? '_indicative' : ''
			}`,
			l2Formatted
		);

		if (this.offloadQueue) {
			try {
				this.offloadQueue.addMessage(
					Object.assign({}, l2Formatted, {
						bids: l2Formatted.bids.slice(0, 20),
						asks: l2Formatted.asks.slice(0, 20),
						ts: Math.floor(new Date().getTime() / 1000),
					})
				);
			} catch (error) {
				logger.error('Error adding message to offload queue:', error);
			}
		}

		this.redisClient.set(
			`last_update_orderbook_${marketType}_${marketArgs.marketIndex}${
				this.indicativeQuotesRedisClient ? '_indicative' : ''
			}`,
			l2Formatted_depth100
		);

		publishGroupings(
			l2Formatted,
			marketArgs,
			this.redisClient,
			clientPrefix,
			marketType,
			this.indicativeQuotesRedisClient
		);

		if (!this.indicativeQuotesRedisClient) {
			const bids = this.dlob
				.getBestMakers({
					marketIndex: marketArgs.marketIndex,
					marketType: isVariant(marketArgs.marketType, 'perp')
						? MarketType.PERP
						: MarketType.SPOT,
					direction: PositionDirection.LONG,
					slot: slot,
					oraclePriceData: oracleData,
					numMakers: 4,
				})
				.map((x) => x.toString());
			const asks = this.dlob
				.getBestMakers({
					marketIndex: marketArgs.marketIndex,
					marketType: isVariant(marketArgs.marketType, 'perp')
						? MarketType.PERP
						: MarketType.SPOT,
					direction: PositionDirection.SHORT,
					slot,
					oraclePriceData: oracleData,
					numMakers: 4,
				})
				.map((x) => x.toString());
			this.redisClient.set(
				`last_update_orderbook_best_makers_${marketType}_${marketArgs.marketIndex}`,
				{ bids, asks, slot }
			);
		}
	}

	getL3AndSendMsg(marketArgs: wsMarketArgs): void {
		const { marketName, ...l2FuncArgs } = marketArgs;
		const l3 = this.getL3(l2FuncArgs);
		const slot = l3.slot;

		if (slot) {
			delete l3.slot;
		}
		const marketType = isVariant(marketArgs.marketType, 'perp')
			? 'perp'
			: 'spot';

		for (const key of Object.keys(l3)) {
			for (const idx in l3[key]) {
				const level = l3[key][idx];
				l3[key][idx] = {
					...level,
					price: level.price.toString(),
					size: level.size.toString(),
				};
			}
		}

		l3['marketName'] = marketName?.toUpperCase();
		l3['marketType'] = marketType?.toLowerCase();
		l3['marketIndex'] = marketArgs.marketIndex;
		l3['ts'] = Date.now();
		l3['slot'] = slot;
		addOracletoResponse(
			l3,
			this.driftClient,
			marketArgs.marketType,
			marketArgs.marketIndex
		);
		addMarketSlotToResponse(
			l3,
			this.driftClient,
			marketArgs.marketType,
			marketArgs.marketIndex
		);

		if (this.offloadQueue) {
			try {
				this.offloadQueue.addMessage(
					Object.assign({}, l3, {
						ts: Math.floor(new Date().getTime() / 1000),
					}),
					{ eventType: 'DLOBL3Snapshot', throttle: true }
				);
			} catch (error) {
				logger.error('Error adding message to offload queue:', error);
			}
		}

		this.redisClient.set(
			`last_update_orderbook_l3_${marketType}_${marketArgs.marketIndex}${
				this.indicativeQuotesRedisClient ? '_indicative' : ''
			}`,
			l3
		);
	}
}
