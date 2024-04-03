import { ExtraConfirmationOptions, TxSigAndSlot } from './types';
import {
	AddressLookupTableAccount,
	ConfirmOptions,
	Connection,
	Signer,
	Transaction,
	TransactionInstruction,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';
import { AnchorProvider } from '@coral-xyz/anchor';
import { IWallet } from '../types';
import { BaseTxSender } from './baseTxSender';
import bs58 from 'bs58';

const DEFAULT_RETRY = 8000;

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

	public constructor({
		connection,
		wallet,
		opts = AnchorProvider.defaultOptions(),
		retrySleep = DEFAULT_RETRY,
		additionalConnections = new Array<Connection>(),
		additionalTxSenderCallbacks = [],
	}: {
		connection: Connection;
		wallet: IWallet;
		opts?: ConfirmOptions;
		retrySleep?: number;
		additionalConnections?;
		additionalTxSenderCallbacks?: ((base58EncodedTx: string) => void)[];
	}) {
		super({
			connection,
			wallet,
			opts,
			additionalConnections,
			additionalTxSenderCallbacks,
		});
		this.retrySleep = retrySleep;
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
		const latestBlockhash = await this.connection.getLatestBlockhash(
			opts.preflightCommitment
		);

		// handle tx
		let signedTx = tx;
		if (!preSigned) {
			tx.feePayer = this.wallet.publicKey;
			tx.recentBlockhash = latestBlockhash.blockhash;

			additionalSigners
				.filter((s): s is Signer => s !== undefined)
				.forEach((kp) => {
					tx.partialSign(kp);
				});

			signedTx = await this.wallet.signTransaction(tx);
		}

		// handle subclass-specific side effects
		const txSig = bs58.encode(signedTx.signatures[0]?.signature || signedTx.signatures[0]);
		this.untilValid.set(txSig, latestBlockhash);

		return signedTx;
	}

	async getVersionedTransaction(
		ixs: TransactionInstruction[],
		lookupTableAccounts: AddressLookupTableAccount[],
		_additionalSigners?: Array<Signer>,
		_opts?: ConfirmOptions
	): Promise<VersionedTransaction> {
		const message = new TransactionMessage({
			payerKey: this.wallet.publicKey,
			recentBlockhash: '', // set blank and reset in sendVersionTransaction
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
		const latestBlockhash = await this.connection.getLatestBlockhash();
		tx.message.recentBlockhash = latestBlockhash.blockhash;

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
					lastValidBlockHeight,
					blockhash,
				},
				opts.commitment
			);
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
