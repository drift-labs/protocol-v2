import {
	Keypair,
	PublicKey,
	Transaction,
	VersionedTransaction,
} from '@solana/web3.js';
import { IWallet, IVersionedWallet } from './types';
import nacl from 'tweetnacl';

export class Wallet implements IWallet, IVersionedWallet {
	readonly payer?: Keypair;

	constructor(
		readonly authority: Keypair,
		payer?: Keypair
	) {
		this.payer = payer ?? authority;
	}

	async signTransaction(tx: Transaction): Promise<Transaction> {
		if (
			this.payer &&
			this.payer.publicKey.toBase58() !== this.authority.publicKey.toBase58()
		) {
			tx.partialSign(this.payer, this.authority);
		} else {
			tx.partialSign(this.authority);
		}
		return tx;
	}

	async signVersionedTransaction(
		tx: VersionedTransaction
	): Promise<VersionedTransaction> {
		if (
			this.payer &&
			this.payer.publicKey.toBase58() !== this.authority.publicKey.toBase58()
		) {
			tx.sign([this.payer, this.authority]);
		} else {
			tx.sign([this.authority]);
		}
		return tx;
	}

	async signAllTransactions(txs: Transaction[]): Promise<Transaction[]> {
		return txs.map((t) => {
			if (
				this.payer &&
				this.payer.publicKey.toBase58() !== this.authority.publicKey.toBase58()
			) {
				t.partialSign(this.payer, this.authority);
			} else {
				t.partialSign(this.authority);
			}
			return t;
		});
	}

	async signAllVersionedTransactions(
		txs: VersionedTransaction[]
	): Promise<VersionedTransaction[]> {
		return txs.map((t) => {
			if (
				this.payer &&
				this.payer.publicKey.toBase58() !== this.authority.publicKey.toBase58()
			) {
				t.sign([this.payer, this.authority]);
			} else {
				t.sign([this.authority]);
			}
			return t;
		});
	}

	get publicKey(): PublicKey {
		return this.authority.publicKey;
	}
}

export class WalletV2 extends Wallet {
	constructor(readonly authority: Keypair) {
		super(authority);
	}

	async signMessage(message: Uint8Array): Promise<Uint8Array> {
		return Buffer.from(nacl.sign.detached(message, this.authority.secretKey));
	}
}
