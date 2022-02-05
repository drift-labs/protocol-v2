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
	await Promise.all(
		users.map((user) => {
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
