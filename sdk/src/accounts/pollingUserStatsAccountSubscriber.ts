import {
	DataAndSlot,
	NotSubscribedError,
	UserStatsAccountSubscriber,
	UserStatsAccountEvents,
} from './types';
import { VelocityProgram } from '../config';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { UserStatsAccount } from '../types';
import { BulkAccountLoader } from './bulkAccountLoader';

export class PollingUserStatsAccountSubscriber
	implements UserStatsAccountSubscriber
{
	isSubscribed: boolean;
	program: VelocityProgram;
	eventEmitter: StrictEventEmitter<EventEmitter, UserStatsAccountEvents>;
	userStatsAccountPublicKey: PublicKey;

	accountLoader: BulkAccountLoader;
	callbackId?: string;
	errorCallbackId?: string;

	userStats?: DataAndSlot<UserStatsAccount>;

	public constructor(
		program: VelocityProgram,
		userStatsAccountPublicKey: PublicKey,
		accountLoader: BulkAccountLoader
	) {
		this.isSubscribed = false;
		this.program = program;
		this.accountLoader = accountLoader;
		this.eventEmitter = new EventEmitter();
		this.userStatsAccountPublicKey = userStatsAccountPublicKey;
	}

	async subscribe(userStatsAccount?: UserStatsAccount): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		if (userStatsAccount) {
			// `slot: 0` keeps {data, slot} atomic: a seeded account always carries a
			// slot (0 = oldest-possible sentinel, overwritten by the first real fetch).
			this.userStats = { data: userStatsAccount, slot: 0 };
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
		if (this.callbackId !== undefined) {
			return;
		}

		this.callbackId = await this.accountLoader.addAccount(
			this.userStatsAccountPublicKey,
			(buffer, slot: number) => {
				if (!buffer) {
					return;
				}

				if (this.userStats && this.userStats.slot > slot) {
					return;
				}

				const account = this.program.coder.accounts.decodeUnchecked(
					'userStats',
					buffer
				);
				this.userStats = { data: account, slot };
				this.eventEmitter.emit('userStatsAccountUpdate', account);
				this.eventEmitter.emit('update');
			}
		);

		this.errorCallbackId = this.accountLoader.addErrorCallbacks((error) => {
			this.eventEmitter.emit('error', error);
		});
	}

	async fetchIfUnloaded(): Promise<void> {
		if (!this.doesAccountExist()) {
			await this.fetch();
		}
	}

	async fetch(): Promise<void> {
		try {
			const dataAndContext = await (
				this.program.account as any
			).userStats.fetchAndContext(
				this.userStatsAccountPublicKey,
				this.accountLoader.commitment
			);
			if (dataAndContext.context.slot > (this.userStats?.slot ?? 0)) {
				this.userStats = {
					data: dataAndContext.data as unknown as UserStatsAccount,
					slot: dataAndContext.context.slot,
				};
			}
		} catch (e) {
			console.log(
				`PollingUserStatsAccountSubscriber.fetch() UserStatsAccount does not exist: ${
					e instanceof Error ? e.message : String(e)
				}`
			);
		}
	}

	doesAccountExist(): this is { userStats: DataAndSlot<UserStatsAccount> } {
		return this.userStats !== undefined;
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		this.accountLoader.removeAccount(
			this.userStatsAccountPublicKey,
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

	public getUserStatsAccountAndSlot():
		| DataAndSlot<UserStatsAccount>
		| undefined {
		this.assertIsSubscribed();
		return this.userStats;
	}
}
