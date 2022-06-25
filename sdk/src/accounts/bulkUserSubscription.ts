import { ClearingHouseUser } from '../clearingHouseUser';
import { BulkAccountLoader } from './bulkAccountLoader';
import { PollingUserAccountSubscriber } from './pollingUserAccountSubscriber';

/**
 * @param users
 * @param accountLoader
 */
export async function bulkPollingUserSubscribe(
	users: ClearingHouseUser[],
	accountLoader: BulkAccountLoader
): Promise<void> {
	if (users.length === 0) {
		await accountLoader.load();
		return;
	}

	await Promise.all(
		users.map((user) => {
			// Pull the keys from the authority map so we can skip fetching them in addToAccountLoader
			return (
				user.accountSubscriber as PollingUserAccountSubscriber
			).addToAccountLoader();
		})
	);

	await accountLoader.load();

	await Promise.all(
		users.map(async (user) => {
			return user.subscribe();
		})
	);
}
