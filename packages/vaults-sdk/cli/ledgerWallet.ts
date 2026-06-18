import Solana from '@ledgerhq/hw-app-solana';
import type { default as Transport } from '@ledgerhq/hw-transport';
import TransportNodeHid from '@ledgerhq/hw-transport-node-hid';
import { getDevices } from '@ledgerhq/hw-transport-node-hid-noevents';
import {
	LedgerWalletAdapter,
	getDerivationPath,
} from '@solana/wallet-adapter-ledger';
import { PublicKey, Keypair } from '@solana/web3.js';
import type { Wallet } from '@velocity-exchange/sdk';

// Follows solana cli url format
// usb://<MANUFACTURER>[/<WALLET_ID>][?key=<ACCOUNT>[/<CHANGE>]]
// See: https://docs.solanalabs.com/cli/intro#hardware-wallet
export const parseKeypairUrl = (
	url = ''
): {
	walletId?: string;
	account?: number;
	change?: number;
} => {
	const walletId = url.match(/(?<=usb:\/\/ledger\/)(\w+)?/)?.[0];
	const [account, change] = (url.split('?key=')[1]?.split('/') ?? []).map(
		Number
	);
	return {
		walletId,
		account,
		change,
	};
};

async function getPublicKey(
	transport: Transport,
	account?: number,
	change?: number
): Promise<PublicKey> {
	const path =
		"44'/501'" + // Following BIP44 standard
		(account !== undefined ? `/${account}` : '') +
		(change !== undefined ? `/${change}` : '');

	const { address } = await new Solana(transport).getAddress(path);
	return new PublicKey(new Uint8Array(address));
}

/*
 * Returns a Drift compatible wallet backed by ledger hardware device
 * This only works in an nodejs environment, based on the transport used
 *
 * Key derivation path is set based on:
 * See: https://docs.solanalabs.com/cli/intro#hardware-wallet
 */
export async function getLedgerWallet(url = ''): Promise<Wallet> {
	const { account, change, walletId } = parseKeypairUrl(url);

	const derivationPath = getDerivationPath(account, change);

	// Load the first device
	let transport = await TransportNodeHid.open('');

	// If walletId is specified, we need to loop and correct device.
	if (walletId) {
		const devices = getDevices();
		let correctDeviceFound = false;

		for (const device of devices) {
			// Wallet id is the public key of the device (with no account or change)
			const connectedWalletId = await getPublicKey(
				transport,
				undefined,
				undefined
			);

			if (connectedWalletId.toString() === walletId) {
				correctDeviceFound = true;
				break;
			}

			transport.close();
			transport = await TransportNodeHid.open(device.path);
		}

		if (!correctDeviceFound) {
			throw new Error('Wallet not found');
		}
	}

	const publicKey = await getPublicKey(transport, account, change);

	// We can reuse the existing ledger wallet adapter
	// But we need to inject/hack in our own transport (as we not a browser)
	const wallet = new LedgerWalletAdapter({ derivationPath });

	// Do some hacky things to get the wallet to work
	// These are all done in the `connect` of the ledger wallet adapter
	wallet['_transport'] = transport;
	wallet['_publicKey'] = publicKey;
	transport.on('disconnect', wallet['_disconnected']);
	wallet.emit('connect', publicKey);

	// Return a Drift compatible wallet
	return {
		payer: undefined as unknown as Keypair, // Doesn't appear to break things
		publicKey: publicKey,
		signTransaction: wallet.signTransaction.bind(wallet),
		signVersionedTransaction: wallet.signTransaction.bind(wallet),
		signAllTransactions: wallet.signAllTransactions.bind(wallet),
		signAllVersionedTransactions: wallet.signAllTransactions.bind(wallet),
	};
}
