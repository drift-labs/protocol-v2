import {
	ConfirmOptions,
	Signer,
	Transaction,
	TransactionSignature,
} from '@solana/web3.js';

export interface TxSender {
	send(
		tx: Transaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions
	): Promise<TransactionSignature>;
}
