import {
	DriftClient,
	getUserStatsAccountPublicKey,
	OrderRecord,
	UserStatsAccount,
	UserStats,
	UserStatsSubscriptionConfig,
	bulkPollingUserStatsSubscribe,
	WrappedEvent,
	DepositRecord,
	FundingPaymentRecord,
	LiquidationRecord,
	OrderActionRecord,
	SettlePnlRecord,
	NewUserRecord,
	LPRecord,
	InsuranceFundStakeRecord,
} from '..';
import { ProgramAccount } from '@project-serum/anchor';
import { AccountInfo, PublicKey } from '@solana/web3.js';

import { UserMap } from './userMap';
import { Buffer } from 'buffer';

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
		const userStatsAccountArray: UserStatsAccount[] = [];

		const programUserAccounts =
			(await this.driftClient.program.account.userStats.all()) as ProgramAccount<UserStatsAccount>[];

		for (const programUserAccount of programUserAccounts) {
			const userStat: UserStatsAccount = programUserAccount.account;
			if (this.userStatsMap.has(userStat.authority.toString())) {
				continue;
			}

			const chUserStat = new UserStats({
				driftClient: this.driftClient,
				userStatsAccountPublicKey: programUserAccount.publicKey,
				accountSubscription: this.accountSubscription,
			});
			userStatArray.push(chUserStat);
			userStatsAccountArray.push(userStat);
		}

		if (this.accountSubscription.type === 'polling') {
			await bulkPollingUserStatsSubscribe(
				userStatArray,
				this.accountSubscription.accountLoader
			);
		} else {
			await Promise.all(
				userStatArray.map((userStat, i) =>
					userStat.subscribe(userStatsAccountArray[i])
				)
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

	public async updateWithEventRecord(
		record: WrappedEvent<any>,
		userMap?: UserMap
	) {
		if (record.eventType === 'DepositRecord') {
			const depositRecord = record as DepositRecord;
			await this.mustGet(depositRecord.userAuthority.toString());
		} else if (record.eventType === 'FundingPaymentRecord') {
			const fundingPaymentRecord = record as FundingPaymentRecord;
			await this.mustGet(fundingPaymentRecord.userAuthority.toString());
		} else if (record.eventType === 'LiquidationRecord') {
			if (!userMap) {
				return;
			}

			const liqRecord = record as LiquidationRecord;

			const user = await userMap.mustGet(liqRecord.user.toString());
			await this.mustGet(user.getUserAccount().authority.toString());

			const liquidatorUser = await userMap.mustGet(
				liqRecord.liquidator.toString()
			);
			await this.mustGet(liquidatorUser.getUserAccount().authority.toString());
		} else if (record.eventType === 'OrderRecord') {
			if (!userMap) {
				return;
			}
			const orderRecord = record as OrderRecord;
			await userMap.updateWithOrderRecord(orderRecord);
		} else if (record.eventType === 'OrderActionRecord') {
			if (!userMap) {
				return;
			}
			const actionRecord = record as OrderActionRecord;

			if (actionRecord.taker) {
				const taker = await userMap.mustGet(actionRecord.taker.toString());
				await this.mustGet(taker.getUserAccount().authority.toString());
			}
			if (actionRecord.maker) {
				const maker = await userMap.mustGet(actionRecord.maker.toString());
				await this.mustGet(maker.getUserAccount().authority.toString());
			}
		} else if (record.eventType === 'SettlePnlRecord') {
			if (!userMap) {
				return;
			}
			const settlePnlRecord = record as SettlePnlRecord;
			const user = await userMap.mustGet(settlePnlRecord.user.toString());
			await this.mustGet(user.getUserAccount().authority.toString());
		} else if (record.eventType === 'NewUserRecord') {
			const newUserRecord = record as NewUserRecord;
			await this.mustGet(newUserRecord.userAuthority.toString());
		} else if (record.eventType === 'LPRecord') {
			if (!userMap) {
				return;
			}
			const lpRecord = record as LPRecord;
			const user = await userMap.mustGet(lpRecord.user.toString());
			await this.mustGet(user.getUserAccount().authority.toString());
		} else if (record.eventType === 'InsuranceFundStakeRecord') {
			const ifStakeRecord = record as InsuranceFundStakeRecord;
			await this.mustGet(ifStakeRecord.userAuthority.toString());
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

	public size(): number {
		return this.userStatsMap.size;
	}

	public async sync() {
		const programAccounts =
			await this.driftClient.connection.getProgramAccounts(
				this.driftClient.program.programId,
				{
					commitment: this.driftClient.connection.commitment,
					filters: [
						{
							memcmp:
								this.driftClient.program.coder.accounts.memcmp('UserStats'),
						},
					],
				}
			);

		const programAccountMap = new Map<string, AccountInfo<Buffer>>();
		for (const programAccount of programAccounts) {
			programAccountMap.set(
				new PublicKey(programAccount.account.data.slice(8, 40)).toString(),
				programAccount.account
			);
		}

		for (const key of programAccountMap.keys()) {
			if (!this.has(key)) {
				await this.addUserStat(new PublicKey(key));
			}
		}
	}
}
