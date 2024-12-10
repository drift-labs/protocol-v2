import {
	ConfirmationStrategy,
	TxSender,
	TxSendError,
	TxSigAndSlot,
} from './types';
import {
	Commitment,
	ConfirmOptions,
	Context,
	RpcResponseAndContext,
	Signer,
	SignatureResult,
	Transaction,
	TransactionSignature,
	Connection,
	VersionedTransaction,
	TransactionInstruction,
	AddressLookupTableAccount,
	BlockhashWithExpiryBlockHeight,
} from '@solana/web3.js';
import assert from 'assert';
import bs58 from 'bs58';
import { TxHandler } from './txHandler';
import { IWallet } from '../types';
import NodeCache from 'node-cache';
import { DEFAULT_CONFIRMATION_OPTS } from '../config';
import { NOT_CONFIRMED_ERROR_CODE } from '../constants/txConstants';
import { throwTransactionError } from './reportTransactionError';

const BASELINE_TX_LAND_RATE = 0.9;
const DEFAULT_TIMEOUT = 35000;
const DEFAULT_TX_LAND_RATE_LOOKBACK_WINDOW_MINUTES = 10;

export abstract class BaseTxSender implements TxSender {
	connection: Connection;
	wallet: IWallet;
	opts: ConfirmOptions;
	timeout: number;
	additionalConnections: Connection[];
	timeoutCount = 0;
	confirmationStrategy: ConfirmationStrategy;
	additionalTxSenderCallbacks: ((base58EncodedTx: string) => void)[];
	txHandler: TxHandler;
	trackTxLandRate?: boolean;
	throwOnTimeoutError: boolean;
	throwOnTransactionError: boolean;

	// For landing rate calcs
	lookbackWindowMinutes: number;
	txSigCache?: NodeCache;
	txLandRate = 0;
	lastPriorityFeeSuggestion = 1;
	landRateToFeeFunc: (landRate: number) => number;

	public constructor({
		connection,
		wallet,
		opts = DEFAULT_CONFIRMATION_OPTS,
		timeout = DEFAULT_TIMEOUT,
		additionalConnections = new Array<Connection>(),
		confirmationStrategy = ConfirmationStrategy.Combo,
		additionalTxSenderCallbacks,
		trackTxLandRate,
		txHandler,
		txLandRateLookbackWindowMinutes = DEFAULT_TX_LAND_RATE_LOOKBACK_WINDOW_MINUTES,
		landRateToFeeFunc,
		throwOnTimeoutError = true,
		throwOnTransactionError = true,
	}: {
		connection: Connection;
		wallet: IWallet;
		opts?: ConfirmOptions;
		timeout?: number;
		additionalConnections?;
		confirmationStrategy?: ConfirmationStrategy;
		additionalTxSenderCallbacks?: ((base58EncodedTx: string) => void)[];
		txHandler?: TxHandler;
		trackTxLandRate?: boolean;
		txLandRateLookbackWindowMinutes?: number;
		landRateToFeeFunc?: (landRate: number) => number;
		throwOnTimeoutError?: boolean;
		throwOnTransactionError?: boolean;
	}) {
		this.connection = connection;
		this.wallet = wallet;
		this.opts = opts;
		this.timeout = timeout;
		this.additionalConnections = additionalConnections;
		this.confirmationStrategy = confirmationStrategy;
		this.additionalTxSenderCallbacks = additionalTxSenderCallbacks;
		this.txHandler =
			txHandler ??
			new TxHandler({
				connection: this.connection,
				wallet: this.wallet,
				confirmationOptions: this.opts,
			});
		this.trackTxLandRate = trackTxLandRate;
		this.lookbackWindowMinutes = txLandRateLookbackWindowMinutes * 60;
		if (this.trackTxLandRate) {
			this.txSigCache = new NodeCache({
				stdTTL: this.lookbackWindowMinutes,
				checkperiod: 120,
			});
		}
		this.landRateToFeeFunc =
			landRateToFeeFunc ?? this.defaultLandRateToFeeFunc.bind(this);
		this.throwOnTimeoutError = throwOnTimeoutError;
		this.throwOnTransactionError = throwOnTransactionError;
	}

	async send(
		tx: Transaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		preSigned?: boolean
	): Promise<TxSigAndSlot> {
		if (additionalSigners === undefined) {
			additionalSigners = [];
		}
		if (opts === undefined) {
			opts = this.opts;
		}

		const signedTx = await this.prepareTx(
			tx,
			additionalSigners,
			opts,
			preSigned
		);

		return this.sendRawTransaction(signedTx.serialize(), opts);
	}

	async prepareTx(
		tx: Transaction,
		additionalSigners: Array<Signer>,
		opts: ConfirmOptions,
		preSigned?: boolean
	): Promise<Transaction> {
		return this.txHandler.prepareTx(
			tx,
			additionalSigners,
			undefined,
			opts,
			preSigned
		);
	}

	async getVersionedTransaction(
		ixs: TransactionInstruction[],
		lookupTableAccounts: AddressLookupTableAccount[],
		_additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		blockhash?: BlockhashWithExpiryBlockHeight
	): Promise<VersionedTransaction> {
		return this.txHandler.generateVersionedTransaction(
			blockhash,
			ixs,
			lookupTableAccounts,
			this.wallet
		);
	}

	async sendVersionedTransaction(
		tx: VersionedTransaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		preSigned?: boolean
	): Promise<TxSigAndSlot> {
		let signedTx;

		if (preSigned) {
			signedTx = tx;
			// @ts-ignore
		} else if (this.wallet.payer) {
			// @ts-ignore
			tx.sign((additionalSigners ?? []).concat(this.wallet.payer));
			signedTx = tx;
		} else {
			signedTx = await this.txHandler.signVersionedTx(
				tx,
				additionalSigners,
				undefined,
				this.wallet
			);
		}

		if (opts === undefined) {
			opts = this.opts;
		}

		return this.sendRawTransaction(signedTx.serialize(), opts);
	}

	async sendRawTransaction(
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		rawTransaction: Buffer | Uint8Array,
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		opts: ConfirmOptions
	): Promise<TxSigAndSlot> {
		throw new Error('Must be implemented by subclass');
	}

	/* Simulate the tx and return a boolean for success value */
	async simulateTransaction(tx: VersionedTransaction): Promise<boolean> {
		try {
			const result = await this.connection.simulateTransaction(tx);
			if (result.value.err != null) {
				console.error('Error in transaction simulation: ', result.value.err);
				return false;
			}
			return true;
		} catch (e) {
			console.error('Error calling simulateTransaction: ', e);
			return false;
		}
	}

	async confirmTransactionWebSocket(
		signature: TransactionSignature,
		commitment?: Commitment
	): Promise<RpcResponseAndContext<SignatureResult>> {
		let decodedSignature;
		try {
			decodedSignature = bs58.decode(signature);
		} catch (err) {
			throw new Error('signature must be base58 encoded: ' + signature);
		}

		assert(decodedSignature.length === 64, 'signature has invalid length');

		const start = Date.now();
		const subscriptionCommitment = commitment || this.opts.commitment;

		const subscriptionIds = new Array<number>();
		const connections = [this.connection, ...this.additionalConnections];
		let response: RpcResponseAndContext<SignatureResult> | null = null;
		const promises = connections.map((connection, i) => {
			let subscriptionId;
			const confirmPromise = new Promise((resolve, reject) => {
				try {
					subscriptionId = connection.onSignature(
						signature,
						(result: SignatureResult, context: Context) => {
							subscriptionIds[i] = undefined;
							response = {
								context,
								value: result,
							};
							resolve(null);
						},
						subscriptionCommitment
					);
				} catch (err) {
					reject(err);
				}
			});
			subscriptionIds.push(subscriptionId);
			return confirmPromise;
		});

		try {
			await this.promiseTimeout(promises, this.timeout);
		} finally {
			for (const [i, subscriptionId] of subscriptionIds.entries()) {
				if (subscriptionId) {
					connections[i].removeSignatureListener(subscriptionId);
				}
			}
		}

		if (response === null) {
			if (this.confirmationStrategy === ConfirmationStrategy.Combo) {
				try {
					const rpcResponse = await this.connection.getSignatureStatuses([
						signature,
					]);

					if (rpcResponse?.value?.[0]?.confirmationStatus) {
						response = {
							context: rpcResponse.context,
							value: { err: rpcResponse.value[0].err },
						};
						return response;
					}
				} catch (error) {
					// Ignore error to pass through to timeout error
				}
			}
			this.timeoutCount += 1;
			const duration = (Date.now() - start) / 1000;
			if (this.throwOnTimeoutError) {
				throw new TxSendError(
					`Transaction was not confirmed in ${duration.toFixed(
						2
					)} seconds. It is unknown if it succeeded or failed. Check signature ${signature} using the Solana Explorer or CLI tools.`,
					NOT_CONFIRMED_ERROR_CODE
				);
			}
		}

		return response;
	}

	async confirmTransactionPolling(
		signature: TransactionSignature,
		commitment: Commitment = 'finalized'
	): Promise<RpcResponseAndContext<SignatureResult> | undefined> {
		let totalTime = 0;
		let backoffTime = 400; // approx block time
		const start = Date.now();

		while (totalTime < this.timeout) {
			await new Promise((resolve) => setTimeout(resolve, backoffTime));

			const rpcResponse = await this.connection.getSignatureStatuses([
				signature,
			]);

			const signatureResult = rpcResponse && rpcResponse.value?.[0];

			if (
				rpcResponse &&
				signatureResult &&
				signatureResult.confirmationStatus === commitment
			) {
				return { context: rpcResponse.context, value: { err: null } };
			}

			totalTime += backoffTime;
			backoffTime = Math.min(backoffTime * 2, 5000);
		}

		// Transaction not confirmed within 30 seconds
		this.timeoutCount += 1;
		const duration = (Date.now() - start) / 1000;
		if (this.throwOnTimeoutError) {
			throw new TxSendError(
				`Transaction was not confirmed in ${duration.toFixed(
					2
				)} seconds. It is unknown if it succeeded or failed. Check signature ${signature} using the Solana Explorer or CLI tools.`,
				NOT_CONFIRMED_ERROR_CODE
			);
		}
	}

	async confirmTransaction(
		signature: TransactionSignature,
		commitment?: Commitment
	): Promise<RpcResponseAndContext<SignatureResult>> {
		if (
			this.confirmationStrategy === ConfirmationStrategy.WebSocket ||
			this.confirmationStrategy === ConfirmationStrategy.Combo
		) {
			return await this.confirmTransactionWebSocket(signature, commitment);
		} else if (this.confirmationStrategy === ConfirmationStrategy.Polling) {
			return await this.confirmTransactionPolling(signature, commitment);
		}
	}

	getTimestamp(): number {
		return new Date().getTime();
	}

	promiseTimeout<T>(
		promises: Promise<T>[],
		timeoutMs: number
	): Promise<T | null> {
		let timeoutId: ReturnType<typeof setTimeout>;
		const timeoutPromise: Promise<null> = new Promise((resolve) => {
			timeoutId = setTimeout(() => resolve(null), timeoutMs);
		});

		return Promise.race([...promises, timeoutPromise]).then(
			(result: T | null) => {
				clearTimeout(timeoutId);
				return result;
			}
		);
	}

	sendToAdditionalConnections(
		rawTx: Buffer | Uint8Array,
		opts: ConfirmOptions
	): void {
		this.additionalConnections.map((connection) => {
			connection.sendRawTransaction(rawTx, opts).catch((e) => {
				console.error(
					// @ts-ignore
					`error sending tx to additional connection ${connection._rpcEndpoint}`
				);
				console.error(e);
			});
		});
		this.additionalTxSenderCallbacks?.map((callback) => {
			callback(bs58.encode(rawTx));
		});
	}

	public addAdditionalConnection(newConnection: Connection): void {
		const alreadyUsingConnection =
			this.additionalConnections.filter((connection) => {
				// @ts-ignore
				return connection._rpcEndpoint === newConnection.rpcEndpoint;
			}).length > 0;

		if (!alreadyUsingConnection) {
			this.additionalConnections.push(newConnection);
		}
	}

	public getTimeoutCount(): number {
		return this.timeoutCount;
	}

	public async checkConfirmationResultForError(
		txSig: string,
		result: SignatureResult
	): Promise<void> {
		if (result?.err) {
			await throwTransactionError(
				txSig,
				this.connection,
				this.opts?.commitment
			);
		}

		return;
	}

	public getTxLandRate(): number {
		if (!this.trackTxLandRate) {
			console.warn(
				'trackTxLandRate is false, returning default land rate of 0'
			);
			return this.txLandRate;
		}
		const keys = this.txSigCache.keys();
		const denominator = keys.length;
		if (denominator === 0) {
			return this.txLandRate;
		}
		let numerator = 0;
		for (const key of keys) {
			const value = this.txSigCache.get(key);
			if (value) {
				numerator += 1;
			}
		}
		this.txLandRate = numerator / denominator;
		return this.txLandRate;
	}

	private defaultLandRateToFeeFunc(txLandRate: number) {
		if (
			txLandRate >= BASELINE_TX_LAND_RATE ||
			this.txSigCache.keys().length < 3
		) {
			return 1;
		}
		const multiplier =
			10 * Math.log10(1 + (BASELINE_TX_LAND_RATE - txLandRate) * 5);
		return Math.min(multiplier, 10);
	}

	public getSuggestedPriorityFeeMultiplier(): number {
		if (!this.trackTxLandRate) {
			console.warn(
				'trackTxLandRate is false, returning default multiplier of 1'
			);
			return 1;
		}
		return this.landRateToFeeFunc(this.getTxLandRate());
	}
}
