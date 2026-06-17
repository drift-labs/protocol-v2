import { DEFAULT_DYNAMO_TABLE, SecondaryIndex } from '@backend/common';
import { DynamoDB } from '../src/client';

jest.mock('@aws-sdk/client-dynamodb', () => {
	return {
		DynamoDBClient: jest.fn().mockImplementation(() => {
			return {};
		}),
	};
});

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => {
	return {
		DynamoDBDocumentClient: {
			from: jest.fn().mockImplementation(() => {
				return {
					send: (params: any) => mockSend(params),
				};
			}),
		},
		GetCommand: jest.fn().mockImplementation((values) => values),
		PutCommand: jest.fn().mockImplementation((values) => values),
		BatchWriteCommand: jest.fn().mockImplementation((values) => values),
		QueryCommand: jest.fn().mockImplementation((values) => values),
		UpdateCommand: jest.fn().mockImplementation((values) => values),
		BatchGetCommand: jest.fn().mockImplementation((values) => values),
	};
});

describe('DynamoDB', () => {
	const { get, put, batchWrite, query, update, queryAll, batchRemove, batchGet } = DynamoDB();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('get', () => {
		it('should call send with correct GetCommand', async () => {
			await get({ pk: 'testPK', sk: 'testSK' });

			expect(mockSend).toHaveBeenCalledWith(
				expect.objectContaining({
					TableName: DEFAULT_DYNAMO_TABLE,
					Key: { pk: 'testPK', sk: 'testSK' },
				})
			);
		});
	});

	describe('put', () => {
		it('should call send with correct PutCommand', async () => {
			const testRecord = { id: '123', data: 'test' };
			await put({ record: testRecord });

			expect(mockSend).toHaveBeenCalledWith(
				expect.objectContaining({
					TableName: DEFAULT_DYNAMO_TABLE,
					Item: testRecord,
				})
			);
		});
	});

	describe('batchWrite', () => {
		const testRecords = [
			{ id: '1', data: 'test1' },
			{ id: '2', data: 'test2' },
			{ id: '3', data: 'test3' },
		];

		it('should call send with correct BatchWriteCommand', async () => {
			const unprocessedItems = {};
			mockSend.mockResolvedValue({ UnprocessedItems: unprocessedItems });

			await batchWrite({ records: testRecords });

			expect(mockSend).toHaveBeenCalledWith(
				expect.objectContaining({
					RequestItems: {
						[DEFAULT_DYNAMO_TABLE]: testRecords.map((item) => ({
							PutRequest: { Item: item },
						})),
					},
				})
			);
		});

		it('should return the total number of failed items', async () => {
			const unprocessedItems = {
				[DEFAULT_DYNAMO_TABLE]: [{ PutRequest: { Item: testRecords[0] } }],
			};
			mockSend.mockResolvedValue({ UnprocessedItems: unprocessedItems });
			const result = await batchWrite({ records: testRecords });
			expect(result).toEqual([testRecords[0]]);
		});
	});

	describe('query', () => {
		it('should call send with correct QueryCommand for primary index', async () => {
			await query({ pk: 'testPK', sk: 'testSK' });

			expect(mockSend).toHaveBeenCalledWith({
				TableName: DEFAULT_DYNAMO_TABLE,
				KeyConditionExpression: 'pk = :pk and begins_with(sk, :sk)',
				ExpressionAttributeValues: { ':pk': 'testPK', ':sk': 'testSK' },
				Limit: 20,
				ScanIndexForward: false,
			});
		});

		it('should handle secondary index queries', async () => {
			await query({ pk: 'testPK', sk: 'testSK', secondaryIndex: SecondaryIndex.GSI1 });

			expect(mockSend).toHaveBeenCalledWith({
				TableName: DEFAULT_DYNAMO_TABLE,
				IndexName: 'GSI1',
				KeyConditionExpression: 'GSI1PK = :pk and begins_with(GSI1SK, :sk)',
				ExpressionAttributeValues: { ':pk': 'testPK', ':sk': 'testSK' },
				Limit: 20,
				ScanIndexForward: false,
			});
		});

		it('should handle custom expressions', async () => {
			const customExpression = 'pk = :pk and sk > :sk';
			await query({ pk: 'testPK', sk: 'testSK', expression: customExpression });

			expect(mockSend).toHaveBeenCalledWith({
				TableName: DEFAULT_DYNAMO_TABLE,
				KeyConditionExpression: customExpression,
				ExpressionAttributeValues: { ':pk': 'testPK', ':sk': 'testSK' },
				Limit: 20,
				ScanIndexForward: false,
			});
		});

		it('should handle pagination with lastEvaluatedKey', async () => {
			const lastEvaluatedKey = { pk: 'lastPK', sk: 'lastSK' };
			await query({ pk: 'testPK', sk: 'testSK', lastEvaluatedKey });

			expect(mockSend).toHaveBeenCalledWith({
				TableName: DEFAULT_DYNAMO_TABLE,
				KeyConditionExpression: 'pk = :pk and begins_with(sk, :sk)',
				ExpressionAttributeValues: { ':pk': 'testPK', ':sk': 'testSK' },
				Limit: 20,
				ExclusiveStartKey: lastEvaluatedKey,
				ScanIndexForward: false,
			});
		});

		it('should handle custom limit', async () => {
			await query({ pk: 'testPK', sk: 'testSK', limit: 50 });

			expect(mockSend).toHaveBeenCalledWith({
				TableName: DEFAULT_DYNAMO_TABLE,
				KeyConditionExpression: 'pk = :pk and begins_with(sk, :sk)',
				ExpressionAttributeValues: { ':pk': 'testPK', ':sk': 'testSK' },
				Limit: 50,
				ScanIndexForward: false,
			});
		});
	});

	describe('update', () => {
		it('should call send with correct basic UpdateCommand', async () => {
			await update({
				pk: 'testPK',
				sk: 'testSK',
				updateExpression: 'SET #status = :status',
				expressionNames: {
					'#status': 'status',
				},
				expressionValues: {
					':status': 'ACTIVE',
				},
			});

			expect(mockSend).toHaveBeenCalledWith(
				expect.objectContaining({
					TableName: DEFAULT_DYNAMO_TABLE,
					Key: { pk: 'testPK', sk: 'testSK' },
					UpdateExpression: 'SET #status = :status',
					ExpressionAttributeNames: {
						'#status': 'status',
					},
					ExpressionAttributeValues: {
						':status': 'ACTIVE',
					},
				})
			);
		});

		it('should handle conditional expressions', async () => {
			await update({
				pk: 'testPK',
				sk: 'testSK',
				updateExpression: 'SET #count = :newCount',
				conditionExpression: '#count = :currentCount',
				expressionNames: {
					'#count': 'count',
				},
				expressionValues: {
					':newCount': 2,
					':currentCount': 1,
				},
			});

			expect(mockSend).toHaveBeenCalledWith(
				expect.objectContaining({
					TableName: DEFAULT_DYNAMO_TABLE,
					Key: { pk: 'testPK', sk: 'testSK' },
					UpdateExpression: 'SET #count = :newCount',
					ConditionExpression: '#count = :currentCount',
					ExpressionAttributeNames: {
						'#count': 'count',
					},
					ExpressionAttributeValues: {
						':newCount': 2,
						':currentCount': 1,
					},
				})
			);
		});

		it('should handle multiple attribute updates', async () => {
			await update({
				pk: 'testPK',
				sk: 'testSK',
				updateExpression: 'SET #status = :status, #timestamp = :timestamp, #count = :count',
				expressionNames: {
					'#status': 'status',
					'#timestamp': 'timestamp',
					'#count': 'count',
				},
				expressionValues: {
					':status': 'COMPLETED',
					':timestamp': 1234567890,
					':count': 3,
				},
			});

			expect(mockSend).toHaveBeenCalledWith(
				expect.objectContaining({
					TableName: DEFAULT_DYNAMO_TABLE,
					Key: { pk: 'testPK', sk: 'testSK' },
					UpdateExpression:
						'SET #status = :status, #timestamp = :timestamp, #count = :count',
					ExpressionAttributeNames: {
						'#status': 'status',
						'#timestamp': 'timestamp',
						'#count': 'count',
					},
					ExpressionAttributeValues: {
						':status': 'COMPLETED',
						':timestamp': 1234567890,
						':count': 3,
					},
				})
			);
		});

		it('should handle ConditionalCheckFailedException', async () => {
			const error = {
				name: 'ConditionalCheckFailedException',
				message: 'The conditional request failed',
			};
			mockSend.mockRejectedValueOnce(error);

			await expect(
				update({
					pk: 'testPK',
					sk: 'testSK',
					updateExpression: 'SET #status = :status',
					conditionExpression: '#status = :oldStatus',
					expressionNames: {
						'#status': 'status',
					},
					expressionValues: {
						':status': 'COMPLETED',
						':oldStatus': 'ACTIVE',
					},
				})
			).rejects.toMatchObject({
				name: 'ConditionalCheckFailedException',
				message: expect.any(String),
			});
		});

		it('should handle update with no expression names', async () => {
			await update({
				pk: 'testPK',
				sk: 'testSK',
				updateExpression: 'SET value = :value',
				expressionValues: {
					':value': 'test',
				},
			});

			expect(mockSend).toHaveBeenCalledWith(
				expect.objectContaining({
					TableName: DEFAULT_DYNAMO_TABLE,
					Key: { pk: 'testPK', sk: 'testSK' },
					UpdateExpression: 'SET value = :value',
					ExpressionAttributeValues: {
						':value': 'test',
					},
				})
			);
		});
	});

	describe('queryAll', () => {
		it('should handle single page results', async () => {
			const items = [{ id: '1' }, { id: '2' }];
			mockSend.mockResolvedValueOnce({ Items: items });

			const result = await queryAll({ pk: 'testPK', sk: 'testSK' });

			expect(result).toEqual(items);
			expect(mockSend).toHaveBeenCalledTimes(1);
			expect(mockSend).toHaveBeenCalledWith({
				TableName: DEFAULT_DYNAMO_TABLE,
				KeyConditionExpression: 'pk = :pk and begins_with(sk, :sk)',
				ExpressionAttributeValues: { ':pk': 'testPK', ':sk': 'testSK' },
				Limit: 1000,
				ScanIndexForward: false,
			});
		});

		it('should handle paginated results', async () => {
			const firstPage = [{ id: '1' }, { id: '2' }];
			const secondPage = [{ id: '3' }, { id: '4' }];
			const lastEvaluatedKey = { pk: 'testPK', sk: 'lastSK' };

			mockSend
				.mockResolvedValueOnce({
					Items: firstPage,
					LastEvaluatedKey: lastEvaluatedKey,
				})
				.mockResolvedValueOnce({
					Items: secondPage,
				});

			const result = await queryAll({ pk: 'testPK', sk: 'testSK' });

			expect(result).toEqual([...firstPage, ...secondPage]);
			expect(mockSend).toHaveBeenCalledTimes(2);
			expect(mockSend).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({
					ExclusiveStartKey: lastEvaluatedKey,
				})
			);
		});

		it('should handle custom expressions with secondary index', async () => {
			const items = [{ id: '1' }];
			mockSend.mockResolvedValueOnce({ Items: items });

			await queryAll({
				pk: 'testPK',
				sk: 'testSK',
				secondaryIndex: SecondaryIndex.GSI1,
				expression: 'GSI1PK = :pk and GSI1SK > :sk',
				expressionValues: {
					':pk': 'testPK',
					':sk': 'testSK',
				},
			});

			expect(mockSend).toHaveBeenCalledWith(
				expect.objectContaining({
					IndexName: 'GSI1',
					KeyConditionExpression: 'GSI1PK = :pk and GSI1SK > :sk',
					ExpressionAttributeValues: {
						':pk': 'testPK',
						':sk': 'testSK',
					},
				})
			);
		});

		it('should handle empty results', async () => {
			mockSend.mockResolvedValueOnce({ Items: [] });

			const result = await queryAll({ pk: 'testPK', sk: 'testSK' });

			expect(result).toEqual([]);
			expect(mockSend).toHaveBeenCalledTimes(1);
		});
	});

	describe('batchRemove', () => {
		const testRecords = [
			{ pk: 'pk1', sk: 'sk1' },
			{ pk: 'pk2', sk: 'sk2' },
			{ pk: 'pk3', sk: 'sk3' },
		];

		it('should call send with correct BatchWriteCommand for deletions', async () => {
			mockSend.mockResolvedValue({ UnprocessedItems: {} });

			await batchRemove({ records: testRecords });

			expect(mockSend).toHaveBeenCalledWith(
				expect.objectContaining({
					RequestItems: {
						[DEFAULT_DYNAMO_TABLE]: testRecords.map((item) => ({
							DeleteRequest: {
								Key: {
									pk: item.pk,
									sk: item.sk,
								},
							},
						})),
					},
				})
			);
		});

		it('should handle unprocessed items', async () => {
			const unprocessedItems = {
				[DEFAULT_DYNAMO_TABLE]: [
					{
						DeleteRequest: {
							Key: testRecords[0],
						},
					},
				],
			};
			mockSend.mockResolvedValue({ UnprocessedItems: unprocessedItems });

			const result = await batchRemove({ records: testRecords });

			expect(result).toEqual([testRecords[0]]);
		});

		it('should handle batching of large record sets', async () => {
			const largeRecordSet = Array.from({ length: 30 }, (_, i) => ({
				pk: `pk${i}`,
				sk: `sk${i}`,
			}));
			mockSend.mockResolvedValue({ UnprocessedItems: {} });

			await batchRemove({ records: largeRecordSet });

			// Should make 2 calls for 30 items (25 + 5)
			expect(mockSend).toHaveBeenCalledTimes(2);
			const firstCall = mockSend.mock.calls[0][0];
			const secondCall = mockSend.mock.calls[1][0];

			expect(firstCall.RequestItems[DEFAULT_DYNAMO_TABLE]).toHaveLength(25);
			expect(secondCall.RequestItems[DEFAULT_DYNAMO_TABLE]).toHaveLength(5);
		});

		it('should handle errors during batch deletion', async () => {
			mockSend.mockRejectedValueOnce(new Error('Batch delete failed'));

			await expect(batchRemove({ records: testRecords })).rejects.toThrow(
				'Batch delete failed'
			);
		});
	});

	describe('batchGet', () => {
		const testKeys = [
			{ pk: 'pk1', sk: 'sk1' },
			{ pk: 'pk2', sk: 'sk2' },
			{ pk: 'pk3', sk: 'sk3' },
		];

		it('should call send with correct BatchGetCommand', async () => {
			const mockResponse = {
				Responses: {
					[DEFAULT_DYNAMO_TABLE]: [
						{ pk: 'pk1', sk: 'sk1', data: 'value1' },
						{ pk: 'pk2', sk: 'sk2', data: 'value2' },
						{ pk: 'pk3', sk: 'sk3', data: 'value3' },
					],
				},
			};
			mockSend.mockResolvedValue(mockResponse);

			const result = await batchGet({ keys: testKeys });

			expect(mockSend).toHaveBeenCalledWith(
				expect.objectContaining({
					RequestItems: {
						[DEFAULT_DYNAMO_TABLE]: {
							Keys: testKeys,
						},
					},
				})
			);
			expect(result).toEqual(mockResponse.Responses[DEFAULT_DYNAMO_TABLE]);
		});

		it('should handle unprocessed keys', async () => {
			const mockResponse = {
				Responses: {
					[DEFAULT_DYNAMO_TABLE]: [{ pk: 'pk1', sk: 'sk1', data: 'value1' }],
				},
				UnprocessedKeys: {
					[DEFAULT_DYNAMO_TABLE]: {
						Keys: [testKeys[1], testKeys[2]],
					},
				},
			};
			mockSend.mockResolvedValue(mockResponse);

			await batchGet({ keys: testKeys });

			expect(mockSend).toHaveBeenCalledWith(
				expect.objectContaining({
					RequestItems: {
						[DEFAULT_DYNAMO_TABLE]: {
							Keys: testKeys,
						},
					},
				})
			);
		});

		it('should handle batching of large key sets', async () => {
			const largeKeySet = Array.from({ length: 150 }, (_, i) => ({
				pk: `pk${i}`,
				sk: `sk${i}`,
			}));

			const mockResponse = {
				Responses: {
					[DEFAULT_DYNAMO_TABLE]: [{ pk: 'pk0', sk: 'sk0', data: 'value0' }],
				},
			};
			mockSend.mockResolvedValue(mockResponse);

			await batchGet({ keys: largeKeySet });

			expect(mockSend).toHaveBeenCalledTimes(2);
			const firstCall = mockSend.mock.calls[0][0];
			const secondCall = mockSend.mock.calls[1][0];

			expect(firstCall.RequestItems[DEFAULT_DYNAMO_TABLE].Keys).toHaveLength(100);
			expect(secondCall.RequestItems[DEFAULT_DYNAMO_TABLE].Keys).toHaveLength(50);
		});

		it('should handle errors during batch get', async () => {
			mockSend.mockRejectedValueOnce(new Error('Batch get failed'));

			await expect(batchGet({ keys: testKeys })).rejects.toThrow('Batch get failed');
		});
	});
});
