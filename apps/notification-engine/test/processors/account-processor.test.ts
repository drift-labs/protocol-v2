import {
	getTimestamp,
	NotificationChannel,
	NotificationStatus,
	NotificationType,
	RiskBucket,
} from '@backend/common';
import { AccountProcessor } from '../../src/processors/account-processor';
import { RiskNotification } from '../../src/types';

const mockCreateNotifications = jest.fn();
const mockGetLastNotificationByType = jest.fn();
jest.mock('@backend/dynamodb', () => ({
	NotificationRepository: () => ({
		createNotifications: mockCreateNotifications,
		getLastNotificationByType: mockGetLastNotificationByType,
	}),
}));

const mockCreateUserAccountFromBuffer = jest.fn();
const mockDetermineRiskBucket = jest.fn();
jest.mock('../../src/services/risk-manager', () => ({
	RiskManager: () => ({
		createUserAccountFromBuffer: mockCreateUserAccountFromBuffer,
		determineRiskBucket: mockDetermineRiskBucket,
	}),
}));

const mockGetAccountInfo = jest.fn();
jest.mock('@solana/web3.js', () => ({
	...jest.requireActual('@solana/web3.js'),
	Connection: jest.fn().mockImplementation(() => ({
		getAccountInfo: () => mockGetAccountInfo(),
	})),
}));

jest.mock('@velocity-exchange/sdk', () => ({
	VelocityClient: jest.fn().mockImplementation(() => ({
		subscribe: jest.fn(),
		_isSubscribed: false,
	})),
	initialize: jest.fn().mockImplementation(() => {
		return {
			SPOT_MARKETS: [],
			PERP_MARKETS: [],
		};
	}),
	Wallet: jest.fn(),
}));

process.env.MAX_NOTIFICATION_AGE_SECONDS = '600';
process.env.NOTIFICATION_COOLDOWN_SECONDS = '14400';

describe('AccountProcessor', () => {
	const { processAccount } = AccountProcessor();

	beforeEach(() => {
		jest.clearAllMocks();
		// Default is no previous notification (not in cooldown)
		mockGetLastNotificationByType.mockResolvedValue(null);
	});

	const mockMessage: RiskNotification = {
		user: '9qD4nu8BHktScBXcTuVCh5AEbn4ur2Hun2bSDXheH92S',
		newBucket: RiskBucket.AT_RISK,
		oldBucket: RiskBucket.HEALTHY,
		healthRatio: 80,
		timestamp: getTimestamp(),
	};

	const mockUserAccount = {
		getHealth: jest.fn().mockReturnValue(80),
		getUserAccount: jest.fn().mockReturnValue({
			authority: {
				toString: () => 'authorityId123',
			},
		}),
	};

	describe('processAccount', () => {
		it('should process account and create notification when risk bucket is CRITICAL', async () => {
			mockGetAccountInfo.mockResolvedValue({
				data: Buffer.from('mockData'),
			});
			mockCreateUserAccountFromBuffer.mockResolvedValue(mockUserAccount);
			mockDetermineRiskBucket.mockReturnValue(RiskBucket.CRITICAL);

			await processAccount(mockMessage);

			expect(mockGetLastNotificationByType).toHaveBeenCalledWith({
				authorityId: 'authorityId123',
				type: NotificationType.ACCOUNT_UPDATE,
			});

			expect(mockCreateNotifications).toHaveBeenCalledWith([
				{
					authorityId: 'authorityId123',
					user: '9qD4nu8BHktScBXcTuVCh5AEbn4ur2Hun2bSDXheH92S',
					type: NotificationType.ACCOUNT_UPDATE,
					status: NotificationStatus.PENDING,
					title: 'Liquidation warning!',
					body: 'Your account health is below 20% and is facing liquidation. Please deposit more collateral or manage your position!',
					channels: [NotificationChannel.APP, NotificationChannel.PUSH],
					data: {
						newBucket: RiskBucket.AT_RISK,
						oldBucket: RiskBucket.HEALTHY,
						healthRatio: 80,
					},
					actions: [
						{
							label: 'Deposit collateral',
							link: 'https://app.drift.trade/',
						},
					],
				},
			]);
		});

		it('should not create notification when in cooldown period', async () => {
			mockGetAccountInfo.mockResolvedValue({
				data: Buffer.from('mockData'),
			});
			mockCreateUserAccountFromBuffer.mockResolvedValue(mockUserAccount);
			mockDetermineRiskBucket.mockReturnValue(RiskBucket.CRITICAL);

			const recentTime = getTimestamp() - 1800; // 30 minutes ago
			mockGetLastNotificationByType.mockResolvedValue({
				notificationId: 'recent-notification',
				type: NotificationType.ACCOUNT_UPDATE,
				status: NotificationStatus.PENDING,
				createdAt: recentTime,
			});

			await processAccount(mockMessage);

			expect(mockGetLastNotificationByType).toHaveBeenCalledWith({
				authorityId: 'authorityId123',
				type: NotificationType.ACCOUNT_UPDATE,
			});

			expect(mockCreateNotifications).not.toHaveBeenCalled();
		});

		it('should create notification when outside cooldown period', async () => {
			mockGetAccountInfo.mockResolvedValue({
				data: Buffer.from('mockData'),
			});
			mockCreateUserAccountFromBuffer.mockResolvedValue(mockUserAccount);
			mockDetermineRiskBucket.mockReturnValue(RiskBucket.CRITICAL);

			const oldTime = getTimestamp() - 20000; // More than 5.5 hours ago
			mockGetLastNotificationByType.mockResolvedValue({
				notificationId: 'old-notification',
				type: NotificationType.ACCOUNT_UPDATE,
				status: NotificationStatus.SENT,
				createdAt: oldTime,
			});

			await processAccount(mockMessage);

			expect(mockGetLastNotificationByType).toHaveBeenCalledWith({
				authorityId: 'authorityId123',
				type: NotificationType.ACCOUNT_UPDATE,
			});

			expect(mockCreateNotifications).toHaveBeenCalled();
		});

		it('should not create notification when notification age exceeds maximum', async () => {
			const oldMessage = {
				...mockMessage,
				timestamp: getTimestamp() - 1200, // 20 minutes ago (exceeds 10 minute limit)
			};

			await processAccount(oldMessage);

			expect(mockGetAccountInfo).not.toHaveBeenCalled();
			expect(mockCreateNotifications).not.toHaveBeenCalled();
		});

		it('should not create notification when account info is not found', async () => {
			mockGetAccountInfo.mockResolvedValue(null);
			try {
				await processAccount(mockMessage);
				fail('Should have thrown an error');
			} catch (error) {
				const { message } = error as Error;
				expect(message).toBe(
					'Unable to find user account: 9qD4nu8BHktScBXcTuVCh5AEbn4ur2Hun2bSDXheH92S'
				);
				expect(mockCreateNotifications).not.toHaveBeenCalled();
			}
		});

		it('should not create notification when risk bucket is not CRITICAL', async () => {
			mockGetAccountInfo.mockResolvedValue({
				data: Buffer.from('mockData'),
			});
			mockCreateUserAccountFromBuffer.mockResolvedValue(mockUserAccount);
			mockDetermineRiskBucket.mockReturnValue(RiskBucket.HEALTHY);

			await processAccount(mockMessage);

			expect(mockCreateNotifications).not.toHaveBeenCalled();
		});

		it('should handle errors during processing', async () => {
			const error = new Error('Test error');
			mockGetAccountInfo.mockRejectedValue(error);
			await expect(processAccount(mockMessage)).rejects.toThrow('Test error');
		});
	});
});
