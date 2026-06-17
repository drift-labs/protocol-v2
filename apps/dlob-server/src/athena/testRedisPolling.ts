import {
	RedisClient,
	RedisClientPrefix,
} from '@velocity-exchange/common/clients';
import { logger, setLogLevel } from '../utils/logger';

setLogLevel('info');

const MARKET_INDEXES_TO_TEST = [0, 1, 2]; // SOL-PERP, BTC-PERP, ETH-PERP
const POLL_INTERVAL_MS = 10_000; // Poll every 10 seconds

interface FillQualityData {
	time: string;
	marketIndex: string;
	takerBuyBpsFromOracle: {
		all: string | null;
		'1e0': string | null;
		'1e3': string | null;
		'1e4': string | null;
		'1e5': string | null;
		'1e6': string | null;
	};
	takerSellBpsFromOracle: {
		all: string | null;
		'1e0': string | null;
		'1e3': string | null;
		'1e4': string | null;
		'1e5': string | null;
		'1e6': string | null;
	};
	updatedAtTs: number;
}

interface SummaryData {
	markets: string[];
	lastUpdated: string;
	lookbackMs: number;
	smoothingMinutes: number;
}

// Track last seen update times for each market
const lastSeenUpdates = new Map<number, number>();

const pollRedis = async (redisClient: RedisClient, iteration: number) => {
	logger.info(`\n========== Polling iteration ${iteration} ==========`);
	const pollTime = Date.now();

	try {
		// Check summary key

		logger.info('\n📊 Market Data:');

		// Check each market
		for (const marketIndex of MARKET_INDEXES_TO_TEST) {
			const key = `taker_fill_vs_oracle_bps:market:${marketIndex}`;
			const dataRaw = await redisClient.get(key);

			if (!dataRaw || typeof dataRaw !== 'string') {
				logger.warn(`   ❌ Market ${marketIndex}: No data found`);
				continue;
			}

			const data: FillQualityData = JSON.parse(dataRaw);
			const lastSeen = lastSeenUpdates.get(marketIndex);
			const isNew = !lastSeen || data.updatedAtTs > lastSeen;
			const ageSeconds = Math.floor((pollTime - data.updatedAtTs) / 1000);

			// Update tracking
			if (isNew) {
				lastSeenUpdates.set(marketIndex, data.updatedAtTs);
			}

			const status = isNew ? '🆕 NEW UPDATE' : '📌 unchanged';
			const marketName =
				['SOL-PERP', 'BTC-PERP', 'ETH-PERP'][marketIndex] ||
				`Market ${marketIndex}`;

			logger.info(`   ${status} - ${marketName} (Market ${marketIndex})`);
			logger.info(`      Data timestamp: ${data.time}`);
			logger.info(
				`      Updated at: ${new Date(data.updatedAtTs).toISOString()}`
			);
			logger.info(`      Age: ${ageSeconds}s ago`);

			// Show some sample data
			const buyAll = data.takerBuyBpsFromOracle.all;
			const sellAll = data.takerSellBpsFromOracle.all;

			if (buyAll !== null && sellAll !== null) {
				logger.info(
					`      Taker Buy (all): ${parseFloat(buyAll).toFixed(2)} bps`
				);
				logger.info(
					`      Taker Sell (all): ${parseFloat(sellAll).toFixed(2)} bps`
				);

				// Show cohort breakdown if available
				const buy1e6 = data.takerBuyBpsFromOracle['1e6'];
				const sell1e6 = data.takerSellBpsFromOracle['1e6'];
				if (buy1e6 !== null && sell1e6 !== null) {
					logger.info(
						`      Large orders (>$1M): Buy=${parseFloat(buy1e6).toFixed(
							2
						)}bps, Sell=${parseFloat(sell1e6).toFixed(2)}bps`
					);
				}
			} else {
				logger.warn(`      ⚠️  No data available for this market`);
			}

			// Warn if data is stale
			if (ageSeconds > 600) {
				// More than 10 minutes old
				logger.warn(
					`      ⚠️  WARNING: Data is stale (${Math.floor(
						ageSeconds / 60
					)} minutes old)`
				);
			}
		}

		// Summary of updates seen
		logger.info('\n📈 Update Tracking:');
		if (iteration === 1) {
			logger.info('   First iteration - establishing baseline');
		} else {
			const updatedMarkets = MARKET_INDEXES_TO_TEST.filter((idx) => {
				const lastSeen = lastSeenUpdates.get(idx);
				if (!lastSeen) return false;
				const currentRaw = redisClient.get(
					`taker_fill_vs_oracle_bps:market:${idx}`
				);
				return true; // If we have a last seen, we've tracked it
			});

			if (updatedMarkets.length === MARKET_INDEXES_TO_TEST.length) {
				logger.info(
					`   ✅ All ${MARKET_INDEXES_TO_TEST.length} markets have data`
				);
			} else {
				logger.warn(
					`   ⚠️  Only ${updatedMarkets.length}/${MARKET_INDEXES_TO_TEST.length} markets have data`
				);
			}
		}

		// Check if keys exist but are not in expected format
		logger.info('\n🔍 Validation:');
		let allValid = true;
		for (const marketIndex of MARKET_INDEXES_TO_TEST) {
			const key = `taker_fill_vs_oracle_bps:market:${marketIndex}`;
			const dataRaw = await redisClient.get(key);
			if (dataRaw && typeof dataRaw === 'string') {
				try {
					const data = JSON.parse(dataRaw);
					if (!data.updatedAtTs || !data.marketIndex) {
						logger.error(`   ❌ Market ${marketIndex}: Invalid data structure`);
						allValid = false;
					}
				} catch (error) {
					logger.error(
						`   ❌ Market ${marketIndex}: Failed to parse JSON - ${error.message}`
					);
					allValid = false;
				}
			}
		}
		if (allValid) {
			logger.info('   ✅ All data structures are valid');
		}
	} catch (error) {
		logger.error(`Error polling Redis: ${error.message}`);
		logger.error(error.stack);
	}
};

const main = async () => {
	logger.info('🚀 Starting Fill Quality Analytics Redis Polling Test');
	logger.info(`   Testing markets: ${MARKET_INDEXES_TO_TEST.join(', ')}`);
	logger.info(`   Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
	logger.info(`   Press Ctrl+C to stop\n`);

	// Log Redis connection details
	const redisHost = process.env.ELASTICACHE_HOST || 'localhost';
	const redisPort = process.env.ELASTICACHE_PORT || '6379';

	// For local development, disable TLS and cluster mode
	const isLocal = !process.env.ELASTICACHE_HOST;
	if (isLocal) {
		logger.info('📡 Using local Redis (TLS disabled)');
		// Set environment variables to disable TLS for local Redis
		// getTlsConfiguration() checks these to determine TLS usage
		process.env.RUNNING_LOCAL = 'true';
		process.env.LOCAL_CACHE = 'true';
	}

	logger.info(`📡 Connecting to Redis:`);
	logger.info(`   Host: ${redisHost}`);
	logger.info(`   Port: ${redisPort}`);
	logger.info(`   Prefix: ${RedisClientPrefix.DLOB}`);

	const redisClient = new RedisClient({
		prefix: RedisClientPrefix.DLOB,
	});

	try {
		await redisClient.connect();
		logger.info('✅ Connected to Redis\n');
	} catch (error) {
		logger.error('❌ Failed to connect to Redis:', error.message);
		logger.error('\n💡 Troubleshooting:');
		logger.error('   1. Make sure Redis is running locally:');
		logger.error('      $ redis-server');
		logger.error('      OR');
		logger.error('      $ docker run -d -p 6379:6379 redis:latest\n');
		logger.error('   2. Check if Redis is accessible:');
		logger.error('      $ redis-cli ping');
		logger.error('      Expected: PONG\n');
		logger.error('   3. Set environment variables if using non-default Redis:');
		logger.error('      $ export ELASTICACHE_HOST=your-redis-host');
		logger.error('      $ export ELASTICACHE_PORT=your-redis-port\n');
		process.exit(1);
	}

	let iteration = 0;

	// Initial poll
	iteration++;
	await pollRedis(redisClient, iteration);

	// Set up periodic polling
	const intervalId = setInterval(async () => {
		iteration++;
		await pollRedis(redisClient, iteration);
	}, POLL_INTERVAL_MS);

	// Graceful shutdown
	process.on('SIGINT', async () => {
		logger.info('\n\n🛑 Shutting down...');
		clearInterval(intervalId);
		await redisClient.disconnect();
		logger.info('✅ Disconnected from Redis');
		logger.info(
			`\n📊 Final Stats: Ran ${iteration} polling iterations over ${Math.floor(
				(iteration * POLL_INTERVAL_MS) / 1000
			)}s`
		);
		process.exit(0);
	});
};

main().catch((error) => {
	logger.error('Fatal error:', error);
	process.exit(1);
});
