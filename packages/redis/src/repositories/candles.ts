import {
	CandleRecord,
	CandleResolutions,
	filterOutKeys,
	getResolutionSeconds,
	TradeRecord,
} from '@backend/common';
import Decimal from 'decimal.js';
import { Redis } from '../client';

export const CandleCacheRepository = () => {
	const redis = Redis();
	const MAX_CANDLES_PER_SET = 1000;

	const buffers = new Map<
		string,
		{
			candle: CandleRecord;
			trades: any[];
			isNewCandle: boolean;
			hasOracleUpdate?: boolean;
		}
	>();

	const generateCandleChannel = (symbol: string, resolution: CandleResolutions) => {
		return `candles:${symbol}:${resolution}`;
	};

	const generateCandleKey = (symbol: string, resolution: CandleResolutions, ts: number) => {
		return `candle:{${symbol}:${resolution}}:${ts}`;
	};

	const generateSetKey = (symbol: string, resolution: CandleResolutions) => {
		return `candleset:{${symbol}:${resolution}}`;
	};

	const getBufferKey = (symbol: string, resolution: CandleResolutions) => {
		return `${symbol}:${resolution}`;
	};

	const trimCandleSet = async (setKey: string) => {
		const setSize = await redis.zCard(setKey);
		if (setSize > MAX_CANDLES_PER_SET) {
			const removeCount = setSize - MAX_CANDLES_PER_SET;
			await redis.zRemRangeByRank(setKey, 0, removeCount - 1);
		}
	};

	const getLatestCandle = async (
		symbol: string,
		resolution: CandleResolutions
	): Promise<CandleRecord | undefined> => {
		const setKey = generateSetKey(symbol, resolution);

		const latestMembers = await redis.zRangeWithScores(setKey, -1, -1);

		if (!latestMembers || latestMembers.length === 0) {
			return undefined;
		}

		const candleKey = latestMembers[0].value;
		const candleData = await redis.get(candleKey);
		return candleData ? JSON.parse(candleData) : undefined;
	};

	const getCandle = async (
		symbol: string,
		resolution: CandleResolutions,
		ts: number
	): Promise<CandleRecord | undefined> => {
		const candleKey = generateCandleKey(symbol, resolution, ts);
		const candleData = await redis.get(candleKey);
		return candleData ? JSON.parse(candleData) : undefined;
	};

	const addToBuffer = (
		candle: CandleRecord,
		trade?: any,
		isNew = false,
		hasOracleUpdate = false
	) => {
		const key = getBufferKey(candle.symbol, candle.resolution);

		if (!buffers.has(key)) {
			buffers.set(key, {
				candle,
				trades: [],
				isNewCandle: isNew,
				hasOracleUpdate,
			});
		} else {
			const buffer = buffers.get(key)!;
			buffer.candle = candle;
			if (isNew) {
				buffer.isNewCandle = true;
			}
			if (hasOracleUpdate) {
				buffer.hasOracleUpdate = true;
			}
		}

		if (trade) {
			const buffer = buffers.get(key)!;
			buffer.trades.push(filterOutKeys(trade));
		}
	};

	const clearBuffers = () => {
		buffers.clear();
	};

	const publishBufferedUpdates = async () => {
		for (const [key, buffer] of buffers.entries()) {
			if (buffer.trades.length > 0 || buffer.isNewCandle || buffer.hasOracleUpdate) {
				try {
					const [symbol, resolution] = key.split(':');
					const channel = generateCandleChannel(symbol, resolution as CandleResolutions);

					await redis.publish(
						channel,
						JSON.stringify({
							type: buffer.isNewCandle ? 'create' : 'update',
							candle: buffer.candle,
							trades: buffer.trades,
						})
					);

					buffer.trades = [];
					buffer.isNewCandle = false;
					buffer.hasOracleUpdate = false;
				} catch (error) {
					console.error(`Error publishing buffer for ${key}:`, error);
				}
			}
		}
	};

	const createCandleRecords = async (candles: CandleRecord[]): Promise<void> => {
		const groupedCandles = candles.reduce(
			(acc, candle) => {
				const key = `${candle.symbol}:${candle.resolution}`;
				if (!acc[key]) {
					acc[key] = [];
				}
				acc[key].push(candle);
				return acc;
			},
			{} as Record<string, CandleRecord[]>
		);

		await Promise.all(
			Object.values(groupedCandles).map(async (candleGroup) => {
				const setKey = generateSetKey(candleGroup[0].symbol, candleGroup[0].resolution);

				for (const candle of candleGroup) {
					const candleKey = generateCandleKey(
						candle.symbol,
						candle.resolution,
						candle.ts
					);

					const ttl = getExpirySeconds(candle.resolution);

					if (ttl) {
						await redis.setEx(candleKey, ttl, JSON.stringify(candle));
					} else {
						await redis.set(candleKey, JSON.stringify(candle));
					}

					await redis.zAdd(setKey, [
						{
							score: candle.ts,
							value: candleKey,
						},
					]);

					addToBuffer(candle, null, true);
				}

				await trimCandleSet(setKey);
			})
		);
	};

	const updateCandleRecord = async ({
		trade,
		resolution,
		ts,
		updateOpenOnly = false,
		updateEmptyCandle = false,
	}: {
		trade: TradeRecord & { price: number };
		resolution: CandleResolutions;
		ts: number;
		updateOpenOnly?: boolean;
		updateEmptyCandle?: boolean;
	}) => {
		const candleKey = generateCandleKey(trade.symbol, resolution, ts);
		const existingCandleData = await redis.get(candleKey);
		const isNewCandle = !existingCandleData;
		let candle: CandleRecord = existingCandleData ? JSON.parse(existingCandleData) : null;

		if (!candle) {
			// Get the previous candle to use its close prices for the open
			const lastCandle = await getLatestCandle(trade.symbol, resolution);
			const openPrice = lastCandle?.fillClose ?? trade.price;
			const openOraclePrice = lastCandle?.oracleClose ?? trade.oraclePrice;

			candle = {
				symbol: trade.symbol,
				resolution,
				ts,
				fillOpen: openPrice,
				fillHigh: Math.max(openPrice, trade.price),
				fillLow: Math.min(openPrice, trade.price),
				fillClose: trade.price,
				oracleOpen: openOraclePrice,
				oracleHigh: Math.max(openOraclePrice, trade.oraclePrice),
				oracleLow: Math.min(openOraclePrice, trade.oraclePrice),
				oracleClose: trade.oraclePrice,
				quoteVolume: trade.quoteAssetAmountFilled,
				baseVolume: trade.baseAssetAmountFilled,
				lastTradeTs: trade.ts,
				lastFillRecordId: trade.fillRecordId,
			};
		} else if (updateEmptyCandle) {
			candle = {
				...candle,
				fillOpen: trade.price,
				fillHigh: trade.price,
				fillLow: trade.price,
				fillClose: trade.price,
				oracleOpen: trade.oraclePrice,
				oracleHigh: trade.oraclePrice,
				oracleLow: trade.oraclePrice,
				oracleClose: trade.oraclePrice,
			};
		} else if (updateOpenOnly) {
			candle.fillOpen = trade.price;
			candle.oracleOpen = trade.oraclePrice;
		} else {
			if (
				!candle.lastFillRecordId ||
				Number(candle.lastFillRecordId) < Number(trade.fillRecordId)
			) {
				candle.fillClose = trade.price;
				candle.oracleClose = trade.oraclePrice;
				candle.lastTradeTs = trade.ts;
				candle.lastFillRecordId = trade.fillRecordId;
			}

			candle.fillHigh = Math.max(candle.fillHigh, trade.price);
			candle.fillLow = Math.min(candle.fillLow, trade.price);
			candle.oracleHigh = Math.max(candle.oracleHigh, trade.oraclePrice);
			candle.oracleLow = Math.min(candle.oracleLow, trade.oraclePrice);
			candle.quoteVolume = new Decimal(candle.quoteVolume)
				.add(trade.quoteAssetAmountFilled)
				.toDecimalPlaces(6)
				.toNumber();
			candle.baseVolume = new Decimal(candle.baseVolume)
				.add(trade.baseAssetAmountFilled)
				.toDecimalPlaces(6)
				.toNumber();
		}

		await redis.set(candleKey, JSON.stringify(candle));

		const setKey = generateSetKey(trade.symbol, resolution);
		await redis.zAdd(setKey, [
			{
				score: ts,
				value: candleKey,
			},
		]);

		addToBuffer(candle, trade, isNewCandle);

		return candle;
	};

	const updateCandleOracle = async ({
		symbol,
		oraclePrice,
		resolution,
		ts,
	}: {
		symbol: string;
		oraclePrice: number;
		resolution: CandleResolutions;
		ts: number;
	}) => {
		const candleKey = generateCandleKey(symbol, resolution, ts);
		const existingCandleData = await redis.get(candleKey);
		const isNewCandle = !existingCandleData;
		let candle: CandleRecord = existingCandleData ? JSON.parse(existingCandleData) : null;

		if (!candle) {
			const lastCandle = await getLatestCandle(symbol, resolution);

			// Don't create oracle-only candles if no trades have occurred yet
			if (!lastCandle) {
				return null; // No candles exist yet, don't create oracle-only candle
			}

			const openPrice = lastCandle.fillClose;
			const openOraclePrice = lastCandle.oracleClose;

			candle = {
				symbol,
				resolution,
				ts,
				fillOpen: openPrice,
				fillHigh: openPrice,
				fillLow: openPrice,
				fillClose: openPrice,
				oracleOpen: openOraclePrice,
				oracleHigh: Math.max(openOraclePrice, oraclePrice),
				oracleLow: Math.min(openOraclePrice, oraclePrice),
				oracleClose: oraclePrice,
				quoteVolume: 0,
				baseVolume: 0,
			};
		} else {
			candle.oracleHigh = Math.max(candle.oracleHigh ?? oraclePrice, oraclePrice);
			candle.oracleLow = Math.min(candle.oracleLow ?? oraclePrice, oraclePrice);
			candle.oracleClose = oraclePrice;
		}

		await redis.set(candleKey, JSON.stringify(candle));
		const setKey = generateSetKey(symbol, resolution);
		await redis.zAdd(setKey, [{ score: ts, value: candleKey }]);

		addToBuffer(candle, null, isNewCandle, true);

		return candle;
	};

	const getExpirySeconds = (resolution: CandleResolutions): number | null => {
		if (resolution === 'M' || resolution === 'W') {
			return null;
		}
		const resolutionSeconds = getResolutionSeconds(resolution);
		const expirySeconds = Math.ceil(resolutionSeconds * MAX_CANDLES_PER_SET * 1.1);
		return expirySeconds;
	};

	const getCandlesForResolution = async ({
		symbol,
		resolution,
		limit = 100,
	}: {
		symbol: string;
		resolution: CandleResolutions;
		limit?: number;
	}): Promise<CandleRecord[]> => {
		const setKey = generateSetKey(symbol, resolution);
		const actualLimit = Math.min(limit, MAX_CANDLES_PER_SET);
		const candleKeys = await redis.zRange(setKey, +Infinity, -Infinity, true, actualLimit);
		if (!candleKeys.length) return [];

		const candles = await redis.mGet(candleKeys);
		return candles
			.filter((data): data is string => data !== null)
			.map((data) => JSON.parse(data));
	};

	const getCandlesBetweenTimestampsForResolution = async ({
		symbol,
		resolution,
		startTs,
		endTs = 0,
		limit = 100,
	}: {
		symbol: string;
		resolution: CandleResolutions;
		startTs: number;
		endTs?: number;
		limit?: number;
	}): Promise<CandleRecord[]> => {
		const setKey = generateSetKey(symbol, resolution);
		const actualLimit = Math.min(limit, MAX_CANDLES_PER_SET);
		const candleKeys = await redis.zRange(setKey, startTs, endTs, true, actualLimit);
		if (!candleKeys.length) return [];
		const candles = await redis.mGet(candleKeys);

		return candles
			.filter((data): data is string => data !== null)
			.map((data) => JSON.parse(data));
	};

	return {
		generateCandleKey,
		generateSetKey,
		generateCandleChannel,
		getCandle,
		getCandlesForResolution,
		getCandlesBetweenTimestampsForResolution,
		getLatestCandle,
		createCandleRecords,
		updateCandleRecord,
		clearBuffers,
		publishBufferedUpdates,
		updateCandleOracle,
	};
};
