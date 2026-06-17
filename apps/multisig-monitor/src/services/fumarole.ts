/**
 * Fumarole-based stream consumer for multisig + council-signer activity.
 *
 * Pattern mirrors realtime-archiver's fumarole subscriber: persistent named
 * subscriber for durable resume-from-checkpoint, exponential-backoff
 * reconnect, RxJS unhandled-error interception. Two subscriptions multiplex
 * onto the same stream:
 *
 *   1. transactions['multisig-activity']  — multisig ops + tx-stream signer
 *      events. Caught by `extractOperations` + `extractSignerEvents` in the
 *      processor.
 *
 *   2. accounts['council-nonce-<signer>']  — nonce accounts whose authority
 *      arg equals a watched council signer. CRITICAL: this is the only path
 *      that catches the Apr 1 attack pattern — the malicious tx referenced
 *      the council signer pubkey only inside the InitializeNonceAccount
 *      *data*, so Yellowstone's tx-side accountInclude never matches.
 *
 * The seen-nonces store gates account-stream alerts: snapshot updates
 * (`isStartup: true`) prime the store without alerting; post-snapshot
 * updates fire alerts only if the nonce wasn't already known.
 */
import { logger, sleep } from '@backend/common';
import { Connection } from '@solana/web3.js';
import {
	CommitmentLevel,
	FumaroleClient,
	type SubscribeRequest,
	type SubscribeUpdate,
} from '@triton-one/yellowstone-fumarole';
import { config as rxjsConfig, Subscription } from 'rxjs';
import type { Config } from '../config';
import { handleAccountUpdate } from './account-handler';
import {
	HealthStatus,
	incrementAccountUpdatesReceived,
	incrementForcedReconnectAttempts,
	incrementReconnectAttempts,
	incrementReconnectFailures,
	incrementTxUpdatesReceived,
	recordEventReceived,
	updateHealthStatus,
	updateSlotLag,
} from './metrics';
import { processTransactions } from './processor';
import type { StateStore } from './state';

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const NONCE_ACCOUNT_DATA_LEN = 80n;
const NONCE_AUTHORITY_OFFSET = 8n;

const MAX_RECONNECT_ATTEMPTS = 5;
const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 20_000;
const SLOT_LAG_CHECK_INTERVAL_MS = 20_000;

export interface MultisigFumaroleSubscriber {
	start(fromTip?: boolean): Promise<void>;
	stop(): Promise<void>;
	getLastEventTime(): number;
}

export function MultisigFumaroleSubscriber(
	config: Config,
	store: StateStore
): MultisigFumaroleSubscriber {
	let client: FumaroleClient | null = null;
	let source: any = null;
	let isShuttingDown = false;
	let isReconnecting = false;
	let reconnectAttempts = 0;
	let currentDelay = INITIAL_RECONNECT_DELAY;
	let lastEventTime = Date.now();
	let latestObservedSlot = 0;
	let streamSubscription: Subscription | null = null;
	let rxjsHookInstalled = false;
	let previousRxjsUnhandledErrorHandler: ((err: any) => void) | null = null;
	let slotLagInterval: NodeJS.Timeout | null = null;
	let slotLagInFlight = false;

	const rpcConnection = config.rpcUrl ? new Connection(config.rpcUrl, 'confirmed') : null;

	/**
	 * One account filter per council signer: SystemProgram-owned accounts of
	 * size 80 (nonce account layout) where bytes [8..40) (the authority field)
	 * equal the signer pubkey.
	 */
	const accountFilters = (): SubscribeRequest['accounts'] => {
		const filters: SubscribeRequest['accounts'] = {};
		for (const signer of config.signerAddresses) {
			filters[`council-nonce-${signer}`] = {
				account: [],
				owner: [SYSTEM_PROGRAM_ID],
				filters: [
					{ datasize: NONCE_ACCOUNT_DATA_LEN },
					{
						memcmp: {
							offset: NONCE_AUTHORITY_OFFSET,
							base58: signer,
						},
					},
				],
			};
		}
		return filters;
	};

	const subscribeRequest = (): SubscribeRequest => ({
		commitment: CommitmentLevel.CONFIRMED,
		accounts: accountFilters(),
		transactions: {
			'multisig-activity': {
				vote: false,
				failed: false,
				accountInclude: [...config.multisigAddresses, ...config.signerAddresses],
				accountExclude: [],
				accountRequired: [],
			},
		},
		// Slot updates serve as a stream heartbeat. Without this, when the
		// multisig + signer filters don't match anything (typical for
		// emergency-use councils), the stream is genuinely silent server-side
		// and last_event_age_ms climbs unboundedly even when subscribed.
		slots: {
			monitoring: { filterByCommitment: true },
		},
		transactionsStatus: {},
		blocks: {},
		blocksMeta: {},
		entry: {},
		accountsDataSlice: [],
		ping: { id: Date.now() },
		fromSlot: config.fumarole.fromSlot,
	});

	const processUpdates = () => {
		if (!source) return;

		streamSubscription = source.subscribe({
			next: (update: SubscribeUpdate) => {
				if (isShuttingDown) return;
				lastEventTime = Date.now();
				recordEventReceived();

				if (update.transaction) {
					incrementTxUpdatesReceived();
					const slot = Number(update.transaction.slot);
					logger.info(`transaction ${slot}`);
					if (slot > latestObservedSlot) latestObservedSlot = slot;
					processTransactions([update], config, store).catch(async (err) => {
						const { message } = err as Error;
						await logger.error(`processTransactions failed: ${message}`);
					});
				}

				if (update.account) {
					incrementAccountUpdatesReceived();
					const slot = Number(update.account.slot);
					logger.info(`account ${slot}`);
					if (slot > latestObservedSlot) latestObservedSlot = slot;
					handleAccountUpdate(update, config, store).catch(async (err) => {
						const { message } = err as Error;
						await logger.error(`handleAccountUpdate failed: ${message}`);
					});
				}

				// Slot updates are heartbeat-only. They keep lastEventTime fresh
				// and feed latestObservedSlot for the lag-check. We don't log
				// each one (would flood at ~2/sec).
				if (update.slot) {
					const slot = Number(update.slot.slot);
					if (slot > latestObservedSlot) latestObservedSlot = slot;
				}
			},
			error: async (err: Error) => {
				if (!isShuttingDown) {
					await logger.warn(`Stream processing error: ${err.message}`);
					await reconnect();
				}
			},
		});
	};

	/**
	 * Lag-detection: every SLOT_LAG_CHECK_INTERVAL_MS we ask the configured RPC
	 * for the current finalized slot and compare to the highest slot we've seen
	 * on the stream. If we're more than `maxSlotDifference` slots behind tip,
	 * the persistent subscriber has likely fallen behind unrecoverably — force
	 * a reconnect from-tip. No-op when no RPC URL is configured.
	 */
	const startSlotLagCheck = () => {
		if (slotLagInterval) clearInterval(slotLagInterval);
		if (!rpcConnection) return;

		slotLagInterval = setInterval(async () => {
			if (isShuttingDown || isReconnecting || slotLagInFlight) return;
			slotLagInFlight = true;
			try {
				const tip = await rpcConnection.getSlot('finalized');
				if (latestObservedSlot === 0) return;
				const lag = tip - latestObservedSlot;
				updateSlotLag(lag);
				if (lag > config.fumarole.maxSlotDifference) {
					await logger.warn(
						`Subscriber is ${lag} slots behind tip (${latestObservedSlot}/${tip}). Forcing reconnect from tip.`
					);
					incrementForcedReconnectAttempts();
					updateHealthStatus(HealthStatus.NotOk);
					await reconnect(true);
				} else {
					updateHealthStatus(HealthStatus.Ok);
				}
			} catch (err) {
				const { message } = err as Error;
				await logger.warn(`Slot lag check failed: ${message}`);
			} finally {
				slotLagInFlight = false;
			}
		}, SLOT_LAG_CHECK_INTERVAL_MS);
	};

	const stopSlotLagCheck = () => {
		if (slotLagInterval) {
			clearInterval(slotLagInterval);
			slotLagInterval = null;
		}
	};

	const installRxjsUnhandledErrorHook = () => {
		if (rxjsHookInstalled) return;
		previousRxjsUnhandledErrorHandler = rxjsConfig.onUnhandledError ?? null;
		rxjsConfig.onUnhandledError = (err: unknown) => {
			const { message } = err as Error;
			logger.info(`RxJS unhandled stream error (intercepted): ${message}. Reconnecting.`);
			if (!isShuttingDown) void reconnect();
		};
		rxjsHookInstalled = true;
	};

	const uninstallRxjsUnhandledErrorHook = () => {
		if (!rxjsHookInstalled) return;
		rxjsConfig.onUnhandledError = previousRxjsUnhandledErrorHandler;
		previousRxjsUnhandledErrorHandler = null;
		rxjsHookInstalled = false;
	};

	const teardownStream = async () => {
		if (streamSubscription) {
			streamSubscription.unsubscribe();
			streamSubscription = null;
			await sleep(250);
		}
		source = null;
	};

	const reconnect = async (fromTip?: boolean): Promise<void> => {
		if (isShuttingDown) return;
		isReconnecting = true;

		if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			incrementReconnectFailures();
			throw new Error('Maximum reconnection attempts reached.');
		}

		logger.info(
			`Reconnecting (attempt ${
				reconnectAttempts + 1
			}/${MAX_RECONNECT_ATTEMPTS}, fromTip=${Boolean(fromTip)})`
		);
		incrementReconnectAttempts();

		try {
			await sleep(currentDelay);
			currentDelay = Math.min(currentDelay * 2, MAX_RECONNECT_DELAY);
			reconnectAttempts++;

			await teardownStream();
			client = null;

			await start(fromTip);

			reconnectAttempts = 0;
			currentDelay = INITIAL_RECONNECT_DELAY;
			logger.info('Reconnected.');
		} catch (err) {
			const { message } = err as Error;
			await logger.warn(`Reconnect failed: ${message}`);
			incrementReconnectFailures();
			await reconnect(fromTip);
		} finally {
			isReconnecting = false;
		}
	};

	const start = async (fromTip?: boolean) => {
		try {
			logger.info(
				`Starting Fumarole subscriber '${
					config.fumarole.subscriberName
				}' (fromTip=${Boolean(fromTip)})`
			);

			client = await FumaroleClient.connect({
				endpoint: config.fumarole.endpoint,
				xToken: config.fumarole.xToken,
				maxDecodingMessageSizeBytes: 100 * 1024 * 1024,
			});
			if (!client) throw new Error('Failed to connect to Fumarole');

			await teardownStream();

			if (fromTip || config.fumarole.fromSlot !== undefined) {
				logger.info(`Resetting persistent subscriber '${config.fumarole.subscriberName}'`);
				await client
					.deletePersistentSubscriber(config.fumarole.subscriberName)
					.catch(() => null);
			}

			await client
				.getPersistentSubscriberInfo(config.fumarole.subscriberName)
				.catch(async (err) => {
					if (client && err.message?.toLowerCase?.().includes('not found')) {
						logger.info(
							`Subscriber '${
								config.fumarole.subscriberName
							}' not found, creating from ${config.fumarole.fromSlot ?? 'tip'}`
						);
						await client.createPersistentSubscriber(
							config.fumarole.subscriberName,
							config.fumarole.fromSlot
						);
						return client.getPersistentSubscriberInfo(config.fumarole.subscriberName);
					}
					throw err;
				});

			const { source: streamSource } = await client.dragonsmouthSubscribe(
				config.fumarole.subscriberName,
				subscribeRequest()
			);

			installRxjsUnhandledErrorHook();
			source = streamSource;
			logger.info('Fumarole subscription established');

			startSlotLagCheck();
			processUpdates();
		} catch (err) {
			const { message } = err as Error;
			await logger.error(`Failed to start Fumarole subscriber: ${message}`);
			throw err;
		}
	};

	const stop = async () => {
		isShuttingDown = true;
		logger.info('Stopping Fumarole subscriber...');
		try {
			stopSlotLagCheck();
			await teardownStream();
			client = null;
			uninstallRxjsUnhandledErrorHook();
			logger.info('Fumarole subscriber stopped');
		} catch (err) {
			const { message } = err as Error;
			await logger.error(`Error during shutdown: ${message}`);
		}
	};

	const getLastEventTime = () => lastEventTime;

	return { start, stop, getLastEventTime };
}
