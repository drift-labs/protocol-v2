import { getSpotMarketSymbol, getTimestamp, logger, RateHistoryType } from '@backend/common';
import { RatesRepository } from '@backend/prometheus';
import { StatsCacheRepository } from '@backend/redis';
import { VelocityClient } from '@velocity-exchange/sdk';
import Bottleneck from 'bottleneck';
import { Scheduler } from '../services/scheduler';

const { fetchRateHistory } = RatesRepository();
const { setRateHistory } = StatsCacheRepository();

const limiter = new Bottleneck({
	maxConcurrent: 5,
	minTime: 100,
});

const STAGE = process.env.APP_STAGE ?? 'mainnet-beta';

export const setupPrometheusTasks = ({
	driftClient,
	scheduler,
}: {
	driftClient: VelocityClient;
	scheduler: ReturnType<typeof Scheduler>;
}) => {
	const spotMarkets = driftClient.getSpotMarketAccounts();

	scheduler.scheduleTask(
		'rate-stats',
		'*/5 * * * *',
		async () => {
			logger.info('Fetching rates for all markets');

			if (STAGE !== 'mainnet-beta') {
				logger.info('No rate data available in non-prod stages');
				return;
			}

			const currentTimestamp = getTimestamp();

			const marketAprsPromises = spotMarkets.map((market) =>
				limiter.schedule(async () => {
					const symbol = getSpotMarketSymbol(market.marketIndex);

					logger.info(`Fetching market: ${symbol}`);
					const depositHistory = await fetchRateHistory({
						symbol: symbol,
						start: getTimestamp({ days: -90 }),
						end: currentTimestamp,
					});

					const borrowHistory = await fetchRateHistory({
						symbol: symbol,
						type: RateHistoryType.BORROW,
						start: getTimestamp({ days: -90 }),
						end: currentTimestamp,
					});

					const depositBalanceHistory = await fetchRateHistory({
						symbol: symbol,
						type: RateHistoryType.DEPOSIT_BALANCE,
						start: getTimestamp({ days: -90 }),
						end: currentTimestamp,
					});

					const borrowBalanceHistory = await fetchRateHistory({
						symbol: symbol,
						type: RateHistoryType.BORROW_BALANCE,
						start: getTimestamp({ days: -90 }),
						end: currentTimestamp,
					});

					await setRateHistory({
						symbol,
						type: RateHistoryType.DEPOSIT,
						rates: depositHistory,
					});
					await setRateHistory({
						symbol,
						type: RateHistoryType.BORROW,
						rates: borrowHistory,
					});
					await setRateHistory({
						symbol,
						type: RateHistoryType.DEPOSIT_BALANCE,
						rates: depositBalanceHistory,
					});
					await setRateHistory({
						symbol,
						type: RateHistoryType.BORROW_BALANCE,
						rates: borrowBalanceHistory,
					});
				})
			);

			const marketAprs = await Promise.all(marketAprsPromises);
			logger.info(`Stored Rate history for ${marketAprs.length} markets`);
		},
		{
			runImmediately: true,
		}
	);
};
