/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-unused-vars */
import {
	VelocityEnv,
	VelocityClient,
	convertToNumber,
	MarketType,
	PRICE_PRECISION,
	DLOBSubscriber,
	SlotSubscriber,
	MakerInfo,
	getUserStatsAccountPublicKey,
	OrderSubscriber,
	PollingVelocityClientAccountSubscriber,
	TxSigAndSlot,
	ZERO,
	PriorityFeeSubscriber,
} from '@velocity-exchange/sdk';
import { Mutex, tryAcquire, E_ALREADY_LOCKED } from 'async-mutex';
import { logger } from '../logger';
import { Bot } from '../types';
import {
	getBestLimitAskExcludePubKey,
	getBestLimitBidExcludePubKey,
} from '../utils';
import { JitProxyClient } from '@drift-labs/jit-proxy/lib';
import dotenv = require('dotenv');

dotenv.config();
import { BaseBotConfig } from 'src/config';
import {
	AddressLookupTableAccount,
	ComputeBudgetProgram,
	PublicKey,
	SendTransactionError,
} from '@solana/web3.js';
import { getErrorCode } from '../error';
import { webhookMessage } from '../webhook';
import {
	isArbIxLog,
	isEndIxLog,
	isErrArb,
	isErrArbNoAsk,
	isErrArbNoBid,
	isIxLog,
	isMakerBreachedMaintenanceMarginLog,
} from './common/txLogParse';

const SETTLE_POSITIVE_PNL_COOLDOWN_MS = 60_000;
const SETTLE_PNL_CHUNKS = 4;
const MAX_POSITIONS_PER_USER = 8;
const THROTTLED_NODE_COOLDOWN = 10000;
const ARB_ERROR_THRESHOLD_PER_USER = 3;

const errorCodesToSuppress = [
	6004, // 0x1774 Error Number: 6004. Error Message: NoBestBid.
	6005, // 0x1775 Error Number: 6005. Error Message: NoBestAsk.
	6006, // 0x1776 Error Number: 6006. Error Message: NoArbOpportunity.
];

/**
 * This is an example of a bot that implements the Bot interface.
 */
export class UncrossArbBot implements Bot {
	public readonly name: string;
	public readonly dryRun: boolean;
	public readonly defaultIntervalMs: number = 1000;

	private velocityEnv: VelocityEnv;
	private periodicTaskMutex = new Mutex();

	private jitProxyClient: JitProxyClient;
	private velocityClient: VelocityClient;
	private lookupTableAccounts?: AddressLookupTableAccount[];
	private intervalIds: Array<NodeJS.Timer> = [];

	private watchdogTimerMutex = new Mutex();
	private watchdogTimerLastPatTime = Date.now();

	private dlobSubscriber: DLOBSubscriber;
	private slotSubscriber: SlotSubscriber;
	private orderSubscriber: OrderSubscriber;
	private priorityFeeSubscriber: PriorityFeeSubscriber;

	private lastSettlePnl = Date.now() - SETTLE_POSITIVE_PNL_COOLDOWN_MS;
	private throttledNodes: Map<number, Map<string, number>> = new Map();
	private noArbErrors: Map<number, Map<string, number>> = new Map();

	constructor(
		velocityClient: VelocityClient, // velocityClient needs to have correct number of subaccounts listed
		jitProxyClient: JitProxyClient,
		slotSubscriber: SlotSubscriber,
		config: BaseBotConfig,
		velocityEnv: VelocityEnv,
		priorityFeeSubscriber: PriorityFeeSubscriber
	) {
		this.jitProxyClient = jitProxyClient;
		this.velocityClient = velocityClient;
		this.name = config.botId;
		this.dryRun = config.dryRun;
		this.velocityEnv = velocityEnv;
		this.slotSubscriber = slotSubscriber;

		let accountSubscription:
			| {
					type: 'polling';
					frequency: number;
					commitment: 'processed';
			  }
			| {
					commitment: 'processed';
					type: 'websocket';
					resubTimeoutMs?: number;
					resyncIntervalMs?: number;
			  };
		if (
			(
				this.velocityClient
					.accountSubscriber as PollingVelocityClientAccountSubscriber
			).accountLoader
		) {
			accountSubscription = {
				type: 'polling',
				frequency: 1000,
				commitment: 'processed',
			};
		} else {
			accountSubscription = {
				commitment: 'processed',
				type: 'websocket',
				resubTimeoutMs: 30000,
				resyncIntervalMs: 10_000,
			};
		}

		this.orderSubscriber = new OrderSubscriber({
			velocityClient: this.velocityClient,
			subscriptionConfig: accountSubscription,
		});

		this.dlobSubscriber = new DLOBSubscriber({
			dlobSource: this.orderSubscriber,
			slotSource: this.orderSubscriber,
			updateFrequency: 500,
			velocityClient: this.velocityClient,
		});

		this.priorityFeeSubscriber = priorityFeeSubscriber;
		this.priorityFeeSubscriber.updateAddresses([
			new PublicKey('8UJgxaiQx5nTrdDgph5FiahMmzduuLTLf5WmsPegYA6W'), // sol-perp
		]);
	}

	/**
	 * Run initialization procedures for the bot.
	 */
	public async init(): Promise<void> {
		logger.info(`${this.name} initing`);

		await this.orderSubscriber.subscribe();
		await this.dlobSubscriber.subscribe();
		this.lookupTableAccounts =
			await this.velocityClient.fetchAllLookupTableAccounts();

		for (const marketIndex of this.velocityClient
			.getPerpMarketAccounts()
			.map((m) => m.marketIndex)) {
			this.throttledNodes.set(marketIndex, new Map());
			this.noArbErrors.set(marketIndex, new Map());
		}

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

		this.intervalIds.push(
			setInterval(
				this.settlePnls.bind(this),
				SETTLE_POSITIVE_PNL_COOLDOWN_MS / 2
			)
		);

		logger.info(`${this.name} Bot started! velocityEnv: ${this.velocityEnv}`);
	}

	/**
	 * Typically used for monitoring liveness.
	 * @returns true if bot is healthy, else false.
	 */
	public async healthCheck(): Promise<boolean> {
		let healthy = false;
		await this.watchdogTimerMutex.runExclusive(async () => {
			healthy =
				this.watchdogTimerLastPatTime > Date.now() - 5 * this.defaultIntervalMs;
		});
		return healthy;
	}

	protected getOrderSignatureFromMakerInfo(makerInfo: MakerInfo): string {
		return (
			makerInfo.maker.toString() + '_' + makerInfo.order!.orderId.toString()
		);
	}

	protected handleTransactionLogs(
		bidMakerInfo: MakerInfo,
		askMakerInfo: MakerInfo,
		marketIndex: number,
		logs: string[] | null | undefined
	): void {
		if (!logs) {
			return;
		}

		let inArbIx = false;
		for (const log of logs) {
			if (log === null) {
				logger.error(`log is null`);
				continue;
			}

			// Log which program is causing the error
			if (isIxLog(log)) {
				if (isArbIxLog(log)) {
					// can also print this from parsing the log record in upcoming
					console.log('Failed in arb ix');
					inArbIx = true;
				} else {
					inArbIx = false;
					console.log('Failed in velocity ix');
				}
				continue;
			}

			if (isEndIxLog(this.velocityClient.program.programId.toBase58(), log)) {
				continue;
			}

			if (!inArbIx) {
				// this is not a log for a fill instruction
				const makerBreachedMaintenanceMargin =
					isMakerBreachedMaintenanceMarginLog(log);
				if (makerBreachedMaintenanceMargin !== null) {
					logger.error(
						`Throttling maker breached maintenance margin: ${makerBreachedMaintenanceMargin}`
					);
					this.throttledNodes
						.get(marketIndex)!
						.set(makerBreachedMaintenanceMargin, Date.now());
					this.velocityClient
						.forceCancelOrders(
							new PublicKey(makerBreachedMaintenanceMargin),
							makerBreachedMaintenanceMargin === bidMakerInfo.maker.toBase58()
								? bidMakerInfo.makerUserAccount
								: askMakerInfo.makerUserAccount
						)
						.then((txSig) => {
							logger.info(
								`Force cancelled orders for makers due to breach of maintenance margin. Tx: ${txSig}`
							);
						})
						.catch((e) => {
							console.error(e);
							logger.error(
								`Failed to send ForceCancelOrder Tx for maker (${makerBreachedMaintenanceMargin}) breach margin (error above):`
							);

							const errorCode = getErrorCode(e);

							if (
								errorCode &&
								!errorCodesToSuppress.includes(errorCode) &&
								!(e as Error).message.includes('Transaction was not confirmed')
							) {
								webhookMessage(
									`[${
										this.name
									}]: :x: error forceCancelling user ${makerBreachedMaintenanceMargin} for maker breaching margin tx logs:\n${
										e.stack ? e.stack : e.message
									}`
								);
							}
						});

					break;
				} else {
					continue;
				}
			}

			// Throttle nodes that aren't filling
			const errArbing = isErrArb(log);
			const errNoAsk = isErrArbNoAsk(log);
			const errNoBid = isErrArbNoBid(log);
			if (inArbIx && errArbing) {
				const noArbErrorsMap = this.noArbErrors.get(marketIndex)!;
				const bidMakerSig = this.getOrderSignatureFromMakerInfo(bidMakerInfo);
				const askMakerSig = this.getOrderSignatureFromMakerInfo(askMakerInfo);

				if (!noArbErrorsMap.has(bidMakerSig))
					noArbErrorsMap.set(bidMakerSig, 0);
				if (!noArbErrorsMap.has(askMakerSig))
					noArbErrorsMap.set(askMakerSig, 0);

				noArbErrorsMap.set(bidMakerSig, noArbErrorsMap.get(bidMakerSig)! + 1);
				noArbErrorsMap.set(askMakerSig, noArbErrorsMap.get(askMakerSig)! + 1);

				if (noArbErrorsMap.get(bidMakerSig)! > ARB_ERROR_THRESHOLD_PER_USER) {
					this.throttledNodes.get(marketIndex)!.set(bidMakerSig, Date.now());
					noArbErrorsMap.set(bidMakerSig, 0);
					logger.warn(
						`Throttling ${bidMakerSig} due to NoArbError on ${marketIndex}`
					);
				}

				if (noArbErrorsMap.get(askMakerSig)! > ARB_ERROR_THRESHOLD_PER_USER) {
					this.throttledNodes.get(marketIndex)!.set(askMakerSig, Date.now());
					noArbErrorsMap.set(askMakerSig, 0);
					logger.warn(
						`Throttling ${askMakerSig} due to NoArbError on ${marketIndex}`
					);
				}

				continue;
			} else if (inArbIx && errNoAsk) {
				const noArbErrorsMap = this.noArbErrors.get(marketIndex)!;
				const askMakerSig = this.getOrderSignatureFromMakerInfo(askMakerInfo);

				if (!noArbErrorsMap.has(askMakerSig))
					noArbErrorsMap.set(askMakerSig, 0);

				noArbErrorsMap.set(askMakerSig, noArbErrorsMap.get(askMakerSig)! + 1);

				if (noArbErrorsMap.get(askMakerSig)! > ARB_ERROR_THRESHOLD_PER_USER) {
					this.throttledNodes.get(marketIndex)!.set(askMakerSig, Date.now());
					noArbErrorsMap.set(askMakerSig, 0);
					logger.warn(
						`Throttling ${askMakerSig} due to NoArbError on ${marketIndex}`
					);
				}
			} else if (inArbIx && errNoBid) {
				const noArbErrorsMap = this.noArbErrors.get(marketIndex)!;
				const bidMakerSig = this.getOrderSignatureFromMakerInfo(bidMakerInfo);

				if (!noArbErrorsMap.has(bidMakerSig))
					noArbErrorsMap.set(bidMakerSig, 0);

				noArbErrorsMap.set(bidMakerSig, noArbErrorsMap.get(bidMakerSig)! + 1);

				if (noArbErrorsMap.get(bidMakerSig)! > ARB_ERROR_THRESHOLD_PER_USER) {
					this.throttledNodes.get(marketIndex)!.set(bidMakerSig, Date.now());
					noArbErrorsMap.set(bidMakerSig, 0);
					logger.warn(
						`Throttling ${bidMakerSig} due to NoArbError on ${marketIndex}`
					);
				}
			}
		}
	}

	private async runPeriodicTasks() {
		const start = Date.now();
		let ran = false;
		try {
			await tryAcquire(this.periodicTaskMutex).runExclusive(async () => {
				logger.debug(
					`[${new Date().toISOString()}] Running uncross periodic tasks...`
				);
				const perpMarkets = this.velocityClient.getPerpMarketAccounts();
				for (let i = 0; i < perpMarkets.length; i++) {
					const perpIdx = perpMarkets[i].marketIndex;
					const velocityUser = this.velocityClient.getUser();

					const perpMarketAccount =
						this.velocityClient.getPerpMarketAccount(perpIdx)!;
					const oraclePriceData =
						this.velocityClient.getOracleDataForPerpMarket(perpIdx);
					const mmOraclePriceData =
						this.velocityClient.getMMOracleDataForPerpMarket(perpIdx);

					// Go through throttled nodes so we can exlcude them
					const excludedPubKeysOrderIdPairs: [string, number][] = [];
					const throttledNodesForMarket = this.throttledNodes.get(perpIdx)!;
					if (throttledNodesForMarket) {
						for (const [pubKeySig, time] of throttledNodesForMarket.entries()) {
							if (Date.now() - time < THROTTLED_NODE_COOLDOWN) {
								excludedPubKeysOrderIdPairs.push(
									((sig: string) => [
										sig.split('_')[0],
										parseInt(sig.split('_')[1]),
									])(pubKeySig)
								);
							} else {
								throttledNodesForMarket.delete(pubKeySig);
								if (this.noArbErrors.get(perpIdx)!.has(pubKeySig)) {
									logger.warn(`Releasing throttled node ${pubKeySig}`);
									this.noArbErrors.get(perpIdx)!.delete(pubKeySig);
								}
							}
						}
					}

					const bestVelocityBid = getBestLimitBidExcludePubKey(
						this.dlobSubscriber.dlob,
						perpMarketAccount.marketIndex,
						MarketType.PERP,
						oraclePriceData.slot.toNumber(),
						mmOraclePriceData,
						velocityUser.getUserAccountPublicKey().toBase58(),
						excludedPubKeysOrderIdPairs
					);

					const bestVelocityAsk = getBestLimitAskExcludePubKey(
						this.dlobSubscriber.dlob,
						perpMarketAccount.marketIndex,
						MarketType.PERP,
						oraclePriceData.slot.toNumber(),
						mmOraclePriceData,
						velocityUser.getUserAccountPublicKey().toBase58(),
						excludedPubKeysOrderIdPairs
					);

					if (!bestVelocityBid || !bestVelocityAsk) {
						continue;
					}

					const currentSlot = this.slotSubscriber.getSlot();
					const bestVelocityBidPrice = bestVelocityBid.getPrice(
						oraclePriceData,
						currentSlot
					);
					const bestVelocityAskPrice = bestVelocityAsk.getPrice(
						oraclePriceData,
						currentSlot
					);
					if (!bestVelocityBidPrice || !bestVelocityAskPrice) {
						continue;
					}
					const bestBidPrice = convertToNumber(
						bestVelocityBidPrice,
						PRICE_PRECISION
					);
					const bestAskPrice = convertToNumber(
						bestVelocityAskPrice,
						PRICE_PRECISION
					);

					const midPrice = (bestBidPrice + bestAskPrice) / 2;
					if (
						(bestBidPrice - bestAskPrice) / midPrice >
						2 *
							this.velocityClient.getMarketFees(
								MarketType.PERP,
								perpIdx,
								velocityUser
							).takerFee
					) {
						let bidMakerInfo: MakerInfo;
						let askMakerInfo: MakerInfo;
						try {
							bidMakerInfo = {
								makerUserAccount: this.orderSubscriber.usersAccounts.get(
									bestVelocityBid.userAccount!
								)!.userAccount,
								order: bestVelocityBid.order,
								maker: new PublicKey(bestVelocityBid.userAccount!),
								makerStats: getUserStatsAccountPublicKey(
									this.velocityClient.program.programId,
									this.orderSubscriber.usersAccounts.get(
										bestVelocityBid.userAccount!
									)!.userAccount.authority
								),
							};

							askMakerInfo = {
								makerUserAccount: this.orderSubscriber.usersAccounts.get(
									bestVelocityAsk.userAccount!
								)!.userAccount,
								order: bestVelocityAsk.order,
								maker: new PublicKey(bestVelocityAsk.userAccount!),
								makerStats: getUserStatsAccountPublicKey(
									this.velocityClient.program.programId,
									this.orderSubscriber.usersAccounts.get(
										bestVelocityAsk.userAccount!
									)!.userAccount.authority
								),
							};

							console.log(`
								Crossing market on marketIndex: ${perpIdx}
								Market: ${bestBidPrice}@${bestAskPrice}
								Bid maker: ${bidMakerInfo.maker.toBase58()}
								ask maker: ${askMakerInfo.maker.toBase58()}
							`);
						} catch (e) {
							continue;
						}
						try {
							const fee = Math.floor(
								this.priorityFeeSubscriber.getCustomStrategyResult() * 1.1 || 1
							);
							const txResult =
								await this.velocityClient.txSender.sendVersionedTransaction(
									await this.velocityClient.txSender.getVersionedTransaction(
										[
											ComputeBudgetProgram.setComputeUnitLimit({
												units: 1_400_000,
											}),
											ComputeBudgetProgram.setComputeUnitPrice({
												microLamports: fee,
											}),
											await this.jitProxyClient.getArbPerpIx({
												marketIndex: perpIdx,
												// jit-proxy is the external @velocity-exchange SDK; its MakerInfo type
												// differs from the velocity SDK's. Cast to bridge.
												makerInfos: [bidMakerInfo, askMakerInfo] as any,
												referrerInfo: this.velocityClient
													.getUserStats()!
													.getReferrerInfo(),
											}),
										],
										this.lookupTableAccounts!,
										[],
										this.velocityClient.opts
									),
									[],
									this.velocityClient.opts
								);
							logger.info(
								`Potential arb with sig: ${txResult.txSig}. Check the blockchain for confirmation.`
							);
						} catch (e) {
							logger.error('Failed to send tx', e);
							try {
								const simError = e as SendTransactionError;
								const errorCode = getErrorCode(simError);

								if (simError.logs && simError.logs.length > 0) {
									const start = Date.now();
									this.handleTransactionLogs(
										bidMakerInfo,
										askMakerInfo,
										perpIdx,
										simError.logs
									);
									logger.error(
										`Failed to send tx, sim error tx logs took: ${
											Date.now() - start
										}ms)`
									);

									if (
										errorCode &&
										!errorCodesToSuppress.includes(errorCode) &&
										!(e as Error).message.includes(
											'Transaction was not confirmed'
										)
									) {
										console.error(`Unsurpressed error:\n`, e);
										webhookMessage(
											`[${this.name}]: :x: error simulating tx:\n${
												simError.logs ? simError.logs.join('\n') : ''
											}\n${simError.stack || e}`
										);
									} else {
										if (errorCode === 6006) {
											logger.warn('No arb opportunity');
										} else if (errorCode === 6004 || errorCode === 6005) {
											logger.warn('No bid/ask, Orderbook was slow');
										}
									}
								}
							} catch (e) {
								if (e instanceof Error) {
									logger.error(
										`Error sending arb tx on market index ${perpIdx} with detected market ${bestBidPrice}@${bestAskPrice}: ${
											e.stack ? e.stack : e.message
										}`
									);
								}
							}
						}
					}
				}
				logger.debug(`done: ${Date.now() - start}ms`);
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

	private async settlePnls() {
		const user = this.velocityClient.getUser();
		const marketIds = user
			.getActivePerpPositions()
			.filter((pos) => !pos.quoteAssetAmount.eq(ZERO))
			.map((pos) => pos.marketIndex);
		if (marketIds.length === 0) {
			return;
		}

		const now = Date.now();
		if (now < this.lastSettlePnl + SETTLE_POSITIVE_PNL_COOLDOWN_MS) {
			logger.info(`Want to settle positive pnl, but in cooldown...`);
		} else {
			const settlePnlPromises: Array<Promise<TxSigAndSlot>> = [];
			for (let i = 0; i < marketIds.length; i += SETTLE_PNL_CHUNKS) {
				const marketIdChunks = marketIds.slice(i, i + SETTLE_PNL_CHUNKS);
				try {
					const ixs = [
						ComputeBudgetProgram.setComputeUnitLimit({
							units: 2_000_000,
						}),
					];
					ixs.push(
						...(await this.velocityClient.getSettlePNLsIxs(
							[
								{
									settleeUserAccountPublicKey: user.getUserAccountPublicKey(),
									settleeUserAccount:
										this.velocityClient.getUserAccountOrThrow()!,
								},
							],
							marketIdChunks
						))
					);
					settlePnlPromises.push(
						this.velocityClient.txSender.sendVersionedTransaction(
							await this.velocityClient.txSender.getVersionedTransaction(
								ixs,
								this.lookupTableAccounts!,
								[],
								this.velocityClient.opts
							),
							[],
							this.velocityClient.opts
						)
					);
				} catch (err) {
					if (!(err instanceof Error)) {
						return;
					}
					const errorCode = getErrorCode(err) ?? 0;
					logger.error(
						`Error code: ${errorCode} while settling pnls for markets ${JSON.stringify(
							marketIds
						)}: ${err.message}`
					);
					console.error(err);
				}
			}
			try {
				const txs = await Promise.all(settlePnlPromises);
				for (const tx of txs) {
					logger.info(
						`Settle positive PNLs tx: https://solscan/io/tx/${tx.txSig}`
					);
				}
			} catch (e) {
				logger.error('Error settling pnls: ', e);
			}
			this.lastSettlePnl = now;
		}
	}
}
