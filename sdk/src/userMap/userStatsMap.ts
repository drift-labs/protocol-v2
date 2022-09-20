import {
	ClearingHouse,
	getUserStatsAccountPublicKey,
	OrderRecord,
	UserStatsAccount,
	ClearingHouseUserStats,
	ClearingHouseUserStatsAccountSubscriptionConfig,
	bulkPollingUserStatsSubscribe,
} from '..';
import { ProgramAccount } from '@project-serum/anchor';
import { PublicKey } from '@solana/web3.js';

import { UserMap } from './userMap';

export class UserStatsMap {
	/**
	 * map from authority pubkey to ClearingHouseUserStats
	 */
	private userStatsMap = new Map<string, ClearingHouseUserStats>();
	private clearingHouse: ClearingHouse;
	private accountSubscription: ClearingHouseUserStatsAccountSubscriptionConfig;

	constructor(
		clearingHouse: ClearingHouse,
		accountSubscription: ClearingHouseUserStatsAccountSubscriptionConfig
	) {
		this.clearingHouse = clearingHouse;
		this.accountSubscription = accountSubscription;
	}

	public async fetchAllUserStats() {
		const userStatArray: ClearingHouseUserStats[] = [];

		const programUserAccounts =
			(await this.clearingHouse.program.account.userStats.all()) as ProgramAccount<UserStatsAccount>[];

		for (const programUserAccount of programUserAccounts) {
			const userStat: UserStatsAccount = programUserAccount.account;
			if (this.userStatsMap.has(userStat.authority.toString())) {
				continue;
			}

			const chUserStat = new ClearingHouseUserStats({
				clearingHouse: this.clearingHouse,
				userStatsAccountPublicKey: getUserStatsAccountPublicKey(
					this.clearingHouse.program.programId,
					userStat.authority
				),
				accountSubscription: this.accountSubscription,
			});
			userStatArray.push(chUserStat);
		}

		if (this.accountSubscription.type === 'polling') {
			await bulkPollingUserStatsSubscribe(
				userStatArray,
				this.accountSubscription.accountLoader
			);
		}

		for (const userStat of userStatArray) {
			this.userStatsMap.set(
				userStat.getAccount().authority.toString(),
				userStat
			);
		}
	}

	public async addUserStat(authority: PublicKey) {
		const userStat = new ClearingHouseUserStats({
			clearingHouse: this.clearingHouse,
			userStatsAccountPublicKey: getUserStatsAccountPublicKey(
				this.clearingHouse.program.programId,
				authority
			),
			accountSubscription: this.accountSubscription,
		});
		await userStat.subscribe();

		this.userStatsMap.set(authority.toString(), userStat);
	}

	public async updateWithOrderRecord(record: OrderRecord, userMap: UserMap) {
		if (!this.has(record.user.toString())) {
			const takerUserAccount = await userMap.mustGet(record.user.toString());
			this.addUserStat(takerUserAccount.getUserAccount().authority);
		}
	}

	public has(authorityPublicKey: string): boolean {
		return this.userStatsMap.has(authorityPublicKey);
	}

	public get(authorityPublicKey: string): ClearingHouseUserStats {
		return this.userStatsMap.get(authorityPublicKey);
	}

	public async mustGet(
		authorityPublicKey: string
	): Promise<ClearingHouseUserStats> {
		if (!this.has(authorityPublicKey)) {
			await this.addUserStat(new PublicKey(authorityPublicKey));
		}
		return this.get(authorityPublicKey);
	}

	public values(): IterableIterator<ClearingHouseUserStats> {
		return this.userStatsMap.values();
	}
}
