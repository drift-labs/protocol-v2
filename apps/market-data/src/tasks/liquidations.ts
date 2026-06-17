import { LiquidationAnalyticsRepository } from '@backend/athena';
import { logger } from '@backend/common';
import { StatsCacheRepository } from '@backend/redis';
import { Scheduler } from '../services/scheduler';

const { getLiquidationStats, getBankruptcyStats } = LiquidationAnalyticsRepository();
const { setLiquidationStats, setBankruptcyStats } = StatsCacheRepository();

export const setupLiquidationTasks = ({
	scheduler,
}: {
	scheduler: ReturnType<typeof Scheduler>;
}) => {
	scheduler.scheduleTask(
		'liquidation-stats',
		'*/10 * * * *',
		async () => {
			logger.info('Fetching liquidation statistics');

			const twentyFourHourStats = await getLiquidationStats(1);
			const thirtyDayStats = await getLiquidationStats(30);

			await setLiquidationStats({ '24h': twentyFourHourStats, '30d': thirtyDayStats });

			logger.info('Stored liquidation statistics');
		},
		{
			runImmediately: true,
		}
	);

	scheduler.scheduleTask(
		'bankruptcy-stats',
		'*/10 * * * *',
		async () => {
			logger.info('Fetching bankruptcy statistics');

			const bankruptcyStats = await getBankruptcyStats(1);
			await setBankruptcyStats(bankruptcyStats);

			logger.info('Stored bankruptcy statistics');
		},
		{
			runImmediately: true,
		}
	);
};
