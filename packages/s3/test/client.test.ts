import { DEFAULT_S3_BUCKET } from '@backend/common';
import { S3 } from '../src/client';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
	S3Client: jest.fn().mockImplementation(() => ({
		send: (params: any) => mockSend(params),
	})),
	ListObjectsV2Command: jest.fn().mockImplementation((values) => {
		return values;
	}),
	GetObjectCommand: jest.fn().mockImplementation((values) => {
		return values;
	}),
	PutObjectCommand: jest.fn().mockImplementation((values) => {
		return values;
	}),
	CreateMultipartUploadCommand: jest.fn().mockImplementation((values) => {
		return values;
	}),
	UploadPartCommand: jest.fn().mockImplementation((values) => {
		return values;
	}),
	CompleteMultipartUploadCommand: jest.fn().mockImplementation((values) => {
		return values;
	}),
	AbortMultipartUploadCommand: jest.fn().mockImplementation((values) => {
		return values;
	}),
	CopyObjectCommand: jest.fn().mockImplementation((values) => {
		return values;
	}),
	DeleteObjectCommand: jest.fn().mockImplementation((values) => {
		return values;
	}),
}));

jest.mock('zlib', () => {
	return {
		...jest.requireActual('zlib'),
		createGzip: jest.fn(() => {
			const { PassThrough } = jest.requireActual('stream');
			return new PassThrough();
		}),
		gunzip: jest.fn((input, callback) => {
			callback(null, input);
		}),
		gzip: jest.fn((input, callback) => {
			callback(null, Buffer.from(input));
		}),
	};
});

describe('S3', () => {
	const { listObjects, getObject, putObject, putObjectStream, moveObject, processFiles } = S3();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('listObjects', () => {
		it('should list objects and filter out zero-size objects', async () => {
			const mockContents = [
				{ Key: 'file1', Size: 100 },
				{ Key: 'file2', Size: 0 },
				{ Key: 'file3', Size: 200 },
			];
			mockSend.mockResolvedValueOnce({ Contents: mockContents });

			const result = await listObjects('prefix');

			expect(mockSend).toHaveBeenCalledWith({
				Bucket: DEFAULT_S3_BUCKET,
				Prefix: 'prefix',
			});

			expect(result).toEqual([
				{ Key: 'file1', Size: 100 },
				{ Key: 'file3', Size: 200 },
			]);
		});
	});

	describe('getObject', () => {
		it('should get and decompress an object', async () => {
			mockSend.mockResolvedValueOnce({
				Body: {
					transformToByteArray: jest.fn().mockResolvedValue(Buffer.from('compressed')),
				},
			});

			const result = await getObject('key');

			expect(mockSend).toHaveBeenCalledWith({
				Bucket: DEFAULT_S3_BUCKET,
				Key: 'key',
			});
			expect(result).toBe('compressed');
		});

		it('should throw an error if the response body is missing', async () => {
			mockSend.mockResolvedValueOnce({});
			await expect(getObject('key')).rejects.toThrow('No body in response for key: key');
		});
	});

	describe('putObject', () => {
		it('should compress and put an object', async () => {
			await putObject('key', 'content');

			expect(mockSend).toHaveBeenCalledWith({
				Bucket: DEFAULT_S3_BUCKET,
				Key: 'key',
				Body: Buffer.from('content'),
			});
		});
	});

	describe('putObjectStream', () => {
		it('should stream and put an object', async () => {
			mockSend
				.mockResolvedValueOnce({ UploadId: 'upload-id' })
				.mockResolvedValueOnce({ ETag: 'etag-1' })
				.mockResolvedValueOnce({});

			await putObjectStream('key', async (stream) => {
				stream.write('content');
			});

			expect(mockSend).toHaveBeenCalledTimes(3);
			expect(mockSend.mock.calls[0][0]).toEqual({
				Bucket: DEFAULT_S3_BUCKET,
				Key: 'key',
			});
			expect(mockSend.mock.calls[1][0]).toEqual({
				Bucket: DEFAULT_S3_BUCKET,
				Key: 'key',
				UploadId: 'upload-id',
				PartNumber: 1,
				Body: Buffer.from('content'),
				ContentLength: Buffer.from('content').length,
			});
			expect(mockSend.mock.calls[2][0]).toEqual({
				Bucket: DEFAULT_S3_BUCKET,
				Key: 'key',
				UploadId: 'upload-id',
				MultipartUpload: {
					Parts: [{ ETag: 'etag-1', PartNumber: 1 }],
				},
			});
		});
	});

	describe('moveObject', () => {
		it('should copy and delete an object', async () => {
			await moveObject('sourceKey', 'destinationKey');

			expect(mockSend).toHaveBeenCalledTimes(2);
			expect(mockSend).toHaveBeenNthCalledWith(1, {
				Bucket: DEFAULT_S3_BUCKET,
				CopySource: `${DEFAULT_S3_BUCKET}/sourceKey`,
				Key: 'destinationKey',
			});
			expect(mockSend).toHaveBeenNthCalledWith(2, {
				Bucket: DEFAULT_S3_BUCKET,
				Key: 'sourceKey',
			});
		});

		it('should handle errors when moving an object', async () => {
			const error = new Error('Move error');
			mockSend.mockRejectedValueOnce(error);

			await expect(moveObject('sourceKey', 'destinationKey')).rejects.toThrow('Move error');
		});
	});

	describe('processFiles', () => {
		it('should process files and move them', async () => {
			mockSend
				.mockResolvedValueOnce({
					Contents: [
						{ Key: 'unprocessed/file1', Size: 100 },
						{ Key: 'unprocessed/file2', Size: 200 },
					],
				})
				// file1
				.mockResolvedValueOnce({
					Body: { transformToByteArray: async () => Buffer.from('content1') },
				})
				.mockResolvedValueOnce({})
				.mockResolvedValueOnce({})
				// file2
				.mockResolvedValueOnce({
					Body: { transformToByteArray: async () => Buffer.from('content2') },
				})
				.mockResolvedValueOnce({})
				.mockResolvedValueOnce({});

			const mockProcessor = jest.fn().mockResolvedValue([]);

			await processFiles('unprocessed/', 'processed/', mockProcessor);

			expect(mockSend).toHaveBeenNthCalledWith(1, {
				Bucket: DEFAULT_S3_BUCKET,
				Prefix: 'unprocessed/',
			});

			expect(mockSend).toHaveBeenNthCalledWith(2, {
				Bucket: DEFAULT_S3_BUCKET,
				Key: 'unprocessed/file1',
			});

			expect(mockProcessor).toHaveBeenCalledTimes(2);
			expect(mockProcessor).toHaveBeenNthCalledWith(1, 'content1', 'unprocessed/file1');
			expect(mockProcessor).toHaveBeenNthCalledWith(2, 'content2', 'unprocessed/file2');

			expect(mockSend).toHaveBeenNthCalledWith(3, {
				Bucket: DEFAULT_S3_BUCKET,
				CopySource: `${DEFAULT_S3_BUCKET}/unprocessed/file1`,
				Key: 'processed/file1',
			});
			expect(mockSend).toHaveBeenNthCalledWith(4, {
				Bucket: DEFAULT_S3_BUCKET,
				Key: 'unprocessed/file1',
			});

			expect(mockSend).toHaveBeenCalledTimes(7);
		});
	});
});
