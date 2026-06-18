import { SlotSubscriber } from '@drift-labs/sdk';
import {
	Connection,
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
	SystemProgram,
	TransactionInstruction,
	VersionedTransaction,
} from '@solana/web3.js';
import {
	SearcherClient,
	searcherClient,
} from 'jito-ts/dist/sdk/block-engine/searcher';
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types';
import { logger } from './logger';
import { BundleResult } from 'jito-ts/dist/gen/block-engine/bundle';
import { LRUCache } from 'lru-cache';
import WebSocket from 'ws';
import { bs58 } from '@project-serum/anchor/dist/cjs/utils/bytes';
import { sleepMs } from './utils';

export const jitoBundlePriceEndpoint =
	'wss://bundles.jito.wtf/api/v1/bundles/tip_stream';

const logPrefix = '[BundleSender]';
const MS_DELAY_BEFORE_CHECK_INCLUSION = 30_000;
const MAX_TXS_TO_CHECK = 50;
const RECONNECT_DELAY_MS = 5000;
const RECONNECT_RESET_DELAY_MS = 30000;

export enum JITO_METRIC_TYPES {
	jito_connected = 'jito_connected',
	jito_bundles_accepted = 'jito_bundles_accepted',
	jito_bundles_simulation_failure = 'jito_simulation_failure',
	jito_dropped_bundle = 'jito_dropped_bundle',
	jito_landed_tips = 'jito_landed_tips',
	jito_bundle_count = 'jito_bundle_count',
}

export type TipStream = {
	time: string;
	ts: number; // millisecond timestamp
	landed_tips_25th_percentile: number; // in SOL
	landed_tips_50th_percentile: number; // in SOL
	landed_tips_75th_percentile: number; // in SOL
	landed_tips_95th_percentile: number; // in SOL
	landed_tips_99th_percentile: number; // in SOL
	ema_landed_tips_50th_percentile: number; // in SOL
};

export type DropReason = 'pruned' | 'blockhash_expired' | 'blockhash_not_found';

export type BundleStats = {
	accepted: number;
	stateAuctionBidRejected: number;
	winningBatchBidRejected: number;
	simulationFailure: number;
	internalError: number;
	droppedBundle: number;

	/// extra stats
	droppedPruned: number;
	droppedBlockhashExpired: number;
	droppedBlockhashNotFound: number;
};

const initBundleStats: BundleStats = {
	accepted: 0,
	stateAuctionBidRejected: 0,
	winningBatchBidRejected: 0,
	simulationFailure: 0,
	internalError: 0,
	droppedBundle: 0,
	droppedPruned: 0,
	droppedBlockhashExpired: 0,
	droppedBlockhashNotFound: 0,
};

export class BundleSender {
	private ws: WebSocket | undefined;
	private searcherClient: SearcherClient | undefined;
	private leaderScheduleIntervalId: NodeJS.Timeout | undefined;
	private checkSentTxsIntervalId: NodeJS.Timeout | undefined;
	private isSubscribed = false;
	private shuttingDown = false;
	private jitoTipAccounts: PublicKey[] = [];
	private nextJitoLeader?: {
		currentSlot: number;
		nextLeaderSlot: number;
		nextLeaderIdentity: string;
	};
	private updatingJitoSchedule = false;
	private checkingSentTxs = false;
	private reconnectAttempts = 0;
	private lastReconnectTime = 0;
	private reconnecting = false;

	// if there is a big difference, probably jito ws connection is bad, should resub
	private bundlesSent = 0;
	private bundleResultsReceived = 0;

	// `bundleIdToTx` will be populated immediately after sending a bundle.
	private bundleIdToTx: LRUCache<string, { tx: string; ts: number }>;
	// `sentTxCache` will only be populated after a bundle result is received.
	// reason being that sometimes results come really late (like minutes after sending)
	// unsure if this is a jito issue or this bot is inefficient and holding onto things
	// for that long. Check txs from this map to see if they landed.
	private sentTxCache: LRUCache<string, number>;

	/// -1 for each accepted bundle, +1 for each rejected (due to bid, don't count sim errors).
	private failBundleCount = 0;
	private countLandedBundles = 0;
	private countDroppedbundles = 0;

	private lastTipStream: TipStream | undefined;
	private bundleStats: BundleStats = initBundleStats;

	constructor(
		private connection: Connection,
		private jitoBlockEngineUrl: string,
		private jitoAuthKeypair: Keypair,
		public tipPayerKeypair: Keypair,
		private slotSubscriber: SlotSubscriber,

		/// tip algo params
		public strategy: 'non-jito-only' | 'jito-only' | 'hybrid' = 'jito-only',
		private minBundleTip = 10_000, // cant be lower than this
		private maxBundleTip = 100_000,
		private maxFailBundleCount = 100, // at 100 failed txs, can expect tip to become maxBundleTip
		private tipMultiplier = 3 // bigger == more superlinear, delay the ramp up to prevent overpaying too soon
	) {
		this.bundleIdToTx = new LRUCache({
			max: 500,
		});
		this.sentTxCache = new LRUCache({
			max: 500,
		});
	}

	slotsUntilNextLeader(): number | undefined {
		if (!this.nextJitoLeader) {
			return undefined;
		}
		return this.nextJitoLeader.nextLeaderSlot - this.slotSubscriber.getSlot();
	}

	connected(): boolean {
		return (
			// tip stream connected
			this.ws !== undefined &&
			this.ws.readyState === WebSocket.OPEN &&
			// searcher client connected
			this.searcherClient !== undefined &&
			// next jito leader is set
			this.nextJitoLeader !== undefined
		);
	}

	getBundleStats(): BundleStats {
		return this.bundleStats;
	}

	getTipStream(): TipStream | undefined {
		return this.lastTipStream;
	}

	getBundleFailCount(): number {
		return this.failBundleCount;
	}

	getLandedCount(): number {
		return this.countLandedBundles;
	}

	getDroppedCount(): number {
		return this.countDroppedbundles;
	}

	private incRunningBundleScore(amount = 1) {
		this.failBundleCount =
			(this.failBundleCount + amount) % this.maxFailBundleCount;
	}

	private decRunningBundleScore(amount = 1) {
		this.failBundleCount = Math.max(this.failBundleCount - amount, 0);
	}

	private handleBundleResult(bundleResult: BundleResult) {
		const bundleId = bundleResult.bundleId;
		const bundlePayload = this.bundleIdToTx.get(bundleId);
		if (!bundlePayload) {
			logger.error(
				`${logPrefix}: got bundle result for unknown bundleId: ${bundleId}`
			);
		}
		const now = Date.now();

		// Update bundle score. -1 for accept, +1 for reject.
		// Large score === many failures.
		// If the count is 0, we pay min tip, if max, we pay max tip.
		if (bundleResult.accepted !== undefined) {
			this.bundleStats.accepted++;
			if (bundlePayload !== undefined) {
				if (now > bundlePayload.ts + MS_DELAY_BEFORE_CHECK_INCLUSION) {
					logger.error(
						`${logPrefix}: received a bundle result ${MS_DELAY_BEFORE_CHECK_INCLUSION} ms after sending. tx: ${bundlePayload.tx}, sent at: ${bundlePayload.ts}`
					);
				} else {
					this.sentTxCache.set(bundlePayload.tx, bundlePayload.ts);
				}
			}
		} else if (bundleResult.rejected !== undefined) {
			if (bundleResult.rejected.droppedBundle !== undefined) {
				this.bundleStats.droppedBundle++;
				const msg = bundleResult.rejected.droppedBundle.msg;
				if (msg.includes('pruned at slot')) {
					this.bundleStats.droppedPruned++;
				} else if (msg.includes('blockhash has expired')) {
					this.bundleStats.droppedBlockhashExpired++;
				} else if (msg.includes('Blockhash not found')) {
					this.bundleStats.droppedBlockhashNotFound++;
				}
			} else if (bundleResult.rejected.internalError !== undefined) {
				this.bundleStats.internalError++;
			} else if (bundleResult.rejected.simulationFailure !== undefined) {
				this.bundleStats.simulationFailure++;
			} else if (bundleResult.rejected.stateAuctionBidRejected !== undefined) {
				this.bundleStats.stateAuctionBidRejected++;
			} else if (bundleResult.rejected.winningBatchBidRejected !== undefined) {
				this.bundleStats.winningBatchBidRejected++;
			}
		}
	}
	private connectJitoTipStream() {
		if (this.ws !== undefined) {
			logger.warn(
				`${logPrefix} Called connectJitoTipStream but this.ws is already connected, disconnecting it...`
			);
			this.ws.close();
			this.ws = undefined;
		}

		logger.info(
			`${logPrefix} establishing jito ws connection (${jitoBundlePriceEndpoint})`
		);

		const connect = () => {
			this.ws = new WebSocket(jitoBundlePriceEndpoint);

			this.ws.on('open', () => {
				logger.info(
					`${logPrefix} WebSocket connection established, resetting bundle stats`
				);
				this.bundleStats = initBundleStats;
				this.bundlesSent = 0;
				this.bundleResultsReceived = 0;
			});

			this.ws.on('message', (data: string) => {
				try {
					const tipStream = JSON.parse(data) as Array<TipStream>;
					if (tipStream.length > 0) {
						tipStream[0].ts = new Date(tipStream[0].time).getTime();
						this.lastTipStream = tipStream[0];
					}
				} catch (error) {
					logger.error(
						`${logPrefix} Error parsing WebSocket message: ${error}`
					);
				}
			});

			this.ws.on('close', (code: number, reason: string) => {
				logger.info(
					`${logPrefix}: jito ws closed (code: ${code}, reason: ${reason}) ${
						this.shuttingDown ? 'shutting down...' : 'reconnecting in 5s...'
					}`
				);
				this.ws = undefined;
				if (!this.shuttingDown) {
					setTimeout(connect, 5000);
				}
			});

			this.ws.on('error', (e) => {
				logger.error(`${logPrefix}: jito ws error: ${e.message}`);
			});
		};

		connect();
	}

	private getBackoffTimeForReconnectAttempts(): number {
		return Math.min(
			RECONNECT_DELAY_MS * this.reconnectAttempts,
			RECONNECT_RESET_DELAY_MS
		);
	}

	private async connectSearcherClient() {
		const now = Date.now();

		logger.info(
			`${logPrefix}: connecting searcherClient. lastReconnectTime: ${
				now - this.lastReconnectTime
			}ms ago. reconnecting: ${this.reconnecting}. reconnectAttempts: ${
				this.reconnectAttempts
			}`
		);
		if (this.reconnecting) {
			logger.info(`${logPrefix}: already reconnecting, skipping...`);
			return;
		}

		if (now - this.lastReconnectTime > RECONNECT_RESET_DELAY_MS) {
			this.reconnectAttempts = 0;
		}

		try {
			this.reconnecting = true;
			this.searcherClient = searcherClient(
				this.jitoBlockEngineUrl,
				this.jitoAuthKeypair,
				{
					'grpc.keepalive_time_ms': 10_000,
					'grpc.keepalive_timeout_ms': 1_000,
					'grpc.keepalive_permit_without_calls': 1,
				}
			);

			this.searcherClient.onBundleResult(
				(bundleResult: BundleResult) => {
					logger.info(
						`${logPrefix}: got bundle result: ${JSON.stringify(bundleResult)}`
					);
					this.bundleResultsReceived++;
					this.handleBundleResult(bundleResult);
				},
				async (err: Error) => {
					logger.error(
						`${logPrefix}: error getting bundle result, retrying in: ${RECONNECT_DELAY_MS}ms. msg: ${err.message}`
					);
					if (this.shuttingDown) {
						logger.info(`${logPrefix}: shutting down, skipping reconnect`);
						return;
					}

					this.reconnectAttempts++;
					this.lastReconnectTime = Date.now();

					await sleepMs(this.getBackoffTimeForReconnectAttempts());
					await this.connectSearcherClient();
				}
			);

			// Reset attempts on successful connection
			this.reconnectAttempts = 0;

			const tipAccounts = await this.searcherClient.getTipAccounts();
			this.jitoTipAccounts = tipAccounts.map((k) => new PublicKey(k));

			this.reconnecting = false;
		} catch (e) {
			const err = e as Error;
			logger.error(
				`${logPrefix}: Failed to connect searcherClient, retrying in: ${RECONNECT_DELAY_MS}ms. msg: ${err.message}`
			);
			this.reconnectAttempts++;
			this.lastReconnectTime = Date.now();

			await sleepMs(this.getBackoffTimeForReconnectAttempts());
			await this.connectSearcherClient();
		} finally {
			this.reconnecting = false;
		}
	}

	async subscribe() {
		if (this.isSubscribed) {
			return;
		}
		this.isSubscribed = true;
		this.shuttingDown = false;

		await this.connectSearcherClient();
		this.connectJitoTipStream();

		this.slotSubscriber.eventEmitter.on(
			'newSlot',
			this.onSlotSubscriberSlot.bind(this)
		);
		this.leaderScheduleIntervalId = setInterval(
			this.updateJitoLeaderSchedule.bind(this),
			1000
		);
		this.checkSentTxsIntervalId = setInterval(
			this.checkSentTxs.bind(this),
			10000
		);
	}

	async unsubscribe() {
		if (!this.isSubscribed) {
			return;
		}
		this.shuttingDown = true;

		this.searcherClient = undefined;

		if (this.ws) {
			this.ws.close();
		}

		if (this.leaderScheduleIntervalId) {
			clearInterval(this.leaderScheduleIntervalId);
			this.leaderScheduleIntervalId = undefined;
		}

		if (this.checkSentTxsIntervalId) {
			clearInterval(this.checkSentTxsIntervalId);
			this.checkSentTxsIntervalId = undefined;
		}

		this.isSubscribed = false;
	}

	private async onSlotSubscriberSlot(slot: number) {
		if (this.nextJitoLeader) {
			const jitoSlot = this.nextJitoLeader.nextLeaderSlot;
			if (slot >= jitoSlot) {
				if (slot >= jitoSlot - 2) {
					logger.debug(
						`${logPrefix}: currSlot: ${slot}, next jito leader slot: ${jitoSlot} (in ${
							jitoSlot - slot
						} slots)`
					);
					this.updateJitoLeaderSchedule();
				}
			}
		}
	}

	private async checkSentTxs() {
		if (this.checkingSentTxs) {
			return;
		}
		this.checkingSentTxs = true;
		try {
			// find txs in cache ready to check
			const now = Date.now();
			const txs = [];
			for (const [tx, ts] of this.sentTxCache.entries()) {
				if (now - ts > MS_DELAY_BEFORE_CHECK_INCLUSION) {
					this.sentTxCache.delete(tx);
					txs.push(tx);
				}
				if (txs.length >= MAX_TXS_TO_CHECK) {
					break;
				}
			}
			if (txs.length === 0) {
				logger.info(`${logPrefix} no txs to check...`);
			} else {
				const resps = await this.connection.getTransactions(txs, {
					commitment: 'confirmed',
					maxSupportedTransactionVersion: 0,
				});
				const droppedTxs = resps.filter((tx) => tx === null);
				const landedTxs = resps.filter((tx) => tx !== null);

				this.countDroppedbundles += droppedTxs.length;
				this.countLandedBundles += landedTxs.length;
				const countBefore = this.failBundleCount;
				this.incRunningBundleScore(droppedTxs.length);
				this.decRunningBundleScore(landedTxs.length);

				logger.info(
					`${logPrefix} Found ${droppedTxs.length} txs dropped, ${landedTxs.length} landed landed, failCount: ${countBefore} -> ${this.failBundleCount}`
				);
			}
		} catch (e) {
			const err = e as Error;
			logger.error(
				`${logPrefix}: error checking sent txs: ${err.message}. ${err.stack}`
			);
		} finally {
			this.checkingSentTxs = false;
			logger.info(
				`${logPrefix}: running fail count: ${
					this.failBundleCount
				}, totalLandedTxs: ${this.countLandedBundles}, totalDroppedTxs: ${
					this.countDroppedbundles
				}, currentTipAmount: ${this.calculateCurrentTipLamports()}, lastJitoTipStream: ${JSON.stringify(
					this.lastTipStream
				)} bundle stats: ${JSON.stringify(this.bundleStats)}`
			);
		}
	}

	private async updateJitoLeaderSchedule() {
		if (this.updatingJitoSchedule || !this.searcherClient) {
			if (!this.searcherClient) {
				logger.error(
					`${logPrefix} no searcherClient, skipping updateJitoLeaderSchedule`
				);
			}
			return;
		}
		this.updatingJitoSchedule = true;
		try {
			this.nextJitoLeader = await this.searcherClient.getNextScheduledLeader();
		} catch (e) {
			this.nextJitoLeader = undefined;
			const err = e as Error;
			logger.error(
				`${logPrefix}: error checking jito leader schedule: ${err.message}`
			);
		} finally {
			this.updatingJitoSchedule = false;
		}
	}

	/**
	 *
	 * @returns current tip based on running score in lamports
	 */
	public calculateCurrentTipLamports(): number {
		// Calculate tip from tip stream
		const tipStreamLamports =
			(this.lastTipStream?.landed_tips_50th_percentile ?? 0) * LAMPORTS_PER_SOL;

		// Calculate tip from failure count
		const failureBasedTip =
			Math.pow(
				this.failBundleCount / this.maxFailBundleCount,
				this.tipMultiplier
			) * this.maxBundleTip;

		// Take the larger of the two tips, but cap at maxBundleTip
		const tip = Math.min(
			this.maxBundleTip,
			Math.max(tipStreamLamports, failureBasedTip)
		);

		// Ensure we never go below minBundleTip
		return Math.floor(Math.max(this.minBundleTip, tip));
	}

	/**
	 * Returns a transaction instruction for sending a tip to a tip account, use this to prevent adding an extra tx to your bundle, and/or to avoid conflicting tx hashes from the transfer ix. You will need to sign the final tx with the tip payer keypair before sending it in a bundle.
	 * @param tipAccount Optional tip account to send to. If not provided, a random one will be chosen from jitoTipAccounts
	 * @param tipAmount Optional tip amount to send. If not provided, the current tip amount will be calculated
	 * @returns
	 */
	getTipIx(tipAccount?: PublicKey, tipAmount?: number): TransactionInstruction {
		if (!tipAccount) {
			tipAccount =
				this.jitoTipAccounts[
					Math.floor(Math.random() * this.jitoTipAccounts.length)
				];
		}
		if (tipAmount === undefined) {
			tipAmount = this.calculateCurrentTipLamports();
		}
		const tipIx = SystemProgram.transfer({
			fromPubkey: this.tipPayerKeypair.publicKey,
			toPubkey: tipAccount,
			lamports: tipAmount,
		});
		return tipIx;
	}

	/**
	 * Sends a bundle of signed transactions to Jito MEV searcher
	 * @param signedTxs Array of signed versioned transactions to include in bundle
	 * @param metadata Optional metadata string to attach to bundle
	 * @param txSig Optional transaction signature for tracking purposes. If not provided, uses first tx signature
	 * @param addTipTx Whether to add a tip transaction to the bundle, if false, your signedTxs must already include a payment to a tip account. Defaults to true
	 * @throws Error if bundle size would exceed Jito's max of 5 transactions
	 */
	async sendTransactions(
		signedTxs: VersionedTransaction[],
		metadata?: string,
		txSig?: string,
		addTipTx = true
	) {
		const maxAllowedTxs = addTipTx ? 4 : 5;
		if (signedTxs.length > maxAllowedTxs) {
			throw new Error(
				`jito max bundle size is ${maxAllowedTxs}, got ${signedTxs.length} (addTipTx: ${addTipTx})`
			);
		}

		if (!this.isSubscribed) {
			logger.warn(
				`${logPrefix} You should call bundleSender.subscribe() before sendTransaction()`
			);
			await this.subscribe();
			return;
		}

		if (!this.searcherClient) {
			logger.error(`${logPrefix} searcherClient not initialized`);
			return;
		}

		if (this.bundlesSent - this.bundleResultsReceived > 100) {
			logger.warn(
				`${logPrefix} sent ${this.bundlesSent} bundles but only redeived ${this.bundleResultsReceived} results, disconnecting jito ws...`
			);
			// reconnect will happen on ws close message
			this.ws?.close();
		}

		// +1 for tip tx, jito max is 5
		let b: Bundle | Error = new Bundle(signedTxs, maxAllowedTxs);

		if (addTipTx) {
			const tipAccountToUse =
				this.jitoTipAccounts[
					Math.floor(Math.random() * this.jitoTipAccounts.length)
				];
			b = b.addTipTx(
				this.tipPayerKeypair!,
				this.calculateCurrentTipLamports(),
				tipAccountToUse!,
				signedTxs[0].message.recentBlockhash
			);
			if (b instanceof Error) {
				logger.error(`${logPrefix} failed to attach tip: ${b.message})`);
				return;
			}
		}

		try {
			// txSig used for tracking purposes, if none provided, use the sig of the first tx in the bundle
			if (!txSig) {
				txSig = bs58.encode(signedTxs[0].signatures[0]);
			}
			const bundleId = await this.searcherClient.sendBundle(b);
			const ts = Date.now();
			this.bundleIdToTx.set(bundleId, { tx: txSig, ts });
			logger.info(
				`${logPrefix} sent bundle with uuid ${bundleId} (tx: ${txSig}: ${ts}) ${metadata}`
			);
			this.bundlesSent++;
		} catch (e) {
			const err = e as Error;
			logger.error(
				`${logPrefix} failed to send bundle: ${err.message}. ${err.stack}`
			);
		}
	}
}
