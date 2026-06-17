import {
	Keypair,
	SystemProgram,
	Transaction,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';
import Fastify, { FastifyInstance } from 'fastify';
import executeRoutes from '../../../src/routes/tx/execute';

const mockSimulateTransaction = jest.fn();
const mockSendSignedTransaction = jest.fn();
const mockHandleVelocityError = jest.fn();

describe('Execute Routes', () => {
	let app: FastifyInstance;
	const mockBlockhash = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';
	const mockSenderKeypair = Keypair.generate();
	const mockRecipientKeypair = Keypair.generate();

	beforeEach(async () => {
		app = Fastify();

		(app as any).simulateTransaction = mockSimulateTransaction;
		(app as any).centralServerVelocity = {
			sendSignedTransaction: mockSendSignedTransaction,
		};
		(app as any).handleVelocityError = mockHandleVelocityError;

		await app.register(executeRoutes);
		await app.ready();

		mockSimulateTransaction.mockReset();
		mockSendSignedTransaction.mockReset();
		mockHandleVelocityError.mockReset();

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

	describe('POST /execute', () => {
		const createMockVersionedTransaction = (signed = true) => {
			const instruction = SystemProgram.transfer({
				fromPubkey: mockSenderKeypair.publicKey,
				toPubkey: mockRecipientKeypair.publicKey,
				lamports: 1000000,
			});

			const message = new TransactionMessage({
				payerKey: mockSenderKeypair.publicKey,
				recentBlockhash: mockBlockhash,
				instructions: [instruction],
			}).compileToV0Message();

			const transaction = new VersionedTransaction(message);

			if (signed) {
				transaction.sign([mockSenderKeypair]);
			}

			return Buffer.from(transaction.serialize()).toString('base64');
		};

		const createMockLegacyTransaction = (signed = true) => {
			const transaction = new Transaction({
				recentBlockhash: mockBlockhash,
				feePayer: mockSenderKeypair.publicKey,
			});

			transaction.add(
				SystemProgram.transfer({
					fromPubkey: mockSenderKeypair.publicKey,
					toPubkey: mockRecipientKeypair.publicKey,
					lamports: 1000000,
				})
			);

			if (signed) {
				transaction.sign(mockSenderKeypair);
			}

			return transaction.serialize().toString('base64');
		};

		it('should successfully execute a versioned transaction without simulation', async () => {
			const mockTxSig = 'mock_transaction_signature_123';
			mockSendSignedTransaction.mockResolvedValue({ txSig: mockTxSig });

			const signedTx = createMockVersionedTransaction();

			const response = await app.inject({
				method: 'POST',
				url: '/execute',
				payload: {
					signedTx,
					simulate: false,
				},
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				txSig: mockTxSig,
				message: 'Transaction executed successfully',
			});

			expect(mockSimulateTransaction).toHaveBeenCalledWith(expect.any(VersionedTransaction), {
				skipSimulation: true,
			});
			expect(mockSendSignedTransaction).toHaveBeenCalledWith(
				expect.any(VersionedTransaction)
			);
		});

		it('should successfully execute a versioned transaction with simulation', async () => {
			const mockTxSig = 'mock_transaction_signature_456';
			mockSimulateTransaction.mockResolvedValue({ success: true });
			mockSendSignedTransaction.mockResolvedValue({ txSig: mockTxSig });

			const signedTx = createMockVersionedTransaction();

			const response = await app.inject({
				method: 'POST',
				url: '/execute',
				payload: {
					signedTx,
					simulate: true,
				},
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: true,
				txSig: mockTxSig,
				message: 'Transaction executed successfully',
			});

			expect(mockSimulateTransaction).toHaveBeenCalledWith(expect.any(VersionedTransaction), {
				skipSimulation: false,
			});
			expect(mockSendSignedTransaction).toHaveBeenCalled();
		});

		it('should default simulate to false when not provided', async () => {
			const mockTxSig = 'mock_tx_sig';
			mockSendSignedTransaction.mockResolvedValue({ txSig: mockTxSig });

			const signedTx = createMockVersionedTransaction();

			const response = await app.inject({
				method: 'POST',
				url: '/execute',
				payload: {
					signedTx,
				},
			});

			expect(response.statusCode).toBe(200);
			expect(mockSimulateTransaction).toHaveBeenCalledWith(expect.anything(), {
				skipSimulation: true,
			});
		});

		it('should return 400 when signedTx is missing', async () => {
			const response = await app.inject({
				method: 'POST',
				url: '/execute',
				payload: {},
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: false,
				error: 'Missing signedTransaction in request body',
			});

			expect(mockSimulateTransaction).not.toHaveBeenCalled();
			expect(mockSendSignedTransaction).not.toHaveBeenCalled();
		});

		it('should return 400 when signedTx is empty string', async () => {
			const response = await app.inject({
				method: 'POST',
				url: '/execute',
				payload: {
					signedTx: '',
				},
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: false,
				error: 'Missing signedTransaction in request body',
			});
		});

		it('should return 400 when simulation fails', async () => {
			mockSimulateTransaction.mockResolvedValue({
				success: false,
				error: 'Simulation failed: insufficient funds',
				code: 1,
				name: 'InsufficientFunds',
				details: 'Account does not have enough lamports',
			});

			const signedTx = createMockVersionedTransaction();

			const response = await app.inject({
				method: 'POST',
				url: '/execute',
				payload: {
					signedTx,
					simulate: true,
				},
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: false,
				error: 'Simulation failed: insufficient funds',
				code: 1,
				name: 'InsufficientFunds',
				details: 'Account does not have enough lamports',
			});

			expect(mockSendSignedTransaction).not.toHaveBeenCalled();
		});

		it('should handle invalid base64 encoded transaction', async () => {
			const response = await app.inject({
				method: 'POST',
				url: '/execute',
				payload: {
					signedTx: 'invalid_base64_!!!',
				},
			});

			expect(response.statusCode).toBeGreaterThanOrEqual(400);
			expect(mockHandleVelocityError).toHaveBeenCalled();
		});

		it('should handle malformed transaction data', async () => {
			const response = await app.inject({
				method: 'POST',
				url: '/execute',
				payload: {
					signedTx: Buffer.from('not a valid transaction').toString('base64'),
				},
			});

			expect(response.statusCode).toBeGreaterThanOrEqual(400);
			expect(mockHandleVelocityError).toHaveBeenCalled();
		});

		it('should handle sendSignedTransaction throwing an error', async () => {
			mockSendSignedTransaction.mockRejectedValue(new Error('Network error'));

			const signedTx = createMockVersionedTransaction();

			const response = await app.inject({
				method: 'POST',
				url: '/execute',
				payload: {
					signedTx,
				},
			});

			expect(response.statusCode).toBe(500);
			expect(mockHandleVelocityError).toHaveBeenCalledWith(
				expect.any(Error),
				expect.anything()
			);
		});

		it('should handle simulateTransaction throwing an error', async () => {
			mockSimulateTransaction.mockRejectedValue(new Error('Simulation RPC error'));

			const signedTx = createMockVersionedTransaction();

			const response = await app.inject({
				method: 'POST',
				url: '/execute',
				payload: {
					signedTx,
					simulate: true,
				},
			});

			expect(response.statusCode).toBe(500);
			expect(mockHandleVelocityError).toHaveBeenCalledWith(
				expect.any(Error),
				expect.anything()
			);
		});

		it('should try VersionedTransaction first, then fall back to Legacy Transaction', async () => {
			const mockTxSig = 'fallback_tx_sig';
			mockSendSignedTransaction.mockResolvedValue({ txSig: mockTxSig });

			const signedTx = createMockLegacyTransaction();

			const response = await app.inject({
				method: 'POST',
				url: '/execute',
				payload: {
					signedTx,
				},
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload.success).toBe(true);
			expect(payload.txSig).toBe(mockTxSig);
		});

		it('should pass through simulation error details', async () => {
			const simulationError = {
				success: false,
				error: 'Custom program error: 0x1',
				code: 6000,
				name: 'CustomProgramError',
				details: 'Detailed error message from program',
			};

			mockSimulateTransaction.mockResolvedValue(simulationError);

			const signedTx = createMockVersionedTransaction();

			const response = await app.inject({
				method: 'POST',
				url: '/execute',
				payload: {
					signedTx,
					simulate: true,
				},
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual(simulationError);
		});

		it('should handle simulation success with empty object', async () => {
			mockSimulateTransaction.mockResolvedValue({ success: true });
			const mockTxSig = 'success_tx_sig';
			mockSendSignedTransaction.mockResolvedValue({ txSig: mockTxSig });

			const signedTx = createMockVersionedTransaction();

			const response = await app.inject({
				method: 'POST',
				url: '/execute',
				payload: {
					signedTx,
					simulate: true,
				},
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload.success).toBe(true);
			expect(payload.txSig).toBe(mockTxSig);
		});

		it('should handle simulate being explicitly set to false', async () => {
			const mockTxSig = 'no_sim_tx_sig';
			mockSendSignedTransaction.mockResolvedValue({ txSig: mockTxSig });

			const signedTx = createMockVersionedTransaction();

			const response = await app.inject({
				method: 'POST',
				url: '/execute',
				payload: {
					signedTx,
					simulate: false,
				},
			});

			expect(response.statusCode).toBe(200);
			expect(mockSimulateTransaction).toHaveBeenCalledWith(expect.anything(), {
				skipSimulation: true,
			});
		});
	});
});
