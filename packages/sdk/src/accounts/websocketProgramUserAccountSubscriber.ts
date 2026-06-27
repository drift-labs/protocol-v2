import {
	DataAndSlot,
	NotSubscribedError,
	UserAccountEvents,
	UserAccountSubscriber,
} from './types';
import { VelocityProgram } from '../config';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { Context, PublicKey } from '@solana/web3.js';
import { WebSocketProgramAccountSubscriber } from './webSocketProgramAccountSubscriber';
import { UserAccount } from '../types';

export class WebSocketProgramUserAccountSubscriber
	implements UserAccountSubscriber
{
	isSubscribed: boolean;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;

	private userAccountPublicKey: PublicKey;
	private program: VelocityProgram;
	private programSubscriber: WebSocketProgramAccountSubscriber<UserAccount>;
	private userAccountAndSlot?: DataAndSlot<UserAccount>;

	public constructor(
		program: VelocityProgram,
		userAccountPublicKey: PublicKey,
		programSubscriber: WebSocketProgramAccountSubscriber<UserAccount>
	) {
		this.isSubscribed = false;
		this.program = program;
		this.userAccountPublicKey = userAccountPublicKey;
		this.eventEmitter = new EventEmitter();
		this.programSubscriber = programSubscriber;
	}

	async subscribe(userAccount?: UserAccount): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		if (userAccount) {
			this.updateData(userAccount, 0);
		}

		this.programSubscriber.onChange = (
			accountId: PublicKey,
			data: UserAccount,
			context: Context
		) => {
			if (accountId.equals(this.userAccountPublicKey)) {
				this.updateData(data, context.slot);
				this.eventEmitter.emit('userAccountUpdate', data);
				this.eventEmitter.emit('update');
			}
		};

		this.isSubscribed = true;
		return true;
	}

	async fetch(): Promise<void> {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'Must subscribe before fetching account updates'
			);
		}

		const account = await (this.program.account as any).user.fetch(
			this.userAccountPublicKey
		);
		this.updateData(account as UserAccount, 0);
	}

	updateData(userAccount: UserAccount, slot: number): void {
		this.userAccountAndSlot = {
			data: userAccount,
			slot,
		};
	}

	async unsubscribe(): Promise<void> {
		this.isSubscribed = false;
	}

	getUserAccountAndSlot(): DataAndSlot<UserAccount> | undefined {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
		return this.userAccountAndSlot;
	}
}
