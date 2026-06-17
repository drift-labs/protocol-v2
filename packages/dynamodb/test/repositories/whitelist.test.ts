import { WhitelistRepository } from '../../src/repositories/whitelist';
import { getBaseRecordFields, getRecordKeys, getTTLTimestampForDelete } from '../../src/utils';

const mockPut = jest.fn();
const mockQuery = jest.fn();
const mockUpdate = jest.fn();
const mockGetRecordKeys = jest.fn();
const mockGetBaseRecordFields = jest.fn();
const mockGetTTLTimestampForDelete = jest.fn();

jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		put: mockPut,
		query: mockQuery,
		update: mockUpdate,
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
	getTTLTimestampForDelete: jest.fn(),
}));

describe('WhitelistRepository', () => {
	const { createWhitelist, getWhitelist, updateWhitelist, removeWhitelist } =
		WhitelistRepository();

	beforeEach(() => {
		jest.clearAllMocks();
		mockQuery.mockResolvedValue({ Items: [] });
		mockUpdate.mockResolvedValue({ Attributes: {} });

		mockGetRecordKeys.mockImplementation((record) => ({
			pk: `AUTHORITY#${record.authorityId}`,
			sk: `WHITELIST#${record.whitelistId}`,
		}));

		mockGetBaseRecordFields.mockReturnValue({
			createdAt: 1000000000,
		});

		mockGetTTLTimestampForDelete.mockReturnValue(1000086400);

		(getRecordKeys as jest.Mock).mockImplementation(mockGetRecordKeys);
		(getBaseRecordFields as jest.Mock).mockImplementation(mockGetBaseRecordFields);
		(getTTLTimestampForDelete as jest.Mock).mockImplementation(mockGetTTLTimestampForDelete);
	});

	describe('createWhitelist', () => {
		const defaultWhitelistInput = {
			authorityId: 'auth123',
			address: 'wallet123',
			label: 'Main Wallet',
			token: 'USDC',
			chainId: 'solana',
		};

		it('should create whitelist entries with generated UUIDs', async () => {
			await createWhitelist(defaultWhitelistInput);

			expect(mockPut).toHaveBeenCalledWith({
				record: {
					...defaultWhitelistInput,
					whitelistId: 'mocked-uuid',
					active: true,
					updatedAt: 1000000000,
					pk: 'AUTHORITY#auth123',
					sk: 'WHITELIST#mocked-uuid',
					createdAt: 1000000000,
				},
			});
		});
	});

	describe('getWhitelist', () => {
		it('should query whitelist entries with correct parameters', async () => {
			await getWhitelist({ authorityId: 'auth123' });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'AUTHORITY#auth123',
				sk: 'WHITELIST#',
				expression: 'pk = :pk and begins_with(sk, :sk)',
				filterExpression: 'active = :active',
				expressionValues: {
					':pk': 'AUTHORITY#auth123',
					':sk': 'WHITELIST#',
					':active': true,
				},
				limit: 100,
			});
		});
	});

	describe('updateWhitelist', () => {
		it('should update a whitelist entry with correct parameters', async () => {
			await updateWhitelist({
				authorityId: 'auth123',
				whitelistId: 'wl1',
				address: 'wallet123',
				label: 'Updated Label',
				token: 'SOL',
				chainId: 'solana',
			});

			expect(mockUpdate).toHaveBeenCalledWith({
				pk: 'AUTHORITY#auth123',
				sk: 'WHITELIST#wl1',
				updateExpression:
					'SET authorityId = :authorityId, whitelistId = :whitelistId, #address = :address, label = :label, #token = :token, chainId = :chainId, updatedAt = :updatedAt, active = :active, createdAt = if_not_exists(createdAt, :createdAt)',
				expressionNames: {
					'#token': 'token',
					'#address': 'address',
				},
				expressionValues: {
					':authorityId': 'auth123',
					':whitelistId': 'wl1',
					':address': 'wallet123',
					':label': 'Updated Label',
					':token': 'SOL',
					':chainId': 'solana',
					':active': true,
					':updatedAt': 1000000000,
					':createdAt': 1000000000,
				},
			});
		});
	});

	describe('removeWhitelist', () => {
		it('should soft delete a whitelist entry', async () => {
			await removeWhitelist({
				authorityId: 'auth123',
				whitelistId: 'wl1',
			});

			expect(mockUpdate).toHaveBeenCalledWith({
				pk: 'AUTHORITY#auth123',
				sk: 'WHITELIST#wl1',
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
