import { ConfirmationStrategy, TxSigAndSlot } from './types';
import { ConfirmOptions, Connection } from '@solana/web3.js';
import { BaseTxSender } from './baseTxSender';
import { TxHandler } from './txHandler';
import { IWallet } from '../types';
import { DEFAULT_CONFIRMATION_OPTS } from '../config';

const DEFAULT_TIMEOUT = 35000;
const DEFAULT_RETRY = 2000;

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
		opts = { ...DEFAULT_CONFIRMATION_OPTS, maxRetries: 0 },
		timeout = DEFAULT_TIMEOUT,
		retrySleep = DEFAULT_RETRY,
		additionalConnections = new Array<Connection>(),
		confirmationStrategy = ConfirmationStrategy.Combo,
		additionalTxSenderCallbacks = [],
		txHandler,
		trackTxLandRate,
		txLandRateLookbackWindowMinutes,
		landRateToFeeFunc,
		throwOnTimeoutError = true,
	}: {
		connection: Connection;
		wallet: IWallet;
		opts?: ConfirmOptions;
		timeout?: number;
		retrySleep?: number;
		additionalConnections?;
		confirmationStrategy?: ConfirmationStrategy;
		additionalTxSenderCallbacks?: ((base58EncodedTx: string) => void)[];
		txHandler?: TxHandler;
		trackTxLandRate?: boolean;
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
			additionalTxSenderCallbacks,
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
			this.txSigCache?.set(txid, true);

			await this.checkConfirmationResultForError(txid, result?.value);

			slot = result?.context?.slot;
			// eslint-disable-next-line no-useless-catch
		} catch (e) {
			throw e;
		} finally {
			stopWaiting();
		}

		return { txSig: txid, slot };
	}
}
