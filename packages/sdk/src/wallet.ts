import {
	Keypair,
	PublicKey,
	Transaction,
	VersionedTransaction,
} from '@solana/web3.js';
import { IWallet, IVersionedWallet } from './types';
import nacl from 'tweetnacl';

export class Wallet implements IWallet, IVersionedWallet {
	constructor(readonly payer: Keypair) {}

	async signTransaction(tx: Transaction): Promise<Transaction> {
		tx.partialSign(this.payer);
		return tx;
	}

	async signVersionedTransaction(
		tx: VersionedTransaction
	): Promise<VersionedTransaction> {
		tx.sign([this.payer]);
		return tx;
	}

	async signAllTransactions(txs: Transaction[]): Promise<Transaction[]> {
		return txs.map((t) => {
			t.partialSign(this.payer);
			return t;
		});
	}

	async signAllVersionedTransactions(
		txs: VersionedTransaction[]
	): Promise<VersionedTransaction[]> {
		return txs.map((t) => {
			t.sign([this.payer]);
			return t;
		});
	}

	get publicKey(): PublicKey {
		return this.payer.publicKey;
	}
}

export class WalletV2 extends Wallet {
	constructor(readonly payer: Keypair) {
		super(payer);
	}

	async signMessage(message: Uint8Array): Promise<Uint8Array> {
		return Buffer.from(nacl.sign.detached(message, this.payer.secretKey));
	}
}
