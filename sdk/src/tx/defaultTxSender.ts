import { TxSender } from './types';
import {
	ConfirmOptions,
	Signer,
	Transaction,
	TransactionSignature,
} from '@solana/web3.js';
import { Provider } from '@project-serum/anchor';

export class DefaultTxSender implements TxSender {
	provider: Provider;

	public constructor(provider: Provider) {
		this.provider = provider;
	}

	send(
		tx: Transaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions
	): Promise<TransactionSignature> {
		return this.provider.send(tx, additionalSigners, opts);
	}
}
