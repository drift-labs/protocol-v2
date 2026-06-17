import { AlertDirection } from '@backend/common';
import Fastify, { FastifyInstance } from 'fastify';
import alertRoutes from '../../../src/routes/notifications/alerts';

const mockCreateAlert = jest.fn();
const mockGetAlerts = jest.fn();
const mockRemoveAlert = jest.fn();

jest.mock('@backend/dynamodb', () => ({
	AlertRepository: jest.fn(() => ({
		createAlert: mockCreateAlert,
		getAlerts: mockGetAlerts,
		removeAlert: mockRemoveAlert,
	})),
}));

describe('Alert Routes', () => {
	let app: FastifyInstance;
	const mockWalletAddress = 'auth123';

	beforeEach(async () => {
		app = Fastify();

		// Add a preHandler hook to inject walletAddress for testing
		app.addHook('preHandler', async (request) => {
			// @ts-ignore
			request.walletAddress = mockWalletAddress;
		});

		await app.register(alertRoutes, { prefix: '/alerts' });
		await app.ready();
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	describe('POST /alerts', () => {
		const validAlertPayload = {
			symbol: 'SOL',
			targetPrice: 50000,
			direction: AlertDirection.ABOVE,
		};

		it('should create a new alert', async () => {
			const mockAlert = {
				alertId: 'alert123',
				...validAlertPayload,
				authorityId: mockWalletAddress,
			};

			mockCreateAlert.mockResolvedValue(mockAlert);

			const response = await app.inject({
				method: 'POST',
				url: '/alerts',
				payload: validAlertPayload,
			});

			expect(response.statusCode).toBe(200);
			expect(mockCreateAlert).toHaveBeenCalledWith({
				authorityId: mockWalletAddress,
				...validAlertPayload,
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				alert: mockAlert,
			});
		});

		it('should return 401 when walletAddress is not set', async () => {
			const testApp = Fastify();

			await testApp.register(alertRoutes, { prefix: '/alerts' });
			await testApp.ready();

			const response = await testApp.inject({
				method: 'POST',
				url: '/alerts',
				payload: validAlertPayload,
			});

			expect(response.statusCode).toBe(401);
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: false,
				error: 'Unauthorized',
			});
		});

		it('should handle validation error for invalid market', async () => {
			const response = await app.inject({
				method: 'POST',
				url: '/alerts',
				payload: {
					...validAlertPayload,
					symbol: 'INVALID',
				},
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);
			expect(payload.error).toBe('ValidationError');
		});

		it('should handle errors when creating alert', async () => {
			mockCreateAlert.mockRejectedValue(new Error('Database error'));

			const response = await app.inject({
				method: 'POST',
				url: '/alerts',
				payload: validAlertPayload,
			});

			expect(response.statusCode).toBe(500);
		});
	});

	describe('GET /alerts', () => {
		it('should get all alerts for an account', async () => {
			const mockAlerts = [
				{
					alertId: 'alert123',
					symbol: 'BTC',
					targetPrice: 50000,
					direction: AlertDirection.ABOVE,
					authorityId: mockWalletAddress,
				},
				{
					alertId: 'alert456',
					symbol: 'ETH',
					targetPrice: 3000,
					direction: AlertDirection.BELOW,
					authorityId: mockWalletAddress,
				},
			];

			mockGetAlerts.mockResolvedValue(mockAlerts);

			const response = await app.inject({
				method: 'GET',
				url: '/alerts',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetAlerts).toHaveBeenCalledWith({
				authorityId: mockWalletAddress,
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				alerts: mockAlerts,
			});
		});

		it('should return 401 when walletAddress is not set', async () => {
			const testApp = Fastify();
			await testApp.register(alertRoutes, { prefix: '/alerts' });
			await testApp.ready();

			const response = await testApp.inject({
				method: 'GET',
				url: '/alerts',
			});

			expect(response.statusCode).toBe(401);
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: false,
				error: 'Unauthorized',
			});
		});

		it('should return empty array when no alerts exist', async () => {
			mockGetAlerts.mockResolvedValue([]);

			const response = await app.inject({
				method: 'GET',
				url: '/alerts',
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				alerts: [],
			});
		});

		it('should handle errors when getting alerts', async () => {
			mockGetAlerts.mockRejectedValue(new Error('Database error'));

			const response = await app.inject({
				method: 'GET',
				url: '/alerts',
			});

			expect(response.statusCode).toBe(500);
		});
	});

	describe('DELETE /alerts/:alertId', () => {
		it('should delete an alert', async () => {
			mockRemoveAlert.mockResolvedValue(undefined);

			const response = await app.inject({
				method: 'DELETE',
				url: '/alerts/alert123',
			});

			expect(response.statusCode).toBe(200);
			expect(mockRemoveAlert).toHaveBeenCalledWith({
				authorityId: mockWalletAddress,
				alertId: 'alert123',
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
			});
		});

		it('should return 401 when walletAddress is not set', async () => {
			const testApp = Fastify();
			await testApp.register(alertRoutes, { prefix: '/alerts' });
			await testApp.ready();

			const response = await testApp.inject({
				method: 'DELETE',
				url: '/alerts/alert123',
			});

			expect(response.statusCode).toBe(401);
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: false,
				error: 'Unauthorized',
			});
		});

		it('should handle errors when deleting alert', async () => {
			mockRemoveAlert.mockRejectedValue(new Error('Database error'));

			const response = await app.inject({
				method: 'DELETE',
				url: '/alerts/alert123',
			});

			expect(response.statusCode).toBe(500);
		});
	});
});
