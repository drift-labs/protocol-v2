import {
	Keypair,
	PublicKey,
	SystemProgram,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';
import Fastify, { FastifyInstance } from 'fastify';
import settleRoutes from '../../../src/routes/tx/settle';

const mockEnsureVelocityClientSubscribed = jest.fn();
const mockGetSettlePnlTxn = jest.fn();
const mockSimulateTransaction = jest.fn();
const mockHandleVelocityError = jest.fn();

jest.mock('@backend/common', () => ({
	getPerpMarkets: jest.fn(() => [
		{ symbol: 'SOL-PERP', marketIndex: 0 },
		{ symbol: 'BTC-PERP', marketIndex: 1 },
		{ symbol: 'ETH-PERP', marketIndex: 2 },
	]),
}));

describe('Settle Routes', () => {
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

		(app as any).ensureVelocityClientSubscribed = mockEnsureVelocityClientSubscribed;
		(app as any).centralServerVelocity = {
			getSettlePnlTxn: mockGetSettlePnlTxn,
		};
		(app as any).simulateTransaction = mockSimulateTransaction;
		(app as any).handleVelocityError = mockHandleVelocityError;

		await app.register(settleRoutes);
		await app.ready();

		mockEnsureVelocityClientSubscribed.mockReset();
		mockGetSettlePnlTxn.mockReset();
		mockSimulateTransaction.mockReset();
		mockHandleVelocityError.mockReset();

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

	describe('POST /settlePnl', () => {
		it('should default to all configured symbols when symbols are omitted', async () => {
			const mockTx = createMockTransaction();
			mockGetSettlePnlTxn.mockResolvedValue(mockTx);

			const response = await app.inject({
				method: 'POST',
				url: '/settlePnl',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
				},
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetSettlePnlTxn).toHaveBeenCalledWith(expect.any(PublicKey), [0, 1, 2]);
		});

		it('should map provided symbols to market indexes', async () => {
			const mockTx = createMockTransaction();
			mockGetSettlePnlTxn.mockResolvedValue(mockTx);

			const response = await app.inject({
				method: 'POST',
				url: '/settlePnl',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbols: [' SOL-PERP ', 'BTC-PERP', 'SOL-PERP'],
				},
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetSettlePnlTxn).toHaveBeenCalledWith(expect.any(PublicKey), [0, 1]);
		});

		it('should return 400 for invalid symbols', async () => {
			const response = await app.inject({
				method: 'POST',
				url: '/settlePnl',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbols: ['INVALID-PERP'],
				},
			});

			expect(response.statusCode).toBe(400);
			expect(JSON.parse(response.payload)).toEqual({
				success: false,
				error: 'Invalid perp symbols: INVALID-PERP',
			});

			expect(mockGetSettlePnlTxn).not.toHaveBeenCalled();
		});

		it('should return simulation error payload', async () => {
			const mockTx = createMockTransaction();
			mockGetSettlePnlTxn.mockResolvedValue(mockTx);
			mockSimulateTransaction.mockResolvedValue({
				success: false,
				error: 'Simulation failed',
				code: 1,
				name: 'SimulationError',
				details: 'mock failure',
			});

			const response = await app.inject({
				method: 'POST',
				url: '/settlePnl',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					symbols: ['SOL-PERP'],
				},
			});

			expect(response.statusCode).toBe(400);
			expect(JSON.parse(response.payload)).toEqual({
				success: false,
				error: 'Simulation failed',
				code: 1,
				name: 'SimulationError',
				details: 'mock failure',
			});
		});
	});
});
