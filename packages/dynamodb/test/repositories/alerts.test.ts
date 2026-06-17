import { AlertDirection, SecondaryIndex } from '@backend/common';
import { AlertRepository } from '../../src/repositories/alerts';
import {
	getAlertRecordPrimaryKeys,
	getBaseRecordFields,
	getRecordKeys,
	getTTLTimestampForDelete,
} from '../../src/utils';

const mockUpdate = jest.fn();
const mockQuery = jest.fn();
const mockQueryAll = jest.fn();
const mockPut = jest.fn();
const mockGetRecordKeys = jest.fn();
const mockGetBaseRecordFields = jest.fn();
const mockGetAlertRecordPrimaryKeys = jest.fn();
const mockGetTTLTimestampForDelete = jest.fn();

jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		update: mockUpdate,
		query: mockQuery,
		queryAll: mockQueryAll,
		put: mockPut,
	}),
}));

jest.mock('uuid', () => ({
	v7: jest.fn().mockReturnValue('mocked-uuid'),
}));

jest.mock('@backend/common', () => ({
	...jest.requireActual('@backend/common'),
	getTimestamp: jest.fn().mockReturnValue(1000000000),
}));

jest.mock('../../src/utils', () => ({
	getRecordKeys: jest.fn(),
	getBaseRecordFields: jest.fn(),
	getAlertRecordPrimaryKeys: jest.fn(),
	getTTLTimestampForDelete: jest.fn(),
}));

describe('AlertRepository', () => {
	const { createAlert, getAlerts, removeAlert, checkPriceRange } = AlertRepository();

	beforeEach(() => {
		jest.clearAllMocks();
		mockQuery.mockResolvedValue({ Items: [] });
		mockQueryAll.mockResolvedValue([]);

		mockGetRecordKeys.mockImplementation((record) => ({
			pk: `AUTHORITY#${record.authorityId}`,
			sk: `ALERT#${record.alertId}`,
			GSI1PK: `ALERT#${record.symbol}#DIRECTION#${record.direction}`,
			GSI1SK: record.targetPrice.toString(),
		}));

		mockGetBaseRecordFields.mockReturnValue({
			active: true,
			createdAt: 1000000000,
			updatedAt: 1000000000,
		});

		mockGetAlertRecordPrimaryKeys.mockImplementation(({ authorityId, alertId }) => ({
			pk: `AUTHORITY#${authorityId}`,
			sk: `ALERT#${alertId}`,
		}));

		mockGetTTLTimestampForDelete.mockReturnValue(1000086400);

		(getRecordKeys as jest.Mock).mockImplementation(mockGetRecordKeys);
		(getBaseRecordFields as jest.Mock).mockImplementation(mockGetBaseRecordFields);
		(getAlertRecordPrimaryKeys as jest.Mock).mockImplementation(mockGetAlertRecordPrimaryKeys);
		(getTTLTimestampForDelete as jest.Mock).mockImplementation(mockGetTTLTimestampForDelete);
	});

	describe('createAlert', () => {
		const defaultAlertInput = {
			symbol: 'BTC',
			targetPrice: 50000,
			direction: AlertDirection.ABOVE,
			authorityId: 'auth123',
			active: true,
		};

		it('should create alerts with generated UUIDs', async () => {
			await createAlert(defaultAlertInput);

			expect(mockPut).toHaveBeenCalledWith({
				record: {
					...defaultAlertInput,
					alertId: 'mocked-uuid',
					pk: 'AUTHORITY#auth123',
					sk: 'ALERT#mocked-uuid',
					GSI1PK: 'ALERT#BTC#DIRECTION#ABOVE',
					GSI1SK: '50000',
					createdAt: 1000000000,
					updatedAt: 1000000000,
					active: true,
				},
			});
		});
	});

	describe('getAlerts', () => {
		const mockAlerts = [
			{
				alertId: 'alert1',
				symbol: 'BTC',
				targetPrice: 50000,
				direction: 'ABOVE',
				authorityId: 'auth123',
				active: true,
			},
			{
				alertId: 'alert2',
				symbol: 'ETH',
				targetPrice: 3000,
				direction: 'BELOW',
				authorityId: 'auth123',
				active: true,
			},
		];

		it('should query alerts with correct parameters', async () => {
			mockQuery.mockResolvedValueOnce({ Items: mockAlerts });

			const result = await getAlerts({ authorityId: 'auth123' });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'AUTHORITY#auth123',
				sk: 'ALERT#',
				expression: 'pk = :pk and begins_with(sk, :sk)',
				filterExpression: 'active = :active',
				expressionValues: {
					':pk': 'AUTHORITY#auth123',
					':sk': 'ALERT#',
					':active': true,
				},
			});

			expect(result).toEqual(mockAlerts);
		});

		it('should return empty array when no alerts found', async () => {
			mockQuery.mockResolvedValueOnce({ Items: [] });

			const result = await getAlerts({ authorityId: 'auth123' });
			expect(result).toEqual([]);
			expect(mockQuery).toHaveBeenCalledTimes(1);
		});
	});

	describe('checkPriceRange', () => {
		const mockRangeAlerts = [
			{
				alertId: 'alert1',
				symbol: 'BTC',
				targetPrice: 50000,
				direction: 'ABOVE',
				authorityId: 'auth123',
				active: true,
				pk: 'AUTHORITY#auth123',
				sk: 'ALERT#alert1',
			},
		];

		it('should query alerts within price range', async () => {
			mockQueryAll.mockResolvedValueOnce(mockRangeAlerts);

			const result = await checkPriceRange({
				symbol: 'BTC',
				direction: 'ABOVE',
				min: '49000',
				max: '51000',
			});

			expect(mockQueryAll).toHaveBeenCalledWith({
				pk: 'BTC#ABOVE',
				expression: 'GSI1PK = :GSI1PK AND GSI1SK BETWEEN :min AND :max',
				filterExpression: '',
				expressionValues: {
					':GSI1PK': 'ALERT#BTC#DIRECTION#ABOVE',
					':min': '49000',
					':max': '51000',
				},
				secondaryIndex: SecondaryIndex.GSI1,
			});

			expect(result).toEqual(mockRangeAlerts);
		});
	});

	describe('removeAlert', () => {
		it('should update alert with correct parameters for removal', async () => {
			const alertInfo = {
				authorityId: 'auth123',
				alertId: 'alert123',
			};

			await removeAlert(alertInfo);

			expect(mockGetAlertRecordPrimaryKeys).toHaveBeenCalledWith(alertInfo);
			expect(mockUpdate).toHaveBeenCalledWith({
				pk: 'AUTHORITY#auth123',
				sk: 'ALERT#alert123',
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
	});
});
