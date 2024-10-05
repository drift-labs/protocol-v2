import { TxSigAndSlot } from './types';
import {
	ConfirmOptions,
	Connection,
	SendTransactionError,
	Signer,
	Transaction,
	TransactionConfirmationStatus,
	VersionedTransaction,
} from '@solana/web3.js';
import { BaseTxSender } from './baseTxSender';
import bs58 from 'bs58';
import { TxHandler } from './txHandler';
import { IWallet } from '../types';
import { DEFAULT_CONFIRMATION_OPTS } from '../config';
import { TransactionConfirmationManager } from '../util/TransactionConfirmationManager';

const DEFAULT_RETRY = 2000;

type ResolveReference = {
	resolve?: () => void;
};

export class WhileValidTxSender extends BaseTxSender {
	connection: Connection;
	wallet: IWallet;
	opts: ConfirmOptions;
	timeout: number;
	retrySleep: number;
	additionalConnections: Connection[];
	timoutCount = 0;
	untilValid = new Map<
		string,
		{ blockhash: string; lastValidBlockHeight: number }
	>();

	useBlockHeightOffset = true;

	transactionConfirmationManager: TransactionConfirmationManager;

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
		additionalTxSenderCallbacks = [],
		txHandler,
		trackTxLandRate,
		txLandRateLookbackWindowMinutes,
		landRateToFeeFunc,
	}: {
		connection: Connection;
		wallet: IWallet;
		opts?: ConfirmOptions;
		retrySleep?: number;
		additionalConnections?;
		additionalTxSenderCallbacks?: ((base58EncodedTx: string) => void)[];
		txHandler?: TxHandler;
		trackTxLandRate?: boolean;
		txLandRateLookbackWindowMinutes?: number;
		landRateToFeeFunc?: (landRate: number) => number;
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
			landRateToFeeFunc,
		});
		this.retrySleep = retrySleep;

		this.checkAndSetUseBlockHeightOffset();

		this.transactionConfirmationManager = new TransactionConfirmationManager(
			this.connection
		);
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
		const txSig = bs58.encode(
			signedTx?.signature || signedTx.signatures[0]?.signature
		);
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
				additionalSigners,
				latestBlockhash
			);
		}

		if (opts === undefined) {
			opts = this.opts;
		}

		const txSig = bs58.encode(signedTx.signatures[0]);
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

		let slot: number;
		try {
			const result = await this.confirmTransaction(txid, opts.commitment);

			/*
			HELP FOR DIAGNOSING MEMORY LEAK :: 
			
			CHECK 1: This is the old version of our transaction confirmation code. If the memory leak goes away with this then there is a bug in BaseTxSender's `confirmTransaction` method which is unchanged. Unfortunately this old code deprecates with the 2.0 upgrade in a few days. If we find the confirmTransaction method is the culprit, it might be worth checking if the memory leak goes away when using the new TransactionConfirmationManager class instead (in CHECK 2 below). If this is NOT the culprit then the memory leak must have been introduced by me in the changes I made under the hood of `checkConfirmationResultForError` because I haven't made any other changes to this class. Hopefully it's easy to figure out because that error reporting code isn't too complex - it's all done through the `reportTransactionError.ts` file now.
			*/

			// THING TO CHECK 1
			// <uncommment this code and remove the previous confirmation logic>
			// const VALID_BLOCK_HEIGHT_OFFSET = -150;
			// const { blockhash, lastValidBlockHeight } = this.untilValid.get(txid);
			// const result = await this.connection.confirmTransaction(
			// 	{
			// 		signature: txid,
			// 		blockhash,
			// 		lastValidBlockHeight: this.useBlockHeightOffset
			// 			? lastValidBlockHeight + VALID_BLOCK_HEIGHT_OFFSET
			// 			: lastValidBlockHeight,
			// 	},
			// 	opts?.commitment
			// );

			// THING TO CHECK 2
			// <uncommment this code and remove the previous confirmation logic>
			// const transactionConfirmationManager = new TransactionConfirmationManager(
			// 	this.connection
			// );
			// const result =
			// 	await transactionConfirmationManager.confirmTransactionWebSocket(
			// 		txid,
			// 		this.timeout,
			// 		this.opts?.commitment as TransactionConfirmationStatus
			// 	);

			this.txSigCache?.set(txid, true);

			// THING TO CHECK 3 :: If the previous checks don't fix the memory leak - it must be in this error reporting code!
			await this.checkConfirmationResultForError(txid, result.value);

			if (result?.value?.err) {
				// Fallback error handling if there's a problem reporting the error in checkConfirmationResultForError
				throw new SendTransactionError({
					action: 'send',
					signature: txid,
					transactionMessage: `Transaction Failed`,
				});
			}

			slot = result.context.slot;
			// eslint-disable-next-line no-useless-catch
		} catch (e) {
			throw e;
		} finally {
			stopWaiting();
		}

		return { txSig: txid, slot };
	}
}
