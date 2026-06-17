import {
	DriftClient,
	ZERO,
	PerpMarketAccount,
	isOneOfVariant,
	getVariant,
	isOperationPaused,
	PerpOperation,
	decodeName,
	PublicKey,
	PriorityFeeSubscriberMap,
	DriftMarketInfo,
	isVariant,
} from '@drift-labs/sdk';
import { Mutex } from 'async-mutex';

import { getErrorCode, getErrorCodeFromSimError } from '../error';
import { logger } from '../logger';
import { Bot } from '../types';
import { webhookMessage } from '../webhook';
import { BaseBotConfig } from '../config';
import {
	getDriftPriorityFeeEndpoint,
	simulateAndGetTxWithCUs,
	sleepMs,
} from '../utils';
import {
	AddressLookupTableAccount,
	ComputeBudgetProgram,
	TransactionExpiredBlockheightExceededError,
} from '@solana/web3.js';

const errorCodesToSuppress = [
	6040,
	6251, // FundingWasNotUpdated
	6096, // AMMNotUpdatedInSameSlot
];
const errorCodesCanRetry = [
	6096, // AMMNotUpdatedInSameSlot
];
const CU_EST_MULTIPLIER = 1.4;

function onTheHourUpdate(
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

export class FundingRateUpdaterBot implements Bot {
	public readonly name: string;
	public readonly dryRun: boolean;
	public readonly runOnce: boolean;
	public readonly defaultIntervalMs: number = 120000; // run every 2 min

	private driftClient: DriftClient;
	private intervalIds: Array<NodeJS.Timer> = [];
	private priorityFeeSubscriberMap?: PriorityFeeSubscriberMap;
	private lookupTableAccounts?: AddressLookupTableAccount[];

	private watchdogTimerMutex = new Mutex();
	private watchdogTimerLastPatTime = Date.now();
	private inProgress: boolean = false;

	constructor(driftClient: DriftClient, config: BaseBotConfig) {
		this.name = config.botId;
		this.dryRun = config.dryRun;
		this.driftClient = driftClient;
		this.runOnce = config.runOnce ?? false;
	}

	public async init() {
		const driftMarkets: DriftMarketInfo[] = [];
		for (const perpMarket of this.driftClient.getPerpMarketAccounts()) {
			driftMarkets.push({
				marketType: 'perp',
				marketIndex: perpMarket.marketIndex,
			});
		}
		this.priorityFeeSubscriberMap = new PriorityFeeSubscriberMap({
			driftPriorityFeeEndpoint: getDriftPriorityFeeEndpoint('mainnet-beta'),
			driftMarkets,
			frequencyMs: 10_000,
		});
		await this.priorityFeeSubscriberMap!.subscribe();

		this.lookupTableAccounts =
			await this.driftClient.fetchAllLookupTableAccounts();
		logger.info(`[${this.name}] inited`);
	}

	public async reset() {
		for (const intervalId of this.intervalIds) {
			clearInterval(intervalId as NodeJS.Timeout);
		}
		this.intervalIds = [];
	}

	public async startIntervalLoop(intervalMs?: number): Promise<void> {
		logger.info(`[${this.name}] Bot started! runOnce ${this.runOnce}`);

		if (this.runOnce) {
			await this.tryUpdateFundingRate();
		} else {
			await this.tryUpdateFundingRate();
			const intervalId = setInterval(
				this.tryUpdateFundingRate.bind(this),
				intervalMs
			);
			this.intervalIds.push(intervalId);
		}
	}

	public async healthCheck(): Promise<boolean> {
		let healthy = false;
		await this.watchdogTimerMutex.runExclusive(async () => {
			healthy =
				this.watchdogTimerLastPatTime >
				Date.now() - 10 * this.defaultIntervalMs;
		});
		return healthy;
	}

	private async tryUpdateFundingRate() {
		if (this.inProgress) {
			logger.info(
				`[${this.name}] UpdateFundingRate already in progress, skipping...`
			);
			return;
		}
		const start = Date.now();
		try {
			this.inProgress = true;

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

			for (
				let i = 0;
				i < this.driftClient.getPerpMarketAccounts().length;
				i++
			) {
				const perpMarket = perpMarketAndOracleData[i].marketAccount;
				isOneOfVariant;
				if (isOneOfVariant(perpMarket.status, ['initialized'])) {
					logger.info(
						`[${this.name}] Skipping perp market ${
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
						`[${this.name}] Update funding paused for market: ${perpMarket.marketIndex} ${marketStr}, skipping`
					);
					continue;
				}

				if (perpMarket.amm.fundingPeriod.eq(ZERO)) {
					continue;
				}
				const currentTs = Date.now() / 1000;

				const timeRemainingTilUpdate = onTheHourUpdate(
					currentTs,
					perpMarket.amm.lastFundingRateTs.toNumber(),
					perpMarket.amm.fundingPeriod.toNumber()
				);
				logger.info(
					`[${this.name}] Perp market ${perpMarket.marketIndex} timeRemainingTilUpdate=${timeRemainingTilUpdate}`
				);
				if ((timeRemainingTilUpdate as number) <= 0) {
					logger.info(
						`[${this.name}] Perp market ${
							perpMarket.marketIndex
						} lastFundingRateTs: ${perpMarket.amm.lastFundingRateTs.toString()}, fundingPeriod: ${perpMarket.amm.fundingPeriod.toString()}, lastFunding+Period: ${perpMarket.amm.lastFundingRateTs
							.add(perpMarket.amm.fundingPeriod)
							.toString()} vs. currTs: ${currentTs.toString()}`
					);
					this.sendTxWithRetry(perpMarket.marketIndex, perpMarket.amm.oracle);
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
			this.inProgress = false;
			logger.info(
				`[${this.name}] Update Funding Rates finished in ${
					Date.now() - start
				}ms`
			);
			await this.watchdogTimerMutex.runExclusive(async () => {
				this.watchdogTimerLastPatTime = Date.now();
			});
		}
	}

	private async sendTxs(
		microLamports: number,
		marketIndex: number,
		oracle: PublicKey
	): Promise<{ success: boolean; canRetry: boolean }> {
		const ixs = [
			ComputeBudgetProgram.setComputeUnitLimit({
				units: 1_400_000, // simulateAndGetTxWithCUs will overwrite
			}),
			ComputeBudgetProgram.setComputeUnitPrice({
				microLamports,
			}),
		];
		const perpMarket = this.driftClient.getPerpMarketAccount(marketIndex);
		if (isVariant(perpMarket?.amm.oracleSource, 'switchboardOnDemand')) {
			const crankIx =
				await this.driftClient.getPostSwitchboardOnDemandUpdateAtomicIx(
					perpMarket!.amm.oracle
				);
			if (crankIx) {
				ixs.push(crankIx);
			}
		}
		ixs.push(
			await this.driftClient.getUpdateFundingRateIx(marketIndex, oracle)
		);

		const recentBlockhash =
			await this.driftClient.connection.getLatestBlockhash('confirmed');
		const simResult = await simulateAndGetTxWithCUs({
			ixs,
			connection: this.driftClient.connection,
			payerPublicKey: this.driftClient.wallet.publicKey,
			lookupTableAccounts: this.lookupTableAccounts!,
			cuLimitMultiplier: CU_EST_MULTIPLIER,
			doSimulation: true,
			recentBlockhash: recentBlockhash.blockhash,
		});
		logger.info(
			`[${this.name}] UpdateFundingRate estimated ${simResult.cuEstimate} CUs for market: ${marketIndex}`
		);

		if (simResult.simError !== null) {
			const errorCode = getErrorCodeFromSimError(simResult.simError);
			if (errorCode && errorCodesToSuppress.includes(errorCode)) {
				logger.error(
					`[${
						this.name
					}] Sim error (suppressed) on market: ${marketIndex}, code: ${errorCode} ${JSON.stringify(
						simResult.simError
					)}`
				);
			} else {
				logger.error(
					`[${
						this.name
					}] Sim error (not suppressed) on market: ${marketIndex}, code: ${errorCode}: ${JSON.stringify(
						simResult.simError
					)}\n${simResult.simTxLogs ? simResult.simTxLogs.join('\n') : ''}`
				);
			}

			if (errorCode && errorCodesCanRetry.includes(errorCode)) {
				return { success: false, canRetry: true };
			} else {
				return { success: false, canRetry: false };
			}
		}

		const sendTxStart = Date.now();
		const txSig = await this.driftClient.txSender.sendVersionedTransaction(
			simResult.tx,
			[],
			this.driftClient.opts
		);
		logger.info(
			`[${
				this.name
			}] UpdateFundingRate for market: ${marketIndex}, tx sent in ${
				Date.now() - sendTxStart
			}ms: https://solana.fm/tx/${txSig.txSig}`
		);

		return { success: true, canRetry: false };
	}

	private async sendTxWithRetry(marketIndex: number, oracle: PublicKey) {
		const pfs = this.priorityFeeSubscriberMap!.getPriorityFees(
			'perp',
			marketIndex
		);
		let microLamports = 10_000;
		if (pfs) {
			microLamports = Math.floor(pfs.medium);
		}

		const maxRetries = 30;

		for (let i = 0; i < maxRetries; i++) {
			try {
				logger.info(
					`[${
						this.name
					}] Funding rate update on market ${marketIndex}, attempt: ${
						i + 1
					}/${maxRetries}`
				);
				const result = await this.sendTxs(microLamports, marketIndex, oracle);
				if (result.success) {
					break;
				}
				if (result.canRetry) {
					logger.info(`[${this.name}] Retrying market ${marketIndex} in 1s...`);
					await sleepMs(1000);
					continue;
				} else {
					break;
				}
			} catch (e: any) {
				const err = e as Error;
				const errorCode = getErrorCode(err);
				logger.error(
					`[${this.name}] Error code: ${errorCode} while updating funding rates on perp marketIndex=${marketIndex}: ${err.message}`
				);
				if (err instanceof TransactionExpiredBlockheightExceededError) {
					logger.info(
						`[${this.name}] Blockhash expired for market: ${marketIndex}, retrying in 1s...`
					);
					await sleepMs(1000);
					continue;
				} else if (errorCode && !errorCodesToSuppress.includes(errorCode)) {
					logger.error(
						`[${this.name}] Unsuppressed error for market: ${marketIndex}, not retrying.`
					);
					console.error(err);
					break;
				}
			}
		}
	}
}
