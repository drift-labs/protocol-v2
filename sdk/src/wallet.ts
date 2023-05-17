import {
	Keypair,
	PublicKey,
	Transaction,
	VersionedTransaction,
} from '@solana/web3.js';
import { IWallet, IVersionedWallet } from './types';
import fs from 'fs';
import bs58 from 'bs58';

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

export function loadKeypair(privateKey: string): Keypair {
	// try to load privateKey as a filepath
	let loadedKey: Uint8Array;
	if (fs.existsSync(privateKey)) {
		privateKey = fs.readFileSync(privateKey).toString();
	}

	if (privateKey.includes('[') && privateKey.includes(']')) {
		loadedKey = Uint8Array.from(JSON.parse(privateKey));
	} else if (privateKey.includes(',')) {
		loadedKey = Uint8Array.from(
			privateKey.split(',').map((val) => Number(val))
		);
	} else {
		privateKey = privateKey.replace(/\s/g, '');
		loadedKey = new Uint8Array(bs58.decode(privateKey));
	}

	return Keypair.fromSecretKey(Uint8Array.from(loadedKey));
}
