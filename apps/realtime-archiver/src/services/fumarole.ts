import { DEFAULT_ENDPOINT, IngestionSource, IngestionState, logger, sleep } from '@backend/common';
import { Idl, Program } from '@coral-xyz/anchor';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';
import { getVaultClient } from '@velocity-exchange/vaults-sdk';
import { Connection, Keypair } from '@solana/web3.js';
import {
	CommitmentLevel,
	FumaroleClient,
	SubscribeRequest,
	SubscribeUpdate,
} from '@triton-one/yellowstone-fumarole';
import { VelocityClient, VelocityEnv, parseLogs, Wallet } from '@velocity-exchange/sdk';
import { config as rxjsConfig, Subscription } from 'rxjs';
import { Ingestion } from './ingestion';
import {
	incrementDriftTransactionErrors,
	incrementDriftTransactions,
	incrementForcedReconnectAttempts,
	incrementReconnectAttempts,
	incrementReconnectFailures,
	updateSlotDifference,
} from './metrics';

const ENDPOINT = process.env.ENDPOINT ?? DEFAULT_ENDPOINT;
const FUMAROLE_ENDPOINT = process.env.FUMAROLE_ENDPOINT ?? 'https://ams.rpcpool.com';
const FUMAROLE_X_TOKEN = process.env.FUMAROLE_X_TOKEN;
if (!FUMAROLE_X_TOKEN) {
	throw new Error('FUMAROLE_X_TOKEN env var is required');
}

const MAX_RECONNECT_ATTEMPTS = 5;
const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 20000;
const MAX_SLOT_DIFFERENCE = process.env.MAX_SLOT_DIFFERENCE
	? parseInt(process.env.MAX_SLOT_DIFFERENCE)
	: 500;
const SLOT_DIFFERENCE_CHECK_INTERVAL_MS = 20000;

const connection = new Connection(ENDPOINT, 'finalized');
const wallet = new Wallet(new Keypair());

const driftClient = new VelocityClient({
	env: (process.env.ENV ?? 'mainnet-beta') as VelocityEnv,
	connection,
	wallet,
});

const vaultClient = getVaultClient(connection, wallet, driftClient);

const defaultState: IngestionState = {
	id: 'primary',
	currentSlot: 0,
	shards: 1,
	shardId: 0,
	paused: false,
	ingestedSlots: [],
	bypassSlots: [],
	skippedSlots: [],
	failedSlots: [],
	missedSlots: [],
};

export const FumaroleEventSubscriber = ({
	subscriberName,
	dryRun,
}: {
	subscriberName: string;
	dryRun?: boolean;
}) => {
	let client: FumaroleClient | null = null;
	let source: any = null;
	let isShuttingDown = false;
	let isReconnecting = false;
	let reconnectAttempts = 0;
	let currentDelay = INITIAL_RECONNECT_DELAY;
	let lastEventTime = Date.now();
	let latestObservedSlot = 0;
	let lagCheckInterval: NodeJS.Timeout | null = null;
	let lagCheckInFlight = false;
	let streamSubscription: Subscription | null = null;
	let rxjsUnhandledHookInstalled = false;
	let previousRxjsUnhandledErrorHandler: ((err: any) => void) | null = null;

	const {
		getSlotAtBlockchainTip,
		addToQueue,
		serializeEvents,
		addSlotsToIngestedQueue,
		addSlotsToSkippedQueue,
		shutdown,
	} = Ingestion({
		state: defaultState,
		driftClient,
		vaultClient,
		connection,
		source: IngestionSource.SEQUENTIAL,
		batchTime: 200,
		dryRun,
		fumarole: true,
	});

	const processUpdates = async () => {
		if (!source) return;

		try {
			streamSubscription = source.subscribe({
				next: (update: SubscribeUpdate) => {
					if (isShuttingDown) {
						logger.info('Shutdown detected, stopping update processing');
						return;
					}

					lastEventTime = Date.now();
					let slotNumber: number | undefined;

					if (update.transaction) {
						const { transaction, slot } = update.transaction;

						if (!transaction || !slot) {
							return;
						}

						slotNumber = Number(slot);
						incrementDriftTransactions();

						// Skip failed transactions
						if (transaction.meta?.err) {
							incrementDriftTransactionErrors();
							return;
						}

						const logs = transaction.meta?.logMessages || [];
						const signature = bs58.encode(transaction.signature);

						const vaultEvents = parseLogs(
							vaultClient.program as unknown as Program<Idl>,
							logs,
							vaultClient.program.programId.toString()
						);
						const driftEvents = parseLogs(driftClient.program, logs);

						const parsedEvents = [...vaultEvents, ...driftEvents];

						if (parsedEvents.length > 0) {
							const eventWithSig = parsedEvents.map((event) => ({
								event,
								signature,
							}));
							if (dryRun) {
								logger.info(
									`DRYRUN: ${JSON.stringify(
										serializeEvents({ events: eventWithSig, slot: slotNumber })
									)}`
								);
							} else {
								addToQueue(
									serializeEvents({ events: eventWithSig, slot: slotNumber })
								);
							}
						}
					}

					if (update.slot) {
						slotNumber = Number(update.slot.slot);
						const parent = Number(update.slot.parent);
						const missingSlots: number[] = [];
						for (let slot = parent + 1; slot < slotNumber; slot++) {
							missingSlots.push(slot);
						}
						if (missingSlots.length > 0) {
							addSlotsToSkippedQueue(missingSlots);
							addSlotsToIngestedQueue(missingSlots);
							logger.info(
								`Detected ${
									missingSlots.length
								} skipped slots between ${parent} and ${slotNumber}. Adding skipped slots: ${JSON.stringify(
									missingSlots
								)}`
							);
						}

						addSlotsToIngestedQueue([slotNumber]);
						logger.info(
							`Successfully processed slot ${slotNumber} (parent: ${parent})`
						);
					}

					if (slotNumber !== undefined) {
						latestObservedSlot = Math.max(latestObservedSlot, slotNumber);
						defaultState.currentSlot = latestObservedSlot;
					}
				},
				error: async (error: Error) => {
					if (!isShuttingDown) {
						logger.warn(`Stream processing error: ${error.message}`);
						await reconnect();
					}
				},
			});
		} catch (error) {
			if (!isShuttingDown) {
				const { message } = error as Error;
				logger.warn(`Failed to subscribe to updates: ${message}`);
				await reconnect();
			}
		}
	};

	const installRxjsUnhandledErrorHook = () => {
		if (rxjsUnhandledHookInstalled) return;

		previousRxjsUnhandledErrorHandler = rxjsConfig.onUnhandledError ?? null;
		rxjsConfig.onUnhandledError = (error: unknown) => {
			const { message } = error as Error;
			logger.info(
				`RxJS unhandled stream error (intercepted): ${message}. Triggering reconnect.`
			);

			if (!isShuttingDown) {
				void reconnect();
			}
		};
		rxjsUnhandledHookInstalled = true;
	};

	const uninstallRxjsUnhandledErrorHook = () => {
		if (!rxjsUnhandledHookInstalled) return;
		rxjsConfig.onUnhandledError = previousRxjsUnhandledErrorHandler;
		previousRxjsUnhandledErrorHandler = null;
		rxjsUnhandledHookInstalled = false;
	};

	const teardownStream = async () => {
		if (streamSubscription) {
			streamSubscription.unsubscribe();
			streamSubscription = null;
			await sleep(250);
		}
		source = null;
	};

	const reconnect = async (fromTip?: boolean) => {
		if (isShuttingDown) return;

		isReconnecting = true;

		if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			throw Error('Maximum reconnection attempts reached. Stopping reconnection attempts.');
		}

		logger.info(
			`Attempting to reconnect from ${fromTip ? 'tip' : 'current position'}... (Attempt ${
				reconnectAttempts + 1
			}/${MAX_RECONNECT_ATTEMPTS})`
		);
		incrementReconnectAttempts();

		try {
			await sleep(currentDelay);

			currentDelay = Math.min(currentDelay * 2, MAX_RECONNECT_DELAY);
			reconnectAttempts++;

			await teardownStream();
			if (client) client = null;

			await start(fromTip);

			reconnectAttempts = 0;
			currentDelay = INITIAL_RECONNECT_DELAY;
			logger.info('Successfully reconnected');
		} catch (error) {
			const { message } = error as Error;
			logger.warn(`Reconnection failed: ${message}`);
			incrementReconnectFailures();
			await reconnect(fromTip);
		} finally {
			isReconnecting = false;
		}
	};

	const startLagCheck = () => {
		if (lagCheckInterval) {
			clearInterval(lagCheckInterval);
		}

		lagCheckInterval = setInterval(async () => {
			if (isShuttingDown || isReconnecting || !client || lagCheckInFlight) {
				return;
			}

			lagCheckInFlight = true;
			try {
				logger.info('Performing slot lag check between subscriber and blockchain tip');
				await getSlotAtBlockchainTip();
				const slotAtTip = defaultState.slotAtTip;

				if (slotAtTip === undefined || latestObservedSlot === 0) {
					return;
				}

				updateSlotDifference(latestObservedSlot, slotAtTip);
				const slotLag = slotAtTip - latestObservedSlot;
				if (slotLag <= MAX_SLOT_DIFFERENCE) {
					logger.info(
						`Current slot lag is ${slotLag}, which is within the acceptable threshold of ${MAX_SLOT_DIFFERENCE}. Continuing to monitor.`
					);
					return;
				}

				logger.warn(
					`Persistent subscriber is ${slotLag} slots behind tip (${latestObservedSlot}/${slotAtTip}). Recreating from tip.`
				);
				incrementForcedReconnectAttempts();
				await reconnect(true);
			} catch (error) {
				const { message } = error as Error;
				logger.warn(`Lag check failed: ${message}`);
			} finally {
				lagCheckInFlight = false;
			}
		}, SLOT_DIFFERENCE_CHECK_INTERVAL_MS);
	};

	const start = async (fromTip?: boolean) => {
		try {
			logger.info(
				`Starting Fumarole event subscriber from ${fromTip ? 'tip' : 'current position'}...`
			);

			const config = {
				endpoint: FUMAROLE_ENDPOINT,
				xToken: FUMAROLE_X_TOKEN,
				maxDecodingMessageSizeBytes: 100 * 1024 * 1024,
			};

			client = await FumaroleClient.connect(config);

			if (!client) {
				throw new Error('Failed to connect to Fumarole');
			}
			logger.info('Connected to Fumarole successfully');

			await teardownStream();

			let consumer = null;
			if (fromTip || process.env.SLOT) {
				logger.info('Deleting persistent subscriber and recreating from tip');
				await client.deletePersistentSubscriber(subscriberName).catch(() => null);
			}
			consumer = await client.getPersistentSubscriberInfo(subscriberName).catch(async (e) => {
				if (client && e.message.toLowerCase().includes('not found')) {
					logger.info(
						'Subscriber not found, creating new persistent subscriber from tip'
					);
					await client.createPersistentSubscriber(
						subscriberName,
						process.env.SLOT ? BigInt(process.env.SLOT) : undefined
					);
					return client.getPersistentSubscriberInfo(subscriberName);
				}
				throw e;
			});

			if (!consumer) {
				throw new Error('Failed to create or retrieve consumer group');
			}

			const driftProgramId = driftClient.program.programId.toString();
			const vaultProgramId = vaultClient.program.programId.toString();

			const request: SubscribeRequest = {
				commitment: CommitmentLevel.FINALIZED,
				accounts: {},
				transactions: {
					drift: {
						accountInclude: [driftProgramId, vaultProgramId],
						accountExclude: [],
						accountRequired: [],
					},
				},
				slots: {
					monitoring: {
						filterByCommitment: true,
					},
				},
				transactionsStatus: {},
				blocks: {},
				blocksMeta: {},
				entry: {},
				ping: { id: Date.now() },
				accountsDataSlice: [],
				fromSlot: undefined,
			};

			const { sink: _sink, source: streamSource } = await client.dragonsmouthSubscribe(
				subscriberName,
				request
			);

			installRxjsUnhandledErrorHook();
			source = streamSource;
			logger.info('Fumarole subscription established');

			startLagCheck();

			// Start processing updates
			processUpdates();
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Failed to start Fumarole event subscriber: ${message}`);
			throw error;
		}
	};

	const stop = async () => {
		isShuttingDown = true;
		logger.info('Stopping Fumarole event subscriber...');

		try {
			if (lagCheckInterval) {
				clearInterval(lagCheckInterval);
				lagCheckInterval = null;
			}

			await teardownStream();

			if (client) {
				logger.info('Fumarole client closed');
				client = null;
			}
			uninstallRxjsUnhandledErrorHook();
			await shutdown();
			logger.info('Ingestion service shutdown complete');
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error during Fumarole shutdown: ${message}`);
			throw error;
		}
	};

	const getLastEventTime = () => {
		return lastEventTime;
	};

	return { start, stop, getLastEventTime };
};
