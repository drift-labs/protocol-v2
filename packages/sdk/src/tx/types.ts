import {
	AddressLookupTableAccount,
	BlockhashWithExpiryBlockHeight,
	ConfirmOptions,
	Signer,
	Transaction,
	TransactionInstruction,
	TransactionSignature,
	VersionedTransaction,
} from '@solana/web3.js';
import { IWallet } from '../types';

/** How a `TxSender` implementation waits for a transaction to confirm. */
export enum ConfirmationStrategy {
	/** Confirm via an RPC websocket `onSignature` subscription only. */
	WebSocket = 'websocket',
	/** Confirm by polling `getSignatureStatuses` only. */
	Polling = 'polling',
	/** Race a websocket subscription against polling and resolve on whichever confirms first. */
	Combo = 'combo',
}

/** A landed transaction's signature plus the slot it was confirmed at (`undefined` if the slot wasn't available). */
export type TxSigAndSlot = {
	txSig: TransactionSignature;
	slot: number | undefined;
};

/** Common interface implemented by every transaction-sending strategy (`BaseTxSender` and its subclasses). */
export interface TxSender {
	wallet: IWallet;

	/**
	 * Signs (unless `preSigned`), sends, and confirms a legacy `Transaction`.
	 * @param tx - Transaction to send.
	 * @param additionalSigners - Extra signers to co-sign alongside the wallet.
	 * @param opts - Confirmation options overriding the sender's defaults.
	 * @param preSigned - If `true`, skip wallet signing (the transaction is already fully signed).
	 * @returns The landed transaction's signature and confirmation slot.
	 */
	send(
		tx: Transaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		preSigned?: boolean
	): Promise<TxSigAndSlot>;

	/**
	 * Signs (unless `preSigned`), sends, and confirms a `VersionedTransaction`.
	 * @param tx - Transaction to send.
	 * @param additionalSigners - Extra signers to co-sign alongside the wallet.
	 * @param opts - Confirmation options overriding the sender's defaults.
	 * @param preSigned - If `true`, skip wallet signing (the transaction is already fully signed).
	 * @returns The landed transaction's signature and confirmation slot.
	 */
	sendVersionedTransaction(
		tx: VersionedTransaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		preSigned?: boolean
	): Promise<TxSigAndSlot>;

	/**
	 * Builds (but does not send or sign) an unsigned `VersionedTransaction` from raw instructions.
	 * @param ixs - Instructions to include, in order.
	 * @param lookupTableAccounts - Address lookup tables to compile the message against.
	 * @param additionalSigners - Unused by `BaseTxSender` (signing happens at send time, e.g. in `sendVersionedTransaction`).
	 * @param opts - Unused by `BaseTxSender`.
	 * @param blockhash - Blockhash to compile the message with; if omitted, the sender fetches a current one.
	 * @returns The compiled, unsigned `VersionedTransaction`, not yet sent.
	 */
	getVersionedTransaction(
		ixs: TransactionInstruction[],
		lookupTableAccounts: AddressLookupTableAccount[],
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		blockhash?: BlockhashWithExpiryBlockHeight
	): Promise<VersionedTransaction>;

	/**
	 * Sends an already-serialized, already-signed transaction and confirms it.
	 * @param rawTransaction - Wire-format serialized transaction bytes.
	 * @param opts - Confirmation options.
	 * @returns The landed transaction's signature and confirmation slot.
	 */
	sendRawTransaction(
		rawTransaction: Buffer | Uint8Array,
		opts: ConfirmOptions
	): Promise<TxSigAndSlot>;

	/**
	 * Simulates a transaction against the cluster without sending it.
	 * @param tx - Transaction to simulate.
	 * @returns `true` if the simulation succeeded (no error), `false` otherwise.
	 */
	simulateTransaction(tx: VersionedTransaction): Promise<boolean>;

	/** Number of transactions sent by this sender that timed out waiting for confirmation. */
	getTimeoutCount(): number;
	/** Multiplier this sender currently recommends applying to a base priority fee, derived from recent land/timeout behavior. */
	getSuggestedPriorityFeeMultiplier(): number;
	/** Fraction (0-1) of recently sent transactions that landed successfully. */
	getTxLandRate(): number;
}

/** Error thrown by tx senders when a transaction fails to send or confirm, carrying a stable numeric `code` (see `constants/txConstants`) alongside the message. */
export class TxSendError extends Error {
	constructor(
		public message: string,
		public code: number
	) {
		super(message);
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, TxSendError);
		}
	}
}
