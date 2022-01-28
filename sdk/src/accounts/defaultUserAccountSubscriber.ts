import {
	AccountSubscriber,
	NotSubscribedError,
	UserAccountEvents,
	UserAccountSubscriber,
} from './types';
import { Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { getUserAccountPublicKey } from '../addresses';
import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';
import { UserAccount, UserPositionsAccount } from '../types';

export class DefaultUserAccountSubscriber implements UserAccountSubscriber {
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	authority: PublicKey;

	userDataAccountSubscriber: AccountSubscriber<UserAccount>;
	userPositionsAccountSubscriber: AccountSubscriber<UserPositionsAccount>;

	public constructor(program: Program, authority: PublicKey) {
		this.isSubscribed = false;
		this.program = program;
		this.authority = authority;
		this.eventEmitter = new EventEmitter();
	}

	async subscribe(): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		const userPublicKey = await getUserAccountPublicKey(
			this.program.programId,
			this.authority
		);
		this.userDataAccountSubscriber = new WebSocketAccountSubscriber(
			'user',
			this.program,
			userPublicKey
		);
		await this.userDataAccountSubscriber.subscribe((data: UserAccount) => {
			this.eventEmitter.emit('userAccountData', data);
			this.eventEmitter.emit('update');
		});

		const userAccountData = this.userDataAccountSubscriber.data;
		this.userPositionsAccountSubscriber = new WebSocketAccountSubscriber(
			'userPositions',
			this.program,
			userAccountData.positions
		);

		await this.userPositionsAccountSubscriber.subscribe(
			(data: UserPositionsAccount) => {
				this.eventEmitter.emit('userPositionsData', data);
				this.eventEmitter.emit('update');
			}
		);

		this.eventEmitter.emit('update');
		this.isSubscribed = true;
		return true;
	}

	async fetch(): Promise<void> {
		await Promise.all([
			this.userDataAccountSubscriber.fetch(),
			this.userPositionsAccountSubscriber.fetch(),
		]);
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		await Promise.all([
			this.userDataAccountSubscriber.unsubscribe(),
			this.userPositionsAccountSubscriber.unsubscribe(),
		]);

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
		return this.userDataAccountSubscriber.data;
	}

	public getUserPositionsAccount(): UserPositionsAccount {
		this.assertIsSubscribed();
		return this.userPositionsAccountSubscriber.data;
	}
}
