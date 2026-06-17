import { unmarshall } from '@aws-sdk/util-dynamodb';
import {
	CandleRecord,
	CandleResolutions,
	getResolutionSeconds,
	isFeatureEnabled,
	logger,
	NotificationType,
	OraclePriceData,
	sleep,
	TradeRecord,
} from '@backend/common';
import { CandleRepository, DynamoDB } from '@backend/dynamodb';
import { CandleCacheRepository } from '@backend/redis';
import { SQS } from '@backend/sqs';
import { PRICE_PRECISION_EXP } from '@velocity-exchange/sdk';
import { SNSMessage } from 'aws-lambda';
import Bottleneck from 'bottleneck';
import Decimal from 'decimal.js';

const BATCH_SIZE = 10;
const MAX_PARALLEL_BATCHES = Number(process.env.MAX_PARALLEL_BATCHES) || 1;
const DLQ_URL = process.env.CANDLE_DLQ_URL ?? '';

export const CANDLE_RESOLUTIONS: CandleResolutions[] = ['1', '5', '15', '60', '240', 'D', 'W', 'M'];

const limiter = new Bottleneck({
	maxConcurrent: 200,
});

export const CandleProcessor = ({
	symbols,
	isRunning,
	isGrpc = false,
}: {
	symbols: string[];
	isRunning: boolean;
	isGrpc?: boolean;
}) => {
	const WHITELISTED_MARKETS = new Set(
		process.env.WHITELISTED_MARKETS?.split(',').filter(Boolean) || []
	);
	const BLACKLISTED_MAKERS = new Set(
		process.env.BLACKLISTED_MAKERS?.split(',').filter(Boolean) || []
	);
	const MAX_PRICE_DEVIATION_PCT = Number(process.env.MAX_PRICE_DEVIATION_PCT) || 3;
	const MIN_NOTIONAL = Number(process.env.MIN_NOTIONAL_VALUE) || 250;

	const { getMessages, deleteMessages, putMessages } = SQS();
	const { put } = DynamoDB({ overrideTableName: process.env.CANDLE_TABLE });
	const candleCache = CandleCacheRepository();
	const repository = isGrpc ? candleCache : CandleRepository();
	const {
		getLatestCandle,
		createCandleRecords,
		updateCandleRecord,
		getCandle,
		updateCandleOracle,
	} = repository;

	const getCandleTimestamp = (
		timestampSeconds: number,
		resolution: CandleResolutions
	): number => {
		const date = new Date(timestampSeconds * 1000);

		switch (resolution) {
			case '240': {
				date.setUTCMinutes(0, 0, 0);
				const hours = date.getUTCHours();
				date.setUTCHours(Math.floor(hours / 4) * 4);
				return Math.floor(date.getTime() / 1000);
			}
			case 'W': {
				date.setUTCHours(0, 0, 0, 0);
				const daysSinceMonday = date.getUTCDay() === 0 ? 6 : date.getUTCDay() - 1;
				date.setUTCDate(date.getUTCDate() - daysSinceMonday);
				return Math.floor(date.getTime() / 1000);
			}
			case 'M': {
				date.setUTCHours(0, 0, 0, 0);
				date.setUTCDate(1);
				return Math.floor(date.getTime() / 1000);
			}
			case 'D': {
				date.setUTCHours(0, 0, 0, 0);
				return Math.floor(date.getTime() / 1000);
			}
			default: {
				const intervalSeconds = getResolutionSeconds(resolution);
				return Math.floor(timestampSeconds / intervalSeconds) * intervalSeconds;
			}
		}
	};

	const getRelevantResolutions = (): CandleResolutions[] => {
		const date = new Date();
		const seconds = date.getUTCSeconds();
		const minutes = date.getUTCMinutes();
		const hours = date.getUTCHours();
		const dayOfWeek = date.getUTCDay();
		const dayOfMonth = date.getUTCDate();

		const relevantResolutions: CandleResolutions[] = [];

		if (seconds !== 0) {
			return [];
		}

		relevantResolutions.push('1');
		if (minutes % 5 === 0) relevantResolutions.push('5');
		if (minutes % 15 === 0) relevantResolutions.push('15');
		if (minutes === 0) relevantResolutions.push('60');
		if (minutes === 0 && hours % 4 === 0) relevantResolutions.push('240');
		if (minutes === 0 && hours === 0) relevantResolutions.push('D');
		if (minutes === 0 && hours === 0 && dayOfWeek === 1) relevantResolutions.push('W');
		if (minutes === 0 && hours === 0 && dayOfMonth === 1) relevantResolutions.push('M');

		return relevantResolutions;
	};

	const findAndFillCandleGaps = async ({
		symbol,
		resolution,
		currentTimestamp,
		lastCandle,
	}: {
		symbol: string;
		resolution: CandleResolutions;
		currentTimestamp: number;
		lastCandle: CandleRecord | undefined;
	}): Promise<CandleRecord[]> => {
		const candlesToCreate: CandleRecord[] = [];

		if (!lastCandle || currentTimestamp - lastCandle.ts <= getResolutionSeconds(resolution)) {
			return candlesToCreate;
		}

		const timeDiff = currentTimestamp - lastCandle.ts;
		const intervalSeconds = getResolutionSeconds(resolution);
		const expectedCandles = Math.floor(timeDiff / intervalSeconds) - 1;

		if (expectedCandles <= 0) {
			return candlesToCreate;
		}

		for (let i = 1; i <= expectedCandles; i++) {
			const timestamp = lastCandle.ts + i * intervalSeconds;
			candlesToCreate.push({
				symbol,
				resolution,
				ts: timestamp,
				fillOpen: lastCandle.fillClose,
				fillHigh: lastCandle.fillClose,
				fillClose: lastCandle.fillClose,
				fillLow: lastCandle.fillClose,
				oracleOpen: lastCandle.oracleClose,
				oracleHigh: lastCandle.oracleClose,
				oracleClose: lastCandle.oracleClose,
				oracleLow: lastCandle.oracleClose,
				quoteVolume: 0,
				baseVolume: 0,
			});
		}

		return candlesToCreate;
	};

	const checkAndCreateEmptyCandles = async ({ force }: { force: boolean }) => {
		const relevantResolutions = force ? CANDLE_RESOLUTIONS : getRelevantResolutions();
		if (relevantResolutions.length === 0) {
			return;
		}

		const candlesToCreate: CandleRecord[] = [];

		const processCandlePair = async (
			symbol: string,
			resolution: CandleResolutions
		): Promise<CandleRecord | null> => {
			const currentTimestamp = getCandleTimestamp(Date.now() / 1000, resolution);
			const lastCandle = await getLatestCandle(symbol, resolution);
			if (!lastCandle) return null;

			const gapCandles = await findAndFillCandleGaps({
				symbol,
				resolution,
				currentTimestamp,
				lastCandle,
			});

			if (gapCandles.length) {
				logger.info(
					`Creating ${gapCandles.length} missing candles, symbol: ${symbol}, resolution: ${resolution}`
				);
			}

			candlesToCreate.push(...gapCandles);

			if (lastCandle.ts < currentTimestamp) {
				const price = lastCandle.fillClose;
				const oraclePrice = lastCandle.oracleClose;
				candlesToCreate.push({
					symbol,
					resolution,
					ts: currentTimestamp,
					fillOpen: price,
					fillHigh: price,
					fillClose: price,
					fillLow: price,
					oracleOpen: oraclePrice,
					oracleHigh: oraclePrice,
					oracleClose: oraclePrice,
					oracleLow: oraclePrice,
					quoteVolume: 0,
					baseVolume: 0,
				});
			}

			return null;
		};

		const pairs = symbols.flatMap((symbol) =>
			relevantResolutions.map((resolution) => ({ symbol, resolution }))
		);

		await Promise.all(
			pairs.map(({ symbol, resolution }) =>
				limiter.schedule(() => processCandlePair(symbol, resolution))
			)
		);

		if (candlesToCreate.length > 0) {
			await createCandleRecords(candlesToCreate);
			logger.info(`Created ${candlesToCreate.length} empty candles`);
		} else {
			logger.info('No empty candles to create');
		}
	};

	const shouldFilterTrade = (trade: TradeRecord, price: number, oracleClose: number): boolean => {
		if (trade.maker && BLACKLISTED_MAKERS.has(trade.maker)) {
			return true;
		}

		if (WHITELISTED_MARKETS.has(trade.symbol)) {
			return false;
		}

		const oracleDev = Math.abs((price - oracleClose) / oracleClose) * 100;
		const notional = trade.quoteAssetAmountFilled;

		if (oracleDev > MAX_PRICE_DEVIATION_PCT && notional < MIN_NOTIONAL) {
			return true;
		}

		return false;
	};

	const processTrade = async (trade: TradeRecord, resolution: CandleResolutions) => {
		const ts = getCandleTimestamp(trade.ts, resolution);
		const currentTs = getCandleTimestamp(Date.now() / 1000, resolution);

		const { quoteAssetAmountFilled, baseAssetAmountFilled, oraclePrice } = trade;

		const quote = new Decimal(quoteAssetAmountFilled);
		const base = new Decimal(baseAssetAmountFilled);
		const price = Number(quote.dividedBy(base).toFixed(PRICE_PRECISION_EXP.toNumber()));

		if (isFeatureEnabled('FILTER_CANDLES') && shouldFilterTrade(trade, price, oraclePrice)) {
			logger.warn(`Filtered trade: ${JSON.stringify(trade)}`);
			await put({
				record: {
					...trade,
					pk: `FILTERED_TRADE`,
				},
			});
			return;
		}

		const { fillClose, oracleClose, lastFillRecordId } = await updateCandleRecord({
			trade: { ...trade, price },
			resolution,
			ts,
		});

		if (ts < currentTs && lastFillRecordId === trade.fillRecordId) {
			let nextCandleTs = ts + getResolutionSeconds(resolution);

			while (nextCandleTs <= currentTs) {
				const nextCandle = await getCandle(trade.symbol, resolution, nextCandleTs);
				if (!nextCandle) break;

				if (nextCandle.baseVolume > 0) {
					logger.info(`updating open for ${nextCandle.symbol}, ${resolution}`);
					await updateCandleRecord({
						trade: {
							...trade,
							price: fillClose,
							oraclePrice: oracleClose,
						},
						resolution,
						ts: nextCandleTs,
						updateOpenOnly: true,
					});

					break;
				} else {
					logger.info(
						`updating empty for ${nextCandle.symbol}, ${trade.ts}, ${resolution}, ${nextCandleTs}`
					);
					await updateCandleRecord({
						trade: {
							...trade,
							price: fillClose,
							oraclePrice: oracleClose,
						},
						resolution,
						ts: nextCandleTs,
						updateEmptyCandle: true,
					});
				}

				nextCandleTs += getResolutionSeconds(resolution);
			}
		}
	};

	const processOraclePrice = async (oracle: OraclePriceData, resolution: CandleResolutions) => {
		const ts = getCandleTimestamp(oracle.timestamp, resolution);

		if (isFeatureEnabled('ORACLE_CANDLES')) {
			await updateCandleOracle({
				symbol: oracle.symbol,
				oraclePrice: oracle.price,
				resolution,
				ts,
			});
		}
	};

	const getTradeInformationFromMessage = (body: string | undefined): TradeRecord | undefined => {
		if (!body) return undefined;

		let parsedMessage;
		try {
			parsedMessage = JSON.parse(body);
		} catch (error) {
			logger.warn(`Failed to parse trade message JSON: ${error}`);
			return undefined;
		}

		if (!parsedMessage?.detail?.dynamodb) {
			return undefined;
		}

		const {
			detail: {
				eventName,
				dynamodb: { NewImage = null, OldImage = null },
			},
		} = parsedMessage;

		if (!NewImage) return undefined;

		const newTrade = unmarshall(NewImage) as TradeRecord;
		const oldTrade = OldImage ? (unmarshall(OldImage) as TradeRecord) : null;

		if (!oldTrade) {
			return newTrade.source ? newTrade : undefined;
		}

		if (!newTrade.source || !oldTrade.source) return undefined;

		if (newTrade.source === oldTrade.source && eventName === 'MODIFY') {
			const volumeDifference =
				newTrade.baseAssetAmountFilled - oldTrade.baseAssetAmountFilled;

			if (volumeDifference !== 0) {
				return {
					...newTrade,
					baseAssetAmountFilled: volumeDifference,
					quoteAssetAmountFilled:
						newTrade.quoteAssetAmountFilled - oldTrade.quoteAssetAmountFilled,
				};
			}

			return undefined;
		}

		return newTrade;
	};

	const getOracleInformationFromMessage = (
		body: string | undefined
	): OraclePriceData | undefined => {
		if (!body) return undefined;
		try {
			const message: SNSMessage = JSON.parse(body);
			if (!message.Message) {
				return undefined;
			}
			const { type, data } = JSON.parse(message.Message);
			if (type === NotificationType.PRICE_ALERT && data) {
				return data as OraclePriceData;
			}
		} catch (error) {
			logger.warn(`Failed to parse oracle message JSON: ${error}`);
			return undefined;
		}

		return;
	};

	const getMessagesBatch = async (batchCount: number, batchSize: number) => {
		const fetchPromises = Array(batchCount)
			.fill(null)
			.map(() =>
				getMessages({
					maxMessages: batchSize,
				})
			);

		const messagesBatches = await Promise.all(fetchPromises);
		const messagesMap = new Map();

		messagesBatches.forEach((batch) => {
			if (batch?.length) {
				batch.forEach((message) => {
					if (message.MessageId) {
						messagesMap.set(message.MessageId, message);
					}
				});
			}
		});

		return Array.from(messagesMap.values());
	};

	const processBatch = async () => {
		try {
			const allMessages = await getMessagesBatch(MAX_PARALLEL_BATCHES, BATCH_SIZE);
			if (!allMessages.length) return;

			const sortedTrades = allMessages
				.map((message) => ({
					trade: getTradeInformationFromMessage(message.Body),
					message,
				}))
				.filter(({ trade }) => trade !== null && trade !== undefined)
				.sort((a, b) => {
					const aId = Number(a.trade?.fillRecordId) || 0;
					const bId = Number(b.trade?.fillRecordId) || 0;
					return aId - bId;
				});

			const oracleMessages = allMessages
				.map((message) => ({
					oracle: getOracleInformationFromMessage(message.Body),
					message,
				}))
				.filter(({ oracle }) => oracle !== null && oracle !== undefined);

			for (const { trade, message } of sortedTrades) {
				try {
					if (!trade) return;

					await Promise.all(
						CANDLE_RESOLUTIONS.map(async (resolution) => {
							try {
								await processTrade(trade, resolution);
							} catch (error) {
								await logger.error(
									`Error processing trade message: ${message.MessageId}, resolution:${resolution}: ${error}`
								);
								if (!isGrpc && DLQ_URL) {
									await putMessages({
										records: [
											{
												Id: message.MessageId,
												MessageBody: JSON.stringify({
													resolution,
													trade,
												}),
											},
										],
										overrideQueue: DLQ_URL,
									});
								}
							}
						})
					);
				} catch (error) {
					await logger.error(
						`Error processing trade message ${message.MessageId}: ${error}`
					);
				}
			}

			for (const { oracle, message } of oracleMessages) {
				try {
					await Promise.all(
						CANDLE_RESOLUTIONS.map((resolution) =>
							processOraclePrice(oracle!, resolution)
						)
					);
				} catch (error) {
					await logger.error(
						`Error processing oracle message ${message.MessageId}: ${error}`
					);
				}
			}

			const messagesToDelete = allMessages.map((message) => ({
				Id: message.MessageId,
				ReceiptHandle: message.ReceiptHandle,
			}));

			if (messagesToDelete.length > 0) {
				await deleteMessages(messagesToDelete);
				logger.info(
					`Processed ${sortedTrades.length} trades and ${oracleMessages.length} oracle updates`
				);
			}
		} catch (error) {
			const { message } = error as Error;
			await logger.error(`Error processing batch: ${message}`);
			await sleep(1000);
		}
	};

	const stop = () => {
		isRunning = false;
		logger.info('Stopping processor after current batch completes...');
	};

	const start = async () => {
		logger.info('Starting Candle processor...');

		await checkAndCreateEmptyCandles({ force: true });

		setInterval(async () => {
			await checkAndCreateEmptyCandles({ force: false });
		}, 1000);

		if (isGrpc) {
			setInterval(async () => {
				await candleCache.publishBufferedUpdates();
			}, 300);
		}

		while (isRunning) {
			await processBatch();
		}

		logger.info('Candle processor stopped');
	};

	return {
		start,
		stop,
		processBatch,
		getTradeInformationFromMessage,
		getOracleInformationFromMessage,
		getResolutionSeconds,
		getCandleTimestamp,
		getRelevantResolutions,
		findAndFillCandleGaps,
		checkAndCreateEmptyCandles,
		processTrade,
		processOraclePrice,
	};
};
