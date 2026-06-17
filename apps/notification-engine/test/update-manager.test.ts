import { UpdateManager } from '../src/services/update-manager';

const mockGet = jest.fn();
const mockExecuteInPipeline = jest.fn();
const mockGetAccountRisk = jest.fn();
const mockUpdateAccountRisk = jest.fn();
const mockBatchUpdateAccountRisk = jest.fn();
const mockGenerateAccountUpdateKey = jest.fn();

jest.mock('@backend/redis', () => ({
	Redis: jest.fn(() => ({
		get: mockGet,
		executeInPipeline: mockExecuteInPipeline,
	})),
	RiskRepository: jest.fn(() => ({
		batchUpdateAccountRisk: mockBatchUpdateAccountRisk,
		updateAccountRisk: mockUpdateAccountRisk,
		getAccountRisk: mockGetAccountRisk,
		generateAccountUpdateKey: mockGenerateAccountUpdateKey.mockImplementation(
			(userId: string) => `account:${userId}`
		),
	})),
}));

jest.mock('@backend/aggregator-api/src/schemas', () => ({
	depositSchema: {
		...jest.requireActual('@backend/aggregator-api/src/schemas').depositSchema,
		required: [],
	},
	fundingPaymentSchema: {
		...jest.requireActual('@backend/aggregator-api/src/schemas').fundingPaymentSchema,
		required: [],
	},
	liquidationSchema: {
		...jest.requireActual('@backend/aggregator-api/src/schemas').liquidationSchema,
		required: [],
	},
	orderActionSchema: {
		...jest.requireActual('@backend/aggregator-api/src/schemas').orderActionSchema,
		required: [],
	},
	orderSchema: {
		...jest.requireActual('@backend/aggregator-api/src/schemas').orderSchema,
		required: [],
	},
	settlePnlSchema: {
		...jest.requireActual('@backend/aggregator-api/src/schemas').settlePnlSchema,
		required: [],
	},
	swapSchema: {
		...jest.requireActual('@backend/aggregator-api/src/schemas').swapSchema,
		required: [],
	},
}));

const mockGetMessages = jest.fn();
const mockDeleteMessages = jest.fn();
jest.mock('@backend/sqs', () => ({
	SQS: jest.fn(() => ({
		getMessages: mockGetMessages,
		deleteMessages: mockDeleteMessages,
	})),
}));

const makeSqsMessage = (data: any) => ({
	MessageId: '1',
	ReceiptHandle: 'receipt1',
	Body: JSON.stringify({ data }),
});

describe('UpdateManager', () => {
	const { processMessage, processUserUpdates, processBatch, resetUserUpdateQueue } =
		UpdateManager({ isRunning: false });

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('processMessage', () => {
		test('handles messages without body', async () => {
			await processMessage({ MessageId: 'x', ReceiptHandle: 'y' } as any);
			await processUserUpdates();
			expect(mockExecuteInPipeline).not.toHaveBeenCalled();
		});

		test('adds messages to the queue', async () => {
			await processMessage(
				makeSqsMessage({
					user: { S: 'user1' },
					sk: { S: 'ORDER#1' },
					baseAssetAmount: { N: 0.2 },
				}) as any
			);

			await processMessage(
				makeSqsMessage({
					user: { S: 'user1' },
					sk: { S: 'ORDER#1' },
					baseAssetAmount: { N: 0.2 },
				}) as any
			);

			await processUserUpdates();

			const pipeline = { publish: jest.fn() } as any;
			mockExecuteInPipeline.mock.calls[0][0](pipeline);

			expect(mockGenerateAccountUpdateKey).toHaveBeenCalledWith('user1');
			expect(pipeline.publish).toHaveBeenCalledTimes(1);

			const [key, payload] = pipeline.publish.mock.calls[0];

			expect(key).toBe('account:user1');
			expect(JSON.parse(payload)).toEqual([
				{ user: 'user1', baseAssetAmount: '0.200000000', recordType: 'OrderRecord' },
				{ user: 'user1', baseAssetAmount: '0.200000000', recordType: 'OrderRecord' },
			]);
		});

		test('handles malformed message body', async () => {
			await processMessage({
				MessageId: 'bad1',
				ReceiptHandle: 'receipt-bad',
				Body: 'not valid json',
			} as any);

			await processUserUpdates();

			expect(mockExecuteInPipeline).not.toHaveBeenCalled();
		});
	});

	describe('processUserUpdates', () => {
		test('does nothing when queue is empty', async () => {
			resetUserUpdateQueue();
			await processUserUpdates();
			expect(mockExecuteInPipeline).not.toHaveBeenCalled();
		});

		test('groups updates by user and record type and applies serialization', async () => {
			await processMessage(
				makeSqsMessage({
					user: { S: 'alice' },
					sk: { S: 'ORDER#11' },
					foo: { N: 1 },
				}) as any
			);
			await processMessage(
				makeSqsMessage({
					user: { S: 'alice' },
					sk: { S: 'NOTHING#12' },
					bar: { N: 2 },
				}) as any
			);
			await processMessage(
				makeSqsMessage({
					user: { S: 'alice' },
					sk: { S: 'ORDER_ACTION#12' },
					oraclePrice: { N: 200.601 },
				}) as any
			);
			await processMessage(
				makeSqsMessage({
					user: { S: 'bob' },
					sk: { S: 'ORDER#13' },
					foo: { N: 3 },
				}) as any
			);

			await processUserUpdates();

			const pipeline = { publish: jest.fn() } as any;
			mockExecuteInPipeline.mock.calls[0][0](pipeline);

			expect(pipeline.publish).toHaveBeenNthCalledWith(
				1,
				'account:alice',
				JSON.stringify([
					{ user: 'alice', recordType: 'OrderRecord' },
					{ oraclePrice: '200.601000', user: 'alice', recordType: 'OrderActionRecord' },
				])
			);
			expect(pipeline.publish).toHaveBeenNthCalledWith(
				2,
				'account:bob',
				JSON.stringify([{ user: 'bob', recordType: 'OrderRecord' }])
			);
		});

		test('handles pipeline errors and re-queues updates', async () => {
			await processMessage(
				makeSqsMessage({
					user: { S: 'u1' },
					sk: { S: 'ORDER#1' },
					foo: { N: 9 },
				}) as any
			);

			mockExecuteInPipeline.mockRejectedValueOnce(new Error('Pipeline failed'));
			await processUserUpdates();

			const pipeline = { publish: jest.fn() } as any;
			mockExecuteInPipeline.mock.calls[0][0](pipeline);
			await processUserUpdates();

			expect(pipeline.publish).toHaveBeenCalledTimes(1);
		});

		test('ignores updates without user field', async () => {
			await processMessage(
				makeSqsMessage({
					sk: { S: 'ORDER#x' },
					foo: { N: 0 },
				}) as any
			);

			await processUserUpdates();
			expect(mockExecuteInPipeline).not.toHaveBeenCalled();
		});

		test('batches multiple record types for same user', async () => {
			const userId = '9qD4nu8BHktScBXcTuVCh5AEbn4ur2Hun2bSDXheH92S';

			await processMessage(
				makeSqsMessage({
					user: { S: userId },
					sk: { S: 'FUNDING_PAYMENT#TS#1761620460#SLOT#376270574#SIG#test#INDEX#00003' },
					fundingPayment: { N: 0.000136 },
					marketIndex: { N: 0 },
				}) as any
			);

			await processMessage(
				makeSqsMessage({
					user: { S: userId },
					sk: { S: 'ORDER#TYPE#PERP#TS#1761620460#ID#179' },
					orderId: { N: 179 },
					status: { S: 'open' },
				}) as any
			);

			await processMessage(
				makeSqsMessage({
					user: { S: userId },
					sk: { S: 'ORDER_ACTION#TS#1761620460#SLOT#376270574#SIG#test#INDEX#00000' },
					action: { S: 'place' },
					userOrderId: { N: 179 },
				}) as any
			);

			await processUserUpdates();

			const pipeline = { publish: jest.fn() } as any;
			mockExecuteInPipeline.mock.calls[0][0](pipeline);

			expect(pipeline.publish).toHaveBeenCalledTimes(1);
			expect(pipeline.publish).toHaveBeenCalledWith(
				'account:9qD4nu8BHktScBXcTuVCh5AEbn4ur2Hun2bSDXheH92S',
				'[{"user":"9qD4nu8BHktScBXcTuVCh5AEbn4ur2Hun2bSDXheH92S","marketIndex":0,"fundingPayment":"0.000136","recordType":"FundingPaymentRecord"},{"user":"9qD4nu8BHktScBXcTuVCh5AEbn4ur2Hun2bSDXheH92S","status":"open","orderId":179,"recordType":"OrderRecord"},{"action":"place","user":"9qD4nu8BHktScBXcTuVCh5AEbn4ur2Hun2bSDXheH92S","recordType":"OrderActionRecord"}]'
			);
		});
	});

	describe('processBatch / processParallelBatches', () => {
		test('handles empty message queue', async () => {
			mockGetMessages.mockResolvedValue([]);
			await processBatch();
			expect(mockDeleteMessages).not.toHaveBeenCalled();
		});

		test('processes a batch and deletes messages', async () => {
			const m1: any = makeSqsMessage({
				user: { S: 'u1' },
				sk: 'ORDER#1',
				foo: { N: 1 },
			});
			const m2: any = makeSqsMessage({
				user: { S: 'u2' },
				sk: 'LIQUIDATION#2',
				bar: { N: 2 },
			});
			mockGetMessages.mockResolvedValue([m1, m2]);
			mockDeleteMessages.mockResolvedValue([]);

			await processBatch();

			expect(mockDeleteMessages).toHaveBeenCalledWith([
				{ Id: '1', ReceiptHandle: 'receipt1' },
				{ Id: '1', ReceiptHandle: 'receipt1' },
			]);
		});
	});
});
