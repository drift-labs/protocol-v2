import {
	NotSubscribedError,
	ConstituentAccountEvents,
	ConstituentAccountSubscriber,
} from '../accounts/types';
import { Program } from '@coral-xyz/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { Commitment, MemcmpFilter } from '@solana/web3.js';
import { ConstituentMap } from './constituentMap';

export class PollingConstituentAccountSubscriber
	implements ConstituentAccountSubscriber
{
	isSubscribed: boolean;
	program: Program;
	frequency: number;
	commitment?: Commitment;
	additionalFilters?: MemcmpFilter[];
	eventEmitter: StrictEventEmitter<EventEmitter, ConstituentAccountEvents>;

	intervalId?: NodeJS.Timeout;
	constituentMap: ConstituentMap;

	public constructor(
		constituentMap: ConstituentMap,
		program: Program,
		frequency: number,
		commitment?: Commitment,
		additionalFilters?: MemcmpFilter[]
	) {
		this.constituentMap = constituentMap;
		this.isSubscribed = false;
		this.program = program;
		this.frequency = frequency;
		this.commitment = commitment;
		this.additionalFilters = additionalFilters;
		this.eventEmitter = new EventEmitter();
	}

	async subscribe(): Promise<boolean> {
		if (this.isSubscribed || this.frequency <= 0) {
			return true;
		}

		const executeSync = async () => {
			await this.sync();
			this.intervalId = setTimeout(executeSync, this.frequency);
		};

		// Initial sync
		await this.sync();

		// Start polling
		this.intervalId = setTimeout(executeSync, this.frequency);

		this.isSubscribed = true;
		return true;
	}

	async sync(): Promise<void> {
		try {
			await this.constituentMap.sync();
			this.eventEmitter.emit('update');
		} catch (error) {
			console.log(
				`PollingConstituentAccountSubscriber.sync() error: ${error.message}`
			);
			this.eventEmitter.emit('error', error);
		}
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		if (this.intervalId) {
			clearTimeout(this.intervalId);
			this.intervalId = undefined;
		}

		this.isSubscribed = false;
	}

	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	didSubscriptionSucceed(): boolean {
		return this.isSubscribed;
	}
}
