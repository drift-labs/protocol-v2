import { Commitment, PublicKey } from '@solana/web3.js';
import { UserAccount } from '../types';
import { BasicUserAccountSubscriber } from './basicUserAccountSubscriber';
import { UserAccountSubscriber } from './types';
import { VelocityProgram } from '../config';

/**
 * Simple implementation of UserAccountSubscriber. It will fetch the UserAccount
 * date on subscribe (or call to fetch) if no account data is provided on init.
 * Expect to use only 1 RPC call unless you call fetch repeatedly.
 */
export class OneShotUserAccountSubscriber
	extends BasicUserAccountSubscriber
	implements UserAccountSubscriber
{
	program: VelocityProgram;
	commitment: Commitment;

	/**
	 * @param program Anchor program used for the one-off `fetchAndContext` call.
	 * @param userAccountPublicKey Address of the `UserAccount` to fetch.
	 * @param data Optional pre-fetched account data to seed with, skipping the RPC call entirely.
	 * @param slot Slot `data` was observed at, if provided.
	 * @param commitment Commitment for the fetch; defaults to `'confirmed'`.
	 */
	public constructor(
		program: VelocityProgram,
		userAccountPublicKey: PublicKey,
		data?: UserAccount,
		slot?: number,
		commitment?: Commitment
	) {
		super(userAccountPublicKey, data, slot);
		this.program = program;
		this.commitment = commitment ?? 'confirmed';
	}

	/**
	 * If `userAccount` is supplied, seeds directly with no RPC call. Otherwise fetches once via
	 * `fetchIfUnloaded()` if no data is cached yet. Always resolves `true` — there is no
	 * persistent subscription to fail.
	 * @param userAccount Optional pre-fetched account data to seed with instead of fetching.
	 */
	async subscribe(userAccount?: UserAccount): Promise<boolean> {
		if (userAccount) {
			this.user = { data: userAccount, slot: this.user?.slot ?? 0 };
			return true;
		}

		await this.fetchIfUnloaded();
		if (this.doesAccountExist()) {
			this.eventEmitter.emit('update');
		}
		return true;
	}

	/** Fetches via `fetch()` only if no data is cached yet; otherwise a no-op. */
	async fetchIfUnloaded(): Promise<void> {
		if (!this.user) {
			await this.fetch();
		}
	}

	/**
	 * Fetches the account once via `program.account.user.fetchAndContext`, applying it only if
	 * the response's slot is newer than what's cached. Logs and swallows errors (e.g. account not
	 * yet initialized) rather than throwing.
	 */
	async fetch(): Promise<void> {
		try {
			const dataAndContext = await (
				this.program.account as any
			).user.fetchAndContext(this.userAccountPublicKey, this.commitment);
			if (dataAndContext.context.slot > (this.user?.slot ?? 0)) {
				this.user = {
					data: dataAndContext.data as UserAccount,
					slot: dataAndContext.context.slot,
				};
			}
		} catch (e) {
			console.error(
				`OneShotUserAccountSubscriber.fetch() UserAccount does not exist: ${
					e instanceof Error ? e.message : String(e)
				}`
			);
		}
	}
}
