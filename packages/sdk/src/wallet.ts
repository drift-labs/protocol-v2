import {
	Keypair,
	PublicKey,
	Transaction,
	VersionedTransaction,
} from '@solana/web3.js';
import { IWallet, IVersionedWallet } from './types';
import nacl from 'tweetnacl';

/**
 * Local-keypair implementation of `IWallet`/`IVersionedWallet` that signs directly with an
 * in-memory `Keypair` (no external wallet/RPC round-trip). Suitable for keeper bots, scripts, and
 * tests; not for browser dapps holding user funds.
 */
export class Wallet implements IWallet, IVersionedWallet {
	constructor(readonly payer: Keypair) {}

	/**
	 * Partially signs a legacy `Transaction` with this wallet's keypair, leaving any other
	 * required signatures untouched.
	 * @param tx - Transaction to sign; mutated in place.
	 * @returns The same transaction instance, now signed by `payer`.
	 */
	async signTransaction(tx: Transaction): Promise<Transaction> {
		tx.partialSign(this.payer);
		return tx;
	}

	/**
	 * Signs a `VersionedTransaction` with this wallet's keypair.
	 * @param tx - Transaction to sign; mutated in place.
	 * @returns The same transaction instance, now signed by `payer`.
	 */
	async signVersionedTransaction(
		tx: VersionedTransaction
	): Promise<VersionedTransaction> {
		tx.sign([this.payer]);
		return tx;
	}

	/**
	 * Partially signs a batch of legacy `Transaction`s with this wallet's keypair.
	 * @param txs - Transactions to sign; each is mutated in place.
	 * @returns The same transaction instances, now signed by `payer`.
	 */
	async signAllTransactions(txs: Transaction[]): Promise<Transaction[]> {
		return txs.map((t) => {
			t.partialSign(this.payer);
			return t;
		});
	}

	/**
	 * Signs a batch of `VersionedTransaction`s with this wallet's keypair.
	 * @param txs - Transactions to sign; each is mutated in place.
	 * @returns The same transaction instances, now signed by `payer`.
	 */
	async signAllVersionedTransactions(
		txs: VersionedTransaction[]
	): Promise<VersionedTransaction[]> {
		return txs.map((t) => {
			t.sign([this.payer]);
			return t;
		});
	}

	/** The wallet's public key, i.e. `payer.publicKey`. */
	get publicKey(): PublicKey {
		return this.payer.publicKey;
	}
}

/**
 * `Wallet` variant that additionally supports raw message signing (`signMessage`), needed for
 * flows like swift/signed-message orders that sign an ed25519 payload outside of a transaction.
 */
export class WalletV2 extends Wallet {
	constructor(readonly payer: Keypair) {
		super(payer);
	}

	/**
	 * Signs an arbitrary message with this wallet's ed25519 secret key (detached signature, not a
	 * transaction).
	 * @param message - Raw bytes to sign.
	 * @returns The 64-byte detached ed25519 signature.
	 */
	async signMessage(message: Uint8Array): Promise<Uint8Array> {
		return Buffer.from(nacl.sign.detached(message, this.payer.secretKey));
	}
}
