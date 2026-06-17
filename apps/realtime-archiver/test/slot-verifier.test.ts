import { handler } from '../src/slot-verifier';

jest.mock('@backend/common');
jest.mock('@backend/dynamodb');

const mockRepository = {
	getCheckpointSlot: jest.fn(),
	getIngestedSlots: jest.fn(),
	createMissedSlotRecords: jest.fn(),
	deleteIngestedSlots: jest.fn(),
	updateCheckpoint: jest.fn(),
};
jest.mock('@backend/dynamodb', () => {
	return {
		RealTimeArchiverRepository: () => mockRepository,
	};
});

const mockConnection = {
	getSlot: jest.fn(),
};

const mockGetSlot = jest.fn();
jest.mock('@solana/web3.js', () => {
	return {
		...jest.requireActual('@solana/web3.js'),
		Connection: jest.fn().mockImplementation(() => ({
			getSlot: mockGetSlot,
		})),
	};
});

describe('SlotVerifier', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('should process slots with no missing slots', async () => {
		const checkpoint = 1000;
		const latestSlot = 6500;
		const targetSlot = 5500;
		const ingestedSlots = Array.from({ length: targetSlot - checkpoint + 1 }, (_, i) => ({
			slot: checkpoint + i,
		}));

		mockGetSlot.mockResolvedValue(latestSlot);
		mockRepository.getCheckpointSlot.mockResolvedValue(checkpoint);
		mockRepository.getIngestedSlots.mockResolvedValue(ingestedSlots);

		const result = await handler();

		expect(mockRepository.createMissedSlotRecords).not.toHaveBeenCalled();
		expect(mockRepository.deleteIngestedSlots).toHaveBeenCalledWith(
			ingestedSlots.map((slot) => slot.slot)
		);
		expect(mockRepository.updateCheckpoint).toHaveBeenCalledWith(targetSlot);
		expect(result).toEqual({
			statusCode: 200,
			body: JSON.stringify({
				message: 'Success',
				checkpointSlot: targetSlot,
				missingSlots: 0,
			}),
		});
	});

	it('should detect and record missing slots', async () => {
		const checkpoint = 1000;
		const latestSlot = 6500;
		const ingestedSlots = [{ slot: 1000 }, { slot: 1001 }, { slot: 1003 }, { slot: 1004 }];

		mockRepository.getCheckpointSlot.mockResolvedValue(checkpoint);
		mockConnection.getSlot.mockResolvedValue(latestSlot);
		mockRepository.getIngestedSlots.mockResolvedValue(ingestedSlots);

		await handler();

		expect(mockRepository.createMissedSlotRecords).toHaveBeenCalledWith(
			expect.arrayContaining(Array(496).fill(expect.any(Number)))
		);
		expect(mockRepository.deleteIngestedSlots).toHaveBeenCalledWith(
			ingestedSlots.map((slot) => slot.slot)
		);
	});

	it('should handle errors during processing', async () => {
		mockRepository.getCheckpointSlot.mockRejectedValue(new Error('Database error'));

		await expect(handler()).rejects.toThrow('Database error');

		expect(mockRepository.updateCheckpoint).not.toHaveBeenCalled();
	});

	it('should handle no ingested slots', async () => {
		const checkpoint = 1000;
		const latestSlot = 2500;

		mockRepository.getCheckpointSlot.mockResolvedValue(checkpoint);
		mockConnection.getSlot.mockResolvedValue(latestSlot);
		mockRepository.getIngestedSlots.mockResolvedValue([]);

		await handler();

		expect(mockRepository.deleteIngestedSlots).not.toHaveBeenCalled();
		expect(mockRepository.createMissedSlotRecords).toHaveBeenCalled();
		expect(mockRepository.updateCheckpoint).toHaveBeenCalled();
	});
});
