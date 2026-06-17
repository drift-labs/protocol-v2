import {
	Keypair,
	PublicKey,
	SystemProgram,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';
import { BN } from '@velocity-exchange/sdk';
import Fastify, { FastifyInstance } from 'fastify';
import depositsRoutes from '../../../src/routes/tx/deposit';

const mockEnsureVelocityClientSubscribed = jest.fn();
const mockGetDepositTxn = jest.fn();
const mockGetWithdrawTxn = jest.fn();
const mockSimulateTransaction = jest.fn();
const mockHandleVelocityError = jest.fn();

describe('Deposits Routes', () => {
	let app: FastifyInstance;
	const mockUserKeypair = Keypair.generate();
	const mockBlockhash = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';

	const createMockTransaction = () => {
		const instruction = SystemProgram.transfer({
			fromPubkey: mockUserKeypair.publicKey,
			toPubkey: Keypair.generate().publicKey,
			lamports: 1000000,
		});

		const message = new TransactionMessage({
			payerKey: mockUserKeypair.publicKey,
			recentBlockhash: mockBlockhash,
			instructions: [instruction],
		}).compileToV0Message();

		return new VersionedTransaction(message);
	};

	beforeEach(async () => {
		app = Fastify();

		// Mock the required properties
		(app as any).ensureVelocityClientSubscribed = mockEnsureVelocityClientSubscribed;
		(app as any).centralServerVelocity = {
			getDepositTxn: mockGetDepositTxn,
			getWithdrawTxn: mockGetWithdrawTxn,
		};
		(app as any).simulateTransaction = mockSimulateTransaction;
		(app as any).handleVelocityError = mockHandleVelocityError;

		await app.register(depositsRoutes);
		await app.ready();

		// Reset mocks
		mockEnsureVelocityClientSubscribed.mockReset();
		mockGetDepositTxn.mockReset();
		mockGetWithdrawTxn.mockReset();
		mockSimulateTransaction.mockReset();
		mockHandleVelocityError.mockReset();

		// Default mock implementations
		mockEnsureVelocityClientSubscribed.mockResolvedValue(undefined);
		mockSimulateTransaction.mockResolvedValue({ success: true });
		mockHandleVelocityError.mockImplementation(async (error, reply) => {
			reply.status(500).send({
				success: false,
				error: error.message,
			});
		});
	});

	afterEach(async () => {
		await app.close();
		jest.clearAllMocks();
	});

	describe('POST /deposit', () => {
		it('should successfully create a deposit transaction with simulation', async () => {
			const mockTx = createMockTransaction();
			mockGetDepositTxn.mockResolvedValue(mockTx);

			const response = await app.inject({
				method: 'POST',
				url: '/deposit',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: '100.50',
					simulate: true,
				},
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload).toHaveProperty('success', true);

			expect(mockEnsureVelocityClientSubscribed).toHaveBeenCalledTimes(1);
			expect(mockGetDepositTxn).toHaveBeenCalledWith(
				expect.any(PublicKey),
				new BN(100500000),
				0
			);
			expect(mockSimulateTransaction).toHaveBeenCalledWith(mockTx, {
				skipSimulation: false,
			});
		});

		it('should successfully create a deposit transaction without simulation', async () => {
			const mockTx = createMockTransaction();
			mockGetDepositTxn.mockResolvedValue(mockTx);

			const response = await app.inject({
				method: 'POST',
				url: '/deposit',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: '100',
					simulate: false,
				},
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload).toHaveProperty('success', true);
			expect(payload.message).not.toContain('simulated');

			expect(mockSimulateTransaction).toHaveBeenCalledWith(mockTx, {
				skipSimulation: true,
			});
		});

		it('should handle very small decimal amounts', async () => {
			const mockTx = createMockTransaction();
			mockGetDepositTxn.mockResolvedValue(mockTx);

			const response = await app.inject({
				method: 'POST',
				url: '/deposit',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: '0.000001',
				},
			});

			expect(response.statusCode).toBe(200);

			const calledAmount = mockGetDepositTxn.mock.calls[0][1];
			expect(calledAmount.toString()).toBe('1'); // 0.000001 * 1e6 = 1
		});

		it('should handle large amounts', async () => {
			const mockTx = createMockTransaction();
			mockGetDepositTxn.mockResolvedValue(mockTx);

			const response = await app.inject({
				method: 'POST',
				url: '/deposit',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: '1000000',
				},
			});

			expect(response.statusCode).toBe(200);

			const calledAmount = mockGetDepositTxn.mock.calls[0][1];
			expect(calledAmount.toString()).toBe('1000000000000'); // 1000000 * 1e6
		});

		it('should return 400 when accountId or amount is missing', async () => {
			const response = await app.inject({
				method: 'POST',
				url: '/deposit',
				payload: {
					symbol: 'USDC',
					amount: '100',
				},
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: false,
				error: 'Missing required fields: accountId and amount',
			});

			expect(mockGetDepositTxn).not.toHaveBeenCalled();
		});

		it('should return 400 for invalid public key format', async () => {
			const response = await app.inject({
				method: 'POST',
				url: '/deposit',
				payload: {
					accountId: 'invalid_public_key',
					symbol: 'USDC',
					amount: '100',
				},
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: false,
				error: 'Invalid public key format for accountId',
			});

			expect(mockGetDepositTxn).not.toHaveBeenCalled();
		});

		it('should return 400 for invalid amount format', async () => {
			const response = await app.inject({
				method: 'POST',
				url: '/deposit',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: 'not_a_number',
				},
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: false,
				error: 'Invalid amount: must be a positive number',
			});
		});

		it('should return 400 for zero amount', async () => {
			const response = await app.inject({
				method: 'POST',
				url: '/deposit',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: '0',
				},
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: false,
				error: 'Invalid amount: must be a positive number',
			});
		});

		it('should return 400 for negative amount', async () => {
			const response = await app.inject({
				method: 'POST',
				url: '/deposit',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: '-100',
				},
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: false,
				error: 'Invalid amount: must be a positive number',
			});
		});

		it('should return 400 when simulation fails', async () => {
			const mockTx = createMockTransaction();
			mockGetDepositTxn.mockResolvedValue(mockTx);
			mockSimulateTransaction.mockResolvedValue({
				success: false,
				error: 'Insufficient funds',
				code: 1,
				name: 'InsufficientFunds',
				details: 'Account does not have enough balance',
			});

			const response = await app.inject({
				method: 'POST',
				url: '/deposit',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: '100',
					simulate: true,
				},
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: false,
				error: 'Insufficient funds',
				code: 1,
				name: 'InsufficientFunds',
				details: 'Account does not have enough balance',
			});
		});

		it('should handle getDepositTxn throwing an error', async () => {
			mockGetDepositTxn.mockRejectedValue(new Error('Failed to create deposit transaction'));

			const response = await app.inject({
				method: 'POST',
				url: '/deposit',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: '100',
				},
			});

			expect(response.statusCode).toBe(500);
			expect(mockHandleVelocityError).toHaveBeenCalledWith(
				expect.any(Error),
				expect.anything()
			);
		});

		it('should handle simulateTransaction throwing an error', async () => {
			const mockTx = createMockTransaction();
			mockGetDepositTxn.mockResolvedValue(mockTx);
			mockSimulateTransaction.mockRejectedValue(new Error('Simulation RPC error'));

			const response = await app.inject({
				method: 'POST',
				url: '/deposit',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: '100',
					simulate: true,
				},
			});

			expect(response.statusCode).toBe(500);
			expect(mockHandleVelocityError).toHaveBeenCalled();
		});

		it('should pass market index 0 to getDepositTxn', async () => {
			const mockTx = createMockTransaction();
			mockGetDepositTxn.mockResolvedValue(mockTx);

			await app.inject({
				method: 'POST',
				url: '/deposit',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: '100',
				},
			});

			expect(mockGetDepositTxn).toHaveBeenCalledWith(
				expect.any(PublicKey),
				expect.any(BN),
				0 // market index
			);
		});
	});

	describe('POST /withdraw', () => {
		it('should successfully create a withdraw transaction with simulation', async () => {
			const mockTx = createMockTransaction();
			mockGetWithdrawTxn.mockResolvedValue(mockTx);

			const response = await app.inject({
				method: 'POST',
				url: '/withdraw',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: '100',
					simulate: true,
				},
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload).toHaveProperty('success', true);
			expect(payload).toHaveProperty('tx');
			expect(payload).toHaveProperty('message');
			expect(payload.message).toContain('Withdrawal');
			expect(payload.message).toContain('simulated');

			expect(mockEnsureVelocityClientSubscribed).toHaveBeenCalledTimes(1);
			expect(mockGetWithdrawTxn).toHaveBeenCalledWith(
				expect.any(PublicKey),
				expect.any(BN),
				0
			);
			expect(mockSimulateTransaction).toHaveBeenCalledWith(mockTx, {
				skipSimulation: false,
			});
		});

		it('should successfully create a withdraw transaction without simulation', async () => {
			const mockTx = createMockTransaction();
			mockGetWithdrawTxn.mockResolvedValue(mockTx);

			const response = await app.inject({
				method: 'POST',
				url: '/withdraw',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: '100',
					simulate: false,
				},
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload.success).toBe(true);
			expect(payload.message).not.toContain('simulated');

			expect(mockSimulateTransaction).toHaveBeenCalledWith(mockTx, {
				skipSimulation: true,
			});
		});

		it('should default simulate to true when not provided', async () => {
			const mockTx = createMockTransaction();
			mockGetWithdrawTxn.mockResolvedValue(mockTx);

			const response = await app.inject({
				method: 'POST',
				url: '/withdraw',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: '100',
				},
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload.message).toContain('simulated');
			expect(mockSimulateTransaction).toHaveBeenCalledWith(mockTx, {
				skipSimulation: false,
			});
		});

		it('should handle decimal amounts correctly', async () => {
			const mockTx = createMockTransaction();
			mockGetWithdrawTxn.mockResolvedValue(mockTx);

			const response = await app.inject({
				method: 'POST',
				url: '/withdraw',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: '50.25',
				},
			});

			expect(response.statusCode).toBe(200);

			const calledAmount = mockGetWithdrawTxn.mock.calls[0][1];
			expect(calledAmount.toString()).toBe('50250000'); // 50.25 * 1e6
		});

		it('should return 400 when accountId is missing', async () => {
			const response = await app.inject({
				method: 'POST',
				url: '/withdraw',
				payload: {
					symbol: 'USDC',
					amount: '100',
				},
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: false,
				error: 'Missing required fields: accountId and amount',
			});
		});

		it('should return 400 when amount is missing', async () => {
			const response = await app.inject({
				method: 'POST',
				url: '/withdraw',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
				},
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: false,
				error: 'Missing required fields: accountId and amount',
			});
		});

		it('should return 400 for invalid public key format', async () => {
			const response = await app.inject({
				method: 'POST',
				url: '/withdraw',
				payload: {
					accountId: 'invalid_key',
					symbol: 'USDC',
					amount: '100',
				},
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: false,
				error: 'Invalid public key format for accountId',
			});
		});

		it('should return 400 for invalid amount format', async () => {
			const response = await app.inject({
				method: 'POST',
				url: '/withdraw',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: 'invalid',
				},
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: false,
				error: 'Invalid amount: must be a positive number',
			});
		});

		it('should return 400 for zero amount', async () => {
			const response = await app.inject({
				method: 'POST',
				url: '/withdraw',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: '0',
				},
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: false,
				error: 'Invalid amount: must be a positive number',
			});
		});

		it('should return 400 for negative amount', async () => {
			const response = await app.inject({
				method: 'POST',
				url: '/withdraw',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: '-50',
				},
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: false,
				error: 'Invalid amount: must be a positive number',
			});
		});

		it('should return 400 when simulation fails', async () => {
			const mockTx = createMockTransaction();
			mockGetWithdrawTxn.mockResolvedValue(mockTx);
			mockSimulateTransaction.mockResolvedValue({
				success: false,
				error: 'Insufficient balance',
				code: 2,
				name: 'InsufficientBalance',
				details: 'Not enough funds to withdraw',
			});

			const response = await app.inject({
				method: 'POST',
				url: '/withdraw',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: '100',
					simulate: true,
				},
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: false,
				error: 'Insufficient balance',
				code: 2,
				name: 'InsufficientBalance',
				details: 'Not enough funds to withdraw',
			});
		});

		it('should handle getWithdrawTxn throwing an error', async () => {
			mockGetWithdrawTxn.mockRejectedValue(
				new Error('Failed to create withdraw transaction')
			);

			const response = await app.inject({
				method: 'POST',
				url: '/withdraw',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: '100',
				},
			});

			expect(response.statusCode).toBe(500);
			expect(mockHandleVelocityError).toHaveBeenCalled();
		});

		it('should pass market index 0 to getWithdrawTxn', async () => {
			const mockTx = createMockTransaction();
			mockGetWithdrawTxn.mockResolvedValue(mockTx);

			await app.inject({
				method: 'POST',
				url: '/withdraw',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: '100',
				},
			});

			expect(mockGetWithdrawTxn).toHaveBeenCalledWith(
				expect.any(PublicKey),
				expect.any(BN),
				0 // market index
			);
		});

		it('should handle very large withdrawal amounts', async () => {
			const mockTx = createMockTransaction();
			mockGetWithdrawTxn.mockResolvedValue(mockTx);

			const response = await app.inject({
				method: 'POST',
				url: '/withdraw',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: '999999999',
				},
			});

			expect(response.statusCode).toBe(200);

			const calledAmount = mockGetWithdrawTxn.mock.calls[0][1];
			expect(calledAmount.toString()).toBe('999999999000000'); // 999999999 * 1e6
		});

		it('should return valid base64 encoded transaction', async () => {
			const mockTx = createMockTransaction();
			mockGetWithdrawTxn.mockResolvedValue(mockTx);

			const response = await app.inject({
				method: 'POST',
				url: '/withdraw',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbol: 'USDC',
					amount: '100',
				},
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			const txBuffer = Buffer.from(payload.tx, 'base64');
			expect(() => VersionedTransaction.deserialize(txBuffer)).not.toThrow();
		});
	});
});
