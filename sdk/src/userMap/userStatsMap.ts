import {
	DriftClient,
	getUserStatsAccountPublicKey,
	OrderRecord,
	UserStatsAccount,
	UserStats,
	UserStatsSubscriptionConfig,
	bulkPollingUserStatsSubscribe,
} from '..';
import { ProgramAccount } from '@project-serum/anchor';
import { PublicKey } from '@solana/web3.js';

import { UserMap } from './userMap';

export class UserStatsMap {
	/**
	 * map from authority pubkey to UserStats
	 */
	private userStatsMap = new Map<string, UserStats>();
	private driftClient: DriftClient;
	private accountSubscription: UserStatsSubscriptionConfig;

	constructor(
		driftClient: DriftClient,
		accountSubscription: UserStatsSubscriptionConfig
	) {
		this.driftClient = driftClient;
		this.accountSubscription = accountSubscription;
	}

	public async fetchAllUserStats() {
		const userStatArray: UserStats[] = [];

		const programUserAccounts =
			(await this.driftClient.program.account.userStats.all()) as ProgramAccount<UserStatsAccount>[];

		for (const programUserAccount of programUserAccounts) {
			const userStat: UserStatsAccount = programUserAccount.account;
			if (this.userStatsMap.has(userStat.authority.toString())) {
				continue;
			}

			const chUserStat = new UserStats({
				driftClient: this.driftClient,
				userStatsAccountPublicKey: getUserStatsAccountPublicKey(
					this.driftClient.program.programId,
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
		const userStat = new UserStats({
			driftClient: this.driftClient,
			userStatsAccountPublicKey: getUserStatsAccountPublicKey(
				this.driftClient.program.programId,
				authority
			),
			accountSubscription: this.accountSubscription,
		});
		await userStat.subscribe();

		this.userStatsMap.set(authority.toString(), userStat);
	}

	public async updateWithOrderRecord(record: OrderRecord, userMap: UserMap) {
		const user = await userMap.mustGet(record.user.toString());
		if (!this.has(user.getUserAccount().authority.toString())) {
			this.addUserStat(user.getUserAccount().authority);
		}
	}

	public has(authorityPublicKey: string): boolean {
		return this.userStatsMap.has(authorityPublicKey);
	}

	public get(authorityPublicKey: string): UserStats {
		return this.userStatsMap.get(authorityPublicKey);
	}

	public async mustGet(authorityPublicKey: string): Promise<UserStats> {
		if (!this.has(authorityPublicKey)) {
			await this.addUserStat(new PublicKey(authorityPublicKey));
		}
		return this.get(authorityPublicKey);
	}

	public values(): IterableIterator<UserStats> {
		return this.userStatsMap.values();
	}
}
