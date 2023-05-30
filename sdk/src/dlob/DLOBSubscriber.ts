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
import { PhoenixSubscriber } from '../phoenix/phoenixSubscriber';
import { PROGRAM_ID as PHOENIX_PROGRAM_ID } from '@ellipsis-labs/phoenix-sdk';
import { SpotMarkets } from '../constants/spotMarkets';
import { SerumSubscriber } from '../serum/serumSubscriber';
import { DriftEnv, configs } from '../config';
import { PublicKey } from '@solana/web3.js';

export class DLOBSubscriber {
	driftClient: DriftClient;
	dlobSource: DLOBSource;
	slotSource: SlotSource;
	updateFrequency: number;
	intervalId?: NodeJS.Timeout;
	dlob = new DLOB();
	public eventEmitter: StrictEventEmitter<EventEmitter, DLOBSubscriberEvents>;
	env : DriftEnv;

	constructor(config: DLOBSubscriptionConfig) {
		this.driftClient = config.driftClient;
		this.dlobSource = config.dlobSource;
		this.slotSource = config.slotSource;
		this.updateFrequency = config.updateFrequency;
		this.eventEmitter = new EventEmitter();
		this.env = config.env;

		if (!config.env) {
			const isMainnet = !this.driftClient.connection.rpcEndpoint.includes('devnet');
			if (isMainnet) {
				this.env = 'mainnet-beta';
			} else {
				this.env = 'devnet';
			}
		}
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
	public async getL2({
		marketName,
		marketIndex,
		marketType,
		depth = 10,
		fallbackL2Generators = [],
		opts
	}: {
		marketName?: string;
		marketIndex?: number;
		marketType?: MarketType;
		depth?: number;
		fallbackL2Generators?: L2OrderBookGenerator[];
		opts?: {
			includeVammL2?:boolean;
			includePhoenixL2?:boolean,
			includeSerumL2?:boolean,
		}
	}): Promise<L2OrderBook> {

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

		if (isPerp && opts?.includeVammL2) {
			fallbackL2Generators = [
				getVammL2Generator({
					marketAccount: this.driftClient.getPerpMarketAccount(marketIndex),
					oraclePriceData,
					numOrders: depth,
				}),
			];
		}

		if (!isPerp) {
			const isMainnet = this.env === 'mainnet-beta';
			const config = isMainnet ? configs['mainnet-beta'] : configs['devnet'];
			const spotMarket = (isMainnet ? (SpotMarkets['mainnet-beta']) : (SpotMarkets.devnet)).find(market => market.marketIndex === marketIndex);
			const phoenixMarket = spotMarket.phoenixMarket;

			if (opts?.includePhoenixL2) {
				// TODO : Is websocket the right thing to use here?
				//// TODO is it better to initialize these subscribers when we create the DLOB subscriber so that they always have data available?
				const phoenixSubscriber = new PhoenixSubscriber({
					connection: this.driftClient.connection,
					programId: PHOENIX_PROGRAM_ID,
					marketAddress: phoenixMarket,
					accountSubscription: {
						type:'websocket'
					}
				});

				await phoenixSubscriber.subscribe();

				fallbackL2Generators.push(phoenixSubscriber);
			}

			if (opts?.includeSerumL2) {
				// TODO : Is websocket the right thing to use here?
				//// TODO is it better to initialize these subscribers when we create the DLOB subscriber so that they always have data available?
				const serumSubscriber = new SerumSubscriber({
					connection: this.driftClient.connection,
					programId: new PublicKey(config.SERUM_V3),
					marketAddress: spotMarket.serumMarket,
					accountSubscription: {
						type:'websocket'
					}
				});

				await serumSubscriber.subscribe();
	
				fallbackL2Generators.push(serumSubscriber);
			}

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
