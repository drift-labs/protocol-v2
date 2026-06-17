import {
	AlertDirection,
	NotificationChannel,
	NotificationStatus,
	NotificationType,
} from '@backend/common';
import { PriceProcessor } from '../../src/processors/price-processor';
import { OraclePriceData } from '../../src/types';

const mockBatchWrite = jest.fn();
const mockCheckPriceRange = jest.fn();
const mockCreateNotifications = jest.fn();
const mockGetTimestamp = jest.fn();
const mockGetNotificationTitle = jest.fn();
const mockGetNotificationBody = jest.fn();

jest.mock('@backend/dynamodb', () => ({
	DynamoDB: () => ({
		batchWrite: mockBatchWrite,
	}),
	AlertRepository: () => ({
		checkPriceRange: mockCheckPriceRange,
	}),
	NotificationRepository: () => ({
		createNotifications: mockCreateNotifications,
	}),
}));

jest.mock('@backend/common', () => ({
	...jest.requireActual('@backend/common'),
	getTimestamp: () => mockGetTimestamp(),
	logger: {
		info: jest.fn(),
		error: jest.fn(),
	},
}));

jest.mock('../../src/utils', () => ({
	getNotificationTitle: () => mockGetNotificationTitle(),
	getNotificationBody: () => mockGetNotificationBody(),
}));

describe('PriceProcessor', () => {
	const { processPriceUpdate } = PriceProcessor();

	beforeEach(() => {
		jest.clearAllMocks();
		mockCheckPriceRange.mockResolvedValue([]);
		mockGetTimestamp.mockReturnValue(1000000000);
		mockGetNotificationTitle.mockReturnValue('Test Title');
		mockGetNotificationBody.mockReturnValue('Test Body');
	});

	describe('processPriceUpdate', () => {
		it('should process ABOVE alerts when price increases', async () => {
			const message = {
				symbol: 'BTC-PERP',
				price: 51000,
				priceChange: 1000,
				confidence: 0.99,
				timestamp: Date.now(),
				slot: 100,
			} as OraclePriceData;

			await processPriceUpdate(message);

			expect(mockCheckPriceRange).toHaveBeenCalledWith({
				symbol: 'BTC-PERP',
				direction: 'ABOVE',
				min: '50000',
				max: '51000',
			});
		});

		it('should process BELOW alerts when price decreases', async () => {
			const message = {
				symbol: 'BTC-PERP',
				price: 50000,
				priceChange: -1000,
				confidence: 0.99,
				timestamp: Date.now(),
				slot: 100,
			} as OraclePriceData;

			await processPriceUpdate(message);

			expect(mockCheckPriceRange).toHaveBeenCalledWith({
				symbol: 'BTC-PERP',
				direction: 'BELOW',
				min: '50000',
				max: '51000',
			});
		});

		it('should create notifications and update alerts when alerts are triggered', async () => {
			const mockAlerts = [
				{
					alertId: 'alert1',
					symbol: 'BTC-PERP',
					targetPrice: 50500,
					direction: AlertDirection.ABOVE,
					authorityId: 'user1',
					triggeredAt: 1000000000,
					GSI1PK: 'ALERT#BTC-PERP#DIRECTION#ABOVE',
				},
				{
					alertId: 'alert2',
					symbol: 'BTC-PERP',
					targetPrice: 50800,
					direction: AlertDirection.ABOVE,
					authorityId: 'user2',
					triggeredAt: 1000000000,
					GSI1PK: 'ALERT#BTC-PERP#DIRECTION#ABOVE',
				},
			];

			mockCheckPriceRange.mockResolvedValue(mockAlerts);

			const message = {
				symbol: 'BTC-PERP',
				price: 51000,
				priceChange: 1000,
				confidence: 0.99,
				timestamp: Date.now(),
				slot: 100,
			} as OraclePriceData;

			await processPriceUpdate(message);

			expect(mockCreateNotifications).toHaveBeenCalledWith(
				mockAlerts.map((alert) => ({
					authorityId: alert.authorityId,
					type: NotificationType.PRICE_ALERT,
					status: NotificationStatus.PENDING,
					title: 'Test Title',
					body: 'Test Body',
					channels: [NotificationChannel.APP, NotificationChannel.PUSH],
					data: {
						symbol: alert.symbol,
						targetPrice: alert.targetPrice,
						triggeredAt: 1000000000,
						direction: alert.direction,
					},
				}))
			);

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: mockAlerts.map((alert) => ({
					...alert,
					lastTriggeredAt: 1000000000,
					GSI1PK: `TRIGGERED#${alert.GSI1PK}`,
				})),
			});
		});

		it('should skip processing when no alerts are found', async () => {
			mockCheckPriceRange.mockResolvedValue([]);

			const message = {
				symbol: 'BTC-PERP',
				price: 51000,
				priceChange: 1000,
				confidence: 0.99,
				timestamp: Date.now(),
				slot: 100,
			} as OraclePriceData;

			await processPriceUpdate(message);

			expect(mockCreateNotifications).not.toHaveBeenCalled();
			expect(mockBatchWrite).not.toHaveBeenCalled();
		});

		it('should handle errors from price range check', async () => {
			mockCheckPriceRange.mockRejectedValue(new Error('Database error'));

			const message = {
				symbol: 'BTC-PERP',
				price: 51000,
				priceChange: 1000,
				confidence: 0.99,
				timestamp: Date.now(),
				slot: 100,
			} as OraclePriceData;

			await expect(processPriceUpdate(message)).rejects.toThrow('Database error');
			expect(mockCreateNotifications).not.toHaveBeenCalled();
			expect(mockBatchWrite).not.toHaveBeenCalled();
		});

		it('should handle errors from notification creation', async () => {
			const mockAlerts = [
				{
					alertId: 'alert1',
					symbol: 'BTC-PERP',
					targetPrice: 50500,
					direction: AlertDirection.ABOVE,
					authorityId: 'user1',
					triggeredAt: 1000000000,
					GSI1PK: 'ALERT#BTC-PERP#DIRECTION#ABOVE',
				},
			];

			mockCheckPriceRange.mockResolvedValue(mockAlerts);
			mockCreateNotifications.mockRejectedValue(new Error('Notification error'));

			const message = {
				symbol: 'BTC-PERP',
				price: 51000,
				priceChange: 1000,
				confidence: 0.99,
				timestamp: Date.now(),
				slot: 100,
			} as OraclePriceData;

			await expect(processPriceUpdate(message)).rejects.toThrow('Notification error');
		});
	});
});
