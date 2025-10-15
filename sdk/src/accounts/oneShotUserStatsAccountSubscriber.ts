import { Commitment, PublicKey } from '@solana/web3.js';
import { UserStatsAccount } from '../types';
import { BasicUserStatsAccountSubscriber } from './basicUserStatsAccountSubscriber';
import { Program } from '@coral-xyz/anchor';
import { UserStatsAccountSubscriber } from './types';

/**
 * Simple implementation of UserStatsAccountSubscriber. It will fetch the UserStatsAccount
 * data on subscribe (or call to fetch) if no account data is provided on init.
 * Expect to use only 1 RPC call unless you call fetch repeatedly.
 */
export class OneShotUserStatsAccountSubscriber
	extends BasicUserStatsAccountSubscriber
	implements UserStatsAccountSubscriber
{
	program: Program;
	commitment: Commitment;

	public constructor(
		program: Program,
		userStatsAccountPublicKey: PublicKey,
		data?: UserStatsAccount,
		slot?: number,
		commitment?: Commitment
	) {
		super(userStatsAccountPublicKey, data, slot);
		this.program = program;
		this.commitment = commitment ?? 'confirmed';
	}

	async subscribe(userStatsAccount?: UserStatsAccount): Promise<boolean> {
		if (userStatsAccount) {
			this.userStats = { data: userStatsAccount, slot: this.userStats.slot };
			return true;
		}

		await this.fetchIfUnloaded();
		if (this.doesAccountExist()) {
			this.eventEmitter.emit('update');
		}
		return true;
	}

	async fetchIfUnloaded(): Promise<void> {
		if (this.userStats.data === undefined) {
			await this.fetch();
		}
	}

	async fetch(): Promise<void> {
		try {
			const dataAndContext =
				await this.program.account.userStats.fetchAndContext(
					this.userStatsAccountPublicKey,
					this.commitment
				);
			if (dataAndContext.context.slot > (this.userStats?.slot ?? 0)) {
				this.userStats = {
					data: dataAndContext.data as UserStatsAccount,
					slot: dataAndContext.context.slot,
				};
			}
		} catch (e) {
			console.error(
				`OneShotUserStatsAccountSubscriber.fetch() UserStatsAccount does not exist: ${e.message}`
			);
		}
	}
}
