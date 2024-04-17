import {
	DataAndSlot,
	NotSubscribedError,
	UserAccountEvents,
	UserAccountSubscriber,
} from './types';
import { Program } from '@coral-xyz/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { UserAccount } from '../types';
import { BulkAccountLoader } from './bulkAccountLoader';

export class PollingUserAccountSubscriber implements UserAccountSubscriber {
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	userAccountPublicKey: PublicKey;

	accountLoader: BulkAccountLoader;
	callbackId?: string;
	errorCallbackId?: string;

	user?: DataAndSlot<UserAccount>;

	public constructor(
		program: Program,
		userAccountPublicKey: PublicKey,
		accountLoader: BulkAccountLoader
	) {
		this.isSubscribed = false;
		this.program = program;
		this.accountLoader = accountLoader;
		this.eventEmitter = new EventEmitter();
		this.userAccountPublicKey = userAccountPublicKey;
	}

	// 🐞 This method always returns true .. consumers probably expect false to be a possibility if subscribing didn't succeed. The question is if subscribing should be able to not succeed ... is it acceptable to subscribe to an account before it exists expecting that the fetching interval will get it later? - that's the only reason I can imagine it makes sense to always return true
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

				const account = this.program.account.user.coder.accounts.decode(
					'User',
					buffer
				);
				this.user = { data: account, slot };
				this.eventEmitter.emit('userAccountUpdate', account);
				this.eventEmitter.emit('update');
			}
		);

		this.errorCallbackId = this.accountLoader.addErrorCallbacks((error) => {
			this.eventEmitter.emit('error', error);
		});
	}

	// 🐞 If the subscribe method SHOULDN'T always return true, then this is the offending meethod which should return false if the fetch fails. 
	async fetchIfUnloaded(): Promise<void> {
		if (this.user === undefined) {
			await this.fetch();
		}
	}

	async fetch(): Promise<void> {
		try {
			const dataAndContext = await this.program.account.user.fetchAndContext(
				this.userAccountPublicKey,
				this.accountLoader.commitment
			);
			if (dataAndContext.context.slot > (this.user?.slot ?? 0)) {
				this.user = {
					data: dataAndContext.data as UserAccount,
					slot: dataAndContext.context.slot,
				};
			}
		} catch (e) {
			console.log(
				`PollingUserAccountSubscriber.fetch() UserAccount does not exist: ${e.message}`
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
			// 🐞 This is the line that throws when we run getUserAccount for an account that doesn't exist. It's reasonable for outside users to expect they can call getUserAccounts, because the driftClient and the userAccountSubscriber both say "subscribed=true" at this point.
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
