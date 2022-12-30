import {
	DataAndSlot,
	AccountSubscriber,
	NotSubscribedError,
	UserAccountEvents,
	UserAccountSubscriber,
} from './types';
import { Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';
import { UserAccount } from '../types';

export class WebSocketUserAccountSubscriber implements UserAccountSubscriber {
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	userAccountPublicKey: PublicKey;

	userDataAccountSubscriber: AccountSubscriber<UserAccount>;

	public constructor(program: Program, userAccountPublicKey: PublicKey) {
		this.isSubscribed = false;
		this.program = program;
		this.userAccountPublicKey = userAccountPublicKey;
		this.eventEmitter = new EventEmitter();
	}

	async subscribe(userAccount?: UserAccount): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		this.userDataAccountSubscriber = new WebSocketAccountSubscriber(
			'user',
			this.program,
			this.userAccountPublicKey
		);

		if (userAccount) {
			this.userDataAccountSubscriber.setData(userAccount);
		}

		await this.userDataAccountSubscriber.subscribe((data: UserAccount) => {
			this.eventEmitter.emit('userAccountUpdate', data);
			this.eventEmitter.emit('update');
		});

		this.eventEmitter.emit('update');
		this.isSubscribed = true;
		return true;
	}

	async fetch(): Promise<void> {
		await Promise.all([this.userDataAccountSubscriber.fetch()]);
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		await Promise.all([this.userDataAccountSubscriber.unsubscribe()]);

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
		this.assertIsSubscribed();
		return this.userDataAccountSubscriber.dataAndSlot;
	}
}
