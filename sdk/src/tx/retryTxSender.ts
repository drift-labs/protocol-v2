import { ConfirmationStrategy, TxSigAndSlot } from './types';
import { Commitment, ConfirmOptions, Connection } from '@solana/web3.js';
import { AnchorProvider } from '@coral-xyz/anchor';
import { IWallet } from '../types';
import { BaseTxSender } from './baseTxSender';

const DEFAULT_TIMEOUT = 35000;
const DEFAULT_RETRY = 8000;

type ResolveReference = {
	resolve?: () => void;
};

export class RetryTxSender extends BaseTxSender {
	connection: Connection;
	wallet: IWallet;
	opts: ConfirmOptions;
	timeout: number;
	retrySleep: number;
	additionalConnections: Connection[];
	timoutCount = 0;

	public constructor({
		connection,
		wallet,
		opts = AnchorProvider.defaultOptions(),
		timeout = DEFAULT_TIMEOUT,
		retrySleep = DEFAULT_RETRY,
		additionalConnections = new Array<Connection>(),
		confirmationStrategy = ConfirmationStrategy.Combo,
		blockhashCommitment = 'confirmed',
	}: {
		connection: Connection;
		wallet: IWallet;
		opts?: ConfirmOptions;
		timeout?: number;
		retrySleep?: number;
		additionalConnections?;
		confirmationStrategy?: ConfirmationStrategy;
		blockhashCommitment?: Commitment;
	}) {
		super({
			connection,
			wallet,
			opts,
			timeout,
			additionalConnections,
			confirmationStrategy,
			blockhashCommitment,
		});
		this.connection = connection;
		this.wallet = wallet;
		this.opts = opts;
		this.timeout = timeout;
		this.retrySleep = retrySleep;
		this.additionalConnections = additionalConnections;
	}

	async sleep(reference: ResolveReference): Promise<void> {
		return new Promise((resolve) => {
			reference.resolve = resolve;
			setTimeout(resolve, this.retrySleep);
		});
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

		const result = await this.confirmTransaction(txid, opts.commitment);
		const slot = result.context.slot;
		stopWaiting();

		return { txSig: txid, slot };
	}
}
