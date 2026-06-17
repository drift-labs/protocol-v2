/* eslint-disable @typescript-eslint/no-unused-vars */
import {
	DriftEnv,
	BASE_PRECISION,
	BN,
	DriftClient,
	MarketType,
	DLOBSubscriber,
	SlotSubscriber,
	PriorityFeeSubscriber,
	OrderSubscriber,
	calculateBidAskPrice,
	getVariant,
	isVariant,
} from '@drift-labs/sdk';
import { Mutex, tryAcquire, E_ALREADY_LOCKED } from 'async-mutex';
import { logger } from '../logger';
import { Bot } from '../types';
import {
	calculateBaseAmountToMarketMakePerp,
	calculateBaseAmountToMarketMakeSpot,
	convertToMarketType,
	getBestLimitAskExcludePubKey,
	getBestLimitBidExcludePubKey,
	isMarketVolatile,
	isSpotMarketVolatile,
	sleepMs,
} from '../utils';
import {
	JitterShotgun,
	JitterSniper,
	PriceType,
} from '@drift-labs/jit-proxy/lib';
import dotenv from 'dotenv';

dotenv.config();
import { PublicKey } from '@solana/web3.js';
import { BaseBotConfig } from '../config';

export type JitMakerConfig = BaseBotConfig & {
	subaccounts?: Array<number>;
	marketType: string;
	/// @deprecated, use {@link JitMakerConfig.marketIndexes} and {@link JitMakerConfig.marketType}
	perpMarketIndicies?: Array<number>;
	marketIndexes?: Array<number>;
	targetLeverage?: number;
	aggressivenessBps?: number;
	jitCULimit?: number;
};

/**
 * This is an example of a bot that implements the Bot interface.
 */
export class JitMaker implements Bot {
	public readonly name: string;
	public readonly dryRun: boolean;
	public readonly defaultIntervalMs: number = 30000;

	private driftEnv: DriftEnv;
	private periodicTaskMutex = new Mutex();

	private jitter: JitterSniper | JitterShotgun;
	private driftClient: DriftClient;
	private config: JitMakerConfig;
	private targetLeverage: number;

	// private subaccountConfig: SubaccountConfig;
	private subAccountIds: Array<number>;
	private marketIndexes: Array<number>;
	private marketType: MarketType;

	private intervalIds: Array<NodeJS.Timer> = [];

	private watchdogTimerMutex = new Mutex();
	private watchdogTimerLastPatTime = Date.now();

	private dlobSubscriber: DLOBSubscriber;
	private slotSubscriber: SlotSubscriber;
	private orderSubscriber: OrderSubscriber;
	private priorityFeeSubscriber: PriorityFeeSubscriber;
	private jitCULimit: number;

	constructor(
		driftClient: DriftClient, // driftClient needs to have correct number of subaccounts listed
		jitter: JitterSniper | JitterShotgun,
		config: JitMakerConfig,
		driftEnv: DriftEnv,
		priorityFeeSubscriber: PriorityFeeSubscriber
	) {
		this.config = config;
		this.subAccountIds = this.config.subaccounts ?? [0];

		// maintain backwards compatible config key `perpMarketIndicies`
		if (this.config.perpMarketIndicies && !this.config.marketIndexes) {
			this.marketIndexes = this.config.perpMarketIndicies;
		} else {
			this.marketIndexes = this.config.marketIndexes ?? [0];
		}

		this.marketType = convertToMarketType(this.config.marketType);
		this.targetLeverage = this.config.targetLeverage ?? 1;

		this.jitCULimit = this.config.jitCULimit ?? 800000;

		const subAccountLen = this.subAccountIds.length;

		// Check for 1:1 unique sub account id to market index ratio
		const marketLen = this.marketIndexes.length;
		if (subAccountLen !== marketLen) {
			throw new Error('You must have 1 sub account id per market to jit');
		}

		this.jitter = jitter;
		this.driftClient = driftClient;
		this.name = this.config.botId;
		this.dryRun = this.config.dryRun;
		this.driftEnv = driftEnv;

		this.slotSubscriber = new SlotSubscriber(this.driftClient.connection);

		this.orderSubscriber = new OrderSubscriber({
			driftClient: this.driftClient,
			subscriptionConfig: {
				commitment: 'processed',
				type: 'websocket',
				resubTimeoutMs: 30000,
				resyncIntervalMs: 300_000, // every 5 min
			},
		});

		this.dlobSubscriber = new DLOBSubscriber({
			dlobSource: this.orderSubscriber,
			slotSource: this.orderSubscriber,
			updateFrequency: 1000,
			driftClient: this.driftClient,
		});

		this.priorityFeeSubscriber = priorityFeeSubscriber;
		this.priorityFeeSubscriber.updateAddresses([
			new PublicKey('8UJgxaiQx5nTrdDgph5FiahMmzduuLTLf5WmsPegYA6W'), // sol-perp
		]);

		logger.info(
			`${this.name} init with targetLeverage: ${
				this.targetLeverage
			}, JIT making ${getVariant(this.marketType)} markets: ${
				this.marketIndexes
			}, and using an aggressiveness of ${this.config.aggressivenessBps} bps`
		);
	}

	/**
	 * Run initialization procedures for the bot.
	 */
	public async init(): Promise<void> {
		logger.info(`${this.name} initing`);
		await this.driftClient.fetchAllLookupTableAccounts();

		for (const subAccountId of this.subAccountIds) {
			if (!this.driftClient.hasUser(subAccountId)) {
				logger.info(`Adding subaccountId ${subAccountId} to driftClient`);
				await this.driftClient.addUser(subAccountId);
			}
		}

		// do stuff that takes some time
		await this.slotSubscriber.subscribe();
		await this.dlobSubscriber.subscribe();

		logger.info(`${this.name} init done`);
	}

	/**
	 * Reset the bot - usually you will reset any periodic tasks here
	 */
	public async reset(): Promise<void> {
		// reset any periodic tasks
		for (const intervalId of this.intervalIds) {
			clearInterval(intervalId as NodeJS.Timeout);
		}
		this.intervalIds = [];
	}

	public async startIntervalLoop(intervalMs?: number): Promise<void> {
		const intervalId = setInterval(
			this.runPeriodicTasks.bind(this),
			intervalMs
		);
		this.intervalIds.push(intervalId);

		logger.info(`${this.name} Bot started! driftEnv: ${this.driftEnv}`);
	}

	/**
	 * Typically used for monitoring liveness.
	 * @returns true if bot is healthy, else false.
	 */
	public async healthCheck(): Promise<boolean> {
		let healthy = false;
		await this.watchdogTimerMutex.runExclusive(async () => {
			healthy =
				this.watchdogTimerLastPatTime > Date.now() - 2 * this.defaultIntervalMs;
		});
		return healthy;
	}

	/**
	 * Typical bot loop that runs periodically and pats the watchdog timer on completion.
	 *
	 */
	private async runPeriodicTasks() {
		const start = Date.now();
		let ran = false;
		try {
			await tryAcquire(this.periodicTaskMutex).runExclusive(async () => {
				console.log(
					`[${new Date().toISOString()}] Running JIT periodic tasks...`
				);
				for (let i = 0; i < this.marketIndexes.length; i++) {
					if (isVariant(this.marketType, 'perp')) {
						await this.jitPerp(i);
					} else {
						await this.jitSpot(i);
					}
				}

				console.log(`done: ${Date.now() - start}ms`);
				ran = true;
			});
		} catch (e) {
			if (e === E_ALREADY_LOCKED) {
				return;
			} else {
				throw e;
			}
		} finally {
			if (ran) {
				const duration = Date.now() - start;
				logger.debug(`${this.name} Bot took ${duration}ms to run`);

				await this.watchdogTimerMutex.runExclusive(async () => {
					this.watchdogTimerLastPatTime = Date.now();
				});
			}
		}
	}

	private async jitPerp(index: number) {
		const perpIdx = this.marketIndexes[index];
		const subId = this.subAccountIds[index];
		await this.driftClient.switchActiveUser(subId);

		const driftUser = this.driftClient.getUser(subId);
		const perpMarketAccount = this.driftClient.getPerpMarketAccount(perpIdx)!;
		const mmOraclePriceData =
			this.driftClient.getMMOracleDataForPerpMarket(perpIdx);

		const numMarketsForSubaccount = this.subAccountIds.filter(
			(num) => num === subId
		).length;

		const targetLeverage = this.targetLeverage / numMarketsForSubaccount;
		const actualLeverage = driftUser.getLeverage().div(new BN(10_000));

		const maxBase: number = calculateBaseAmountToMarketMakePerp(
			perpMarketAccount,
			driftUser,
			targetLeverage
		);

		let overleveredLong = false;
		let overleveredShort = false;

		if (actualLeverage.toNumber() >= targetLeverage * 0.95) {
			logger.warn(
				`jit maker at or above max leverage actual: ${actualLeverage} target: ${targetLeverage}`
			);
			const overleveredBaseAssetAmount =
				driftUser.getPerpPosition(perpIdx)!.baseAssetAmount;
			if (overleveredBaseAssetAmount.gt(new BN(0))) {
				overleveredLong = true;
			} else if (overleveredBaseAssetAmount.lt(new BN(0))) {
				overleveredShort = true;
			}
		}

		this.jitter.setUserFilter((userAccount, userKey) => {
			let skip = userKey == driftUser.userAccountPublicKey.toBase58();

			if (
				isMarketVolatile(
					perpMarketAccount,
					mmOraclePriceData,
					0.015 // 150 bps
				)
			) {
				console.log('skipping, market is volatile');
				skip = true;
			}

			if (skip) {
				console.log('skipping user:', userKey);
			}

			return skip;
		});

		const slot = this.orderSubscriber.getSlot();
		const dlob = this.dlobSubscriber.getDLOB();
		const bestDLOBBid = dlob.getBestBid(
			perpMarketAccount.marketIndex,
			slot,
			MarketType.PERP,
			mmOraclePriceData
		);
		const bestDLOBAsk = dlob.getBestAsk(
			perpMarketAccount.marketIndex,
			slot,
			MarketType.PERP,
			mmOraclePriceData
		);

		const [ammBid, ammAsk] = calculateBidAskPrice(
			perpMarketAccount.amm,
			this.driftClient.getMMOracleDataForPerpMarket(perpIdx),
			true
		);

		let bestBidPrice;
		if (bestDLOBBid) {
			bestBidPrice = BN.max(BN.min(bestDLOBBid, ammAsk), ammBid);
		} else {
			bestBidPrice = ammBid;
		}

		let bestAskPrice;
		if (bestDLOBAsk) {
			bestAskPrice = BN.min(BN.max(bestDLOBAsk, ammBid), ammAsk);
		} else {
			bestAskPrice = ammAsk;
		}

		const bidOffset = bestBidPrice
			.muln(10000 + (this.config.aggressivenessBps ?? 0))
			.divn(10000);

		const askOffset = bestAskPrice
			.muln(10000 - (this.config.aggressivenessBps ?? 0))
			.divn(10000);

		let perpMinPosition = new BN(-maxBase * BASE_PRECISION.toNumber());
		let perpMaxPosition = new BN(maxBase * BASE_PRECISION.toNumber());

		if (overleveredLong) {
			perpMaxPosition = new BN(0);
		} else if (overleveredShort) {
			perpMinPosition = new BN(0);
		}

		const priorityFee = Math.floor(
			this.priorityFeeSubscriber.getCustomStrategyResult() * 1.1
		);
		this.jitter.setComputeUnitsPrice(priorityFee);
		this.jitter.setComputeUnits(this.jitCULimit);

		this.jitter.updatePerpParams(perpIdx, {
			maxPosition: perpMaxPosition,
			minPosition: perpMinPosition,
			bid: bidOffset,
			ask: askOffset,
			priceType: PriceType.LIMIT,
			subAccountId: subId,
		});
	}

	private async jitSpot(index: number) {
		const spotIdx = this.marketIndexes[index];
		const subId = this.subAccountIds[index];
		await this.driftClient.switchActiveUser(subId);

		const driftUser = this.driftClient.getUser(subId);
		const spotMarketAccount = this.driftClient.getSpotMarketAccount(spotIdx)!;
		const oraclePriceData =
			this.driftClient.getOracleDataForSpotMarket(spotIdx);

		const numMarketsForSubaccount = this.subAccountIds.filter(
			(num) => num === subId
		).length;

		const targetLeverage = this.targetLeverage / numMarketsForSubaccount;
		const actualLeverage = driftUser.getLeverage().div(new BN(10_000));

		const maxBase: number = calculateBaseAmountToMarketMakeSpot(
			spotMarketAccount,
			driftUser,
			targetLeverage
		);

		let overleveredLong = false;
		let overleveredShort = false;

		if (actualLeverage.toNumber() >= targetLeverage * 0.95) {
			logger.warn(
				`jit maker at or above max leverage actual: ${actualLeverage} target: ${targetLeverage}`
			);
			const overleveredBaseAssetAmount =
				driftUser.getSpotPosition(spotIdx)!.scaledBalance;
			if (overleveredBaseAssetAmount.gt(new BN(0))) {
				overleveredLong = true;
			} else if (overleveredBaseAssetAmount.lt(new BN(0))) {
				overleveredShort = true;
			}
		}

		this.jitter.setUserFilter((userAccount, userKey) => {
			let skip = userKey == driftUser.userAccountPublicKey.toBase58();

			if (
				isSpotMarketVolatile(
					spotMarketAccount,
					oraclePriceData,
					0.015 // 150 bps
				)
			) {
				console.log('skipping, market is volatile');
				skip = true;
			}

			if (skip) {
				console.log('skipping user:', userKey);
			}

			return skip;
		});

		const bestDriftBid = getBestLimitBidExcludePubKey(
			this.dlobSubscriber.dlob,
			spotMarketAccount.marketIndex,
			MarketType.SPOT,
			oraclePriceData.slot.toNumber(),
			oraclePriceData,
			driftUser.userAccountPublicKey.toString()
		);

		const bestDriftAsk = getBestLimitAskExcludePubKey(
			this.dlobSubscriber.dlob,
			spotMarketAccount.marketIndex,
			MarketType.SPOT,
			oraclePriceData.slot.toNumber(),
			oraclePriceData,
			driftUser.userAccountPublicKey.toString()
		);

		if (!bestDriftBid || !bestDriftAsk) {
			logger.warn('skipping, no best bid/ask');
			return;
		}

		const bestBidPrice = bestDriftBid.getPrice(
			oraclePriceData,
			this.dlobSubscriber.slotSource.getSlot()
		);

		const bestAskPrice = bestDriftAsk.getPrice(
			oraclePriceData,
			this.dlobSubscriber.slotSource.getSlot()
		);

		const bidOffset = bestBidPrice.sub(oraclePriceData.price);

		const askOffset = bestAskPrice.sub(oraclePriceData.price);

		const spotMarketPrecision = 10 ** spotMarketAccount.decimals;

		let spotMinPosition = new BN(-maxBase * spotMarketPrecision);
		let spotMaxPosition = new BN(maxBase * spotMarketPrecision);

		if (overleveredLong) {
			spotMaxPosition = new BN(0);
		} else if (overleveredShort) {
			spotMinPosition = new BN(0);
		}

		this.jitter.updateSpotParams(spotIdx, {
			maxPosition: spotMaxPosition,
			minPosition: spotMinPosition,
			bid: bidOffset,
			ask: askOffset,
			priceType: PriceType.ORACLE,
			subAccountId: subId,
		});
	}
}
