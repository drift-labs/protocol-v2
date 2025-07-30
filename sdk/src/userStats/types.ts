import { BN } from '@coral-xyz/anchor';
import { DataAndSlot, UserStatsAccountSubscriber } from '../accounts/types';
import { UserStatsAccount } from '../types';
import { ReferrerInfo } from '../types';
import { PublicKey } from '@solana/web3.js';

export interface IUserStats {
	userStatsAccountPublicKey: PublicKey;
	accountSubscriber: UserStatsAccountSubscriber;
	isSubscribed: boolean;

	subscribe(userStatsAccount?: UserStatsAccount): Promise<boolean>;
	fetchAccounts(): Promise<void>;
	unsubscribe(): Promise<void>;
	getAccountAndSlot(): DataAndSlot<UserStatsAccount>;
	getAccount(): UserStatsAccount;
	getInsuranceFuelBonus(
		now: BN,
		includeSettled?: boolean,
		includeUnsettled?: boolean
	): BN;
	getReferrerInfo(): ReferrerInfo | undefined;
}
