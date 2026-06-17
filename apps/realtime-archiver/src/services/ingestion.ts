import {
	enumToStr,
	IngestionSource,
	IngestionState,
	logger,
	RecordTypes,
	SerializedMarketFilter,
	simpleSerialize,
	SlotStatus,
} from '@backend/common';
import { RealTimeArchiverRepository } from '@backend/dynamodb';
import { Kinesis } from '@backend/kinesis';
import { Event, Idl, Program } from '@coral-xyz/anchor';
import { VaultClient } from '@velocity-exchange/vaults-sdk';
import { Connection, SolanaJSONRPCError } from '@solana/web3.js';
import {
	DepositExplanation,
	VelocityClient,
	VelocityEnv,
	DriftEvent,
	initialize,
	MarketType,
	Order,
	OrderAction,
	OrderRecord,
	parseLogs,
} from '@velocity-exchange/sdk';
import { backOff } from 'exponential-backoff';
import { updateFailedSlotCount } from './metrics';

const ONE_SECOND = 1000;
const TEN_SECONDS = 10000;
const TWENTY_SECONDS = 20000;
const MAX_SLOT_DIFFERENCE = 20;
const MAX_SLOTS_IN_QUEUE = 0;
const MAX_SLOTS_FOR_WARNING = 200;
const ONE_MINUTE = 60000;
const EMPTY_SLOTS_BEFORE_SYNC = 100;
const driftEnv = (process.env.ENV || 'mainnet-beta') as VelocityEnv;
const { PERP_MARKETS } = initialize({ env: driftEnv });

const PREDICTION_MARKETS = PERP_MARKETS.filter((market) => market.category?.includes('Prediction'));

export const Ingestion = ({
	state,
	driftClient,
	vaultClient,
	connection,
	source = IngestionSource.SEQUENTIAL,
	batchTime = ONE_SECOND,
	dryRun = false,
	fumarole = false,
}: {
	state: IngestionState;
	driftClient: VelocityClient;
	vaultClient: VaultClient;
	connection: Connection;
	source?: IngestionSource;
	batchTime?: number;
	dryRun?: boolean;
	fumarole?: boolean;
}) => {
	const { putRecords } = Kinesis();
	const {
		updateState,
		createSkippedSlotRecords,
		createMissedSlotRecords,
		createFailedSlotRecords,
		createIngestedSlotRecords,
	} = RealTimeArchiverRepository();

	const eventQueue: DriftEvent[] = [];
	let consecutiveEmptySlots = 0;

	setInterval(async () => {
		if (ingestionIsPaused() || dryRun) return;

		const queue = getQueue();
		if (queue.length > 0) {
			const batch = queue.splice(0);
			logger.info(`Processing ${batch.length} events from queue`);
			await sendToKinesis(batch);
		}
	}, batchTime);

	setInterval(async () => {
		if (ingestionIsPaused() || dryRun) return;

		logger.info(
			`Re-processing slots - missed: ${state.missedSlots.length}, failed: ${state.failedSlots.length}`
		);

		if (state.failedSlots.length > MAX_SLOTS_IN_QUEUE) {
			await offloadSlotsToRecords(SlotStatus.FAILED);
		} else {
			while (state.failedSlots.length > 0) {
				const slot = state.failedSlots.shift();

				if (slot === undefined) break;

				logger.info(`Re-processing failed slot: ${slot}`);

				try {
					if (shouldProcessSlot(slot)) {
						await processSlotWithBackoff(slot);
					}
				} catch (error) {
					const { message } = error as Error;
					await logger.error(`Failed to re-process failed slot ${slot}: ${message}`);
					state.failedSlots.push(slot);
				}
			}
		}

		if (state.missedSlots.length > MAX_SLOTS_IN_QUEUE) {
			await offloadSlotsToRecords(SlotStatus.MISSED);
		} else {
			while (state.missedSlots.length > 0) {
				const slot = state.missedSlots.shift();

				if (slot === undefined) break;

				logger.info(`Re-processing missed slot: ${slot}`);

				try {
					if (shouldProcessSlot(slot)) {
						await processSlotWithBackoff(slot);
					}
				} catch (error) {
					const { message } = error as Error;
					await logger.error(`Failed to re-process missed slot ${slot}: ${message}`);
					state.missedSlots.push(slot);
				}
			}
		}

		await offloadSlotsToRecords(SlotStatus.INGESTED);
	}, TEN_SECONDS);

	setInterval(async () => {
		if (ingestionIsPaused() || isGrpcSource() || fumarole) return;

		const { currentSlot, slotAtTip } = state;

		logger.info('Checking current slot position relative to blockchain tip');

		if (currentSlot === undefined) {
			logger.warn('Current slot is undefined. Skipping check.');
			return;
		}

		if (slotAtTip === undefined) {
			logger.warn('Unable to fetch slot at tip. Skipping check.');
			return;
		}

		const slotDifference = slotAtTip - currentSlot;

		if (slotDifference > MAX_SLOT_DIFFERENCE) {
			logger.info(`Current slot is ${slotDifference} behind the tip. Updating to tip.`);
			const missedSlots = Array.from({ length: slotDifference }, (_, i) => currentSlot + i);

			addSlotsToMissedQueue(missedSlots);

			state.currentSlot = slotAtTip;
		} else {
			logger.info(`Current slot is ${slotDifference} behind the tip. No update needed.`);
		}
	}, TWENTY_SECONDS);

	setInterval(async () => {
		if (ingestionIsPaused() || dryRun) return;

		logger.info(`Offloading skipped slots: ${state.skippedSlots.length}`);

		if (state.skippedSlots.length) {
			await offloadSlotsToRecords(SlotStatus.SKIPPED);
		}
	}, ONE_MINUTE);

	const ingestionIsPaused = () => {
		return state.paused;
	};

	const isGrpcSource = () => {
		return source === 'grpc';
	};

	const shouldProcessSlot = (slot: number, bypassTipCheck = false) => {
		const { slotAtTip, bypassSlots, endSlot, shards, shardId } = state;

		if (endSlot && endSlot < slot) {
			throw new Error(
				'Ingestor has reached end slot and will not continue ingesting any more slots'
			);
		}

		if (!bypassTipCheck && slotAtTip && slot > slotAtTip) {
			logger.info(`Slot ${slot} already processed or not new.`);
			return false;
		}

		if (bypassSlots.includes(slot)) {
			logger.info(`Slot ${slot} has been bypassed.`);
			return false;
		}

		if (slot % shards !== shardId) {
			logger.info(`Slot ${slot} does not belong to shard ${state.shardId}`);
			return false;
		}

		return true;
	};

	const processSlotWithBackoff = async (slot: number) => {
		const backoffOptions = {
			numOfAttempts: 3,
			startingDelay: 1000,
			timeMultiple: 2,
			maxDelay: 10000,
			delayFirstAttempt: false,
			retry: (error: Error, attemptNumber: number) => {
				if (
					error instanceof SolanaJSONRPCError &&
					(error.code === -32007 || error.code === -32009)
				) {
					logger.info(`Slot ${slot} skipped, not retrying.`);
					return false;
				}
				logger.warn(
					`Attempt ${attemptNumber} failed for slot ${slot}. Error: ${error.message}. Retrying...`
				);
				return true;
			},
		};

		try {
			await backOff(() => processSlot(slot), backoffOptions);
			logger.info(`Successfully processed slot ${slot}`);
			addSlotsToIngestedQueue([slot]);
			return true;
		} catch (error) {
			if (error instanceof SolanaJSONRPCError) {
				const { code, message } = error;
				switch (code) {
					case -32007:
					case -32009:
						logger.info(message);
						addSlotsToSkippedQueue([slot]);
						addSlotsToIngestedQueue([slot]);
						return true;
					default:
						updateFailedSlotCount();
						await logger.error(
							`Failed to process slot ${slot} after all retries: ${message}`
						);
						addSlotsToFailedQueue([slot]);
						return false;
				}
			}

			const { message, name } = error as Error;
			if (name === 'TimeoutError') {
				await logger.warn(`Failed to process slot ${slot} after all retries: ${message}`);
			} else {
				await logger.error(`Failed to process slot ${slot} after all retries: ${message}`);
			}
			updateFailedSlotCount();
			addSlotsToFailedQueue([slot]);
			return false;
		}
	};

	const processSlot = async (slot: number) => {
		const block = await connection.getBlock(slot, {
			commitment: 'finalized',
			maxSupportedTransactionVersion: 0,
			rewards: false,
		});

		if (!block) {
			logger.info(`No block found for slot ${slot}`);
			return;
		}

		const relevantTransactions = block.transactions.filter((tx) => {
			if (tx.meta?.err) return false;
			return tx.meta?.logMessages?.some(
				(log) =>
					log.includes(driftClient.program.programId.toString()) ||
					log.includes(vaultClient.program.programId.toString())
			);
		});

		const transactionLogsAndSignatures = relevantTransactions.map((tx) => ({
			logs: tx.meta?.logMessages || [],
			signature: tx.transaction.signatures[0],
		}));

		const txSigsWithEvents = transactionLogsAndSignatures
			.map(({ logs, signature }) => {
				const driftEvents = parseLogs(driftClient.program, logs);

				const vaultEvents = parseLogs(
					vaultClient.program as unknown as Program<Idl>,
					logs,
					vaultClient.program.programId.toString()
				);

				const events = [...vaultEvents, ...driftEvents];
				return events.map((event) => ({ event, signature }));
			})
			.filter((events) => events.length > 0);

		if (txSigsWithEvents.length) {
			for (const txSigWithEvents of txSigsWithEvents) {
				const { signature } = txSigWithEvents[0];
				logger.info(
					`Adding ${txSigWithEvents.length} for slot:${slot}, tx:${signature} to the queue`
				);
				addToQueue(serializeEvents({ events: txSigWithEvents, slot }));
			}
		} else {
			consecutiveEmptySlots++;

			if (consecutiveEmptySlots >= EMPTY_SLOTS_BEFORE_SYNC) {
				await syncIngestionState({
					state: {
						...state,
						currentSlot: slot - EMPTY_SLOTS_BEFORE_SYNC,
					},
				});

				consecutiveEmptySlots = 0;
			}
		}
	};

	const getSlotAtBlockchainTip = async () => {
		const backoffOptions = {
			numOfAttempts: 3,
			startingDelay: 500,
			timeMultiple: 2,
			maxDelay: 10000,
			delayFirstAttempt: false,
			retry: (e: Error, attemptNumber: number) => {
				logger.warn(
					`Attempt ${attemptNumber} failed to get latest slot. Error: ${e.message}. Retrying...`
				);
				return true;
			},
		};

		try {
			await backOff(async () => {
				state.slotAtTip = await connection.getSlot('finalized');
			}, backoffOptions);
		} catch (error) {
			const { message } = error as Error;
			await logger.error(`Failed to get the latest slot after all retries: ${message}`);
		}
	};

	const serializeEvents = (chunk: {
		slot: number;
		events: { event: Event; signature: string }[];
	}) => {
		const serializedEvents = [];
		const { events, slot } = chunk;
		let runningEventIndex = 0;

		for (const { event, signature } of events) {
			event.data.txSig = signature;
			event.data.slot = slot;

			if (event.name === RecordTypes.OrderActionRecord) {
				event.data.eventType = RecordTypes.OrderActionRecord;
				event.data.marketFilter = enumToStr(event.data.marketType as MarketType);

				const isPredictionMarket = PREDICTION_MARKETS.find(
					(market) => market.marketIndex === event.data.marketIndex
				);

				if (enumToStr(event.data.marketType as MarketType) === enumToStr(MarketType.PERP)) {
					if (isPredictionMarket) {
						event.data.marketFilter = SerializedMarketFilter.PREDICTION;
					}
				}

				if (enumToStr(event.data.action as OrderAction) === enumToStr(OrderAction.FILL)) {
					if (isPredictionMarket) {
						event.data.eventType = RecordTypes.PredictionRecord;
					} else {
						event.data.eventType = RecordTypes.TradeRecord;
					}
				}
			} else if (event.name === RecordTypes.OrderRecord) {
				event.data.eventType = RecordTypes.OrderRecord;

				const { order } = event.data as OrderRecord & {
					order: Order & { marketFilter: string };
				};

				order.marketFilter = enumToStr(order.marketType);

				if (enumToStr(order.marketType as MarketType) === enumToStr(MarketType.PERP)) {
					const isPredictionMarket = PREDICTION_MARKETS.find(
						(market) => market.marketIndex === order.marketIndex
					);

					if (isPredictionMarket) {
						order.marketFilter = SerializedMarketFilter.PREDICTION;
					}
				}

				event.data.order = order;
			} else if (event.name === RecordTypes.DepositRecord) {
				event.data.eventType = RecordTypes.DepositRecord;

				if (
					enumToStr(event.data.explanation as DepositExplanation) ===
					enumToStr(DepositExplanation.REWARD)
				) {
					event.data.eventType = RecordTypes.RewardRecord;
				}
			} else {
				event.data.eventType = event.name;
			}

			event.data.txSigIndex = runningEventIndex;
			event.data.source = source;
			serializedEvents.push(simpleSerialize(event.data));
			runningEventIndex++;
		}

		return serializedEvents;
	};

	const incrementSlot = ({
		incrementBy,
	}: {
		incrementBy?: number;
	} = {}) => {
		const { currentSlot, slotAtTip } = state;

		if (slotAtTip && currentSlot > slotAtTip) {
			logger.info(`Cannot increment past the tip of the blockchain`);
			return;
		}

		if (incrementBy) {
			state.currentSlot += incrementBy;
			return;
		}

		state.currentSlot += state.shards;
	};

	const getQueue = () => {
		return eventQueue;
	};

	const addToQueue = (events: DriftEvent[]) => {
		return eventQueue.push(...events);
	};

	const addSlotsToFailedQueue = (slots: number[]) => {
		slots.forEach((slot) => {
			if (state.failedSlots.includes(slot)) {
				logger.info(`Slot ${slot} is already in the failed queue`);
				return;
			}

			if (shouldProcessSlot(slot, true)) state.failedSlots.push(slot);
		});
	};

	const addSlotsToSkippedQueue = (slots: number[]) => {
		slots.forEach((slot) => {
			if (state.skippedSlots.includes(slot)) {
				logger.info(`Slot ${slot} is already in the skipped queue`);
				return;
			}
			if (shouldProcessSlot(slot, true)) state.skippedSlots.push(slot);
		});
	};

	const addSlotsToMissedQueue = (slots: number[]) => {
		slots.forEach((slot) => {
			if (state.missedSlots.includes(slot)) {
				logger.info(`Slot ${slot} is already in the missed queue`);
				return;
			}
			if (shouldProcessSlot(slot, true)) state.missedSlots.push(slot);
		});
	};

	const addSlotsToIngestedQueue = (slots: number[]) => {
		slots.forEach((slot) => {
			if (state.ingestedSlots.includes(slot)) {
				logger.info(`Slot ${slot} is already in the ingested queue`);
				return;
			}
			if (shouldProcessSlot(slot, true)) state.ingestedSlots.push(slot);
		});
	};

	const offloadSlotsToRecords = async (type: SlotStatus) => {
		let queue: keyof Pick<
			IngestionState,
			'missedSlots' | 'failedSlots' | 'skippedSlots' | 'ingestedSlots'
		> = 'missedSlots';
		let callback: (slots: number[]) => Promise<Record<string, any>[]>;
		let slots: number[] = [];

		try {
			switch (type) {
				case SlotStatus.FAILED:
					queue = 'failedSlots';
					callback = createFailedSlotRecords;
					break;
				case SlotStatus.MISSED:
					queue = 'missedSlots';
					callback = createMissedSlotRecords;
					break;
				case SlotStatus.SKIPPED:
					queue = 'skippedSlots';
					callback = createSkippedSlotRecords;
					break;
				case SlotStatus.INGESTED:
					queue = 'ingestedSlots';
					callback = createIngestedSlotRecords;
					break;
			}

			slots = state[queue].splice(0);

			if (isGrpcSource()) {
				return;
			}

			if (slots.length > MAX_SLOTS_FOR_WARNING) {
				await logger.error(
					`Investigate shard: ${state.shardId}, attempting to offload ${slots.length} ${type} slots`
				);
			}

			const failedRecords = await callback(slots);
			if (failedRecords && failedRecords.length) {
				const failedSlots = failedRecords.map((record) => record.slot);
				state[queue].push(...failedSlots);
			}
		} catch (error) {
			const { message } = error as Error;
			await logger.error(`Failed to offload ${type} slots: ${message}`);
			state[queue].push(...slots);
			return;
		}
	};

	const syncIngestionState = async ({ state }: { state: IngestionState }) => {
		if (isGrpcSource() || fumarole) {
			return;
		}

		logger.info(`Updating state for latest ingested slot: ${state.currentSlot}`);

		return updateState({ state });
	};

	const sendToKinesis = async (records: DriftEvent[], syncState = true) => {
		const kinesisRecords = records.map((record) => ({
			Data: Buffer.from(JSON.stringify(record)),
			PartitionKey: record.slot.toString(),
		}));

		const { failedCount } = await putRecords(kinesisRecords);

		if (failedCount) {
			await logger.error(`Failed to ingest ${failedCount} records`);
			const uniqueSlots = new Set<number>();

			records.forEach((record) => {
				if (record.slot !== undefined) {
					uniqueSlots.add(record.slot);
				}
			});

			const failedSlotArray = [...uniqueSlots];
			await logger.error(`Failed slots: ${failedSlotArray.join(', ')}`);
			addSlotsToFailedQueue(failedSlotArray);
		}

		if (syncState) {
			const latestIngestedSlot = Math.max(...records.map((record) => record.slot));

			await syncIngestionState({
				state: {
					...state,
					currentSlot: latestIngestedSlot,
				},
			});
		}

		logger.info(`Success: ${kinesisRecords.length} events sent to kinesis`);
	};

	const shutdown = async (
		{
			syncState,
			skipOffloadRetrySlots,
		}: { syncState?: boolean; skipOffloadRetrySlots?: boolean } = {
			syncState: true,
			skipOffloadRetrySlots: false,
		}
	) => {
		const shouldSyncState = syncState ?? true;
		const shouldSkipOffloadRetries = skipOffloadRetrySlots ?? false;

		if (dryRun) {
			logger.info(`DRYRUN SHUTDOWN: ${JSON.stringify(state)}`);
			return;
		}

		if (shouldSkipOffloadRetries) {
			await Promise.all([
				sendToKinesis(getQueue().splice(0), shouldSyncState),
				offloadSlotsToRecords(SlotStatus.SKIPPED),
				offloadSlotsToRecords(SlotStatus.INGESTED),
			]);
		} else {
			await Promise.all([
				sendToKinesis(getQueue().splice(0), shouldSyncState),
				offloadSlotsToRecords(SlotStatus.MISSED),
				offloadSlotsToRecords(SlotStatus.FAILED),
				offloadSlotsToRecords(SlotStatus.SKIPPED),
				offloadSlotsToRecords(SlotStatus.INGESTED),
			]);
		}
	};

	return {
		ingestionIsPaused,
		getSlotAtBlockchainTip,
		shouldProcessSlot,
		processSlot,
		processSlotWithBackoff,
		incrementSlot,
		addSlotsToFailedQueue,
		addSlotsToMissedQueue,
		addSlotsToSkippedQueue,
		addSlotsToIngestedQueue,
		offloadSlotsToRecords,
		syncIngestionState,
		serializeEvents,
		sendToKinesis,
		shutdown,
		getQueue,
		addToQueue,
	};
};
