import { TxSigAndSlot } from './types';
import {
	ConfirmOptions,
	TransactionSignature,
	Connection,
} from '@solana/web3.js';
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
	}: {
		connection: Connection;
		wallet: IWallet;
		opts?: ConfirmOptions;
		timeout?: number;
		retrySleep?: number;
		additionalConnections?;
	}) {
		super({ connection, wallet, opts, timeout, additionalConnections });
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

		let txid: TransactionSignature;
		try {
			txid = await this.connection.sendRawTransaction(rawTransaction, opts);
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
			slot = result.context.slot;
		} catch (e) {
			console.error(e);
			throw e;
		} finally {
			stopWaiting();
		}

		return { txSig: txid, slot };
	}
}
