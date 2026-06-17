import { CandleResolutions, getResolutionSeconds, logger } from '@backend/common';
import { CandleRepository } from '@backend/dynamodb';
import { CandleCacheRepository, Redis } from '@backend/redis';
import Bottleneck from 'bottleneck';
import { CANDLE_RESOLUTIONS } from './candle-processor';

const limiter = new Bottleneck({
	maxConcurrent: 10,
});

const SYNC_SIZE = Number.isNaN(Number(process.env.SYNC_SIZE)) ? 250 : Number(process.env.SYNC_SIZE);

export const CandleSync = ({ symbols }: { symbols: string[] }) => {
	const { getCandlesBetweenTimestampsForResolution } = CandleRepository();
	const { generateCandleKey, generateSetKey } = CandleCacheRepository();
	const { mSetWithTTL, zAdd } = Redis();

	const getSyncCutoffTime = (resolution: CandleResolutions): number => {
		const multiplier = resolution === '1' ? 5 : 1;
		const currentTime = Math.floor(Date.now() / 1000);
		const resolutionSeconds = getResolutionSeconds(resolution);
		const currentCandleStart = Math.floor(currentTime / resolutionSeconds) * resolutionSeconds;
		return currentCandleStart - resolutionSeconds * multiplier;
	};

	const syncSymbolResolution = async (symbol: string, resolution: CandleResolutions) => {
		try {
			const cutoffTime = getSyncCutoffTime(resolution);

			const records = await getCandlesBetweenTimestampsForResolution({
				symbol,
				resolution,
				startTs: cutoffTime,
				endTs: 0,
				limit: SYNC_SIZE,
			});

			if (records.length > 0) {
				const keyValuePairs: Record<string, string> = {};
				const zAddEntries: { score: number; value: string }[] = [];

				for (const candle of records) {
					const key = generateCandleKey(candle.symbol, candle.resolution, candle.ts);
					keyValuePairs[key] = JSON.stringify(candle);
					zAddEntries.push({
						score: candle.ts,
						value: key,
					});
				}
				await mSetWithTTL(keyValuePairs);

				const setKey = generateSetKey(symbol, resolution);

				if (zAddEntries.length > 0) {
					await zAdd(setKey, zAddEntries);
				}

				logger.info(
					`Synced ${records.length} candles for ${symbol}:${resolution} up to ${new Date(
						cutoffTime * 1000
					).toISOString()}`
				);
			}
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error syncing old candles for ${symbol}:${resolution}: ${message}`);
			throw error;
		}
	};

	const sync = async () => {
		logger.info(`Starting candle sync.`);

		const syncTasks = symbols.flatMap((symbol) =>
			CANDLE_RESOLUTIONS.map((resolution) =>
				limiter.schedule(() => syncSymbolResolution(symbol, resolution))
			)
		);

		const results = await Promise.allSettled(syncTasks);

		const succeeded = results.filter((result) => result.status === 'fulfilled').length;
		const failed = results.filter((result) => result.status === 'rejected').length;

		logger.info(
			`Sync completed. Successfully processed ${succeeded} symbol/resolution combinations. ${failed} failed.`
		);

		return failed === 0;
	};

	return {
		sync,
		getSyncCutoffTime,
	};
};
