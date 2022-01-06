import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { IWallet } from './types';

export class Wallet implements IWallet {
	constructor(readonly payer: Keypair) {}

	async signTransaction(tx: Transaction): Promise<Transaction> {
		tx.partialSign(this.payer);
		return tx;
	}

	async signAllTransactions(txs: Transaction[]): Promise<Transaction[]> {
		return txs.map((t) => {
			t.partialSign(this.payer);
			return t;
		});
	}

	get publicKey(): PublicKey {
		return this.payer.publicKey;
	}
}
