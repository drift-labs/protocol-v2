import {
	DeleteMessageBatchCommand,
	ReceiveMessageCommand,
	SendMessageBatchCommand,
} from '@aws-sdk/client-sqs';
import { DEFAULT_SQS_QUEUE } from '@backend/common';
import { SQS } from '../src/client';

jest.mock('@aws-sdk/util-retry');

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-sqs', () => ({
	SQSClient: jest.fn().mockImplementation(() => ({
		send: (params: any) => mockSend(params),
	})),
	SendMessageBatchCommand: jest.fn().mockImplementation((values) => values),
	ReceiveMessageCommand: jest.fn().mockImplementation((values) => values),
	DeleteMessageBatchCommand: jest.fn().mockImplementation((values) => values),
}));

describe('SQS', () => {
	const { putMessages, getMessages, deleteMessages } = SQS();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('putMessages', () => {
		const testRecords = [
			{ MessageBody: JSON.stringify('test1'), Id: 'key1' },
			{ MessageBody: JSON.stringify('test2'), Id: 'key2' },
			{ MessageBody: JSON.stringify('test3'), Id: 'key3' },
		];

		beforeEach(() => {
			mockSend.mockResolvedValue({ Failed: [{ test: 123 }] });
		});

		it('should call send with correct SendMessagesCommand', async () => {
			mockSend.mockResolvedValue({ Failed: [{ test: 123 }] });
			await putMessages({ records: testRecords });
			expect(SendMessageBatchCommand).toHaveBeenCalledWith({
				QueueUrl: DEFAULT_SQS_QUEUE,
				Entries: testRecords,
			});
			expect(mockSend).toHaveBeenCalled();
		});

		it('should return the correct failed count', async () => {
			mockSend.mockResolvedValue({ Failed: [{ test: 123 }] });
			const result = await putMessages({ records: testRecords });
			expect(result).toEqual({ failedCount: 1 });
		});

		it('should handle errors', async () => {
			const testError = new Error('Test error');
			mockSend.mockRejectedValue(testError);
			await expect(putMessages({ records: testRecords })).rejects.toThrow('Test error');
		});
	});

	describe('getMessages', () => {
		const mockMessages = [
			{ MessageId: '1', Body: 'test1' },
			{ MessageId: '2', Body: 'test2' },
		];

		it('should use default options when none provided', async () => {
			mockSend.mockResolvedValue({ Messages: mockMessages });

			await getMessages();

			expect(ReceiveMessageCommand).toHaveBeenCalledWith({
				QueueUrl: DEFAULT_SQS_QUEUE,
				MaxNumberOfMessages: 10,
				WaitTimeSeconds: 20,
				VisibilityTimeout: 30,
				MessageSystemAttributeNames: ['ApproximateReceiveCount'],
			});
		});

		it('should use provided options', async () => {
			mockSend.mockResolvedValue({ Messages: mockMessages });

			await getMessages({
				maxMessages: 5,
				waitTimeSeconds: 10,
				visibilityTimeout: 15,
			});

			expect(ReceiveMessageCommand).toHaveBeenCalledWith({
				QueueUrl: DEFAULT_SQS_QUEUE,
				MaxNumberOfMessages: 5,
				WaitTimeSeconds: 10,
				VisibilityTimeout: 15,
				MessageSystemAttributeNames: ['ApproximateReceiveCount'],
			});
		});

		it('should return empty array when no messages', async () => {
			mockSend.mockResolvedValue({});
			const result = await getMessages();
			expect(result).toEqual([]);
		});

		it('should log and throw error on failure', async () => {
			const error = new Error('Test error');
			mockSend.mockRejectedValue(error);

			await expect(getMessages()).rejects.toThrow('Test error');
		});
	});

	describe('deleteMessages', () => {
		const mockEntries = [
			{ Id: '1', ReceiptHandle: 'receipt1' },
			{ Id: '2', ReceiptHandle: 'receipt2' },
		];

		it('should delete messages successfully', async () => {
			mockSend.mockResolvedValue({
				Successful: [{ Id: '1' }, { Id: '2' }],
				Failed: [],
			});

			await deleteMessages(mockEntries);

			expect(DeleteMessageBatchCommand).toHaveBeenCalledWith({
				QueueUrl: DEFAULT_SQS_QUEUE,
				Entries: mockEntries,
			});
		});

		it('should log and throw error on failure', async () => {
			const error = new Error('Test error');
			mockSend.mockRejectedValue(error);
			await expect(deleteMessages(mockEntries)).rejects.toThrow('Test error');
		});
	});
});
