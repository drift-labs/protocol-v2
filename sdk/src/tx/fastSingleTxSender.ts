import { ConfirmationStrategy, TxSigAndSlot } from './types';
import {
	ConfirmOptions,
	Signer,
	Transaction,
	TransactionSignature,
	Connection,
	VersionedTransaction,
	TransactionMessage,
	TransactionInstruction,
	AddressLookupTableAccount,
	Commitment,
} from '@solana/web3.js';
import { AnchorProvider } from '@coral-xyz/anchor';
import { IWallet } from '../types';
import { BaseTxSender } from './baseTxSender';

const DEFAULT_TIMEOUT = 35000;
const DEFAULT_BLOCKHASH_REFRESH = 10000;

export class FastSingleTxSender extends BaseTxSender {
	connection: Connection;
	wallet: IWallet;
	opts: ConfirmOptions;
	timeout: number;
	blockhashRefreshInterval: number;
	additionalConnections: Connection[];
	timoutCount = 0;
	recentBlockhash: string;
	skipConfirmation: boolean;
	blockhashCommitment: Commitment;
	blockhashIntervalId: NodeJS.Timer;

	public constructor({
		connection,
		wallet,
		opts = { ...AnchorProvider.defaultOptions(), maxRetries: 0 },
		timeout = DEFAULT_TIMEOUT,
		blockhashRefreshInterval = DEFAULT_BLOCKHASH_REFRESH,
		additionalConnections = new Array<Connection>(),
		skipConfirmation = false,
		blockhashCommitment = 'finalized',
		confirmationStrategy = ConfirmationStrategy.Combo,
	}: {
		connection: Connection;
		wallet: IWallet;
		opts?: ConfirmOptions;
		timeout?: number;
		blockhashRefreshInterval?: number;
		additionalConnections?;
		skipConfirmation?: boolean;
		blockhashCommitment?: Commitment;
		confirmationStrategy?: ConfirmationStrategy;
	}) {
		super({
			connection,
			wallet,
			opts,
			timeout,
			additionalConnections,
			confirmationStrategy,
		});
		this.connection = connection;
		this.wallet = wallet;
		this.opts = opts;
		this.timeout = timeout;
		this.blockhashRefreshInterval = blockhashRefreshInterval;
		this.additionalConnections = additionalConnections;
		this.skipConfirmation = skipConfirmation;
		this.blockhashCommitment = blockhashCommitment;
		this.startBlockhashRefreshLoop();
	}

	startBlockhashRefreshLoop(): void {
		if (this.blockhashRefreshInterval > 0) {
			this.blockhashIntervalId = setInterval(async () => {
				try {
					this.recentBlockhash = (
						await this.connection.getLatestBlockhash(this.blockhashCommitment)
					).blockhash;
				} catch (e) {
					console.error('Error in startBlockhashRefreshLoop: ', e);
				}
			}, this.blockhashRefreshInterval);
		}
	}

	async prepareTx(
		tx: Transaction,
		additionalSigners: Array<Signer>,
		_opts: ConfirmOptions,
		preSigned?: boolean
	): Promise<Transaction> {
		return super.prepareTx(tx, additionalSigners, _opts, preSigned);
	}

	async getVersionedTransaction(
		ixs: TransactionInstruction[],
		lookupTableAccounts: AddressLookupTableAccount[],
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		blockhash?: string
	): Promise<VersionedTransaction> {
		if (additionalSigners === undefined) {
			additionalSigners = [];
		}
		if (opts === undefined) {
			opts = this.opts;
		}

		let recentBlockhash = '';
		if (blockhash) {
			recentBlockhash = blockhash;
		} else {
			recentBlockhash =
				this.recentBlockhash ??
				(await this.connection.getLatestBlockhash(opts.preflightCommitment))
					.blockhash;
		}

		const message = new TransactionMessage({
			payerKey: this.wallet.publicKey,
			recentBlockhash,
			instructions: ixs,
		}).compileToV0Message(lookupTableAccounts);

		const tx = new VersionedTransaction(message);

		return tx;
	}

	async sendRawTransaction(
		rawTransaction: Buffer | Uint8Array,
		opts: ConfirmOptions
	): Promise<TxSigAndSlot> {
		let txid: TransactionSignature;
		try {
			txid = await this.connection.sendRawTransaction(rawTransaction, opts);
			this.sendToAdditionalConnections(rawTransaction, opts);
		} catch (e) {
			console.error(e);
			throw e;
		}

		let slot: number;
		if (!this.skipConfirmation) {
			try {
				const result = await this.confirmTransaction(txid, opts.commitment);
				slot = result.context.slot;
			} catch (e) {
				console.error(e);
				throw e;
			}
		}

		return { txSig: txid, slot };
	}
}
