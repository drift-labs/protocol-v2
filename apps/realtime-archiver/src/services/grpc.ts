import { DEFAULT_ENDPOINT, IngestionSource, IngestionState, logger, sleep } from '@backend/common';
import { Idl, Program } from '@coral-xyz/anchor';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';
import { getVaultClient } from '@velocity-exchange/vaults-sdk';
import { Connection, Keypair } from '@solana/web3.js';
import Client, { CommitmentLevel } from '@triton-one/yellowstone-grpc';
import { VelocityClient, VelocityEnv, parseLogs, Wallet } from '@velocity-exchange/sdk';
import { Ingestion } from './ingestion';
import {
	incrementDriftTransactionErrors,
	incrementDriftTransactions,
	incrementReconnectAttempts,
	incrementReconnectFailures,
} from './metrics';

const ENDPOINT = process.env.ENDPOINT ?? DEFAULT_ENDPOINT;
const URL = process.env.URL ?? ENDPOINT.slice(0, ENDPOINT.lastIndexOf('/'));
const TOKEN = process.env.TOKEN ?? ENDPOINT.slice(ENDPOINT.lastIndexOf('/') + 1);

const MAX_RECONNECT_ATTEMPTS = 5;
const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 20000;

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

export const GrpcEventSubscriber = ({ dryRun }: { dryRun?: boolean } = {}) => {
	let isShuttingDown = false;
	let isReconnecting = false;
	let reconnectAttempts = 0;
	let currentDelay = INITIAL_RECONNECT_DELAY;
	let client: Client;
	let stream: Awaited<ReturnType<Client['subscribe']>> | null;
	let lastEventTime = Date.now();

	const { addToQueue, serializeEvents } = Ingestion({
		state: defaultState,
		driftClient,
		vaultClient,
		connection,
		source: IngestionSource.GRPC,
		batchTime: 200,
	});

	const setupStreamHandlers = () => {
		if (!stream) return;

		stream.on('data', (chunk) => {
			if (!chunk.transaction) {
				return;
			}

			incrementDriftTransactions();

			lastEventTime = Date.now();

			if (chunk.transaction.transaction.meta?.err) {
				incrementDriftTransactionErrors();
				return;
			}

			const slot = Number(chunk.transaction.slot);
			const signature = bs58.encode(chunk.transaction.transaction.signature);
			const logs = chunk.transaction.transaction.meta.logMessages;

			const vaultEvents = parseLogs(
				vaultClient.program as unknown as Program<Idl>,
				logs,
				vaultClient.program.programId.toString()
			);

			const driftEvents = parseLogs(driftClient.program, logs);

			const parsedEvents = [...vaultEvents, ...driftEvents];
			const eventWithSig = parsedEvents.map((event) => ({ event, signature }));

			if (dryRun) {
				logger.info(
					`DRYRUN: ${JSON.stringify(serializeEvents({ events: eventWithSig, slot }))}`
				);
				return;
			}
			addToQueue(serializeEvents({ events: eventWithSig, slot }));
		});

		stream.on('error', async (error: Error) => {
			if (!isReconnecting) {
				logger.warn(`Stream error: ${error.message}`);
				await reconnect();
			}
		});

		stream.on('end', async () => {
			if (!isReconnecting) {
				logger.info('Stream ended');
				await reconnect();
			}
		});
	};

	const reconnect = async () => {
		if (isShuttingDown) return;

		isReconnecting = true;

		if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			throw Error('Maximum reconnection attempts reached. Stopping reconnection attempts.');
		}

		logger.info(
			`Attempting to reconnect... (Attempt ${
				reconnectAttempts + 1
			}/${MAX_RECONNECT_ATTEMPTS})`
		);
		incrementReconnectAttempts();

		try {
			await sleep(currentDelay);

			currentDelay = Math.min(currentDelay * 2, MAX_RECONNECT_DELAY);
			reconnectAttempts++;

			if (stream) {
				stream.destroy();
			}

			await start();

			reconnectAttempts = 0;
			currentDelay = INITIAL_RECONNECT_DELAY;

			logger.info('Successfully reconnected');
		} catch (error) {
			const { message } = error as Error;
			logger.warn(`Reconnection failed: ${message}`);
			incrementReconnectFailures();
			await reconnect();
		} finally {
			isReconnecting = false;
		}
	};

	const start = async () => {
		try {
			logger.info('Starting GRPC event subscriber...');
			client = new Client(URL, TOKEN, {
				grpcHttp2AdaptiveWindow: true,
				grpcDefaultCompressionAlgorithm: 1,
			});
			await client.connect();
			stream = await client.subscribe();

			setupStreamHandlers();

			const request = {
				slots: {},
				accounts: {},
				transactions: {
					drift: {
						vote: false,
						// failed: false,
						accountInclude: [
							driftClient.program.programId.toString(),
							vaultClient.program.programId.toString(),
						],
						accountExclude: [],
						accountRequired: [],
					},
				},
				blocks: {},
				blocksMeta: {},
				accountsDataSlice: [],
				commitment: CommitmentLevel.CONFIRMED,
				entry: {},
				transactionsStatus: {},
			};

			return new Promise<void>((resolve, reject) => {
				if (stream) {
					stream.write(request, (err) => {
						if (err === null || err === undefined) {
							resolve();
						} else {
							reject(err);
						}
					});
				}
			});
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Failed to start GRPC event subscriber: ${message}`);
			throw error;
		}
	};

	const stop = async () => {
		isShuttingDown = true;

		try {
			if (stream) {
				const request = {
					slots: {},
					accounts: {},
					transactions: {},
					blocks: {},
					blocksMeta: {},
					accountsDataSlice: [],
					entry: {},
					transactionsStatus: {},
				};

				await new Promise<void>((resolve, reject) => {
					if (stream) {
						stream.write(request, (err) => {
							if (err === null || err === undefined) {
								resolve();
							} else {
								reject(err);
							}
						});
					}
				});

				stream.destroy();
				stream = null;
			}
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error during unsubscribe: ${message}`);
			throw error;
		}
	};

	const getLastEventTime = () => {
		return lastEventTime;
	};

	return { start, stop, getLastEventTime };
};
