import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { CustomizedCadenceBulkAccountLoader } from '../../src/accounts/customizedCadenceBulkAccountLoader';
import { expect } from 'chai';

describe('CustomizedCadenceBulkAccountLoader', () => {
	let connection: Connection;
	let loader: CustomizedCadenceBulkAccountLoader;
	const defaultPollingFrequency = 1000;

	beforeEach(() => {
		connection = {
			_rpcBatchRequest: async () => {
				return Promise.resolve([
					{
						result: {
							context: { slot: 1 },
							value: Array(10)
								.fill(null)
								.map(() => ({
									data: [
										Buffer.from(Math.random().toString()).toString('base64'),
										'base64',
									],
								})),
						},
					},
				]);
			},
		} as unknown as Connection;
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
		expect(loader.getAccountCadence(pubkey)).to.equal(customFrequency);
	});

	it('should remove account and clean up polling', async () => {
		const pubkey = new PublicKey(Keypair.generate().publicKey);
		const customFrequency = 500;
		const callback = () => {};

		const cid = await loader.addAccount(pubkey, callback, customFrequency);
		loader.removeAccount(pubkey, cid);

		expect(loader.getAccountCadence(pubkey)).to.equal(null);
	});

	it('should update custom polling frequency', async () => {
		const pubkey = new PublicKey(Keypair.generate().publicKey);
		const initialFrequency = 500;
		const newFrequency = 200;
		const callback = () => {};

		await loader.addAccount(pubkey, callback, initialFrequency);
		loader.setCustomPollingFrequency(pubkey, newFrequency);

		expect(loader.getAccountCadence(pubkey)).to.equal(newFrequency);
	});

	it('should use default polling frequency when no custom frequency provided', async () => {
		const pubkey = new PublicKey(Keypair.generate().publicKey);
		const callback = () => {};

		await loader.addAccount(pubkey, callback);

		expect(loader.getAccountCadence(pubkey)).to.equal(defaultPollingFrequency);
	});

	it('should clear all polling on clearAccountFrequencies', async () => {
		const pubkey1 = new PublicKey(Keypair.generate().publicKey);
		const pubkey2 = new PublicKey(Keypair.generate().publicKey);
		const callback = () => {};

		await loader.addAccount(pubkey1, callback, 500);
		await loader.addAccount(pubkey2, callback, 1000);
		loader.clearAccountFrequencies();

		expect(loader.getAccountCadence(pubkey1)).to.equal(null);
		expect(loader.getAccountCadence(pubkey2)).to.equal(null);
	});

	it('should remove key from previous polling group when setting new frequency', async () => {
		const pubkey = new PublicKey(Keypair.generate().publicKey);
		const pubkey2 = new PublicKey(Keypair.generate().publicKey);
		const pubkey3 = new PublicKey(Keypair.generate().publicKey);
		const initialFrequency = 500;
		const newFrequency = 1000;
		const callback = () => {};

		// Add accounts with initial frequency
		await loader.addAccount(pubkey, callback, initialFrequency);
		await loader.addAccount(pubkey2, callback, initialFrequency);
		await loader.addAccount(pubkey3, callback, initialFrequency);

		// Verify they're all in the initial frequency group
		expect(loader.getAccountCadence(pubkey)).to.equal(initialFrequency);
		expect(loader.getAccountCadence(pubkey2)).to.equal(initialFrequency);
		expect(loader.getAccountCadence(pubkey3)).to.equal(initialFrequency);

		// Change polling frequency for first pubkey only
		loader.setCustomPollingFrequency(pubkey, newFrequency);

		// Verify first pubkey is updated to new frequency
		expect(loader.getAccountCadence(pubkey)).to.equal(newFrequency);

		// Verify other pubkeys remain in initial group
		expect(loader.getAccountCadence(pubkey2)).to.equal(initialFrequency);
		expect(loader.getAccountCadence(pubkey3)).to.equal(initialFrequency);
	});

	it('accounts in different polling groups fire at appropriate intervals', async () => {
		const loader = new CustomizedCadenceBulkAccountLoader(
			connection,
			'processed',
			1000
		);

		// Create test accounts and callbacks with counters
		const oneSecGroupPubkey = new PublicKey(Keypair.generate().publicKey);
		const oneSecGroup = {
			pubkey: oneSecGroupPubkey,
			callCount: 0,
		};

		const threeSecGroup = Array.from({ length: 5 }, () => ({
			pubkey: new PublicKey(Keypair.generate().publicKey),
			callCount: 0,
		}));

		const fourSecGroup = Array.from({ length: 10 }, () => ({
			pubkey: new PublicKey(Keypair.generate().publicKey),
			callCount: 0,
		}));

		// Add accounts with different frequencies
		await loader.addAccount(
			oneSecGroup.pubkey,
			() => {
				oneSecGroup.callCount += 1;
			},
			1000
		);

		for (const account of threeSecGroup) {
			await loader.addAccount(
				account.pubkey,
				() => {
					account.callCount++;
				},
				3000
			);
		}

		for (const account of fourSecGroup) {
			await loader.addAccount(
				account.pubkey,
				() => {
					account.callCount++;
				},
				4000
			);
		}

		loader.startPolling();

		// Wait for 6 seconds to allow multiple intervals to fire
		await new Promise((resolve) => setTimeout(resolve, 4500));

		// 1s group should have fired ~4 times
		expect(oneSecGroup.callCount).to.be.greaterThanOrEqual(3);
		expect(oneSecGroup.callCount).to.be.lessThanOrEqual(5);

		// 3s group should have fired ~2 times
		for (const account of threeSecGroup) {
			expect(account.callCount).to.be.greaterThanOrEqual(1);
			expect(account.callCount).to.be.lessThanOrEqual(3);
		}

		// 5s group should have fired ~1 time
		for (const account of fourSecGroup) {
			expect(account.callCount).to.be.greaterThanOrEqual(1);
			expect(account.callCount).to.be.lessThanOrEqual(2);
		}

		loader.stopPolling();
	});
});
