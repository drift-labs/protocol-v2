import {
	BN,
	DriftClient,
	UserAccount,
	PublicKey,
	PerpMarketAccount,
	calculateClaimablePnl,
	QUOTE_PRECISION,
	UserMap,
	ZERO,
	calculateNetUserPnlImbalance,
	convertToNumber,
	TxSigAndSlot,
	getTokenAmount,
	SpotBalanceType,
	calculateNetUserPnl,
	QUOTE_SPOT_MARKET_INDEX,
	isOperationPaused,
	PerpOperation,
	DriftMarketInfo,
	User,
	PerpPosition,
	MarketStatus,
	PriorityFeeSubscriber,
	isOneOfVariant,
	getVariant,
	calculateUnsettledFundingPnl,
	BlockhashSubscriber,
	RevenueShareEscrowMap,
	isBuilderOrderCompleted,
	getUserAccountPublicKeySync,
	SettlePnlMode,
} from '@drift-labs/sdk';
import { Mutex } from 'async-mutex';

import { getErrorCode } from '../error';
import { logger } from '../logger';
import { Bot } from '../types';
import { webhookMessage } from '../webhook';
import { GlobalConfig, UserPnlSettlerConfig } from '../config';
import {
	decodeName,
	handleSimResultError,
	simulateAndGetTxWithCUs,
	sleepMs,
} from '../utils';
import {
	AddressLookupTableAccount,
	ComputeBudgetProgram,
	SendTransactionError,
	TransactionExpiredBlockheightExceededError,
	TransactionInstruction,
} from '@solana/web3.js';
import { ENUM_UTILS } from '@drift-labs/common';

// =============================================================================
// CONSTANTS
// =============================================================================

const SETTLE_USER_CHUNKS = 4;
const SETTLE_FUNDING_USER_CHUNKS = 10;
const SLEEP_MS = 500;
const CU_EST_MULTIPLIER = 1.25;

const FILTER_FOR_MARKET = undefined; // undefined;

const EMPTY_USER_SETTLE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour (after initial delay)
const POSITIVE_PNL_SETTLE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour (after initial delay)
const ALL_NEGATIVE_PNL_SETTLE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour (after initial delay)
const FUNDING_SETTLE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour (after initial delay)
const MIN_MARGIN_RATIO_FOR_POSITIVE_PNL = 0.1; // 10% of account value

const errorCodesToSuppress = [
	6010, // Error Code: UserHasNoPositionInMarket. Error Number: 6010. Error Message: User Has No Position In Market.
	6035, // Error Code: InvalidOracle. Error Number: 6035. Error Message: InvalidOracle.
	6078, // Error Code: PerpMarketNotFound. Error Number: 6078. Error Message: PerpMarketNotFound.
	6095, // Error Code: InsufficientCollateralForSettlingPNL. Error Number: 6095. Error Message: InsufficientCollateralForSettlingPNL.
	6259, // Error Code: NoUnsettledPnl. Error Number: 6259. Error Message: NoUnsettledPnl.
];

// =============================================================================
// TYPES
// =============================================================================

interface UserToSettle {
	settleeUserAccountPublicKey: PublicKey;
	settleeUserAccount: UserAccount;
	pnl: number;
}

type IxsBuilder = (
	users: UserToSettle[],
	marketIndex: number
) => Promise<TransactionInstruction[]>;

// =============================================================================
// MAIN CLASS
// =============================================================================

export class UserPnlSettlerBot implements Bot {
	public readonly name: string;
	public readonly dryRun: boolean;
	public readonly runOnce: boolean;
	public readonly defaultIntervalMs: number = 5 * 60 * 1000;

	// =============================================================================
	// DEPENDENCIES
	// =============================================================================

	private driftClient: DriftClient;
	private blockhashSubscriber: BlockhashSubscriber;
	private globalConfig: GlobalConfig;
	private lookupTableAccounts?: AddressLookupTableAccount[];
	private userMap: UserMap;
	private priorityFeeSubscriber?: PriorityFeeSubscriber;
	private revenueShareEscrowMap?: RevenueShareEscrowMap;

	// =============================================================================
	// CONFIGURATION
	// =============================================================================

	private marketIndexes: Array<number>;
	private minPnlToSettle: BN;
	private maxUsersToConsider: number;

	// =============================================================================
	// STATE MANAGEMENT
	// =============================================================================

	private intervalIds: Array<NodeJS.Timer> = [];
	private timeoutIds: Array<NodeJS.Timeout> = [];
	private watchdogTimerMutex = new Mutex();
	private watchdogTimerLastPatTime = Date.now();

	// =============================================================================
	// CONSTRUCTOR & LIFECYCLE
	// =============================================================================

	constructor(
		driftClient: DriftClient,
		priorityFeeSubscriber: PriorityFeeSubscriber,
		config: UserPnlSettlerConfig,
		globalConfig: GlobalConfig
	) {
		this.name = config.botId;
		this.dryRun = config.dryRun;
		this.runOnce = config.runOnce || false;
		this.marketIndexes = config.perpMarketIndicies ?? [];
		this.minPnlToSettle = new BN(
			Math.abs(Number(config.settlePnlThresholdUsdc) ?? 10) * -1
		).mul(QUOTE_PRECISION);
		this.maxUsersToConsider = Number(config.maxUsersToConsider) ?? 50;
		this.globalConfig = globalConfig;

		this.driftClient = driftClient;
		this.priorityFeeSubscriber = priorityFeeSubscriber;
		this.blockhashSubscriber = new BlockhashSubscriber({
			connection: driftClient.connection,
		});
		this.userMap = new UserMap({
			driftClient: this.driftClient,
			subscriptionConfig: {
				type: 'polling',
				frequency: 60_000,
				commitment: this.driftClient.opts?.commitment,
			},
			skipInitialLoad: false,
			includeIdle: false,
		});
		this.revenueShareEscrowMap = new RevenueShareEscrowMap(
			this.driftClient,
			true
		);
	}

	public async init() {
		logger.info(`${this.name} initing`);

		const driftMarkets: DriftMarketInfo[] = [];
		for (const perpMarket of this.driftClient.getPerpMarketAccounts()) {
			driftMarkets.push({
				marketType: 'perp',
				marketIndex: perpMarket.marketIndex,
			});
		}

		await this.priorityFeeSubscriber!.subscribe();
		await this.driftClient.subscribe();
		await this.blockhashSubscriber.subscribe();

		const start0 = Date.now();
		await this.userMap.subscribe();
		logger.info(`Subscribed to UserMap in ${Date.now() - start0}ms`);
		const start1 = Date.now();
		await this.revenueShareEscrowMap!.subscribe();
		logger.info(
			`Subscribed to RevenueShareEscrowMap in ${Date.now() - start1}ms`
		);

		this.lookupTableAccounts =
			await this.driftClient.fetchAllLookupTableAccounts();

		logger.info(`${this.name} init'd!`);
	}

	public async reset() {
		for (const intervalId of this.intervalIds) {
			clearInterval(intervalId as NodeJS.Timeout);
		}
		this.intervalIds = [];

		for (const timeoutId of this.timeoutIds) {
			clearTimeout(timeoutId);
		}
		this.timeoutIds = [];

		await this.priorityFeeSubscriber!.unsubscribe();
		await this.userMap?.unsubscribe();
		await this.blockhashSubscriber.unsubscribe();
	}

	public async startIntervalLoop(intervalMs?: number): Promise<void> {
		logger.info(`${this.name} Bot started!`);
		const negativeInterval = intervalMs || this.defaultIntervalMs;

		if (this.runOnce) {
			logger.info('Running once mode - executing all settlement types');
			await this.trySettleNegativePnl();
			await this.trySettleAllNegativePnl();
			await this.trySettleUsersWithNoPositions();
			await this.trySettlePositivePnlForLowMargin();
			await this.trySettleFundingForMarketThenUsers();
			await this.trySettleBuilderFees();
		} else {
			// Initial settlement on startup - only settle negative PnL
			await this.trySettleNegativePnl();

			// Set up intervals
			// Top 10 largest negative PnL users every 5 minutes
			this.intervalIds.push(
				setInterval(this.trySettleNegativePnl.bind(this), negativeInterval)
			);

			// Calculate delay until next hour's 1st minute for hourly tasks
			const delayUntilNextHourFirstMinute =
				this.getMillisecondsUntilNextHourFirstMinute();
			const nextRunTime = new Date(Date.now() + delayUntilNextHourFirstMinute);
			logger.info(
				`Hourly settlement tasks will start at ${nextRunTime.toISOString()} (in ${Math.round(
					delayUntilNextHourFirstMinute / 1000
				)}s)`
			);

			// Comprehensive negative PnL settlement - start at next hour's 1st minute, then every hour
			this.timeoutIds.push(
				setTimeout(() => {
					this.trySettleAllNegativePnl();
					this.intervalIds.push(
						setInterval(
							this.trySettleAllNegativePnl.bind(this),
							ALL_NEGATIVE_PNL_SETTLE_INTERVAL_MS
						)
					);
				}, delayUntilNextHourFirstMinute)
			);

			// Users with no positions - start at next hour's 1st minute, then every hour
			this.timeoutIds.push(
				setTimeout(() => {
					this.trySettleUsersWithNoPositions();
					this.intervalIds.push(
						setInterval(
							this.trySettleUsersWithNoPositions.bind(this),
							EMPTY_USER_SETTLE_INTERVAL_MS
						)
					);
				}, delayUntilNextHourFirstMinute)
			);

			// Positive PnL settlement for low margin users - start at next hour's 1st minute, then every hour
			this.timeoutIds.push(
				setTimeout(() => {
					this.trySettlePositivePnlForLowMargin();
					this.intervalIds.push(
						setInterval(
							this.trySettlePositivePnlForLowMargin.bind(this),
							POSITIVE_PNL_SETTLE_INTERVAL_MS
						)
					);
				}, delayUntilNextHourFirstMinute)
			);

			// Funding settlement for markets and users - start at next hour's 1st minute, then every hour
			this.timeoutIds.push(
				setTimeout(() => {
					this.trySettleFundingForMarketThenUsers();
					this.intervalIds.push(
						setInterval(
							this.trySettleFundingForMarketThenUsers.bind(this),
							FUNDING_SETTLE_INTERVAL_MS
						)
					);
				}, delayUntilNextHourFirstMinute)
			);

			// Builder fees - Run around when funding runs
			this.timeoutIds.push(
				setTimeout(() => {
					this.trySettleBuilderFees();
					this.intervalIds.push(
						setInterval(
							this.trySettleBuilderFees.bind(this),
							FUNDING_SETTLE_INTERVAL_MS
						)
					);
				}, delayUntilNextHourFirstMinute)
			);
		}
	}

	public async healthCheck(): Promise<boolean> {
		let healthy = false;
		await this.watchdogTimerMutex.runExclusive(async () => {
			healthy =
				this.watchdogTimerLastPatTime > Date.now() - 2 * this.defaultIntervalMs;
		});
		return healthy;
	}

	// =============================================================================
	// MAIN SETTLEMENT ORCHESTRATION
	// =============================================================================

	private async trySettleNegativePnl() {
		const start = Date.now();
		try {
			logger.info('Starting top 10 negative PnL settlement...');
			await this.settleLargestNegativePnl();
		} catch (err) {
			this.handleSettlementError(err, 'trySettleNegativePnl');
		} finally {
			logger.info(
				`Top 10 negative PnL settlement finished in ${Date.now() - start}ms`
			);
			await this.updateWatchdogTimer();
		}
	}

	private async trySettlePositivePnlForLowMargin() {
		const start = Date.now();
		try {
			logger.info('Starting positive PnL settlement for low margin users...');
			await this.settlePnl({ positiveOnly: true, requireLowMargin: true });
		} catch (err) {
			this.handleSettlementError(err, 'trySettlePositivePnlForLowMargin');
		} finally {
			logger.info(
				`Settle positive PNLs for low margin finished in ${
					Date.now() - start
				}ms`
			);
			await this.updateWatchdogTimer();
		}
	}

	private async trySettleAllNegativePnl() {
		const start = Date.now();
		try {
			logger.info('Starting comprehensive negative PnL settlement...');
			await this.settlePnl({ positiveOnly: false });
		} catch (err) {
			this.handleSettlementError(err, 'trySettleAllNegativePnl');
		} finally {
			logger.info(
				`Settle all negative PNLs finished in ${Date.now() - start}ms`
			);
			await this.updateWatchdogTimer();
		}
	}

	private async trySettleUsersWithNoPositions() {
		try {
			const usersToSettleMap = await this.findUsersWithNoPositions();

			if (usersToSettleMap.size === 0) {
				logger.info('[trySettleUsersWithNoPositions] No users to settle');
				return;
			}

			await this.processUserSettlements(
				usersToSettleMap,
				'[trySettleUsersWithNoPositions]'
			);
		} catch (err) {
			this.handleSettlementError(err, 'trySettleUsersWithNoPositions');
		}
	}

	private async trySettleBuilderFees() {
		try {
			await this.trySettleBuilderFeesForUsers();
		} catch (err) {
			this.handleSettlementError(err, 'trySettleBuilderFees');
		}
	}

	private async trySettleBuilderFeesForUsers() {
		const logPrefix = '[trySettleBuilderFeesForUsers]';
		const start = Date.now();
		await this.revenueShareEscrowMap!.sync();
		logger.info(
			`${logPrefix} Synced revenue share escrow map in ${
				Date.now() - start
			}ms, found ${this.revenueShareEscrowMap!.size()} escrows`
		);

		// Group by user and accumulate market indexes with sweepable builder fees
		const usersByAuthority: Map<
			string,
			{
				settleeUserAccountPublicKey: PublicKey;
				settleeUserAccount: UserAccount;
				marketIndexes: Set<number>;
			}
		> = new Map();
		for (const escrow of this.revenueShareEscrowMap!.getAll().values()) {
			const sweepableFees = escrow.orders.filter(
				(order) => isBuilderOrderCompleted(order) && order.feesAccrued.gt(ZERO)
			);
			for (const order of sweepableFees) {
				logger.info(
					`${logPrefix} ${escrow.authority.toBase58()} has sweepable fees for order in market: ${
						order.marketIndex
					}: ${order.feesAccrued.toString()}`
				);
				// sweeping builder feees doesn't require a user account, but we need one that exists, so just use the last one
				// set in the RevenueShareOrder.
				const user = getUserAccountPublicKeySync(
					this.driftClient.program.programId,
					escrow.authority,
					order.subAccountId
				);
				const userKey = user.toBase58();
				if (!usersByAuthority.has(userKey)) {
					usersByAuthority.set(userKey, {
						settleeUserAccountPublicKey: user,
						settleeUserAccount: this.userMap!.get(userKey)!.getUserAccount(),
						marketIndexes: new Set<number>(),
					});
				}
				usersByAuthority.get(userKey)!.marketIndexes.add(order.marketIndex);
			}
		}

		await this.processBuilderFeeSettlements(usersByAuthority, logPrefix);
	}

	private async processBuilderFeeSettlements(
		usersByAuthority: Map<
			string,
			{
				settleeUserAccountPublicKey: PublicKey;
				settleeUserAccount: UserAccount;
				marketIndexes: Set<number>;
			}
		>,
		logPrefix = ''
	) {
		const MAX_MARKETS_PER_IX = 4;
		for (const [
			userKey,
			{ settleeUserAccountPublicKey, settleeUserAccount, marketIndexes },
		] of usersByAuthority) {
			const markets = Array.from(new Set(Array.from(marketIndexes)));
			if (markets.length === 0) {
				continue;
			}

			logger.info(
				`${logPrefix} TRY_SETTLE builder fees for user ${userKey} across ${
					markets.length
				} markets: [${markets.join(', ')}]`
			);

			for (let i = 0; i < markets.length; i += MAX_MARKETS_PER_IX) {
				const marketChunk = markets.slice(i, i + MAX_MARKETS_PER_IX);
				await this.trySendBuilderSettleForMarketChunk(
					userKey,
					settleeUserAccountPublicKey,
					settleeUserAccount,
					marketChunk,
					logPrefix
				);
			}
		}
	}

	private async trySendBuilderSettleForMarketChunk(
		userKey: string,
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketChunk: number[],
		logPrefix: string
	): Promise<void> {
		const success = await this.sendBuilderSettleForMarketChunk(
			userKey,
			settleeUserAccountPublicKey,
			settleeUserAccount,
			marketChunk,
			logPrefix
		);
		if (!success) {
			const slice = Math.floor(marketChunk.length / 2);
			if (slice < 1) {
				return;
			}
			const slice0 = marketChunk.slice(0, slice);
			const slice1 = marketChunk.slice(slice);
			logger.info(
				`${logPrefix} (builderSettle) Chunk failed for user ${userKey}: [${marketChunk.join(
					', '
				)}], retrying with\nslice0: [${slice0.join(
					', '
				)}]\nslice1: [${slice1.join(', ')}]`
			);
			await sleepMs(SLEEP_MS);
			await this.sendBuilderSettleForMarketChunk(
				userKey,
				settleeUserAccountPublicKey,
				settleeUserAccount,
				slice0,
				logPrefix
			);
			await sleepMs(SLEEP_MS);
			await this.sendBuilderSettleForMarketChunk(
				userKey,
				settleeUserAccountPublicKey,
				settleeUserAccount,
				slice1,
				logPrefix
			);
		}
		await sleepMs(SLEEP_MS);
	}

	private async sendBuilderSettleForMarketChunk(
		userKey: string,
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketChunk: number[],
		logPrefix: string
	): Promise<boolean> {
		if (marketChunk.length === 0) {
			return true;
		}
		let success = false;
		try {
			const pfs = this.priorityFeeSubscriber!.getAvgStrategyResult();
			let microLamports = 10_000;
			if (pfs) {
				microLamports = Math.floor(pfs);
			}
			const computeUnits = Math.min(300_000 * marketChunk.length, 1_400_000);

			const ixs: TransactionInstruction[] = [
				ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
				ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
				await this.driftClient.settleMultiplePNLsIx(
					settleeUserAccountPublicKey,
					settleeUserAccount,
					marketChunk,
					SettlePnlMode.TRY_SETTLE,
					undefined,
					this.revenueShareEscrowMap
				),
			];

			const recentBlockhash = this.blockhashSubscriber.getLatestBlockhash(5);
			if (!recentBlockhash) {
				logger.error(
					`${logPrefix} (builderSettle) No recent blockhash found for user ${userKey} markets: [${marketChunk.join(
						', '
					)}]`
				);
				throw new Error('No recent blockhash found');
			}

			const simResult = await simulateAndGetTxWithCUs({
				ixs,
				connection: this.driftClient.connection,
				payerPublicKey: this.driftClient.wallet.publicKey,
				lookupTableAccounts: this.lookupTableAccounts!,
				cuLimitMultiplier: CU_EST_MULTIPLIER,
				doSimulation: true,
				recentBlockhash: recentBlockhash.blockhash,
			});
			if (simResult.simError !== null) {
				logger.error(
					`${logPrefix} (builderSettle) Sim error for user ${userKey} markets [${marketChunk.join(
						', '
					)}]: ${JSON.stringify(simResult.simError)}\n${
						simResult.simTxLogs ? simResult.simTxLogs.join('\n') : ''
					}`
				);
				handleSimResultError(
					simResult,
					errorCodesToSuppress,
					'(builderSettle)'
				);
				success = false;
			} else {
				if (this.dryRun) {
					logger.info(
						`[DRY RUN] ${logPrefix} (builderSettle) Would settle for user ${userKey} markets [${marketChunk.join(
							', '
						)}]`
					);
					success = true;
				} else {
					const sendTxStart = Date.now();
					const txSig =
						await this.driftClient.txSender.sendVersionedTransaction(
							simResult.tx,
							[],
							this.driftClient.opts
						);
					logger.info(
						`${logPrefix} (builderSettle) TRY_SETTLE for user ${userKey} markets [${marketChunk.join(
							', '
						)}] in ${Date.now() - sendTxStart}ms: https://solana.fm/tx/${
							txSig.txSig
						}`
					);
					success = true;
				}
			}
		} catch (err) {
			this.handleSettlementError(err, 'sendBuilderSettleForMarketChunk');
		}
		return success;
	}

	private async trySettleFundingForMarketThenUsers() {
		try {
			await this.trySettleFundingForMarkets();
			await this.trySettleFundingForUsers();
		} catch (err) {
			this.handleSettlementError(err, 'trySettleFundingForMarketThenUsers');
		}
	}

	private async trySettleFundingForMarkets() {
		const logPrefix = '[trySettleFundingForMarkets]';
		try {
			const perpMarketAndOracleData: {
				[marketIndex: number]: {
					marketAccount: PerpMarketAccount;
				};
			} = {};

			for (const marketAccount of this.driftClient.getPerpMarketAccounts()) {
				perpMarketAndOracleData[marketAccount.marketIndex] = {
					marketAccount,
				};
			}

			for (const marketAccount of this.driftClient.getPerpMarketAccounts()) {
				const perpMarket =
					perpMarketAndOracleData[marketAccount.marketIndex].marketAccount;
				if (isOneOfVariant(perpMarket.status, ['initialized'])) {
					logger.info(
						`${logPrefix} Skipping perp market ${
							perpMarket.marketIndex
						} because market status = ${getVariant(perpMarket.status)}`
					);
					continue;
				}

				const fundingPaused = isOperationPaused(
					perpMarket.pausedOperations,
					PerpOperation.UPDATE_FUNDING
				);
				if (fundingPaused) {
					const marketStr = decodeName(perpMarket.name);
					logger.warn(
						`${logPrefix} Update funding paused for market: ${perpMarket.marketIndex} ${marketStr}, skipping`
					);
					continue;
				}

				if (perpMarket.amm.fundingPeriod.eq(ZERO)) {
					continue;
				}
				const currentTs = Date.now() / 1000;

				const timeRemainingTilUpdate = this.getTimeUntilNextFundingUpdate(
					currentTs,
					perpMarket.amm.lastFundingRateTs.toNumber(),
					perpMarket.amm.fundingPeriod.toNumber()
				);
				logger.info(
					`${logPrefix} Perp market ${perpMarket.marketIndex} timeRemainingTilUpdate=${timeRemainingTilUpdate}`
				);
				if ((timeRemainingTilUpdate as number) <= 0) {
					logger.info(
						`${logPrefix} Perp market ${
							perpMarket.marketIndex
						} lastFundingRateTs: ${perpMarket.amm.lastFundingRateTs.toString()}, fundingPeriod: ${perpMarket.amm.fundingPeriod.toString()}, lastFunding+Period: ${perpMarket.amm.lastFundingRateTs
							.add(perpMarket.amm.fundingPeriod)
							.toString()} vs. currTs: ${currentTs.toString()}`
					);
					try {
						const pfs = this.priorityFeeSubscriber!.getAvgStrategyResult();
						let microLamports = 10_000;
						if (pfs) {
							microLamports = Math.floor(pfs);
						}

						const ixs = [
							ComputeBudgetProgram.setComputeUnitLimit({
								units: 1_400_000, // simulateAndGetTxWithCUs will overwrite
							}),
							ComputeBudgetProgram.setComputeUnitPrice({
								microLamports,
							}),
						];

						if (
							isOneOfVariant(perpMarket.amm.oracleSource, [
								'switchboardOnDemand',
							])
						) {
							const crankIx =
								await this.driftClient.getPostSwitchboardOnDemandUpdateAtomicIx(
									perpMarket.amm.oracle
								);
							if (crankIx) {
								ixs.push(crankIx);
							}
						}

						ixs.push(
							await this.driftClient.getUpdateFundingRateIx(
								perpMarket.marketIndex,
								perpMarket.amm.oracle
							)
						);

						const recentBlockhash =
							this.blockhashSubscriber.getLatestBlockhash(5);
						if (!recentBlockhash) {
							logger.error(
								`${logPrefix} No recent blockhash found for market: ${perpMarket.marketIndex}`
							);
							throw new Error('No recent blockhash found');
						}
						const simResult = await simulateAndGetTxWithCUs({
							ixs,
							connection: this.driftClient.connection,
							payerPublicKey: this.driftClient.wallet.publicKey,
							lookupTableAccounts: this.lookupTableAccounts!,
							cuLimitMultiplier: CU_EST_MULTIPLIER,
							doSimulation: true,
							recentBlockhash: recentBlockhash?.blockhash,
						});
						logger.info(
							`${logPrefix} UpdateFundingRate estimated ${simResult.cuEstimate} CUs for market: ${perpMarket.marketIndex}`
						);

						if (simResult.simError !== null) {
							logger.error(
								`${logPrefix} Sim error on market: ${
									perpMarket.marketIndex
								}, ${JSON.stringify(simResult.simError)}\n${
									simResult.simTxLogs ? simResult.simTxLogs.join('\n') : ''
								}`
							);
							handleSimResultError(
								simResult,
								errorCodesToSuppress,
								`(updateFundingRate)`
							);
							continue;
						}

						if (this.dryRun) {
							logger.info(
								`[DRY RUN] ${logPrefix} Would update funding rate for market: ${perpMarket.marketIndex}`
							);
						} else {
							const sendTxStart = Date.now();
							const txSig =
								await this.driftClient.txSender.sendVersionedTransaction(
									simResult.tx,
									[],
									this.driftClient.opts
								);
							logger.info(
								`${logPrefix} UpdateFundingRate for market: ${
									perpMarket.marketIndex
								}, tx sent in ${
									Date.now() - sendTxStart
								}ms: https://solana.fm/tx/${txSig.txSig}`
							);
						}
					} catch (err) {
						this.handleSettlementError(err, 'trySettleFundingForMarkets.send');
					}
				}
			}
		} catch (err) {
			this.handleSettlementError(err, 'trySettleFundingForMarkets');
		}
	}

	private async trySettleFundingForUsers() {
		const logPrefix = '[trySettleFundingForUsers]';
		try {
			const usersToSettle = await this.findUsersWithUnsettledFunding();
			logger.info(
				`${logPrefix} Found ${usersToSettle.length} users with unsettled funding`
			);
			await this.processUserFundingSettlements(usersToSettle, logPrefix);
		} catch (err) {
			this.handleSettlementError(err, 'trySettleFundingForUsers');
		}
	}

	// =============================================================================
	// PNL SETTLEMENT LOGIC
	// =============================================================================

	private async settlePnl(options: {
		positiveOnly: boolean;
		requireLowMargin?: boolean;
	}) {
		const usersToSettleMap = await this.findUsersToSettle(options);
		await this.processUserSettlements(usersToSettleMap);
	}

	private async settleLargestNegativePnl() {
		const nowTs = Date.now() / 1000;
		const usersToSettleMap = await this.findLargestNegativePnlUsersToSettle(
			nowTs
		);
		await this.processUserSettlements(
			usersToSettleMap,
			'[settleLargestNegativePnl]'
		);
	}

	private async findUsersToSettle(options: {
		positiveOnly: boolean;
		requireLowMargin?: boolean;
	}): Promise<Map<number, UserToSettle[]>> {
		const usersToSettleMap: Map<number, UserToSettle[]> = new Map();
		const nowTs = Date.now() / 1000;

		for (const user of this.userMap!.values()) {
			const userAccount = user.getUserAccount();
			if (userAccount.poolId !== 0) {
				continue;
			}

			// Check margin requirement for positive PnL settlement
			if (options.requireLowMargin && options.positiveOnly) {
				const userFreeMarginCurrent =
					user.getFreeCollateral('Initial').toNumber() /
					QUOTE_PRECISION.toNumber();
				const userAccountValue = user.getNetUsdValue().toNumber() / 1e6;

				// Only settle if user's free margin is less than 10% of account value
				if (
					userFreeMarginCurrent >=
					userAccountValue * MIN_MARGIN_RATIO_FOR_POSITIVE_PNL
				) {
					continue;
				}
			}

			for (const settleePosition of user.getActivePerpPositions()) {
				const settlementDecision = await this.shouldSettleUserPosition(
					user,
					settleePosition,
					nowTs,
					options
				);

				if (settlementDecision.shouldSettle) {
					const userData: UserToSettle = {
						settleeUserAccountPublicKey: user.getUserAccountPublicKey(),
						settleeUserAccount: userAccount,
						pnl: settlementDecision.pnl!,
					};

					if (usersToSettleMap.has(settleePosition.marketIndex)) {
						const existingData = usersToSettleMap.get(
							settleePosition.marketIndex
						)!;
						existingData.push(userData);
					} else {
						usersToSettleMap.set(settleePosition.marketIndex, [userData]);
					}
				}
			}
		}

		return usersToSettleMap;
	}

	private async findLargestNegativePnlUsersToSettle(
		nowTs: number
	): Promise<Map<number, UserToSettle[]>> {
		// Collect all potential negative PnL candidates by market
		const candidatesByMarket: Map<number, UserToSettle[]> = new Map();

		const totalUsers = this.userMap!.size();
		let candidatesFound = 0;

		logger.info(
			`[findLargestNegativePnlUsersToSettle] Processing ${totalUsers} users from userMap`
		);

		for (const user of this.userMap!.values()) {
			const userAccount = user.getUserAccount();
			if (userAccount.poolId !== 0) {
				continue;
			}

			const activePerpPositions = user.getActivePerpPositions();

			for (const settleePosition of activePerpPositions) {
				// Early PnL check to avoid processing positive PnL users
				const perpMarketIdx = settleePosition.marketIndex;
				const perpMarket =
					this.driftClient.getPerpMarketAccount(perpMarketIdx)!;
				const spotMarketIdx = QUOTE_SPOT_MARKET_INDEX;
				const spotMarket = this.driftClient.getSpotMarketAccount(spotMarketIdx);
				if (!spotMarket) {
					logger.warn(
						`Spot market ${spotMarketIdx} not found, skipping user ${user
							.getUserAccountPublicKey()
							.toBase58()}`
					);
					continue;
				}
				const oraclePriceData =
					this.driftClient.getOracleDataForPerpMarket(perpMarketIdx);

				const userUnsettledPnl = calculateClaimablePnl(
					perpMarket,
					spotMarket,
					settleePosition,
					oraclePriceData
				);

				// Skip positive PnL users early
				if (userUnsettledPnl.gt(ZERO)) {
					continue;
				}

				const settlementDecision = await this.shouldSettleUserPosition(
					user,
					settleePosition,
					nowTs,
					{ positiveOnly: false }
				);

				if (settlementDecision.shouldSettle) {
					candidatesFound++;
					const userData: UserToSettle = {
						settleeUserAccountPublicKey: user.getUserAccountPublicKey(),
						settleeUserAccount: userAccount,
						pnl: settlementDecision.pnl!,
					};

					if (!candidatesByMarket.has(settleePosition.marketIndex)) {
						candidatesByMarket.set(settleePosition.marketIndex, []);
					}
					candidatesByMarket.get(settleePosition.marketIndex)!.push(userData);
				}
			}
		}

		logger.info(
			`[findLargestNegativePnlUsersToSettle] Found ${candidatesFound} candidates across ${candidatesByMarket.size} markets`
		);

		// Sort and select top 10 most negative PnL users per market
		const usersToSettleMap: Map<number, UserToSettle[]> = new Map();

		for (const [marketIndex, candidates] of candidatesByMarket) {
			// Sort by PnL ascending (most negative first)
			const sortedCandidates = candidates
				.sort((a, b) => a.pnl - b.pnl)
				.slice(0, 10); // Take top 10 most negative

			if (sortedCandidates.length > 0) {
				logger.info(
					`Market ${marketIndex}: Settling top ${
						sortedCandidates.length
					} users with PnLs: [${sortedCandidates
						.map((u) => `$${u.pnl.toFixed(2)}`)
						.join(', ')}] in market ${marketIndex}`
				);

				usersToSettleMap.set(marketIndex, sortedCandidates);
			}
		}

		return usersToSettleMap;
	}

	private async shouldSettleUserPosition(
		user: User,
		settleePosition: PerpPosition,
		nowTs: number,
		options: { positiveOnly: boolean; requireLowMargin?: boolean }
	): Promise<{ shouldSettle: boolean; pnl?: number }> {
		const userAccKeyStr = user.getUserAccountPublicKey().toBase58();

		// Check market filter
		if (
			this.marketIndexes.length > 0 &&
			!this.marketIndexes.includes(settleePosition.marketIndex)
		) {
			return { shouldSettle: false };
		}

		// Check if position has activity
		if (
			settleePosition.quoteAssetAmount.gte(ZERO) &&
			settleePosition.baseAssetAmount.eq(ZERO) &&
			settleePosition.lpShares.eq(ZERO)
		) {
			return { shouldSettle: false };
		}

		const perpMarketIdx = settleePosition.marketIndex;
		const perpMarket = this.driftClient.getPerpMarketAccount(perpMarketIdx)!;
		const spotMarketIdx = QUOTE_SPOT_MARKET_INDEX;

		// Check if settlement is paused
		const settlePnlWithPositionPaused = isOperationPaused(
			perpMarket.pausedOperations,
			PerpOperation.SETTLE_PNL_WITH_POSITION
		);

		if (
			settlePnlWithPositionPaused &&
			!settleePosition.baseAssetAmount.eq(ZERO)
		) {
			return { shouldSettle: false };
		}

		// Get fresh market and oracle data
		const spotMarket = this.driftClient.getSpotMarketAccount(spotMarketIdx);
		if (!spotMarket) {
			logger.warn(
				`Spot market ${spotMarketIdx} not found, cannot settle user ${userAccKeyStr}`
			);
			return { shouldSettle: false };
		}
		const oraclePriceData =
			this.driftClient.getOracleDataForPerpMarket(perpMarketIdx);

		const userUnsettledPnl = calculateClaimablePnl(
			perpMarket,
			spotMarket,
			settleePosition,
			oraclePriceData
		);

		// Apply PnL filtering based on options
		if (options.positiveOnly) {
			if (userUnsettledPnl.lte(ZERO)) {
				return { shouldSettle: false };
			}
			// For positive PnL, check if we can settle it
			const canSettlePositivePnl = await this.canSettlePositivePnl(
				user,
				userUnsettledPnl,
				perpMarketIdx,
				spotMarketIdx
			);
			if (!canSettlePositivePnl) {
				return { shouldSettle: false };
			}
		} else {
			// For negative PnL settlement, apply existing logic
			const hasZeroPnl = userUnsettledPnl.eq(ZERO);

			// Skip users with zero PnL and no LP shares - these don't need settlement
			if (hasZeroPnl) {
				return { shouldSettle: false };
			}

			// skip if positive orbelow minPnlToSettle
			if (
				userUnsettledPnl.abs().lt(this.minPnlToSettle.abs()) ||
				userUnsettledPnl.gt(ZERO)
			) {
				return { shouldSettle: false };
			}
		}

		return {
			shouldSettle: true,
			pnl: convertToNumber(userUnsettledPnl, QUOTE_PRECISION),
		};
	}

	private async canSettlePositivePnl(
		user: any,
		userUnsettledPnl: BN,
		perpMarketIdx: number,
		spotMarketIdx: number
	): Promise<boolean> {
		const perpMarket = this.driftClient.getPerpMarketAccount(perpMarketIdx)!;
		const oraclePriceData =
			this.driftClient.getOracleDataForPerpMarket(perpMarketIdx);

		const pnlPool = perpMarket.pnlPool;
		const pnlPoolSpotMarket = this.driftClient.getSpotMarketAccount(
			pnlPool.marketIndex
		);
		if (!pnlPoolSpotMarket) {
			logger.warn(
				`Spot market ${pnlPool.marketIndex} not found for PnL pool, skipping positive PnL settlement check`
			);
			return false;
		}
		const pnlPoolTokenAmount = getTokenAmount(
			pnlPool.scaledBalance,
			pnlPoolSpotMarket,
			SpotBalanceType.DEPOSIT
		);

		const pnlToSettleWithUser = BN.min(userUnsettledPnl, pnlPoolTokenAmount);
		if (pnlToSettleWithUser.lte(ZERO)) {
			return false;
		}

		const netUserPnl = calculateNetUserPnl(perpMarket, oraclePriceData);

		let maxPnlPoolExcess = ZERO;
		if (netUserPnl.lt(pnlPoolTokenAmount)) {
			maxPnlPoolExcess = pnlPoolTokenAmount.sub(BN.max(netUserPnl, ZERO));
		}

		// we're only allowed to settle positive pnl if pnl pool is in excess
		if (maxPnlPoolExcess.lte(ZERO)) {
			logger.warn(
				`Want to settle positive PnL for user ${user
					.getUserAccountPublicKey()
					.toBase58()} in market ${perpMarketIdx}, but maxPnlPoolExcess is: (${convertToNumber(
					maxPnlPoolExcess,
					QUOTE_PRECISION
				)})`
			);
			return false;
		}

		const spotMarket = this.driftClient.getSpotMarketAccount(spotMarketIdx);
		if (!spotMarket) {
			logger.warn(
				`Spot market ${spotMarketIdx} not found for positive PnL settlement check`
			);
			return false;
		}
		const netUserPnlImbalance = calculateNetUserPnlImbalance(
			perpMarket,
			spotMarket,
			oraclePriceData
		);

		if (netUserPnlImbalance.gt(ZERO)) {
			logger.warn(
				`Want to settle positive PnL for user ${user
					.getUserAccountPublicKey()
					.toBase58()} in market ${perpMarketIdx}, protocol's AMM lacks excess PnL (${convertToNumber(
					netUserPnlImbalance,
					QUOTE_PRECISION
				)})`
			);
			return false;
		}

		// only settle user pnl if they have enough collateral
		if (user.canBeLiquidated().canBeLiquidated) {
			logger.warn(
				`Want to settle negative PnL for user ${user
					.getUserAccountPublicKey()
					.toBase58()}, but they have insufficient collateral`
			);
			return false;
		}

		return true;
	}

	private async findUsersWithNoPositions(): Promise<
		Map<number, UserToSettle[]>
	> {
		const usersToSettleMap: Map<number, UserToSettle[]> = new Map();

		for (const user of this.userMap!.values()) {
			if (user.getUserAccount().poolId !== 0) {
				continue;
			}

			const perpPositions = user.getActivePerpPositions();
			for (const perpPosition of perpPositions) {
				// this loop only processes empty positions
				if (!perpPosition.baseAssetAmount.eq(ZERO)) {
					continue;
				}

				const perpMarket = this.driftClient.getPerpMarketAccount(
					perpPosition.marketIndex
				)!;
				const settlePnlPaused = isOperationPaused(
					perpMarket.pausedOperations,
					PerpOperation.SETTLE_PNL
				);
				if (settlePnlPaused) {
					logger.warn(
						`Settle PNL paused for market ${perpPosition.marketIndex}, skipping settle PNL`
					);
					continue;
				}

				const pnl = convertToNumber(
					perpPosition.quoteAssetAmount,
					QUOTE_PRECISION
				);
				if (pnl !== 0) {
					logger.info(
						`[trySettleUsersWithNoPositions] User ${user
							.getUserAccountPublicKey()
							.toBase58()} has empty perp position in market ${
							perpPosition.marketIndex
						} with unsettled pnl: ${pnl}`
					);

					const userData: UserToSettle = {
						settleeUserAccountPublicKey: user.getUserAccountPublicKey(),
						settleeUserAccount: user.getUserAccount(),
						pnl,
					};

					if (usersToSettleMap.has(perpPosition.marketIndex)) {
						const existingData = usersToSettleMap.get(
							perpPosition.marketIndex
						)!;
						existingData.push(userData);
					} else {
						usersToSettleMap.set(perpPosition.marketIndex, [userData]);
					}
				}
			}
		}

		return usersToSettleMap;
	}

	private async findUsersWithUnsettledFunding(): Promise<UserToSettle[]> {
		const usersToSettle: UserToSettle[] = [];
		for (const user of this.userMap!.values()) {
			const perpPositions = user.getActivePerpPositions();
			for (const perpPosition of perpPositions) {
				const unsettledFunding = calculateUnsettledFundingPnl(
					this.driftClient.getPerpMarketAccount(perpPosition.marketIndex)!,
					perpPosition
				);
				if (!unsettledFunding.eq(ZERO)) {
					usersToSettle.push({
						settleeUserAccountPublicKey: user.getUserAccountPublicKey(),
						settleeUserAccount: user.getUserAccount(),
						pnl: 0,
					});
					break;
				}
			}
		}

		return usersToSettle;
	}

	private async processUserSettlements(
		usersToSettleMap: Map<number, UserToSettle[]>,
		logPrefix = ''
	) {
		for (const [marketIndex, params] of usersToSettleMap) {
			const perpMarket = this.driftClient.getPerpMarketAccount(marketIndex)!;
			const marketStr = decodeName(perpMarket.name);

			if (
				FILTER_FOR_MARKET !== undefined &&
				marketIndex !== FILTER_FOR_MARKET
			) {
				logger.info(
					`${logPrefix} Skipping market ${marketStr} because FILTER_FOR_MARKET is set to ${FILTER_FOR_MARKET}`
				);
				continue;
			}

			const settlePnlPaused = isOperationPaused(
				perpMarket.pausedOperations,
				PerpOperation.SETTLE_PNL
			);

			// cannot settle pnl in this state
			const marketIsReduceOnly = ENUM_UTILS.match(
				perpMarket.status,
				MarketStatus.REDUCE_ONLY
			);

			if (settlePnlPaused || marketIsReduceOnly) {
				logger.warn(
					`${logPrefix} Settle PNL paused for market ${marketStr}, skipping settle PNL`
				);
				continue;
			}

			logger.info(
				`${logPrefix} Trying to settle PNL for ${params.length} users on market ${marketStr}`
			);

			const sortedParams = params
				.sort((a, b) => a.pnl - b.pnl)
				.slice(0, this.maxUsersToConsider);

			logger.info(
				`${logPrefix} Settling ${sortedParams.length} users in ${Math.ceil(
					sortedParams.length / SETTLE_USER_CHUNKS
				)} chunks for market ${marketIndex} with respective PnLs: ${sortedParams
					.map((p) => p.pnl)
					.join(', ')}`
			);

			await this.executeSettlementForMarket(
				marketIndex,
				sortedParams,
				logPrefix
			);
		}
	}

	private async processUserFundingSettlements(
		usersToSettle: UserToSettle[],
		logPrefix = ''
	) {
		if (usersToSettle.length === 0) {
			logger.info(`${logPrefix} No users to settle funding for`);
			return;
		}

		const allTxPromises = [];
		const fundingIxsBuilder: IxsBuilder = async (users, _marketIndex) => {
			const ixs: TransactionInstruction[] = [];
			for (const u of users) {
				ixs.push(
					await this.driftClient.getSettleFundingPaymentIx(
						u.settleeUserAccountPublicKey
					)
				);
			}
			return ixs;
		};

		for (let i = 0; i < usersToSettle.length; i += SETTLE_FUNDING_USER_CHUNKS) {
			const usersChunk = usersToSettle.slice(i, i + SETTLE_FUNDING_USER_CHUNKS);
			allTxPromises.push(
				this.trySendTxForChunk(
					-1,
					usersChunk,
					fundingIxsBuilder,
					'(settleFunding)'
				)
			);
		}

		logger.info(
			`${logPrefix} Waiting for ${allTxPromises.length} funding txs to settle...`
		);
		const settleStart = Date.now();
		await Promise.all(allTxPromises);
		logger.info(
			`${logPrefix} Settled funding for ${usersToSettle.length} users in ${
				Date.now() - settleStart
			}ms`
		);
	}

	private async executeSettlementForMarket(
		marketIndex: number,
		users: UserToSettle[],
		logPrefix = ''
	) {
		const allTxPromises = [];
		const pnlIxsBuilder: IxsBuilder = async (usersArg, marketIdx) =>
			this.driftClient.getSettlePNLsIxs(
				usersArg,
				[marketIdx],
				this.revenueShareEscrowMap
			);
		for (let i = 0; i < users.length; i += SETTLE_USER_CHUNKS) {
			const usersChunk = users.slice(i, i + SETTLE_USER_CHUNKS);
			allTxPromises.push(
				this.trySendTxForChunk(
					marketIndex,
					usersChunk,
					pnlIxsBuilder,
					'(settlePnL)'
				)
			);
		}

		logger.info(
			`${logPrefix} Waiting for ${allTxPromises.length} txs to settle...`
		);
		const settleStart = Date.now();
		await Promise.all(allTxPromises);
		logger.info(
			`${logPrefix} Settled ${users.length} users in market ${marketIndex} in ${
				Date.now() - settleStart
			}ms`
		);
	}

	// =============================================================================
	// TRANSACTION SENDING
	// =============================================================================

	async trySendTxForChunk(
		marketIndex: number,
		users: UserToSettle[],
		buildIxs?: IxsBuilder,
		simLabel = '(settlePnL)'
	): Promise<void> {
		const success = await this.sendTxForChunk(
			marketIndex,
			users,
			buildIxs,
			simLabel
		);
		if (!success) {
			const slice = Math.floor(users.length / 2);
			if (slice < 1) {
				return;
			}

			const slice0 = users.slice(0, slice);
			const slice1 = users.slice(slice);
			logger.info(
				`[trySendTxForChunk] Chunk failed: ${users
					.map((u) => u.settleeUserAccountPublicKey.toBase58())
					.join(' ')}, retrying with:\nslice0: ${slice0
					.map((u) => u.settleeUserAccountPublicKey.toBase58())
					.join(' ')}\nslice1: ${slice1
					.map((u) => u.settleeUserAccountPublicKey.toBase58())
					.join(' ')}`
			);

			await sleepMs(SLEEP_MS);
			await this.sendTxForChunk(marketIndex, slice0, buildIxs, simLabel);

			await sleepMs(SLEEP_MS);
			await this.sendTxForChunk(marketIndex, slice1, buildIxs, simLabel);
		}
		await sleepMs(SLEEP_MS);
	}

	async sendTxForChunk(
		marketIndex: number,
		users: UserToSettle[],
		buildIxs?: IxsBuilder,
		simLabel = '(settlePnL)'
	): Promise<boolean> {
		if (users.length == 0) {
			return true;
		}

		let success = false;
		try {
			const pfs = this.priorityFeeSubscriber!.getAvgStrategyResult();
			let microLamports = 10_000;
			if (pfs) {
				microLamports = Math.floor(pfs);
			}
			const ixs = [
				ComputeBudgetProgram.setComputeUnitLimit({
					units: 1_400_000, // simulateAndGetTxWithCUs will overwrite
				}),
				ComputeBudgetProgram.setComputeUnitPrice({
					microLamports,
				}),
			];
			try {
				const extraIxs = buildIxs
					? await buildIxs(users, marketIndex)
					: await this.driftClient.getSettlePNLsIxs(
							users,
							[marketIndex],
							this.revenueShareEscrowMap
					  );
				ixs.push(...extraIxs);
			} catch (error) {
				logger.error(
					`Failed to build ixs ${simLabel} for market ${marketIndex}:`
				);
				logger.error(`Error: ${error}`);
				logger.error(
					`Users: ${users
						.map((u) => u.settleeUserAccountPublicKey.toBase58())
						.join(', ')}`
				);
				throw error;
			}

			const recentBlockhash = this.blockhashSubscriber.getLatestBlockhash(5);
			if (!recentBlockhash) {
				logger.error(
					`${simLabel} No recent blockhash found for users: ${users
						.map((u) => u.settleeUserAccountPublicKey.toBase58())
						.join(', ')}`
				);
				throw new Error('No recent blockhash found');
			}
			const simResult = await simulateAndGetTxWithCUs({
				ixs,
				connection: this.driftClient.connection,
				payerPublicKey: this.driftClient.wallet.publicKey,
				lookupTableAccounts: this.lookupTableAccounts!,
				cuLimitMultiplier: CU_EST_MULTIPLIER,
				doSimulation: true,
				recentBlockhash: recentBlockhash.blockhash,
			});
			if (simResult.simError !== null) {
				logger.error(
					`Sim error for users: ${users
						.map((u) => u.settleeUserAccountPublicKey.toBase58())
						.join(', ')}: ${JSON.stringify(simResult.simError)}\n${
						simResult.simTxLogs ? simResult.simTxLogs.join('\n') : ''
					}`
				);
				handleSimResultError(simResult, errorCodesToSuppress, simLabel);
				success = false;
			} else {
				logger.info(
					`[sendTxForChunk] ${simLabel} estimated ${
						simResult.cuEstimate
					} CUs for ${ixs.length} ixs, ${users.length} users (${users
						.map((u) => u.settleeUserAccountPublicKey.toBase58())
						.join(', ')})`
				);
				if (this.dryRun) {
					logger.info(
						`[DRY RUN] ${simLabel} Would settle PnL for ${users.length} users`
					);
					success = true;
				} else {
					const sendTxStart = Date.now();
					const txSig =
						await this.driftClient.txSender.sendVersionedTransaction(
							simResult.tx,
							[],
							this.driftClient.opts
						);
					const sendTxDuration = Date.now() - sendTxStart;
					success = true;

					this.logTxAndSlotForUsers(
						txSig,
						marketIndex,
						users.map(
							({ settleeUserAccountPublicKey }) => settleeUserAccountPublicKey
						),
						sendTxDuration,
						simLabel
					);
				}
			}
		} catch (err) {
			const userKeys = users
				.map(({ settleeUserAccountPublicKey }) =>
					settleeUserAccountPublicKey.toBase58()
				)
				.join(', ');
			logger.error(`Failed to settle pnl for users: ${userKeys}`);
			console.error(err);

			if (err instanceof TransactionExpiredBlockheightExceededError) {
				logger.info(
					`Blockheight exceeded error, retrying with same set of users (${users.length} users on market ${marketIndex})`
				);
				success = await this.sendTxForChunk(
					marketIndex,
					users,
					buildIxs,
					simLabel
				);
			} else if (err instanceof Error) {
				const errorCode = getErrorCode(err) ?? 0;
				if (!errorCodesToSuppress.includes(errorCode) && users.length === 1) {
					if (err instanceof SendTransactionError) {
						await webhookMessage(
							`[${
								this.name
							}]: :x: Error code: ${errorCode} while settling pnls for ${marketIndex}:\n${
								err.logs ? (err.logs as Array<string>).join('\n') : ''
							}\n${err.stack ? err.stack : err.message}`
						);
					}
				}
			}
		}
		return success;
	}

	// =============================================================================
	// UTILITY METHODS
	// =============================================================================

	private getMillisecondsUntilNextHourFirstMinute(): number {
		const now = new Date();
		const nextHour = new Date(now);
		nextHour.setHours(now.getHours() + 1, 1, 0, 0); // Next hour, 1st minute, 0 seconds, 0 ms
		return nextHour.getTime() - now.getTime();
	}

	private getTimeUntilNextFundingUpdate(
		now: number,
		lastUpdateTs: number,
		updatePeriod: number
	): number | Error {
		const timeSinceLastUpdate = now - lastUpdateTs;

		if (timeSinceLastUpdate < 0) {
			return new Error('Invalid arguments');
		}

		let nextUpdateWait = updatePeriod;
		if (updatePeriod > 1) {
			const lastUpdateDelay = lastUpdateTs % updatePeriod;
			if (lastUpdateDelay !== 0) {
				const maxDelayForNextPeriod = updatePeriod / 3;
				const twoFundingPeriods = updatePeriod * 2;

				if (lastUpdateDelay > maxDelayForNextPeriod) {
					// too late for on the hour next period, delay to following period
					nextUpdateWait = twoFundingPeriods - lastUpdateDelay;
				} else {
					// allow update on the hour
					nextUpdateWait = updatePeriod - lastUpdateDelay;
				}

				if (nextUpdateWait > twoFundingPeriods) {
					nextUpdateWait -= updatePeriod;
				}
			}
		}

		return Math.max(nextUpdateWait - timeSinceLastUpdate, 0);
	}

	private async updateWatchdogTimer() {
		await this.watchdogTimerMutex.runExclusive(async () => {
			this.watchdogTimerLastPatTime = Date.now();
		});
	}

	private handleSettlementError(err: any, methodName: string) {
		console.error(`Error in ${methodName}`, err);
		if (!(err instanceof Error)) {
			return;
		}
		if (
			!err.message.includes('Transaction was not confirmed') &&
			!err.message.includes('Blockhash not found')
		) {
			const errorCode = getErrorCode(err);
			if (errorCodesToSuppress.includes(errorCode!)) {
				console.log(`Suppressing error code: ${errorCode}`);
			} else {
				const simError = err as SendTransactionError;
				if (simError) {
					webhookMessage(
						`[${
							this.name
						}]: :x: Uncaught error: Error code: ${errorCode} while settling pnls:\n${
							simError.logs! ? (simError.logs as Array<string>).join('\n') : ''
						}\n${err.stack ? err.stack : err.message}`
					);
				}
			}
		}
	}

	private logTxAndSlotForUsers(
		txSigAndSlot: TxSigAndSlot,
		marketIndex: number,
		userAccountPublicKeys: Array<PublicKey>,
		sendTxDuration: number,
		label?: string
	) {
		const txSig = txSigAndSlot.txSig;
		let userStr = '';
		let countUsers = 0;
		for (const userAccountPublicKey of userAccountPublicKeys) {
			userStr += `${userAccountPublicKey.toBase58()}, `;
			countUsers++;
		}
		const isFunding = label === '(settleFunding)';
		if (isFunding) {
			logger.info(
				`Settled funding for ${countUsers} users: ${userStr}. Took: ${sendTxDuration}ms. https://solana.fm/tx/${txSig}`
			);
		} else {
			logger.info(
				`Settled pnl in market ${marketIndex}. For ${countUsers} users: ${userStr}. Took: ${sendTxDuration}ms. https://solana.fm/tx/${txSig}`
			);
		}
	}
}
