import {
	DataAndSlot,
	AccountSubscriber,
	NotSubscribedError,
	IFStakeAccountSubscriber,
	IFStakeAccountEvents,
} from './types';
import { Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';
import { InsuranceFundStake } from '../types';

export class WebsocketIFStakeAccountSubscriber
	implements IFStakeAccountSubscriber
{
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, IFStakeAccountEvents>;
	ifStakeAccountPublicKey: PublicKey;

	ifStakeAccountSubscriber: AccountSubscriber<InsuranceFundStake>;

	public constructor(program: Program, ifStakeAccountPublicKey: PublicKey) {
		this.isSubscribed = false;
		this.program = program;
		this.ifStakeAccountPublicKey = ifStakeAccountPublicKey;
		this.eventEmitter = new EventEmitter();
	}

	async subscribe(): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		this.ifStakeAccountSubscriber = new WebSocketAccountSubscriber(
			'insuranceFundStake',
			this.program,
			this.ifStakeAccountPublicKey
		);

		await this.ifStakeAccountSubscriber.subscribe(
			(data: InsuranceFundStake) => {
				this.eventEmitter.emit('ifStakeAccountUpdate', data);
				this.eventEmitter.emit('update');
			}
		);

		this.eventEmitter.emit('update');
		this.isSubscribed = true;
		return true;
	}

	async fetch(): Promise<void> {
		await Promise.all([this.ifStakeAccountSubscriber.fetch()]);
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		await Promise.all([this.ifStakeAccountSubscriber.unsubscribe()]);

		this.isSubscribed = false;
	}

	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	public getIFStakeAccountAndSlot(): DataAndSlot<InsuranceFundStake> {
		this.assertIsSubscribed();
		return this.ifStakeAccountSubscriber.dataAndSlot;
	}
}
