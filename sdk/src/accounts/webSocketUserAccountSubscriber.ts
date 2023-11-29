import {
	DataAndSlot,
	AccountSubscriber,
	NotSubscribedError,
	UserAccountEvents,
	UserAccountSubscriber,
} from './types';
import { Program } from '@coral-xyz/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { Commitment, PublicKey } from '@solana/web3.js';
import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';
import { UserAccount } from '../types';

export class WebSocketUserAccountSubscriber implements UserAccountSubscriber {
	isSubscribed: boolean;
	reconnectTimeoutMs?: number;
	commitment?: Commitment;
	useWhirligig?: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	userAccountPublicKey: PublicKey;

	userDataAccountSubscriber: AccountSubscriber<UserAccount>;

	public constructor(
		program: Program,
		userAccountPublicKey: PublicKey,
		reconnectTimeoutMs?: number,
		commitment?: Commitment,
		useWhirligig = false
	) {
		this.isSubscribed = false;
		this.program = program;
		this.userAccountPublicKey = userAccountPublicKey;
		this.eventEmitter = new EventEmitter();
		this.reconnectTimeoutMs = reconnectTimeoutMs;
		this.commitment = commitment;
		this.useWhirligig = useWhirligig;
	}

	async subscribe(userAccount?: UserAccount): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		this.userDataAccountSubscriber = new WebSocketAccountSubscriber(
			'user',
			this.program,
			this.userAccountPublicKey,
			undefined,
			this.reconnectTimeoutMs,
			this.commitment,
			this.useWhirligig
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

	public updateData(userAccount: UserAccount, slot: number) {
		const currentDataSlot =
			this.userDataAccountSubscriber.dataAndSlot?.slot || 0;
		if (currentDataSlot < slot) {
			this.userDataAccountSubscriber.setData(userAccount, slot);
			this.eventEmitter.emit('userAccountUpdate', userAccount);
			this.eventEmitter.emit('update');
		}
	}
}
