import { NotificationStatus, NotificationType } from '@backend/common';
import { NotificationRepository } from '../../src/repositories/notifications';
import {
	getBaseRecordFields,
	getRecordKeys,
	getTTLTimestampForNotification,
} from '../../src/utils';

const mockBatchWrite = jest.fn();
const mockQuery = jest.fn();
const mockGet = jest.fn();
const mockTransact = jest.fn();
const mockGetRecordKeys = jest.fn();
const mockGetBaseRecordFields = jest.fn();
const mockGetTTLTimestampForNotification = jest.fn();

jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		batchWrite: mockBatchWrite,
		query: mockQuery,
		get: mockGet,
		transact: mockTransact,
	}),
}));

jest.mock('uuid', () => ({
	v7: jest.fn().mockReturnValue('mocked-uuid'),
}));

jest.mock('@backend/common', () => ({
	...jest.requireActual('@backend/common'),
	RecordTypes: {
		NotificationRecord: 'NotificationRecord',
	},
	NotificationStatus: {
		PENDING: 'PENDING',
		READ: 'READ',
		SENT: 'SENT',
	},
	SecondaryIndex: {
		GSI1: 'GSI1',
	},
}));

jest.mock('../../src/utils', () => ({
	getRecordKeys: jest.fn(),
	getBaseRecordFields: jest.fn(),
	getTTLTimestampForNotification: jest.fn(),
}));

describe('NotificationRepository', () => {
	const {
		createNotifications,
		getNotifications,
		updateNotificationStatus,
		getLastNotificationByType,
	} = NotificationRepository();

	beforeEach(() => {
		jest.clearAllMocks();
		mockQuery.mockResolvedValue({ Items: [] });
		mockGet.mockResolvedValue({ Item: null });

		mockGetRecordKeys.mockImplementation((record) => ({
			pk: `AUTHORITY#${record.authorityId}`,
			sk: `NOTIFICATION#STATUS#${record.status}#${record.notificationId}`,
		}));

		mockGetBaseRecordFields.mockReturnValue({
			createdAt: 1000000000,
			updatedAt: 1000000000,
		});

		mockGetTTLTimestampForNotification.mockReturnValue({
			ttl: 1000086400,
		});

		(getRecordKeys as jest.Mock).mockImplementation(mockGetRecordKeys);
		(getBaseRecordFields as jest.Mock).mockImplementation(mockGetBaseRecordFields);
		(getTTLTimestampForNotification as jest.Mock).mockImplementation(
			mockGetTTLTimestampForNotification
		);
	});

	describe('createNotifications', () => {
		const defaultNotification = {
			authorityId: 'auth123',
			type: NotificationType.PRICE_ALERT,
			status: NotificationStatus.PENDING,
			title: 'Test Title',
			body: 'Test Body',
			data: { test: 'data' },
		};

		it('should create notifications with generated UUIDs', async () => {
			await createNotifications([defaultNotification]);

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					{
						...defaultNotification,
						notificationId: 'mocked-uuid',
						pk: 'AUTHORITY#auth123',
						sk: `NOTIFICATION#STATUS#${NotificationStatus.PENDING}#mocked-uuid`,
						createdAt: 1000000000,
						updatedAt: 1000000000,
						ttl: 1000086400,
					},
				],
			});
		});

		it('should handle multiple notifications', async () => {
			const notifications = [
				defaultNotification,
				{ ...defaultNotification, authorityId: 'auth456' },
			];

			await createNotifications(notifications);

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: expect.arrayContaining([
					expect.objectContaining({ authorityId: 'auth123' }),
					expect.objectContaining({ authorityId: 'auth456' }),
				]),
			});
			expect(mockBatchWrite.mock.calls[0][0].records).toHaveLength(2);
		});
	});

	describe('getNotifications', () => {
		const mockNotifications = [
			{
				notificationId: 'notif1',
				authorityId: 'auth123',
				status: NotificationStatus.PENDING,
				type: NotificationType.PRICE_ALERT,
				title: 'Test 1',
				body: 'Body 1',
			},
			{
				notificationId: 'notif2',
				authorityId: 'auth123',
				status: NotificationStatus.PENDING,
				type: NotificationType.PRICE_ALERT,
				title: 'Test 2',
				body: 'Body 2',
			},
		];

		it('should query notifications with correct parameters', async () => {
			mockQuery.mockResolvedValueOnce({
				Items: mockNotifications,
				LastEvaluatedKey: null,
			});

			const result = await getNotifications({
				authorityId: 'auth123',
				status: NotificationStatus.PENDING,
			});

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'AUTHORITY#auth123',
				sk: `NOTIFICATION#STATUS#${NotificationStatus.PENDING}`,
				lastEvaluatedKey: undefined,
			});

			expect(result).toEqual({
				records: mockNotifications,
				meta: { nextPage: null },
			});
		});

		it('should handle pagination correctly', async () => {
			const mockPage = { pk: 'lastPK', sk: 'lastSK' };
			const mockLastEvaluatedKey = { pk: 'nextPK', sk: 'nextSK' };

			mockQuery.mockResolvedValueOnce({
				Items: mockNotifications,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getNotifications({
				authorityId: 'auth123',
				status: NotificationStatus.PENDING,
				page: mockPage,
			});

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'AUTHORITY#auth123',
				sk: `NOTIFICATION#STATUS#${NotificationStatus.PENDING}`,
				lastEvaluatedKey: mockPage,
			});

			expect(result.meta.nextPage).toEqual(mockLastEvaluatedKey);
		});
	});

	describe('getLastNotificationByType', () => {
		const mockNotification = {
			notificationId: 'notif1',
			authorityId: 'auth123',
			status: NotificationStatus.PENDING,
			type: NotificationType.PRICE_ALERT,
			title: 'Test 1',
			body: 'Body 1',
			createdAt: 1000000000,
		};

		it('should query the most recent notification by type with the correct parameters', async () => {
			mockQuery.mockResolvedValueOnce({
				Items: [mockNotification],
			});

			const result = await getLastNotificationByType({
				authorityId: 'auth123',
				type: NotificationType.PRICE_ALERT,
			});

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'AUTHORITY#auth123',
				sk: `NOTIFICATION#TYPE#${NotificationType.PRICE_ALERT}`,
				limit: 1,
				secondaryIndex: 'GSI1',
			});

			expect(result).toEqual(mockNotification);
		});

		it('should return undefined when no notification is found', async () => {
			mockQuery.mockResolvedValueOnce({ Items: [] });

			const result = await getLastNotificationByType({
				authorityId: 'auth123',
				type: NotificationType.PRICE_ALERT,
			});

			expect(result).toBeUndefined();
		});
	});

	describe('updateNotificationStatus', () => {
		const mockExistingNotification = {
			pk: 'AUTHORITY#auth123',
			sk: `NOTIFICATION#STATUS#${NotificationStatus.PENDING}#notif1`,
			notificationId: 'notif1',
			authorityId: 'auth123',
			status: NotificationStatus.PENDING,
			type: NotificationType.PRICE_ALERT,
			title: 'Test',
			body: 'Body',
		};

		it('should update notification status correctly', async () => {
			mockGet.mockResolvedValueOnce({ Item: mockExistingNotification });

			await updateNotificationStatus({
				authorityId: 'auth123',
				notificationId: 'notif1',
			});

			expect(mockTransact).toHaveBeenCalledWith({
				items: [
					{
						Put: {
							Item: expect.objectContaining({
								...mockExistingNotification,
								sk: `NOTIFICATION#STATUS#${NotificationStatus.READ}#notif1`,
								status: NotificationStatus.READ,
								updatedAt: expect.any(Number),
							}),
						},
					},
					{
						Delete: {
							Key: {
								pk: mockExistingNotification.pk,
								sk: mockExistingNotification.sk,
							},
						},
					},
				],
			});
		});

		it('should set sentAt timestamp when updating to SENT status', async () => {
			mockGet.mockResolvedValueOnce({ Item: mockExistingNotification });

			await updateNotificationStatus({
				authorityId: 'auth123',
				notificationId: 'notif1',
				status: NotificationStatus.SENT,
			});

			expect(mockTransact).toHaveBeenCalledWith({
				items: [
					{
						Put: {
							Item: expect.objectContaining({
								...mockExistingNotification,
								sk: `NOTIFICATION#STATUS#${NotificationStatus.SENT}#notif1`,
								status: NotificationStatus.SENT,
								updatedAt: expect.any(Number),
								sentAt: expect.any(Number),
							}),
						},
					},
					{
						Delete: {
							Key: {
								pk: mockExistingNotification.pk,
								sk: mockExistingNotification.sk,
							},
						},
					},
				],
			});
		});

		it('should throw error when notification does not exist', async () => {
			mockGet.mockResolvedValueOnce({ Item: null });

			await expect(
				updateNotificationStatus({
					authorityId: 'auth123',
					notificationId: 'nonexistent',
				})
			).rejects.toThrow('Notification: nonexistent does not exist');

			expect(mockTransact).not.toHaveBeenCalled();
		});
	});
});
