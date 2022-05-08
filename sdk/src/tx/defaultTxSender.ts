import { TxSender } from './types';
import {
	ConfirmOptions,
	Signer,
	Transaction,
	TransactionSignature,
} from '@solana/web3.js';
import { AnchorProvider } from '@project-serum/anchor';

export class DefaultTxSender implements TxSender {
	provider: AnchorProvider;

	public constructor(provider: AnchorProvider) {
		this.provider = provider;
	}

	send(
		tx: Transaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions
	): Promise<TransactionSignature> {
		return this.provider.sendAndConfirm(tx, additionalSigners, opts);
	}
}
