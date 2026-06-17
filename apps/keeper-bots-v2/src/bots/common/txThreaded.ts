import { logger } from '../../logger';
import { GaugeValue, Metrics } from '../../metrics';
import { spawnChildWithRetry } from './processUtils';
import {
	IpcMessageMap,
	IpcMessageTypes,
	WrappedIpcMessage,
	TxSenderMetrics,
} from './threads/types';
import { TransactionInstruction } from '@solana/web3.js';
import { ChildProcess, SendHandle, Serializable } from 'child_process';
import path from 'path';

export class TxThreaded {
	protected txThreadProcess?: ChildProcess;
	protected txSendMetricsGauge?: GaugeValue;
	protected _lastTxMetrics?: TxSenderMetrics;
	protected _lastTxThreadMetricsReceived: number;
	private _botIdString: string;

	constructor(botIdString?: string) {
		this._botIdString = botIdString ?? '';
		this._lastTxThreadMetricsReceived = 0;
	}
	get lastTxThreadMetricsReceived(): number {
		return this._lastTxThreadMetricsReceived;
	}

	get pendingQueueSize(): number {
		return this.pendingQueueSize;
	}

	public txThreadSetName(name: string) {
		this._botIdString = name;
	}

	/**
	 * Sends a notification to the txThread to close and waits for it to exit
	 */
	protected async terminateTxThread() {
		if (!this.txThreadProcess) {
			logger.info(`[TxThreaded] No txThread process to terminate`);
			return;
		}

		this.txThreadProcess.send({
			type: IpcMessageTypes.NOTIFICATION,
			data: {
				message: 'close',
			},
		});

		// terminate child txThread
		logger.info(`[TxThreaded] Waiting 5s for txThread to close...`);
		for (let i = 0; i < 5; i++) {
			if (
				this.txThreadProcess.exitCode !== null ||
				this.txThreadProcess.killed
			) {
				break;
			}
			logger.info(`[TxThreaded] Child thread still alive ...`);
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}

		if (!this.txThreadProcess.killed) {
			logger.info(`[TxThreaded] Child thread still alive 🔪...`);
			this.txThreadProcess.kill();
		}
		logger.info(
			`[TxThreaded] Child thread exit code: ${this.txThreadProcess.exitCode}`
		);
	}

	protected initializeTxThreadMetrics(metrics: Metrics, meterName: string) {
		this.txSendMetricsGauge = metrics.addGauge(
			'tx_sender_metrics',
			'TxSender thread metrics',
			meterName
		);
	}

	/**
	 * Spawns the txThread process
	 */
	protected initTxThread(rpcUrl?: string) {
		// @ts-ignore - This is how to check for tsx unfortunately https://github.com/privatenumber/tsx/issues/49
		const isTsx: boolean = process._preload_modules.some((m: string) =>
			m.includes('tsx')
		);
		const isTsNode = process.argv.some((arg) => arg.includes('ts-node'));
		const isBun = process.versions.bun;
		const isTs = isTsNode || isTsx || isBun;
		const txThreadFileName = isTs ? 'txThread.ts' : 'txThread.js';

		logger.info(
			`[TxThreaded] isTsNode or tsx: ${isTs}, txThreadFileName: ${txThreadFileName}, argv: ${JSON.stringify(
				process.argv
			)}, __dirname: ${__dirname}, __filename: ${__filename}`
		);

		const rpcEndpoint =
			rpcUrl ?? process.env.ENDPOINT ?? process.env.RPC_HTTP_URL;

		if (!rpcEndpoint) {
			throw new Error(
				'Must supply a Solana RPC endpoint through config file or env vars ENDPOINT or RPC_HTTP_URL'
			);
		}

		// {@link ./threads/txThread.ts}
		this.txThreadProcess = spawnChildWithRetry(
			path.join(
				__dirname,
				isTs ? 'threads' : './bots/common/threads',
				txThreadFileName
			),
			[`--rpc=${rpcEndpoint}`, `--send-tx=false`], // initially disable transactions
			'txThread',
			(_msg: Serializable, _sendHandle: SendHandle) => {
				const msg = _msg as WrappedIpcMessage;
				switch (msg.type) {
					case IpcMessageTypes.NOTIFICATION: {
						const notification =
							msg.data as IpcMessageMap[IpcMessageTypes.NOTIFICATION];
						logger.info(`Notification from child: ${notification.message}`);
						break;
					}
					case IpcMessageTypes.METRICS: {
						const txMetrics =
							msg.data as IpcMessageMap[IpcMessageTypes.METRICS];
						const now = Date.now();
						this._lastTxThreadMetricsReceived = now;
						this._lastTxMetrics = txMetrics;

						if (!this.txSendMetricsGauge) {
							break;
						}

						this.txSendMetricsGauge!.setLatestValue(now, {
							metric: 'txMetricsLastTs',
						});
						this.txSendMetricsGauge!.setLatestValue(txMetrics.txLanded, {
							metric: 'txLanded',
						});
						this.txSendMetricsGauge!.setLatestValue(txMetrics.txRetried, {
							metric: 'txRetried',
						});
						this.txSendMetricsGauge!.setLatestValue(txMetrics.txAttempted, {
							metric: 'txAttempted',
						});
						this.txSendMetricsGauge!.setLatestValue(
							txMetrics.txDroppedBlockhashExpired,
							{
								metric: 'txDroppedBlockhashExpired',
							}
						);
						this.txSendMetricsGauge!.setLatestValue(txMetrics.txEnabled, {
							metric: 'txEnabled',
						});
						this.txSendMetricsGauge!.setLatestValue(txMetrics.lruEvictedTxs, {
							metric: 'lruEvictedTxs',
						});
						this.txSendMetricsGauge!.setLatestValue(
							txMetrics.pendingQueueSize,
							{
								metric: 'pendingQueueSize',
							}
						);
						this.txSendMetricsGauge!.setLatestValue(
							txMetrics.confirmQueueSize,
							{
								metric: 'confirmQueueSize',
							}
						);
						this.txSendMetricsGauge!.setLatestValue(
							txMetrics.txFailedSimulation,
							{
								metric: 'txFailedSimulation',
							}
						);
						this.txSendMetricsGauge!.setLatestValue(
							txMetrics.txConfirmedFromWs,
							{
								metric: 'txConfirmedFromWs',
							}
						);
						break;
					}
					default: {
						logger.info(
							`Unknown message type from child: ${JSON.stringify(_msg)}`
						);
						break;
					}
				}
			},
			`[${this._botIdString}]`
		);
	}

	/**
	 * Sends signer info for the tx thread to sign txs with.
	 * @param signerKey - public key of the signer, used to id the signer
	 * @param signerInfo - Raw private key or file to open, to be passed into `loadKeypair`
	 */
	protected async sendSignerToTxThread(signerKey: string, signerInfo: string) {
		if (!this.txThreadProcess) {
			logger.error(`[TxThreaded] No txThread process to send signer to`);
			return;
		}

		this.txThreadProcess.send({
			type: IpcMessageTypes.NEW_SIGNER,
			data: {
				signerKey,
				signerInfo,
			},
		});
	}

	/**
	 * Sends an address lookup table to the tx thread, needed when resigning txs for retry
	 * @param address - address of the lookup table
	 */
	protected async sendAddressLutToTxThread(address: string) {
		if (!this.txThreadProcess) {
			logger.error(
				`[TxThreaded] No txThread process to send address lookup table to`
			);
			return;
		}

		this.txThreadProcess.send({
			type: IpcMessageTypes.NEW_ADDRESS_LOOKUP_TABLE,
			data: {
				address,
			},
		});
	}

	/**
	 * Sends a transaction to the tx thread to be signed and sent
	 * @param ixs - instructions to send
	 * @param signerKeys - public keys of the signers (must previously be registerd with `sendSignerToTxThread`)
	 * @param addressLookupTables - addresses of the address lookup tables (must previously be registerd with `sendAddressLutToTxThread`)
	 * @param newSigners - new signers to add (identical to registering with `sendSignerToTxThread`)
	 */
	protected async sendIxsToTxthread({
		ixs,
		signerKeys,
		doSimulation,
		addressLookupTables = [],
		newSigners = [],
	}: {
		ixs: TransactionInstruction[];
		signerKeys: string[];
		doSimulation: boolean;
		addressLookupTables?: string[];
		newSigners?: { key: string; info: string }[];
	}) {
		if (!this.txThreadProcess) {
			logger.error(`[TxThreaded] No txThread process to send instructions to`);
			return;
		}

		this.txThreadProcess.send({
			type: IpcMessageTypes.TRANSACTION,
			data: {
				ixsSerialized: ixs,
				doSimulation,
				simulateCUs: true,
				retryUntilConfirmed: false,
				signerKeys,
				addressLookupTables,
				newSigners,
			},
		});
	}

	/**
	 * Sends a transaction signature to the tx thread to be confirmed. The signer of the tx sig must be previously registered with `sendSignerToTxThread`.
	 * @param txSig - transaction signature to confirm
	 * @param signerKeys - public keys of the signers (must previously be registerd with `sendSignerToTxThread`)
	 * @param addressLookupTables - addresses of the address lookup tables (must previously be registerd with `sendAddressLutToTxThread`)
	 * @param newSigners - new signers to add (identical to registering with `sendSignerToTxThread`)
	 */
	protected async registerTxToConfirm({
		txSig,
		newSigners = [],
	}: {
		txSig: string;
		newSigners?: { key: string; info: string }[];
	}) {
		if (!this.txThreadProcess) {
			logger.error(`[TxThreaded] No txThread process to send instructions to`);
			return;
		}

		this.txThreadProcess.send({
			type: IpcMessageTypes.CONFIRM_TRANSACTION,
			data: {
				confirmTxSig: txSig,
				newSigners,
			},
		});
	}

	/**
	 * Enables or disables transactions for the tx thread
	 * @param state - true to enable transactions, false to disable
	 */
	protected async setTxEnabledTxThread(state: boolean) {
		if (!this.txThreadProcess) {
			logger.error(
				`[TxThreaded] No txThread process to set transaction enabled state`
			);
			return;
		}

		this.txThreadProcess.send({
			type: IpcMessageTypes.SET_TRANSACTIONS_ENABLED,
			data: {
				txEnabled: state,
			},
		});
	}
}
