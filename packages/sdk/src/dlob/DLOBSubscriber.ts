import { DLOB } from './DLOB';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import {
	DLOBSource,
	DLOBSubscriberEvents,
	DLOBSubscriptionConfig,
	SlotSource,
} from './types';
import { VelocityClient } from '../velocityClient';
import { isVariant, MarketType } from '../types';
import {
	DEFAULT_TOP_OF_BOOK_QUOTE_AMOUNTS,
	MAJORS_TOP_OF_BOOK_QUOTE_AMOUNTS,
	getVammL2Generator,
	L2OrderBook,
	L2OrderBookGenerator,
	L3OrderBook,
} from './orderBookLevels';
import { BN } from '../isomorphic/anchor';

/**
 * Keeps a `DLOB` snapshot fresh on a timer and exposes convenience `getL2`/`getL3` accessors that
 * resolve market name/index/type and oracle price data via `velocityClient` so callers don't have
 * to. Until `subscribe()` resolves at least once, `getDLOB()`/`getL2`/`getL3` operate on an empty
 * `DLOB`.
 */
export class DLOBSubscriber {
	velocityClient: VelocityClient;
	dlobSource: DLOBSource;
	slotSource: SlotSource;
	/** Polling interval in milliseconds between `DLOB` refreshes. */
	updateFrequency: number;
	/** Handle of the active polling timer, or `undefined` before `subscribe()`/after `unsubscribe()`. */
	intervalId?: ReturnType<typeof setTimeout>;
	/** The current `DLOB` snapshot; replaced wholesale on each refresh rather than mutated. */
	dlob: DLOB;
	/** Emits `'update'` after each successful refresh and `'error'` if a refresh throws. */
	public eventEmitter: StrictEventEmitter<EventEmitter, DLOBSubscriberEvents>;
	/** @throws if `config.velocityClient` is not provided. */
	constructor(config: DLOBSubscriptionConfig) {
		const velocityClient = config.velocityClient;
		if (!velocityClient) {
			throw new Error('DLOBSubscriber: velocityClient must be provided');
		}
		this.velocityClient = velocityClient;
		this.dlobSource = config.dlobSource;
		this.slotSource = config.slotSource;
		this.updateFrequency = config.updateFrequency;
		this.dlob = new DLOB();
		this.eventEmitter = new EventEmitter();
	}

	/**
	 * Fetches an initial `DLOB` snapshot (awaited before returning) and then starts a timer that
	 * refreshes it every `updateFrequency` ms, emitting `'update'` on success or `'error'` if the
	 * fetch throws. No-ops if already subscribed.
	 */
	public async subscribe(): Promise<void> {
		if (this.intervalId) {
			return;
		}

		await this.updateDLOB();

		this.intervalId = setInterval(async () => {
			try {
				await this.updateDLOB();
				this.eventEmitter.emit('update', this.dlob);
			} catch (e) {
				this.eventEmitter.emit(
					'error',
					e instanceof Error ? e : new Error(String(e))
				);
			}
		}, this.updateFrequency);
	}

	/** Fetches a new `DLOB` snapshot at the current slot (from `slotSource`) via `dlobSource.getDLOB` and replaces `this.dlob`. */
	async updateDLOB(): Promise<void> {
		this.dlob = await this.dlobSource.getDLOB(this.slotSource.getSlot());
	}

	/** @returns the most recently fetched `DLOB` snapshot (empty until the first successful `subscribe()`/`updateDLOB()`). */
	public getDLOB(): DLOB {
		return this.dlob;
	}

	/**
	 * Get the L2 (aggregated price/size) order book for a given market, using the current
	 * `DLOB` snapshot and the current slot from `slotSource`.
	 *
	 * @param marketName e.g. "SOL-PERP" or "SOL". If not provided, `marketIndex` and `marketType` must both be provided.
	 * @param marketIndex market index; ignored if `marketName` is provided
	 * @param marketType market type; ignored if `marketName` is provided
	 * @param depth number of price levels to include per side; defaults to 10
	 * @param includeVamm whether to synthesize and merge in vAMM liquidity (perp markets only) via `getVammL2Generator`; defaults to `false`. Throws if `true` and `fallbackL2Generators` is non-empty.
	 * @param numVammOrders number of vAMM levels to generate per side when `includeVamm` is true; defaults to `depth`
	 * @param fallbackL2Generators additional non-DLOB liquidity sources to merge in, e.g. `getVammL2Generator`'s output; defaults to `[]`
	 * @param latestSlot latest observed slot (e.g. from a `SlotSubscriber`), used for more accurate vAMM spread-reserve quotes when `includeVamm` is true; optional
	 * @returns the merged `L2OrderBook` (bids/asks with sizes, BASE_PRECISION 1e9, and prices, PRICE_PRECISION 1e6)
	 * @throws if `marketName` doesn't resolve to a known market, if neither `marketName` nor both `marketIndex`/`marketType` are given, or if `includeVamm` is combined with a non-empty `fallbackL2Generators`
	 */
	public getL2({
		marketName,
		marketIndex,
		marketType,
		depth = 10,
		includeVamm = false,
		numVammOrders,
		fallbackL2Generators = [],
		latestSlot,
	}: {
		marketName?: string;
		marketIndex?: number;
		marketType?: MarketType;
		depth?: number;
		includeVamm?: boolean;
		numVammOrders?: number;
		fallbackL2Generators?: L2OrderBookGenerator[];
		latestSlot?: BN;
	}): L2OrderBook {
		if (marketName) {
			const derivedMarketInfo =
				this.velocityClient.getMarketIndexAndType(marketName);
			if (!derivedMarketInfo) {
				throw new Error(`Market ${marketName} not found`);
			}
			marketIndex = derivedMarketInfo.marketIndex;
			marketType = derivedMarketInfo.marketType;
		} else {
			if (marketIndex === undefined || marketType === undefined) {
				throw new Error(
					'Either marketName or marketIndex and marketType must be provided'
				);
			}
		}

		const isPerp = isVariant(marketType, 'perp');
		if (isPerp) {
			const perpMarketAccount =
				this.velocityClient.getPerpMarketAccountOrThrow(marketIndex);
			const oraclePriceData = this.velocityClient.getMMOracleDataForPerpMarket(
				perpMarketAccount.marketIndex
			);

			if (includeVamm) {
				if (fallbackL2Generators.length > 0) {
					throw new Error(
						'includeVamm can only be used if fallbackL2Generators is empty'
					);
				}

				fallbackL2Generators = [
					getVammL2Generator({
						marketAccount: perpMarketAccount,
						mmOraclePriceData:
							this.velocityClient.getMMOracleDataForPerpMarket(marketIndex),
						numOrders: numVammOrders ?? depth,
						topOfBookQuoteAmounts:
							marketIndex < 3
								? MAJORS_TOP_OF_BOOK_QUOTE_AMOUNTS
								: DEFAULT_TOP_OF_BOOK_QUOTE_AMOUNTS,
						latestSlot,
					}),
				];
			}

			return this.dlob.getL2({
				marketIndex,
				marketType: MarketType.PERP,
				depth,
				oraclePriceData,
				slot: this.slotSource.getSlot(),
				fallbackL2Generators: fallbackL2Generators,
				tickSize: perpMarketAccount.orderTickSize,
			});
		}

		const oraclePriceData =
			this.velocityClient.getOracleDataForSpotMarket(marketIndex);
		const spotMarketAccount =
			this.velocityClient.getSpotMarketAccountOrThrow(marketIndex);

		return this.dlob.getL2({
			marketIndex,
			marketType: MarketType.SPOT,
			depth,
			oraclePriceData,
			slot: this.slotSource.getSlot(),
			fallbackL2Generators: fallbackL2Generators,
			tickSize: spotMarketAccount.orderTickSize,
		});
	}

	/**
	 * Get the L3 (individual resting order) book for a given market, using the current `DLOB`
	 * snapshot and the current slot from `slotSource`. Does not include fallback (e.g. vAMM)
	 * liquidity.
	 *
	 * @param marketName e.g. "SOL-PERP" or "SOL". If not provided, `marketIndex` and `marketType` must both be provided.
	 * @param marketIndex market index; ignored if `marketName` is provided
	 * @param marketType market type; ignored if `marketName` is provided
	 * @returns the `L3OrderBook` (per-order price/size/maker/orderId, prices PRICE_PRECISION 1e6, sizes BASE_PRECISION 1e9)
	 * @throws if `marketName` doesn't resolve to a known market, or if neither `marketName` nor both `marketIndex`/`marketType` are given
	 */
	public getL3({
		marketName,
		marketIndex,
		marketType,
	}: {
		marketName?: string;
		marketIndex?: number;
		marketType?: MarketType;
	}): L3OrderBook {
		if (marketName) {
			const derivedMarketInfo =
				this.velocityClient.getMarketIndexAndType(marketName);
			if (!derivedMarketInfo) {
				throw new Error(`Market ${marketName} not found`);
			}
			marketIndex = derivedMarketInfo.marketIndex;
			marketType = derivedMarketInfo.marketType;
		} else {
			if (marketIndex === undefined || marketType === undefined) {
				throw new Error(
					'Either marketName or marketIndex and marketType must be provided'
				);
			}
		}

		const isPerp = isVariant(marketType, 'perp');
		if (isPerp) {
			const oraclePriceData =
				this.velocityClient.getMMOracleDataForPerpMarket(marketIndex);
			const perpMarketAccount =
				this.velocityClient.getPerpMarketAccountOrThrow(marketIndex);

			return this.dlob.getL3({
				marketIndex,
				marketType: MarketType.PERP,
				oraclePriceData,
				slot: this.slotSource.getSlot(),
				tickSize: perpMarketAccount.orderTickSize,
			});
		}

		const oraclePriceData =
			this.velocityClient.getOracleDataForSpotMarket(marketIndex);
		const spotMarketAccount =
			this.velocityClient.getSpotMarketAccountOrThrow(marketIndex);

		return this.dlob.getL3({
			marketIndex,
			marketType: MarketType.SPOT,
			oraclePriceData,
			slot: this.slotSource.getSlot(),
			tickSize: spotMarketAccount.orderTickSize,
		});
	}

	/** Stops the periodic refresh timer, if running. Safe to call when not subscribed. */
	public async unsubscribe(): Promise<void> {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}
}
