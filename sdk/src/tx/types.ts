import { Provider } from '@project-serum/anchor';
import {
	ConfirmOptions,
	Signer,
	Transaction,
	TransactionSignature,
} from '@solana/web3.js';

export type TxSigAndSlot = {
	txSig: TransactionSignature;
	slot: number;
};

export interface TxSender {
	provider: Provider;

	send(
		tx: Transaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions
	): Promise<TxSigAndSlot>;
}
