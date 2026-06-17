import { NotificationStatus } from '@backend/common';
import Fastify, { FastifyInstance } from 'fastify';
import Pagination from '../../../src/plugins/pagination';
import notificationRoutes from '../../../src/routes/notifications/notifications';

const mockGetNotifications = jest.fn();
const mockUpdateNotificationStatus = jest.fn();

jest.mock('@backend/dynamodb', () => ({
	NotificationRepository: jest.fn(() => ({
		getNotifications: mockGetNotifications,
		updateNotificationStatus: mockUpdateNotificationStatus,
	})),
}));

describe('Notification Routes', () => {
	let app: FastifyInstance;
	const mockWalletAddress = 'auth123';

	beforeEach(async () => {
		app = Fastify();

		// Add a preHandler hook to inject walletAddress for testing
		app.addHook('preHandler', async (request) => {
			//@ts-ignore
			request.walletAddress = mockWalletAddress;
		});

		await app.register(Pagination);
		await app.register(notificationRoutes, { prefix: '/notifications' });
		await app.ready();
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	describe('GET /notifications', () => {
		const mockNotifications = [
			{
				notificationId: 'notif1',
				authorityId: 'auth123',
				type: 'ORDER_FILLED',
				status: NotificationStatus.SENT,
				title: 'Test Notification 1',
				body: 'Test Body 1',
				data: { test: 'data1' },
			},
			{
				notificationId: 'notif2',
				authorityId: 'auth123',
				type: 'ORDER_FILLED',
				status: NotificationStatus.SENT,
				title: 'Test Notification 2',
				body: 'Test Body 2',
				data: { test: 'data2' },
			},
		];

		it('should get notifications with default status', async () => {
			mockGetNotifications.mockResolvedValue({
				records: mockNotifications,
				meta: { nextPage: null },
			});

			const response = await app.inject({
				method: 'GET',
				url: '/notifications',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetNotifications).toHaveBeenCalledWith({
				authorityId: mockWalletAddress,
				status: NotificationStatus.SENT,
				page: undefined,
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				records: mockNotifications,
				meta: { nextPage: null },
			});
		});

		it('should get notifications with specified status', async () => {
			mockGetNotifications.mockResolvedValue({
				records: mockNotifications,
				meta: { nextPage: null },
			});

			const response = await app.inject({
				method: 'GET',
				url: '/notifications?status=READ',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetNotifications).toHaveBeenCalledWith({
				authorityId: mockWalletAddress,
				status: NotificationStatus.READ,
				page: undefined,
			});
		});

		it('should handle pagination for notifications', async () => {
			const lastEvaluatedKey = {
				pk: 'USER#testAccount',
				sk: 'ORDER#TYPE#PERP',
			};
			const encodedToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');

			const response = await app.inject({
				method: 'GET',
				url: `/notifications?page=${encodedToken}`,
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetNotifications).toHaveBeenCalledWith({
				authorityId: mockWalletAddress,
				status: NotificationStatus.SENT,
				page: lastEvaluatedKey,
			});
		});

		it('should return 401 when walletAddress is not set', async () => {
			const testApp = Fastify();
			await testApp.register(Pagination);
			await testApp.register(notificationRoutes, { prefix: '/notifications' });
			await testApp.ready();

			const response = await testApp.inject({
				method: 'GET',
				url: '/notifications',
			});

			expect(response.statusCode).toBe(401);
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: false,
				error: 'Unauthorized',
			});
		});

		it('should handle errors when getting notifications', async () => {
			mockGetNotifications.mockRejectedValue(new Error('Database error'));

			const response = await app.inject({
				method: 'GET',
				url: '/notifications',
			});

			expect(response.statusCode).toBe(500);
		});
	});

	describe('PUT /notifications/:notificationId/read', () => {
		it('should update notification status to read', async () => {
			mockUpdateNotificationStatus.mockResolvedValue(undefined);

			const response = await app.inject({
				method: 'PUT',
				url: '/notifications/notif123/read',
			});

			expect(response.statusCode).toBe(200);
			expect(mockUpdateNotificationStatus).toHaveBeenCalledWith({
				authorityId: mockWalletAddress,
				notificationId: 'notif123',
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
			});
		});

		it('should return 401 when walletAddress is not set', async () => {
			const testApp = Fastify();
			await testApp.register(Pagination);
			await testApp.register(notificationRoutes, { prefix: '/notifications' });
			await testApp.ready();

			const response = await testApp.inject({
				method: 'PUT',
				url: '/notifications/notif123/read',
			});

			expect(response.statusCode).toBe(401);
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: false,
				error: 'Unauthorized',
			});
		});

		it('should handle errors when updating notification status', async () => {
			mockUpdateNotificationStatus.mockRejectedValue(new Error('Database error'));

			const response = await app.inject({
				method: 'PUT',
				url: '/notifications/notif123/read',
			});

			expect(response.statusCode).toBe(500);
		});
	});
});
