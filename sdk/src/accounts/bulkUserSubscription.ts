import { ClearingHouseUser } from '../clearingHouseUser';
import { BulkAccountLoader } from './bulkAccountLoader';
import { PollingUserAccountSubscriber } from './pollingUserAccountSubscriber';
import { UserPublicKeys } from './types';

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

	// Create a map of the authority to keys
	const authorityToKeys = new Map<string, UserPublicKeys>();
	for (const user of users) {
		authorityToKeys.set(user.authority.toString(), {
			user: await user.getUserAccountPublicKey(),
		});
	}

	await Promise.all(
		users.map((user) => {
			// Pull the keys from the authority map so we can skip fetching them in addToAccountLoader
			const userPublicKeys = authorityToKeys.get(user.authority.toString());
			return (
				user.accountSubscriber as PollingUserAccountSubscriber
			).addToAccountLoader(userPublicKeys);
		})
	);

	await accountLoader.load();

	await Promise.all(
		users.map(async (user) => {
			return user.subscribe();
		})
	);
}
