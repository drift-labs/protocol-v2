import {
	AddressLookupTableAccount,
	ConfirmOptions,
	Signer,
	Transaction,
	TransactionInstruction,
	TransactionSignature,
	VersionedTransaction,
} from '@solana/web3.js';
import { IWallet, PositionDirection } from '../types';
import { BN, SwapMode } from '..';

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
		opts?: ConfirmOptions
	): Promise<VersionedTransaction>;

	sendRawTransaction(
		rawTransaction: Buffer | Uint8Array,
		opts: ConfirmOptions
	): Promise<TxSigAndSlot>;

	getTimeoutCount(): number;
}

export type RiskIncreasingAction =
	| 'withdraw'
	| 'borrow'
	| 'perpTrade'
	| 'spotTrade'
	| 'swap';

export type PreSettleOpts = {
	txType: RiskIncreasingAction;
	notionalValueRequested?: BN;
	baseAmountRequested?: BN;
	perpMarketIndex?: number;
	spotMarketIndex?: number;
	inMarketIndex?: number;
	outMarketIndex?: number;
	tradeDirection?: PositionDirection;
	reduceOnlyTrade?: boolean;
	swapMode?: SwapMode;
};
