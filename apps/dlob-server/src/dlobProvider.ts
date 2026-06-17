import {
	DLOB,
	OrderSubscriber,
	UserAccount,
	UserMap,
} from '@velocity-exchange/sdk';
import { PublicKey } from '@solana/web3.js';

export type DLOBProvider = {
	subscribe(): Promise<void>;
	getDLOB(slot: number): Promise<DLOB>;
	getUniqueAuthorities(): PublicKey[];
	getUserAccounts(): Generator<{
		userAccount: UserAccount;
		publicKey: PublicKey;
	}>;
	getUserAccount(publicKey: PublicKey): UserAccount | undefined;
	size(): number;
	fetch(): Promise<void>;
	getSlot(): number;
};

export function getDLOBProviderFromUserMap(userMap: UserMap): DLOBProvider {
	return {
		subscribe: async () => {
			await userMap.subscribe();
		},
		getDLOB: async (slot: number) => {
			return await userMap.getDLOB(slot);
		},
		getUniqueAuthorities: () => {
			return userMap.getUniqueAuthorities();
		},
		getUserAccounts: function* () {
			for (const user of userMap.values()) {
				yield {
					userAccount: user.getUserAccount(),
					publicKey: user.getUserAccountPublicKey(),
				};
			}
		},
		getUserAccount: (publicKey) => {
			return userMap.get(publicKey.toString())?.getUserAccount();
		},
		size: () => {
			return userMap.size();
		},
		fetch: () => {
			return userMap.sync();
		},
		getSlot: () => {
			return userMap.getSlot();
		},
	};
}

export function getDLOBProviderFromOrderSubscriber(
	orderSubscriber: OrderSubscriber
): DLOBProvider {
	return {
		subscribe: async () => {
			await orderSubscriber.subscribe();
		},
		getDLOB: async (slot: number) => {
			return await orderSubscriber.getDLOB(slot);
		},
		getUniqueAuthorities: () => {
			const authorities = new Set<string>();
			for (const { userAccount } of orderSubscriber.usersAccounts.values()) {
				authorities.add(userAccount.authority.toBase58());
			}
			const pubkeys = Array.from(authorities).map((a) => new PublicKey(a));
			return pubkeys;
		},
		getUserAccounts: function* () {
			for (const [
				key,
				{ userAccount },
			] of orderSubscriber.usersAccounts.entries()) {
				yield { userAccount: userAccount, publicKey: new PublicKey(key) };
			}
		},
		getUserAccount: (publicKey) => {
			return orderSubscriber.usersAccounts.get(publicKey.toString())
				?.userAccount;
		},
		size(): number {
			return orderSubscriber.usersAccounts.size;
		},
		fetch() {
			return orderSubscriber.fetch();
		},
		getSlot: () => {
			return orderSubscriber.getSlot();
		},
	};
}
