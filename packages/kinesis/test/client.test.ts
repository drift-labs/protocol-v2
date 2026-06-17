import {
	GetRecordsCommand,
	GetShardIteratorCommand,
	PutRecordCommand,
	PutRecordsCommand,
	ShardIteratorType,
} from '@aws-sdk/client-kinesis';
import { DEFAULT_KINESIS_STREAM, batchArray } from '@backend/common';
import { Kinesis } from '../src/client';

jest.mock('@aws-sdk/util-retry');

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-kinesis', () => ({
	KinesisClient: jest.fn().mockImplementation(() => ({
		send: (params: any) => mockSend(params),
	})),
	PutRecordCommand: jest.fn().mockImplementation((values) => values),
	PutRecordsCommand: jest.fn().mockImplementation((values) => values),
	GetShardIteratorCommand: jest.fn().mockImplementation((values) => values),
	GetRecordsCommand: jest.fn().mockImplementation((values) => values),
	ShardIteratorType: {
		AT_SEQUENCE_NUMBER: 'AT_SEQUENCE_NUMBER',
	},
}));

jest.mock('@backend/common', () => ({
	...jest.requireActual('@backend/common'),
	batchArray: jest.fn(),
}));

describe('Kinesis', () => {
	const { putRecord, putRecords, getRecordsFromSequence, decodeKinesisData } = Kinesis();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('putRecord', () => {
		it('should call send with correct PutRecordCommand', async () => {
			const testData = 'testData';
			const testPartitionKey = 'testPartitionKey';

			await putRecord({ data: testData, partitionKey: testPartitionKey });

			expect(PutRecordCommand).toHaveBeenCalledWith({
				StreamName: DEFAULT_KINESIS_STREAM,
				Data: Buffer.from(testData),
				PartitionKey: testPartitionKey,
			});
		});
	});

	describe('putRecords', () => {
		const testRecords = [
			{ Data: Buffer.from('test1'), PartitionKey: 'key1' },
			{ Data: Buffer.from('test2'), PartitionKey: 'key2' },
			{ Data: Buffer.from('test3'), PartitionKey: 'key3' },
		];

		beforeEach(() => {
			(batchArray as jest.Mock).mockReturnValue([testRecords]);
			mockSend.mockResolvedValue({ FailedRecordCount: 1 });
		});

		it('should call batchArray with correct parameters', async () => {
			await putRecords(testRecords);
			expect(batchArray).toHaveBeenCalledWith(testRecords, 500);
		});

		it('should call send with correct PutRecordsCommand', async () => {
			mockSend.mockResolvedValue({ FailedRecordCount: 0 });
			await putRecords(testRecords);
			expect(PutRecordsCommand).toHaveBeenCalledWith({
				StreamName: DEFAULT_KINESIS_STREAM,
				Records: testRecords,
			});
			expect(mockSend).toHaveBeenCalled();
		});

		it('should return the correct failed count', async () => {
			mockSend.mockResolvedValue({ FailedRecordCount: 1 });
			const result = await putRecords(testRecords);
			expect(result).toEqual({ failedCount: 1 });
		});

		it('should handle errors', async () => {
			const testError = new Error('Test error');
			mockSend.mockRejectedValue(testError);
			await expect(putRecords(testRecords)).rejects.toThrow('Test error');
		});
	});

	describe('getRecordsFromSequence', () => {
		const testParams = {
			shardId: 'testShardId',
			startSequenceNumber: 'startSeq123',
			endSequenceNumber: 'endSeq456',
			limit: 100,
		};

		const mockRecord = {
			Data: Buffer.from(JSON.stringify({ testKey: 'testValue' })),
			SequenceNumber: 'seq123',
		};

		it('should get shard iterator and fetch records', async () => {
			mockSend.mockResolvedValueOnce({
				ShardIterator: 'testIterator',
			});

			mockSend.mockResolvedValueOnce({
				Records: [mockRecord],
				NextShardIterator: null,
			});

			const result = await getRecordsFromSequence(testParams);

			expect(GetShardIteratorCommand).toHaveBeenCalledWith({
				StreamName: DEFAULT_KINESIS_STREAM,
				ShardId: testParams.shardId,
				ShardIteratorType: ShardIteratorType.AT_SEQUENCE_NUMBER,
				StartingSequenceNumber: testParams.startSequenceNumber,
			});

			expect(GetRecordsCommand).toHaveBeenCalledWith({
				ShardIterator: 'testIterator',
				Limit: testParams.limit,
			});

			expect(result).toEqual([{ testKey: 'testValue' }]);
		});

		it('should handle multiple batches until end sequence', async () => {
			const middleRecord = { ...mockRecord, SequenceNumber: 'middleSeq' };
			const endRecord = { ...mockRecord, SequenceNumber: testParams.endSequenceNumber };

			mockSend
				.mockResolvedValueOnce({ ShardIterator: 'testIterator' })
				.mockResolvedValueOnce({
					Records: [middleRecord],
					NextShardIterator: 'nextIterator',
				})
				.mockResolvedValueOnce({
					Records: [endRecord],
					NextShardIterator: 'finalIterator',
				});

			await getRecordsFromSequence(testParams);

			expect(GetRecordsCommand).toHaveBeenCalledTimes(2);
		});

		it('should handle failed shard iterator', async () => {
			mockSend.mockResolvedValueOnce({ ShardIterator: null });

			await expect(getRecordsFromSequence(testParams)).rejects.toThrow(
				'Failed to get shard iterator'
			);
		});

		it('should handle decode errors', async () => {
			const invalidRecord = {
				Data: Buffer.from('invalid json'),
				SequenceNumber: 'seq123',
			};

			mockSend
				.mockResolvedValueOnce({ ShardIterator: 'testIterator' })
				.mockResolvedValueOnce({
					Records: [invalidRecord],
					NextShardIterator: null,
				});

			const result = await getRecordsFromSequence(testParams);
			expect(result).toEqual([]);
		});

		it('should handle empty records response', async () => {
			mockSend
				.mockResolvedValueOnce({ ShardIterator: 'testIterator' })
				.mockResolvedValueOnce({
					Records: [],
					NextShardIterator: 'nextIterator',
				});

			const result = await getRecordsFromSequence(testParams);
			expect(result).toEqual([]);
		});

		describe('decodeKinesisData', () => {
			it('should decode valid JSON data', () => {
				const testData = { test: 'value' };
				const record = {
					Data: Buffer.from(JSON.stringify(testData)),
				};

				const result = decodeKinesisData(record);
				expect(result).toEqual(testData);
			});
		});
	});
});
