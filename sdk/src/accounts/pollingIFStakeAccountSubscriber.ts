import {
	DataAndSlot,
	AccountToPoll,
	NotSubscribedError,
	IFStakeAccountSubscriber,
	IFStakeAccountEvents,
} from './types';
import { Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { InsuranceFundStake } from '../types';
import { BulkAccountLoader } from './bulkAccountLoader';

export class PollingIFStakeAccountSubscriber
	implements IFStakeAccountSubscriber
{
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, IFStakeAccountEvents>;
	ifStakeAccountPublicKey: PublicKey;

	accountLoader: BulkAccountLoader;
	accountsToPoll = new Map<string, AccountToPoll>();
	callbackId?: string;
	errorCallbackId?: string;

	ifStake?: DataAndSlot<InsuranceFundStake>;

	public constructor(
		program: Program,
		ifStakeAccountPublicKey: PublicKey,
		accountLoader: BulkAccountLoader
	) {
		this.isSubscribed = false;
		this.program = program;
		this.accountLoader = accountLoader;
		this.eventEmitter = new EventEmitter();
		this.ifStakeAccountPublicKey = ifStakeAccountPublicKey;
	}

	async subscribe(): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		await this.addToAccountLoader();

		await this.fetchIfUnloaded();
		if (this.doesAccountExist()) {
			this.eventEmitter.emit('update');
		}

		this.isSubscribed = true;
		return true;
	}

	async addToAccountLoader(): Promise<void> {
		if (this.callbackId) {
			return;
		}

		this.callbackId = await this.accountLoader.addAccount(
			this.ifStakeAccountPublicKey,
			(buffer, slot: number) => {
				if (!buffer) {
					return;
				}

				if (this.ifStake && this.ifStake.slot > slot) {
					return;
				}

				const account =
					this.program.account.insuranceFundStake.coder.accounts.decode(
						'InsuranceFundStake',
						buffer
					);
				this.ifStake = { data: account, slot };
				this.eventEmitter.emit('ifStakeAccountUpdate', account);
				this.eventEmitter.emit('update');
			}
		);

		this.errorCallbackId = this.accountLoader.addErrorCallbacks((error) => {
			this.eventEmitter.emit('error', error);
		});
	}

	async fetchIfUnloaded(): Promise<void> {
		if (this.ifStake === undefined) {
			await this.fetch();
		}
	}

	async fetch(): Promise<void> {
		await this.accountLoader.load();
		const { buffer, slot } = this.accountLoader.getBufferAndSlot(
			this.ifStakeAccountPublicKey
		);
		const currentSlot = this.ifStake?.slot ?? 0;
		if (buffer && slot > currentSlot) {
			const account =
				this.program.account.insuranceFundStake.coder.accounts.decode(
					'InsuranceFundStake',
					buffer
				);
			this.ifStake = { data: account, slot };
		}
	}

	doesAccountExist(): boolean {
		return this.ifStake !== undefined;
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		this.accountLoader.removeAccount(
			this.ifStakeAccountPublicKey,
			this.callbackId
		);
		this.callbackId = undefined;

		this.accountLoader.removeErrorCallbacks(this.errorCallbackId);
		this.errorCallbackId = undefined;

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
		return this.ifStake;
	}
}
