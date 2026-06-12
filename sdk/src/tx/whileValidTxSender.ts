import { ConfirmationStrategy, TxSigAndSlot } from './types';
import {
	ConfirmOptions,
	Connection,
	SendTransactionError,
	Signer,
	Transaction,
	VersionedTransaction,
} from '@solana/web3.js';
import { BaseTxSender } from './baseTxSender';
import bs58 from 'bs58';
import { TxHandler } from './txHandler';
import { IWallet } from '../types';
import { DEFAULT_CONFIRMATION_OPTS } from '../config';

const DEFAULT_RETRY = 2000;

type ResolveReference = {
	resolve?: () => void;
};

export class WhileValidTxSender extends BaseTxSender {
	retrySleep: number;
	timoutCount = 0;
	untilValid = new Map<
		string,
		{ blockhash: string; lastValidBlockHeight: number }
	>();

	useBlockHeightOffset = true;

	private async checkAndSetUseBlockHeightOffset() {
		this.connection.getVersion().then((version) => {
			const solanaCoreVersion = version['solana-core'];

			if (!solanaCoreVersion) return;

			const majorVersion = solanaCoreVersion.split('.')[0];

			if (!majorVersion) return;

			const parsedMajorVersion = parseInt(majorVersion);

			if (isNaN(parsedMajorVersion)) return;

			if (parsedMajorVersion >= 2) {
				this.useBlockHeightOffset = false;
			} else {
				this.useBlockHeightOffset = true;
			}
		});
	}

	public constructor({
		connection,
		wallet,
		opts = { ...DEFAULT_CONFIRMATION_OPTS, maxRetries: 0 },
		retrySleep = DEFAULT_RETRY,
		additionalConnections = new Array<Connection>(),
		confirmationStrategy = ConfirmationStrategy.Combo,
		additionalTxSenderCallbacks = [],
		txHandler,
		trackTxLandRate,
		txLandRateLookbackWindowMinutes,
		landRateToFeeFunc,
		throwOnTimeoutError = true,
		throwOnTransactionError = true,
	}: {
		connection: Connection;
		wallet: IWallet;
		opts?: ConfirmOptions;
		retrySleep?: number;
		additionalConnections?: Connection[];
		additionalTxSenderCallbacks?: ((base58EncodedTx: string) => void)[];
		confirmationStrategy?: ConfirmationStrategy;
		txHandler?: TxHandler;
		trackTxLandRate?: boolean;
		txLandRateLookbackWindowMinutes?: number;
		landRateToFeeFunc?: (landRate: number) => number;
		throwOnTimeoutError?: boolean;
		throwOnTransactionError?: boolean;
	}) {
		super({
			connection,
			wallet,
			opts,
			additionalConnections,
			additionalTxSenderCallbacks,
			txHandler,
			trackTxLandRate,
			txLandRateLookbackWindowMinutes,
			confirmationStrategy,
			landRateToFeeFunc,
			throwOnTimeoutError,
			throwOnTransactionError,
		});
		this.retrySleep = retrySleep;

		this.checkAndSetUseBlockHeightOffset();
	}

	async sleep(reference: ResolveReference): Promise<void> {
		return new Promise((resolve) => {
			reference.resolve = resolve;
			setTimeout(resolve, this.retrySleep);
		});
	}

	async prepareTx(
		tx: Transaction,
		additionalSigners: Array<Signer>,
		opts: ConfirmOptions,
		preSigned?: boolean
	): Promise<Transaction> {
		let latestBlockhash =
			await this.txHandler.getLatestBlockhashForTransaction();

		if (!latestBlockhash) {
			throw new Error(
				'WhileValidTxSender: failed to fetch latest blockhash for transaction'
			);
		}

		// handle tx
		let signedTx = tx;
		if (!preSigned) {
			signedTx = await this.txHandler.prepareTx(
				tx,
				additionalSigners,
				undefined,
				opts,
				false,
				latestBlockhash
			);
		}

		// See SIGNATURE_BLOCK_AND_EXPIRY explanation in txHandler.ts if this is confusing
		// @ts-ignore
		if (preSigned && tx.SIGNATURE_BLOCK_AND_EXPIRY) {
			// @ts-ignore
			latestBlockhash = tx.SIGNATURE_BLOCK_AND_EXPIRY;
		}

		// handle subclass-specific side effects
		const signature = signedTx?.signature || signedTx.signatures[0]?.signature;
		if (!signature) {
			throw new Error(
				'WhileValidTxSender: signed transaction is missing a signature'
			);
		}
		const txSig = bs58.encode(signature);
		if (!latestBlockhash) {
			throw new Error(
				'WhileValidTxSender: failed to resolve latest blockhash for transaction'
			);
		}
		this.untilValid.set(txSig, latestBlockhash);

		return signedTx;
	}

	async sendVersionedTransaction(
		tx: VersionedTransaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		preSigned?: boolean
	): Promise<TxSigAndSlot> {
		let latestBlockhash =
			await this.txHandler.getLatestBlockhashForTransaction();

		if (!latestBlockhash) {
			throw new Error(
				'WhileValidTxSender: failed to fetch latest blockhash for transaction'
			);
		}

		let signedTx;
		if (preSigned) {
			signedTx = tx;

			// See SIGNATURE_BLOCK_AND_EXPIRY explanation in txHandler.ts if this is confusing
			// @ts-ignore
			if (tx.SIGNATURE_BLOCK_AND_EXPIRY) {
				// @ts-ignore
				latestBlockhash = tx.SIGNATURE_BLOCK_AND_EXPIRY;
			}

			// @ts-ignore
		} else if (this.wallet.payer) {
			tx.message.recentBlockhash = latestBlockhash.blockhash;
			// @ts-ignore
			tx.sign((additionalSigners ?? []).concat(this.wallet.payer));
			signedTx = tx;
		} else {
			tx.message.recentBlockhash = latestBlockhash.blockhash;
			additionalSigners
				?.filter((s): s is Signer => s !== undefined)
				.forEach((kp) => {
					tx.sign([kp]);
				});
			signedTx = await this.txHandler.signVersionedTx(
				tx,
				additionalSigners ?? [],
				latestBlockhash
			);
		}

		if (opts === undefined) {
			opts = this.opts;
		}

		const signature = signedTx.signatures[0];
		if (!signature) {
			throw new Error(
				'WhileValidTxSender: signed transaction is missing a signature'
			);
		}
		const txSig = bs58.encode(signature);
		if (!latestBlockhash) {
			throw new Error(
				'WhileValidTxSender: failed to resolve latest blockhash for transaction'
			);
		}
		this.untilValid.set(txSig, latestBlockhash);

		return this.sendRawTransaction(signedTx.serialize(), opts);
	}

	async sendRawTransaction(
		rawTransaction: Buffer | Uint8Array,
		opts: ConfirmOptions
	): Promise<TxSigAndSlot> {
		const startTime = this.getTimestamp();

		const txid = await this.connection.sendRawTransaction(rawTransaction, opts);
		this.txSigCache?.set(txid, false);
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
					this.connection
						.sendRawTransaction(rawTransaction, opts)
						.catch((e) => {
							console.error(e);
							stopWaiting();
						});
					this.sendToAdditionalConnections(rawTransaction, opts);
				}
			}
		})();

		let slot: number | undefined;
		try {
			const result = await this.confirmTransaction(txid, opts.commitment);

			this.txSigCache?.set(txid, true);

			if (result) {
				await this.checkConfirmationResultForError(txid, result.value);

				if (result.value?.err && this.throwOnTransactionError) {
					// Fallback error handling if there's a problem reporting the error in checkConfirmationResultForError
					throw new SendTransactionError({
						action: 'send',
						signature: txid,
						transactionMessage: `Transaction Failed`,
					});
				}

				slot = result.context.slot;
			}
			// eslint-disable-next-line no-useless-catch
		} catch (e) {
			throw e;
		} finally {
			stopWaiting();
			this.untilValid.delete(txid);
		}

		return { txSig: txid, slot };
	}
}
