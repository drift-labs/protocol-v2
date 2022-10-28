import {
	DriftClient,
	getUserStatsAccountPublicKey,
	OrderRecord,
	UserStatsAccount,
	DriftUserStats,
	DriftUserStatsAccountSubscriptionConfig,
	bulkPollingUserStatsSubscribe,
} from '..';
import { ProgramAccount } from '@project-serum/anchor';
import { PublicKey } from '@solana/web3.js';

import { UserMap } from './userMap';

export class UserStatsMap {
	/**
	 * map from authority pubkey to DriftUserStats
	 */
	private userStatsMap = new Map<string, DriftUserStats>();
	private driftClient: DriftClient;
	private accountSubscription: DriftUserStatsAccountSubscriptionConfig;

	constructor(
		driftClient: DriftClient,
		accountSubscription: DriftUserStatsAccountSubscriptionConfig
	) {
		this.driftClient = driftClient;
		this.accountSubscription = accountSubscription;
	}

	public async fetchAllUserStats() {
		const userStatArray: DriftUserStats[] = [];

		const programUserAccounts =
			(await this.driftClient.program.account.userStats.all()) as ProgramAccount<UserStatsAccount>[];

		for (const programUserAccount of programUserAccounts) {
			const userStat: UserStatsAccount = programUserAccount.account;
			if (this.userStatsMap.has(userStat.authority.toString())) {
				continue;
			}

			const chUserStat = new DriftUserStats({
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
		const userStat = new DriftUserStats({
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
		if (!this.has(record.user.toString())) {
			const takerUserAccount = await userMap.mustGet(record.user.toString());
			this.addUserStat(takerUserAccount.getUserAccount().authority);
		}
	}

	public has(authorityPublicKey: string): boolean {
		return this.userStatsMap.has(authorityPublicKey);
	}

	public get(authorityPublicKey: string): DriftUserStats {
		return this.userStatsMap.get(authorityPublicKey);
	}

	public async mustGet(authorityPublicKey: string): Promise<DriftUserStats> {
		if (!this.has(authorityPublicKey)) {
			await this.addUserStat(new PublicKey(authorityPublicKey));
		}
		return this.get(authorityPublicKey);
	}

	public values(): IterableIterator<DriftUserStats> {
		return this.userStatsMap.values();
	}
}
