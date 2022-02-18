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
import {
	getUserAccountPublicKey,
	getUserOrdersAccountPublicKey,
} from '../addresses';
import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';
import { UserAccount, UserOrdersAccount, UserPositionsAccount } from '../types';
import { ClearingHouseConfigType } from '../factory/clearingHouse';

export class WebSocketUserAccountSubscriber implements UserAccountSubscriber {
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	authority: PublicKey;

	userDataAccountSubscriber: AccountSubscriber<UserAccount>;
	userPositionsAccountSubscriber: AccountSubscriber<UserPositionsAccount>;
	userOrdersAccountSubscriber: AccountSubscriber<UserOrdersAccount>;

	type: ClearingHouseConfigType = 'websocket';

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

		const userOrdersPublicKey = await getUserOrdersAccountPublicKey(
			this.program.programId,
			userPublicKey
		);

		this.userOrdersAccountSubscriber = new WebSocketAccountSubscriber(
			'userOrders',
			this.program,
			userOrdersPublicKey
		);
		await this.userOrdersAccountSubscriber.subscribe(
			(data: UserOrdersAccount) => {
				this.eventEmitter.emit('userOrdersData', data);
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
			this.userOrdersAccountSubscriber.fetch(),
		]);
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		await Promise.all([
			this.userDataAccountSubscriber.unsubscribe(),
			this.userPositionsAccountSubscriber.unsubscribe(),
			await this.userOrdersAccountSubscriber.unsubscribe(),
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

	public getUserOrdersAccount(): UserOrdersAccount {
		return this.userOrdersAccountSubscriber.data;
	}
}
