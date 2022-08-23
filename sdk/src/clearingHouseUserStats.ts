import { ClearingHouse } from './clearingHouse';
import { PublicKey } from '@solana/web3.js';
import { DataAndSlot, UserStatsAccountSubscriber } from './accounts/types';
import { ClearingHouseUserStatsConfig } from './clearingHouseUserStatsConfig';
import { PollingUserStatsAccountSubscriber } from './accounts/pollingUserStatsAccountSubscriber';
import { WebSocketUserStatsAccountSubscriber } from './accounts/webSocketUserStatsAccountSubsriber';
import { ReferrerInfo, UserStatsAccount } from './types';
import {
	getUserAccountPublicKeySync,
	getUserStatsAccountPublicKey,
} from './addresses/pda';

export class ClearingHouseUserStats {
	clearingHouse: ClearingHouse;
	userStatsAccountPublicKey: PublicKey;
	accountSubscriber: UserStatsAccountSubscriber;
	isSubscribed: boolean;

	public constructor(config: ClearingHouseUserStatsConfig) {
		this.clearingHouse = config.clearingHouse;
		this.userStatsAccountPublicKey = config.userStatsAccountPublicKey;
		if (config.accountSubscription?.type === 'polling') {
			this.accountSubscriber = new PollingUserStatsAccountSubscriber(
				config.clearingHouse.program,
				config.userStatsAccountPublicKey,
				config.accountSubscription.accountLoader
			);
		} else {
			this.accountSubscriber = new WebSocketUserStatsAccountSubscriber(
				config.clearingHouse.program,
				config.userStatsAccountPublicKey
			);
		}
	}

	public async subscribe(): Promise<boolean> {
		this.isSubscribed = await this.accountSubscriber.subscribe();
		return this.isSubscribed;
	}

	public async fetchAccounts(): Promise<void> {
		await this.accountSubscriber.fetch();
	}

	public async unsubscribe(): Promise<void> {
		await this.accountSubscriber.unsubscribe();
		this.isSubscribed = false;
	}

	public getAccountAndSlot(): DataAndSlot<UserStatsAccount> {
		return this.accountSubscriber.getUserStatsAccountAndSlot();
	}

	public getAccount(): UserStatsAccount {
		return this.accountSubscriber.getUserStatsAccountAndSlot().data;
	}

	public getReferrerInfo(): ReferrerInfo | undefined {
		if (this.getAccount().referrer.equals(PublicKey.default)) {
			return undefined;
		} else {
			return {
				referrer: getUserAccountPublicKeySync(
					this.clearingHouse.program.programId,
					this.getAccount().referrer,
					0
				),
				referrerStats: getUserStatsAccountPublicKey(
					this.clearingHouse.program.programId,
					this.getAccount().referrer
				),
			};
		}
	}
}
