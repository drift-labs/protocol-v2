import { createCluster } from 'redis';
import { Redis } from '../src/client';

jest.mock('redis', () => ({
	createCluster: jest.fn(),
}));

jest.mock('@backend/common', () => ({
	logger: {
		error: jest.fn(),
		info: jest.fn(),
		warn: jest.fn(),
	},
	DEFAULT_REDIS_CLIENT: 'redis://localhost:6379',
}));

describe('Redis Client', () => {
	const mockClient = {
		isOpen: true,
		connect: jest.fn().mockResolvedValue(undefined),
		quit: jest.fn().mockResolvedValue(undefined),
		get: jest.fn(),
		mGet: jest.fn(),
		set: jest.fn(),
		mSet: jest.fn(),
		setEx: jest.fn(),
		multi: jest.fn(),
		zAdd: jest.fn(),
		zRem: jest.fn(),
		zCard: jest.fn(),
		zRange: jest.fn(),
		zRangeByScore: jest.fn(),
		zRemRangeByRank: jest.fn(),
		zRangeWithScores: jest.fn(),
		zRevRank: jest.fn(),
		lRange: jest.fn(),
		hIncrByFloat: jest.fn(),
		expire: jest.fn(),
		sAdd: jest.fn(),
		sMembers: jest.fn(),
		hGetAll: jest.fn(),
		hSet: jest.fn(),
		copy: jest.fn(),
		publish: jest.fn(),
		subscribe: jest.fn(),
		unsubscribe: jest.fn(),
		on: jest.fn(),
	};

	(createCluster as jest.Mock).mockReturnValue(mockClient);

	const {
		get,
		mGet,
		set,
		mSet,
		setEx,
		zAdd,
		zRem,
		zCard,
		zRange,
		zRangeByScore,
		zRevRank,
		zRemRangeByRank,
		zRangeWithScores,
		lRange,
		hIncrByFloat,
		expire,
		sAdd,
		sMembers,
		hGetAll,
		hmSet,
		copy,
		executeInPipeline,
		publish,
		subscribe,
		unsubscribe,
	} = Redis();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('Methods', () => {
		describe('get', () => {
			it('should get a value successfully', async () => {
				mockClient.get.mockResolvedValue('value');
				const result = await get('key');
				expect(result).toBe('value');
				expect(mockClient.get).toHaveBeenCalledWith('key');
			});

			it('should handle null values', async () => {
				mockClient.get.mockResolvedValue(null);
				const result = await get('non-existent');
				expect(result).toBeNull();
			});
		});

		describe('mGet', () => {
			it('should get multiple values successfully', async () => {
				mockClient.mGet.mockResolvedValue(['value1', 'value2']);
				const result = await mGet(['key1', 'key2']);
				expect(result).toEqual(['value1', 'value2']);
				expect(mockClient.mGet).toHaveBeenCalledWith(['key1', 'key2']);
			});

			it('should handle empty array', async () => {
				const _result = await mGet([]);
				expect(mockClient.mGet).toHaveBeenCalledWith([]);
			});
		});

		describe('set', () => {
			it('should set a value successfully with KEEPTTL', async () => {
				mockClient.set.mockResolvedValue('OK');
				await set('key', 'value');
				expect(mockClient.set).toHaveBeenCalledWith('key', 'value', { KEEPTTL: true });
			});
		});

		describe('mSet', () => {
			it('should set multiple key-value pairs successfully', async () => {
				const keyValuePairs = {
					key1: 'value1',
					key2: 'value2',
				};
				mockClient.mSet.mockResolvedValue('OK');

				await mSet(keyValuePairs);

				expect(mockClient.mSet).toHaveBeenCalledWith(['key1', 'value1', 'key2', 'value2']);
			});

			it('should batch and rate limit large sets of key-value pairs', async () => {
				const largeKeyValuePairs: Record<string, string> = {};
				for (let i = 0; i < 1200; i++) {
					largeKeyValuePairs[`key${i}`] = `value${i}`;
				}

				mockClient.mSet.mockResolvedValue('OK');

				await mSet(largeKeyValuePairs);

				expect(mockClient.mSet).toHaveBeenCalledTimes(3);
				const firstCall = mockClient.mSet.mock.calls[0][0];
				expect(firstCall.length).toBe(1000);
			});

			it('should not use rate limiting for small sets', async () => {
				const keyValuePairs = {
					key1: 'value1',
					key2: 'value2',
				};
				mockClient.mSet.mockResolvedValue('OK');

				await mSet(keyValuePairs);

				expect(mockClient.mSet).toHaveBeenCalledTimes(1);
			});

			it('should handle empty input', async () => {
				await mSet({});
				expect(mockClient.mSet).toHaveBeenCalledWith([]);
			});
		});

		describe('setEx', () => {
			it('should set a value with expiration', async () => {
				mockClient.setEx.mockResolvedValue('OK');
				await setEx('key', 3600, 'value');
				expect(mockClient.setEx).toHaveBeenCalledWith('key', 3600, 'value');
			});
		});

		describe('zAdd', () => {
			it('should add members to sorted set', async () => {
				const members = [
					{ score: 1, value: 'one' },
					{ score: 2, value: 'two' },
				];
				mockClient.zAdd.mockResolvedValue(2);
				const result = await zAdd('set', members);
				expect(result).toBe(2);
				expect(mockClient.zAdd).toHaveBeenCalledWith('set', members);
			});
		});

		describe('zCard', () => {
			it('should return set cardinality', async () => {
				mockClient.zCard.mockResolvedValue(5);
				const result = await zCard('set');
				expect(result).toBe(5);
				expect(mockClient.zCard).toHaveBeenCalledWith('set');
			});
		});

		describe('zRange', () => {
			it('should return range of members', async () => {
				mockClient.zRange.mockResolvedValue(['one', 'two']);
				const result = await zRange('set', 0, -1);
				expect(result).toEqual(['one', 'two']);
				expect(mockClient.zRange).toHaveBeenCalledWith('set', 0, -1);
			});
		});

		describe('zRemRangeByRank', () => {
			it('should remove members by rank range', async () => {
				mockClient.zRemRangeByRank.mockResolvedValue(2);
				const result = await zRemRangeByRank('set', 0, 1);
				expect(result).toBe(2);
				expect(mockClient.zRemRangeByRank).toHaveBeenCalledWith('set', 0, 1);
			});
		});

		describe('zRangeByScore', () => {
			it('should return members within score range', async () => {
				mockClient.zRangeByScore.mockResolvedValue(['one', 'two']);
				const result = await zRangeByScore('set', 1, 2);
				expect(result).toEqual(['one', 'two']);
				expect(mockClient.zRangeByScore).toHaveBeenCalledWith('set', 1, 2, undefined);
			});

			it('should handle LIMIT option', async () => {
				const opts = { LIMIT: { offset: 0, count: 5 } };
				mockClient.zRangeByScore.mockResolvedValue(['one']);
				const _result = await zRangeByScore('set', 1, 2, opts);
				expect(mockClient.zRangeByScore).toHaveBeenCalledWith('set', 1, 2, opts);
			});
		});

		describe('zRem', () => {
			it('should remove specified members from sorted set', async () => {
				mockClient.zRem.mockResolvedValue(1);
				const result = await zRem('myzset', 'a', 'b');
				expect(result).toBe(1);
				expect(mockClient.zRem).toHaveBeenCalledWith('myzset', ['a', 'b']);
			});
		});

		describe('zRangeWithScores', () => {
			it('should return sorted set with scores', async () => {
				mockClient.zRangeWithScores.mockResolvedValue([{ value: 'a', score: 1 }]);
				const result = await zRangeWithScores('myzset', 0, 1);
				expect(result).toEqual([{ value: 'a', score: 1 }]);
				expect(mockClient.zRangeWithScores).toHaveBeenCalledWith('myzset', 0, 1);
			});

			it('should support reverse option', async () => {
				mockClient.zRangeWithScores.mockResolvedValue([{ value: 'b', score: 2 }]);
				await zRangeWithScores('myzset', 0, 1, true);
				expect(mockClient.zRangeWithScores).toHaveBeenCalledWith('myzset', 0, 1, {
					REV: true,
				});
			});
		});

		describe('zRevRank', () => {
			it('should return reverse rank of member', async () => {
				mockClient.zRevRank.mockResolvedValue(1);
				const result = await zRevRank('myzset', 'a');
				expect(result).toBe(1);
				expect(mockClient.zRevRank).toHaveBeenCalledWith('myzset', 'a');
			});
		});

		describe('lRange', () => {
			it('should return list range', async () => {
				mockClient.lRange = jest.fn().mockResolvedValue(['a', 'b']);
				const result = await lRange('mylist', 0, 1);
				expect(result).toEqual(['a', 'b']);
				expect(mockClient.lRange).toHaveBeenCalledWith('mylist', 0, 1);
			});
		});

		describe('hIncrByFloat', () => {
			it('should increment a hash field by float', async () => {
				mockClient.hIncrByFloat = jest.fn().mockResolvedValue(10.5);
				const result = await hIncrByFloat('myhash', 'field', 1.5);
				expect(result).toBe(10.5);
				expect(mockClient.hIncrByFloat).toHaveBeenCalledWith('myhash', 'field', 1.5);
			});
		});

		describe('expire', () => {
			it('should set expiration on a key', async () => {
				mockClient.expire = jest.fn().mockResolvedValue(1);
				const result = await expire('mykey', 60);
				expect(result).toBe(1);
				expect(mockClient.expire).toHaveBeenCalledWith('mykey', 60);
			});
		});

		describe('sAdd', () => {
			it('should add member to set', async () => {
				mockClient.sAdd = jest.fn().mockResolvedValue(1);
				const result = await sAdd('myset', 'member');
				expect(result).toBe(1);
				expect(mockClient.sAdd).toHaveBeenCalledWith('myset', 'member');
			});
		});

		describe('sMembers', () => {
			it('should return all members of a set', async () => {
				mockClient.sMembers = jest.fn().mockResolvedValue(['a', 'b']);
				const result = await sMembers('myset');
				expect(result).toEqual(['a', 'b']);
			});
		});

		describe('hGetAll', () => {
			it('should return all fields of a hash', async () => {
				mockClient.hGetAll = jest.fn().mockResolvedValue({ a: '1', b: '2' });
				const result = await hGetAll('myhash');
				expect(result).toEqual({ a: '1', b: '2' });
			});

			it('should return null for empty hash', async () => {
				mockClient.hGetAll = jest.fn().mockResolvedValue({});
				const result = await hGetAll('myhash');
				expect(result).toBeNull();
			});
		});

		describe('hmSet', () => {
			it('should set multiple hash fields', async () => {
				mockClient.hSet = jest.fn().mockResolvedValue(2);
				const data = { field1: 'value1', field2: 'value2' };
				const result = await hmSet('myhash', data);
				expect(result).toBe(2);
				expect(mockClient.hSet).toHaveBeenCalledWith('myhash', data);
			});
		});

		describe('copy', () => {
			it('should copy key to destination', async () => {
				mockClient.copy = jest.fn().mockResolvedValue(1);
				const result = await copy('source', 'dest');
				expect(result).toBe(1);
				expect(mockClient.copy).toHaveBeenCalledWith('source', 'dest', { replace: true });
			});
		});

		describe('executeInPipeline', () => {
			it('should execute commands in pipeline', async () => {
				const execMock = jest.fn().mockResolvedValue('OK');
				const multiMock = {
					set: jest.fn().mockReturnThis(),
					exec: execMock,
				};
				mockClient.multi = jest.fn(() => multiMock);

				await executeInPipeline((pipeline) => {
					pipeline.set('k', 'v');
				});

				expect(mockClient.multi).toHaveBeenCalled();
				expect(multiMock.set).toHaveBeenCalledWith('k', 'v');
				expect(execMock).toHaveBeenCalled();
			});
		});

		describe('publish', () => {
			it('should publish message to channel', async () => {
				mockClient.publish.mockResolvedValue(1);
				const result = await publish('channel', 'message');
				expect(result).toBe(1);
				expect(mockClient.publish).toHaveBeenCalledWith('channel', 'message');
			});
		});

		describe('subscribe', () => {
			it('should subscribe to channels with message handler', async () => {
				const onMessage = jest.fn();
				await subscribe(['channel1', 'channel2'], onMessage);
				expect(mockClient.subscribe).toHaveBeenCalledWith(
					['channel1', 'channel2'],
					onMessage
				);
			});
		});

		describe('unsubscribe', () => {
			it('should unsubscribe from channels', async () => {
				await unsubscribe(['channel1', 'channel2']);
				expect(mockClient.unsubscribe).toHaveBeenCalledWith(['channel1', 'channel2']);
			});
		});
	});

	describe('Retry', () => {
		it('should retry failed operations', async () => {
			mockClient.get
				.mockRejectedValueOnce(new Error('Temporary failure'))
				.mockResolvedValueOnce('success');

			const result = await get('key');

			expect(result).toBe('success');
			expect(mockClient.get).toHaveBeenCalledTimes(2);
		});

		it('should fail after maximum retries', async () => {
			const error = new Error('Persistent failure');
			mockClient.get.mockRejectedValue(error);
			await expect(get('key')).rejects.toThrow(error);
		});

		it('should ensure connection before operation', async () => {
			mockClient.isOpen = false;
			mockClient.get.mockResolvedValue('value');

			await get('key');

			expect(mockClient.connect).toHaveBeenCalled();
			expect(mockClient.get).toHaveBeenCalled();
		});
	});
});
