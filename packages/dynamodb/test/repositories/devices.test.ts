import { DevicePlatform, DeviceRecord } from '@backend/common';
import { DeviceRepository } from '../../src/repositories/devices';

const mockUpdate = jest.fn();
const mockQuery = jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		update: mockUpdate,
		query: mockQuery,
	}),
}));

jest.mock('@backend/common', () => ({
	...jest.requireActual('@backend/common'),
	getTimestamp: jest.fn().mockReturnValue(1000000000),
}));

jest.mock('../../src/utils', () => ({
	...jest.requireActual('../../src/utils'),
	getTTLTimestampForDelete: jest.fn().mockReturnValue(1000086400),
	getRecordKeys: jest.requireActual('../../src/utils').getRecordKeys,
}));

describe('DeviceRepository', () => {
	const { upsertDevice, getDevices, removeDevice } = DeviceRepository();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('upsertDevice', () => {
		it('should call update with correct parameters', async () => {
			const deviceRecord = {
				authorityId: 'auth123',
				deviceId: 'device123',
				token: 'token123',
				platform: DevicePlatform.IOS,
			};

			await upsertDevice(deviceRecord);

			expect(mockUpdate).toHaveBeenCalledWith({
				pk: 'AUTHORITY#auth123',
				sk: 'DEVICE#device123',
				updateExpression:
					'SET #token = :token, platform = :platform, authorityId = :authorityId, deviceId = :deviceId, updatedAt = :updatedAt, active = :active, createdAt = if_not_exists(createdAt, :createdAt)',
				expressionNames: {
					'#token': 'token',
				},
				expressionValues: {
					':token': 'token123',
					':platform': DevicePlatform.IOS,
					':authorityId': 'auth123',
					':deviceId': 'device123',
					':active': true,
					':updatedAt': 1000000000,
					':createdAt': 1000000000,
				},
			});
		});

		it('should handle null/undefined values', async () => {
			const deviceRecord = {
				authorityId: 'auth123',
				deviceId: 'device123',
			} as DeviceRecord;

			await upsertDevice(deviceRecord);

			expect(mockUpdate).toHaveBeenCalledWith(
				expect.objectContaining({
					expressionValues: expect.objectContaining({
						':token': '',
						':platform': '',
					}),
				})
			);
		});
	});

	describe('getDevices', () => {
		it('should call query with correct parameters', async () => {
			const authorityId = 'auth123';
			await getDevices(authorityId);

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'AUTHORITY#auth123',
				sk: 'DEVICE#',
				expression: 'pk = :pk and begins_with(sk, :sk)',
				filterExpression: 'active = :active',
				expressionValues: {
					':pk': 'AUTHORITY#auth123',
					':sk': 'DEVICE#',
					':active': true,
				},
			});
		});

		it('should return devices array', async () => {
			const mockDevices = [
				{
					authorityId: 'auth123',
					deviceId: 'device1',
					token: 'token1',
					platform: DevicePlatform.IOS,
				},
				{
					authorityId: 'auth123',
					deviceId: 'device2',
					token: 'token2',
					platform: DevicePlatform.ANDROID,
				},
			];

			mockQuery.mockResolvedValueOnce({ Items: mockDevices });

			const result = await getDevices('auth123');
			expect(result).toEqual(mockDevices);
		});

		it('should return empty array when no devices found', async () => {
			mockQuery.mockResolvedValueOnce({ Items: [] });

			const result = await getDevices('auth123');
			expect(result).toEqual([]);
		});
	});

	describe('removeDevice', () => {
		it('should call update with correct parameters for device removal', async () => {
			const deviceInfo = {
				authorityId: 'auth123',
				deviceId: 'device123',
			};

			await removeDevice(deviceInfo);

			expect(mockUpdate).toHaveBeenCalledWith({
				pk: 'AUTHORITY#auth123',
				sk: 'DEVICE#device123',
				updateExpression: 'SET updatedAt = :updatedAt, active = :active, #ttl = :ttl',
				expressionNames: {
					'#ttl': 'ttl',
				},
				expressionValues: {
					':active': false,
					':updatedAt': 1000000000,
					':ttl': 1000086400,
				},
			});
		});

		it('should handle removal with minimal device info', async () => {
			const deviceInfo = {
				authorityId: 'auth123',
				deviceId: 'device123',
			};

			await removeDevice(deviceInfo);

			expect(mockUpdate).toHaveBeenCalledWith(
				expect.objectContaining({
					pk: 'AUTHORITY#auth123',
					sk: 'DEVICE#device123',
				})
			);
		});
	});
});
