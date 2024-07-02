import { expect } from 'chai';
import sinon from 'sinon';
import {
	Connection,
	Commitment,
	BlockhashWithExpiryBlockHeight,
} from '@solana/web3.js';
import { CachedBlockhashFetcher } from '../../src/tx/blockhashFetcher/cachedBlockhashFetcher';

describe('CachedBlockhashFetcher', () => {
	let connection: sinon.SinonStubbedInstance<Connection>;
	let cachedBlockhashFetcher: CachedBlockhashFetcher;
	const mockBlockhash: BlockhashWithExpiryBlockHeight = {
		blockhash: 'mockedBlockhash',
		lastValidBlockHeight: 1000,
	};

	beforeEach(() => {
		connection = sinon.createStubInstance(Connection);
		connection.getLatestBlockhash.resolves(mockBlockhash);

		cachedBlockhashFetcher = new CachedBlockhashFetcher(
			connection as unknown as Connection,
			'confirmed' as Commitment,
			3,
			100,
			1000
		);
	});

	afterEach(() => {
		sinon.restore();
	});

	it('should fetch and cache the latest blockhash', async () => {
		const result = await cachedBlockhashFetcher.getLatestBlockhash();
		expect(result).to.deep.equal(mockBlockhash);
		expect(connection.getLatestBlockhash.calledOnce).to.be.true;
	});

	it('should use cached blockhash if not stale', async () => {
		await cachedBlockhashFetcher.getLatestBlockhash();
		await cachedBlockhashFetcher.getLatestBlockhash();
		expect(connection.getLatestBlockhash.calledOnce).to.be.true;
	});

	it('should refresh blockhash if cache is stale', async () => {
		const clock = sinon.useFakeTimers();

		await cachedBlockhashFetcher.getLatestBlockhash();

		// Advance time to make cache stale
		clock.tick(1100);

		await cachedBlockhashFetcher.getLatestBlockhash();
		expect(connection.getLatestBlockhash.calledTwice).to.be.true;

		clock.restore();
	});

	it('should retry on failure', async () => {
		connection.getLatestBlockhash
			.onFirstCall()
			.rejects(new Error('Network error'))
			.onSecondCall()
			.rejects(new Error('Network error'))
			.onThirdCall()
			.resolves(mockBlockhash);

		const result = await cachedBlockhashFetcher.getLatestBlockhash();
		expect(result).to.deep.equal(mockBlockhash);
		expect(connection.getLatestBlockhash.calledThrice).to.be.true;
	});

	it('should throw error after maximum retries', async () => {
		connection.getLatestBlockhash.rejects(new Error('Network error'));

		try {
			await cachedBlockhashFetcher.getLatestBlockhash();
			expect.fail('Should have thrown an error');
		} catch (error) {
			expect(error.message).to.equal(
				'Failed to fetch blockhash after maximum retries'
			);
		}
		expect(connection.getLatestBlockhash.calledThrice).to.be.true;
	});

	it('should prevent concurrent requests for the same blockhash', async () => {
		const promise1 = cachedBlockhashFetcher.getLatestBlockhash();
		const promise2 = cachedBlockhashFetcher.getLatestBlockhash();

		await Promise.all([promise1, promise2]);
		expect(connection.getLatestBlockhash.calledOnce).to.be.true;
	});
});
