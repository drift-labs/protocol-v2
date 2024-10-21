import {
	ConfirmOptions,
	Connection,
	VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { BaseTxSender } from './baseTxSender';
import { ConfirmationStrategy, TxSigAndSlot } from './types';
import { TxHandler } from './txHandler';
import { IWallet } from '../types';
import { DEFAULT_CONFIRMATION_OPTS } from '../config';

const DEFAULT_TIMEOUT = 35000;
const DEFAULT_RETRY = 5000;

type ResolveReference = {
	resolve?: () => void;
};

export class ForwardOnlyTxSender extends BaseTxSender {
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
			additionalConnections: [],
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
		this.additionalConnections = [];
	}

	async sleep(reference: ResolveReference): Promise<void> {
		return new Promise((resolve) => {
			reference.resolve = resolve;
			setTimeout(resolve, this.retrySleep);
		});
	}

	sendToAdditionalConnections(
		rawTx: Buffer | Uint8Array,
		_opts: ConfirmOptions
	): void {
		this.additionalTxSenderCallbacks?.map((callback) => {
			callback(bs58.encode(rawTx));
		});
	}

	async sendRawTransaction(
		rawTransaction: Buffer | Uint8Array,
		opts: ConfirmOptions
	): Promise<TxSigAndSlot> {
		const deserializedTx = VersionedTransaction.deserialize(rawTransaction);

		const txSig = deserializedTx.signatures[0];
		const encodedTxSig = bs58.encode(txSig);

		const startTime = this.getTimestamp();

		this.sendToAdditionalConnections(rawTransaction, opts);
		this.txSigCache?.set(encodedTxSig, false);

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
					this.sendToAdditionalConnections(rawTransaction, opts);
				}
			}
		})();

		let slot: number;
		try {
			const result = await this.confirmTransaction(
				encodedTxSig,
				opts.commitment
			);
			slot = result?.context?.slot;
			this.txSigCache?.set(encodedTxSig, true);
			// eslint-disable-next-line no-useless-catch
		} catch (e) {
			throw e;
		} finally {
			stopWaiting();
		}

		return { txSig: encodedTxSig, slot };
	}
}
