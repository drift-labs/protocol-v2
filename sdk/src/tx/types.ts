import {
	AddressLookupTableAccount,
	ConfirmOptions,
	Signer,
	Transaction,
	TransactionInstruction,
	TransactionSignature,
	VersionedTransaction,
} from '@solana/web3.js';
import { IWallet } from '../types';

export enum ConfirmationStrategy {
	WebSocket = 'websocket',
	Polling = 'polling',
	Combo = 'combo',
}

export type TxSigAndSlot = {
	txSig: TransactionSignature;
	slot: number;
};

export type ExtraConfirmationOptions = {
	onSignedCb: () => void;
};

export interface TxSender {
	wallet: IWallet;
	recentBlockhash: string;

	send(
		tx: Transaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		preSigned?: boolean,
		extraConfirmationOptions?: ExtraConfirmationOptions
	): Promise<TxSigAndSlot>;

	sendVersionedTransaction(
		tx: VersionedTransaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		preSigned?: boolean,
		extraConfirmationOptions?: ExtraConfirmationOptions
	): Promise<TxSigAndSlot>;

	getVersionedTransaction(
		ixs: TransactionInstruction[],
		lookupTableAccounts: AddressLookupTableAccount[],
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		blockhash?: string
	): Promise<VersionedTransaction>;

	sendRawTransaction(
		rawTransaction: Buffer | Uint8Array,
		opts: ConfirmOptions
	): Promise<TxSigAndSlot>;

	simulateTransaction(tx: VersionedTransaction): Promise<boolean>;

	getTimeoutCount(): number;
}
