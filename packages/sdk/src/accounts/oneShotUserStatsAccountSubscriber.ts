import { Commitment, PublicKey } from '@solana/web3.js';
import { UserStatsAccount } from '../types';
import { BasicUserStatsAccountSubscriber } from './basicUserStatsAccountSubscriber';
import { UserStatsAccountSubscriber } from './types';
import { VelocityProgram } from '../config';

/**
 * Simple implementation of UserStatsAccountSubscriber. It will fetch the UserStatsAccount
 * data on subscribe (or call to fetch) if no account data is provided on init.
 * Expect to use only 1 RPC call unless you call fetch repeatedly.
 */
export class OneShotUserStatsAccountSubscriber
	extends BasicUserStatsAccountSubscriber
	implements UserStatsAccountSubscriber
{
	program: VelocityProgram;
	commitment: Commitment;

	/**
	 * @param program Anchor program used for the one-off `fetchAndContext` call.
	 * @param userStatsAccountPublicKey Address of the `UserStatsAccount` to fetch.
	 * @param data Optional pre-fetched account data to seed with, skipping the RPC call entirely.
	 * @param slot Slot `data` was observed at, if provided.
	 * @param commitment Commitment for the fetch; defaults to `'confirmed'`.
	 */
	public constructor(
		program: VelocityProgram,
		userStatsAccountPublicKey: PublicKey,
		data?: UserStatsAccount,
		slot?: number,
		commitment?: Commitment
	) {
		super(userStatsAccountPublicKey, data, slot);
		this.program = program;
		this.commitment = commitment ?? 'confirmed';
	}

	/**
	 * If `userStatsAccount` is supplied, seeds directly with no RPC call. Otherwise fetches once
	 * via `fetchIfUnloaded()` if no data is cached yet. Always resolves `true` — there is no
	 * persistent subscription to fail.
	 * @param userStatsAccount Optional pre-fetched account data to seed with instead of fetching.
	 */
	async subscribe(userStatsAccount?: UserStatsAccount): Promise<boolean> {
		if (userStatsAccount) {
			this.userStats = {
				data: userStatsAccount,
				slot: this.userStats?.slot ?? 0,
			};
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
		if (!this.userStats) {
			await this.fetch();
		}
	}

	/**
	 * Fetches the account once via `program.account.userStats.fetchAndContext`, applying it only
	 * if the response's slot is newer than what's cached. Logs and swallows errors (e.g. account
	 * not yet initialized) rather than throwing.
	 */
	async fetch(): Promise<void> {
		try {
			const dataAndContext = await (
				this.program.account as any
			).userStats.fetchAndContext(
				this.userStatsAccountPublicKey,
				this.commitment
			);
			if (dataAndContext.context.slot > (this.userStats?.slot ?? 0)) {
				this.userStats = {
					data: dataAndContext.data as unknown as UserStatsAccount,
					slot: dataAndContext.context.slot,
				};
			}
		} catch (e) {
			console.error(
				`OneShotUserStatsAccountSubscriber.fetch() UserStatsAccount does not exist: ${
					e instanceof Error ? e.message : String(e)
				}`
			);
		}
	}
}
