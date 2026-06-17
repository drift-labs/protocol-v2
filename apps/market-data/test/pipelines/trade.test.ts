import { TradeRecord } from '@backend/common';

const mockGetMessages = jest.fn();
const mockDeleteMessages = jest.fn();
const mockProcessLeaderboard = jest.fn();
const mockProcessVolume = jest.fn();

jest.doMock('@backend/sqs', () => ({
	SQS: () => ({
		getMessages: mockGetMessages,
		deleteMessages: mockDeleteMessages,
	}),
}));

jest.doMock('@backend/common', () => {
	const actual = jest.requireActual('@backend/common');
	return {
		...actual,
		parseSQSMessageFromDynamoEvent: jest
			.fn()
			.mockResolvedValueOnce({
				symbol: 'SOL-PERP',
				fillRecordId: 'tx-123',
				baseAssetAmountFilled: 1,
				quoteAssetAmountFilled: 100,
				ts: 1234567890,
			})
			.mockResolvedValueOnce({
				symbol: 'SOL-PERP',
				fillRecordId: 'tx-123',
				baseAssetAmountFilled: 1,
				quoteAssetAmountFilled: 100,
				ts: 1234567890,
			})
			.mockResolvedValueOnce(undefined),
	};
});

jest.doMock('../../src/tasks/leaderboard', () => ({
	processLeaderboard: jest.fn((trade) => mockProcessLeaderboard(trade)),
	takeLeaderboardSnapshot: jest.fn(),
}));

jest.doMock('../../src/tasks/volume', () => ({
	processVolume: jest.fn((trade) => mockProcessVolume(trade)),
	publishRollingVolumes: jest.fn(),
}));

describe('processTradePipeline', () => {
	let processTradePipeline: any;
	let processBatch: any;

	beforeAll(async () => {
		const module = await import('../../src/pipelines/trade');
		processTradePipeline = module.processTradePipeline;
		processBatch = module.processBatch;
	});

	beforeEach(() => {
		jest.clearAllMocks();
	});

	const mockTrade: TradeRecord = {
		symbol: 'SOL-PERP',
		fillRecordId: 'tx-123',
		baseAssetAmountFilled: 1,
		quoteAssetAmountFilled: 100,
		ts: 1234567890,
	} as any;

	it('should run all steps successfully', async () => {
		mockProcessLeaderboard.mockResolvedValue(undefined);
		mockProcessVolume.mockResolvedValue(undefined);

		await expect(processTradePipeline(mockTrade)).resolves.not.toThrow();
		expect(mockProcessLeaderboard).toHaveBeenCalledWith(mockTrade);
		expect(mockProcessVolume).toHaveBeenCalledWith(mockTrade);
	});

	it('should throw if all steps fail', async () => {
		mockProcessLeaderboard.mockRejectedValue(new Error('fail'));
		mockProcessVolume.mockRejectedValue(new Error('fail'));

		await expect(processTradePipeline(mockTrade)).rejects.toThrow('All pipeline steps failed');
	});
});

describe('processBatch', () => {
	let processBatch: any;

	beforeAll(async () => {
		const module = await import('../../src/pipelines/trade');
		processBatch = module.processBatch;
	});

	beforeEach(() => {
		jest.clearAllMocks();
	});

	const createMockMessage = (id: string) => ({
		MessageId: id,
		ReceiptHandle: `handle-${id}`,
		Body: `mock-body-${id}`,
	});

	it('should process messages and delete successful ones', async () => {
		mockGetMessages.mockResolvedValue([createMockMessage('1'), createMockMessage('2')]);
		mockDeleteMessages.mockResolvedValue([]);
		mockProcessLeaderboard.mockResolvedValue(undefined);
		mockProcessVolume.mockResolvedValue(undefined);

		await processBatch();

		expect(mockDeleteMessages).toHaveBeenCalledWith([
			{ Id: '1', ReceiptHandle: 'handle-1' },
			{ Id: '2', ReceiptHandle: 'handle-2' },
		]);
	});

	it('should handle delete failures with backoff', async () => {
		mockGetMessages.mockResolvedValue([createMockMessage('1')]);
		mockProcessLeaderboard.mockResolvedValue(undefined);
		mockProcessVolume.mockResolvedValue(undefined);

		mockDeleteMessages
			.mockResolvedValueOnce([{ Id: '1', ReceiptHandle: 'handle-1' }])
			.mockResolvedValueOnce([{ Id: '1', ReceiptHandle: 'handle-1' }])
			.mockResolvedValueOnce([]);

		await processBatch();

		expect(mockDeleteMessages).toHaveBeenCalledTimes(3);
	});

	it('should handle pipeline errors per message', async () => {
		mockGetMessages.mockResolvedValueOnce([createMockMessage('err')]);
		mockProcessLeaderboard.mockRejectedValueOnce(new Error('fail'));
		mockProcessVolume.mockRejectedValueOnce(new Error('fail'));

		await processBatch();

		expect(mockDeleteMessages).not.toHaveBeenCalled();
	});
});
