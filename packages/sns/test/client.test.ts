import { PublishBatchCommand, PublishCommand } from '@aws-sdk/client-sns';
import { SNS } from '../src/client';

jest.mock('@aws-sdk/util-retry');

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-sns', () => ({
	SNSClient: jest.fn().mockImplementation(() => ({
		send: (params: any) => mockSend(params),
	})),
	PublishBatchCommand: jest.fn().mockImplementation((values) => values),
	PublishCommand: jest.fn().mockImplementation((values) => values),
	CreateTopicCommand: jest.fn().mockImplementation((values) => values),
	SubscribeCommand: jest.fn().mockImplementation((values) => values),
	UnsubscribeCommand: jest.fn().mockImplementation((values) => values),
	ListSubscriptionsByTopicCommand: jest.fn().mockImplementation((values) => values),
}));

describe('SNS', () => {
	const { publishMessages, publishMessage } = SNS();
	const TEST_TOPIC_ARN = 'arn:aws:sns:region:account:topic';

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('publishMessages', () => {
		const testRecords = [
			{ Message: JSON.stringify('test1'), Id: 'key1' },
			{ Message: JSON.stringify('test2'), Id: 'key2' },
			{ Message: JSON.stringify('test3'), Id: 'key3' },
		];

		beforeEach(() => {
			mockSend.mockResolvedValue({ Failed: [{ test: 123 }] });
		});

		it('should call send with correct PublishBatchCommand', async () => {
			await publishMessages({ records: testRecords, topicArn: TEST_TOPIC_ARN });

			expect(PublishBatchCommand).toHaveBeenCalledWith({
				TopicArn: TEST_TOPIC_ARN,
				PublishBatchRequestEntries: testRecords,
			});
			expect(mockSend).toHaveBeenCalled();
		});

		it('should return the correct failed count', async () => {
			const result = await publishMessages({
				records: testRecords,
				topicArn: TEST_TOPIC_ARN,
			});
			expect(result).toEqual({ failedCount: 1 });
		});

		it('should handle errors', async () => {
			const testError = new Error('Test error');
			mockSend.mockRejectedValue(testError);
			await expect(
				publishMessages({ records: testRecords, topicArn: TEST_TOPIC_ARN })
			).rejects.toThrow('Test error');
		});
	});

	describe('publishMessage', () => {
		const testMessage = {
			message: 'test message',
			topicArn: TEST_TOPIC_ARN,
			subject: 'Test Subject',
			messageAttributes: {
				testAttr: {
					DataType: 'String',
					StringValue: 'test value',
				},
			},
		};

		it('should call send with correct PublishCommand', async () => {
			mockSend.mockResolvedValue({ MessageId: 'test-message-id' });

			await publishMessage(testMessage);

			expect(PublishCommand).toHaveBeenCalledWith({
				TopicArn: TEST_TOPIC_ARN,
				Message: testMessage.message,
				Subject: testMessage.subject,
				MessageAttributes: testMessage.messageAttributes,
			});
		});

		it('should handle errors', async () => {
			const testError = new Error('Test error');
			mockSend.mockRejectedValue(testError);
			await expect(publishMessage(testMessage)).rejects.toThrow('Test error');
		});
	});
});
