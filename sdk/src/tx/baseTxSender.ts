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
	SendTransactionError,
	TransactionInstruction,
	AddressLookupTableAccount,
	BlockhashWithExpiryBlockHeight,
} from '@solana/web3.js';
import { AnchorProvider } from '@coral-xyz/anchor';
import assert from 'assert';
import bs58 from 'bs58';
import { TxHandler } from './txHandler';
import { IWallet } from '../types';

const DEFAULT_TIMEOUT = 35000;
const NOT_CONFIRMED_ERROR_CODE = -1001;

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

	public constructor({
		connection,
		wallet,
		opts = AnchorProvider.defaultOptions(),
		timeout = DEFAULT_TIMEOUT,
		additionalConnections = new Array<Connection>(),
		confirmationStrategy = ConfirmationStrategy.Combo,
		additionalTxSenderCallbacks,
		txHandler,
	}: {
		connection: Connection;
		wallet: IWallet;
		opts?: ConfirmOptions;
		timeout?: number;
		additionalConnections?;
		confirmationStrategy?: ConfirmationStrategy;
		additionalTxSenderCallbacks?: ((base58EncodedTx: string) => void)[];
		txHandler?: TxHandler;
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
					const rpcResponse = await this.connection.getSignatureStatus(
						signature
					);
					if (rpcResponse?.value?.confirmationStatus) {
						response = {
							context: rpcResponse.context,
							value: { err: rpcResponse.value.err },
						};
						return response;
					}
				} catch (error) {
					// Ignore error to pass through to timeout error
				}
			}
			this.timeoutCount += 1;
			const duration = (Date.now() - start) / 1000;
			throw new TxSendError(
				`Transaction was not confirmed in ${duration.toFixed(
					2
				)} seconds. It is unknown if it succeeded or failed. Check signature ${signature} using the Solana Explorer or CLI tools.`,
				NOT_CONFIRMED_ERROR_CODE
			);
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

			const response = await this.connection.getSignatureStatus(signature);
			const result = response && response.value?.[0];

			if (result && result.confirmationStatus === commitment) {
				return { context: result.context, value: { err: null } };
			}

			totalTime += backoffTime;
			backoffTime = Math.min(backoffTime * 2, 5000);
		}

		// Transaction not confirmed within 30 seconds
		this.timeoutCount += 1;
		const duration = (Date.now() - start) / 1000;
		throw new TxSendError(
			`Transaction was not confirmed in ${duration.toFixed(
				2
			)} seconds. It is unknown if it succeeded or failed. Check signature ${signature} using the Solana Explorer or CLI tools.`,
			NOT_CONFIRMED_ERROR_CODE
		);
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
		result: RpcResponseAndContext<SignatureResult>
	) {
		if (result.value.err) {
			await this.reportTransactionError(txSig);
		}

		return;
	}

	public async reportTransactionError(txSig: string) {
		const transactionResult = await this.connection.getTransaction(txSig, {
			maxSupportedTransactionVersion: 0,
		});

		if (!transactionResult?.meta?.err) {
			return undefined;
		}

		const logs = transactionResult.meta.logMessages;

		const lastLog = logs[logs.length - 1];

		const friendlyMessage = lastLog?.match(/(failed:) (.+)/)?.[2];

		throw new SendTransactionError(
			`Transaction Failed${friendlyMessage ? `: ${friendlyMessage}` : ''}`,
			transactionResult.meta.logMessages
		);
	}
}
