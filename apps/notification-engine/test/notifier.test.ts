import { marshall } from '@aws-sdk/util-dynamodb';
import { NotificationRecord, NotificationStatus, NotificationType } from '@backend/common';
import { SQSEvent } from 'aws-lambda';
import { handler } from '../src/notifier';
import * as providers from '../src/providers';

jest.mock('../src/providers', () => {
	return {
		registerAllProviders: jest.fn(),
		processNotification: jest.fn(),
	};
});

describe('Notification Handler', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	const createSQSEvent = (notifications: NotificationRecord[]): SQSEvent => ({
		Records: notifications.map((notification, index) => ({
			messageId: `msg-${index}`,
			body: JSON.stringify({ data: marshall({ ...notification }) }),
			receiptHandle: `receipt-${index}`,
			attributes: {
				ApproximateReceiveCount: '1',
				SentTimestamp: '',
				SenderId: '',
				ApproximateFirstReceiveTimestamp: '',
			},
			messageAttributes: {},
			md5OfBody: '',
			eventSource: '',
			eventSourceARN: '',
			awsRegion: '',
		})),
	});

	it('should process single notification and return empty batchItemFailures', async () => {
		(providers.processNotification as jest.Mock).mockResolvedValue(undefined);

		const notification: NotificationRecord = {
			authorityId: 'auth1',
			notificationId: '123',
			title: 'Test Title',
			body: 'Test Body',
			data: { key: 'value' },
			type: NotificationType.PRICE_ALERT,
			status: NotificationStatus.PENDING,
		};

		const event = createSQSEvent([notification]);
		const result = await handler(event);

		expect(providers.processNotification).toHaveBeenCalledWith(notification);
		expect(result.batchItemFailures).toHaveLength(0);
	});

	it('should handle failed notification processing and add to batchItemFailures', async () => {
		(providers.processNotification as jest.Mock).mockRejectedValue(
			new Error('Processing failed')
		);

		const notification: NotificationRecord = {
			authorityId: 'auth1',
			notificationId: '123',
			title: 'Test Title',
			body: 'Test Body',
			data: { key: 'value' },
			type: NotificationType.PRICE_ALERT,
			status: NotificationStatus.PENDING,
		};

		const event = createSQSEvent([notification]);
		const result = await handler(event);

		expect(providers.processNotification).toHaveBeenCalledWith(notification);
		expect(result.batchItemFailures).toHaveLength(1);
		expect(result.batchItemFailures[0].itemIdentifier).toBe('msg-0');
	});

	it('should process multiple notifications in batch', async () => {
		(providers.processNotification as jest.Mock).mockResolvedValue(undefined);

		const notifications: NotificationRecord[] = [
			{
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test 1',
				body: 'Body 1',
				data: { key: '1' },
				type: NotificationType.PRICE_ALERT,
				status: NotificationStatus.PENDING,
			},
			{
				authorityId: 'auth2',
				notificationId: '124',
				title: 'Test 2',
				body: 'Body 2',
				data: { key: '2' },
				type: NotificationType.PRICE_ALERT,
				status: NotificationStatus.PENDING,
			},
		];

		const event = createSQSEvent(notifications);
		const result = await handler(event);

		expect(providers.processNotification).toHaveBeenCalledTimes(2);
		expect(result.batchItemFailures).toHaveLength(0);
	});

	it('should handle partial failures in batch', async () => {
		(providers.processNotification as jest.Mock)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('Processing failed'));

		const notifications: NotificationRecord[] = [
			{
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test 1',
				body: 'Body 1',
				data: { key: '1' },
				type: NotificationType.PRICE_ALERT,
				status: NotificationStatus.PENDING,
			},
			{
				authorityId: 'auth2',
				notificationId: '124',
				title: 'Test 2',
				body: 'Body 2',
				data: { key: '2' },
				type: NotificationType.PRICE_ALERT,
				status: NotificationStatus.PENDING,
			},
		];

		const event = createSQSEvent(notifications);
		const result = await handler(event);

		expect(providers.processNotification).toHaveBeenCalledTimes(2);
		expect(result.batchItemFailures).toHaveLength(1);
		expect(result.batchItemFailures[0].itemIdentifier).toBe('msg-1');
	});
});
