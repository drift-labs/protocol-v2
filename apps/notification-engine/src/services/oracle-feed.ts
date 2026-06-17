import {
	bnStringToNumber,
	DEFAULT_ENDPOINT,
	DEFAULT_SNS_TOPIC,
	getTimestamp,
	logger,
	NotificationType,
	simpleSerialize,
	sleep,
} from '@backend/common';
import { SNS } from '@backend/sns';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import Client, { CommitmentLevel } from '@triton-one/yellowstone-grpc';
import {
	DelistedMarketSetting,
	VelocityClient,
	VelocityEnv,
	initialize,
	PerpMarketConfig,
	PRICE_PRECISION,
	SpotMarketConfig,
	Wallet,
} from '@velocity-exchange/sdk';
import { OracleClientCache } from '@velocity-exchange/sdk/lib/node/oracles/oracleClientCache';
import { LastPriceInfo, OracleData, OraclePriceData } from '../types';

const driftEnv = (process.env.ENV ?? 'mainnet-beta') as VelocityEnv;
const { SPOT_MARKETS, PERP_MARKETS } = initialize({ env: driftEnv });

const ORACLE_MAP = [...SPOT_MARKETS, ...PERP_MARKETS].reduce(
	(acc, market) => {
		const key = `${market.symbol}_${market.oracle.toString()}`;
		acc[key] = market;
		return acc;
	},
	{} as Record<string, PerpMarketConfig | SpotMarketConfig>
);

const ORACLE_TO_COMPOSITE_KEYS = [...SPOT_MARKETS, ...PERP_MARKETS].reduce(
	(acc, market) => {
		const oracleKey = market.oracle.toString();
		const compositeKey = `${market.symbol}_${oracleKey}`;

		if (!acc[oracleKey]) {
			acc[oracleKey] = [];
		}
		acc[oracleKey].push(compositeKey);
		return acc;
	},
	{} as Record<string, string[]>
);

const connection = new Connection(process.env.ENDPOINT || DEFAULT_ENDPOINT, 'confirmed');
const driftClient = new VelocityClient({
	connection,
	wallet: new Wallet(new Keypair()),
	env: driftEnv,
	delistedMarketSetting: DelistedMarketSetting.Discard,
});

const program = driftClient.program;
const oracleClientCache = new OracleClientCache();

const ENDPOINT = process.env.ENDPOINT ?? DEFAULT_ENDPOINT;
const URL = process.env.URL ?? ENDPOINT.slice(0, ENDPOINT.lastIndexOf('/'));
const TOKEN = process.env.TOKEN ?? ENDPOINT.slice(ENDPOINT.lastIndexOf('/') + 1);

const MAX_RECONNECT_ATTEMPTS = 5;
const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;

const PRICE_THRESHOLD = parseFloat(process.env.PRICE_THRESHOLD || '0.001');
const MIN_UPDATE_INTERVAL = parseInt(process.env.MIN_UPDATE_INTERVAL || '5');

const TOPIC_ARN = process.env.SNS_TOPIC_ARN! ?? DEFAULT_SNS_TOPIC;
const FIFO_TOPIC_ARN = process.env.SNS_FIFO_TOPIC_ARN!;

export const OracleFeed = ({ dryRun = false }: { dryRun?: boolean } = {}) => {
	let stream: any;
	let isShuttingDown = false;
	let isReconnecting = false;
	let reconnectAttempts = 0;
	let currentDelay: number = INITIAL_RECONNECT_DELAY;

	const { publishMessage } = SNS();

	const lastPrices: Record<string, LastPriceInfo> = {};

	const shouldPublishPrice = (compositeKey: string, data: OracleData): boolean => {
		const last = lastPrices[compositeKey];
		if (!last) return true;

		const timeElapsed = getTimestamp() - last.lastPublished;
		if (timeElapsed < MIN_UPDATE_INTERVAL) return false;

		const priceChange = Math.abs(data.price - last.price) / last.price;

		return priceChange >= PRICE_THRESHOLD;
	};

	const publishToSNS = async (compositeKey: string, data: OracleData) => {
		try {
			const market = ORACLE_MAP[compositeKey];
			if (!market) {
				logger.error(`Market not found for composite key: ${compositeKey}`);
				return;
			}

			const [symbol, oracleAddress] = compositeKey.split('_', 2);

			const priceData: OraclePriceData = {
				oracle: oracleAddress,
				symbol: symbol,
				price: data.price,
				confidence: data.confidence,
				timestamp: getTimestamp(),
				slot: data.slot,
				priceChange: lastPrices[compositeKey]
					? (data.price - lastPrices[compositeKey].price) / lastPrices[compositeKey].price
					: 0,
			};

			const message = JSON.stringify({ type: NotificationType.PRICE_ALERT, data: priceData });
			const messageAttributes = {
				type: {
					DataType: 'String',
					StringValue: NotificationType.PRICE_ALERT,
				},
				oracle: {
					DataType: 'String',
					StringValue: oracleAddress,
				},
				symbol: {
					DataType: 'String',
					StringValue: symbol,
				},
			};

			const standardParams = {
				topicArn: TOPIC_ARN,
				message,
				messageAttributes,
			};

			const fifoParams = {
				topicArn: FIFO_TOPIC_ARN,
				message,
				messageAttributes,
				messageGroupId: symbol,
				messageDeduplicationId: `${compositeKey}-${data.slot}-${getTimestamp()}`,
			};

			if (dryRun) {
				logger.info(
					`DRY RUN: ${JSON.stringify(standardParams)} ${JSON.stringify(fifoParams)}`
				);
			} else {
				await Promise.all([publishMessage(standardParams), publishMessage(fifoParams)]);
			}

			setLastPrices(compositeKey, {
				price: data.price,
				confidence: data.confidence,
			});

			logger.info(
				`Published ${symbol} price: ${data.price} (Δ: ${priceData.priceChange.toFixed(4)})`
			);
		} catch (error) {
			const { message } = error as Error;
			logger.error(`SNS publish error for ${compositeKey}: ${message}`);
		}
	};

	const handleStreamData = async (chunk: any) => {
		if (!chunk.account?.account?.data) {
			return;
		}

		try {
			const pubkey = new PublicKey(chunk.account.account.pubkey).toBase58();
			const compositeKeys = ORACLE_TO_COMPOSITE_KEYS[pubkey];

			if (!compositeKeys || compositeKeys.length === 0) {
				logger.warn(`No markets found for oracle: ${pubkey}`);
				return;
			}

			const processPromises = compositeKeys.map(async (compositeKey) => {
				try {
					const market = ORACLE_MAP[compositeKey];

					if (!market) {
						logger.error(`Market not found for composite key: ${compositeKey}`);
						return;
					}

					const oracleClient = oracleClientCache.get(
						market.oracleSource,
						connection,
						program
					);

					const buffer = chunk.account.account.data;
					const data = oracleClient.getOraclePriceDataFromBuffer(buffer);
					const serializedData = simpleSerialize(data);

					const formattedData: OracleData = {
						slot: bnStringToNumber(serializedData.slot),
						price: bnStringToNumber(serializedData.price, PRICE_PRECISION),
						confidence: bnStringToNumber(serializedData.confidence, PRICE_PRECISION),
					};

					if (shouldPublishPrice(compositeKey, formattedData)) {
						await publishToSNS(compositeKey, formattedData);
					}
				} catch (error) {
					logger.error(`Error processing composite key ${compositeKey}: ${error}`);
				}
			});

			await Promise.all(processPromises);
		} catch (error) {
			logger.error(`Error processing oracle data: ${error}`);
		}
	};

	const getLastPrices = () => {
		return lastPrices;
	};

	const setLastPrices = (
		compositeKey: string,
		data: { price: number; confidence: number; lastPublished?: number }
	) => {
		lastPrices[compositeKey] = {
			price: data.price,
			confidence: data.confidence,
			lastPublished: data.lastPublished ?? getTimestamp(),
		};
	};

	const resetLastPrices = () => {
		Object.keys(lastPrices).forEach((key) => delete lastPrices[key]);
	};

	const setupStreamHandlers = () => {
		if (!stream) return;
		stream.on('data', handleStreamData);

		stream.on('error', async (error: Error) => {
			const { message } = error as Error;
			if (isShuttingDown) {
				return;
			}
			if (!isReconnecting) {
				logger.warn(`Stream error: ${message}`);
				await reconnect();
			}
		});

		stream.on('end', async () => {
			if (isShuttingDown) {
				return;
			}
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

		try {
			await sleep(currentDelay);

			currentDelay = Math.min(currentDelay * 2, MAX_RECONNECT_DELAY);
			reconnectAttempts++;

			if (stream) {
				stream.end();
			}

			await start();

			reconnectAttempts = 0;
			currentDelay = INITIAL_RECONNECT_DELAY;

			logger.info('Successfully reconnected');
		} catch (error) {
			const { message } = error as Error;
			logger.warn(`Reconnection failed: ${message}`);
			await reconnect();
		} finally {
			isReconnecting = false;
		}
	};

	const start = async () => {
		try {
			// Allow restart cycles to run start() after a stop()
			isShuttingDown = false;
			logger.info('Starting price listener...');
			const client = new Client(URL, TOKEN, {
				grpcHttp2AdaptiveWindow: true,
				grpcDefaultCompressionAlgorithm: 1,
			});
			await client.connect();
			stream = await client.subscribe();

			setupStreamHandlers();

			const uniqueOracles = Array.from(
				new Set([...SPOT_MARKETS, ...PERP_MARKETS].map((m) => m.oracle.toString()))
			);

			logger.info(`Unique oracles: ${uniqueOracles.length}`);

			const request = {
				slots: {},
				accounts: {
					account: {
						account: uniqueOracles,
						owner: [],
						filters: [],
					},
				},
				transactions: {},
				blocks: {},
				blocksMeta: {},
				accountsDataSlice: [],
				commitment: CommitmentLevel.CONFIRMED,
				entry: {},
				transactionsStatus: {},
			};

			return new Promise<void>((resolve, reject) => {
				if (stream) {
					stream.write(request, (err: Error) => {
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
			logger.error(`Failed to start price listener: ${message}`);
			throw error;
		}
	};

	const stop = () => {
		isShuttingDown = true;
		if (stream) {
			stream.removeAllListeners();
			stream.end();
			stream = null;
		}
	};

	return {
		start,
		stop,
		shouldPublishPrice,
		publishToSNS,
		handleStreamData,
		getLastPrices,
		setLastPrices,
		resetLastPrices,
	};
};
