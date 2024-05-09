import { ConfirmationStrategy, TxSigAndSlot } from './types';
import {
	ConfirmOptions,
	Signer,
	TransactionSignature,
	Connection,
	VersionedTransaction,
	TransactionInstruction,
	AddressLookupTableAccount,
	Commitment,
} from '@solana/web3.js';
import { AnchorProvider } from '@coral-xyz/anchor';
import { IWallet } from '../types';
import { BaseTxSender } from './baseTxSender';
import { TxHandler } from './txHandler';
import { BlockHashAndValidSlot } from "./types";

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
	recentBlockhash: BlockHashAndValidSlot;
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
		txHandler,
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
		txHandler: TxHandler,
	}) {
		super({
			connection,
			wallet,
			opts,
			timeout,
			additionalConnections,
			confirmationStrategy,
			txHandler
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
					);
				} catch (e) {
					console.error('Error in startBlockhashRefreshLoop: ', e);
				}
			}, this.blockhashRefreshInterval);
		}
	}

	async getVersionedTransaction(
		ixs: TransactionInstruction[],
		lookupTableAccounts: AddressLookupTableAccount[],
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		blockhash?: BlockHashAndValidSlot
	): Promise<VersionedTransaction> {
		if (additionalSigners === undefined) {
			additionalSigners = [];
		}
		if (opts === undefined) {
			opts = this.opts;
		}

		const recentBlockhash =
			blockhash ??
			this.recentBlockhash ??
			(await this.connection.getLatestBlockhash(opts.preflightCommitment));

		return this.txHandler.getVersionedTransaction(
			ixs,
			lookupTableAccounts,
			additionalSigners,
			opts,
			recentBlockhash
		);
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
