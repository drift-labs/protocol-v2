import { ConfirmationStrategy, TxSigAndSlot } from './types';
import {
	ConfirmOptions,
	TransactionSignature,
	Connection,
	Commitment,
	BlockhashWithExpiryBlockHeight,
} from '@solana/web3.js';
import { BaseTxSender } from './baseTxSender';
import { TxHandler } from './txHandler';
import { IWallet } from '../types';
import { DEFAULT_CONFIRMATION_OPTS } from '../config';

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
	recentBlockhash: BlockhashWithExpiryBlockHeight;
	skipConfirmation: boolean;
	confirmInBackground: boolean;
	blockhashCommitment: Commitment;
	blockhashIntervalId: NodeJS.Timer;

	public constructor({
		connection,
		wallet,
		opts = { ...DEFAULT_CONFIRMATION_OPTS, maxRetries: 0 },
		timeout = DEFAULT_TIMEOUT,
		blockhashRefreshInterval = DEFAULT_BLOCKHASH_REFRESH,
		additionalConnections = new Array<Connection>(),
		skipConfirmation = false,
		confirmInBackground = false,
		blockhashCommitment = 'finalized',
		confirmationStrategy = ConfirmationStrategy.Combo,
		trackTxLandRate,
		txHandler,
		txLandRateLookbackWindowMinutes,
		landRateToFeeFunc,
		throwOnTimeoutError = true,
	}: {
		connection: Connection;
		wallet: IWallet;
		opts?: ConfirmOptions;
		timeout?: number;
		blockhashRefreshInterval?: number;
		additionalConnections?;
		skipConfirmation?: boolean;
		confirmInBackground?: boolean;
		blockhashCommitment?: Commitment;
		confirmationStrategy?: ConfirmationStrategy;
		trackTxLandRate?: boolean;
		txHandler?: TxHandler;
		txLandRateLookbackWindowMinutes?: number;
		landRateToFeeFunc?: (landRate: number) => number;
		throwOnTimeoutError?: boolean;
	}) {
		super({
			connection,
			wallet,
			opts,
			timeout,
			additionalConnections,
			confirmationStrategy,
			txHandler,
			trackTxLandRate,
			txLandRateLookbackWindowMinutes,
			landRateToFeeFunc,
			throwOnTimeoutError,
		});
		this.connection = connection;
		this.wallet = wallet;
		this.opts = opts;
		this.timeout = timeout;
		this.blockhashRefreshInterval = blockhashRefreshInterval;
		this.additionalConnections = additionalConnections;
		this.skipConfirmation = skipConfirmation;
		this.confirmInBackground = confirmInBackground;
		this.blockhashCommitment = blockhashCommitment;
		this.startBlockhashRefreshLoop();
	}

	startBlockhashRefreshLoop(): void {
		if (this.blockhashRefreshInterval > 0) {
			this.blockhashIntervalId = setInterval(async () => {
				try {
					this.recentBlockhash = await this.connection.getLatestBlockhash(
						this.blockhashCommitment
					);
				} catch (e) {
					console.error('Error in startBlockhashRefreshLoop: ', e);
				}
			}, this.blockhashRefreshInterval);
		}
	}

	async sendRawTransaction(
		rawTransaction: Buffer | Uint8Array,
		opts: ConfirmOptions
	): Promise<TxSigAndSlot> {
		let txid: TransactionSignature;
		try {
			txid = await this.connection.sendRawTransaction(rawTransaction, opts);
			this.txSigCache?.set(txid, false);
			this.sendToAdditionalConnections(rawTransaction, opts);
		} catch (e) {
			console.error(e);
			throw e;
		}

		let slot: number;
		if (!this.skipConfirmation) {
			try {
				if (this.confirmInBackground) {
					this.confirmTransaction(txid, opts.commitment).then(
						async (result) => {
							this.txSigCache?.set(txid, true);
							await this.checkConfirmationResultForError(txid, result?.value);
							slot = result.context.slot;
						}
					);
				} else {
					const result = await this.confirmTransaction(txid, opts.commitment);
					this.txSigCache?.set(txid, true);
					await this.checkConfirmationResultForError(txid, result?.value);
					slot = result?.context?.slot;
				}
			} catch (e) {
				console.error(e);
				throw e;
			}
		}

		return { txSig: txid, slot };
	}
}
