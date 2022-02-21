import {
	AccountToPoll,
	NotSubscribedError,
	UserAccountEvents,
	UserAccountSubscriber,
	UserPublicKeys,
} from './types';
import { Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import {
	getUserAccountPublicKey,
	getUserOrdersAccountPublicKey,
} from '../addresses';
import { UserAccount, UserOrdersAccount, UserPositionsAccount } from '../types';
import { BulkAccountLoader } from './bulkAccountLoader';
import { capitalize } from './utils';
import { ClearingHouseConfigType } from '../factory/clearingHouse';

export class PollingUserAccountSubscriber implements UserAccountSubscriber {
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	authority: PublicKey;

	accountLoader: BulkAccountLoader;
	accountsToPoll = new Map<string, AccountToPoll>();
	errorCallbackId?: string;

	user?: UserAccount;
	userPositions?: UserPositionsAccount;
	userOrders?: UserOrdersAccount;

	type: ClearingHouseConfigType = 'polling';

	public constructor(
		program: Program,
		authority: PublicKey,
		accountLoader: BulkAccountLoader
	) {
		this.isSubscribed = false;
		this.program = program;
		this.authority = authority;
		this.accountLoader = accountLoader;
		this.eventEmitter = new EventEmitter();
	}

	async subscribe(): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		await this.addToAccountLoader();
		await this.fetchIfUnloaded();
		this.eventEmitter.emit('update');

		this.isSubscribed = true;
		return true;
	}

	async addToAccountLoader(userPublicKeys?: UserPublicKeys): Promise<void> {
		if (this.accountsToPoll.size > 0) {
			return;
		}

		if (!userPublicKeys) {
			const userPublicKey = await getUserAccountPublicKey(
				this.program.programId,
				this.authority
			);

			const userAccount = (await this.program.account.user.fetch(
				userPublicKey
			)) as UserAccount;

			this.accountsToPoll.set(userPublicKey.toString(), {
				key: 'user',
				publicKey: userPublicKey,
				eventType: 'userAccountData',
			});

			this.accountsToPoll.set(userAccount.positions.toString(), {
				key: 'userPositions',
				publicKey: userAccount.positions,
				eventType: 'userPositionsData',
			});

			const userOrdersPublicKey = await getUserOrdersAccountPublicKey(
				this.program.programId,
				userPublicKey
			);

			this.accountsToPoll.set(userOrdersPublicKey.toString(), {
				key: 'userOrders',
				publicKey: userOrdersPublicKey,
				eventType: 'userOrdersData',
			});
		} else {
			this.accountsToPoll.set(userPublicKeys.user.toString(), {
				key: 'user',
				publicKey: userPublicKeys.user,
				eventType: 'userAccountData',
			});

			this.accountsToPoll.set(userPublicKeys.userPositions.toString(), {
				key: 'userPositions',
				publicKey: userPublicKeys.userPositions,
				eventType: 'userPositionsData',
			});

			if (userPublicKeys.userOrders) {
				this.accountsToPoll.set(userPublicKeys.userOrders.toString(), {
					key: 'userOrders',
					publicKey: userPublicKeys.userOrders,
					eventType: 'userOrdersData',
				});
			}
		}

		for (const [_, accountToPoll] of this.accountsToPoll) {
			accountToPoll.callbackId = this.accountLoader.addAccount(
				accountToPoll.publicKey,
				(buffer) => {
					if (!buffer) {
						return;
					}

					const account = this.program.account[
						accountToPoll.key
					].coder.accounts.decode(capitalize(accountToPoll.key), buffer);
					this[accountToPoll.key] = account;
					// @ts-ignore
					this.eventEmitter.emit(accountToPoll.eventType, account);
					this.eventEmitter.emit('update');
				}
			);
		}

		this.errorCallbackId = this.accountLoader.addErrorCallbacks((error) => {
			this.eventEmitter.emit('error', error);
		});
	}

	async fetchIfUnloaded(): Promise<void> {
		let shouldFetch = false;
		for (const [_, accountToPoll] of this.accountsToPoll) {
			if (this[accountToPoll.key] === undefined) {
				shouldFetch = true;
				break;
			}
		}

		if (shouldFetch) {
			await this.fetch();
		}
	}

	async fetch(): Promise<void> {
		await this.accountLoader.load();
		for (const [_, accountToPoll] of this.accountsToPoll) {
			const buffer = this.accountLoader.getAccountData(accountToPoll.publicKey);
			if (buffer) {
				this[accountToPoll.key] = this.program.account[
					accountToPoll.key
				].coder.accounts.decode(capitalize(accountToPoll.key), buffer);
			}
		}
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		for (const [_, accountToPoll] of this.accountsToPoll) {
			this.accountLoader.removeAccount(
				accountToPoll.publicKey,
				accountToPoll.callbackId
			);
		}

		this.accountLoader.removeErrorCallbacks(this.errorCallbackId);
		this.errorCallbackId = undefined;

		this.accountsToPoll.clear();

		this.isSubscribed = false;
	}

	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	public getUserAccount(): UserAccount {
		this.assertIsSubscribed();
		return this.user;
	}

	public getUserPositionsAccount(): UserPositionsAccount {
		this.assertIsSubscribed();
		return this.userPositions;
	}

	public getUserOrdersAccount(): UserOrdersAccount {
		this.assertIsSubscribed();
		return this.userOrders;
	}
}
