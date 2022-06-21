import {
	AccountAndSlot,
	AccountToPoll,
	ClearingHouseAccountEvents,
	ClearingHouseAccountSubscriber,
	NotSubscribedError,
} from './types';
import { BN, Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import {
	BankAccount,
	MarketAccount,
	OrderStateAccount,
	StateAccount,
	UserAccount,
} from '../types';
import {
	getClearingHouseStateAccountPublicKey,
	getBankPublicKey,
	getMarketPublicKey,
	getUserAccountPublicKey,
} from '../addresses/pda';
import { BulkAccountLoader } from './bulkAccountLoader';
import { capitalize } from './utils';
import { ClearingHouseConfigType } from '../factory/clearingHouse';
import { PublicKey } from '@solana/web3.js';
type UserPublicKeys = {
	userAccountPublicKey: PublicKey;
};

export class PollingClearingHouseAccountSubscriber
	implements ClearingHouseAccountSubscriber
{
	isSubscribed: boolean;
	program: Program;
	authority: PublicKey;
	userId: number;
	eventEmitter: StrictEventEmitter<EventEmitter, ClearingHouseAccountEvents>;

	accountLoader: BulkAccountLoader;
	accountsToPoll = new Map<string, AccountToPoll>();
	errorCallbackId?: string;

	state?: AccountAndSlot<StateAccount>;
	market = new Map<number, AccountAndSlot<MarketAccount>>();
	bank = new Map<number, AccountAndSlot<BankAccount>>();
	orderState?: AccountAndSlot<OrderStateAccount>;
	user?: AccountAndSlot<UserAccount>;

	type: ClearingHouseConfigType = 'polling';

	private isSubscribing = false;
	private subscriptionPromise: Promise<boolean>;
	private subscriptionPromiseResolver: (val: boolean) => void;

	public constructor(
		program: Program,
		authority: PublicKey,
		accountLoader: BulkAccountLoader,
		userId: number
	) {
		this.isSubscribed = false;
		this.program = program;
		this.eventEmitter = new EventEmitter();
		this.accountLoader = accountLoader;
		this.authority = authority;
		this.userId = userId;
	}

	public async subscribe(): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		if (this.isSubscribing) {
			return await this.subscriptionPromise;
		}

		this.isSubscribing = true;

		this.subscriptionPromise = new Promise((res) => {
			this.subscriptionPromiseResolver = res;
		});

		await this.updateAccountsToPoll();
		await this.addToAccountLoader();

		let subscriptionSucceeded = false;
		let retries = 0;
		while (!subscriptionSucceeded && retries < 5) {
			await this.fetch();
			subscriptionSucceeded = this.didSubscriptionSucceed();
			retries++;
		}

		if (subscriptionSucceeded) {
			this.eventEmitter.emit('update');
		}

		this.isSubscribing = false;
		this.isSubscribed = subscriptionSucceeded;
		this.subscriptionPromiseResolver(subscriptionSucceeded);

		return subscriptionSucceeded;
	}

	async updateAccountsToPoll(): Promise<void> {
		if (this.accountsToPoll.size > 0) {
			return;
		}

		const accounts = await this.getClearingHouseAccounts();

		this.accountsToPoll.set(accounts.state.toString(), {
			key: 'state',
			publicKey: accounts.state,
			eventType: 'stateAccountUpdate',
		});

		this.accountsToPoll.set(accounts.orderState.toString(), {
			key: 'orderState',
			publicKey: accounts.orderState,
			eventType: 'orderStateAccountUpdate',
		});

		await this.updateUserAccountsToPoll();
		await this.updateMarketAccountsToPoll();
		await this.updateBankAccountsToPoll();
	}

	async updateUserAccountsToPoll(): Promise<UserPublicKeys> {
		const { userAccountPublicKey } = await this.getUserAccountPublicKeys();

		this.accountsToPoll.set(userAccountPublicKey.toString(), {
			key: 'user',
			publicKey: userAccountPublicKey,
			eventType: 'userAccountUpdate',
		});

		return {
			userAccountPublicKey,
		};
	}

	async updateMarketAccountsToPoll(): Promise<boolean> {
		for (let i = 0; i < 10; i++) {
			const marketPublicKey = await getMarketPublicKey(
				this.program.programId,
				new BN(i)
			);

			this.accountsToPoll.set(marketPublicKey.toString(), {
				key: 'market',
				publicKey: marketPublicKey,
				eventType: 'marketAccountUpdate',
				mapKey: i,
			});
		}

		return true;
	}

	async updateBankAccountsToPoll(): Promise<boolean> {
		for (let i = 0; i < 10; i++) {
			const bankPublicKey = await getBankPublicKey(
				this.program.programId,
				new BN(i)
			);

			this.accountsToPoll.set(bankPublicKey.toString(), {
				key: 'bank',
				publicKey: bankPublicKey,
				eventType: 'bankAccountUpdate',
				mapKey: i,
			});
		}

		return true;
	}

	async getClearingHouseAccounts(): Promise<ClearingHouseAccounts> {
		const statePublicKey = await getClearingHouseStateAccountPublicKey(
			this.program.programId
		);

		const state = (await this.program.account.state.fetch(
			statePublicKey
		)) as StateAccount;

		const accounts = {
			state: statePublicKey,
			orderState: state.orderState,
		};

		return accounts;
	}

	async getUserAccountPublicKeys(): Promise<UserPublicKeys> {
		const userAccountPublicKey = await getUserAccountPublicKey(
			this.program.programId,
			this.authority,
			this.userId
		);

		return {
			userAccountPublicKey,
		};
	}

	async addToAccountLoader(): Promise<void> {
		for (const [_, accountToPoll] of this.accountsToPoll) {
			this.addAccountToAccountLoader(accountToPoll);
		}

		this.errorCallbackId = this.accountLoader.addErrorCallbacks((error) => {
			this.eventEmitter.emit('error', error);
		});
	}

	addAccountToAccountLoader(accountToPoll: AccountToPoll): void {
		accountToPoll.callbackId = this.accountLoader.addAccount(
			accountToPoll.publicKey,
			(buffer, slot) => {
				if (!buffer) return;
				const account = this.program.account[
					accountToPoll.key
				].coder.accounts.decode(capitalize(accountToPoll.key), buffer);
				const accountAndSlot = {
					account,
					slot,
				};
				if (accountToPoll.mapKey != undefined) {
					this[accountToPoll.key].set(accountToPoll.mapKey, accountAndSlot);
				} else {
					this[accountToPoll.key] = accountAndSlot;
				}

				// @ts-ignore
				this.eventEmitter.emit(accountToPoll.eventType, account);
				this.eventEmitter.emit('update');

				if (!this.isSubscribed) {
					this.isSubscribed = this.didSubscriptionSucceed();
				}
			}
		);
	}

	public async fetch(): Promise<void> {
		await this.accountLoader.load();
		for (const [_, accountToPoll] of this.accountsToPoll) {
			const { buffer, slot } = this.accountLoader.getBufferAndSlot(
				accountToPoll.publicKey
			);
			if (buffer) {
				const account = this.program.account[
					accountToPoll.key
				].coder.accounts.decode(capitalize(accountToPoll.key), buffer);

				if (accountToPoll.mapKey != undefined) {
					this[accountToPoll.key].set(accountToPoll.mapKey, { account, slot });
				} else {
					this[accountToPoll.key] = {
						account,
						slot,
					};
				}
			}
		}
	}

	didSubscriptionSucceed(): boolean {
		if (this.state) return true;

		return false;
	}

	public async unsubscribe(): Promise<void> {
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

	public async updateAuthority(newAuthority: PublicKey): Promise<boolean> {
		let userAccountPublicKeys = Object.values(
			await this.getUserAccountPublicKeys()
		);

		// remove the old user accounts
		for (const publicKey of userAccountPublicKeys) {
			const accountToPoll = this.accountsToPoll.get(publicKey.toString());
			this.accountLoader.removeAccount(
				accountToPoll.publicKey,
				accountToPoll.callbackId
			);
			this.accountsToPoll.delete(publicKey.toString());
		}

		// update authority
		this.authority = newAuthority;

		// add new user accounts
		userAccountPublicKeys = Object.values(
			await this.updateUserAccountsToPoll()
		);
		for (const publicKey of userAccountPublicKeys) {
			const accountToPoll = this.accountsToPoll.get(publicKey.toString());
			this.addAccountToAccountLoader(accountToPoll);
		}

		return true;
	}

	public async updateUserId(newUserId: number): Promise<boolean> {
		let userAccountPublicKeys = Object.values(
			await this.getUserAccountPublicKeys()
		);

		// remove the old user accounts
		for (const publicKey of userAccountPublicKeys) {
			const accountToPoll = this.accountsToPoll.get(publicKey.toString());
			this.accountLoader.removeAccount(
				accountToPoll.publicKey,
				accountToPoll.callbackId
			);
			this.accountsToPoll.delete(publicKey.toString());
		}

		// update authority
		this.userId = newUserId;

		// add new user accounts
		userAccountPublicKeys = Object.values(
			await this.updateUserAccountsToPoll()
		);
		for (const publicKey of userAccountPublicKeys) {
			const accountToPoll = this.accountsToPoll.get(publicKey.toString());
			this.addAccountToAccountLoader(accountToPoll);
		}

		return true;
	}

	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	public getStateAccountAndSlot(): AccountAndSlot<StateAccount> {
		this.assertIsSubscribed();
		return this.state;
	}

	public getMarketAccountAndSlot(
		marketIndex: BN
	): AccountAndSlot<MarketAccount> | undefined {
		return this.market.get(marketIndex.toNumber());
	}

	public getBankAccountAndSlot(
		bankIndex: BN
	): AccountAndSlot<BankAccount> | undefined {
		return this.bank.get(bankIndex.toNumber());
	}

	public getOrderStateAccountAndSlot(): AccountAndSlot<OrderStateAccount> {
		this.assertIsSubscribed();
		return this.orderState;
	}

	public getUserAccountAndSlot(): AccountAndSlot<UserAccount> | undefined {
		this.assertIsSubscribed();
		return this.user;
	}
}

type ClearingHouseAccounts = {
	state: PublicKey;
	orderState: PublicKey;
};
