import { IUserStats } from '../userStats/types';
import { BulkAccountLoader } from './bulkAccountLoader/bulkAccountLoader';
import { PollingUserStatsAccountSubscriber } from './userStatsAccount/pollingUserStatsAccountSubscriber';

/**
 * @param userStats
 * @param accountLoader
 */
export async function bulkPollingUserStatsSubscribe(
	userStats: IUserStats[],
	accountLoader: BulkAccountLoader
): Promise<void> {
	if (userStats.length === 0) {
		await accountLoader.load();
		return;
	}

	await Promise.all(
		userStats.map((userStat) => {
			return (
				userStat.accountSubscriber as PollingUserStatsAccountSubscriber
			).addToAccountLoader();
		})
	);

	await accountLoader.load();

	await Promise.all(
		userStats.map(async (userStat) => {
			return userStat.subscribe();
		})
	);
}
