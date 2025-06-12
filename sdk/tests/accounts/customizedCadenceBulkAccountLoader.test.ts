import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { CustomizedCadenceBulkAccountLoader } from '../../src/accounts/customizedCadenceBulkAccountLoader';
import { expect } from 'chai';

describe('CustomizedCadenceBulkAccountLoader', () => {
	let connection: Connection;
	let loader: CustomizedCadenceBulkAccountLoader;
	const defaultPollingFrequency = 1000;

	beforeEach(() => {
		connection = new Connection('http://localhost:8899', 'processed');
		loader = new CustomizedCadenceBulkAccountLoader(
			connection,
			'processed',
			defaultPollingFrequency
		);
	});

	afterEach(() => {
		loader.stopPolling();
	});

	it('should add account with custom polling frequency', async () => {
		const pubkey = new PublicKey(Keypair.generate().publicKey);
		const customFrequency = 500;
		const callback = () => {}; // Empty spy function for mocha

		const id = await loader.addAccount(pubkey, callback, customFrequency);

		expect(id).to.exist;
		expect(
            // @ts-ignore - accessing private property for testing
			loader.customPollingGroups.get(customFrequency)?.has(pubkey.toBase58())
		).to.equal(true);
	});

	it('should remove account and clean up polling', async () => {
		const pubkey = new PublicKey(Keypair.generate().publicKey);
		const customFrequency = 500;
		const callback = () => {

		};

		await loader.addAccount(pubkey, callback, customFrequency);
		loader.removeAccount(pubkey);

		expect(
            // @ts-ignore - accessing private property for testing
			loader.customPollingGroups.get(customFrequency)?.has(pubkey.toBase58())
		).to.equal(undefined);
	});

	it('should update custom polling frequency', async () => {
		const pubkey = new PublicKey(Keypair.generate().publicKey);
		const initialFrequency = 500;
		const newFrequency = 200;
		const callback = () => {

		};

		await loader.addAccount(pubkey, callback, initialFrequency);
		loader.setCustomPollingFrequency(pubkey, newFrequency);

		expect(
            // @ts-ignore - accessing private property for testing
			loader.customPollingGroups.get(initialFrequency)?.has(pubkey.toBase58())
		).to.equal(undefined);
		expect(
            // @ts-ignore - accessing private property for testing
			loader.customPollingGroups.get(newFrequency)?.has(pubkey.toBase58())
		).to.equal(true);
	});

	it('should use default polling frequency when no custom frequency provided', async () => {
		const pubkey = new PublicKey(Keypair.generate().publicKey);
		const callback = () => {

		};

		await loader.addAccount(pubkey, callback);

		expect(
            // @ts-ignore - accessing private property for testing
			loader.customPollingGroups
				.get(defaultPollingFrequency)
				?.has(pubkey.toBase58())
		).to.equal(true);
	});

	it('should clear all polling on stopPolling', async () => {
		const pubkey1 = new PublicKey(Keypair.generate().publicKey);
		const pubkey2 = new PublicKey(Keypair.generate().publicKey);
		const callback = () => {

		};

		await loader.addAccount(pubkey1, callback, 500);
		await loader.addAccount(pubkey2, callback, 1000);

		loader.stopPolling();

		// @ts-ignore - accessing private property for testing
		expect(loader.customIntervalIds.size).to.equal(0);
	});
});
