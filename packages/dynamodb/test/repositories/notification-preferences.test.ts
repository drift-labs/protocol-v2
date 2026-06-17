import { NotificationPreferencesRecord, NotificationType } from '@backend/common';
import { NotificationRepository } from '../../src/repositories/notifications';

const mockGet = jest.fn();
const mockUpdate = jest.fn();

jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		get: mockGet,
		update: mockUpdate,
	}),
}));

jest.mock('@backend/common', () => ({
	...jest.requireActual('@backend/common'),
	getTimestamp: jest.fn().mockReturnValue(1000000000),
}));

describe('NotificationRepository preferences', () => {
	const { getPreferences, upsertPreferences } = NotificationRepository();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('getPreferences', () => {
		it('should return null when no preferences exist', async () => {
			mockGet.mockResolvedValue({ Item: null });

			const result = await getPreferences('auth123');

			expect(mockGet).toHaveBeenCalledWith({
				pk: 'AUTHORITY#auth123',
				sk: 'NOTIFICATION_PREFERENCES',
			});
			expect(result).toBeNull();
		});

		it('should return preferences when found', async () => {
			const preferences = {
				authorityId: 'auth123',
				pushOptOutTypes: [NotificationType.PRICE_ALERT],
			};

			mockGet.mockResolvedValue({ Item: preferences });

			const result = await getPreferences('auth123');

			expect(result).toEqual(preferences);
		});
	});

	describe('upsertPreferences', () => {
		it('should call update with correct parameters', async () => {
			const preferences: NotificationPreferencesRecord = {
				authorityId: 'auth123',
				pushOptOutTypes: [NotificationType.PRICE_ALERT, NotificationType.ACCOUNT_UPDATE],
			};

			mockUpdate.mockResolvedValue({ Attributes: preferences });

			const result = await upsertPreferences(preferences);

			expect(mockUpdate).toHaveBeenCalledWith({
				pk: 'AUTHORITY#auth123',
				sk: 'NOTIFICATION_PREFERENCES',
				updateExpression:
					'SET authorityId = :authorityId, pushOptOutTypes = :pushOptOutTypes, updatedAt = :updatedAt, createdAt = if_not_exists(createdAt, :createdAt)',
				expressionValues: {
					':authorityId': 'auth123',
					':pushOptOutTypes': [
						NotificationType.PRICE_ALERT,
						NotificationType.ACCOUNT_UPDATE,
					],
					':updatedAt': 1000000000,
					':createdAt': 1000000000,
				},
			});
			expect(result).toEqual(preferences);
		});
	});
});
