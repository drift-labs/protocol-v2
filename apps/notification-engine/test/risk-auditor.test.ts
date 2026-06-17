import { RiskBucket } from '@backend/common';
import { handler } from '../src/risk-auditor';

const mockGetHealth = jest.fn();
const mockGetMaintenanceMarginRequirement = jest.fn();
const mockGetTotalCollateral = jest.fn();
const mockUserSubscribe = jest.fn();

jest.mock('@velocity-exchange/sdk', () => ({
	VelocityClient: jest.fn().mockImplementation(() => ({
		subscribe: jest.fn(),
	})),
	User: jest.fn().mockImplementation(() => ({
		getHealth: mockGetHealth,
		getMaintenanceMarginRequirement: mockGetMaintenanceMarginRequirement,
		getTotalCollateral: mockGetTotalCollateral,
		subscribe: mockUserSubscribe,
	})),
	initialize: jest.fn().mockImplementation(() => {
		return {
			SPOT_MARKETS: [],
			PERP_MARKETS: [],
		};
	}),
	Wallet: jest.fn(),
}));

const mockGetMultipleAccountsInfo = jest.fn();
jest.mock('@solana/web3.js', () => ({
	...jest.requireActual('@solana/web3.js'),
	Connection: jest.fn().mockImplementation(() => ({
		getMultipleAccountsInfo: () => mockGetMultipleAccountsInfo(),
	})),
}));

const mockGetUsersByRiskBucket = jest.fn();
const mockUpdateAccountRisk = jest.fn();
const mockRemoveAccountFromBucket = jest.fn();
jest.mock('@backend/redis', () => ({
	RiskRepository: () => ({
		getUsersByRiskBucket: mockGetUsersByRiskBucket,
		updateAccountRisk: mockUpdateAccountRisk,
		removeAccountFromBucket: mockRemoveAccountFromBucket,
	}),
}));

const mockDetermineRiskBucket = jest.fn();
const mockCreateUserAccountFromBuffer = jest.fn();
const mockIsSignificantHealthChange = jest.fn();
const mockAddToNotificationQueue = jest.fn();
const mockProcessNotifications = jest.fn();
const mockGetNotificationQueue = jest.fn();
jest.mock('../src/services/risk-manager', () => ({
	RiskManager: () => ({
		determineRiskBucket: mockDetermineRiskBucket,
		createUserAccountFromBuffer: mockCreateUserAccountFromBuffer,
		isSignificantHealthChange: mockIsSignificantHealthChange,
		addToNotificationQueue: mockAddToNotificationQueue,
		processNotifications: mockProcessNotifications,
		getNotificationQueue: mockGetNotificationQueue,
	}),
}));

describe('Risk Bucket Verifier', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockGetNotificationQueue.mockReturnValue([]);
	});

	const createMockUser = (healthRatio: number) => ({
		getHealth: () => healthRatio,
		getMaintenanceMarginRequirement: () => ({ toNumber: () => healthRatio * 1e6 }),
		getTotalCollateral: () => ({ toNumber: () => healthRatio * 2e6 }),
		subscribe: jest.fn(),
	});

	describe('successful verification', () => {
		it('should process users with no health changes', async () => {
			const mockUsers = [
				{ value: genMockKey(), score: 95 },
				{ value: genMockKey(), score: 85 },
			];
			mockGetUsersByRiskBucket.mockResolvedValue(mockUsers);

			mockGetMultipleAccountsInfo.mockResolvedValue([
				{ data: Buffer.from('account1') },
				{ data: Buffer.from('account2') },
			]);

			mockCreateUserAccountFromBuffer.mockImplementation((_, user) =>
				createMockUser(user === 'user1' ? 95 : 85)
			);
			mockDetermineRiskBucket.mockReturnValue(RiskBucket.HEALTHY);
			mockIsSignificantHealthChange.mockReturnValue(false);

			const event = { riskBucket: RiskBucket.HEALTHY };
			const result = await handler(event);

			expect(result.verified).toBe(2);
			expect(result.mismatched).toBe(0);
			expect(result.failed).toBe(0);
			expect(mockAddToNotificationQueue).not.toHaveBeenCalled();
		});

		it('should detect and process health changes', async () => {
			const mockUsers = [
				{ value: genMockKey(), score: 95 },
				{ value: genMockKey(), score: 85 },
			];
			mockGetNotificationQueue.mockReturnValue([{}]);
			mockGetUsersByRiskBucket.mockResolvedValue(mockUsers);
			mockGetMultipleAccountsInfo.mockResolvedValue([
				{ data: Buffer.from('account1') },
				{ data: Buffer.from('account2') },
			]);

			mockCreateUserAccountFromBuffer.mockImplementation((_, user) =>
				createMockUser(user === 'user1' ? 95 : 65)
			);

			mockDetermineRiskBucket
				.mockReturnValueOnce(RiskBucket.HEALTHY)
				.mockReturnValueOnce(RiskBucket.MODERATE);

			mockIsSignificantHealthChange.mockReturnValueOnce(false).mockReturnValueOnce(true);

			const event = { riskBucket: RiskBucket.HEALTHY };
			const result = await handler(event);

			expect(result.verified).toBe(1);
			expect(result.mismatched).toBe(1);
			expect(mockUpdateAccountRisk).toHaveBeenCalledTimes(1);
			expect(mockAddToNotificationQueue).toHaveBeenCalledTimes(1);
			expect(mockProcessNotifications).toHaveBeenCalledTimes(1);
		});
	});

	describe('error handling', () => {
		it('should handle accounts not found on chain', async () => {
			const key = genMockKey();
			const mockUsers = [{ value: key, score: 95 }];
			mockGetUsersByRiskBucket.mockResolvedValue(mockUsers);
			mockGetMultipleAccountsInfo.mockResolvedValue([null]);

			const event = { riskBucket: RiskBucket.HEALTHY };
			const result = await handler(event);

			expect(mockRemoveAccountFromBucket).toHaveBeenCalledWith(key, 'HEALTHY');
			expect(result.failed).toBe(1);
			expect(result.verified).toBe(0);
		});

		it('should handle invalid risk bucket input', async () => {
			const event = { riskBucket: 999 };
			try {
				await handler(event);
				fail('Should have thrown an error');
			} catch (error) {
				const { message } = error as Error;
				expect(message).toBe('Invalid risk bucket: 999');
			}
		});

		it('should handle user creation errors', async () => {
			const mockUsers = [{ value: genMockKey(), score: 95 }];
			mockGetUsersByRiskBucket.mockResolvedValue(mockUsers);
			mockGetMultipleAccountsInfo.mockResolvedValue([{ data: Buffer.from('account1') }]);
			mockCreateUserAccountFromBuffer.mockRejectedValue(new Error('Failed to create user'));

			const event = { riskBucket: RiskBucket.HEALTHY };
			const result = await handler(event);

			expect(result.failed).toBe(1);
			expect(result.verified).toBe(0);
		});
	});

	describe('notification handling', () => {
		it('should process notifications after verification', async () => {
			const mockUsers = [{ value: genMockKey(), score: 95 }];
			mockGetUsersByRiskBucket.mockResolvedValue(mockUsers);
			mockGetMultipleAccountsInfo.mockResolvedValue([{ data: Buffer.from('account1') }]);
			mockCreateUserAccountFromBuffer.mockReturnValue(createMockUser(75));
			mockDetermineRiskBucket.mockReturnValue(RiskBucket.MODERATE);
			mockIsSignificantHealthChange.mockReturnValue(true);
			mockGetNotificationQueue.mockReturnValue([{ user: 'user1' }]);

			const event = { riskBucket: RiskBucket.HEALTHY };
			const result = await handler(event);

			expect(mockProcessNotifications).toHaveBeenCalled();
			expect(result.notificationsSent).toBe(1);
		});
	});
});
