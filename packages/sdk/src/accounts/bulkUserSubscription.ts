import { User } from '../user';
import { BulkAccountLoader } from './bulkAccountLoader';
import { PollingUserAccountSubscriber } from './pollingUserAccountSubscriber';

/**
 * Subscribes many `User`s that share a single `BulkAccountLoader` in one batched round trip,
 * instead of each `User.subscribe()` triggering its own `addAccount`/`load()`. Registers every
 * user's `PollingUserAccountSubscriber` with the loader first, issues one `load()` to seed all of
 * them from a single batched `getMultipleAccounts` call, and only then calls `user.subscribe()`
 * (which becomes a fast no-op fetch since data is already cached). If `users` is empty, still
 * calls `accountLoader.load()` so any other accounts already registered on the loader get polled.
 * @param users Users to subscribe; each must already be constructed with a `PollingUserAccountSubscriber`.
 * @param accountLoader Shared `BulkAccountLoader` batching the underlying RPC polls.
 */
export async function bulkPollingUserSubscribe(
	users: User[],
	accountLoader: BulkAccountLoader
): Promise<void> {
	if (users.length === 0) {
		await accountLoader.load();
		return;
	}

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
