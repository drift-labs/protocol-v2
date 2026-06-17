import { IngestionState, SlotStatus } from '@backend/common';
import { RealTimeArchiverRepository } from '../../src/repositories/realtime-archiver';

const mockGet = jest.fn();
const mockPut = jest.fn();
const mockBatch = jest.fn();
const mockBatchRemove = jest.fn();
const mockRemove = jest.fn();
const mockQueryAll = jest.fn();

jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		get: mockGet,
		put: mockPut,
		batchWrite: mockBatch,
		batchRemove: mockBatchRemove,
		remove: mockRemove,
		queryAll: mockQueryAll,
	}),
}));

describe('RealTimeArchiverRepository', () => {
	let repository: ReturnType<typeof RealTimeArchiverRepository>;

	const initState: IngestionState = {
		id: '123',
		currentSlot: 0,
		shards: 2,
		shardId: 1,
		paused: false,
		ingestedSlots: [],
		bypassSlots: [],
		missedSlots: [],
		failedSlots: [],
		skippedSlots: [],
	};

	beforeEach(() => {
		jest.clearAllMocks();
		repository = RealTimeArchiverRepository();
	});

	describe('getState', () => {
		it('should return the state when it exists', async () => {
			const mockState: IngestionState = initState;
			mockGet.mockResolvedValue({ Item: mockState });
			const result = await repository.getState({ id: '123' });
			expect(result).toEqual(mockState);
			expect(mockGet).toHaveBeenCalledWith({
				pk: 'INGESTOR#123',
				sk: 'INGESTOR#123',
			});
		});

		it('should return null when the state does not exist', async () => {
			mockGet.mockResolvedValue({ Item: undefined });
			const result = await repository.getState({ id: '123' });
			expect(result).toBeUndefined();
		});
	});

	describe('updateState', () => {
		it('should update the state and return it', async () => {
			const mockState: IngestionState = initState;
			mockPut.mockResolvedValue({});
			const result = await repository.updateState({ state: mockState });
			expect(result).toEqual(mockState);
			expect(mockPut).toHaveBeenCalledWith({ record: mockState });
		});
	});

	describe('createSlotRecords', () => {
		const testCases = [
			{
				method: 'createSkippedSlotRecords' as const,
				status: SlotStatus.SKIPPED,
				pk: 'SKIPPED',
			},
			{ method: 'createMissedSlotRecords' as const, status: SlotStatus.MISSED, pk: 'MISSED' },
			{ method: 'createFailedSlotRecords' as const, status: SlotStatus.FAILED, pk: 'FAILED' },
			{
				method: 'createIngestedSlotRecords' as const,
				status: SlotStatus.INGESTED,
				pk: 'INGESTED',
			},
		];

		testCases.forEach(({ method, status, pk }) => {
			describe(method, () => {
				it(`should create ${status} slot records`, async () => {
					const slots = [1, 2, 3];
					let expectedRecords = slots.map((slot) => ({
						pk,
						sk: `SLOT#${slot}`,
						slot,
						createdAt: expect.any(Number),
						status,
					}));

					if (status === SlotStatus.SKIPPED) {
						expectedRecords = expectedRecords.map((record) => {
							return {
								...record,
								ttl: expect.any(Number),
							};
						});
					}

					await repository[method](slots);

					expect(mockBatch).toHaveBeenCalledWith({ records: expectedRecords });
				});
			});
		});
	});

	describe('getCheckpointSlot', () => {
		it('should return the checkpoint slot when it exists', async () => {
			mockGet.mockResolvedValue({ Item: { lastProcessedSlot: 1000 } });
			const result = await repository.getCheckpointSlot();
			expect(result).toBe(1000);
			expect(mockGet).toHaveBeenCalledWith({
				pk: 'CHECKPOINT',
				sk: 'CHECKPOINT',
			});
		});

		it('should return 0 when no checkpoint exists', async () => {
			mockGet.mockResolvedValue({ Item: undefined });
			const result = await repository.getCheckpointSlot();
			expect(result).toBe(0);
		});
	});

	describe('updateCheckpoint', () => {
		it('should update the checkpoint slot', async () => {
			const slot = 1000;
			await repository.updateCheckpoint(slot);
			expect(mockPut).toHaveBeenCalledWith({
				record: {
					pk: 'CHECKPOINT',
					sk: 'CHECKPOINT',
					lastProcessedSlot: slot,
					createdAt: expect.any(Number),
				},
			});
		});
	});

	describe('getIngestedSlots', () => {
		it('should query and return ingested slots', async () => {
			const mockSlots = [
				{ slot: 1, pk: 'INGESTED', sk: 'SLOT#1' },
				{ slot: 2, pk: 'INGESTED', sk: 'SLOT#2' },
			];
			mockQueryAll.mockResolvedValue(mockSlots);

			const result = await repository.getIngestedSlots(1000);
			expect(result).toEqual(mockSlots);
			expect(mockQueryAll).toHaveBeenCalledWith({
				pk: 'INGESTED',
				sk: 'SLOT#1000',
				expression: 'pk = :pk and sk <= :sk',
			});
		});

		it('should return empty array when no slots found', async () => {
			mockQueryAll.mockResolvedValue(undefined);
			const result = await repository.getIngestedSlots(1000);
			expect(result).toEqual([]);
		});
	});

	describe('deleteIngestedSlots', () => {
		it('should delete ingested slots successfully', async () => {
			const slots = [1, 2, 3];
			mockBatchRemove.mockResolvedValue([]);

			await repository.deleteIngestedSlots(slots);

			expect(mockBatchRemove).toHaveBeenCalledWith({
				records: slots.map((slot) => ({
					pk: 'INGESTED',
					sk: `SLOT#${slot}`,
				})),
			});
		});

		it('should retry failed deletions individually', async () => {
			const slots = [1, 2];
			const failedItems = [{ pk: 'INGESTED', sk: 'SLOT#1' }];
			mockBatchRemove.mockResolvedValue(failedItems);

			await repository.deleteIngestedSlots(slots);

			expect(mockRemove).toHaveBeenCalledWith({
				pk: 'INGESTED',
				sk: 'SLOT#1',
			});
		});
	});

	describe('deleteMissedSlotRecord', () => {
		it('should delete a missed slot record', async () => {
			const slot = 1000;
			await repository.deleteMissedSlotRecord(slot);

			expect(mockRemove).toHaveBeenCalledWith({
				pk: 'MISSED',
				sk: `SLOT#${slot}`,
			});
		});
	});

	describe('deleteFailedSlotRecord', () => {
		it('should delete a failed slot record', async () => {
			const slot = 1000;
			await repository.deleteFailedSlotRecord(slot);

			expect(mockRemove).toHaveBeenCalledWith({
				pk: 'FAILED',
				sk: `SLOT#${slot}`,
			});
		});
	});
});
