import { NotificationType } from '@backend/common';
import Fastify, { FastifyInstance } from 'fastify';
import preferencesRoutes from '../../../src/routes/notifications/preferences';

const mockGetPreferences = jest.fn();
const mockUpsertPreferences = jest.fn();

jest.mock('@backend/dynamodb', () => ({
	NotificationRepository: jest.fn(() => ({
		getPreferences: mockGetPreferences,
		upsertPreferences: mockUpsertPreferences,
	})),
}));

describe('Notification Preferences Routes', () => {
	let app: FastifyInstance;
	const mockWalletAddress = 'auth123';

	beforeEach(async () => {
		app = Fastify();

		app.addHook('preHandler', async (request) => {
			// @ts-ignore
			request.walletAddress = mockWalletAddress;
		});

		await app.register(preferencesRoutes, { prefix: '/notifications' });
		await app.ready();
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	describe('GET /notifications/preferences', () => {
		it('should return preferences when they exist', async () => {
			const preferences = {
				authorityId: mockWalletAddress,
				pushOptOutTypes: [NotificationType.PRICE_ALERT],
			};

			mockGetPreferences.mockResolvedValue(preferences);

			const response = await app.inject({
				method: 'GET',
				url: '/notifications/preferences',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetPreferences).toHaveBeenCalledWith(mockWalletAddress);

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				preferences,
			});
		});

		it('should return defaults when preferences do not exist', async () => {
			mockGetPreferences.mockResolvedValue(null);

			const response = await app.inject({
				method: 'GET',
				url: '/notifications/preferences',
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				preferences: {
					authorityId: mockWalletAddress,
					pushOptOutTypes: [],
				},
			});
		});

		it('should return 401 when walletAddress is not set', async () => {
			const testApp = Fastify();
			await testApp.register(preferencesRoutes, { prefix: '/notifications' });
			await testApp.ready();

			const response = await testApp.inject({
				method: 'GET',
				url: '/notifications/preferences',
			});

			expect(response.statusCode).toBe(401);
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: false,
				error: 'Unauthorized',
			});
		});
	});

	describe('PUT /notifications/preferences', () => {
		it('should update preferences', async () => {
			const preferences = {
				authorityId: mockWalletAddress,
				pushOptOutTypes: [NotificationType.ACCOUNT_UPDATE],
			};

			mockUpsertPreferences.mockResolvedValue(preferences);

			const response = await app.inject({
				method: 'PUT',
				url: '/notifications/preferences',
				payload: {
					pushOptOutTypes: [
						NotificationType.ACCOUNT_UPDATE,
						NotificationType.PRICE_ALERT,
					],
				},
			});

			expect(response.statusCode).toBe(200);
			expect(mockUpsertPreferences).toHaveBeenCalledWith({
				authorityId: mockWalletAddress,
				pushOptOutTypes: [NotificationType.ACCOUNT_UPDATE, NotificationType.PRICE_ALERT],
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				preferences,
			});
		});

		it('should return 401 when walletAddress is not set', async () => {
			const testApp = Fastify();
			await testApp.register(preferencesRoutes, { prefix: '/notifications' });
			await testApp.ready();

			const response = await testApp.inject({
				method: 'PUT',
				url: '/notifications/preferences',
				payload: {
					pushOptOutTypes: [NotificationType.PRICE_ALERT],
				},
			});

			expect(response.statusCode).toBe(401);
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: false,
				error: 'Unauthorized',
			});
		});
	});
});
