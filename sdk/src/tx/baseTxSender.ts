import {
	ConfirmationStrategy,
	ExtraConfirmationOptions,
	TxSender,
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
	TransactionMessage,
	TransactionInstruction,
	AddressLookupTableAccount,
} from '@solana/web3.js';
import { AnchorProvider } from '@coral-xyz/anchor';
import assert from 'assert';
import bs58 from 'bs58';
import { IWallet } from '../types';

const DEFAULT_TIMEOUT = 35000;

export abstract class BaseTxSender implements TxSender {
	connection: Connection;
	wallet: IWallet;
	opts: ConfirmOptions;
	timeout: number;
	additionalConnections: Connection[];
	timeoutCount = 0;
	confirmationStrategy: ConfirmationStrategy;
	additionalTxSenderCallbacks: ((base58EncodedTx: string) => void)[];

	public constructor({
		connection,
		wallet,
		opts = AnchorProvider.defaultOptions(),
		timeout = DEFAULT_TIMEOUT,
		additionalConnections = new Array<Connection>(),
		confirmationStrategy = ConfirmationStrategy.Combo,
		additionalTxSenderCallbacks,
	}: {
		connection: Connection;
		wallet: IWallet;
		opts?: ConfirmOptions;
		timeout?: number;
		additionalConnections?;
		confirmationStrategy?: ConfirmationStrategy;
		additionalTxSenderCallbacks?: ((base58EncodedTx: string) => void)[];
	}) {
		this.connection = connection;
		this.wallet = wallet;
		this.opts = opts;
		this.timeout = timeout;
		this.additionalConnections = additionalConnections;
		this.confirmationStrategy = confirmationStrategy;
		this.additionalTxSenderCallbacks = additionalTxSenderCallbacks;
	}

	async send(
		tx: Transaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		preSigned?: boolean,
		extraConfirmationOptions?: ExtraConfirmationOptions
	): Promise<TxSigAndSlot> {
		if (additionalSigners === undefined) {
			additionalSigners = [];
		}
		if (opts === undefined) {
			opts = this.opts;
		}

		const signedTx = preSigned
			? tx
			: await this.prepareTx(tx, additionalSigners, opts);

		if (extraConfirmationOptions?.onSignedCb) {
			extraConfirmationOptions.onSignedCb();
		}

		return this.sendRawTransaction(signedTx.serialize(), opts);
	}

	async prepareTx(
		tx: Transaction,
		additionalSigners: Array<Signer>,
		opts: ConfirmOptions
	): Promise<Transaction> {
		tx.feePayer = this.wallet.publicKey;
		tx.recentBlockhash = (
			await this.connection.getLatestBlockhash(opts.preflightCommitment)
		).blockhash;

		additionalSigners
			.filter((s): s is Signer => s !== undefined)
			.forEach((kp) => {
				tx.partialSign(kp);
			});

		const signedTx = await this.wallet.signTransaction(tx);

		return signedTx;
	}

	async getVersionedTransaction(
		ixs: TransactionInstruction[],
		lookupTableAccounts: AddressLookupTableAccount[],
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions
	): Promise<VersionedTransaction> {
		if (additionalSigners === undefined) {
			additionalSigners = [];
		}
		if (opts === undefined) {
			opts = this.opts;
		}

		const message = new TransactionMessage({
			payerKey: this.wallet.publicKey,
			recentBlockhash: (
				await this.connection.getLatestBlockhash(opts.preflightCommitment)
			).blockhash,
			instructions: ixs,
		}).compileToV0Message(lookupTableAccounts);

		const tx = new VersionedTransaction(message);

		return tx;
	}

	async sendVersionedTransaction(
		tx: VersionedTransaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		preSigned?: boolean,
		extraConfirmationOptions?: ExtraConfirmationOptions
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
			additionalSigners
				?.filter((s): s is Signer => s !== undefined)
				.forEach((kp) => {
					tx.sign([kp]);
				});
			// @ts-ignore
			signedTx = await this.wallet.signTransaction(tx);
		}

		if (extraConfirmationOptions?.onSignedCb) {
			extraConfirmationOptions.onSignedCb();
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
			throw new Error(
				`Transaction was not confirmed in ${duration.toFixed(
					2
				)} seconds. It is unknown if it succeeded or failed. Check signature ${signature} using the Solana Explorer or CLI tools.`
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
		throw new Error(
			`Transaction was not confirmed in ${duration.toFixed(
				2
			)} seconds. It is unknown if it succeeded or failed. Check signature ${signature} using the Solana Explorer or CLI tools.`
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
}
