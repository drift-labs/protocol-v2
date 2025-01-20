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
	DEFAULT_TOP_OF_BOOK_QUOTE_AMOUNTS,
	getVammL2Generator,
	L2OrderBook,
	L2OrderBookGenerator,
	L3OrderBook,
} from './orderBookLevels';

export class DLOBSubscriber {
	driftClient: DriftClient;
	dlobSource: DLOBSource;
	slotSource: SlotSource;
	updateFrequency: number;
	intervalId?: NodeJS.Timeout;
	dlob: DLOB;
	public eventEmitter: StrictEventEmitter<EventEmitter, DLOBSubscriberEvents>;
	protectedMakerView: boolean;
	constructor(config: DLOBSubscriptionConfig) {
		this.driftClient = config.driftClient;
		this.dlobSource = config.dlobSource;
		this.slotSource = config.slotSource;
		this.updateFrequency = config.updateFrequency;
		this.protectedMakerView = config.protectedMakerView || false;
		this.dlob = new DLOB(this.protectedMakerView);
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
		this.dlob = await this.dlobSource.getDLOB(
			this.slotSource.getSlot(),
			this.protectedMakerView
		);
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
		numVammOrders,
		fallbackL2Generators = [],
	}: {
		marketName?: string;
		marketIndex?: number;
		marketType?: MarketType;
		depth?: number;
		includeVamm?: boolean;
		numVammOrders?: number;
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
		const isPerp = isVariant(marketType, 'perp');
		if (isPerp) {
			const perpMarketAccount =
				this.driftClient.getPerpMarketAccount(marketIndex);
			oraclePriceData = this.driftClient.getOracleDataForPerpMarket(
				perpMarketAccount.marketIndex
			);
		} else {
			oraclePriceData =
				this.driftClient.getOracleDataForSpotMarket(marketIndex);
		}

		if (isPerp && includeVamm) {
			if (fallbackL2Generators.length > 0) {
				throw new Error(
					'includeVamm can only be used if fallbackL2Generators is empty'
				);
			}

			fallbackL2Generators = [
				getVammL2Generator({
					marketAccount: this.driftClient.getPerpMarketAccount(marketIndex),
					oraclePriceData,
					numOrders: numVammOrders ?? depth,
					topOfBookQuoteAmounts: DEFAULT_TOP_OF_BOOK_QUOTE_AMOUNTS,
				}),
			];
		}

		return this.dlob.getL2({
			marketIndex,
			marketType,
			depth,
			oraclePriceData,
			slot: this.slotSource.getSlot(),
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
