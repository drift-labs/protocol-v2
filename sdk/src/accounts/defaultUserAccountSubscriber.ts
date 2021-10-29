import {
	AccountSubscriber,
	UserAccountEvents,
	UserAccountSubscriber,
} from './types';
import { Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { getUserPublicKey } from '../addresses';
import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';
import { UserAccountData, UserPositionData } from '../types';

export class DefaultUserAccountSubscriber implements UserAccountSubscriber {
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	userAuthorityPublicKey: PublicKey;

	userDataAccountSubscriber: AccountSubscriber<UserAccountData>;
	userPositionsAccountSubscriber: AccountSubscriber<UserPositionData>;

	public constructor(program: Program, userAuthorityPublicKey: PublicKey) {
		this.isSubscribed = false;
		this.program = program;
		this.userAuthorityPublicKey = userAuthorityPublicKey;
		this.eventEmitter = new EventEmitter();
	}

	async subscribe(): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		const userPublicKey = await getUserPublicKey(
			this.program.programId,
			this.userAuthorityPublicKey
		);
		this.userDataAccountSubscriber = new WebSocketAccountSubscriber(
			'user',
			this.program,
			userPublicKey
		);
		await new Promise<void>((res) => {
			this.userDataAccountSubscriber.subscribe((data: UserAccountData) => {
				res();
				this.eventEmitter.emit('userAccountData', data);
				this.eventEmitter.emit('update');
			});
		});

		const userAccountData = this.userDataAccountSubscriber.data;
		this.userPositionsAccountSubscriber = new WebSocketAccountSubscriber(
			'userPositions',
			this.program,
			userAccountData.positions
		);

		await new Promise<void>((res) => {
			this.userPositionsAccountSubscriber.subscribe(
				(data: UserPositionData) => {
					res();
					this.eventEmitter.emit('userPositionsData', data);
					this.eventEmitter.emit('update');
				}
			);
		});

		this.eventEmitter.emit('update');
		this.isSubscribed = true;
		return true;
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		this.userDataAccountSubscriber.unsubscribe();
		this.userPositionsAccountSubscriber.unsubscribe();

		this.isSubscribed = false;
	}

	public getUserAccountData(): UserAccountData {
		return this.userDataAccountSubscriber.data;
	}

	public getUserPositionsData(): UserPositionData {
		return this.userPositionsAccountSubscriber.data;
	}
}
