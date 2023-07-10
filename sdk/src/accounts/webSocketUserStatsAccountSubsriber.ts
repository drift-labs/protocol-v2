import {
	DataAndSlot,
	AccountSubscriber,
	NotSubscribedError,
	UserStatsAccountSubscriber,
	UserStatsAccountEvents,
} from './types';
import { Program } from '@coral-xyz/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';
import { UserStatsAccount } from '../types';

export class WebSocketUserStatsAccountSubscriber
	implements UserStatsAccountSubscriber
{
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, UserStatsAccountEvents>;
	userStatsAccountPublicKey: PublicKey;

	userStatsAccountSubscriber: AccountSubscriber<UserStatsAccount>;

	public constructor(program: Program, userStatsAccountPublicKey: PublicKey) {
		this.isSubscribed = false;
		this.program = program;
		this.userStatsAccountPublicKey = userStatsAccountPublicKey;
		this.eventEmitter = new EventEmitter();
	}

	async subscribe(userStatsAccount?: UserStatsAccount): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		this.userStatsAccountSubscriber = new WebSocketAccountSubscriber(
			'userStats',
			this.program,
			this.userStatsAccountPublicKey
		);

		if (userStatsAccount) {
			this.userStatsAccountSubscriber.setData(userStatsAccount);
		}

		await this.userStatsAccountSubscriber.subscribe(
			(data: UserStatsAccount) => {
				this.eventEmitter.emit('userStatsAccountUpdate', data);
				this.eventEmitter.emit('update');
			}
		);

		this.eventEmitter.emit('update');
		this.isSubscribed = true;
		return true;
	}

	async fetch(): Promise<void> {
		await Promise.all([this.userStatsAccountSubscriber.fetch()]);
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		await Promise.all([this.userStatsAccountSubscriber.unsubscribe()]);

		this.isSubscribed = false;
	}

	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	public getUserStatsAccountAndSlot(): DataAndSlot<UserStatsAccount> {
		this.assertIsSubscribed();
		return this.userStatsAccountSubscriber.dataAndSlot;
	}
}
