import { DLOB } from './DLOB';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import {
	DLOBSource,
	DLOBSubscriberEvents,
	DLOBSubscriptionConfig,
	SlotSource,
} from './types';
import { DriftClient } from '../driftClient';
import { isVariant, MarketType } from '../types';
import {
	getVammL2Generator,
	L2OrderBook,
	L2OrderBookGenerator,
	L3OrderBook,
} from './orderBookLevels';
import { calculateAskPrice, calculateBidPrice } from '../math/market';

export class DLOBSubscriber {
	driftClient: DriftClient;
	dlobSource: DLOBSource;
	slotSource: SlotSource;
	updateFrequency: number;
	marketName?: string;
	marketIndex?: number;
	marketType?: MarketType;
	intervalId?: NodeJS.Timeout;
	dlob = new DLOB();
	public eventEmitter: StrictEventEmitter<EventEmitter, DLOBSubscriberEvents>;

	constructor(config: DLOBSubscriptionConfig) {
		this.driftClient = config.driftClient;
		this.dlobSource = config.dlobSource;
		this.slotSource = config.slotSource;
		this.updateFrequency = config.updateFrequency;
		this.marketName = config.marketName;
		this.marketIndex = config.marketIndex;
		this.marketType = config.marketType;
		this.eventEmitter = new EventEmitter();
	}

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
				this.eventEmitter.emit('error', e);
			}
		}, this.updateFrequency);
	}

	async updateDLOBMarket({
		marketName,
		marketIndex,
		marketType,
	}: {
		marketName?: string;
		marketIndex?: number;
		marketType?: MarketType;
	}) {
		this.marketName = marketName;
		this.marketIndex = marketIndex;
		this.marketType = marketType;
	}

	async updateDLOB(): Promise<void> {
		this.dlob = await this.dlobSource.getDLOB({
			slot: this.slotSource.getSlot(),
			marketName: this.marketName,
			marketIndex: this.marketIndex,
			marketType: this.marketType,
		});
	}

	public getDLOB(): DLOB {
		return this.dlob;
	}

	/**
	 * Get the L2 order book for a given market.
	 *
	 * @param marketName e.g. "SOL-PERP" or "SOL". If not provided, marketIndex and marketType must be provided.
	 * @param marketIndex
	 * @param marketType
	 * @param depth Number of orders to include in the order book. Defaults to 10.
	 * @param includeVamm Whether to include the VAMM orders in the order book. Defaults to false. If true, creates vAMM generator {@link getVammL2Generator} and adds it to fallbackL2Generators.
	 * @param fallbackL2Generators L2 generators for fallback liquidity e.g. vAMM {@link getVammL2Generator}, openbook {@link SerumSubscriber}
	 */
	public getL2({
		marketName,
		marketIndex,
		marketType,
		depth = 10,
		includeVamm = false,
		fallbackL2Generators = [],
	}: {
		marketName?: string;
		marketIndex?: number;
		marketType?: MarketType;
		depth?: number;
		includeVamm?: boolean;
		fallbackL2Generators?: L2OrderBookGenerator[];
	}): L2OrderBook {
		if (marketName) {
			const derivedMarketInfo =
				this.driftClient.getMarketIndexAndType(marketName);
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

		let oraclePriceData;
		let fallbackBid;
		let fallbackAsk;
		const isPerp = isVariant(marketType, 'perp');
		if (isPerp) {
			const perpMarketAccount =
				this.driftClient.getPerpMarketAccount(marketIndex);
			oraclePriceData = this.driftClient.getOracleDataForPerpMarket(
				perpMarketAccount.marketIndex
			);
			fallbackBid = calculateBidPrice(perpMarketAccount, oraclePriceData);
			fallbackAsk = calculateAskPrice(perpMarketAccount, oraclePriceData);
		} else {
			oraclePriceData =
				this.driftClient.getOracleDataForSpotMarket(marketIndex);
		}

		if (isPerp && includeVamm) {
			fallbackL2Generators = [
				getVammL2Generator({
					marketAccount: this.driftClient.getPerpMarketAccount(marketIndex),
					oraclePriceData,
					numOrders: depth,
				}),
			];
		}

		return this.dlob.getL2({
			marketIndex,
			marketType,
			depth,
			oraclePriceData,
			slot: this.slotSource.getSlot(),
			fallbackBid,
			fallbackAsk,
			fallbackL2Generators: fallbackL2Generators,
		});
	}

	/**
	 * Get the L3 order book for a given market.
	 *
	 * @param marketName e.g. "SOL-PERP" or "SOL". If not provided, marketIndex and marketType must be provided.
	 * @param marketIndex
	 * @param marketType
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
				this.driftClient.getMarketIndexAndType(marketName);
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

		let oraclePriceData;
		const isPerp = isVariant(marketType, 'perp');
		if (isPerp) {
			oraclePriceData =
				this.driftClient.getOracleDataForPerpMarket(marketIndex);
		} else {
			oraclePriceData =
				this.driftClient.getOracleDataForSpotMarket(marketIndex);
		}

		return this.dlob.getL3({
			marketIndex,
			marketType,
			oraclePriceData,
			slot: this.slotSource.getSlot(),
		});
	}

	public async unsubscribe(): Promise<void> {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}
}
