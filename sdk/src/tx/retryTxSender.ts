import { TxSender, TxSigAndSlot } from './types';
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

const DEFAULT_TIMEOUT = 35000;
const DEFAULT_RETRY = 8000;

type ResolveReference = {
	resolve?: () => void;
};

export class RetryTxSender implements TxSender {
	provider: AnchorProvider;
	timeout: number;
	retrySleep: number;
	additionalConnections: Connection[];

	public constructor(
		provider: AnchorProvider,
		timeout?: number,
		retrySleep?: number,
		additionalConnections = new Array<Connection>()
	) {
		this.provider = provider;
		this.timeout = timeout ?? DEFAULT_TIMEOUT;
		this.retrySleep = retrySleep ?? DEFAULT_RETRY;
		this.additionalConnections = additionalConnections;
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
			opts = this.provider.opts;
		}

		const signedTx = preSigned
			? tx
			: await this.prepareTx(tx, additionalSigners, opts);

		return this.sendRawTransaction(signedTx.serialize(), opts);
	}

	async prepareTx(
		tx: Transaction,
		additionalSigners: Array<Signer>,
		opts: ConfirmOptions
	): Promise<Transaction> {
		tx.feePayer = this.provider.wallet.publicKey;
		tx.recentBlockhash = (
			await this.provider.connection.getRecentBlockhash(
				opts.preflightCommitment
			)
		).blockhash;

		additionalSigners
			.filter((s): s is Signer => s !== undefined)
			.forEach((kp) => {
				tx.partialSign(kp);
			});

		const signedTx = await this.provider.wallet.signTransaction(tx);

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
			opts = this.provider.opts;
		}

		const message = new TransactionMessage({
			payerKey: this.provider.wallet.publicKey,
			recentBlockhash: (
				await this.provider.connection.getRecentBlockhash(
					opts.preflightCommitment
				)
			).blockhash,
			instructions: ixs,
		}).compileToV0Message(lookupTableAccounts);

		const tx = new VersionedTransaction(message);

		return tx;
	}

	async sendVersionedTransaction(
		tx: VersionedTransaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions
	): Promise<TxSigAndSlot> {
		// @ts-ignore
		tx.sign((additionalSigners ?? []).concat(this.provider.wallet.payer));

		if (opts === undefined) {
			opts = this.provider.opts;
		}

		return this.sendRawTransaction(tx.serialize(), opts);
	}

	async sendRawTransaction(
		rawTransaction: Buffer | Uint8Array,
		opts: ConfirmOptions
	): Promise<TxSigAndSlot> {
		const startTime = this.getTimestamp();

		let txid: TransactionSignature;
		try {
			txid = await this.provider.connection.sendRawTransaction(
				rawTransaction,
				opts
			);
			this.sendToAdditionalConnections(rawTransaction, opts);
		} catch (e) {
			console.error(e);
			throw e;
		}

		let done = false;
		const resolveReference: ResolveReference = {
			resolve: undefined,
		};
		const stopWaiting = () => {
			done = true;
			if (resolveReference.resolve) {
				resolveReference.resolve();
			}
		};

		(async () => {
			while (!done && this.getTimestamp() - startTime < this.timeout) {
				await this.sleep(resolveReference);
				if (!done) {
					this.provider.connection
						.sendRawTransaction(rawTransaction, opts)
						.catch((e) => {
							console.error(e);
							stopWaiting();
						});
					this.sendToAdditionalConnections(rawTransaction, opts);
				}
			}
		})();

		let slot: number;
		try {
			const result = await this.confirmTransaction(txid, opts.commitment);
			slot = result.context.slot;
		} catch (e) {
			console.error(e);
			throw e;
		} finally {
			stopWaiting();
		}

		return { txSig: txid, slot };
	}

	async confirmTransaction(
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
		const subscriptionCommitment = commitment || this.provider.opts.commitment;

		const subscriptionIds = new Array<number>();
		const connections = [
			this.provider.connection,
			...this.additionalConnections,
		];
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
			const duration = (Date.now() - start) / 1000;
			throw new Error(
				`Transaction was not confirmed in ${duration.toFixed(
					2
				)} seconds. It is unknown if it succeeded or failed. Check signature ${signature} using the Solana Explorer or CLI tools.`
			);
		}

		return response;
	}

	getTimestamp(): number {
		return new Date().getTime();
	}

	async sleep(reference: ResolveReference): Promise<void> {
		return new Promise((resolve) => {
			reference.resolve = resolve;
			setTimeout(resolve, this.retrySleep);
		});
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
}
