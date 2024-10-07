import { TxSigAndSlot } from './types';
import {
	Commitment,
	ConfirmOptions,
	Connection,
	Signer,
	Transaction,
	VersionedTransaction,
} from '@solana/web3.js';
import { AnchorProvider } from '@coral-xyz/anchor';
import { BaseTxSender } from './baseTxSender';
import bs58 from 'bs58';
import { TxHandler } from './txHandler';
import { IWallet } from '../types';

const DEFAULT_RETRY = 2000;

const VALID_BLOCK_HEIGHT_OFFSET = -150; // This is a bit of weirdness but the lastValidBlockHeight value returned from connection.getLatestBlockhash is always 300 blocks ahead of the current block, even though the transaction actually expires after 150 blocks. This accounts for that so that we can at least accuractely estimate the transaction expiry.

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
	blockhashCommitment: Commitment;

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
		opts = { ...AnchorProvider.defaultOptions(), maxRetries: 0 },
		retrySleep = DEFAULT_RETRY,
		additionalConnections = new Array<Connection>(),
		additionalTxSenderCallbacks = [],
		blockhashCommitment = 'finalized',
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
		blockhashCommitment?: Commitment;
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
		this.blockhashCommitment = blockhashCommitment;

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
			signedTx.signature || signedTx.signatures[0]?.signature
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
			const { blockhash, lastValidBlockHeight } = this.untilValid.get(txid);

			const result = await this.connection.confirmTransaction(
				{
					signature: txid,
					blockhash,
					lastValidBlockHeight: this.useBlockHeightOffset
						? lastValidBlockHeight + VALID_BLOCK_HEIGHT_OFFSET
						: lastValidBlockHeight,
				},
				opts?.commitment
			);

			if (!result) {
				throw new Error(`Couldn't get signature status for txid: ${txid}`);
			}

			this.txSigCache?.set(txid, true);

			await this.checkConfirmationResultForError(txid, result.value);

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
