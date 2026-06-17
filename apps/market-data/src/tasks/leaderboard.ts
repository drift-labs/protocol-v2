import { Athena } from '@backend/athena';
import {
	formatTradesFromAthenaForLeaderboard,
	getTimestampDay,
	getUTCDayFromTimestamp,
	logger,
	TradeRecord,
} from '@backend/common';
import { LeaderboardCacheRepository } from '@backend/redis';

const {
	VERIFIED_MARKET_PNL_KEY,
	VERIFIED_MARKET_VOLUME_KEY,
	VERIFIED_PNL_KEY,
	VERIFIED_VOLUME_KEY,
	VERIFIED_MAKER_VOLUME_KEY,
	VERIFIED_TAKER_VOLUME_KEY,
	VERIFIED_USER_PNL_KEY,
	VERIFIED_FEE_REBATE_KEY,
	VERIFIED_FEE_PAID_KEY,

	updateTradeStats,
	verifyLeaderboardType,
	getMarkets,
	getLastVerifiedDay,
	setLastVerifiedDay,
	acquireVerificationLock,
	releaseVerificationLock,
} = LeaderboardCacheRepository();

const { query } = Athena();

const BACKFILL_START_DATE = '2025-07-01';
const ONE_DAY_SECONDS = 24 * 60 * 60;

const VERIFY_TYPES = process.env.VERIFY_TYPES?.toLowerCase()
	.split(',')
	.map((t) => t.trim()) || ['pnl', 'volume', 'fees'];

export const processLeaderboard = async (trade: TradeRecord): Promise<void> => {
	await updateTradeStats(trade);
};

export const verifyLeaderboard = async () => {
	try {
		const shouldVerifyPnl = VERIFY_TYPES.includes('pnl');
		const shouldVerifyVolume = VERIFY_TYPES.includes('volume');
		const shouldVerifyFees = VERIFY_TYPES.includes('fees');

		if (!shouldVerifyPnl && !shouldVerifyVolume && !shouldVerifyFees) {
			logger.warn('No valid verification types specified. Valid options: pnl, volume');
			return;
		}

		logger.info(`Verifying types: ${VERIFY_TYPES.join(', ')}`);

		const lastVerified = await getLastVerifiedDay();
		let startDate;

		if (lastVerified) {
			const nextDay = new Date(lastVerified);
			nextDay.setUTCDate(nextDay.getUTCDate() + 1);
			startDate = nextDay.toISOString().split('T')[0];
		} else {
			startDate = BACKFILL_START_DATE;
		}

		const endDate = getUTCDayFromTimestamp(getTimestampDay());

		const start = Math.floor(new Date(startDate).getTime() / 1000);
		const end = Math.floor(new Date(endDate).getTime() / 1000);

		if (start >= end) {
			logger.error('Start timestamp is not before end timestamp');
			process.exit(1);
		}

		logger.info(`Start: ${startDate} (${start})`);
		logger.info(`End: ${endDate} (${end})`);

		const dates = [];
		const daysBetween = Math.floor((end - start) / ONE_DAY_SECONDS);
		for (let i = 0; i < daysBetween; i++) {
			dates.push(new Date((start + i * ONE_DAY_SECONDS) * 1000).toISOString().split('T')[0]);
		}

		logger.info(`Total number of days to verify: ${JSON.stringify(dates)}`);

		await acquireVerificationLock();

		try {
			for (const currentDay of dates) {
				logger.info(`Verifying: ${currentDay}`);

				const previousDate = new Date(currentDay);
				previousDate.setUTCDate(previousDate.getUTCDate() - 1);
				const previousDay = previousDate.toISOString().split('T')[0];

				const [year, month, day] = currentDay.split('-');
				const trades = await query(`
				SELECT DISTINCT * FROM eventtype_traderecord
				WHERE year = '${year}' AND month = '${month}' AND day = '${day}'
			`);

				const formattedTrades = formatTradesFromAthenaForLeaderboard(trades);

				const globalVerifications = [];
				const marketVerifications = [];

				if (shouldVerifyVolume) {
					globalVerifications.push(
						verifyLeaderboardType({
							currentVerifiedKey: VERIFIED_VOLUME_KEY(currentDay),
							previousVerifiedKey: VERIFIED_VOLUME_KEY(previousDay),
							trades: formattedTrades,
							type: 'volume',
						})
					);
					globalVerifications.push(
						verifyLeaderboardType({
							currentVerifiedKey: VERIFIED_MAKER_VOLUME_KEY(currentDay),
							previousVerifiedKey: VERIFIED_MAKER_VOLUME_KEY(previousDay),
							trades: formattedTrades,
							type: 'makerVolume',
						})
					);
					globalVerifications.push(
						verifyLeaderboardType({
							currentVerifiedKey: VERIFIED_TAKER_VOLUME_KEY(currentDay),
							previousVerifiedKey: VERIFIED_TAKER_VOLUME_KEY(previousDay),
							trades: formattedTrades,
							type: 'takerVolume',
						})
					);
				}

				if (shouldVerifyPnl) {
					globalVerifications.push(
						verifyLeaderboardType({
							currentVerifiedKey: VERIFIED_PNL_KEY(currentDay),
							previousVerifiedKey: VERIFIED_PNL_KEY(previousDay),
							trades: formattedTrades,
							type: 'pnl',
						})
					);
					globalVerifications.push(
						verifyLeaderboardType({
							currentVerifiedKey: VERIFIED_USER_PNL_KEY(currentDay),
							previousVerifiedKey: VERIFIED_USER_PNL_KEY(previousDay),
							trades: formattedTrades,
							type: 'userPnl',
						})
					);
				}

				if (shouldVerifyFees) {
					globalVerifications.push(
						verifyLeaderboardType({
							currentVerifiedKey: VERIFIED_FEE_PAID_KEY(currentDay),
							previousVerifiedKey: VERIFIED_FEE_PAID_KEY(previousDay),
							trades: formattedTrades,
							type: 'feePaid',
						})
					);

					globalVerifications.push(
						verifyLeaderboardType({
							currentVerifiedKey: VERIFIED_FEE_REBATE_KEY(currentDay),
							previousVerifiedKey: VERIFIED_FEE_REBATE_KEY(previousDay),
							trades: formattedTrades,
							type: 'feeRebate',
						})
					);
				}

				await Promise.all(globalVerifications);

				const markets = await getMarkets();

				for (const market of markets) {
					const marketTrades = formattedTrades.filter((trade) => trade.symbol === market);
					if (shouldVerifyVolume) {
						marketVerifications.push(
							verifyLeaderboardType({
								currentVerifiedKey: VERIFIED_MARKET_VOLUME_KEY(currentDay, market),
								previousVerifiedKey: VERIFIED_MARKET_VOLUME_KEY(
									previousDay,
									market
								),
								trades: marketTrades,
								type: 'volume',
							})
						);
					}
					if (shouldVerifyPnl) {
						marketVerifications.push(
							verifyLeaderboardType({
								currentVerifiedKey: VERIFIED_MARKET_PNL_KEY(currentDay, market),
								previousVerifiedKey: VERIFIED_MARKET_PNL_KEY(previousDay, market),
								trades: marketTrades,
								type: 'pnl',
							})
						);
					}
				}

				await Promise.all(marketVerifications);

				await setLastVerifiedDay(currentDay);
			}
		} finally {
			await releaseVerificationLock();
		}
	} catch (error) {
		await logger.error(`Failed to verify leaderboard: ${error.message}`);
		throw error;
	}
};
