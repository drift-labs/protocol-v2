import { SQSEvent } from 'aws-lambda';
import { handler } from '../src/async-slot-ingestion';

// Mock the dependencies
jest.mock('@backend/common', () => ({
	...jest.requireActual('@backend/common'),
	isFeatureEnabled: jest.fn().mockReturnValue(true),
}));
jest.mock('@backend/dynamodb');

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

const mockDeleteMissedRecord = jest.fn();
const mockDeleteFailedRecord = jest.fn();
jest.mock('@backend/dynamodb', () => {
	return {
		RealTimeArchiverRepository: () => {
			return {
				deleteMissedSlotRecord: mockDeleteMissedRecord,
				deleteFailedSlotRecord: mockDeleteFailedRecord,
			};
		},
	};
});

describe('AsyncSlotIngestion', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('should process valid SQS records', async () => {
		const mockEvent: SQSEvent = {
			Records: [
				{
					body: JSON.stringify({ slot: 100, status: 'MISSED' }),
					messageId: 'msg-100',
				},
				{
					body: JSON.stringify({ slot: 101, status: 'MISSED' }),
					messageId: 'msg-101',
				},
			],
		} as SQSEvent;

		mockIngestion.processSlotWithBackoff.mockResolvedValue(true);

		const result = await handler(mockEvent);

		expect(mockIngestion.processSlotWithBackoff).toHaveBeenCalledTimes(2);
		expect(mockIngestion.processSlotWithBackoff).toHaveBeenCalledWith(100);
		expect(mockIngestion.processSlotWithBackoff).toHaveBeenCalledWith(101);
		expect(mockDeleteMissedRecord).toHaveBeenCalledTimes(2);
		expect(mockDeleteMissedRecord).toHaveBeenCalledWith(100);
		expect(mockDeleteMissedRecord).toHaveBeenCalledWith(101);
		expect(mockDeleteFailedRecord).not.toHaveBeenCalled();
		expect(result).toEqual({ batchItemFailures: [] });
		expect(mockIngestion.shutdown).toHaveBeenCalledWith({
			syncState: false,
			skipOffloadRetrySlots: true,
		});
	});

	it('should return batch item failures when processing fails', async () => {
		const mockEvent: SQSEvent = {
			Records: [
				{
					body: JSON.stringify({ slot: 100, status: 'MISSED' }),
					messageId: 'msg-100',
				},
			],
		} as SQSEvent;

		mockIngestion.processSlotWithBackoff.mockResolvedValue(false);

		const result = await handler(mockEvent);

		expect(mockIngestion.processSlotWithBackoff).toHaveBeenCalledWith(100);
		expect(mockDeleteMissedRecord).not.toHaveBeenCalled();
		expect(result).toEqual({
			batchItemFailures: [{ itemIdentifier: 'msg-100' }],
		});
		expect(mockIngestion.shutdown).toHaveBeenCalledWith({
			syncState: false,
			skipOffloadRetrySlots: true,
		});
	});
});
