import { main } from '../src';

jest.mock('../src/services/health');

const mockIngestion = {
	ingestionIsPaused: jest.fn(),
	getSlotAtBlockchainTip: jest.fn(),
	incrementSlot: jest.fn(),
	processSlotWithBackoff: jest.fn(),
	shouldProcessSlot: jest.fn(),
	shutdown: jest.fn(),
};
jest.mock('../src/services/ingestion', () => {
	return {
		Ingestion: () => mockIngestion,
	};
});

const mockGetState = jest.fn();
jest.mock('@backend/dynamodb', () => {
	return {
		RealTimeArchiverRepository: () => {
			return {
				getState: mockGetState,
			};
		},
	};
});

describe('Ingestion', () => {
	beforeEach(() => {
		jest.useFakeTimers();
		jest.spyOn(process, 'exit').mockImplementation();
		process.env.INGESTION_ID = 'test-id';
		process.env.ENDPOINT = 'test-endpoint';
	});

	afterEach(() => {
		jest.clearAllTimers();
	});

	it('should throw an error if INGESTION_ID is not defined', async () => {
		delete process.env.INGESTION_ID;
		await expect(main()).rejects.toThrow('INGESTION_ID is not defined');
	});

	it('should throw an error if unable to retrieve state', async () => {
		mockGetState.mockResolvedValue(null);
		await expect(main()).rejects.toThrow('Unable to retrieve state for test-id');
	});

	it('should set up the interval and process slots', async () => {
		mockGetState.mockResolvedValue({ currentSlot: 100, shardId: 0, shards: 1 });
		mockIngestion.ingestionIsPaused.mockReturnValue(false);
		mockIngestion.shouldProcessSlot.mockReturnValue(true);

		await main();

		jest.advanceTimersByTime(500);
		await Promise.resolve();

		expect(mockIngestion.getSlotAtBlockchainTip).toHaveBeenCalled();
		expect(mockIngestion.shouldProcessSlot).toHaveBeenCalledWith(100);
		expect(mockIngestion.processSlotWithBackoff).toHaveBeenCalledWith(100);
		expect(mockIngestion.incrementSlot).toHaveBeenCalled();
	});

	it('should skip processing if ingestion is paused', async () => {
		mockGetState.mockResolvedValue({ currentSlot: 100, shardId: 1 });
		mockIngestion.ingestionIsPaused.mockReturnValue(true);

		await main();

		jest.advanceTimersByTime(500);
		await Promise.resolve();

		expect(mockIngestion.processSlotWithBackoff).not.toHaveBeenCalled();
	});

	it('should increment slot without processing if shouldProcessSlot returns false', async () => {
		mockGetState.mockResolvedValue({ currentSlot: 100, shardId: 1 });
		mockIngestion.ingestionIsPaused.mockReturnValue(false);
		mockIngestion.shouldProcessSlot.mockReturnValue(false);

		await main();

		jest.advanceTimersByTime(500);
		await Promise.resolve();

		expect(mockIngestion.processSlotWithBackoff).not.toHaveBeenCalled();
		expect(mockIngestion.incrementSlot).toHaveBeenCalledWith({ incrementBy: 1 });
	});

	it('should handle errors in the main loop', async () => {
		mockGetState.mockResolvedValue({ currentSlot: 100, shardId: 1 });
		mockIngestion.ingestionIsPaused.mockReturnValue(false);
		mockIngestion.getSlotAtBlockchainTip.mockRejectedValue(new Error('Test error'));

		await main().catch(async () => {
			jest.advanceTimersByTime(500);
			await Promise.resolve();
			expect(mockIngestion.shutdown).toHaveBeenCalled();
		});
	});
});
