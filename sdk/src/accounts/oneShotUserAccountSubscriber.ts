import { Commitment, PublicKey } from '@solana/web3.js';
import { UserAccount } from '../types';
import { BasicUserAccountSubscriber } from './basicUserAccountSubscriber';
import { Program } from '@coral-xyz/anchor';
import { UserAccountSubscriber } from './types';

/**
 * Simple implementation of UserAccountSubscriber. It will fetch the UserAccount
 * date on subscribe (or call to fetch) if no account data is provided on init.
 * Expect to use only 1 RPC call unless you call fetch repeatedly.
 */
export class OneShotUserAccountSubscriber
	extends BasicUserAccountSubscriber
	implements UserAccountSubscriber
{
	program: Program;
	commitment: Commitment;

	public constructor(
		program: Program,
		userAccountPublicKey: PublicKey,
		data?: UserAccount,
		slot?: number,
		commitment?: Commitment
	) {
		super(userAccountPublicKey, data, slot);
		this.program = program;
		this.commitment = commitment ?? 'confirmed';
	}

	async subscribe(userAccount?: UserAccount): Promise<boolean> {
		if (userAccount) {
			this.user = { data: userAccount, slot: this.user.slot };
			return true;
		}

		await this.fetchIfUnloaded();
		if (this.doesAccountExist()) {
			this.eventEmitter.emit('update');
		}
		return true;
	}

	async fetchIfUnloaded(): Promise<void> {
		if (this.user.data === undefined) {
			await this.fetch();
		}
	}

	async fetch(): Promise<void> {
		try {
			const dataAndContext = await this.program.account.user.fetchAndContext(
				this.userAccountPublicKey,
				this.commitment
			);
			if (dataAndContext.context.slot > (this.user?.slot ?? 0)) {
				this.user = {
					data: dataAndContext.data as UserAccount,
					slot: dataAndContext.context.slot,
				};
			}
		} catch (e) {
			console.error(
				`OneShotUserAccountSubscriber.fetch() UserAccount does not exist: ${e.message}`
			);
		}
	}
}
