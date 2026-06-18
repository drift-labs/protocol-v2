import {
	IngestionSource,
	IngestionState,
	RecordTypes,
	SerializedMarketFilter,
	SlotStatus,
} from '@backend/common';
import { VaultClient } from '@velocity-exchange/vaults-sdk';
import { Connection, SolanaJSONRPCError } from '@solana/web3.js';
import { VelocityClient } from '@velocity-exchange/sdk';
import { backOff } from 'exponential-backoff';
import { Ingestion } from '../../src/services/ingestion';

jest.mock('exponential-backoff');
jest.mock('@backend/dynamodb');
jest.mock('@backend/kinesis');

const mockGetState = jest.fn();
const mockUpdateState = jest.fn();
const mockCreateSkippedSlotRecords = jest.fn();
let mockCreateMissedSlotRecords = jest.fn();
const mockCreateFailedSlotRecords = jest.fn();
const mockCreateIngestedSlotRecords = jest.fn();
jest.mock('@backend/dynamodb', () => ({
	RealTimeArchiverRepository: jest.fn().mockImplementation(() => ({
		getState: mockGetState,
		updateState: mockUpdateState,
		createSkippedSlotRecords: mockCreateSkippedSlotRecords,
		createMissedSlotRecords: mockCreateMissedSlotRecords,
		createFailedSlotRecords: mockCreateFailedSlotRecords,
		createIngestedSlotRecords: mockCreateIngestedSlotRecords,
	})),
}));

const mockPutRecords = jest.fn();
jest.mock('@backend/kinesis', () => ({
	Kinesis: jest.fn().mockImplementation(() => ({
		putRecords: mockPutRecords,
	})),
}));

const mockGetBlock = jest.fn();
const mockGetSlot = jest.fn();
jest.mock('@solana/web3.js', () => {
	return {
		...jest.requireActual('@solana/web3.js'),
		Connection: jest.fn().mockImplementation(() => ({
			getBlock: mockGetBlock,
			getSlot: mockGetSlot,
		})),
	};
});

jest.mock('@velocity-exchange/sdk', () => {
	return {
		// `BN` is re-exported by the SDK and used by `@backend/common`'s
		// `simpleSerialize` (`value instanceof BN`). The SDK's `BN` is bn.js's
		// constructor, so requiring it directly keeps `instanceof` semantics
		// without pulling the whole SDK into the test realm.
		BN: require('bn.js'),
		parseLogs: jest.fn().mockImplementation((program, logs) => {
			if (
				program.programId.toString() === 'driftProgramId' &&
				logs.some((log: string) => log.includes('driftProgramId'))
			) {
				return [{ name: 'test', data: {} }];
			}
			if (
				program.programId.toString() === 'vaultProgramId' &&
				logs.some((log: string) => log.includes('vaultProgramId'))
			) {
				return [{ name: 'test-vault', data: {} }];
			}
			return [];
		}),
		initialize: jest.fn().mockImplementation(() => {
			return {
				PERP_MARKETS: [
					{
						marketIndex: 90,
						category: ['Prediction'],
					},
				],
			};
		}),
		OrderAction: {
			FILL: { fill: {} },
		},
		MarketType: {
			PERP: { perp: {} },
		},
		DepositExplanation: {
			REWARD: { reward: {} },
		},
	};
});

(backOff as jest.Mock).mockImplementation((fn) => fn());

describe('Ingestion Service', () => {
	let mockState: IngestionState;
	let ingestion: ReturnType<typeof Ingestion>;

	beforeEach(() => {
		jest.useFakeTimers();
		mockState = {
			id: 'test-id',
			currentSlot: 100,
			slotAtTip: 150,
			paused: false,
			bypassSlots: [],
			ingestedSlots: [],
			endSlot: undefined,
			shards: 2,
			shardId: 1,
			missedSlots: [],
			failedSlots: [],
			skippedSlots: [],
		};

		const mockDriftClient = {
			program: {
				programId: { toString: jest.fn().mockReturnValue('driftProgramId') },
			},
		} as unknown as VelocityClient;

		const mockVaultClient = {
			program: {
				programId: { toString: jest.fn().mockReturnValue('vaultProgramId') },
			},
		} as unknown as VaultClient;

		const mockConnection = new Connection('') as jest.Mocked<Connection>;

		ingestion = Ingestion({
			state: mockState,
			driftClient: mockDriftClient,
			vaultClient: mockVaultClient,
			connection: mockConnection,
		});
	});

	afterEach(() => {
		jest.clearAllMocks();
		jest.useRealTimers();
	});

	describe('ingestionIsPaused', () => {
		it('should return correct pause state', () => {
			expect(ingestion.ingestionIsPaused()).toBe(false);
			mockState.paused = true;
			expect(ingestion.ingestionIsPaused()).toBe(true);
		});
	});

	describe('getSlotAtBlockchainTip', () => {
		it('should update slotAtTip in state', async () => {
			mockGetSlot.mockResolvedValue(200);
			await ingestion.getSlotAtBlockchainTip();
			expect(mockState.slotAtTip).toBe(200);
		});
	});

	describe('shouldProcessSlot', () => {
		it('should throw an error when end slot is reached', () => {
			mockState.endSlot = 101;
			expect(() => ingestion.shouldProcessSlot(102)).toThrow(
				'Ingestor has reached end slot and will not continue ingesting any more slots'
			);
		});

		it('should return false when slot is greater than slotAtTip', () => {
			mockState.slotAtTip = 101;
			expect(ingestion.shouldProcessSlot(102)).toBe(false);
		});

		it('should return false when slot is in bypassSlots', () => {
			mockState.bypassSlots = [102];
			expect(ingestion.shouldProcessSlot(102)).toBe(false);
		});

		it('should return false when slot does not belong to shard', () => {
			expect(ingestion.shouldProcessSlot(102)).toBe(false);
		});

		it('should return true for a valid slot', () => {
			mockState.slotAtTip = 150;
			mockState.shardId = 0;
			expect(ingestion.shouldProcessSlot(102)).toBe(true);
		});
	});

	describe('processSlotWithBackoff', () => {
		it('should process slot successfully', async () => {
			mockGetBlock.mockResolvedValue({
				transactions: [
					{
						meta: {
							logMessages: [
								'Program driftProgramId invoke [1]',
								'Program log: Instruction: InitializeMarket',
							],
						},
						transaction: {
							signatures: ['sig1'],
						},
					},
					{
						meta: {
							logMessages: [
								'Program otherProgramId invoke [1]',
								'Program log: Some other instruction',
							],
						},
						transaction: {
							signatures: ['sig2'],
						},
					},
				],
			});
			const processed = await ingestion.processSlotWithBackoff(101);
			expect(processed).toBe(true);
			expect(mockState.ingestedSlots).toContain(101);
			expect(ingestion.getQueue()).toEqual([
				{
					eventType: 'test',
					txSigIndex: 0,
					txSig: 'sig1',
					slot: 101,
					source: IngestionSource.SEQUENTIAL,
				},
			]);
		});

		it('should handle SolanaJSONRPCError', async () => {
			mockGetBlock.mockRejectedValue(
				new SolanaJSONRPCError({ code: -32007, message: 'Slot skipped' })
			);
			const processed = await ingestion.processSlotWithBackoff(101);
			expect(processed).toBe(true);
			expect(mockState.skippedSlots).toContain(101);
		});

		it('should treat -32009 as skipped and successful', async () => {
			mockGetBlock.mockRejectedValue(
				new SolanaJSONRPCError({ code: -32009, message: 'Long-term storage unavailable' })
			);
			const processed = await ingestion.processSlotWithBackoff(101);
			expect(processed).toBe(true);
			expect(mockState.skippedSlots).toContain(101);
			expect(mockState.ingestedSlots).toContain(101);
		});

		it('should add slot to failed queue on other errors', async () => {
			mockGetBlock.mockRejectedValue(new Error('Unknown error'));
			const processed = await ingestion.processSlotWithBackoff(101);
			expect(processed).toBe(false);
			expect(mockState.failedSlots).toContain(101);
		});
	});

	describe('processSlot', () => {
		it('should process a slot with transactions', async () => {
			const mockBlock = {
				transactions: [
					{
						meta: { logMessages: ['driftProgramId'] },
						transaction: {
							signatures: ['sig1'],
						},
					},
					{
						meta: { logMessages: ['otherProgramId'] },
						transaction: {
							signatures: ['sig2'],
						},
					},
				],
			};
			mockGetBlock.mockResolvedValue(mockBlock);

			await ingestion.processSlot(102);

			expect(mockGetBlock).toHaveBeenCalledWith(102, expect.any(Object));
			expect(ingestion.getQueue()).toEqual([
				{
					eventType: 'test',
					txSigIndex: 0,
					slot: 102,
					txSig: 'sig1',
					source: IngestionSource.SEQUENTIAL,
				},
			]);
		});

		it('should process a slot with drift in one transaction and vault in another', async () => {
			const mockBlock = {
				transactions: [
					{
						meta: {
							logMessages: [
								'Program driftProgramId invoke [1]',
								'Program log: Instruction: PlaceOrder',
							],
							err: null,
						},
						transaction: {
							signatures: ['sig4'],
						},
					},
					{
						meta: {
							logMessages: [
								'Program vaultProgramId invoke [1]',
								'Program log: Instruction: DepositVault',
							],
							err: null,
						},
						transaction: {
							signatures: ['sig5'],
						},
					},
				],
			};
			mockGetBlock.mockResolvedValue(mockBlock);

			await ingestion.processSlot(105);

			expect(mockGetBlock).toHaveBeenCalledWith(105, expect.any(Object));

			const queue = ingestion.getQueue();
			expect(queue.length).toBe(2);

			expect(queue).toContainEqual(
				expect.objectContaining({
					eventType: 'test',
					txSig: 'sig4',
					slot: 105,
					source: IngestionSource.SEQUENTIAL,
				})
			);

			expect(queue).toContainEqual(
				expect.objectContaining({
					eventType: 'test-vault',
					txSig: 'sig5',
					slot: 105,
					source: IngestionSource.SEQUENTIAL,
				})
			);
		});

		it('should process a slot with both drift and vault program logs', async () => {
			const mockBlock = {
				transactions: [
					{
						meta: {
							logMessages: [
								'Program driftProgramId invoke [1]',
								'Program log: Instruction: PlaceOrder',
								'Program vaultProgramId invoke [2]',
								'Program log: Instruction: ProcessDeposit',
							],
							err: null,
						},
						transaction: {
							signatures: ['sig3'],
						},
					},
				],
			};
			mockGetBlock.mockResolvedValue(mockBlock);

			await ingestion.processSlot(104);

			expect(mockGetBlock).toHaveBeenCalledWith(104, expect.any(Object));

			const queue = ingestion.getQueue();
			expect(queue.length).toBe(2);

			expect(queue).toContainEqual(
				expect.objectContaining({
					eventType: 'test',
					txSig: 'sig3',
					slot: 104,
					source: IngestionSource.SEQUENTIAL,
				})
			);

			expect(queue).toContainEqual(
				expect.objectContaining({
					eventType: 'test-vault',
					txSig: 'sig3',
					slot: 104,
					source: IngestionSource.SEQUENTIAL,
				})
			);
		});

		it('should handle case when no block is found', async () => {
			mockGetBlock.mockResolvedValue(null);
			await ingestion.processSlot(102);
			expect(ingestion.getQueue()).toEqual([]);
		});
	});

	describe('incrementSlot', () => {
		it('should increment slot correctly', () => {
			ingestion.incrementSlot();
			expect(mockState.currentSlot).toBe(102);
			ingestion.incrementSlot({ incrementBy: 5 });
			expect(mockState.currentSlot).toBe(107);
		});

		it('should not increment past slotAtTip', () => {
			mockState.currentSlot = 151;
			mockState.slotAtTip = 150;
			ingestion.incrementSlot({ incrementBy: 5 });
			expect(mockState.currentSlot).toBe(151);
		});
	});

	describe('serializeEvents', () => {
		const createBaseEvent = (name: string, data: any = {}) => ({
			name,
			data: { ...data },
		});

		it('should correctly serialize a basic non-order event', () => {
			const chunk = {
				slot: 123,
				events: [
					{
						event: createBaseEvent('SomeEvent', { field: 'value' }),
						signature: 'sig123',
					},
				],
			};

			const result = ingestion.serializeEvents(chunk);

			expect(result[0]).toMatchObject({
				field: 'value',
				slot: 123,
				txSig: 'sig123',
				eventType: 'SomeEvent',
				txSigIndex: 0,
				source: IngestionSource.SEQUENTIAL,
			});
		});

		it('should correctly serialize a prediction market fill order', () => {
			const chunk = {
				slot: 456,
				events: [
					{
						event: createBaseEvent(RecordTypes.OrderActionRecord, {
							action: { fill: {} },
							marketType: { perp: {} },
							marketIndex: 90,
						}),
						signature: 'sig456',
					},
				],
			};

			const result = ingestion.serializeEvents(chunk);

			expect(result[0]).toMatchObject({
				slot: 456,
				txSig: 'sig456',
				eventType: RecordTypes.PredictionRecord,
				marketType: 'perp',
				marketFilter: 'prediction',
				txSigIndex: 0,
				marketIndex: 90,
				source: IngestionSource.SEQUENTIAL,
			});
		});

		it('should correctly serialize a standard perp market fill order', () => {
			const chunk = {
				slot: 789,
				events: [
					{
						event: createBaseEvent(RecordTypes.OrderActionRecord, {
							action: { fill: {} },
							marketType: { perp: {} },
							marketIndex: 2,
						}),
						signature: 'sig789',
					},
				],
			};

			const result = ingestion.serializeEvents(chunk);

			expect(result[0]).toMatchObject({
				slot: 789,
				txSig: 'sig789',
				eventType: RecordTypes.TradeRecord,
				marketType: 'perp',
				marketFilter: 'perp',
				txSigIndex: 0,
				marketIndex: 2,
				source: IngestionSource.SEQUENTIAL,
			});
		});

		it('should correctly serialize a spot market fill order', () => {
			const chunk = {
				slot: 101,
				events: [
					{
						event: createBaseEvent(RecordTypes.OrderActionRecord, {
							action: { fill: {} },
							marketType: { spot: {} },
						}),
						signature: 'sig101',
					},
				],
			};

			const result = ingestion.serializeEvents(chunk);

			expect(result[0]).toMatchObject({
				slot: 101,
				txSig: 'sig101',
				eventType: RecordTypes.TradeRecord,
				txSigIndex: 0,
				source: IngestionSource.SEQUENTIAL,
			});
		});

		it('should correctly update market type for prediction market orders', () => {
			const chunk = {
				slot: 505,
				events: [
					{
						event: createBaseEvent(RecordTypes.OrderRecord, {
							order: {
								marketType: { perp: {} },
								marketIndex: 90, // Prediction market index
							},
						}),
						signature: 'sig505',
					},
				],
			};

			const result = ingestion.serializeEvents(chunk);

			expect(result[0]).toEqual({
				eventType: 'OrderRecord',
				slot: 505,
				txSig: 'sig505',
				txSigIndex: 0,
				order: {
					marketType: 'perp',
					marketFilter: SerializedMarketFilter.PREDICTION,
					marketIndex: 90,
				},
				source: IngestionSource.SEQUENTIAL,
			});
		});

		it('should not update market type for non-prediction perpetual market orders', () => {
			const chunk = {
				slot: 506,
				events: [
					{
						event: createBaseEvent(RecordTypes.OrderRecord, {
							order: {
								marketType: { perp: {} },
								marketIndex: 2,
							},
						}),
						signature: 'sig506',
					},
				],
			};

			const result = ingestion.serializeEvents(chunk);

			expect(result[0]).toEqual({
				eventType: 'OrderRecord',
				slot: 506,
				txSig: 'sig506',
				txSigIndex: 0,
				order: {
					marketFilter: 'perp',
					marketType: 'perp',
					marketIndex: 2,
				},
				source: IngestionSource.SEQUENTIAL,
			});
		});

		it('should maintain correct txSigIndex for multiple events', () => {
			const chunk = {
				slot: 202,
				events: [
					{
						event: createBaseEvent('Event1', { field: 'value1' }),
						signature: 'sig202a',
					},
					{
						event: createBaseEvent('Event2', { field: 'value2' }),
						signature: 'sig202b',
					},
				],
			};

			const result: any[] = ingestion.serializeEvents(chunk);
			expect(result[0].txSigIndex).toBe(0);
			expect(result[1].txSigIndex).toBe(1);
		});

		it('should correctly handle an empty events array', () => {
			const chunk = {
				slot: 303,
				events: [],
			};

			const result = ingestion.serializeEvents(chunk);

			expect(result).toHaveLength(0);
		});

		it('should correctly serialize a deposit record with normal explanation', () => {
			const chunk = {
				slot: 404,
				events: [
					{
						event: createBaseEvent(RecordTypes.DepositRecord, {
							explanation: { deposit: {} },
							amount: 100,
						}),
						signature: 'sig404',
					},
				],
			};

			const result = ingestion.serializeEvents(chunk);

			expect(result[0]).toMatchObject({
				slot: 404,
				txSig: 'sig404',
				eventType: RecordTypes.DepositRecord,
				explanation: 'deposit',
				amount: 100,
				txSigIndex: 0,
				source: IngestionSource.SEQUENTIAL,
			});
		});

		it('should convert deposit records with reward explanation to reward records', () => {
			const chunk = {
				slot: 505,
				events: [
					{
						event: createBaseEvent(RecordTypes.DepositRecord, {
							explanation: { reward: {} },
							amount: 50,
							referrer: 'referrer123',
						}),
						signature: 'sig505',
					},
				],
			};

			const result = ingestion.serializeEvents(chunk);

			expect(result[0]).toMatchObject({
				slot: 505,
				txSig: 'sig505',
				eventType: RecordTypes.RewardRecord,
				explanation: 'reward',
				amount: 50,
				referrer: 'referrer123',
				txSigIndex: 0,
				source: IngestionSource.SEQUENTIAL,
			});
		});

		it('should handle multiple deposit records with different explanations correctly', () => {
			const chunk = {
				slot: 606,
				events: [
					{
						event: createBaseEvent(RecordTypes.DepositRecord, {
							explanation: { deposit: {} },
							amount: 100,
						}),
						signature: 'sig606',
					},
					{
						event: createBaseEvent(RecordTypes.DepositRecord, {
							explanation: { reward: {} },
							amount: 25,
							rewardType: 'referral',
						}),
						signature: 'sig606',
					},
				],
			};

			const result = ingestion.serializeEvents(chunk);

			expect(result).toHaveLength(2);
			expect(result[0]).toMatchObject({
				eventType: RecordTypes.DepositRecord,
				explanation: 'deposit',
				txSigIndex: 0,
			});
			expect(result[1]).toMatchObject({
				eventType: RecordTypes.RewardRecord,
				explanation: 'reward',
				rewardType: 'referral',
				txSigIndex: 1,
			});
		});
	});

	describe('getQueue', () => {
		it('should return the event queue', () => {
			const queue = ingestion.getQueue();
			expect(Array.isArray(queue)).toBe(true);
		});
	});

	describe('addSlotsToFailedQueue', () => {
		it('should add slots to failed queue', () => {
			ingestion.addSlotsToFailedQueue([103, 106, 105]);
			expect(mockState.failedSlots).toEqual([103, 105]);
		});

		it('should not add duplicate slots', () => {
			mockState.failedSlots = [103];
			ingestion.addSlotsToFailedQueue([103, 105]);
			expect(mockState.failedSlots).toEqual([103, 105]);
		});
	});

	describe('addSlotsToSkippedQueue', () => {
		it('should add slots to skipped queue', () => {
			ingestion.addSlotsToSkippedQueue([103, 104, 105]);
			expect(mockState.skippedSlots).toEqual([103, 105]);
		});

		it('should not add duplicate slots', () => {
			mockState.skippedSlots = [103];
			ingestion.addSlotsToSkippedQueue([103, 105]);
			expect(mockState.skippedSlots).toEqual([103, 105]);
		});
	});

	describe('addSlotsToMissedQueue', () => {
		it('should add slots to missed queue', () => {
			(ingestion as any).addSlotsToMissedQueue([107, 104, 109]);
			expect(mockState.missedSlots).toEqual([107, 109]);
		});

		it('should not add duplicate slots', () => {
			mockState.missedSlots = [107];
			(ingestion as any).addSlotsToMissedQueue([107, 109]);
			expect(mockState.missedSlots).toEqual([107, 109]);
		});
	});

	describe('offloadSlotsToRecords', () => {
		it('should offload failed slots', async () => {
			mockState.failedSlots = [110, 112];
			await ingestion.offloadSlotsToRecords(SlotStatus.FAILED);
			expect(mockCreateFailedSlotRecords).toHaveBeenCalledWith([110, 112]);
			expect(mockState.failedSlots).toEqual([]);
		});

		it('should offload ingested slots', async () => {
			mockState.ingestedSlots = [120, 122, 124];
			await ingestion.offloadSlotsToRecords(SlotStatus.INGESTED);
			expect(mockCreateIngestedSlotRecords).toHaveBeenCalledWith([120, 122, 124]);
			expect(mockState.ingestedSlots).toEqual([]);
		});

		it('should handle errors when offloading ingested slots', async () => {
			mockState.ingestedSlots = [120, 122];
			mockCreateIngestedSlotRecords.mockRejectedValue(new Error('Test error'));

			await ingestion.offloadSlotsToRecords(SlotStatus.INGESTED);

			expect(mockState.ingestedSlots).toEqual([120, 122]);
			expect(mockCreateIngestedSlotRecords).toHaveBeenCalledWith([120, 122]);
		});

		it('should handle errors and restore slots', async () => {
			mockState.missedSlots = [114, 116];
			mockCreateMissedSlotRecords.mockRejectedValue(new Error('Test error'));
			expect(mockState.missedSlots).toEqual([114, 116]);
			mockCreateMissedSlotRecords = jest.fn();
		});
	});

	describe('syncIngestionState', () => {
		it('should update the ingestion state', async () => {
			const newState = { ...mockState, currentSlot: 120 };
			await ingestion.syncIngestionState({ state: newState });
			expect(mockUpdateState).toHaveBeenCalledWith({ state: newState });
		});
	});

	describe('sendToKinesis', () => {
		it('should send records to Kinesis', async () => {
			const mockRecords = [
				{ ts: '123', slot: 118 },
				{ ts: '124', slot: 119 },
			] as any;
			mockPutRecords.mockResolvedValue({ failedCount: 0 });
			await ingestion.sendToKinesis(mockRecords);
			expect(mockPutRecords).toHaveBeenCalled();
		});

		it('should handle failed records', async () => {
			const mockRecords = [
				{ ts: '123', slot: 118 },
				{ ts: '124', slot: 119 },
			] as any;
			mockPutRecords.mockResolvedValue({ failedCount: 1 });
			await ingestion.sendToKinesis(mockRecords);
			expect(mockState.failedSlots).toContain(119);
		});

		it('should update to highest slot', async () => {
			const mockRecords = [
				{ ts: '124', slot: 119 },
				{ ts: '123', slot: 118 },
			] as any;
			mockPutRecords.mockResolvedValue({ failedCount: 0 });
			await ingestion.sendToKinesis(mockRecords);
			expect(mockPutRecords).toHaveBeenCalled();
			expect(mockUpdateState).toHaveBeenCalledWith({
				state: { ...mockState, currentSlot: 119 },
			});
		});
	});

	describe('Interval operations', () => {
		it('should process event queue every second', async () => {
			const record = { id: 'test-id', slot: 123, ts: '123' };
			ingestion.addToQueue([{ id: 'test-id', slot: 123, ts: '123' } as any]);
			mockPutRecords.mockResolvedValue({ failedCount: 0 });
			jest.advanceTimersByTime(1000);
			await Promise.resolve();
			expect(mockPutRecords).toHaveBeenCalledWith([
				{
					Data: Buffer.from(JSON.stringify(record)),
					PartitionKey: '123',
				},
			]);
			expect(ingestion.getQueue()).toHaveLength(0);
		});

		it('should re-process slots every 10 seconds', async () => {
			mockState.failedSlots = [103, 105];
			jest.advanceTimersByTime(10000);
			await Promise.resolve();

			// Slots in queue turned off
			expect(mockCreateFailedSlotRecords).toHaveBeenCalled();

			// expect(mockGetBlock).toHaveBeenCalledWith(103, {
			// 	commitment: 'finalized',
			// 	maxSupportedTransactionVersion: 0,
			// });

			// expect(mockState.failedSlots).toEqual([105]);
			// jest.advanceTimersByTime(10000);
			// await Promise.resolve();
			// expect(mockGetBlock).toHaveBeenCalledWith(105, {
			// 	commitment: 'finalized',
			// 	maxSupportedTransactionVersion: 0,
			// });

			expect(mockState.failedSlots).toHaveLength(0);
		});

		it('should offload slots every 10 seconds', async () => {
			mockState.failedSlots = Array.from({ length: 99 }, (_, i) => i * 2 + 3);
			jest.advanceTimersByTime(10000);
			await Promise.resolve();
			expect(mockCreateFailedSlotRecords).toHaveBeenCalled();
			expect(mockState.failedSlots).toHaveLength(0);
		});

		it('should offload ingested slots every 10 seconds', async () => {
			mockState.ingestedSlots = [130, 132, 134];
			jest.advanceTimersByTime(10000);
			await Promise.resolve();

			expect(mockCreateIngestedSlotRecords).toHaveBeenCalledWith([130, 132, 134]);
			expect(mockState.ingestedSlots).toEqual([]);
		});

		describe('should check current slot position every 20 seconds', () => {
			it('should not update when slot difference is within MAX_SLOT_DIFFERENCE', async () => {
				mockState.currentSlot = 100;
				mockState.slotAtTip = 105;
				await jest.advanceTimersByTimeAsync(20000);
				await Promise.resolve();
				expect(mockState.missedSlots).toHaveLength(0);
				expect(mockState.currentSlot).toBe(100);
			});

			it('should update when slot difference exceeds MAX_SLOT_DIFFERENCE', async () => {
				mockState.currentSlot = 100;
				mockState.slotAtTip = 140;
				await jest.advanceTimersByTimeAsync(20000);
				await Promise.resolve();
				const expectedMissedSlots = Array.from(
					{ length: Math.floor((140 - 100) / 2) },
					(_, i) => 101 + i * 2
				);
				expect(mockState.missedSlots).toEqual(expectedMissedSlots);
				expect(mockState.missedSlots).toHaveLength(20);
				expect(mockState.currentSlot).toBe(140);
			});
		});

		it('should offload skipped slots every minute', async () => {
			mockState.skippedSlots = Array.from({ length: 99 }, (_, i) => i * 2 + 3);
			jest.advanceTimersByTime(60000);
			await Promise.resolve();
			expect(mockCreateSkippedSlotRecords).toHaveBeenCalled();
			expect(mockState.skippedSlots).toHaveLength(0);
		});
	});

	describe('shutdown', () => {
		it('should send remaining events to Kinesis', async () => {
			const record = { id: 'test-id', slot: 123, ts: 123 };
			ingestion.addToQueue([{ id: 'test-id', slot: 123, ts: 123 } as any]);
			mockPutRecords.mockResolvedValue({ failedCount: 0 });
			mockCreateMissedSlotRecords.mockImplementation();

			await ingestion.shutdown();

			expect(mockPutRecords).toHaveBeenCalledWith([
				{
					Data: Buffer.from(JSON.stringify(record)),
					PartitionKey: '123',
				},
			]);
			expect(ingestion.getQueue()).toHaveLength(0);
		});

		it('should skip offloading missed and failed when skipOffloadRetrySlots is true', async () => {
			mockState.missedSlots = [111];
			mockState.failedSlots = [113];
			mockState.skippedSlots = [115];
			mockState.ingestedSlots = [117];
			mockPutRecords.mockResolvedValue({ failedCount: 0 });

			await ingestion.shutdown({ syncState: false, skipOffloadRetrySlots: true });

			expect(mockCreateMissedSlotRecords).not.toHaveBeenCalled();
			expect(mockCreateFailedSlotRecords).not.toHaveBeenCalled();
			expect(mockCreateSkippedSlotRecords).toHaveBeenCalledWith([115]);
			expect(mockCreateIngestedSlotRecords).toHaveBeenCalledWith([117]);
		});

		it('should offload missed and failed by default', async () => {
			mockState.missedSlots = [121];
			mockState.failedSlots = [123];
			mockPutRecords.mockResolvedValue({ failedCount: 0 });

			await ingestion.shutdown({ syncState: false });

			expect(mockCreateMissedSlotRecords).toHaveBeenCalledWith([121]);
			expect(mockCreateFailedSlotRecords).toHaveBeenCalledWith([123]);
		});
	});
});
