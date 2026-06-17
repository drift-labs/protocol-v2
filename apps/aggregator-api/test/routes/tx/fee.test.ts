import { RateLimitMetric } from '@backend/dynamodb';
import { Program } from '@coral-xyz/anchor';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';
import {
	ComputeBudgetProgram,
	Keypair,
	PublicKey,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';
import Fastify, { FastifyInstance } from 'fastify';
import feePayerRoutes from '../../../src/routes/tx/fee';

const mockVerifyAuthToken = jest.fn();
const mockCheckRateLimit = jest.fn();
const mockTrackUsage = jest.fn();
const mockCheckMultipleRateLimits = jest.fn();

const mockVelocityProgramKeypair = Keypair.generate();
const mockVelocityProgram = {
	programId: mockVelocityProgramKeypair.publicKey,
	idl: {
		instructions: [
			{ name: 'placePerpOrder', accounts: [], args: [] },
			{ name: 'placeSpotOrder', accounts: [], args: [] },
			{ name: 'cancelOrder', accounts: [], args: [] },
		],
	},
} as unknown as Program;

const mockDecode = jest.fn();
jest.mock('@coral-xyz/anchor', () => {
	const actual = jest.requireActual('@coral-xyz/anchor');
	return {
		...actual,
		BorshInstructionCoder: jest.fn().mockImplementation(() => ({
			decode: mockDecode,
		})),
	};
});

jest.mock('@privy-io/server-auth', () => ({
	PrivyClient: jest.fn(() => ({
		verifyAuthToken: mockVerifyAuthToken,
	})),
}));

jest.mock('@backend/dynamodb', () => ({
	RateLimitMetric: {
		PriorityFees: 'priority_fees',
	},
	DEFAULT_RATE_LIMITS: {
		priority_fees: 1000000,
	},
	RateLimitRepository: jest.fn(() => ({
		checkMultipleRateLimits: mockCheckMultipleRateLimits,
		checkRateLimit: mockCheckRateLimit,
		recordMultipleUsage: mockTrackUsage,
	})),
}));

describe('Fee Payer Routes', () => {
	let app: FastifyInstance;
	const mockUserId = 'user123';
	const mockFeePayerKeypair = Keypair.generate();
	const validAccessToken = 'valid_token';
	const mockBlockhash = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';

	beforeEach(async () => {
		process.env.FEE_PAYER_PRIVATE_KEY = bs58.encode(mockFeePayerKeypair.secretKey);
		process.env.PRIVY_APP_ID = 'test_app_id';
		process.env.PRIVY_APP_SECRET = 'test_app_secret';
		process.env.PRIVY_VERIFICATION_KEY = 'test_verification_key';
		process.env.FEE_PAYER_ROUTE_DISABLED = 'false';
		process.env.PRIORITY_FEE_LIMIT = '1000000';

		app = Fastify();

		// Mock the centralServerVelocity property
		(app as any).centralServerVelocity = {
			velocityClient: {
				program: mockVelocityProgram,
			},
		};

		await app.register(feePayerRoutes);
		await app.ready();

		// Reset mocks
		mockVerifyAuthToken.mockReset();
		mockCheckRateLimit.mockReset();
		mockTrackUsage.mockReset();
		mockDecode.mockReset();

		// Default mock decode to return a valid Velocity instruction
		mockDecode.mockReturnValue({
			name: 'placePerpOrder',
			data: {},
		});
	});

	afterEach(async () => {
		await app.close();
		jest.clearAllMocks();
		delete process.env.FEE_PAYER_PRIVATE_KEY;
		delete process.env.FEE_PAYER_ROUTE_DISABLED;
		delete process.env.PRIORITY_FEE_LIMIT;
	});

	describe('POST /sign', () => {
		const createMockTransaction = (
			feePayer = mockFeePayerKeypair.publicKey,
			options: {
				includeVelocityInstruction?: boolean;
				includeComputeBudget?: boolean;
				computeUnits?: number;
				computeUnitPrice?: number;
				additionalPrograms?: PublicKey[];
			} = {}
		) => {
			const {
				includeVelocityInstruction = true,
				includeComputeBudget = true,
				computeUnits = 200000,
				computeUnitPrice = 1000,
				additionalPrograms = [],
			} = options;

			const instructions = [];

			// Add compute budget instructions
			if (includeComputeBudget) {
				// SetComputeUnitLimit instruction
				const computeUnitsBuffer = Buffer.alloc(5);
				computeUnitsBuffer[0] = 2; // discriminator
				computeUnitsBuffer.writeUInt32LE(computeUnits, 1);
				instructions.push({
					programId: ComputeBudgetProgram.programId,
					keys: [],
					data: computeUnitsBuffer,
				});

				// SetComputeUnitPrice instruction
				const computePriceBuffer = Buffer.alloc(9);
				computePriceBuffer[0] = 3; // discriminator
				computePriceBuffer.writeBigUInt64LE(BigInt(computeUnitPrice), 1);
				instructions.push({
					programId: ComputeBudgetProgram.programId,
					keys: [],
					data: computePriceBuffer,
				});
			}

			// Add Velocity instruction
			if (includeVelocityInstruction) {
				// Create a simple instruction data buffer (8 bytes discriminator + data)
				const velocityInstructionData = Buffer.alloc(8);
				instructions.push({
					programId: mockVelocityProgram.programId,
					keys: [],
					data: velocityInstructionData,
				});
			}

			// Add additional disallowed programs if specified
			for (const programId of additionalPrograms) {
				instructions.push({
					programId,
					keys: [],
					data: Buffer.alloc(8),
				});
			}

			// Create a VersionedTransaction
			const message = new TransactionMessage({
				payerKey: feePayer,
				recentBlockhash: mockBlockhash,
				instructions,
			}).compileToV0Message();

			const transaction = new VersionedTransaction(message);
			const serialized = transaction.serialize();
			return Buffer.from(serialized).toString('base64');
		};

		it('should successfully sign a valid transaction', async () => {
			mockVerifyAuthToken.mockResolvedValue({ userId: mockUserId });
			mockCheckMultipleRateLimits.mockResolvedValue({ allowed: true });

			const serializedTransaction = createMockTransaction();

			const response = await app.inject({
				method: 'POST',
				url: '/sign',
				headers: {
					authorization: `Bearer ${validAccessToken}`,
				},
				payload: {
					serializedTransaction,
				},
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);
			expect(payload).toHaveProperty('success', true);
			expect(payload).toHaveProperty('tx');

			// Verify the transaction was signed
			const signedTx = VersionedTransaction.deserialize(Buffer.from(payload.tx, 'base64'));
			expect(signedTx.signatures.length).toBeGreaterThan(0);
		});

		it('should return 503 when fee payer route is disabled', async () => {
			process.env.FEE_PAYER_ROUTE_DISABLED = 'true';

			const response = await app.inject({
				method: 'POST',
				url: '/sign',
				headers: {
					authorization: `Bearer ${validAccessToken}`,
				},
				payload: {
					serializedTransaction: createMockTransaction(),
				},
			});

			expect(response.statusCode).toBe(503);
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: false,
				error: 'Fee payer route is temporarily disabled',
			});
		});

		it('should return 401 when no access token is provided', async () => {
			const response = await app.inject({
				method: 'POST',
				url: '/sign',
				payload: {
					serializedTransaction: createMockTransaction(),
				},
			});

			expect(response.statusCode).toBe(401);
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: false,
				error: 'Unauthorized user',
			});
		});

		it('should return 401 when access token is invalid', async () => {
			mockVerifyAuthToken.mockResolvedValue(null);

			const response = await app.inject({
				method: 'POST',
				url: '/sign',
				headers: {
					authorization: 'Bearer invalid_token',
				},
				payload: {
					serializedTransaction: createMockTransaction(),
				},
			});

			expect(response.statusCode).toBe(401);
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: false,
				error: 'Unauthorized user',
			});
		});

		it('should return 401 when Privy verification throws an error', async () => {
			mockVerifyAuthToken.mockRejectedValue(new Error('Invalid token'));

			const response = await app.inject({
				method: 'POST',
				url: '/sign',
				headers: {
					authorization: `Bearer ${validAccessToken}`,
				},
				payload: {
					serializedTransaction: createMockTransaction(),
				},
			});

			expect(response.statusCode).toBe(401);
		});

		it('should return 403 when transaction uses wrong fee payer', async () => {
			mockVerifyAuthToken.mockResolvedValue({ userId: mockUserId });
			mockCheckMultipleRateLimits.mockResolvedValue({ allowed: true });

			const differentFeePayer = Keypair.generate().publicKey;
			const serializedTransaction = createMockTransaction(differentFeePayer);

			const response = await app.inject({
				method: 'POST',
				url: '/sign',
				headers: {
					authorization: `Bearer ${validAccessToken}`,
				},
				payload: {
					serializedTransaction,
				},
			});

			console.log(response.payload);
			expect(response.statusCode).toBe(403);
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: false,
				error: 'Transaction is not using the correct fee payer',
			});
		});

		it('should return 429 when rate limit is exceeded', async () => {
			mockVerifyAuthToken.mockResolvedValue({ userId: mockUserId });
			mockCheckMultipleRateLimits.mockResolvedValue({
				allowed: false,
				metric: RateLimitMetric.PriorityFees,
				currentUsage: 1500000,
				limit: 1000000,
			});

			const response = await app.inject({
				method: 'POST',
				url: '/sign',
				headers: {
					authorization: `Bearer ${validAccessToken}`,
				},
				payload: {
					serializedTransaction: createMockTransaction(),
				},
			});

			expect(response.statusCode).toBe(429);
			const payload = JSON.parse(response.payload);
			expect(payload).toHaveProperty('success', false);
			expect(payload).toHaveProperty('error');
		});

		it('should handle malformed serialized transaction', async () => {
			mockVerifyAuthToken.mockResolvedValue({ userId: mockUserId });
			mockCheckRateLimit.mockResolvedValue({ allowed: true });

			const response = await app.inject({
				method: 'POST',
				url: '/sign',
				headers: {
					authorization: `Bearer ${validAccessToken}`,
				},
				payload: {
					serializedTransaction: 'invalid_base64_data',
				},
			});

			expect(response.statusCode).toBeGreaterThanOrEqual(400);
		});

		it('should track priority fee usage after successful signing', async () => {
			mockVerifyAuthToken.mockResolvedValue({ userId: mockUserId });
			mockCheckRateLimit.mockResolvedValue({ allowed: true });

			const computeUnits = 200000;
			const computeUnitPrice = 1000;
			const expectedFee = (computeUnits * computeUnitPrice) / 1_000_000;

			const serializedTransaction = createMockTransaction(mockFeePayerKeypair.publicKey, {
				computeUnits,
				computeUnitPrice,
			});

			await app.inject({
				method: 'POST',
				url: '/sign',
				headers: {
					authorization: `Bearer ${validAccessToken}`,
				},
				payload: {
					serializedTransaction,
				},
			});

			// Verify rate limit tracking was called with correct values
			expect(mockTrackUsage).toHaveBeenCalledWith(mockUserId, [
				{
					metric: RateLimitMetric.PriorityFees,
					value: expectedFee,
				},
			]);
		});

		it('should reject transactions with disallowed programs', async () => {
			mockVerifyAuthToken.mockResolvedValue({ userId: mockUserId });
			mockCheckMultipleRateLimits.mockResolvedValue({ allowed: true });

			const disallowedProgram = Keypair.generate().publicKey;

			const serializedTransaction = createMockTransaction(mockFeePayerKeypair.publicKey, {
				additionalPrograms: [disallowedProgram],
			});

			const response = await app.inject({
				method: 'POST',
				url: '/sign',
				headers: {
					authorization: `Bearer ${validAccessToken}`,
				},
				payload: {
					serializedTransaction,
				},
			});

			expect(response.statusCode).toBeGreaterThanOrEqual(400);
			const payload = JSON.parse(response.payload);
			expect(payload.success).toBe(false);
			expect(payload.error).toContain('disallowed');
		});

		it('should reject transactions with no Velocity instructions', async () => {
			mockVerifyAuthToken.mockResolvedValue({ userId: mockUserId });
			mockCheckRateLimit.mockResolvedValue({ allowed: true });

			const serializedTransaction = createMockTransaction(mockFeePayerKeypair.publicKey, {
				includeVelocityInstruction: false,
			});

			const response = await app.inject({
				method: 'POST',
				url: '/sign',
				headers: {
					authorization: `Bearer ${validAccessToken}`,
				},
				payload: {
					serializedTransaction,
				},
			});

			expect(response.statusCode).toBeGreaterThanOrEqual(400);
			const payload = JSON.parse(response.payload);
			expect(payload.success).toBe(false);
			expect(payload.error).toContain('No Velocity instructions found');
		});

		it('should reject transactions when Velocity instruction cannot be decoded', async () => {
			mockVerifyAuthToken.mockResolvedValue({ userId: mockUserId });
			mockCheckRateLimit.mockResolvedValue({ allowed: true });
			mockDecode.mockReturnValue(null); // Simulate decode failure

			const serializedTransaction = createMockTransaction();

			const response = await app.inject({
				method: 'POST',
				url: '/sign',
				headers: {
					authorization: `Bearer ${validAccessToken}`,
				},
				payload: {
					serializedTransaction,
				},
			});

			expect(response.statusCode).toBeGreaterThanOrEqual(400);
			const payload = JSON.parse(response.payload);
			expect(payload.success).toBe(false);
			expect(payload.error).toContain('Failed to decode');
		});

		it('should allow System Program instructions alongside Velocity instructions', async () => {
			mockVerifyAuthToken.mockResolvedValue({ userId: mockUserId });
			mockCheckRateLimit.mockResolvedValue({ allowed: true });

			// System Program is in ALLOWED_NON_VELOCITY_PROGRAMS
			const systemProgramId = new PublicKey('11111111111111111111111111111111');

			const serializedTransaction = createMockTransaction(mockFeePayerKeypair.publicKey, {
				additionalPrograms: [systemProgramId],
			});

			const response = await app.inject({
				method: 'POST',
				url: '/sign',
				headers: {
					authorization: `Bearer ${validAccessToken}`,
				},
				payload: {
					serializedTransaction,
				},
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);
			expect(payload.success).toBe(true);
		});
	});
});
