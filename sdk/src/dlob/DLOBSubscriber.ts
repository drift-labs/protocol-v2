import { DLOB, L2OrderBook, L3OrderBook } from './DLOB';
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
import { FallbackOrders, getVammOrders } from './fallbackOrders';

export class DLOBSubscriber {
	driftClient: DriftClient;
	dlobSource: DLOBSource;
	slotSource: SlotSource;
	updateFrequency: number;
	intervalId?: NodeJS.Timeout;
	dlob = new DLOB();
	public eventEmitter: StrictEventEmitter<EventEmitter, DLOBSubscriberEvents>;

	constructor(config: DLOBSubscriptionConfig) {
		this.driftClient = config.driftClient;
		this.dlobSource = config.dlobSource;
		this.slotSource = config.slotSource;
		this.updateFrequency = config.updateFrequency;
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

	async updateDLOB(): Promise<void> {
		this.dlob = await this.dlobSource.getDLOB(this.slotSource.getSlot());
	}

	public getDLOB(): DLOB {
		return this.dlob;
	}

	public getL2({
		marketName,
		marketIndex,
		marketType,
		depth = 10,
		includeVamm = false,
		fallbackOrders = [],
	}: {
		marketName?: string;
		marketIndex?: number;
		marketType?: MarketType;
		depth?: number;
		includeVamm?: boolean;
		fallbackOrders?: FallbackOrders[];
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
			if (!marketIndex || !marketType) {
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

		if (isPerp && includeVamm) {
			fallbackOrders = [
				getVammOrders({
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
			fallbackOrders,
		});
	}

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
			if (!marketIndex || !marketType) {
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
