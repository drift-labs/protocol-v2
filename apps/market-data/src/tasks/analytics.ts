import {
	FillQualityAnalyticsRepository,
	LiquiditySourceAnalyticsRepository,
	TriggerOrderAnalyticsRepository,
} from '@backend/athena';
import {
	AuctionLatencyStats,
	getPerpMarketSymbol,
	getSpotMarketSymbol,
	getTimestamp,
	logger,
	roundToDay,
} from '@backend/common';
import { AnalyticsRepository } from '@backend/dynamodb';
import { VelocityClient } from '@velocity-exchange/sdk';
import Bottleneck from 'bottleneck';
import { Scheduler } from '../services/scheduler';

// Don't backfill until this date
const MIN_BACKFILL_DATE = new Date('2024-01-01').getTime() / 1000;

const { getAuctionLatencyStats } = FillQualityAnalyticsRepository();
const { getTriggerOrderFillAnalytics } = TriggerOrderAnalyticsRepository();
const { getLiquiditySourceAnalytics } = LiquiditySourceAnalyticsRepository();
const {
	createAuctionLatencyStats,
	getOldestAuctionLatencyStats,
	createTriggerOrderFillStats,
	getOldestTriggerOrderFillStats,
	createLiquiditySourceStats,
	getOldestLiquiditySourceStats,
} = AnalyticsRepository();

const limiter = new Bottleneck({
	maxConcurrent: 10,
	minTime: 100,
});

const backfillLimiter = new Bottleneck({
	maxConcurrent: 10,
	minTime: 100,
});

// New limiters for parallel backfill processing
const athenaQueryLimiter = new Bottleneck({
	maxConcurrent: 50,
	minTime: 100,
});

const parallelBackfillLimiter = new Bottleneck({
	maxConcurrent: 50,
	minTime: 100,
});

// Limiter for DynamoDB read operations to avoid throttling
const dynamoReadLimiter = new Bottleneck({
	maxConcurrent: 20,
	minTime: 100, // Allow faster reads but still controlled
});

// Exported types for testing
export interface MarketInfo {
	marketIndex: number;
	symbol: string;
	isPerp: boolean;
}

export interface BackfillBatch {
	from: number;
	to: number;
	dayString: string;
}

export interface BackfillResult {
	from: number;
	to: number;
	dayString: string;
	stats: any[];
	hasData: boolean;
	error?: Error;
}

export interface BackfillConfig {
	minDate: number;
	maxConsecutiveEmptyDays: number;
	batchSize: number;
}

// Extracted helper functions for testing
export const getAllMarkets = (driftClient: VelocityClient): MarketInfo[] => {
	const perpMarkets = driftClient
		.getPerpMarketAccounts()
		.filter((market) => !getPerpMarketSymbol(market.marketIndex).includes('-BET'));

	const spotMarkets = driftClient.getSpotMarketAccounts();

	const allMarkets: MarketInfo[] = [
		...perpMarkets.map((market) => ({
			marketIndex: market.marketIndex,
			symbol: getPerpMarketSymbol(market.marketIndex),
			isPerp: true,
		})),
		...spotMarkets.map((market) => ({
			marketIndex: market.marketIndex,
			symbol: getSpotMarketSymbol(market.marketIndex),
			isPerp: false,
		})),
	];

	return allMarkets;
};

export const shouldStopBackfill = (oldestTimestamp: number, config: BackfillConfig): boolean => {
	return oldestTimestamp <= config.minDate;
};

export const createDayBatch = (
	oldestTimestamp: number,
	config: BackfillConfig
): { batch: BackfillBatch[]; shouldContinue: boolean } => {
	const dayBatch: BackfillBatch[] = [];
	let shouldContinue = true;

	for (let i = 0; i < config.batchSize; i++) {
		const dayOffset = i * 24 * 60 * 60;
		const previousDayTo = roundToDay(oldestTimestamp - dayOffset);
		const previousDayFrom = roundToDay(oldestTimestamp - dayOffset - 24 * 60 * 60);

		// Skip days before minimum backfill date
		if (previousDayFrom < config.minDate) {
			logger.info(
				`[ANALYTICS_BACKFILL] Reached minimum backfill date (${new Date(
					config.minDate * 1000
				).toISOString()}), stopping batch creation`
			);
			shouldContinue = false;
			break;
		}

		dayBatch.push({
			from: previousDayFrom,
			to: previousDayTo,
			dayString: new Date(previousDayFrom * 1000).toISOString().split('T')[0],
		});
	}

	return { batch: dayBatch, shouldContinue };
};

export const shouldStopAfterBatch = (results: BackfillResult[]): boolean => {
	const daysWithData = results.filter((result) => result.hasData);
	return daysWithData.length === 0;
};

export const addMarketSymbolsToStats = (stats: any[]): void => {
	stats.forEach((stat) => {
		if (stat.marketType === 'perp') {
			stat.market = getPerpMarketSymbol(parseInt(stat.marketIndex));
		} else {
			stat.market = getSpotMarketSymbol(parseInt(stat.marketIndex));
		}
	});
};

export const getOldestRecordAcrossMarkets = async (
	markets: MarketInfo[],
	cohorts: string[],
	bitFlags: string,
	getOldestFn: (symbol: string, bitFlags: string, cohort?: string) => Promise<any>
): Promise<{ timestamp: number; record: any } | null> => {
	// Create all possible market-cohort combinations for parallel processing
	const marketCohortCombinations = markets.flatMap((market) => {
		return cohorts.map((cohort) => ({ symbol: market.symbol, cohort }));
	});

	// Fetch all oldest records in parallel with rate limiting
	const allOldestRecords = await Promise.all(
		marketCohortCombinations.map(({ symbol, cohort }) =>
			dynamoReadLimiter.schedule(async () => {
				try {
					const record = await getOldestFn(symbol, bitFlags, cohort);
					return record ? { ...record, symbol, cohort } : null;
				} catch (error) {
					logger.warn(
						`[ANALYTICS_BACKFILL] Failed to get oldest record for ${symbol}-${cohort}-${bitFlags}: ${
							(error as Error).message
						}`
					);
					return null;
				}
			})
		)
	);

	// Find the actual oldest record across all markets and cohorts
	const validRecords = allOldestRecords.filter((record) => record !== null);
	if (validRecords.length === 0) {
		return null;
	}

	const oldestRecord = validRecords.reduce((oldest, current) => {
		return parseInt(current.sk) < parseInt(oldest.sk) ? current : oldest;
	});

	return {
		timestamp: parseInt(oldestRecord.sk),
		record: oldestRecord,
	};
};

export const processAuctionLatencyBatch = async (
	batch: BackfillBatch[]
): Promise<BackfillResult[]> => {
	return Promise.all(
		batch.map(({ from, to, dayString }) =>
			parallelBackfillLimiter.schedule(async () => {
				try {
					// Hit Athena to get the day's auction latency for ALL markets
					const stats = await athenaQueryLimiter.schedule(async () => {
						return await getAuctionLatencyStats(from, to);
					});

					// Add market symbols to the stats
					addMarketSymbolsToStats(stats);

					logger.info(
						`[AUCTION_LATENCY_BACKFILL] Auction latency batch query on ${dayString} from: ${from}, to: ${to}, found ${stats.length} records`
					);
					return {
						from,
						to,
						dayString,
						stats,
						hasData: stats.length > 0,
					};
				} catch (error) {
					logger.error(
						`[AUCTION_LATENCY_BACKFILL] Failed to fetch auction latency stats on ${dayString}: ${
							(error as Error).message
						}`
					);
					return {
						from,
						to,
						dayString,
						stats: [],
						hasData: false,
						error: error as Error,
					};
				}
			})
		)
	);
};

export const processTriggerOrderBatch = async (
	batch: BackfillBatch[],
	orderType: string
): Promise<BackfillResult[]> => {
	return Promise.all(
		batch.map(({ from, to, dayString }) =>
			parallelBackfillLimiter.schedule(async () => {
				try {
					const stats = await athenaQueryLimiter.schedule(async () => {
						return await getTriggerOrderFillAnalytics(
							from,
							to - 1,
							orderType as 'triggerMarket' | 'triggerLimit' | 'all'
						);
					});

					// Add market symbols to the stats
					addMarketSymbolsToStats(stats);

					return {
						from,
						to,
						dayString,
						stats,
						hasData: stats.length > 0,
					};
				} catch (error) {
					logger.error(
						`[TRIGGER_ORDER_BACKFILL] Failed to fetch trigger order fill stats for orderType ${orderType} on ${dayString}: ${
							(error as Error).message
						}`
					);
					return {
						from,
						to,
						dayString,
						stats: [],
						hasData: false,
						error: error as Error,
					};
				}
			})
		)
	);
};

export const processLiquiditySourceBatch = async (
	batch: BackfillBatch[]
): Promise<BackfillResult[]> => {
	return Promise.all(
		batch.map(({ from, to, dayString }) =>
			parallelBackfillLimiter.schedule(async () => {
				try {
					const stats = await athenaQueryLimiter.schedule(async () => {
						return await getLiquiditySourceAnalytics(from, to - 1);
					});

					// Add market symbols to the stats
					addMarketSymbolsToStats(stats);

					return {
						from,
						to,
						dayString,
						stats,
						hasData: stats.length > 0,
					};
				} catch (error) {
					logger.error(
						`[LIQUIDITY_SOURCE_BACKFILL] Failed to fetch liquidity source stats on ${dayString}: ${
							(error as Error).message
						}`
					);
					return {
						from,
						to,
						dayString,
						stats: [],
						hasData: false,
						error: error as Error,
					};
				}
			})
		)
	);
};

export const storeAuctionLatencyResults = async (results: BackfillResult[]): Promise<number> => {
	let rowsWritten = 0;

	// Sort results by timestamp to process in chronological order
	results.sort((a, b) => a.from - b.from);

	// Process days with data
	const daysWithData = results.filter((result) => result.hasData);

	for (const result of daysWithData) {
		// Group stats by market for storage
		const statsByMarket = result.stats.reduce((acc, stat) => {
			if (!acc[stat.market]) {
				acc[stat.market] = [];
			}
			acc[stat.market].push(stat);
			return acc;
		}, {} as Record<string, any[]>);

		// Write the stats to DDB for each market
		const storePromises = Object.entries(statsByMarket).map(([_symbol, marketStats]) =>
			backfillLimiter.schedule(async () => {
				await createAuctionLatencyStats(result.from, marketStats as any);
			})
		);

		await Promise.all(storePromises);
		rowsWritten += result.stats.length;

		logger.info(
			`[AUCTION_LATENCY_BACKFILL] Successfully backfilled auction latency stats for ${
				result.dayString
			}: ${result.stats.length} records written across ${
				Object.keys(statsByMarket).length
			} markets`
		);
	}

	return rowsWritten;
};

export const storeTriggerOrderResults = async (results: BackfillResult[]): Promise<number> => {
	let rowsWritten = 0;

	// Sort results by timestamp to process in chronological order
	results.sort((a, b) => a.from - b.from);

	// Process days with data
	const daysWithData = results.filter((result) => result.hasData);

	for (const result of daysWithData) {
		// Write the stats to DDB
		await createTriggerOrderFillStats(result.from, result.stats);
		rowsWritten += result.stats.length;

		logger.info(
			`[TRIGGER_ORDER_BACKFILL] Successfully backfilled trigger order fill stats for ${
				result.dayString
			}: ${result.stats.length} records written across ${
				new Set(result.stats.map((s) => s.market)).size
			} markets`
		);
	}

	return rowsWritten;
};

export const storeLiquiditySourceResults = async (results: BackfillResult[]): Promise<number> => {
	let rowsWritten = 0;

	// Sort results by timestamp to process in chronological order
	results.sort((a, b) => a.from - b.from);

	// Process days with data
	const daysWithData = results.filter((result) => result.hasData);

	for (const result of daysWithData) {
		// Write the stats to DDB
		await createLiquiditySourceStats(result.from, result.stats);
		rowsWritten += result.stats.length;

		logger.info(
			`[LIQUIDITY_SOURCE_BACKFILL] Successfully backfilled liquidity source stats for ${
				result.dayString
			}: ${result.stats.length} records written across ${
				new Set(result.stats.map((s) => s.market)).size
			} markets`
		);
	}

	return rowsWritten;
};

// Generic backfill processor to reduce code duplication
export interface BackfillProcessor {
	name: string;
	variants: string[];
	processBatch: (batch: BackfillBatch[], variant: string) => Promise<BackfillResult[]>;
	storeResults: (results: BackfillResult[]) => Promise<number>;
	getOldestRecord: (
		markets: MarketInfo[],
		cohorts: string[],
		variant: string
	) => Promise<{ timestamp: number; record: any } | null>;
}

export const executeBackfillForProcessor = async (
	processor: BackfillProcessor,
	markets: MarketInfo[],
	cohorts: string[],
	config: BackfillConfig
): Promise<number> => {
	let totalRowsWritten = 0;

	for (const variant of processor.variants) {
		logger.info(`[${processor.name}] Starting backfill for variant: ${variant}`);

		let variantRowsWritten = 0;
		let shouldContinue = true;

		try {
			while (shouldContinue) {
				const batchStartTime = Date.now();

				logger.info(
					`[${processor.name}] Fetching oldest records for ${
						markets.length
					} markets with variant ${variant} across ${cohorts.length} cohorts (${
						markets.length * cohorts.length
					} total queries)`
				);

				const oldestRecordResult = await processor.getOldestRecord(
					markets,
					cohorts,
					variant
				);

				if (!oldestRecordResult) {
					logger.info(
						`[${processor.name}] No existing records found for any market for variant ${variant}, skipping this variant`
					);
					break;
				}

				const { timestamp: oldestTimestamp } = oldestRecordResult;
				logger.info(
					`[${
						processor.name
					}] Found oldest record for variant ${variant} across all markets at timestamp ${oldestTimestamp} (${new Date(
						oldestTimestamp * 1000
					).toISOString()})`
				);

				// Check if we've reached the minimum backfill date
				if (shouldStopBackfill(oldestTimestamp, config)) {
					logger.info(
						`[${processor.name}] Oldest record (${new Date(
							oldestTimestamp * 1000
						).toISOString()}) is at or before minimum backfill date (${new Date(
							config.minDate * 1000
						).toISOString()}), stopping backfill for variant ${variant}`
					);
					break;
				}

				// Calculate batch of days to process
				const { batch: dayBatch, shouldContinue: batchShouldContinue } = createDayBatch(
					oldestTimestamp,
					config
				);
				shouldContinue = batchShouldContinue;

				// If no days to process, break the loop
				if (dayBatch.length === 0) {
					logger.info(
						`[${processor.name}] No valid days to process for variant ${variant}, stopping backfill`
					);
					break;
				}

				logger.info(
					`[${processor.name}] Processing batch of ${
						dayBatch.length
					} days for variant ${variant}: ${dayBatch[0].dayString} to ${
						dayBatch[dayBatch.length - 1].dayString
					}`
				);

				// Process days in parallel
				const dayResults = await processor.processBatch(dayBatch, variant);

				// Check if we should stop after this batch
				if (shouldStopAfterBatch(dayResults)) {
					logger.info(
						`[${processor.name}] All days in batch have no data for variant ${variant}, stopping backfill`
					);
					shouldContinue = false;
				} else {
					// Store results
					const batchRowsWritten = await processor.storeResults(dayResults);
					variantRowsWritten += batchRowsWritten;

					const daysWithData = dayResults.filter((r) => r.hasData);
					logger.info(
						`[${processor.name}] Batch processed ${daysWithData.length}/${dayBatch.length} days with data for variant ${variant}`
					);
				}

				const batchTime = Date.now() - batchStartTime;
				logger.info(
					`[${processor.name}] Completed batch for variant ${variant} in ${batchTime}ms: ${variantRowsWritten} rows written`
				);
			}

			totalRowsWritten += variantRowsWritten;
			logger.info(
				`[${processor.name}] Completed backfill for variant ${variant}: ${variantRowsWritten} rows written`
			);
		} catch (error) {
			logger.error(
				`[${processor.name}] Failed backfill for variant ${variant}: ${
					(error as Error).message
				}`
			);
		}
	}

	return totalRowsWritten;
};

export const setupAnalyticsTasks = ({
	driftClient,
	scheduler,
}: {
	driftClient: VelocityClient;
	scheduler: ReturnType<typeof Scheduler>;
}) => {
	const config: BackfillConfig = {
		minDate: MIN_BACKFILL_DATE,
		maxConsecutiveEmptyDays: 14,
		batchSize: 7,
	};

	scheduler.scheduleTask(
		'auction-latency-stats',
		'0 0 * * *',
		async () => {
			logger.info('[AUCTION_LATENCY_STATS] Fetching auction latency statistics');

			const from = roundToDay(getTimestamp({ days: -1 }));
			const to = roundToDay(getTimestamp());

			try {
				const stats = await getAuctionLatencyStats(from, to);

				// Add market symbols to the stats
				addMarketSymbolsToStats(stats);

				// Group stats by market for storage
				const statsByMarket = stats.reduce(
					(acc: Record<string, AuctionLatencyStats[]>, stat: AuctionLatencyStats) => {
						if (!acc[stat.market]) {
							acc[stat.market] = [];
						}
						acc[stat.market].push(stat);
						return acc;
					},
					{} as Record<string, AuctionLatencyStats[]>
				);

				// Store stats for each market
				const storePromises = Object.entries(statsByMarket).map(
					([_symbol, marketStats]: [string, AuctionLatencyStats[]]) =>
						limiter.schedule(async () => {
							await createAuctionLatencyStats(from, marketStats);
							logger.info(
								`[AUCTION_LATENCY_STATS] Stored auction latency stats to cache for ${marketStats[0].market} from ${from} to ${to}: ${marketStats.length}`
							);
						})
				);

				await Promise.all(storePromises);
				logger.info(
					`[AUCTION_LATENCY_STATS] Completed storing auction latency stats: ${
						stats.length
					} total records across ${Object.keys(statsByMarket).length} markets`
				);
			} catch (error) {
				logger.error(
					`[AUCTION_LATENCY_STATS] Failed to store auction latency stats from ${from} to ${to}: ${
						(error as Error).message
					}`
				);
			}
		},
		{
			runImmediately: true,
		}
	);

	scheduler.scheduleTask(
		'trigger-order-fill-stats',
		'0 0 * * *',
		async () => {
			logger.info('[TRIGGER_ORDER_STATS] Fetching trigger order fill statistics');

			const from = roundToDay(getTimestamp({ days: -1 }));
			const to = roundToDay(getTimestamp()) - 1;

			for (const orderType of ['triggerMarket', 'triggerLimit', 'all'] as const) {
				const stats = await getTriggerOrderFillAnalytics(from, to - 1, orderType);
				addMarketSymbolsToStats(stats);

				await createTriggerOrderFillStats(from, stats);
				logger.info(
					`[TRIGGER_ORDER_STATS] Completed storing trigger order fill stats: ${stats.length} records`
				);
			}
		},
		{
			runImmediately: true,
		}
	);

	scheduler.scheduleTask(
		'liquidity-source-stats',
		'0 0 * * *',
		async () => {
			logger.info('[LIQUIDITY_SOURCE_STATS] Fetching liquidity source statistics');

			const from = roundToDay(getTimestamp({ days: -1 }));
			const to = roundToDay(getTimestamp());

			try {
				const stats = await getLiquiditySourceAnalytics(from, to - 1);
				addMarketSymbolsToStats(stats);

				await createLiquiditySourceStats(from, stats);
				logger.info(
					`[LIQUIDITY_SOURCE_STATS] Completed storing liquidity source stats: ${stats.length} records`
				);
			} catch (error) {
				logger.error(
					`[LIQUIDITY_SOURCE_STATS] Failed to store liquidity source stats from ${from} to ${to}: ${
						(error as Error).message
					}`
				);
			}
		},
		{
			runImmediately: true,
		}
	);

	// Create backfill processors for each analytics type
	const markets = getAllMarkets(driftClient);
	const cohorts = ['0', '1000', '10000', '100000', '500000', '1000000'];

	const auctionLatencyProcessor: BackfillProcessor = {
		name: 'AUCTION_LATENCY_BACKFILL',
		variants: ['all'],
		processBatch: async (batch) => processAuctionLatencyBatch(batch),
		storeResults: storeAuctionLatencyResults,
		getOldestRecord: (markets, cohorts) =>
			getOldestRecordAcrossMarkets(
				markets,
				cohorts,
				'all',
				(symbol: string, _bitFlags: string, _cohort?: string) =>
					getOldestAuctionLatencyStats(symbol)
			),
	};

	const triggerOrderProcessor: BackfillProcessor = {
		name: 'TRIGGER_ORDER_BACKFILL',
		variants: ['triggerMarket', 'triggerLimit', 'all'],
		processBatch: processTriggerOrderBatch,
		storeResults: storeTriggerOrderResults,
		getOldestRecord: async (markets, cohorts, orderType) => {
			// Create all possible market-cohort combinations for parallel processing
			const marketCohortCombinations = markets.flatMap((market) => {
				return cohorts.map((cohort) => ({ symbol: market.symbol, cohort }));
			});

			// Fetch all oldest records in parallel with rate limiting
			const allOldestRecords = await Promise.all(
				marketCohortCombinations.map(({ symbol, cohort }) =>
					dynamoReadLimiter.schedule(async () => {
						try {
							const record = await getOldestTriggerOrderFillStats(
								symbol,
								orderType as 'triggerMarket' | 'triggerLimit' | 'all',
								cohort
							);
							return record ? { ...record, symbol, cohort } : null;
						} catch (error) {
							logger.warn(
								`[TRIGGER_ORDER_BACKFILL] Failed to get oldest record for ${symbol}-${orderType}-${cohort}: ${
									(error as Error).message
								}`
							);
							return null;
						}
					})
				)
			);

			// Find the actual oldest record across all markets and cohorts
			const validRecords = allOldestRecords.filter((record) => record !== null);
			const oldestRecord =
				validRecords.length > 0
					? validRecords.reduce((oldest, current) => {
							return parseInt(current.sk) < parseInt(oldest.sk) ? current : oldest;
					  })
					: null;

			return oldestRecord
				? {
						timestamp: parseInt(oldestRecord.sk),
						record: oldestRecord,
				  }
				: null;
		},
	};

	const liquiditySourceProcessor: BackfillProcessor = {
		name: 'LIQUIDITY_SOURCE_BACKFILL',
		variants: ['all'], // Liquidity source doesn't have variants like other processors
		processBatch: async (batch) => processLiquiditySourceBatch(batch),
		storeResults: storeLiquiditySourceResults,
		getOldestRecord: async (markets, cohorts) => {
			// For liquidity source, just check 'all' combos to avoid blowing up the number of queries
			const combinations = markets.flatMap((market) => {
				return cohorts.flatMap((cohort) => {
					return ['all'].flatMap((takerOrderType) => {
						return ['all'].map((bitFlag) => ({
							symbol: market.symbol,
							cohort,
							takerOrderType,
							bitFlag,
						}));
					});
				});
			});

			// Fetch all oldest records in parallel with rate limiting
			const allOldestRecords = await Promise.all(
				combinations.map(({ symbol, cohort, takerOrderType, bitFlag }) =>
					dynamoReadLimiter.schedule(async () => {
						try {
							const record = await getOldestLiquiditySourceStats(
								symbol,
								cohort as any,
								takerOrderType as any,
								bitFlag as any
							);
							return record
								? { ...record, symbol, cohort, takerOrderType, bitFlag }
								: null;
						} catch (error) {
							logger.warn(
								`[LIQUIDITY_SOURCE_BACKFILL] Failed to get oldest record for ${symbol}-${cohort}-${takerOrderType}-${bitFlag}: ${
									(error as Error).message
								}`
							);
							return null;
						}
					})
				)
			);

			// Find the actual oldest record across all combinations
			const validRecords = allOldestRecords.filter((record) => record !== null);
			const oldestRecord =
				validRecords.length > 0
					? validRecords.reduce((oldest, current) => {
							return parseInt(current.sk) < parseInt(oldest.sk) ? current : oldest;
					  })
					: null;

			return oldestRecord
				? {
						timestamp: parseInt(oldestRecord.sk),
						record: oldestRecord,
				  }
				: null;
		},
	};

	// Backfill tasks - Auction Latency
	scheduler.scheduleTask(
		'auction-latency-backfill',
		'0 4 * * *',
		async () => {
			logger.info('[AUCTION_LATENCY_BACKFILL] Starting backfill');

			const totalRowsWritten = await executeBackfillForProcessor(
				auctionLatencyProcessor,
				markets,
				cohorts,
				config
			);

			logger.info(
				`[AUCTION_LATENCY_BACKFILL] Completed backfill: ${totalRowsWritten} total rows written`
			);
		},
		{
			runImmediately: true,
		}
	);

	// Backfill tasks - Trigger Orders
	scheduler.scheduleTask(
		'trigger-order-fill-backfill',
		'0 5 * * *',
		async () => {
			logger.info('[TRIGGER_ORDER_BACKFILL] Starting backfill');

			const totalRowsWritten = await executeBackfillForProcessor(
				triggerOrderProcessor,
				markets,
				cohorts,
				config
			);

			logger.info(
				`[TRIGGER_ORDER_BACKFILL] Completed backfill: ${totalRowsWritten} total rows written`
			);
		},
		{
			runImmediately: true,
		}
	);

	// Backfill tasks - Liquidity Source
	scheduler.scheduleTask(
		'liquidity-source-backfill',
		'0 6 * * *',
		async () => {
			logger.info('[LIQUIDITY_SOURCE_BACKFILL] Starting backfill');

			const totalRowsWritten = await executeBackfillForProcessor(
				liquiditySourceProcessor,
				markets,
				cohorts,
				config
			);

			logger.info(
				`[LIQUIDITY_SOURCE_BACKFILL] Completed backfill: ${totalRowsWritten} total rows written`
			);
		},
		{
			runImmediately: true,
		}
	);
};
