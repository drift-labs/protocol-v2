import {
	DLOB,
	DriftClient,
	UserMap,
	SlotSubscriber,
	MarketType,
	PositionDirection,
	getUserStatsAccountPublicKey,
	promiseTimeout,
	isVariant,
	PriorityFeeSubscriberMap,
	DriftMarketInfo,
	isOneOfVariant,
	getVariant,
	PerpMarkets,
	BlockhashSubscriber,
} from '@drift-labs/sdk';
import { Mutex } from 'async-mutex';

import { logger } from '../logger';
import { Bot } from '../types';
import { GlobalConfig, MakerBidAskTwapCrankConfig } from '../config';
import {
	TransactionSignature,
	VersionedTransaction,
	AddressLookupTableAccount,
	PublicKey,
	ComputeBudgetProgram,
	TransactionInstruction,
	TransactionExpiredBlockheightExceededError,
} from '@solana/web3.js';
import { webhookMessage } from '../webhook';
import { ConfirmOptions, Signer } from '@solana/web3.js';
import {
	chunks,
	getAllPythOracleUpdateIxs,
	getDriftPriorityFeeEndpoint,
	handleSimResultError,
	simulateAndGetTxWithCUs,
	SimulateAndGetTxWithCUsResponse,
} from '../utils';
import { PythLazerSubscriber } from '../pythLazerSubscriber';
import { BundleSender } from '../bundleSender';

const CU_EST_MULTIPLIER = 1.4;
const DEFAULT_INTERVAL_GROUP = -1;
const TWAP_CRANK_MIN_CU = 200_000;
const MIN_PRIORITY_FEE = 10_000;
const MAX_PRIORITY_FEE = process.env.MAX_PRIORITY_FEE
	? parseInt(process.env.MAX_PRIORITY_FEE) || 500_000
	: 500_000;

const CACHED_BLOCKHASH_OFFSET = 5;

const TX_LAND_RATE_THRESHOLD = process.env.TX_LAND_RATE_THRESHOLD
	? parseFloat(process.env.TX_LAND_RATE_THRESHOLD) || 0.5
	: 0.5;
const NUM_MAKERS_TO_LOOK_AT_FOR_TWAP_CRANK = 2;
const TX_PER_JITO_BUNDLE = 3;

const CONCURRENCY_LIMIT = 3;

// Timeouts and watchdog thresholds
const SIM_TIMEOUT_MS = 10_000;
const TX_SEND_TIMEOUT_MS = 20_000;
const BUNDLE_SEND_TIMEOUT_MS = 15_000;
const RPC_TIMEOUT_MS = 10_000;
const STUCK_INTERVAL_MULTIPLIER = 4; // consider stuck if run time > 4x interval

function getStuckThresholdMs(intervalGroup: number): number {
	// Fallback for DEFAULT_INTERVAL_GROUP or small intervals
	const base = intervalGroup > 0 ? intervalGroup : 30_000;
	return Math.max(base * STUCK_INTERVAL_MULTIPLIER, 60_000);
}

const TX_SEND_TIMEOUT_THRESHOLD = process.env.TX_SEND_TIMEOUT_THRESHOLD
	? parseInt(process.env.TX_SEND_TIMEOUT_THRESHOLD) || 10
	: 10;

function isCriticalError(e: Error): boolean {
	// retrying on this error is standard
	if (e.message.includes('Blockhash not found')) {
		return false;
	}

	if (e.message.includes('Transaction was not confirmed in')) {
		return false;
	}
	return true;
}

export async function sendVersionedTransaction(
	driftClient: DriftClient,
	tx: VersionedTransaction,
	additionalSigners?: Array<Signer>,
	opts?: ConfirmOptions,
	timeoutMs = 5000
): Promise<TransactionSignature | null> {
	// @ts-ignore
	tx.sign((additionalSigners ?? []).concat(driftClient.provider.wallet.payer));

	if (opts === undefined) {
		opts = driftClient.provider.opts;
	}

	const rawTransaction = tx.serialize();
	let txid: TransactionSignature | null;
	try {
		txid = await promiseTimeout(
			driftClient.provider.connection.sendRawTransaction(rawTransaction, opts),
			timeoutMs
		);
		if (txid === null) {
			logger.warn(
				`[sendVersionedTransaction] sendRawTransaction timed out after ${timeoutMs}ms`
			);
		}
	} catch (e) {
		console.error(e);
		throw e;
	}

	return txid;
}

/**
 * Builds a mapping from crank interval (ms) to perp market indexes
 * @param driftClient
 * @returns
 */
function buildCrankIntervalToMarketIds(
	driftClient: DriftClient,
	crankIntervalToMarketIndicies?: { [key: number]: number[] }
): {
	crankIntervals: { [key: number]: number[] };
	driftMarkets: DriftMarketInfo[];
} {
	const crankIntervals: { [key: number]: number[] } = {};
	const driftMarkets: DriftMarketInfo[] = [];

	const overrideMarketIndexToCrankingInterval: { [key: number]: number } = {};
	if (crankIntervalToMarketIndicies) {
		for (const [interval, marketIndexes] of Object.entries(
			crankIntervalToMarketIndicies
		)) {
			for (const marketIndex of marketIndexes) {
				overrideMarketIndexToCrankingInterval[marketIndex] = parseInt(interval);
				logger.info(
					`Overriding crank interval for market ${marketIndex} to ${interval}ms`
				);
			}
		}
	}

	for (const perpMarket of driftClient.getPerpMarketAccounts()) {
		if (isOneOfVariant(perpMarket.status, ['settlement', 'delisted'])) {
			logger.info(
				`markTwapCrank skipping market ${
					perpMarket.marketIndex
				} with status ${getVariant(perpMarket.status)}`
			);
			continue;
		}

		driftMarkets.push({
			marketType: 'perp',
			marketIndex: perpMarket.marketIndex,
		});

		let crankPeriodMs = 10_000;
		if (perpMarket.marketIndex in overrideMarketIndexToCrankingInterval) {
			crankPeriodMs =
				overrideMarketIndexToCrankingInterval[perpMarket.marketIndex];
		} else {
			if (isOneOfVariant(perpMarket.contractTier, ['a', 'b'])) {
				crankPeriodMs = 10_000;
			} else if (isVariant(perpMarket.amm.oracleSource, 'prelaunch')) {
				crankPeriodMs = 30_000;
			}
		}
		logger.info(
			`Perp market ${perpMarket.marketIndex} contractTier: ${getVariant(
				perpMarket.contractTier
			)} isPrelaunch: ${isVariant(
				perpMarket.amm.oracleSource,
				'prelaunch'
			)}, crankPeriodMs: ${crankPeriodMs}`
		);
		if (crankIntervals[crankPeriodMs] === undefined) {
			crankIntervals[crankPeriodMs] = [perpMarket.marketIndex];
		} else {
			crankIntervals[crankPeriodMs].push(perpMarket.marketIndex);
		}
	}

	return {
		crankIntervals,
		driftMarkets,
	};
}

export class MakerBidAskTwapCrank implements Bot {
	public readonly name: string;
	public readonly dryRun: boolean;
	public readonly runOnce: boolean;
	public readonly defaultIntervalMs?: number = undefined;

	public readonly globalConfig: GlobalConfig;

	private crankIntervalToMarketIds?: { [key: number]: number[] }; // Object from number to array of numbers
	private crankIntervalInProgress?: { [key: number]: boolean };
	private crankIntervalStartTime?: { [key: number]: number };
	private allCrankIntervalGroups?: number[];
	private maxIntervalGroup?: number; // tracks the max interval group for health checking

	private slotSubscriber: SlotSubscriber;
	private driftClient: DriftClient;
	private intervalIds: Array<NodeJS.Timer> = [];
	private userMap?: UserMap;

	private dlob?: DLOB;
	private latestDlobSlot?: number;
	private priorityFeeSubscriberMap?: PriorityFeeSubscriberMap;

	private watchdogTimerMutex = new Mutex();
	private watchdogTimerLastPatTime = Date.now();
	private pythLazerSubscriber?: PythLazerSubscriber;
	private pythHealthy: boolean = true;
	private lookupTableAccounts: AddressLookupTableAccount[];
	private blockhashSubscriber: BlockhashSubscriber;
	private txSendTimeoutCount: number = 0;
	private txSendHealthy: boolean = true;

	private bundleSender?: BundleSender;
	private crankIntervalToMarketIndicies?: { [key: number]: number[] };

	constructor(
		driftClient: DriftClient,
		slotSubscriber: SlotSubscriber,
		userMap: UserMap,
		config: MakerBidAskTwapCrankConfig,
		globalConfig: GlobalConfig,
		runOnce: boolean,
		blockhashSubscriber: BlockhashSubscriber,
		lookupTableAccounts: AddressLookupTableAccount[] = [],
		bundleSender?: BundleSender
	) {
		this.slotSubscriber = slotSubscriber;
		this.name = config.botId;
		this.dryRun = config.dryRun;
		this.runOnce = runOnce;
		this.globalConfig = globalConfig;
		this.driftClient = driftClient;
		this.userMap = userMap;
		this.lookupTableAccounts = lookupTableAccounts;
		this.bundleSender = bundleSender;
		this.crankIntervalToMarketIndicies = config.crankIntervalToMarketIndicies;
		this.blockhashSubscriber = blockhashSubscriber;

		// Pyth lazer: remember to remove devnet guard
		if (!this.globalConfig.lazerEndpoints || !this.globalConfig.lazerToken) {
			throw new Error('Missing lazerEndpoint or lazerToken in global config');
		}

		const markets = PerpMarkets[this.globalConfig.driftEnv!].filter(
			(market) =>
				market.pythLazerId !== undefined &&
				(!market.marketStatus ||
					!isOneOfVariant(market.marketStatus, ['delisted', 'settlement']))
		);
		const pythLazerIds = markets.map((m) => m.pythLazerId!);
		const pythLazerIdsChunks = chunks(pythLazerIds, 4);
		this.pythLazerSubscriber = new PythLazerSubscriber(
			this.globalConfig.lazerEndpoints,
			this.globalConfig.lazerToken,
			pythLazerIdsChunks.map((ids) => {
				return {
					priceFeedIds: ids,
					channel: 'fixed_rate@200ms',
				};
			}),
			this.globalConfig.driftEnv
		);
	}

	public async init() {
		await this.pythLazerSubscriber?.subscribe();

		logger.info(`[${this.name}] initing, runOnce: ${this.runOnce}`);
		this.lookupTableAccounts.push(
			...(await this.driftClient.fetchAllLookupTableAccounts())
		);

		let driftMarkets: DriftMarketInfo[] = [];
		console.log('1.crank ints');
		({ crankIntervals: this.crankIntervalToMarketIds, driftMarkets } =
			buildCrankIntervalToMarketIds(
				this.driftClient,
				this.crankIntervalToMarketIndicies
			));
		logger.info(
			`[${this.name}] crankIntervals:\n${JSON.stringify(
				this.crankIntervalToMarketIds,
				null,
				2
			)}`
		);

		this.crankIntervalInProgress = {};
		this.crankIntervalStartTime = {};
		if (this.crankIntervalToMarketIds) {
			this.allCrankIntervalGroups = Object.keys(
				this.crankIntervalToMarketIds
			).map((x) => parseInt(x));
			this.maxIntervalGroup = Math.max(...this.allCrankIntervalGroups!);
			this.watchdogTimerLastPatTime = Date.now() - this.maxIntervalGroup;

			for (const intervalGroup of this.allCrankIntervalGroups!) {
				this.crankIntervalInProgress[intervalGroup] = false;
				this.crankIntervalStartTime[intervalGroup] = 0;
			}
		} else {
			this.crankIntervalInProgress[DEFAULT_INTERVAL_GROUP] = false;
			this.crankIntervalStartTime[DEFAULT_INTERVAL_GROUP] = 0;
		}

		this.priorityFeeSubscriberMap = new PriorityFeeSubscriberMap({
			driftPriorityFeeEndpoint: getDriftPriorityFeeEndpoint('mainnet-beta'),
			driftMarkets,
			frequencyMs: 10_000,
		});
		await this.priorityFeeSubscriberMap.subscribe();
	}

	public async reset() {
		for (const intervalId of this.intervalIds) {
			clearInterval(intervalId as NodeJS.Timeout);
		}
		this.intervalIds = [];

		await this.userMap?.unsubscribe();
		await this.pythLazerSubscriber?.unsubscribe();
		await this.priorityFeeSubscriberMap?.unsubscribe();

		// Reset tx timeout tracking and health on reset
		this.txSendTimeoutCount = 0;
		this.txSendHealthy = true;
	}

	public async startIntervalLoop(_intervalMs?: number): Promise<void> {
		logger.info(`[${this.name}] Bot started!`);
		if (this.runOnce) {
			await this.tryTwapCrank(null);
		} else {
			// start an interval for each crank interval
			for (const intervalGroup of this.allCrankIntervalGroups!) {
				const intervalId = setInterval(
					this.tryTwapCrank.bind(this, intervalGroup),
					intervalGroup
				);
				this.intervalIds.push(intervalId);
			}
		}
	}

	public async healthCheck(): Promise<boolean> {
		let healthy = false;
		await this.watchdogTimerMutex.runExclusive(async () => {
			healthy =
				this.watchdogTimerLastPatTime > Date.now() - 5 * this.maxIntervalGroup!;
		});
		return healthy && this.pythHealthy && this.txSendHealthy;
	}

	private async initDlob() {
		try {
			this.latestDlobSlot = this.slotSubscriber.currentSlot;
			const dlob = await promiseTimeout(
				this.userMap!.getDLOB(this.slotSubscriber.currentSlot),
				RPC_TIMEOUT_MS
			);
			if (dlob) {
				this.dlob = dlob;
			} else {
				this.dlob = undefined;
				logger.warn(
					`[${this.name}] getDLOB timed out after ${RPC_TIMEOUT_MS}ms`
				);
			}
		} catch (e) {
			logger.error(`[${this.name}] Error loading dlob: ${e}`);
		}
	}

	private getCombinedList(makersArray: PublicKey[]) {
		const combinedList = [];

		for (const maker of makersArray) {
			const uA = this.userMap!.getUserAuthority(maker.toString());
			if (uA !== undefined) {
				const uStats = getUserStatsAccountPublicKey(
					this.driftClient.program.programId,
					uA
				);

				// Combine maker and uStats into a list and add it to the combinedList
				const combinedItem = [maker, uStats];
				combinedList.push(combinedItem);
			} else {
				logger.warn(
					'[${this.name}] skipping maker... cannot find authority for userAccount=',
					maker.toString()
				);
			}
		}

		return combinedList;
	}

	private async sendSingleTx(
		marketIndex: number,
		tx: VersionedTransaction
	): Promise<void> {
		try {
			const sendTxStart = Date.now();
			const txSig = await promiseTimeout(
				this.driftClient.txSender.sendVersionedTransaction(tx, [], {
					...this.driftClient.opts,
				}),
				TX_SEND_TIMEOUT_MS
			);
			if (txSig) {
				logger.info(
					`[${
						this.name
					}] makerBidAskTwapCrank sent tx for market: ${marketIndex} in ${
						Date.now() - sendTxStart
					}ms tx: https://solana.fm/tx/${txSig.txSig}, txSig: ${
						txSig.txSig
					}, slot: ${txSig.slot}`
				);
				this.txSendTimeoutCount = Math.max(0, this.txSendTimeoutCount - 1);
			} else {
				logger.warn(
					`[${this.name}] sendVersionedTransaction timed out after ${TX_SEND_TIMEOUT_MS}ms (market: ${marketIndex})`
				);
				this.txSendTimeoutCount += 1;
				if (this.txSendTimeoutCount >= TX_SEND_TIMEOUT_THRESHOLD) {
					if (this.txSendHealthy) {
						logger.error(
							`[${this.name}] observed ${this.txSendTimeoutCount} send timeouts (>= ${TX_SEND_TIMEOUT_THRESHOLD}). Marking bot unhealthy.`
						);
					}
					this.txSendHealthy = false;
				}
			}
		} catch (err: any) {
			logger.error(
				`[${
					this.name
				}] for market ${marketIndex} error sending tx: ${JSON.stringify(err)}`
			);
			logger.error(
				`Dumped tx: ${Buffer.from(tx.serialize()).toString('base64')}`
			);
			if (err instanceof TransactionExpiredBlockheightExceededError) {
				logger.info(
					`[${this.name}] Blockheight exceeded error, retrying with market: ${marketIndex})`
				);
			} else if (err instanceof Error) {
				if (isCriticalError(err)) {
					logger.error(
						`[${this.name}] for market ${marketIndex} critical error: ${err}`
					);
					throw err;
				} else {
					return;
				}
			}
		}
		return;
	}

	private async buildTransaction(
		marketIndex: number,
		ixs: TransactionInstruction[],
		doSimulation = true
	): Promise<VersionedTransaction | undefined> {
		const recentBlockhash = await this.getBlockhashForTx();

		let simResult: SimulateAndGetTxWithCUsResponse | undefined | null;
		try {
			simResult = await promiseTimeout(
				simulateAndGetTxWithCUs({
					ixs,
					connection: this.driftClient.connection,
					payerPublicKey: this.driftClient.wallet.publicKey,
					lookupTableAccounts: this.lookupTableAccounts,
					cuLimitMultiplier: CU_EST_MULTIPLIER,
					minCuLimit: TWAP_CRANK_MIN_CU,
					doSimulation,
					recentBlockhash,
				}),
				SIM_TIMEOUT_MS
			);
		} catch (error) {
			logger.error(`[${this.name}] simulating tx: ${error}`);
			return;
		}

		if (!simResult || simResult.simError !== null) {
			if (!simResult) {
				logger.warn(
					`[${this.name}] simulateAndGetTxWithCUs timed out after ${SIM_TIMEOUT_MS}ms (market: ${marketIndex})`
				);
			}
			logger.error(
				`[${this.name}] Sim error (market: ${marketIndex}): ${JSON.stringify(
					simResult ? simResult.simError : 'timeout'
				)}\n${
					simResult && simResult.simTxLogs ? simResult.simTxLogs.join('\n') : ''
				}`
			);
			if (simResult) {
				handleSimResultError(
					simResult,
					[],
					`[${this.name}] (market: ${marketIndex})`,
					false,
					'bid or ask twap unchanged from small ts delta update'
				);
			}
			return;
		} else {
			return simResult.tx;
		}
	}

	private async getBlockhashForTx(): Promise<string> {
		const cachedBlockhash = this.blockhashSubscriber.getLatestBlockhash(
			CACHED_BLOCKHASH_OFFSET
		);
		if (cachedBlockhash) {
			return cachedBlockhash.blockhash as string;
		}

		console.log('getting recent blockhash from rpc...');
		const recentBlockhash =
			await this.driftClient.connection.getLatestBlockhash({
				commitment: 'confirmed',
			});
		return recentBlockhash.blockhash;
	}

	private async getPythIxsFromTwapCrankInfo(
		crankMarketIndex: number,
		precedingIxs: TransactionInstruction[] = []
	): Promise<TransactionInstruction[]> {
		if (crankMarketIndex === undefined) {
			throw new Error('Market index not found on node');
		}
		const pythIxs = await getAllPythOracleUpdateIxs(
			crankMarketIndex,
			this.driftClient,
			this.pythLazerSubscriber,
			precedingIxs
		);
		return pythIxs;
	}

	/**
	 * @returns true if configured to use jito AND there is currently a jito leader
	 */
	private sendThroughJito(): boolean {
		if (!this.bundleSender) {
			// not configured for jito
			logger.warn(`skip sendThroughJito, bundleSender not initialized`);
			return false;
		}

		const slotsUntilNextLeader = this.bundleSender.slotsUntilNextLeader();
		if (slotsUntilNextLeader === undefined || slotsUntilNextLeader > 0) {
			logger.warn(
				`skip sendThroughJito, slotsUntilNextLeader: ${slotsUntilNextLeader}`
			);
			return false;
		}

		return true;
	}

	private async tryTwapCrank(intervalGroup: number | null) {
		const state = this.driftClient.getStateAccount();
		let crankMarkets: number[] = [];
		if (intervalGroup === null) {
			crankMarkets = Array.from(
				{ length: state.numberOfMarkets },
				(_, index) => index
			);
			intervalGroup = DEFAULT_INTERVAL_GROUP;
		} else {
			crankMarkets = this.crankIntervalToMarketIds![intervalGroup]!;
		}

		const intervalInProgress = this.crankIntervalInProgress![intervalGroup]!;
		if (intervalInProgress) {
			const startTime = this.crankIntervalStartTime![intervalGroup] || 0;
			const elapsed = Date.now() - startTime;
			const threshold = getStuckThresholdMs(intervalGroup);
			if (startTime > 0 && elapsed > threshold) {
				logger.warn(
					`[${this.name}] Interval ${intervalGroup} appears stuck for ${elapsed}ms (> ${threshold}ms). Forcing reset.`
				);
				this.crankIntervalInProgress![intervalGroup] = false;
				this.crankIntervalStartTime![intervalGroup] = 0;
			} else {
				logger.info(
					`[${this.name}] Interval ${intervalGroup} already in progress, skipping`
				);
				return;
			}
		}

		const start = Date.now();
		let numFeedsSignalingRestart = 0;
		try {
			this.crankIntervalInProgress![intervalGroup] = true;
			this.crankIntervalStartTime![intervalGroup] = Date.now();
			await this.initDlob();

			logger.info(
				`[${this.name}] Cranking interval group ${intervalGroup}: ${crankMarkets}`
			);

			let txsToBundle: VersionedTransaction[] = [];

			const useJitoGlobal = this.sendThroughJito();

			const processMarket = async (
				mi: number,
				forceUseJito: boolean,
				addTipIx: boolean
			): Promise<{ jitoTx?: VersionedTransaction; restartSignal: boolean }> => {
				const mmOraclePriceData =
					this.driftClient.getMMOracleDataForPerpMarket(mi);

				const bidMakers = this.dlob!.getBestMakers({
					marketIndex: mi,
					marketType: MarketType.PERP,
					direction: PositionDirection.LONG,
					slot: this.latestDlobSlot!,
					oraclePriceData: mmOraclePriceData,
					numMakers: NUM_MAKERS_TO_LOOK_AT_FOR_TWAP_CRANK,
				});

				const askMakers = this.dlob!.getBestMakers({
					marketIndex: mi,
					marketType: MarketType.PERP,
					direction: PositionDirection.SHORT,
					slot: this.latestDlobSlot!,
					oraclePriceData: mmOraclePriceData,
					numMakers: NUM_MAKERS_TO_LOOK_AT_FOR_TWAP_CRANK,
				});
				logger.info(
					`[${this.name}] loaded makers for market ${mi}: ${bidMakers.length} bids, ${askMakers.length} asks`
				);

				const usingSwitchboardOnDemand = isVariant(
					this.driftClient.getPerpMarketAccount(mi)!.amm.oracleSource,
					'switchboardOnDemand'
				);

				const ixs = [];
				if (usingSwitchboardOnDemand) {
					const switchboardIx =
						await this.driftClient.getPostManySwitchboardOnDemandUpdatesAtomicIxs(
							[this.driftClient.getPerpMarketAccount(mi)!.amm.oracle],
							undefined,
							askMakers.length + bidMakers.length > 3 ? 2 : 3
						);
					if (switchboardIx) {
						ixs.push(...switchboardIx);
						ixs.push(
							ComputeBudgetProgram.setComputeUnitLimit({
								units: 120_000, // switchboard simulation is unreliable, use hardcoded CU limit
							})
						);
					} else {
						logger.error(
							`[${this.name}] failed to get switchboardIx for market: ${mi}`
						);
					}
				} else {
					ixs.push(
						ComputeBudgetProgram.setComputeUnitLimit({
							units: 1_400_000, // will be overwritten by simulateAndGetTxWithCUs
						})
					);
				}

				// add priority fees if not using jito
				if (!forceUseJito) {
					const pfs = this.priorityFeeSubscriberMap!.getPriorityFees(
						'perp',
						mi
					);
					let microLamports = MIN_PRIORITY_FEE;
					if (pfs) {
						microLamports = Math.floor(
							pfs.low *
								this.driftClient.txSender.getSuggestedPriorityFeeMultiplier()
						);
					}
					const clampedMicroLamports = Math.min(
						microLamports,
						MAX_PRIORITY_FEE
					);
					microLamports = clampedMicroLamports;
					ixs.push(
						ComputeBudgetProgram.setComputeUnitPrice({
							microLamports: isNaN(microLamports)
								? MIN_PRIORITY_FEE
								: microLamports,
						})
					);
				}

				if (
					this.pythLazerSubscriber &&
					isOneOfVariant(
						this.driftClient.getPerpMarketAccount(mi)!.amm.oracleSource,
						['pythLazer', 'pythLazer1K', 'pythLazer1M', 'pythLazerStableCoin']
					)
				) {
					const pythIxs = await this.getPythIxsFromTwapCrankInfo(mi, ixs);
					ixs.push(...pythIxs);
				}

				const concatenatedList = [
					...this.getCombinedList(bidMakers),
					...this.getCombinedList(askMakers),
				];

				ixs.push(
					await this.driftClient.getUpdatePerpBidAskTwapIx(
						mi,
						concatenatedList as [PublicKey, PublicKey][]
					)
				);

				if (
					isVariant(
						this.driftClient.getPerpMarketAccount(mi)!.amm.oracleSource,
						'prelaunch'
					)
				) {
					const updatePrelaunchOracleIx =
						await this.driftClient.getUpdatePrelaunchOracleIx(mi);
					ixs.push(updatePrelaunchOracleIx);
				}

				if (forceUseJito) {
					// first tx in bundle pays the tip
					const jitoSigners = [this.driftClient.wallet.payer];
					if (addTipIx) {
						ixs.push(this.bundleSender!.getTipIx());
					}
					const txToSend = await this.buildTransaction(
						mi,
						ixs,
						!usingSwitchboardOnDemand
					);
					if (txToSend) {
						// @ts-ignore;
						txToSend.sign(jitoSigners);
						return { jitoTx: txToSend, restartSignal: false };
					} else {
						logger.error(`[${this.name}] failed to build tx for market: ${mi}`);
						return { restartSignal: false };
					}
				} else {
					const txToSend = await this.buildTransaction(
						mi,
						ixs,
						!usingSwitchboardOnDemand
					);
					if (txToSend) {
						await this.sendSingleTx(mi, txToSend);
					} else {
						logger.error(`[${this.name}] failed to build tx for market: ${mi}`);
					}
				}
				// logger.info(`[${this.name}] sent tx for market: ${mi}`);

				return { restartSignal: false };
			};

			if (useJitoGlobal) {
				for (const mi of crankMarkets) {
					const { jitoTx, restartSignal } = await processMarket(
						mi,
						true,
						txsToBundle.length === 0
					);
					if (restartSignal) numFeedsSignalingRestart++;
					if (jitoTx) txsToBundle.push(jitoTx);

					if (txsToBundle.length >= TX_PER_JITO_BUNDLE) {
						logger.info(
							`[${this.name}] sending ${txsToBundle.length} txs to jito`
						);
						const bundleChunkResult = await promiseTimeout(
							this.bundleSender!.sendTransactions(
								txsToBundle,
								undefined,
								undefined,
								false
							),
							BUNDLE_SEND_TIMEOUT_MS
						);
						if (bundleChunkResult === null) {
							logger.warn(
								`[${this.name}] bundleSender.sendTransactions timed out after ${BUNDLE_SEND_TIMEOUT_MS}ms (chunk, ${txsToBundle.length} txs)`
							);
						}
						txsToBundle = [];
					}
				}
			} else {
				for (let idx = 0; idx < crankMarkets.length; idx += CONCURRENCY_LIMIT) {
					const batch = crankMarkets.slice(idx, idx + CONCURRENCY_LIMIT);
					const results = await Promise.allSettled(
						batch.map((mi) => processMarket(mi, false, false))
					);
					for (const res of results) {
						if (res.status === 'fulfilled') {
							const value = res.value;
							if (value.restartSignal) {
								numFeedsSignalingRestart++;
							}
						} else {
							logger.error(
								`[${this.name}] error processing market in batch: ${res.reason}`
							);
						}
					}
				}
			}

			// There's a chance that by the time we get here there is no active jito leader, but we
			// already built txs without priority fee, so we skip the leader check and just send
			// the bundle anyways to increase overall land rate.
			if (this.bundleSender && txsToBundle.length > 0) {
				logger.info(
					`[${this.name}] sending remaining ${txsToBundle.length} txs to jito`
				);
				const bundleResult = await promiseTimeout(
					this.bundleSender!.sendTransactions(
						txsToBundle,
						undefined,
						undefined,
						false
					),
					BUNDLE_SEND_TIMEOUT_MS
				);
				if (bundleResult === null) {
					logger.warn(
						`[${this.name}] bundleSender.sendTransactions timed out after ${BUNDLE_SEND_TIMEOUT_MS}ms (final flush, ${txsToBundle.length} txs)`
					);
				}
			}
		} catch (e) {
			console.error(e);
			if (e instanceof Error) {
				await webhookMessage(
					`[${this.name}]: :x: uncaught error:\n${
						e.stack ? e.stack : e.message
					}`
				);
			}
		} finally {
			this.crankIntervalInProgress![intervalGroup] = false;
			this.crankIntervalStartTime![intervalGroup] = 0;
			logger.info(
				`[${
					this.name
				}] tryTwapCrank finished for interval group ${intervalGroup}, took ${
					Date.now() - start
				}ms`
			);
			await this.watchdogTimerMutex.runExclusive(async () => {
				this.watchdogTimerLastPatTime = Date.now();
			});
			if (
				numFeedsSignalingRestart > 2 &&
				this.driftClient.txSender.getTxLandRate() > TX_LAND_RATE_THRESHOLD
			) {
				logger.info(
					`[${
						this.name
					}] ${numFeedsSignalingRestart} feeds signaling restart, tx land rate: ${this.driftClient.txSender.getTxLandRate()}`
				);
				await webhookMessage(
					`[${
						this.name
					}] ${numFeedsSignalingRestart} feeds signaling restart, tx land rate: ${this.driftClient.txSender.getTxLandRate()}`
				);
				this.pythHealthy = false;
			}
		}
	}
}
