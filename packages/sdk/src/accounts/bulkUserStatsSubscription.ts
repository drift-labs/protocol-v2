import { UserStats } from '../userStats';
import { BulkAccountLoader } from './bulkAccountLoader';
import { PollingUserStatsAccountSubscriber } from './pollingUserStatsAccountSubscriber';

/**
 * Subscribes many `UserStats`s that share a single `BulkAccountLoader` in one batched round trip,
 * instead of each `UserStats.subscribe()` triggering its own `addAccount`/`load()`. Registers
 * every account's `PollingUserStatsAccountSubscriber` with the loader first, issues one `load()`
 * to seed all of them from a single batched `getMultipleAccounts` call, and only then calls
 * `userStat.subscribe()` (which becomes a fast no-op fetch since data is already cached). If
 * `userStats` is empty, still calls `accountLoader.load()` so any other accounts already
 * registered on the loader get polled.
 * @param userStats `UserStats` instances to subscribe; each must already be constructed with a `PollingUserStatsAccountSubscriber`.
 * @param accountLoader Shared `BulkAccountLoader` batching the underlying RPC polls.
 */
export async function bulkPollingUserStatsSubscribe(
	userStats: UserStats[],
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
