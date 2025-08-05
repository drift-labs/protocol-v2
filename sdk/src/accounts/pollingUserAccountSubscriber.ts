import {
	DataAndSlot,
	NotSubscribedError,
	UserAccountEvents,
	UserAccountSubscriber,
} from './types';
import { Connection } from '../bankrun/bankrunConnection';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { UserAccount } from '../types';
import { BulkAccountLoader } from './bulkAccountLoader';

export class PollingUserAccountSubscriber implements UserAccountSubscriber {
	isSubscribed: boolean;
	connection: Connection;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	userAccountPublicKey: PublicKey;

	accountLoader: BulkAccountLoader;
	callbackId?: string;
	errorCallbackId?: string;

	decode: (name, buffer) => UserAccount;

	user?: DataAndSlot<UserAccount>;

	public constructor(
		connection: Connection,
		userAccountPublicKey: PublicKey,
		accountLoader: BulkAccountLoader,
		decode: (name, buffer) => UserAccount
	) {
		this.isSubscribed = false;
		this.connection = connection;
		this.accountLoader = accountLoader;
		this.eventEmitter = new EventEmitter();
		this.userAccountPublicKey = userAccountPublicKey;
		this.decode = decode;
	}

	async subscribe(userAccount?: UserAccount): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		if (userAccount) {
			this.user = { data: userAccount, slot: undefined };
		}

		await this.addToAccountLoader();

		await this.fetchIfUnloaded();
		if (this.doesAccountExist()) {
			this.eventEmitter.emit('update');
		}

		this.isSubscribed = true;
		return true;
	}

	async addToAccountLoader(): Promise<void> {
		if (this.callbackId) {
			return;
		}

		this.callbackId = await this.accountLoader.addAccount(
			this.userAccountPublicKey,
			(buffer, slot: number) => {
				if (!buffer) {
					return;
				}

				if (this.user && this.user.slot > slot) {
					return;
				}

				const account = this.decode('User', buffer);
				this.user = { data: account, slot };
				this.eventEmitter.emit('userAccountUpdate', account);
				this.eventEmitter.emit('update');
			}
		);

		this.errorCallbackId = this.accountLoader.addErrorCallbacks((error) => {
			this.eventEmitter.emit('error', error);
		});
	}

	async fetchIfUnloaded(): Promise<void> {
		if (this.user === undefined) {
			await this.fetch();
		}
	}

	async fetch(): Promise<void> {
		try {
			const dataAndContext = await this.connection.getAccountInfoAndContext(
				this.userAccountPublicKey,
				this.accountLoader.commitment
			);
			if (dataAndContext.context.slot > (this.user?.slot ?? 0)) {
				this.user = {
					data: this.decode('User', dataAndContext.value.data),
					slot: dataAndContext.context.slot,
				};
			}
		} catch (e) {
			console.log(
				`PollingUserAccountSubscriber.fetch() UserAccount does not exist: ${e.message}-${e.stack}`
			);
		}
	}

	doesAccountExist(): boolean {
		return this.user !== undefined;
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		this.accountLoader.removeAccount(
			this.userAccountPublicKey,
			this.callbackId
		);
		this.callbackId = undefined;

		this.accountLoader.removeErrorCallbacks(this.errorCallbackId);
		this.errorCallbackId = undefined;

		this.isSubscribed = false;
	}

	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	public getUserAccountAndSlot(): DataAndSlot<UserAccount> {
		if (!this.doesAccountExist()) {
			throw new NotSubscribedError(
				'You must call `subscribe` or `fetch` before using this function'
			);
		}
		return this.user;
	}

	public updateData(userAccount: UserAccount, slot: number): void {
		if (!this.user || this.user.slot < slot) {
			this.user = { data: userAccount, slot };
			this.eventEmitter.emit('userAccountUpdate', userAccount);
			this.eventEmitter.emit('update');
		}
	}
}
