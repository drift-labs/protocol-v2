import {
	ClearingHouseUser,
	ClearingHouse,
	UserAccount,
	bulkPollingUserSubscribe,
	OrderRecord,
	ClearingHouseUserAccountSubscriptionConfig,
} from '..';
import { ProgramAccount } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

export class UserMap {
	private userMap = new Map<string, ClearingHouseUser>();
	private clearingHouse: ClearingHouse;
	private accountSubscription: ClearingHouseUserAccountSubscriptionConfig;

	constructor(
		clearingHouse: ClearingHouse,
		accountSubscription: ClearingHouseUserAccountSubscriptionConfig
	) {
		this.clearingHouse = clearingHouse;
		this.accountSubscription = accountSubscription;
	}

	public async fetchAllUsers() {
		const userArray: ClearingHouseUser[] = [];

		const programUserAccounts =
			(await this.clearingHouse.program.account.user.all()) as ProgramAccount<UserAccount>[];
		for (const programUserAccount of programUserAccounts) {
			if (this.userMap.has(programUserAccount.publicKey.toString())) {
				continue;
			}

			const user = new ClearingHouseUser({
				clearingHouse: this.clearingHouse,
				userAccountPublicKey: programUserAccount.publicKey,
				accountSubscription: this.accountSubscription,
			});
			userArray.push(user);
		}

		if (this.accountSubscription.type === 'polling') {
			await bulkPollingUserSubscribe(
				userArray,
				this.accountSubscription.accountLoader
			);
		}

		for (const user of userArray) {
			this.userMap.set(user.getUserAccountPublicKey().toString(), user);
		}
	}

	public async addPubkey(userAccountPublicKey: PublicKey) {
		const user = new ClearingHouseUser({
			clearingHouse: this.clearingHouse,
			userAccountPublicKey,
			accountSubscription: this.accountSubscription,
		});
		await user.subscribe();
		this.userMap.set(userAccountPublicKey.toString(), user);
	}

	public has(key: string): boolean {
		return this.userMap.has(key);
	}

	/**
	 * gets the ClearingHouseUser for a particular userAccountPublicKey, if no ClearingHouseUser exists, undefined is returned
	 * @param key userAccountPublicKey to get ClearngHouseUserFor
	 * @returns user ClearingHouseUser | undefined
	 */
	public get(key: string): ClearingHouseUser | undefined {
		return this.userMap.get(key);
	}

	/**
	 * gets the ClearingHouseUser for a particular userAccountPublicKey, if no ClearingHouseUser exists, new one is created
	 * @param key userAccountPublicKey to get ClearngHouseUserFor
	 * @returns  ClearingHouseUser
	 */
	public async mustGet(key: string): Promise<ClearingHouseUser> {
		if (!this.has(key)) {
			await this.addPubkey(new PublicKey(key));
		}
		const user = this.userMap.get(key);
		await user.fetchAccounts();
		return user;
	}

	public async updateWithOrderRecord(record: OrderRecord) {
		await this.addPubkey(record.user);
	}

	public values(): IterableIterator<ClearingHouseUser> {
		return this.userMap.values();
	}
}
