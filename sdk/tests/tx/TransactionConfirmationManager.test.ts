import { expect } from 'chai';
import sinon from 'sinon';
import {
	Connection,
	SignatureStatus,
	VersionedTransactionResponse,
} from '@solana/web3.js';
import { TransactionConfirmationManager } from '../../src/util/TransactionConfirmationManager';
import assert from 'assert';

describe('TransactionConfirmationManager_Polling_Tests', () => {
	let manager: TransactionConfirmationManager;
	let mockConnection: sinon.SinonStubbedInstance<Connection>;

	beforeEach(() => {
		mockConnection = sinon.createStubInstance(Connection);
		manager = new TransactionConfirmationManager(
			mockConnection as unknown as Connection
		);
	});

	afterEach(() => {
		sinon.restore();
	});

	it('should throw error for invalid poll interval', async () => {
		try {
			await manager.confirmTransactionPolling(
				'fakeTxSig',
				'confirmed',
				30000,
				300
			);
			assert.fail('Expected an error to be thrown');
		} catch (error) {
			assert(error instanceof Error);
			assert.strictEqual(
				error.message,
				'Transaction confirmation polling interval must be at least 400ms and a multiple of 100ms'
			);
		}
	});

	it('should resolve when transaction is confirmed', async () => {
		const fakeTxSig = 'fakeTxSig';
		const fakeStatus: SignatureStatus = {
			slot: 100,
			confirmations: 1,
			err: null,
			confirmationStatus: 'confirmed',
		};

		mockConnection.getSignatureStatuses.resolves({
			context: { slot: 100 },
			value: [fakeStatus],
		});

		const result = await manager.confirmTransactionPolling(
			fakeTxSig,
			'confirmed',
			30000,
			400
		);

		expect(result).to.deep.equal(fakeStatus);
		expect(
			mockConnection.getSignatureStatuses.calledWith([fakeTxSig], {
				searchTransactionHistory: false,
			})
		).to.be.true;
	});

	it('should reject when transaction fails', async function () {
		const fakeTxSig = 'fakeTxSig';
		const fakeStatus: SignatureStatus = {
			slot: 100,
			confirmations: 1,
			err: { InstructionError: [0, 'Custom'] },
			confirmationStatus: 'confirmed',
		};

		mockConnection.getSignatureStatuses.resolves({
			context: { slot: 100 },
			value: [fakeStatus],
		});

		// The transaction manager falls into getTransaction when it detects a transaction failure so we need to mock that as well
		// @ts-ignore
		mockConnection.getTransaction.resolves({
			meta: {
				logMessages: ['Transaction failed: Custom'],
				err: { InstructionError: [0, 'Custom'] },
			},
		} as VersionedTransactionResponse);

		try {
			await manager.confirmTransactionPolling(
				fakeTxSig,
				'confirmed',
				30000,
				400
			);
			assert.fail('Expected an error to be thrown');
		} catch (error) {
			return;
		}
	});

	it('should reject on timeout', async () => {
		const clock = sinon.useFakeTimers();

		const fakeTxSig = 'fakeTxSig';
		mockConnection.getSignatureStatuses.resolves({
			context: { slot: 100 },
			value: [null],
		});

		const promise = manager.confirmTransactionPolling(
			fakeTxSig,
			'confirmed',
			5000,
			1000
		);

		clock.tick(6000);

		try {
			await promise;
			assert.fail('Expected an error to be thrown');
		} catch (error) {
			assert(error instanceof Error);
			assert.strictEqual(
				error.message,
				'Transaction confirmation timeout after 5000ms'
			);
		}

		clock.restore();
	});

	it('should check multiple transactions together', async () => {
		const fakeTxSig1 = 'fakeTxSig1';
		const fakeTxSig2 = 'fakeTxSig2';
		const fakeStatus1: SignatureStatus = {
			slot: 100,
			confirmations: 1,
			err: null,
			confirmationStatus: 'confirmed',
		};
		const fakeStatus2: SignatureStatus = {
			slot: 100,
			confirmations: 1,
			err: null,
			confirmationStatus: 'confirmed',
		};

		mockConnection.getSignatureStatuses.resolves({
			context: { slot: 100 },
			value: [fakeStatus1, fakeStatus2],
		});

		const promise1 = manager.confirmTransactionPolling(
			fakeTxSig1,
			'confirmed',
			30000,
			400
		);
		const promise2 = manager.confirmTransactionPolling(
			fakeTxSig2,
			'confirmed',
			30000,
			400
		);

		const clock = sinon.useFakeTimers();
		clock.tick(400);
		clock.restore();

		const [result1, result2] = await Promise.all([promise1, promise2]);

		expect(result1).to.deep.equal(fakeStatus1);
		expect(result2).to.deep.equal(fakeStatus2);
		expect(
			mockConnection.getSignatureStatuses.calledWith([fakeTxSig1, fakeTxSig2], {
				searchTransactionHistory: false,
			})
		).to.be.true;
	});

	it('should have overlapping request for transactions with 400ms and 1200ms intervals on the third 400ms interval', async function () {
		this.timeout(5000); // Increase timeout for this test to 5 seconds

		const fakeTxSig1 = 'fakeTxSig1'; // 400ms interval
		const fakeTxSig2 = 'fakeTxSig2'; // 1200ms interval
		const fakeStatus: SignatureStatus = {
			slot: 100,
			confirmations: 1,
			err: null,
			confirmationStatus: 'confirmed',
		};

		let callCount = 0;
		const callTimes: number[] = [];
		const callSignatures: string[][] = [];

		mockConnection.getSignatureStatuses = async (signatures) => {
			callCount++;
			const currentTime = Date.now();
			callTimes.push(currentTime);
			callSignatures.push([...signatures]);

			if (callCount < 3) {
				return {
					context: { slot: 100 },
					value: signatures.map(() => null),
				};
			} else {
				return {
					context: { slot: 100 },
					value: signatures.map(() => fakeStatus),
				};
			}
		};

		const startTime = Date.now();

		// Start both confirmation processes
		const promise1 = manager.confirmTransactionPolling(
			fakeTxSig1,
			'confirmed',
			5000,
			400
		);
		const promise2 = manager.confirmTransactionPolling(
			fakeTxSig2,
			'confirmed',
			5000,
			1200
		);

		// Wait for 1250ms to ensure we've hit the third 400ms interval and first 1200ms interval
		await new Promise((resolve) => setTimeout(resolve, 1250));

		// Resolve both promises
		await Promise.all([promise1, promise2]);

		// Check the call times and signatures
		assert.strictEqual(callTimes.length, 3, 'Should have exactly 3 calls');

		// Check if the third call is close to 1200ms and includes both signatures
		const overlapCall = 2; // The third call should be the overlapping one
		const overlapTime = callTimes[overlapCall] - startTime;

		assert(
			Math.abs(overlapTime - 1200) < 100,
			`Overlapping call should be around 1200ms, but was at ${overlapTime}ms`
		);

		// Verify the call pattern
		assert(
			callSignatures[0].includes(fakeTxSig1) &&
				!callSignatures[0].includes(fakeTxSig2),
			'First call should only include 400ms interval transaction'
		);
		assert(
			callSignatures[1].includes(fakeTxSig1) &&
				!callSignatures[1].includes(fakeTxSig2),
			'Second call should only include 400ms interval transaction'
		);
		assert(
			callSignatures[2].includes(fakeTxSig1) &&
				callSignatures[2].includes(fakeTxSig2),
			'Third call should include both transactions'
		);

		// Wait for 1000ms to check that we haven't made any more calls now that all transactions are confirmed
		await new Promise((resolve) => setTimeout(resolve, 1000));

		// Verify that no more calls were made
		assert.strictEqual(
			callTimes.length,
			3,
			'Should not have made any more calls after all transactions are confirmed'
		);

		// Verify that only the third call returns non-null results
		callCount = 0;
		const results = await Promise.all(
			callSignatures.map((sigs) => mockConnection.getSignatureStatuses!(sigs))
		);

		assert(
			results[0].value.every((v) => v === null),
			'First call should return null results'
		);
		assert(
			results[1].value.every((v) => v === null),
			'Second call should return null results'
		);
		assert(
			results[2].value.every((v) => v !== null),
			'Third call should return non-null results'
		);
	});
});
