import { ClaimStatus, ClaimType, DevicePlatform } from '@backend/common';
import Fastify, { FastifyInstance } from 'fastify';
import claimRoutes from '../../src/routes/claim/claim';

const mockGetClaim = jest.fn();
const mockReserveClaim = jest.fn();
const mockResetClaim = jest.fn();

jest.mock('@backend/dynamodb', () => ({
	ClaimRepository: jest.fn(() => ({
		getClaim: mockGetClaim,
		reserveClaim: mockReserveClaim,
		resetClaim: mockResetClaim,
	})),
}));

describe('Claim Routes', () => {
	let app: FastifyInstance;
	const originalEnv = process.env.ENV;
	const mockWalletAddress = 'auth123';
	const activeClaim = {
		campaignId: 'mobile-launch',
		authorityId: mockWalletAddress,
		claimType: ClaimType.FIXED,
		status: ClaimStatus.ELIGIBLE,
		amount: 5,
		assetSymbol: 'USDC',
		campaignStartTs: Math.floor(Date.now() / 1000) - 60,
		campaignEndTs: Math.floor(Date.now() / 1000) + 3600,
		processedAt: undefined,
		targetUserAccount: undefined,
	};

	const buildApp = async (env = 'devnet') => {
		process.env.ENV = env;
		app = Fastify();
		app.addHook('preHandler', async (request) => {
			// @ts-ignore
			request.walletAddress = mockWalletAddress;
		});
		await app.register(claimRoutes, { prefix: '/claim' });
		await app.ready();
	};

	beforeEach(async () => {
		jest.clearAllMocks();
	});

	afterEach(async () => {
		process.env.ENV = originalEnv;
	});

	it('gets a claim for the authenticated authority', async () => {
		await buildApp();
		mockGetClaim.mockResolvedValue(activeClaim);

		const response = await app.inject({
			method: 'GET',
			url: '/claim/mobile-launch',
		});

		expect(response.statusCode).toBe(200);
		expect(mockGetClaim).toHaveBeenCalledWith({
			authorityId: mockWalletAddress,
			campaignId: 'mobile-launch',
		});
		expect(JSON.parse(response.payload)).toEqual({
			success: true,
			claim: {
				campaignId: 'mobile-launch',
				authorityId: mockWalletAddress,
				claimType: ClaimType.FIXED,
				status: ClaimStatus.ELIGIBLE,
				amount: 5,
				assetSymbol: 'USDC',
				campaignEndTs: activeClaim.campaignEndTs,
			},
		});
	});

	it('returns an empty claim response when no claim exists', async () => {
		await buildApp();
		mockGetClaim.mockResolvedValue(null);

		const response = await app.inject({
			method: 'GET',
			url: '/claim/mobile-launch',
		});

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload)).toEqual({
			success: true,
			claim: {
				campaignId: 'mobile-launch',
				authorityId: mockWalletAddress,
				status: null,
			},
		});
	});

	it('reserves an eligible claim', async () => {
		await buildApp();
		mockGetClaim.mockResolvedValue(activeClaim);
		mockReserveClaim.mockResolvedValue({
			...activeClaim,
			status: ClaimStatus.PROCESSING,
			targetUserAccount: 'user123',
		});

		const response = await app.inject({
			method: 'POST',
			url: '/claim',
			payload: {
				campaignId: 'mobile-launch',
				deviceId: 'device-1',
				platform: DevicePlatform.IOS,
				targetUserAccount: 'user123',
			},
		});

		expect(response.statusCode).toBe(202);
		expect(mockReserveClaim).toHaveBeenCalledWith({
			authorityId: mockWalletAddress,
			campaignId: 'mobile-launch',
			deviceId: 'device-1',
			platform: DevicePlatform.IOS,
			targetUserAccount: 'user123',
		});
	});

	it('returns 404 when the claim does not exist', async () => {
		await buildApp();
		mockGetClaim.mockResolvedValue(null);

		const response = await app.inject({
			method: 'POST',
			url: '/claim',
			payload: {
				campaignId: 'mobile-launch',
				deviceId: 'device-1',
				targetUserAccount: 'user123',
			},
		});

		expect(response.statusCode).toBe(404);
		expect(JSON.parse(response.payload)).toEqual({
			success: false,
			error: 'Claim not found',
		});
	});

	it('returns 409 when the claim is already completed', async () => {
		await buildApp();
		mockGetClaim.mockResolvedValue({
			...activeClaim,
			status: ClaimStatus.COMPLETED,
			targetUserAccount: 'user123',
		});

		const response = await app.inject({
			method: 'POST',
			url: '/claim',
			payload: {
				campaignId: 'mobile-launch',
				deviceId: 'device-1',
				targetUserAccount: 'user123',
			},
		});

		expect(response.statusCode).toBe(409);
		expect(JSON.parse(response.payload)).toEqual({
			success: false,
			error: 'Claim is not available',
			claim: {
				campaignId: 'mobile-launch',
				authorityId: mockWalletAddress,
				claimType: ClaimType.FIXED,
				status: ClaimStatus.COMPLETED,
				amount: 5,
				assetSymbol: 'USDC',
				campaignStartTs: activeClaim.campaignStartTs,
				campaignEndTs: activeClaim.campaignEndTs,
				targetUserAccount: 'user123',
			},
		});
	});

	it('gets accrual progress for the authenticated authority', async () => {
		mockGetClaim.mockResolvedValue({
			...activeClaim,
			campaignId: 'fees-rebate-v1',
			claimType: ClaimType.ACCRUAL,
			status: ClaimStatus.ACCRUING,
			amount: 10,
			progressAmount: 4,
			progressCap: 10,
			claimableAmount: 0,
			claimedAmount: 0,
			lastSyncedAt: 1234567890,
		});

		const response = await app.inject({
			method: 'GET',
			url: '/claim/fees-rebate-v1',
		});

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload)).toEqual({
			success: true,
			claim: {
				campaignId: 'fees-rebate-v1',
				authorityId: mockWalletAddress,
				claimType: ClaimType.ACCRUAL,
				status: ClaimStatus.ACCRUING,
				amount: 10,
				assetSymbol: 'USDC',
				progressAmount: 4,
				progressCap: 10,
				claimableAmount: 0,
				claimedAmount: 0,
				lastSyncedAt: 1234567890,
				campaignEndTs: activeClaim.campaignEndTs,
			},
		});
	});

	it('rejects accrual claims that have not reached the cap', async () => {
		mockGetClaim.mockResolvedValue({
			...activeClaim,
			campaignId: 'fees-rebate-v1',
			claimType: ClaimType.ACCRUAL,
			status: ClaimStatus.ELIGIBLE,
			amount: 10,
			progressAmount: 4,
			progressCap: 10,
			claimableAmount: 0,
		});

		const response = await app.inject({
			method: 'POST',
			url: '/claim',
			payload: {
				campaignId: 'fees-rebate-v1',
				deviceId: 'device-1',
				targetUserAccount: 'user123',
			},
		});

		expect(response.statusCode).toBe(409);
		expect(mockReserveClaim).not.toHaveBeenCalled();
	});
});
