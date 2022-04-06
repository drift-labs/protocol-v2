import { TxSender } from './types';
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
} from '@solana/web3.js';
import { Provider } from '@project-serum/anchor';
import assert from 'assert';
import bs58 from 'bs58';

const DEFAULT_TIMEOUT = 35000;
const DEFAULT_RETRY = 8000;

type ResolveReference = {
	resolve?: () => void;
};

export class RetryTxSender implements TxSender {
	provider: Provider;
	timeout: number;
	retrySleep: number;
	additionalConnections: Connection[];

	public constructor(
		provider: Provider,
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
		opts?: ConfirmOptions
	): Promise<TransactionSignature> {
		if (additionalSigners === undefined) {
			additionalSigners = [];
		}
		if (opts === undefined) {
			opts = this.provider.opts;
		}

		await this.prepareTx(tx, additionalSigners, opts);

		const rawTransaction = tx.serialize();
		const startTime = this.getTimestamp();

		const txid: TransactionSignature =
			await this.provider.connection.sendRawTransaction(rawTransaction, opts);
		this.sendToAdditionalConnections(rawTransaction, opts);

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

		try {
			await this.confirmTransaction(txid, opts.commitment);
		} catch (e) {
			console.error(e);
			throw e;
		} finally {
			stopWaiting();
		}

		return txid;
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

		await this.provider.wallet.signTransaction(tx);
		additionalSigners
			.filter((s): s is Signer => s !== undefined)
			.forEach((kp) => {
				tx.partialSign(kp);
			});

		return tx;
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

		let subscriptionId;
		let response: RpcResponseAndContext<SignatureResult> | null = null;
		const confirmPromise = new Promise((resolve, reject) => {
			try {
				subscriptionId = this.provider.connection.onSignature(
					signature,
					(result: SignatureResult, context: Context) => {
						subscriptionId = undefined;
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

		try {
			await this.promiseTimeout(confirmPromise, this.timeout);
		} finally {
			if (subscriptionId) {
				this.provider.connection.removeSignatureListener(subscriptionId);
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

	promiseTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
		let timeoutId: ReturnType<typeof setTimeout>;
		const timeoutPromise: Promise<null> = new Promise((resolve) => {
			timeoutId = setTimeout(() => resolve(null), timeoutMs);
		});

		return Promise.race([promise, timeoutPromise]).then((result: T | null) => {
			clearTimeout(timeoutId);
			return result;
		});
	}

	sendToAdditionalConnections(rawTx: Buffer, opts: ConfirmOptions): void {
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
}
