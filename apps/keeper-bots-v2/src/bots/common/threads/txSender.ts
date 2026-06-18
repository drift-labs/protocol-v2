import { logger } from '../../../logger';
import { sleepMs } from '../../../utils';
import {
	IpcMessageMap,
	IpcMessageTypes,
	TransactionPayload,
	TxSenderMetrics,
} from './types';
import {
	simulateAndGetTxWithCUs,
	SimulateAndGetTxWithCUsResponse,
} from '../../../utils';
import { Wallet as AnchorWallet } from '@coral-xyz/anchor';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';
import {
	BlockhashSubscriber,
	loadKeypair,
	SlotSubscriber,
} from '@drift-labs/sdk';
import {
	Connection,
	BlockhashWithExpiryBlockHeight,
	ConfirmOptions,
	TransactionInstruction,
	TransactionSignature,
	VersionedTransaction,
	PublicKey,
	Signer,
	AddressLookupTableAccount,
	Logs,
	Context,
} from '@solana/web3.js';
import { LRUCache } from 'lru-cache';

const CONFIRM_TX_INTERVAL_MS = 15_000;
const CONFIRM_TX_RATE_LIMIT_BACKOFF_MS = 5_000;
const TX_CONFIRMATION_BATCH_SIZE = 50;
const TX_TIMEOUT_THRESHOLD_MS = 1000 * 60 * 10; // 10 minutes
const LOG_PREFIX = '[TxSender]';

export type TxSenderConfig = {
	connection: Connection;
	blockhashSubscriber: BlockhashSubscriber;
	slotSubscriber: SlotSubscriber;
	resendInterval: number;
	sendTxEnabled: boolean;
};

export class TxSender {
	private connection: Connection;
	private additionalSendTxConnections: Connection[];
	private blockhashSubscriber: BlockhashSubscriber;
	private slotSubscriber: SlotSubscriber;
	private sendTxOpts: ConfirmOptions;
	private running: boolean;
	private sendTxEnabled: boolean;

	private txConfirmationConnection: Connection;
	private txToSendPayload: TransactionPayload[];
	private pendingTxSigsToConfirm = new LRUCache<
		string,
		{
			ts: number;
			slot: number;
			simSlot?: number;
		}
	>({
		max: 10_000,
		ttl: TX_TIMEOUT_THRESHOLD_MS,
		ttlResolution: 1000,
		disposeAfter: this.recordEvictedTxSig.bind(this),
	});
	private confirmLoopRunning = false;
	private lastConfirmLoopRunTs = Date.now() - CONFIRM_TX_RATE_LIMIT_BACKOFF_MS;
	private pendingTxSigsInterval?: NodeJS.Timeout;
	private signers: Map<string, AnchorWallet> = new Map();
	private addressLookupTables: Map<string, AddressLookupTableAccount> =
		new Map();

	private resendInterval: number;
	private metrics: TxSenderMetrics;

	constructor(config: TxSenderConfig) {
		this.connection = config.connection;
		this.txConfirmationConnection = new Connection(
			'https://api.mainnet-beta.solana.com'
		);
		this.blockhashSubscriber = config.blockhashSubscriber;
		this.slotSubscriber = config.slotSubscriber;
		this.resendInterval = config.resendInterval ?? 2000;
		this.additionalSendTxConnections = []; // TODO: pass in additional RPCs to send txs to
		this.sendTxOpts = {
			commitment: 'confirmed',
			maxRetries: 0,
			skipPreflight: true,
		};
		this.sendTxEnabled = config.sendTxEnabled;

		this.running = false;
		this.txToSendPayload = [];
		this.metrics = {
			txEnabled: this.sendTxEnabled ? 1 : 0,
			txLanded: 0,
			txAttempted: 0,
			txDroppedTimeout: 0,
			txDroppedBlockhashExpired: 0,
			txFailedSimulation: 0,
			pendingQueueSize: 0,
			lruEvictedTxs: 0,
			confirmQueueSize: 0,
			txRetried: 0,
			txConfirmRateLimited: 0,
			txConfirmedFromWs: 0,
		};
		logger.info(
			`${LOG_PREFIX} TxSender initialized, connection: ${
				this.connection.rpcEndpoint
			}, additionalConns: ${this.additionalSendTxConnections
				.map((conn) => conn.rpcEndpoint)
				.join(', ')}`
		);
	}

	setTransactionsEnabled(state: boolean) {
		this.sendTxEnabled = state;
	}

	async subscribe() {
		let blockhash = this.blockhashSubscriber.getLatestBlockhash(5);
		while (!blockhash) {
			logger.info(
				`${LOG_PREFIX} waiting for blockhash subscriber to update...`
			);
			await sleepMs(1000);
			blockhash = this.blockhashSubscriber.getLatestBlockhash(5);
		}

		this.running = true;
		this.startTxSenderLoop();

		this.pendingTxSigsInterval = setInterval(() => {
			this.confirmPendingTxSigs();
		}, CONFIRM_TX_INTERVAL_MS);
	}

	async unsubscribe() {
		this.running = false;
		if (this.pendingTxSigsInterval) {
			clearInterval(this.pendingTxSigsInterval);
		}
	}

	getMetrics(): TxSenderMetrics {
		this.metrics.confirmQueueSize = this.pendingTxSigsToConfirm.size;
		this.metrics.pendingQueueSize = this.txToSendPayload.length;
		this.metrics.txEnabled = this.sendTxEnabled ? 1 : 0;
		return this.metrics;
	}

	private async listenToTxLogs(accountPubkey: PublicKey) {
		this.connection.onLogs(
			accountPubkey,
			(logs: Logs, ctx: Context) => {
				// sim result
				if (
					logs.signature ===
					'1111111111111111111111111111111111111111111111111111111111111111'
				) {
					return;
				}

				const txInsert = this.pendingTxSigsToConfirm.get(logs.signature);
				if (txInsert) {
					this.pendingTxSigsToConfirm.delete(logs.signature);
					this.metrics.txConfirmedFromWs++;
					this.metrics.txLanded++;

					const confirmedAge = Date.now() - txInsert.ts;
					const slotAge = ctx.slot - txInsert.slot;
					logger.info(
						`${LOG_PREFIX} Tx confirmed from ws: ${logs.signature} (${confirmedAge}ms elapsed, slots elapsed: ${slotAge}, current slot: ${ctx.slot}, txSlot: ${txInsert.slot}, txSimSlot: ${txInsert.simSlot})`
					);
				}
			},
			'confirmed'
		);
	}

	private async confirmPendingTxSigs() {
		const nextTimeCanRun =
			this.lastConfirmLoopRunTs + CONFIRM_TX_RATE_LIMIT_BACKOFF_MS;
		if (Date.now() < nextTimeCanRun) {
			logger.warn(
				`Skipping confirm loop due to rate limit, next run in ${
					nextTimeCanRun - Date.now()
				} ms`
			);
			this.metrics.txConfirmRateLimited++;
			return;
		}
		if (this.confirmLoopRunning) {
			return;
		}
		this.confirmLoopRunning = true;
		if (!this.running) {
			return;
		}
		try {
			const txEntries = Array.from(this.pendingTxSigsToConfirm.entries());
			for (let i = 0; i < txEntries.length; i += TX_CONFIRMATION_BATCH_SIZE) {
				const txSigsBatch = txEntries.slice(i, i + TX_CONFIRMATION_BATCH_SIZE);
				const txs = await this.txConfirmationConnection.getTransactions(
					txSigsBatch.map((tx) => tx[0]),
					{
						commitment: 'confirmed',
						maxSupportedTransactionVersion: 0,
					}
				);
				for (let j = 0; j < txs.length; j++) {
					const txResp = txs[j];
					const txConfirmationInfo = txSigsBatch[j];
					const txSig = txConfirmationInfo[0];
					const txAge = txConfirmationInfo[1].ts - Date.now();
					if (!this.pendingTxSigsToConfirm.has(txSig)) {
						continue;
					}
					if (txResp === null) {
						if (Math.abs(txAge) > TX_TIMEOUT_THRESHOLD_MS) {
							logger.info(
								`${LOG_PREFIX} Tx not found after ${
									txAge / 1000
								}s, untracking: ${txSig}`
							);
							this.metrics.txDroppedTimeout++;
							this.pendingTxSigsToConfirm.delete(txSig);
						}
					} else {
						const confirmedAge =
							txConfirmationInfo[1].ts / 1000 -
							(txResp.blockTime ?? Date.now() / 1000);
						logger.info(
							`${LOG_PREFIX} Tx landed: ${txSig}, confirmed tx age: ${confirmedAge}s, slot: ${txResp.slot}`
						);
						this.metrics.txLanded++;
						this.pendingTxSigsToConfirm.delete(txSig);
					}
					await sleepMs(500);
				}
			}
			// const txSigConfirmDuration = Date.now() - start;
		} catch (e) {
			const err = e as Error;
			if (err.message.includes('429')) {
				logger.info(
					`${LOG_PREFIX} Confirming tx loop rate limited: ${err.message}`
				);
				this.lastConfirmLoopRunTs =
					Date.now() + CONFIRM_TX_RATE_LIMIT_BACKOFF_MS;
			} else {
				logger.error(
					`${LOG_PREFIX} Other error confirming tx sigs: ${err.message}`
				);
			}
		} finally {
			this.confirmLoopRunning = false;
		}
	}

	private recordEvictedTxSig(
		_value: { ts: number },
		key: string,
		reason: string
	) {
		if (reason === 'evict') {
			this.metrics.lruEvictedTxs++;
			logger.info(`${LOG_PREFIX} Evicted tx from lru cache: ${key}`);
		}
	}

	async addTxPayload(txPayload: IpcMessageMap[IpcMessageTypes.TRANSACTION]) {
		this.txToSendPayload.push({
			instruction: txPayload,
			addressLookupTables: await Promise.all(
				txPayload.addressLookupTables.map((lut) =>
					this.mustGetAddressLookupTable(lut)
				)
			),
		});
	}

	async addTxToConfirm(
		txPayload: IpcMessageMap[IpcMessageTypes.CONFIRM_TRANSACTION]
	) {
		this.pendingTxSigsToConfirm.set(txPayload.confirmTxSig, {
			ts: Date.now(),
			slot: this.slotSubscriber.getSlot(),
		});
		this.metrics.txAttempted++;
	}

	addSigner(signerKey: string, signerInfo: string) {
		const keypair = loadKeypair(signerInfo);
		logger.info(
			`${LOG_PREFIX} adding new signer: ${signerKey}: info: ${signerInfo.slice(
				0,
				10
			)}... (${signerInfo.length} len), ${keypair.publicKey.toBase58()}`
		);
		this.listenToTxLogs(keypair.publicKey);
		this.signers.set(signerKey, new AnchorWallet(keypair));
	}

	async addAddressLookupTable(address: string) {
		if (!this.addressLookupTables.has(address)) {
			logger.info(`${LOG_PREFIX} adding new address lookup table: ${address}`);
			const resp = await this.connection.getAddressLookupTable(
				new PublicKey(address)
			);
			if (resp.value) {
				this.addressLookupTables.set(address, resp.value);
			} else {
				logger.error(
					`${LOG_PREFIX} Failed to get address lookup table for ${address}`
				);
			}
		}
	}

	async mustGetAddressLookupTable(
		address: string
	): Promise<AddressLookupTableAccount> {
		if (!this.addressLookupTables.has(address)) {
			logger.error(
				`${LOG_PREFIX} Address lookup table not found for ${address}, adding it...`
			);
			await this.addAddressLookupTable(address);
		}
		return this.addressLookupTables.get(address)!;
	}

	private async buildTransactionToSend(
		ixs: TransactionInstruction[],
		lookupTableAccounts: AddressLookupTableAccount[] | undefined,
		payerPublicKey: PublicKey,
		simulateForCus = true
	): Promise<{
		simResult: SimulateAndGetTxWithCUsResponse;
		blockhash: BlockhashWithExpiryBlockHeight;
	}> {
		const blockhash = this.blockhashSubscriber.getLatestBlockhash(5);
		const simResult = await simulateAndGetTxWithCUs({
			ixs,
			connection: this.connection,
			payerPublicKey,
			lookupTableAccounts: lookupTableAccounts ?? [],
			cuLimitMultiplier: 1.1,
			doSimulation: simulateForCus,
			recentBlockhash: blockhash?.blockhash,
		});

		return {
			simResult,
			blockhash: blockhash!,
		};
	}

	private async sendVersionedTransaction(
		tx: VersionedTransaction,
		signers: Signer[],
		opts?: ConfirmOptions
	): Promise<{ txRaw: Buffer | Uint8Array; txSig: TransactionSignature }> {
		tx.sign(signers);
		const txRaw = tx.serialize();
		this.sendRawTransaction(txRaw, opts);

		const txSig = bs58.encode(tx.signatures[0]);
		return {
			txRaw,
			txSig,
		};
	}

	private sendToAdditionalConnections(
		rawTx: Buffer | Uint8Array,
		opts?: ConfirmOptions
	): void {
		this.additionalSendTxConnections.map((connection: Connection) => {
			connection.sendRawTransaction(rawTx, opts).catch((e) => {
				console.error(
					// @ts-ignore
					`${LOG_PREFIX} error sending tx to additional connection: ${connection._rpcEndpoint}`
				);
				console.error(e);
			});
		});
	}

	private sendRawTransaction(
		rawTransaction: Buffer | Uint8Array,
		opts?: ConfirmOptions
	) {
		this.connection.sendRawTransaction(rawTransaction, opts);
		this.sendToAdditionalConnections(rawTransaction, opts);
	}

	private async runTxSenderLoop() {
		const work = this.txToSendPayload.shift();
		if (!work) {
			return;
		}

		// 1) handle any expired transactions
		let txExpired = false;
		if (work.blockhashExpiryHeight) {
			const blockHeight = this.blockhashSubscriber.getLatestBlockHeight();
			if (blockHeight > work.blockhashExpiryHeight) {
				logger.info(
					`${LOG_PREFIX} Blockhash expired for tx: ${work.lastSentTxSig}, retrying: ${work.instruction.retryUntilConfirmed}`
				);
				if (work.instruction.retryUntilConfirmed) {
					txExpired = true;
				} else {
					this.pendingTxSigsToConfirm.delete(work.lastSentTxSig!);
					this.metrics.txDroppedBlockhashExpired++;
					return;
				}
			}
		}

		const now = Date.now();
		const txReadyToRetry = now > (work.lastSendTs ?? 0) + this.resendInterval;
		const firstTimeSendingTx = work.lastSendTs === undefined;
		const txPreviouslySent = work.lastSentRawTx !== undefined;

		// 2) check if the tx has been confirmed
		if (!firstTimeSendingTx) {
			if (!this.pendingTxSigsToConfirm.has(work.lastSentTxSig!)) {
				return;
			}
		}

		// 3) send the tx if it's the first time or ready to retry
		// Build a new tx with a fresh blockhash. TODO: need a fresh priority fee?
		if (txExpired || firstTimeSendingTx) {
			const signers: AnchorWallet[] = [];
			for (const signerKey of work.instruction.signerKeys) {
				const signer = this.signers.get(signerKey);
				if (!signer) {
					throw new Error(`${LOG_PREFIX} Signer not found for ${signerKey}`);
				}
				signers.push(signer);
			}
			if (signers.length === 0) {
				throw new Error(`${LOG_PREFIX} No signers found for tx`);
			}

			const { simResult, blockhash } = await this.buildTransactionToSend(
				work.instruction.ixs,
				work.addressLookupTables,
				signers[0].publicKey,
				work.instruction.simulateCUs
			);

			if (simResult.simError === null) {
				work.lastSendTs = Date.now();
				if (this.sendTxEnabled) {
					const txResp = await this.sendVersionedTransaction(
						simResult.tx,
						signers.map((signer) => signer.payer),
						this.sendTxOpts
					);
					work.lastSentTxSig = txResp.txSig;
					work.lastSentTx = simResult.tx;
					work.lastSentRawTx = txResp.txRaw;
					work.blockhashExpiryHeight = blockhash.lastValidBlockHeight;
					work.blockhashUsed = blockhash.blockhash;
					this.pendingTxSigsToConfirm.set(work.lastSentTxSig!, {
						ts: Date.now(),
						slot: this.slotSubscriber.getSlot(),
						simSlot: simResult.simSlot,
					});
					this.txToSendPayload.push(work);
				} else {
					logger.info(
						`${LOG_PREFIX} sendTxEnabled=false, cuEst: ${
							simResult.cuEstimate
						} simError: ${JSON.stringify(
							simResult.simError
						)}, sim logs:\n${JSON.stringify(simResult.simTxLogs, null, 2)}`
					);
				}
				this.metrics.txAttempted++;
			} else {
				this.metrics.txFailedSimulation++;
				logger.error(
					`${LOG_PREFIX} TxSimulationFailed: ${JSON.stringify(
						simResult.simError
					)}: simLogs:\n${JSON.stringify(simResult.simTxLogs, null, 2)}`
				);
			}
		} else if (txPreviouslySent && txReadyToRetry) {
			if (work.instruction.simOnRetry && work.lastSentTx) {
				const simResp = await this.connection.simulateTransaction(
					work.lastSentTx,
					{
						sigVerify: false,
						replaceRecentBlockhash: true,
						commitment: 'processed',
					}
				);
				if (simResp.value.err !== null) {
					logger.error(
						`${LOG_PREFIX} TxSimulationFailed: ${JSON.stringify(
							simResp.value.err
						)}\n${JSON.stringify(simResp.value.logs)}`
					);
					this.metrics.txFailedSimulation++;
					return;
				}
			}
			if (this.sendTxEnabled) {
				this.sendRawTransaction(work.lastSentRawTx!, this.sendTxOpts);
				work.lastSendTs = Date.now();
				this.txToSendPayload.push(work);
				this.metrics.txRetried++;
			} else {
				logger.info(
					`${LOG_PREFIX} sendTxEnabled=false, skipping retry ${work.lastSentTxSig}`
				);
			}
		} else {
			// not ready to retry, push it back to the queue
			this.txToSendPayload.push(work);
		}
	}

	private async startTxSenderLoop() {
		logger.info(`${LOG_PREFIX} TxSender started`);
		while (this.running) {
			try {
				await this.runTxSenderLoop();
			} catch (e) {
				const err = e as Error;
				logger.error(
					`${LOG_PREFIX} Error in txSenderLoop: ${err.message}\n${err.stack}`
				);
			}

			// let the event loop run
			await sleepMs(10);
		}
		logger.info(`${LOG_PREFIX} TxSender stopped`);
	}
}
