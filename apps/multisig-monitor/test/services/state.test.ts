/**
 * State store tests. We mock @backend/dynamodb to assert the conditional-put
 * is wired correctly and that ConditionalCheckFailedException is converted
 * to "already seen".
 */
const mockPut = jest.fn();
jest.mock('@backend/dynamodb', () => ({
	DynamoDB: jest.fn().mockImplementation(() => ({
		put: mockPut,
		get: jest.fn(),
		query: jest.fn(),
		queryAll: jest.fn(),
		batchWrite: jest.fn(),
		batchRemove: jest.fn(),
		batchGet: jest.fn(),
		remove: jest.fn(),
		update: jest.fn(),
		transact: jest.fn(),
	})),
}));

import { createStateStore } from '../../src/services/state';

const store = createStateStore({
	tableName: 'test-table',
	signatureTtlSeconds: 24 * 3600,
});

const conditionalCheckFailed = (): Error => {
	const err = new Error('The conditional request failed');
	(err as Error & { name: string }).name = 'ConditionalCheckFailedException';
	return err;
};

beforeEach(() => {
	mockPut.mockReset();
});

describe('markSignatureSeen', () => {
	it('returns false on first write and includes a TTL attribute', async () => {
		mockPut.mockResolvedValueOnce(undefined);
		const before = Math.floor(Date.now() / 1000);
		const seen = await store.markSignatureSeen('sig-abc');
		const after = Math.floor(Date.now() / 1000);

		expect(seen).toBe(false);
		expect(mockPut).toHaveBeenCalledTimes(1);
		const call = mockPut.mock.calls[0]![0];
		expect(call.record).toMatchObject({
			pk: 'SIG#sig-abc',
			sk: 'META',
			signature: 'sig-abc',
		});
		expect(call.record.ttl).toBeGreaterThanOrEqual(before + 24 * 3600);
		expect(call.record.ttl).toBeLessThanOrEqual(after + 24 * 3600);
		expect(call.conditionExpression).toBe('attribute_not_exists(pk)');
	});

	it('returns true on ConditionalCheckFailedException', async () => {
		mockPut.mockRejectedValueOnce(conditionalCheckFailed());
		const seen = await store.markSignatureSeen('sig-abc');
		expect(seen).toBe(true);
	});

	it('returns false (err on side of alerting) on unexpected DynamoDB errors', async () => {
		mockPut.mockRejectedValueOnce(new Error('throttle'));
		const seen = await store.markSignatureSeen('sig-abc');
		expect(seen).toBe(false);
	});
});

describe('markNonceAccountSeen', () => {
	it('returns false on first write with no TTL (permanent record)', async () => {
		mockPut.mockResolvedValueOnce(undefined);
		const seen = await store.markNonceAccountSeen('nonce-abc');

		expect(seen).toBe(false);
		const call = mockPut.mock.calls[0]![0];
		expect(call.record).toMatchObject({
			pk: 'NONCE#nonce-abc',
			sk: 'META',
			nonceAccount: 'nonce-abc',
		});
		expect(call.record.ttl).toBeUndefined();
	});

	it('returns true on ConditionalCheckFailedException', async () => {
		mockPut.mockRejectedValueOnce(conditionalCheckFailed());
		const seen = await store.markNonceAccountSeen('nonce-abc');
		expect(seen).toBe(true);
	});
});
