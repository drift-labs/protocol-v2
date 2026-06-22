import {
	VelocityClient,
	SpotMarketAccount,
	OraclePriceData,
	ZERO,
	PriorityFeeSubscriberMap,
	VelocityMarketInfo,
} from '@velocity-exchange/sdk';
import { Mutex } from 'async-mutex';

import { getErrorCode } from '../error';
import { logger } from '../logger';
import { Bot } from '../types';
import { webhookMessage } from '../webhook';
import { BaseBotConfig } from '../config';
import {
	getVelocityPriorityFeeEndpoint,
	simulateAndGetTxWithCUs,
	sleepS,
} from '../utils';
import {
	AddressLookupTableAccount,
	ComputeBudgetProgram,
} from '@solana/web3.js';

const MAX_SETTLE_WAIT_TIME_S = 10 * 60; // 10 minutes

const errorCodesToSuppress = [
	6177, // NoRevenueToSettleToIF
	6176, // RevenueSettingsCannotSettleToIF
];

export class IFRevenueSettlerBot implements Bot {
	public readonly name: string;
	public readonly dryRun: boolean;
	public readonly runOnce: boolean;
	public readonly defaultIntervalMs: number = 600000;
	private priorityFeeSubscriberMap?: PriorityFeeSubscriberMap;

	private velocityClient: VelocityClient;
	private intervalIds: Array<NodeJS.Timer> = [];

	private watchdogTimerMutex = new Mutex();
	private watchdogTimerLastPatTime = Date.now();
	private lookupTableAccounts?: AddressLookupTableAccount[];

	constructor(velocityClient: VelocityClient, config: BaseBotConfig) {
		this.name = config.botId;
		this.dryRun = config.dryRun;
		this.runOnce = config.runOnce || false;
		this.velocityClient = velocityClient;
	}

	public async init() {
		logger.info(`${this.name} initing`);

		await this.velocityClient.subscribe();

		const velocityMarkets: VelocityMarketInfo[] = [];
		for (const spotMarket of this.velocityClient.getSpotMarketAccounts()) {
			velocityMarkets.push({
				marketType: 'spot',
				marketIndex: spotMarket.marketIndex,
			});
		}

		this.priorityFeeSubscriberMap = new PriorityFeeSubscriberMap({
			// Prefer the configured endpoint (PRIORITY_FEE_ENDPOINT, e.g. the
			// in-cluster dlob-server) over the hardcoded dlob.drift.trade, which
			// 502s for velocity.
			velocityPriorityFeeEndpoint:
				process.env.PRIORITY_FEE_ENDPOINT ??
				getVelocityPriorityFeeEndpoint('mainnet-beta'),
			velocityMarkets,
			frequencyMs: 10_000,
		});
		await this.priorityFeeSubscriberMap!.subscribe();

		if (!(await this.velocityClient.getUser().exists())) {
			throw new Error(
				`User for ${this.velocityClient.wallet.publicKey.toString()} does not exist`
			);
		}

		this.lookupTableAccounts =
			await this.velocityClient.fetchAllLookupTableAccounts();
	}

	public async reset() {
		await this.priorityFeeSubscriberMap!.unsubscribe();
		await this.velocityClient.unsubscribe();
		for (const intervalId of this.intervalIds) {
			clearInterval(intervalId as NodeJS.Timeout);
		}
		this.intervalIds = [];
	}

	public async startIntervalLoop(intervalMs?: number): Promise<void> {
		logger.info(`${this.name} Bot started!`);
		if (this.runOnce) {
			await this.trySettleIFRevenue();
		} else {
			const intervalId = setInterval(
				this.trySettleIFRevenue.bind(this),
				intervalMs
			);
			this.intervalIds.push(intervalId);
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

	private async settleIFRevenue(spotMarketIndex: number) {
		try {
			const pfs = this.priorityFeeSubscriberMap!.getPriorityFees(
				'spot',
				spotMarketIndex
			);
			let microLamports = 10_000;
			if (pfs) {
				microLamports = Math.floor(pfs.medium);
			}
			const ixs = [
				ComputeBudgetProgram.setComputeUnitLimit({
					units: 1_400_000, // simulateAndGetTxWithCUs will overwrite
				}),
				ComputeBudgetProgram.setComputeUnitPrice({
					microLamports,
				}),
			];
			ixs.push(
				await this.velocityClient.getSettleRevenueToInsuranceFundIx(
					spotMarketIndex
				)
			);

			const recentBlockhash =
				await this.velocityClient.connection.getLatestBlockhash('confirmed');
			const simResult = await simulateAndGetTxWithCUs({
				ixs,
				connection: this.velocityClient.connection,
				payerPublicKey: this.velocityClient.wallet.publicKey,
				lookupTableAccounts: this.lookupTableAccounts!,
				cuLimitMultiplier: 1.1,
				doSimulation: true,
				recentBlockhash: recentBlockhash.blockhash,
			});
			logger.info(
				`settleRevenueToInsuranceFund on spot market ${spotMarketIndex} estimated to take ${simResult.cuEstimate} CUs.`
			);
			if (simResult.simError !== null) {
				logger.error(
					`Sim error: ${JSON.stringify(simResult.simError)}\n${
						simResult.simTxLogs ? simResult.simTxLogs.join('\n') : ''
					}`
				);
			} else {
				const sendTxStart = Date.now();
				const txSig =
					await this.velocityClient.txSender.sendVersionedTransaction(
						simResult.tx,
						[],
						this.velocityClient.opts
					);
				logger.info(
					`Settle IF Revenue for spot market ${spotMarketIndex} tx sent in ${
						Date.now() - sendTxStart
					}ms: https://solana.fm/tx/${txSig.txSig}`
				);
			}
		} catch (e: any) {
			const err = e as Error;
			const errorCode = getErrorCode(err);
			logger.error(
				`Error code: ${errorCode} while settling revenue to IF for marketIndex=${spotMarketIndex}: ${err.message}`
			);
			console.error(err);

			if (errorCode && !errorCodesToSuppress.includes(errorCode)) {
				await webhookMessage(
					`[${
						this.name
					}]: :x: Error code: ${errorCode} while settling revenue to IF for marketIndex=${spotMarketIndex}:\n${
						e.logs ? (e.logs as Array<string>).join('\n') : ''
					}\n${err.stack ? err.stack : err.message}`
				);
			}
		}
	}

	private async trySettleIFRevenue() {
		try {
			const spotMarketAndOracleData: {
				[marketIndex: number]: {
					marketAccount: SpotMarketAccount;
					oraclePriceData: OraclePriceData;
				};
			} = {};

			for (const marketAccount of this.velocityClient.getSpotMarketAccounts()) {
				spotMarketAndOracleData[marketAccount.marketIndex] = {
					marketAccount,
					oraclePriceData: this.velocityClient.getOracleDataForSpotMarket(
						marketAccount.marketIndex
					),
				};
			}

			const ifSettlePromises = [];
			for (
				let i = 0;
				i < this.velocityClient.getSpotMarketAccounts().length;
				i++
			) {
				const spotMarketAccount = spotMarketAndOracleData[i].marketAccount;
				const spotIf = spotMarketAccount.insuranceFund;
				if (
					spotIf.revenueSettlePeriod.eq(ZERO) ||
					spotMarketAccount.revenuePool.scaledBalance.eq(ZERO)
				) {
					continue;
				}
				const currentTs = Date.now() / 1000;

				// add 1 sec buffer
				const timeUntilSettle =
					spotIf.lastRevenueSettleTs.toNumber() +
					spotIf.revenueSettlePeriod.toNumber() -
					currentTs +
					1;

				if (timeUntilSettle <= MAX_SETTLE_WAIT_TIME_S) {
					ifSettlePromises.push(
						(async () => {
							logger.info(
								`IF revenue settling on market ${i} in ${timeUntilSettle} seconds`
							);
							await sleepS(timeUntilSettle);
							await this.settleIFRevenue(i);
						})()
					);
				} else {
					logger.info(
						`Too long to wait (${timeUntilSettle} seconds) to settle IF for marke market ${i}, skipping...`
					);
				}
			}

			await Promise.all(ifSettlePromises);
		} catch (e: any) {
			console.error(e);
			const err = e as Error;
			if (
				!err.message.includes('Transaction was not confirmed') &&
				!err.message.includes('Blockhash not found')
			) {
				const errorCode = getErrorCode(err);
				await webhookMessage(
					`[${
						this.name
					}]: :x: IF Revenue Settler error: Error code: ${errorCode}:\n${
						e.logs ? (e.logs as Array<string>).join('\n') : ''
					}\n${err.stack ? err.stack : err.message}`
				);
			}
		} finally {
			logger.info('Settle IF Revenues finished');
			await this.watchdogTimerMutex.runExclusive(async () => {
				this.watchdogTimerLastPatTime = Date.now();
			});
		}
	}
}
