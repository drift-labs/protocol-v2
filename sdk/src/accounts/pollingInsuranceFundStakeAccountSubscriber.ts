import {
	DataAndSlot,
	NotSubscribedError,
	InsuranceFundStakeAccountEvents,
	InsuranceFundStakeAccountSubscriber,
} from './types';
import { Program } from '@coral-xyz/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from './bulkAccountLoader';
import { InsuranceFundStake } from '../types';

export class PollingInsuranceFundStakeAccountSubscriber
	implements InsuranceFundStakeAccountSubscriber
{
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<
		EventEmitter,
		InsuranceFundStakeAccountEvents
	>;
	insuranceFundStakeAccountPublicKey: PublicKey;

	accountLoader: BulkAccountLoader;
	callbackId?: string;
	errorCallbackId?: string;

	insuranceFundStakeAccountAndSlot?: DataAndSlot<InsuranceFundStake>;

	public constructor(
		program: Program,
		publicKey: PublicKey,
		accountLoader: BulkAccountLoader
	) {
		this.isSubscribed = false;
		this.program = program;
		this.insuranceFundStakeAccountPublicKey = publicKey;
		this.accountLoader = accountLoader;
		this.eventEmitter = new EventEmitter();
	}

	async subscribe(insuranceFundStake?: InsuranceFundStake): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		if (insuranceFundStake) {
			this.insuranceFundStakeAccountAndSlot = {
				data: insuranceFundStake,
				slot: undefined,
			};
		}

		await this.addToAccountLoader();

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
			this.insuranceFundStakeAccountPublicKey,
			(buffer, slot: number) => {
				if (!buffer) {
					return;
				}

				if (
					this.insuranceFundStakeAccountAndSlot &&
					this.insuranceFundStakeAccountAndSlot.slot > slot
				) {
					return;
				}

				const account = this.program.account.user.coder.accounts.decode(
					'InsuranceFundStake',
					buffer
				);
				this.insuranceFundStakeAccountAndSlot = { data: account, slot };
				this.eventEmitter.emit('insuranceFundStakeAccountUpdate', account);
				this.eventEmitter.emit('update');
			}
		);

		this.errorCallbackId = this.accountLoader.addErrorCallbacks((error) => {
			this.eventEmitter.emit('error', error);
		});
	}

	async fetchIfUnloaded(): Promise<void> {
		if (this.insuranceFundStakeAccountAndSlot === undefined) {
			await this.fetch();
		}
	}

	async fetch(): Promise<void> {
		try {
			const dataAndContext =
				await this.program.account.insuranceFundStake.fetchAndContext(
					this.insuranceFundStakeAccountPublicKey,
					this.accountLoader.commitment
				);
			if (
				dataAndContext.context.slot >
				(this.insuranceFundStakeAccountAndSlot?.slot ?? 0)
			) {
				this.insuranceFundStakeAccountAndSlot = {
					data: dataAndContext.data as InsuranceFundStake,
					slot: dataAndContext.context.slot,
				};
			}
		} catch (e) {
			console.log(
				`PollingInsuranceFundStakeAccountSubscriber.fetch() InsuranceFundStake does not exist: ${e.message}`
			);
		}
	}

	doesAccountExist(): boolean {
		return this.insuranceFundStakeAccountAndSlot !== undefined;
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		this.accountLoader.removeAccount(
			this.insuranceFundStakeAccountPublicKey,
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

	public getInsuranceFundStakeAccountAndSlot(): DataAndSlot<InsuranceFundStake> {
		this.assertIsSubscribed();
		return this.insuranceFundStakeAccountAndSlot;
	}

	didSubscriptionSucceed(): boolean {
		return !!this.insuranceFundStakeAccountAndSlot;
	}

	public updateData(
		insuranceFundStake: InsuranceFundStake,
		slot: number
	): void {
		if (
			!this.insuranceFundStakeAccountAndSlot ||
			this.insuranceFundStakeAccountAndSlot.slot < slot
		) {
			this.insuranceFundStakeAccountAndSlot = {
				data: insuranceFundStake,
				slot,
			};
			this.eventEmitter.emit(
				'insuranceFundStakeAccountUpdate',
				insuranceFundStake
			);
			this.eventEmitter.emit('update');
		}
	}
}
