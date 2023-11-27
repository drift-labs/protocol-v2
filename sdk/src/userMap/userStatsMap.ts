import {
	DriftClient,
	getUserStatsAccountPublicKey,
	OrderRecord,
	UserStatsAccount,
	UserStats,
	UserStatsSubscriptionConfig,
	WrappedEvent,
	DepositRecord,
	FundingPaymentRecord,
	LiquidationRecord,
	OrderActionRecord,
	SettlePnlRecord,
	NewUserRecord,
	LPRecord,
	InsuranceFundStakeRecord,
	StateAccount,
} from '..';
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

	public async subscribe(authorities: PublicKey[]) {
		if (this.size() > 0) {
			return;
		}

		await this.driftClient.subscribe();
		await this.sync(authorities);
	}

	public async addUserStat(
		authority: PublicKey,
		userStatsAccount?: UserStatsAccount,
		skipFetch?: boolean
	) {
		const userStat = new UserStats({
			driftClient: this.driftClient,
			userStatsAccountPublicKey: getUserStatsAccountPublicKey(
				this.driftClient.program.programId,
				authority
			),
			accountSubscription: this.accountSubscription,
		});
		if (skipFetch) {
			await userStat.addToAccountLoader();
		} else {
			await userStat.subscribe(userStatsAccount);
		}

		this.userStatsMap.set(authority.toString(), userStat);
	}

	public async updateWithOrderRecord(record: OrderRecord, userMap: UserMap) {
		const user = await userMap.mustGet(record.user.toString());
		if (!this.has(user.getUserAccount().authority.toString())) {
			await this.addUserStat(user.getUserAccount().authority, undefined, false);
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

	/**
	 * Enforce that a UserStats will exist for the given authorityPublicKey,
	 * reading one from the blockchain if necessary.
	 * @param authorityPublicKey
	 * @returns
	 */
	public async mustGet(authorityPublicKey: string): Promise<UserStats> {
		if (!this.has(authorityPublicKey)) {
			await this.addUserStat(
				new PublicKey(authorityPublicKey),
				undefined,
				false
			);
		}
		return this.get(authorityPublicKey);
	}

	public values(): IterableIterator<UserStats> {
		return this.userStatsMap.values();
	}

	public size(): number {
		return this.userStatsMap.size;
	}

	/**
	 * Sync the UserStatsMap
	 * @param authorities list of authorities to derive UserStatsAccount public keys from.
	 * You may want to get this list from UserMap in order to filter out idle users
	 */
	public async sync(authorities: PublicKey[]) {
		const userStatsMapAccounts = new Set(
			authorities.map((authority) =>
				getUserStatsAccountPublicKey(
					this.driftClient.program.programId,
					authority
				)
			)
		);
		for (const account of userStatsMapAccounts) {
			await this.addUserStat(account, undefined, true);
		}

		if (this.accountSubscription.type === 'polling') {
			await this.accountSubscription.accountLoader.load();
		}
	}

	public async unsubscribe() {
		for (const [key, userStats] of this.userStatsMap.entries()) {
			await userStats.unsubscribe();
			this.userStatsMap.delete(key);
		}
	}
}
