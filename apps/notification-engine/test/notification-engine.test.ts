import { NotificationType } from '@backend/common';
import { SQSEvent } from 'aws-lambda';
import { handler } from '../src';

// Mock all processors
const mockProcessPriceUpdate = jest.fn();
const mockProcessAccount = jest.fn();
const mockProcessRecord = jest.fn();

jest.mock('../src/processors/price-processor', () => ({
	PriceProcessor: () => ({
		processPriceUpdate: mockProcessPriceUpdate,
	}),
}));

jest.mock('../src/processors/account-processor', () => ({
	AccountProcessor: () => ({
		processAccount: mockProcessAccount,
	}),
}));

jest.mock('../src/processors/record-processor', () => ({
	RecordProcessor: () => ({
		processRecord: mockProcessRecord,
	}),
}));

describe('Notification engine', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	const createSQSEvent = (messages: any[]): SQSEvent => ({
		Records: messages.map((message, index) => ({
			messageId: `msg-${index}`,
			body: JSON.stringify({
				Message: JSON.stringify(message),
			}),
			receiptHandle: ``,
			attributes: {
				ApproximateReceiveCount: '1',
				SentTimestamp: '',
				SenderId: '',
				ApproximateFirstReceiveTimestamp: '',
			},
			messageAttributes: {},
			md5OfBody: '',
			eventSource: '',
			eventSourceARN: '',
			awsRegion: '',
		})),
	});

	describe('successful message processing', () => {
		it('should process price alert messages', async () => {
			const message = {
				type: NotificationType.PRICE_ALERT,
				data: { price: 100 },
			};

			const event = createSQSEvent([message]);
			const result = await handler(event);

			expect(mockProcessPriceUpdate).toHaveBeenCalledWith({ price: 100 });
			expect(result.batchItemFailures).toHaveLength(0);
		});

		it('should process record update messages', async () => {
			const message = {
				type: NotificationType.RECORD_UPDATE,
				data: { recordId: { S: '123' } },
			};

			const event = createSQSEvent([message]);
			const result = await handler(event);

			expect(mockProcessRecord).toHaveBeenCalledWith({ recordId: '123' });
			expect(result.batchItemFailures).toHaveLength(0);
		});

		it('should process account update messages', async () => {
			const message = {
				type: NotificationType.ACCOUNT_UPDATE,
				data: { accountId: '123' },
			};

			const event = createSQSEvent([message]);
			const result = await handler(event);

			expect(mockProcessAccount).toHaveBeenCalledWith({ accountId: '123' });
			expect(result.batchItemFailures).toHaveLength(0);
		});

		it('should process multiple messages in batch successfully', async () => {
			const messages = [
				{
					type: NotificationType.PRICE_ALERT,
					data: { price: 100 },
				},
				{
					type: NotificationType.ACCOUNT_UPDATE,
					data: { accountId: '123' },
				},
			];

			const event = createSQSEvent(messages);
			const result = await handler(event);

			expect(mockProcessPriceUpdate).toHaveBeenCalledWith({ price: 100 });
			expect(mockProcessAccount).toHaveBeenCalledWith({ accountId: '123' });
			expect(result.batchItemFailures).toHaveLength(0);
		});
	});

	describe('error handling and retries', () => {
		it('should handle invalid message format', async () => {
			const event = {
				Records: [
					{
						messageId: 'msg-0',
						body: 'invalid-json',
						receiptHandle: 'receipt-0',
						attributes: {
							ApproximateReceiveCount: '1',
							SentTimestamp: '',
							SenderId: '',
							ApproximateFirstReceiveTimestamp: '',
						},
						messageAttributes: {},
						md5OfBody: '',
						eventSource: '',
						eventSourceARN: '',
						awsRegion: '',
					},
				],
			};

			const result = await handler(event as SQSEvent);
			expect(result.batchItemFailures).toHaveLength(1);
			expect(result.batchItemFailures[0].itemIdentifier).toBe('msg-0');
		});

		it('should handle unsupported message type', async () => {
			const message = {
				type: 'UNSUPPORTED_TYPE',
				data: {},
			};

			const event = createSQSEvent([message]);
			const result = await handler(event);

			expect(result.batchItemFailures).toHaveLength(1);
			expect(result.batchItemFailures[0].itemIdentifier).toBe('msg-0');
		});

		it('should handle processor errors and mark for retry', async () => {
			mockProcessPriceUpdate.mockRejectedValue(new Error('Processing failed'));

			const message = {
				type: NotificationType.PRICE_ALERT,
				data: { price: 100 },
			};

			const event = createSQSEvent([message]);
			const result = await handler(event);

			expect(result.batchItemFailures).toHaveLength(1);
			expect(result.batchItemFailures[0].itemIdentifier).toBe('msg-0');
		});

		it('should handle partial batch failures', async () => {
			mockProcessPriceUpdate.mockResolvedValue(undefined);
			mockProcessAccount.mockRejectedValue(new Error('Processing failed'));

			const messages = [
				{
					type: NotificationType.PRICE_ALERT,
					data: { price: 100 },
				},
				{
					type: NotificationType.ACCOUNT_UPDATE,
					data: { accountId: '123' },
				},
			];

			const event = createSQSEvent(messages);
			const result = await handler(event);

			expect(result.batchItemFailures).toHaveLength(1);
			expect(result.batchItemFailures[0].itemIdentifier).toBe('msg-1');
		});

		it('should handle missing message type', async () => {
			const message = {
				data: { price: 100 },
			};

			const event = createSQSEvent([message]);
			const result = await handler(event);

			expect(result.batchItemFailures).toHaveLength(1);
			expect(result.batchItemFailures[0].itemIdentifier).toBe('msg-0');
		});
	});
});
