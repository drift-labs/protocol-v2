import { DevicePlatform } from '@backend/common';
import Fastify, { FastifyInstance } from 'fastify';
import deviceRoutes from '../../../src/routes/notifications/devices';

const mockUpsertDevice = jest.fn();
const mockGetDevices = jest.fn();
const mockRemoveDevice = jest.fn();

jest.mock('@backend/dynamodb', () => ({
	DeviceRepository: jest.fn(() => ({
		upsertDevice: mockUpsertDevice,
		getDevices: mockGetDevices,
		removeDevice: mockRemoveDevice,
	})),
}));

describe('Device Routes', () => {
	let app: FastifyInstance;
	const mockWalletAddress = 'auth123';

	beforeEach(async () => {
		app = Fastify();

		// Add a preHandler hook to inject walletAddress for testing
		app.addHook('preHandler', async (request) => {
			// @ts-ignore
			request.walletAddress = mockWalletAddress;
		});

		await app.register(deviceRoutes, { prefix: '/devices' });
		await app.ready();
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	describe('POST /devices', () => {
		it('should register or update a device', async () => {
			const mockDevice = {
				deviceId: 'device123',
				token: 'token123',
				platform: DevicePlatform.IOS,
			};

			mockUpsertDevice.mockResolvedValue(mockDevice);

			const response = await app.inject({
				method: 'POST',
				url: '/devices',
				payload: {
					deviceId: 'device123',
					token: 'token123',
					platform: DevicePlatform.IOS,
				},
			});

			expect(response.statusCode).toBe(200);
			expect(mockUpsertDevice).toHaveBeenCalledWith({
				authorityId: mockWalletAddress,
				deviceId: 'device123',
				token: 'token123',
				platform: DevicePlatform.IOS,
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				device: mockDevice,
			});
		});

		it('should return 401 when walletAddress is not set', async () => {
			const testApp = Fastify();
			await testApp.register(deviceRoutes, { prefix: '/devices' });
			await testApp.ready();

			const response = await testApp.inject({
				method: 'POST',
				url: '/devices',
				payload: {
					deviceId: 'device123',
					token: 'token123',
					platform: DevicePlatform.IOS,
				},
			});

			expect(response.statusCode).toBe(401);
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: false,
				error: 'Unauthorized',
			});
		});

		it('should handle errors when registering device', async () => {
			mockUpsertDevice.mockRejectedValue(new Error('Database error'));

			const response = await app.inject({
				method: 'POST',
				url: '/devices',
				payload: {
					deviceId: 'device123',
					token: 'token123',
					platform: DevicePlatform.IOS,
				},
			});

			expect(response.statusCode).toBe(500);
		});
	});

	describe('GET /devices', () => {
		it('should get all devices for an account', async () => {
			const mockDevices = [
				{
					deviceId: 'device123',
					token: 'token123',
					platform: DevicePlatform.IOS,
				},
				{
					deviceId: 'device456',
					token: 'token456',
					platform: DevicePlatform.ANDROID,
				},
			];

			mockGetDevices.mockResolvedValue(mockDevices);

			const response = await app.inject({
				method: 'GET',
				url: '/devices',
			});

			expect(response.statusCode).toBe(200);
			expect(mockGetDevices).toHaveBeenCalledWith(mockWalletAddress);

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
				devices: mockDevices,
			});
		});

		it('should return 401 when walletAddress is not set', async () => {
			const testApp = Fastify();
			await testApp.register(deviceRoutes, { prefix: '/devices' });
			await testApp.ready();

			const response = await testApp.inject({
				method: 'GET',
				url: '/devices',
			});

			expect(response.statusCode).toBe(401);
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: false,
				error: 'Unauthorized',
			});
		});

		it('should handle errors when getting devices', async () => {
			mockGetDevices.mockRejectedValue(new Error('Database error'));

			const response = await app.inject({
				method: 'GET',
				url: '/devices',
			});

			expect(response.statusCode).toBe(500);
		});
	});

	describe('DELETE /devices/:deviceId', () => {
		it('should delete a device', async () => {
			mockRemoveDevice.mockResolvedValue(undefined);

			const response = await app.inject({
				method: 'DELETE',
				url: '/devices/device123',
			});

			expect(response.statusCode).toBe(200);
			expect(mockRemoveDevice).toHaveBeenCalledWith({
				authorityId: mockWalletAddress,
				deviceId: 'device123',
			});

			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: true,
			});
		});

		it('should return 401 when walletAddress is not set', async () => {
			const testApp = Fastify();
			await testApp.register(deviceRoutes, { prefix: '/devices' });
			await testApp.ready();

			const response = await testApp.inject({
				method: 'DELETE',
				url: '/devices/device123',
			});

			expect(response.statusCode).toBe(401);
			const payload = JSON.parse(response.payload);
			expect(payload).toEqual({
				success: false,
				error: 'Unauthorized',
			});
		});

		it('should handle errors when deleting device', async () => {
			mockRemoveDevice.mockRejectedValue(new Error('Database error'));

			const response = await app.inject({
				method: 'DELETE',
				url: '/devices/device123',
			});

			expect(response.statusCode).toBe(500);
		});
	});
});
