import {
	DataAndSlot,
	AccountSubscriber,
	NotSubscribedError,
	InsuranceFundStakeAccountEvents,
	InsuranceFundStakeAccountSubscriber,
	ResubOpts,
} from './types';
import { Program } from '@coral-xyz/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { Commitment, PublicKey } from '@solana/web3.js';
import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';
import { InsuranceFundStake } from '../types';

export class WebSocketInsuranceFundStakeAccountSubscriber
	implements InsuranceFundStakeAccountSubscriber
{
	isSubscribed: boolean;
	resubOpts: ResubOpts;
	commitment?: Commitment;
	program: Program;
	eventEmitter: StrictEventEmitter<
		EventEmitter,
		InsuranceFundStakeAccountEvents
	>;
	insuranceFundStakeAccountPublicKey: PublicKey;

	insuranceFundStakeDataAccountSubscriber: AccountSubscriber<InsuranceFundStake>;

	public constructor(
		program: Program,
		insuranceFundStakeAccountPublicKey: PublicKey,
		resubOpts?: ResubOpts,
		commitment?: Commitment
	) {
		this.isSubscribed = false;
		this.program = program;
		this.insuranceFundStakeAccountPublicKey =
			insuranceFundStakeAccountPublicKey;
		this.eventEmitter = new EventEmitter();
		this.resubOpts = resubOpts;
		this.commitment = commitment;
	}

	async subscribe(
		insuranceFundStakeAccount?: InsuranceFundStake
	): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		this.insuranceFundStakeDataAccountSubscriber =
			new WebSocketAccountSubscriber(
				'insuranceFundStake',
				this.program,
				this.insuranceFundStakeAccountPublicKey,
				undefined,
				this.resubOpts,
				this.commitment
			);

		if (insuranceFundStakeAccount) {
			this.insuranceFundStakeDataAccountSubscriber.setData(
				insuranceFundStakeAccount
			);
		}

		await this.insuranceFundStakeDataAccountSubscriber.subscribe(
			(data: InsuranceFundStake) => {
				this.eventEmitter.emit('insuranceFundStakeAccountUpdate', data);
				this.eventEmitter.emit('update');
			}
		);

		this.eventEmitter.emit('update');
		this.isSubscribed = true;
		return true;
	}

	async fetch(): Promise<void> {
		await Promise.all([this.insuranceFundStakeDataAccountSubscriber.fetch()]);
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		await Promise.all([
			this.insuranceFundStakeDataAccountSubscriber.unsubscribe(),
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

	public getInsuranceFundStakeAccountAndSlot(): DataAndSlot<InsuranceFundStake> {
		this.assertIsSubscribed();
		return this.insuranceFundStakeDataAccountSubscriber.dataAndSlot;
	}

	public updateData(
		insuranceFundStake: InsuranceFundStake,
		slot: number
	): void {
		const currentDataSlot =
			this.insuranceFundStakeDataAccountSubscriber.dataAndSlot?.slot || 0;
		if (currentDataSlot <= slot) {
			this.insuranceFundStakeDataAccountSubscriber.setData(
				insuranceFundStake,
				slot
			);
			this.eventEmitter.emit(
				'insuranceFundStakeAccountUpdate',
				insuranceFundStake
			);
			this.eventEmitter.emit('update');
		}
	}
}
