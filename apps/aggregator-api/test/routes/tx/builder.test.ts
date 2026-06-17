import {
	Keypair,
	PublicKey,
	SystemProgram,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';
import Fastify, { FastifyInstance } from 'fastify';
import builderRoutes from '../../../src/routes/tx/builder';

const mockEnsureVelocityClientSubscribed = jest.fn();
const mockGetCreateRevenueShareAccountTxn = jest.fn();
const mockGetCreateRevenueShareEscrowTxn = jest.fn();
const mockGetConfigureApprovedBuilderTxn = jest.fn();
const mockFetchNullableRevenueShareEscrow = jest.fn();
const mockSimulateTransaction = jest.fn();
const mockHandleVelocityError = jest.fn();
const mockGetRevenueShareEscrowAccountPublicKey = jest.fn();

jest.mock('@velocity-exchange/sdk', () => {
	const actual = jest.requireActual('@velocity-exchange/sdk');
	return {
		...actual,
		getRevenueShareEscrowAccountPublicKey: (...args) =>
			mockGetRevenueShareEscrowAccountPublicKey(...args),
	};
});

describe('Builder Routes', () => {
	let app: FastifyInstance;
	const mockUserKeypair = Keypair.generate();
	const mockBuilderKeypair = Keypair.generate();
	const mockProgramId = Keypair.generate().publicKey;
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
		(app as any).velocityClient = {
			program: {
				programId: mockProgramId,
				account: {
					revenueShareEscrow: {
						fetchNullable: mockFetchNullableRevenueShareEscrow,
					},
				},
			},
		};
		(app as any).centralServerVelocity = {
			getCreateRevenueShareAccountTxn: mockGetCreateRevenueShareAccountTxn,
			getCreateRevenueShareEscrowTxn: mockGetCreateRevenueShareEscrowTxn,
			getConfigureApprovedBuilderTxn: mockGetConfigureApprovedBuilderTxn,
		};
		(app as any).simulateTransaction = mockSimulateTransaction;
		(app as any).handleVelocityError = mockHandleVelocityError;

		await app.register(builderRoutes);
		await app.ready();

		mockEnsureVelocityClientSubscribed.mockReset();
		mockGetCreateRevenueShareAccountTxn.mockReset();
		mockGetCreateRevenueShareEscrowTxn.mockReset();
		mockGetConfigureApprovedBuilderTxn.mockReset();
		mockFetchNullableRevenueShareEscrow.mockReset();
		mockSimulateTransaction.mockReset();
		mockHandleVelocityError.mockReset();
		mockGetRevenueShareEscrowAccountPublicKey.mockReset();

		mockEnsureVelocityClientSubscribed.mockResolvedValue(undefined);
		mockSimulateTransaction.mockResolvedValue({ success: true });
		mockGetRevenueShareEscrowAccountPublicKey.mockReturnValue(Keypair.generate().publicKey);
		mockFetchNullableRevenueShareEscrow.mockResolvedValue({});
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

	describe('POST /builder/init', () => {
		it('should create builder init transaction', async () => {
			const mockTx = createMockTransaction();
			mockGetCreateRevenueShareAccountTxn.mockResolvedValue(mockTx);

			const response = await app.inject({
				method: 'POST',
				url: '/builder/init',
				payload: {
					builderId: mockBuilderKeypair.publicKey.toString(),
				},
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);
			expect(payload.success).toBe(true);
			expect(payload.tx).toEqual(expect.any(String));

			expect(mockGetCreateRevenueShareAccountTxn).toHaveBeenCalledWith(expect.any(PublicKey));
			expect(mockSimulateTransaction).toHaveBeenCalledWith(mockTx, {
				skipSimulation: false,
			});
		});

		it('should return 400 for invalid builder public key', async () => {
			const response = await app.inject({
				method: 'POST',
				url: '/builder/init',
				payload: {
					builderId: 'invalid_pubkey',
				},
			});

			expect(response.statusCode).toBe(400);
			expect(JSON.parse(response.payload)).toEqual({
				success: false,
				error: 'Invalid public key format for builderId',
			});
		});
	});

	describe('POST /builder/approve', () => {
		it('should configure approved builder when escrow already exists', async () => {
			const mockTx = createMockTransaction();
			mockGetConfigureApprovedBuilderTxn.mockResolvedValue(mockTx);

			const response = await app.inject({
				method: 'POST',
				url: '/builder/approve',
				payload: {
					authorityId: mockUserKeypair.publicKey.toString(),
					builderId: mockBuilderKeypair.publicKey.toString(),
					maxFeeTenthBps: 10,
				},
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);
			expect(payload.success).toBe(true);
			expect(payload.tx).toEqual(expect.any(String));

			expect(mockGetRevenueShareEscrowAccountPublicKey).toHaveBeenCalledWith(
				mockProgramId,
				expect.any(PublicKey)
			);
			expect(mockGetConfigureApprovedBuilderTxn).toHaveBeenCalledWith(
				expect.any(PublicKey),
				expect.any(PublicKey),
				10
			);
			expect(mockGetCreateRevenueShareEscrowTxn).not.toHaveBeenCalled();
		});

		it('should create revenue share escrow when escrow does not exist', async () => {
			const mockTx = createMockTransaction();
			mockFetchNullableRevenueShareEscrow.mockResolvedValue(null);
			mockGetCreateRevenueShareEscrowTxn.mockResolvedValue(mockTx);

			const response = await app.inject({
				method: 'POST',
				url: '/builder/approve',
				payload: {
					authorityId: mockUserKeypair.publicKey.toString(),
					builderId: mockBuilderKeypair.publicKey.toString(),
					maxFeeTenthBps: 10,
				},
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);
			expect(payload.success).toBe(true);
			expect(payload.tx).toEqual(expect.any(String));

			expect(mockGetCreateRevenueShareEscrowTxn).toHaveBeenCalledWith(expect.any(PublicKey), {
				numOrders: 16,
				builder: {
					builderAuthority: expect.any(PublicKey),
					maxFeeTenthBps: 10,
				},
			});
			expect(mockGetConfigureApprovedBuilderTxn).not.toHaveBeenCalled();
		});

		it('should validate maxFeeTenthBps', async () => {
			const response = await app.inject({
				method: 'POST',
				url: '/builder/approve',
				payload: {
					authorityId: mockUserKeypair.publicKey.toString(),
					builderId: mockBuilderKeypair.publicKey.toString(),
					maxFeeTenthBps: 0,
				},
			});

			expect(response.statusCode).toBe(400);
			expect(JSON.parse(response.payload)).toEqual({
				success: false,
				error: 'maxFeeTenthBps must be a positive integer',
			});
		});

		it('should validate numOrders', async () => {
			const response = await app.inject({
				method: 'POST',
				url: '/builder/approve',
				payload: {
					authorityId: mockUserKeypair.publicKey.toString(),
					builderId: mockBuilderKeypair.publicKey.toString(),
					maxFeeTenthBps: 10,
					numOrders: 0,
				},
			});

			expect(response.statusCode).toBe(400);
			expect(JSON.parse(response.payload)).toEqual({
				success: false,
				error: 'numOrders must be an integer between 1 and 128',
			});
		});

		it('should return simulation error payload', async () => {
			const mockTx = createMockTransaction();
			mockGetConfigureApprovedBuilderTxn.mockResolvedValue(mockTx);
			mockSimulateTransaction.mockResolvedValue({
				success: false,
				error: 'simulation failed',
				code: 1,
				name: 'SimulationError',
				details: 'mock failure',
			});

			const response = await app.inject({
				method: 'POST',
				url: '/builder/approve',
				payload: {
					authorityId: mockUserKeypair.publicKey.toString(),
					builderId: mockBuilderKeypair.publicKey.toString(),
					maxFeeTenthBps: 10,
				},
			});

			expect(response.statusCode).toBe(400);
			expect(JSON.parse(response.payload)).toEqual({
				success: false,
				error: 'simulation failed',
				code: 1,
				name: 'SimulationError',
				details: 'mock failure',
			});
		});

		it('should return 400 for invalid authorityId', async () => {
			const response = await app.inject({
				method: 'POST',
				url: '/builder/approve',
				payload: {
					authorityId: 'invalid_pubkey',
					builderId: mockBuilderKeypair.publicKey.toString(),
					maxFeeTenthBps: 10,
				},
			});

			expect(response.statusCode).toBe(400);
			expect(JSON.parse(response.payload)).toEqual({
				success: false,
				error: 'Invalid public key format for authorityId',
			});
		});
	});
});
