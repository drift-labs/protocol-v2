import {
	DataAndSlot,
	AccountSubscriber,
	NotSubscribedError,
	ResubOpts,
	TokenAccountEvents,
	TokenAccountSubscriber,
} from './types';
import { Program } from '@coral-xyz/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { Commitment, PublicKey } from '@solana/web3.js';
import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';
import { Account } from '@solana/spl-token';

export class WebSocketTokenAccountSubscriber implements TokenAccountSubscriber {
	isSubscribed: boolean;
	resubOpts?: ResubOpts;
	commitment?: Commitment;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, TokenAccountEvents>;
	tokenAccountPublicKey: PublicKey;

	tokenAccountSubscriber: AccountSubscriber<Account>;

	public constructor(
		program: Program,
		tokenAccountPublicKey: PublicKey,
		resubOpts?: ResubOpts,
		commitment?: Commitment
	) {
		this.isSubscribed = false;
		this.program = program;
		this.resubOpts = resubOpts;
		this.tokenAccountPublicKey = tokenAccountPublicKey;
		this.eventEmitter = new EventEmitter();
		this.commitment = commitment;
	}

	async subscribe(tokenAccount?: Account): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		this.tokenAccountSubscriber = new WebSocketAccountSubscriber(
			'user',
			this.program,
			this.tokenAccountPublicKey,
			undefined,
			this.resubOpts,
			this.commitment
		);

		if (tokenAccount) {
			this.tokenAccountSubscriber.setData(tokenAccount);
		}

		await this.tokenAccountSubscriber.subscribe((data: Account) => {
			this.eventEmitter.emit('tokenAccountUpdate', data);
			this.eventEmitter.emit('update');
		});

		this.eventEmitter.emit('update');
		this.isSubscribed = true;
		return true;
	}

	async fetch(): Promise<void> {
		await Promise.all([this.tokenAccountSubscriber.fetch()]);
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		await Promise.all([this.tokenAccountSubscriber.unsubscribe()]);

		this.isSubscribed = false;
	}

	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	public getTokenAccountAndSlot(): DataAndSlot<Account> {
		this.assertIsSubscribed();
		return this.tokenAccountSubscriber.dataAndSlot;
	}

	public updateData(tokenAccount: Account, slot: number) {
		const currentDataSlot = this.tokenAccountSubscriber.dataAndSlot?.slot || 0;
		if (currentDataSlot <= slot) {
			this.tokenAccountSubscriber.setData(tokenAccount, slot);
			this.eventEmitter.emit('tokenAccountUpdate', tokenAccount);
			this.eventEmitter.emit('update');
		}
	}
}
